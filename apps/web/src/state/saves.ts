import { targetsMarkedFromSaves, targetsToMarkFromSave, type ProgressRecord } from '@atlas/core';
import { saveGameForPack } from '@atlas/saves/games';
import {
  distance,
  fitPoints,
  type CalibrationPoint,
  type MapCalibration,
  type PlayerOnMap,
  type SaveMatch,
} from '@atlas/saves/match';
import type { GameFileInput, SaveGame, SaveSummary } from '@atlas/saves';
import { isPinTable, type GamePinTable } from '@atlas/saves/table';
import {
  desktop,
  type GameFilesReport,
  type GameFilesScan,
  type GameFolderInfo,
  type SaveFileEntry,
  type SaveFolderInfo,
} from '../desktop';
import { nothingNotice } from '../saves/explain';
import { packForMatching } from '../saves/pack';
import type { SaveJobContext } from '../saves/process';
import { runSaveJob, runTableJob } from '../saves/run';
import { applyProgress, goToPoint, notify, saveSetting, showMap } from './actions';
import { progressStore, SETTINGS } from './services';
import { NO_GAME_TABLE, NO_SAVE, useAtlas, type LoadedGame } from './store';

/**
 * Game saves: linking a save (a folder of saves or one file in the desktop
 * app, a file opened in a browser) to the active profile, reading it,
 * marking the places it shows done, and showing where the player stood.
 *
 * The save is read in a worker (see `saves/run.ts`); the bytes never leave
 * the device. The link, which map shows which world and how maps are lined
 * up with the game world are device-local settings, never exported. So is
 * the table of the game's own map pins, which the desktop app reads from
 * the game's files (see "The game's own map places" below). Marks
 * made from saves have `source: 'save'`; they never override marks made by
 * hand (see `targetsToMarkFromSave` in `@atlas/core`).
 */

/** What the last read of the linked save gave, kept with the link. */
export interface LastRead {
  /** The save's file name. */
  file: string;
  /** Its path in the desktop app, for the screenshot; null in a browser. */
  path: string | null;
  /** When the game last changed the file, if known. */
  modified: number | null;
  /** When Atlas read it. */
  readAt: number;
  version: string;
  world: { id: string; name: string } | null;
  /** Where the player stood, on which map; null when no map shows it yet. */
  player: PlayerOnMap | null;
  /** Places the save shows done. */
  found: number;
  /** Of those, how many this read marked found (the others were already). */
  marked: number;
}

export interface SaveLink {
  /** A folder of saves (its newest is read), one save file, or a file opened in a browser. */
  kind: 'folder' | 'file' | 'browser';
  /** The folder or file in the desktop app; null in a browser, which cannot open it again. */
  path: string | null;
  /** The folder's or file's name, for people. */
  name: string;
  /** Read each new save as the game writes it (desktop app only). */
  follow: boolean;
  last: LastRead | null;
}

export interface SaveState {
  link: SaveLink | null;
  /** A save is being read. */
  busy: boolean;
  error: string | null;
  /** The save read in this session; null after a restart until it is read again. */
  summary: SaveSummary | null;
  match: SaveMatch | null;
  /** The linked folder's saves (desktop app). */
  folder: SaveFolderInfo | null;
  /** Clicks on this map mark where the player stood (lining the map up by hand). */
  placing: { mapId: string; world: { x: number; y: number } } | null;
  /** Which map shows which game world, where the person chose. */
  worldMaps: Record<string, string | null>;
  /** World-to-pixel transforms by map id. */
  calibrations: Record<string, MapCalibration>;
  /** Spots the person marked, by map id. */
  points: Record<string, CalibrationPoint[]>;
  gameTable: GameTableState;
}

/** The table of the game's own map pins, and reading it from the game (desktop app). */
export interface GameTableState {
  /** The game's folder as last checked; null before checking, or in a browser. */
  folder: GameFolderInfo | null;
  /** The table kept on this device; null when none was read. */
  table: GamePinTable | null;
  /** What is being done while the game's files are read; null when nothing is. */
  busy: string | null;
  error: string | null;
  /** How the last read in this session went. */
  last: { files: number; unreadable: number; pins: number } | null;
}

/** Spots marked by hand must be this far apart in the game world (metres) to line a map up. */
export const MIN_SPOT_DISTANCE = 50;
/** How often "Follow new saves" asks the desktop app for a new save. */
const FOLLOW_POLL_MS = 2500;

const get = useAtlas.getState;

function patch(part: Partial<SaveState>): void {
  useAtlas.setState({ save: { ...get().save, ...part } });
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The game of a pack whose saves Atlas reads, or null when it cannot read that game's saves. */
export function saveReaderOf(game: LoadedGame | null): SaveGame | null {
  if (!game) return null;
  const { gameId, title } = game.pack.manifest;
  return saveGameForPack({ gameId, title });
}

/** Where to show the player: from the save read now, or the last one read. */
export function shownPlayer(save: SaveState): PlayerOnMap | null {
  return save.match ? save.match.player : (save.link?.last?.player ?? null);
}

// ---------------------------------------------------------------------------
// Loading and keeping settings

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function linkFrom(value: unknown): SaveLink | null {
  if (!isObject(value)) return null;
  const { kind, path, name, follow, last } = value;
  if (kind !== 'folder' && kind !== 'file' && kind !== 'browser') return null;
  if (typeof name !== 'string') return null;
  return {
    kind,
    path: typeof path === 'string' ? path : null,
    name,
    follow: follow === true && kind !== 'browser',
    last: isObject(last) && typeof last.file === 'string' ? (last as unknown as LastRead) : null,
  };
}

let loadToken = 0;

/** Reads the save link of the active profile and the game's map settings. */
async function loadSaveState(): Promise<void> {
  stopFollowing();
  const token = ++loadToken;
  const { game, profileId } = get();
  if (!game || !profileId || !saveReaderOf(game)) {
    useAtlas.setState({ save: NO_SAVE });
    return;
  }
  const store = progressStore();
  const gameId = game.pack.manifest.gameId;
  const reader = saveReaderOf(game)!;
  const [link, worldMaps, calibrations, points, table] = await Promise.all([
    store.getSetting(SETTINGS.saveLink(profileId)),
    store.getSetting(SETTINGS.saveWorlds(gameId)),
    store.getSetting(SETTINGS.saveCalibration(gameId)),
    store.getSetting(SETTINGS.savePoints(gameId)),
    reader.readsGameFiles ? store.getSetting(SETTINGS.gamePins(reader.id)) : null,
  ]);
  if (token !== loadToken) return;
  const save: SaveState = {
    ...NO_SAVE,
    link: linkFrom(link),
    worldMaps: isObject(worldMaps) ? (worldMaps as SaveState['worldMaps']) : {},
    calibrations: isObject(calibrations) ? (calibrations as SaveState['calibrations']) : {},
    points: isObject(points) ? (points as SaveState['points']) : {},
    gameTable: { ...NO_GAME_TABLE, table: isPinTable(table) ? table : null },
  };
  useAtlas.setState({ save });
  if (desktop && save.link?.follow && save.link.path) void startFollowing();
  if (desktop && reader.readsGameFiles) void checkGameFolder(token);
}

/** Keeps the save state with the game and profile shown. Returns the unsubscribe function. */
export function initSaves(): () => void {
  return useAtlas.subscribe((state, previous) => {
    if (state.game?.entry !== previous.game?.entry || state.profileId !== previous.profileId) {
      void loadSaveState();
    }
  });
}

function storeLink(link: SaveLink | null): void {
  const { profileId } = get();
  if (profileId) saveSetting(SETTINGS.saveLink(profileId), link);
  patch({ link });
}

function gameIdOf(): string | null {
  return get().game?.pack.manifest.gameId ?? null;
}

// ---------------------------------------------------------------------------
// Reading

function matchContext(game: LoadedGame, readerId: string): SaveJobContext {
  const { worldMaps, calibrations, gameTable } = get().save;
  return {
    readerId,
    pack: packForMatching(game.pack.data),
    worldMaps,
    calibrations,
    table: gameTable.table,
    now: Date.now(),
  };
}

const placesText = (n: number) => (n === 1 ? '1 location' : `${n} locations`);

/** Marks found the places a match shows done, where nothing was set by hand. Returns how many. */
function markFound(match: SaveMatch): number {
  const { game, rows } = get();
  if (!game) return 0;
  const ids = match.found
    .map((found) => found.locationId)
    .filter((id) => game.counter.isTrackable(id));
  const targets = targetsToMarkFromSave([...rows.values()], ids, game.pack.currentId);
  if (targets.length === 0) return 0;
  applyProgress(
    targets.map((targetId) => ({ targetId, found: true })),
    {
      undone: `Undone: ${placesText(targets.length)} marked from the save ${targets.length === 1 ? 'is' : 'are'} not found again.`,
      selectId: null,
    },
    'save',
  );
  return targets.length;
}

interface ReadFile {
  name: string;
  path: string | null;
  modified: number | null;
}

/** Reads a save's bytes and uses what it says. */
async function takeSave(bytes: Uint8Array, file: ReadFile): Promise<void> {
  const { game, profileId } = get();
  const reader = saveReaderOf(game);
  if (!game || !reader) return;
  patch({ busy: true, error: null });
  const result = await runSaveJob({ kind: 'read', bytes, ...matchContext(game, reader.id) });
  // Another game or profile is shown now; its own link applies.
  if (get().game !== game || get().profileId !== profileId) return;
  if (!result.ok) {
    patch({ busy: false, error: result.message });
    notify(result.message, 'error');
    report({ file: file.name, ok: false, message: result.message });
    return;
  }
  const { marked } = applyMatch(result.summary, result.match, file);
  const { summary, match } = result;
  report({
    file: file.name,
    ok: true,
    version: summary.version.label,
    ...(summary.world ? { world: summary.world.id } : {}),
    matched: match.found.length,
    marked,
  });
  notify(readNotice(file.name, match, marked));
}

function readNotice(file: string, match: SaveMatch, marked: number): string {
  const parts = [`Read ${file}:`];
  const nothing = nothingNotice(match);
  if (marked > 0) parts.push(`${placesText(marked)} marked found.`);
  else if (nothing) parts.push(`nothing to mark. ${nothing}`);
  else parts.push('nothing new to mark.');
  const current = match.current;
  if (current && !current.mapId) parts.push(`No map of this pack shows ${current.name}.`);
  else if (match.needsCalibration) parts.push('Open “Game save” to place yourself on the map.');
  return parts.join(' ');
}

/** Keeps a match: new automatic fits, marks, and the link's last read. */
function applyMatch(
  summary: SaveSummary,
  match: SaveMatch,
  file: ReadFile | null,
): { marked: number } {
  const gameId = gameIdOf();
  let calibrations = get().save.calibrations;
  if (gameId && Object.keys(match.calibrated).length > 0) {
    calibrations = { ...calibrations, ...match.calibrated };
    saveSetting(SETTINGS.saveCalibration(gameId), calibrations);
  }
  const marked = markFound(match);
  const link = get().save.link;
  if (link) {
    const previous = link.last;
    const last: LastRead | null = file
      ? {
          file: file.name,
          path: file.path,
          modified: file.modified,
          readAt: Date.now(),
          version: summary.version.label,
          world: summary.world ? { id: summary.world.id, name: summary.world.name } : null,
          player: match.player,
          found: match.found.length,
          marked,
        }
      : previous && { ...previous, player: match.player, found: match.found.length };
    storeLink({ ...link, last });
  }
  patch({ busy: false, error: null, summary, match, calibrations });
  reportTableUse(match);
  return { marked };
}

/** Matches the save read before again, after a map or lining-up change. */
async function rematch(): Promise<void> {
  const { game } = get();
  const { summary } = get().save;
  const reader = saveReaderOf(game);
  if (!game || !reader || !summary) return;
  const profileId = get().profileId;
  const result = await runSaveJob({ kind: 'match', summary, ...matchContext(game, reader.id) });
  if (get().game !== game || get().profileId !== profileId || get().save.summary !== summary) {
    return;
  }
  if (result.ok) applyMatch(summary, result.match, null);
}

function report(entry: Parameters<NonNullable<typeof desktop>['saves']['report']>[0]): void {
  desktop?.saves.report(entry).catch(() => {
    // The log is a help, not a reason to bother anyone.
  });
}

/** Reads a save file the person picked in a browser (or dropped). */
export async function openSaveFile(file: File): Promise<void> {
  const link = get().save.link;
  storeLink({
    kind: 'browser',
    path: null,
    name: file.name,
    follow: false,
    last: link?.kind === 'browser' ? link.last : null,
  });
  stopFollowing();
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    patch({ error: `Could not open ${file.name}: ${errorText(error)}` });
    return;
  }
  await takeSave(bytes, { name: file.name, path: null, modified: file.lastModified || null });
}

/** Reads a save the desktop app lists. */
async function readDesktopSave(
  entry: Pick<SaveFileEntry, 'path' | 'name'> & { modified: number | null },
) {
  if (!desktop) return;
  patch({ busy: true, error: null });
  let bytes: Uint8Array;
  try {
    bytes = await desktop.saves.read(entry.path);
  } catch (error) {
    patch({ busy: false, error: errorText(error) });
    return;
  }
  await takeSave(bytes, entry);
}

/** Links a saves folder: the game's own (under Documents), or one the person chooses. */
export async function linkSaveFolder(which: 'default' | 'choose'): Promise<void> {
  const reader = saveReaderOf(get().game);
  if (!desktop || !reader) return;
  let folder: SaveFolderInfo | null;
  try {
    folder =
      which === 'default'
        ? await desktop.saves.defaultFolder(reader.id)
        : await desktop.saves.chooseFolder(reader.id);
  } catch (error) {
    patch({ error: errorText(error) });
    return;
  }
  if (!folder) return;
  if (!folder.exists) {
    patch({
      error: `${folder.path} cannot be found. Choose the folder where the game keeps its saves.`,
    });
    return;
  }
  stopFollowing();
  storeLink({ kind: 'folder', path: folder.path, name: folder.name, follow: true, last: null });
  patch({ folder, error: null });
  const newest = folder.saves[0];
  if (newest) await readDesktopSave(newest);
  else notify('There are no saves in that folder yet. Atlas reads the first one the game writes.');
  void startFollowing();
}

/** Links one save file: chosen in the desktop app's dialog. */
export async function linkSaveFile(): Promise<void> {
  const reader = saveReaderOf(get().game);
  if (!desktop || !reader) return;
  let entry: SaveFileEntry | null;
  try {
    entry = await desktop.saves.chooseFile(reader.id);
  } catch (error) {
    patch({ error: errorText(error) });
    return;
  }
  if (!entry) return;
  stopFollowing();
  storeLink({ kind: 'file', path: entry.path, name: entry.name, follow: true, last: null });
  patch({ folder: null, error: null });
  await readDesktopSave(entry);
  void startFollowing();
}

/** Reads the linked save again: the newest in the folder, or the file. */
export async function readLinkedSave(): Promise<void> {
  const link = get().save.link;
  if (!desktop || !link?.path) return;
  if (link.kind === 'folder') {
    const folder = await refreshSaveFolder();
    const newest = folder?.saves[0];
    if (newest) await readDesktopSave(newest);
    else if (folder) patch({ error: 'There are no saves in the linked folder.' });
  } else {
    await readDesktopSave({ path: link.path, name: link.name, modified: null });
  }
}

/** Lists the linked folder's saves again (desktop app). */
export async function refreshSaveFolder(): Promise<SaveFolderInfo | null> {
  const link = get().save.link;
  if (!desktop || link?.kind !== 'folder' || !link.path) return null;
  try {
    const folder = await desktop.saves.list(link.path);
    patch({ folder });
    return folder;
  } catch (error) {
    patch({ error: errorText(error) });
    return null;
  }
}

/** Forgets the linked save. Marks already made stay; see {@link removeSaveMarks}. */
export function unlinkSave(): void {
  stopFollowing();
  storeLink(null);
  patch({ summary: null, match: null, folder: null, error: null, placing: null });
}

// ---------------------------------------------------------------------------
// Following new saves (desktop app)

let followToken = 0;
let followTimer: ReturnType<typeof setInterval> | null = null;
let followRevision = 0;
let polling = false;

function stopFollowing(): void {
  followToken++;
  if (followTimer !== null) {
    clearInterval(followTimer);
    followTimer = null;
    desktop?.saves.unwatch().catch(() => {
      // Nothing to stop.
    });
  }
}

async function startFollowing(): Promise<void> {
  stopFollowing();
  const link = get().save.link;
  if (!desktop || !link?.path || !link.follow) return;
  const token = followToken;
  try {
    const status = await desktop.saves.watch(link.path);
    if (token !== followToken) return;
    followRevision = status.revision;
    followTimer = setInterval(() => {
      void pollFollow(token);
    }, FOLLOW_POLL_MS);
    // A save written while Atlas was closed.
    const newest = status.newest;
    const last = link.last;
    if (newest && (last?.file !== newest.name || last.modified !== newest.modified)) {
      await readDesktopSave(newest);
    }
  } catch (error) {
    if (token === followToken) patch({ error: errorText(error) });
  }
}

async function pollFollow(token: number): Promise<void> {
  if (!desktop || polling || get().save.busy) return;
  polling = true;
  try {
    const status = await desktop.saves.watchStatus();
    if (token !== followToken || status.revision === followRevision || !status.settled) return;
    followRevision = status.revision;
    await readDesktopSave(status.settled);
    if (get().save.link?.kind === 'folder') void refreshSaveFolder();
  } catch {
    // The next look may work; a lasting problem shows when reading.
  } finally {
    polling = false;
  }
}

/** Turns "Follow new saves" on or off. */
export function setFollowSaves(follow: boolean): void {
  const link = get().save.link;
  if (!link || link.kind === 'browser') return;
  storeLink({ ...link, follow });
  if (follow) void startFollowing();
  else stopFollowing();
}

// ---------------------------------------------------------------------------
// Marks

/** Places found only because a save said so, in a profile's rows. */
export function saveMarkTargets(
  game: LoadedGame | null,
  rows: ReadonlyMap<string, ProgressRecord>,
): string[] {
  return game ? targetsMarkedFromSaves([...rows.values()], game.pack.currentId) : [];
}

/** Takes back every mark made from saves in the active profile; marks made by hand stay. */
export function removeSaveMarks(): void {
  const targets = saveMarkTargets(get().game, get().rows);
  if (targets.length === 0) {
    notify('No locations are marked from saves.');
    return;
  }
  applyProgress(
    targets.map((targetId) => ({ targetId, found: false })),
    { undone: 'Undone: the marks made from saves are back.', selectId: null },
    'save',
  );
  notify(
    `Removed ${targets.length === 1 ? 'the mark' : `${targets.length} marks`} made from saves. Marks you made by hand are as they were.`,
    'info',
    { undo: true },
  );
}

// ---------------------------------------------------------------------------
// Maps and lining up

/** Shows a game world on another map, or on none (null). */
export function setWorldMap(worldId: string, mapId: string | null): void {
  const gameId = gameIdOf();
  if (!gameId) return;
  const worldMaps = { ...get().save.worldMaps, [worldId]: mapId };
  saveSetting(SETTINGS.saveWorlds(gameId), worldMaps);
  patch({ worldMaps });
  void rematch();
}

/** Starts marking where the player stood on the current world's map. */
export function startPlacing(): void {
  const { match, summary } = get().save;
  const mapId = match?.current?.mapId;
  const position = summary?.player?.position;
  if (!mapId || !position) return;
  if (get().mapId !== mapId) showMap(mapId);
  patch({ placing: { mapId, world: { x: position.x, y: position.y } } });
  useAtlas.setState({ saveDialogOpen: false });
}

export function cancelPlacing(): void {
  patch({ placing: null });
}

/** The person clicked where they stood: keep the spot, and line the map up once there are two. */
export function placePlayerAt(mapId: string | null, pixel: { x: number; y: number }): void {
  const { placing } = get().save;
  const gameId = gameIdOf();
  if (placing?.mapId !== mapId || !gameId) return;
  const spot: CalibrationPoint = { world: placing.world, pixel: { x: pixel.x, y: pixel.y } };
  // The same save placed again replaces its spot.
  const spots = [
    ...(get().save.points[mapId] ?? []).filter((p) => distance(p.world, spot.world) > 1),
    spot,
  ].slice(-8);
  const points = { ...get().save.points, [mapId]: spots };
  saveSetting(SETTINGS.savePoints(gameId), points);
  const fit = fitPoints(spots, MIN_SPOT_DISTANCE);
  if (!fit) {
    patch({ points, placing: null });
    notify(
      `Spot saved. To line this map up, save the game somewhere at least ${MIN_SPOT_DISTANCE} m away, read that save, and place yourself again.`,
    );
    return;
  }
  const calibrations: Record<string, MapCalibration> = {
    ...get().save.calibrations,
    [mapId]: {
      source: 'manual',
      transform: fit.transform,
      points: spots,
      at: Date.now(),
    },
  };
  saveSetting(SETTINGS.saveCalibration(gameId), calibrations);
  patch({ points, calibrations, placing: null });
  notify('The map is lined up with the game world.');
  void rematch();
}

/** Forgets how a map is lined up (by hand or from pins), and the spots marked on it. */
export function resetCalibration(mapId: string): void {
  const gameId = gameIdOf();
  if (!gameId) return;
  const { [mapId]: _calibration, ...calibrations } = get().save.calibrations;
  const { [mapId]: _points, ...points } = get().save.points;
  saveSetting(SETTINGS.saveCalibration(gameId), calibrations);
  saveSetting(SETTINGS.savePoints(gameId), points);
  patch({ calibrations, points });
  void rematch();
}

/** Moves the map to where the player last saved. */
export function showPlayer(): void {
  const player = shownPlayer(get().save);
  if (player) goToPoint(player.mapId, player.x, player.y);
}

export function setSaveDialogOpen(open: boolean): void {
  useAtlas.setState({ saveDialogOpen: open });
  if (open) void refreshSaveFolder();
}

// ---------------------------------------------------------------------------
// The game's own map places (desktop app)
//
// The desktop app unpacks the game's map pin files from the folder the
// person chose (read-only); the save worker builds the table from them;
// the table is kept in this device's settings, keyed to the game's
// executable, and read again when the game is patched. The activity log
// gets counts only.

function patchTable(part: Partial<GameTableState>): void {
  patch({ gameTable: { ...get().save.gameTable, ...part } });
}

/** The table was read from another version of the game than the one in the folder now. */
export function tableStale(state: GameTableState): boolean {
  return Boolean(state.table && state.folder?.valid && state.folder.stamp !== state.table.stamp);
}

function reportGameFiles(report: GameFilesReport): void {
  desktop?.gameFiles.report(report).catch(() => {
    // The log is a help, not a reason to bother anyone.
  });
}

let lastTableReport = '';

/** Logs how a match used the table: counts and fits only, once per change. */
function reportTableUse(match: SaveMatch): void {
  if (!match.table) return;
  const fits = Object.fromEntries(
    match.worlds.flatMap((world) => (world.fit ? [[world.worldId, world.fit] as const] : [])),
  );
  const report: GameFilesReport = {
    kind: 'match',
    saveTags: match.table.tags,
    saveTagsFound: match.table.found,
    fits,
  };
  const key = JSON.stringify(report);
  if (key === lastTableReport) return;
  lastTableReport = key;
  reportGameFiles(report);
}

/** Checks the chosen game folder; reads the map places again when the game was patched. */
async function checkGameFolder(token = loadToken): Promise<void> {
  const reader = saveReaderOf(get().game);
  if (!desktop || !reader?.readsGameFiles) return;
  let folder: GameFolderInfo;
  try {
    folder = await desktop.gameFiles.folder(reader.id);
  } catch {
    return;
  }
  if (token !== loadToken) return;
  patchTable({ folder: folder.path ? folder : null });
  if (tableStale(get().save.gameTable)) void readGameTable();
}

/** Why a scan gave no files to read, in plain words. */
function noFilesText(scan: GameFilesScan): string {
  if (scan.bundles === 0) {
    return 'Atlas found no bundles in the game folder, so it cannot read the map locations.';
  }
  const unknown = scan.layouts.unknown ?? 0;
  if (unknown * 2 >= scan.bundles) {
    return 'The game’s bundles have a file layout Atlas does not know, so it cannot find the map files in them.';
  }
  return 'Atlas found no map files in the game’s bundles: an unknown file layout.';
}

/** Why no map file could be unpacked, in plain words. */
function unpackFailedText(problems: readonly string[]): string {
  if (problems.some((p) => p.includes('Doboz') || p.includes('compression Atlas'))) {
    return 'The game’s map files are packed with a compression Atlas cannot read yet, so it cannot read the map locations.';
  }
  if (problems.some((p) => p.includes('CR2W'))) {
    return 'The game’s map files did not unpack the way Atlas expects: an unknown file layout.';
  }
  return problems[0] ?? 'Atlas could not read the game’s map files.';
}

let tableToken = 0;

/** Reads the game's map places from the chosen folder (desktop app), and keeps them on this device. */
export async function readGameTable(): Promise<void> {
  const reader = saveReaderOf(get().game);
  if (!desktop || !reader?.readsGameFiles) return;
  const bridge = desktop;
  const token = ++tableToken;
  const game = get().game;
  const set = (part: Partial<GameTableState>) => {
    if (token === tableToken && get().game === game) patchTable(part);
  };
  set({ busy: 'Looking through the game’s bundles…', error: null });
  try {
    const folder = await bridge.gameFiles.folder(reader.id);
    set({ folder: folder.path ? folder : null });
    if (!folder.valid) {
      set({ busy: null, error: folder.problem ?? 'Choose the game’s folder first.' });
      return;
    }
    const scan = await bridge.gameFiles.scan(reader.id);
    if (scan.files.length === 0) {
      set({ busy: null, error: noFilesText(scan) });
      return;
    }
    const files: GameFileInput[] = [];
    const problems: string[] = [];
    for (const [i, file] of scan.files.entries()) {
      set({ busy: `Unpacking the game’s map files (${i + 1} of ${scan.files.length})…` });
      try {
        files.push({ path: file.path, bytes: await bridge.gameFiles.read(reader.id, file.index) });
      } catch (error) {
        problems.push(errorText(error));
      }
    }
    if (files.length === 0) {
      set({ busy: null, error: unpackFailedText(problems) });
      return;
    }
    set({ busy: 'Reading the map locations…' });
    const result = await runTableJob({
      kind: 'table',
      readerId: reader.id,
      files,
      stamp: scan.stamp,
      now: Date.now(),
    });
    if (token !== tableToken || get().game !== game) return;
    if (!result.ok) {
      set({ busy: null, error: result.message });
      return;
    }
    reportGameFiles({ kind: 'table', readFailed: problems.length, ...result.stats });
    const pins = Object.values(result.table.worlds).reduce((sum, list) => sum + list.length, 0);
    if (pins === 0) {
      set({
        busy: null,
        error:
          'Atlas read the game’s map files but found no map locations in them: an unknown file layout.',
      });
      return;
    }
    saveSetting(SETTINGS.gamePins(reader.id), result.table);
    set({
      busy: null,
      error: null,
      table: result.table,
      last: { files: files.length, unreadable: problems.length, pins },
    });
    notify(`Read ${pins === 1 ? '1 map location' : `${pins} map locations`} from the game.`);
    void rematch();
  } catch (error) {
    set({ busy: null, error: errorText(error) });
  }
}

/** Asks for the game's folder (desktop app), then reads its map places. */
export async function chooseGameFolder(): Promise<void> {
  const reader = saveReaderOf(get().game);
  if (!desktop || !reader?.readsGameFiles) return;
  let folder: GameFolderInfo | null;
  try {
    folder = await desktop.gameFiles.chooseFolder(reader.id);
  } catch (error) {
    patchTable({ error: errorText(error) });
    return;
  }
  if (!folder) return;
  if (!folder.valid) {
    patchTable({ error: folder.problem ?? 'That is not the game’s folder.' });
    return;
  }
  patchTable({ folder, error: null });
  await readGameTable();
}

/** Forgets the game folder and the map places read from it. */
export async function forgetGameTable(): Promise<void> {
  const reader = saveReaderOf(get().game);
  if (!reader?.readsGameFiles) return;
  tableToken++;
  saveSetting(SETTINGS.gamePins(reader.id), null);
  patch({ gameTable: NO_GAME_TABLE });
  try {
    await desktop?.gameFiles.forgetFolder(reader.id);
  } catch {
    // Nothing remembered.
  }
  void rematch();
}
