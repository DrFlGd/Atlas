import {
  MAP_KIND,
  canAddPage,
  catalogueAt,
  pageKey,
  type AtlasImporter,
  type ListedPage,
} from '@atlas/importer-api';
import { create } from 'zustand';
import { desktop } from '../desktop';
import type { GamePick } from './gameChoice';
import { joinSameTitle, type TitleMatch } from './gameGroups';
import { fileUnderSystem } from './gameTags';
import {
  addGamePages,
  loadImporters,
  readGamePage,
  recordedKeys,
  showCatalogue,
  showGamesStep,
  sitePauseMs,
  siteWayOf,
  stopRun,
  useImport,
} from './importing';
import { RUN_PAUSE_MS, stopReasonText, type RunState } from './importRun';
import { SETTINGS, progressStore } from './services';
import { useAtlas } from './store';

/**
 * Adding the games of a site's list one after another (the issue: add
 * every game of a list page at once). The person ticks games in the list
 * (with Tick all), sees what is known of them before anything is fetched
 * (how many maps, how much room, the room there is), and starts. Then for
 * each game in turn: its game page is read (a game with one map needs
 * none), and every page of it the importer can add that is not in the maps
 * folder yet is added, as a go of its own. Between two pages there is the
 * pause of the site's rules file, never less than the app's own, and only
 * one page is read at a time.
 *
 * It stops at the first refusal (a go stops there, and so does the
 * session), when the person closes the page window or presses Stop, and
 * after two games in a row whose pages gave no data. What is left is kept
 * (the `gameSession` setting) and the person can continue later: games
 * added are skipped, and the pages of a game already in the maps folder
 * are not read again.
 *
 * Each game added is filed under its system (the System tag of the
 * Library: the game's own in the list, the list's, or what the person
 * typed), unless the person chose its systems already, and shown with the
 * game here of the same title, matched as the Importer's offer matches
 * them, only when that is sure. The session ends with the games it could
 * not match, for the person to put together by hand.
 */

/** A game of the session, as the list gave it. */
export interface SessionGame {
  id: string;
  name: string;
  address: string;
  /** Its address is its one map page: no game page to read. */
  direct: boolean;
  /** How many maps it has, when the list says so. */
  maps?: number;
  /** About how many bytes its maps take, when the list says so. */
  bytes?: number;
  /** The system it is for, when the list says so. */
  system?: string;
}

/** What came of one game. */
export type GameResult =
  | {
      kind: 'added';
      packId: string;
      title: string;
      /** Pages added and pages that could not be. */
      added: number;
      failed: number;
      /** How it was matched by its title; null when its pages went into a game here before. */
      match: TitleMatch | null;
      /** The system it was filed under, when it was. */
      system: string | null;
      /** The session stopped while its pages were read: some are left. */
      partial?: boolean;
    }
  /** Nothing to add: its maps are here already, or its game page lists none. */
  | { kind: 'nothing'; message: string }
  | { kind: 'failed'; message: string; noData?: boolean };

export interface GameSession {
  importerId: string;
  importerTitle: string;
  /** The site's name, for the person. */
  site: string;
  /** The list of games' address. */
  catalogue: string;
  /** The system the games are filed under when the list does not say one of a game; '' for none. */
  system: string;
  games: SessionGame[];
  /** What came of each game dealt with, by its id. */
  results: Record<string, GameResult>;
  /** Why it stopped before the end, when it did. */
  stopped: string | null;
  /** When it was planned, as an ISO time. */
  startedAt: string;
}

interface GameSessionState {
  /** The session shown: planned, going or done. */
  session: GameSession | null;
  going: boolean;
  /** The game being read now. */
  current: string | null;
  /** The next page is read at this time (ms), during the pause. */
  nextAt: number | null;
  stopAsked: boolean;
  /** Bytes free on the drive of the maps folder: undefined until asked, null when not known. */
  free: number | null | undefined;
  /** A session stopped before its end, kept to continue (read once). */
  kept: GameSession | null;
}

export const useGameSession = create<GameSessionState>()(() => ({
  session: null,
  going: false,
  current: null,
  nextAt: null,
  stopAsked: false,
  free: undefined,
  kept: null,
}));

const get = useGameSession.getState;
const set = useGameSession.setState;

// ---------------------------------------------------------------------------
// What is known before anything is read

/** Whether a game is still to be added: not dealt with, or stopped half-way. */
export const isLeft = (session: GameSession, id: string): boolean => {
  const result = session.results[id];
  return !result || (result.kind === 'added' && result.partial === true);
};

/** The games still to add, in order. */
export const gamesLeft = (session: GameSession): SessionGame[] =>
  session.games.filter((game) => isLeft(session, game.id));

/** What the list says of the games left, added up, and what it does not say. */
export interface SessionTotals {
  games: number;
  /** Maps of the games whose count the list gives, and how many games it does not give it for. */
  maps: number;
  mapsUnknown: number;
  /** Bytes of the games whose size the list gives, and how many games it does not give it for. */
  bytes: number;
  bytesUnknown: number;
}

export function sessionTotals(games: readonly SessionGame[]): SessionTotals {
  const totals: SessionTotals = {
    games: games.length,
    maps: 0,
    mapsUnknown: 0,
    bytes: 0,
    bytesUnknown: 0,
  };
  for (const game of games) {
    if (game.maps === undefined) totals.mapsUnknown++;
    else totals.maps += game.maps;
    if (game.bytes === undefined) totals.bytesUnknown++;
    else totals.bytes += game.bytes;
  }
  return totals;
}

/**
 * Whether the games fit in the room there is: false only when the sizes
 * the list gives already need more than is free.
 */
export const roomFor = (totals: SessionTotals, free: number | null | undefined): boolean =>
  free === null || free === undefined || totals.bytes <= free;

/**
 * The pages of a game page to add: every page the importer can add (as the
 * list of pages ticks them), only its maps for an importer that reads page
 * by page (a wiki's pages are many), and none already in the maps folder.
 */
export function pagesToAdd(
  importer: Pick<AtlasImporter, 'matches' | 'fetch'>,
  listed: readonly ListedPage[],
  recorded: ReadonlySet<string>,
): { url: string; title: string; group?: string }[] {
  const seen = new Set<string>();
  return listed.flatMap((page) => {
    const key = pageKey(page.url);
    if (seen.has(key) || recorded.has(key) || !canAddPage(importer, page.url)) return [];
    if (importer.fetch && page.kind !== MAP_KIND) return [];
    seen.add(key);
    return [{ url: page.url, title: page.title, ...(page.group ? { group: page.group } : {}) }];
  });
}

/** The game most pages of a go were added to, with how many were added and failed. */
export function goOutcome(run: RunState): {
  packId: string | null;
  added: number;
  failed: number;
  noData: boolean;
} {
  const counts = new Map<string, number>();
  let failed = 0;
  let noData = 0;
  for (const { state } of run.pages) {
    if (state.kind === 'added') counts.set(state.packId, (counts.get(state.packId) ?? 0) + 1);
    if (state.kind === 'failed') {
      failed++;
      if (state.cause === 'no-data') noData++;
    }
  }
  let packId: string | null = null;
  let most = 0;
  for (const [id, count] of counts) {
    if (count > most) {
      packId = id;
      most = count;
    }
  }
  const added = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return { packId, added, failed, noData: added === 0 && noData > 0 };
}

/** The games added that were not shown with another game of the same title. */
export function unmatched(
  session: GameSession,
): { game: SessionGame; result: Extract<GameResult, { kind: 'added' }> }[] {
  return session.games.flatMap((game) => {
    const result = session.results[game.id];
    return result?.kind === 'added' && result.match !== null && result.match.kind !== 'joined'
      ? [{ game, result }]
      : [];
  });
}

/** A session as it was kept, if it is one; anything else is null. */
export function keptSession(value: unknown): GameSession | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<GameSession>;
  if (
    typeof v.importerId !== 'string' ||
    typeof v.importerTitle !== 'string' ||
    typeof v.site !== 'string' ||
    typeof v.catalogue !== 'string' ||
    typeof v.system !== 'string' ||
    typeof v.startedAt !== 'string' ||
    !Array.isArray(v.games) ||
    !v.results ||
    typeof v.results !== 'object'
  ) {
    return null;
  }
  const games = v.games.filter(
    (game): game is SessionGame =>
      typeof game === 'object' &&
      typeof game.id === 'string' &&
      typeof game.name === 'string' &&
      typeof game.address === 'string' &&
      typeof game.direct === 'boolean',
  );
  if (games.length === 0) return null;
  return {
    importerId: v.importerId,
    importerTitle: v.importerTitle,
    site: v.site,
    catalogue: v.catalogue,
    system: v.system,
    games,
    results: v.results,
    stopped: typeof v.stopped === 'string' ? v.stopped : null,
    startedAt: v.startedAt,
  };
}

// ---------------------------------------------------------------------------
// Kept between sessions of the app

async function keep(session: GameSession | null): Promise<void> {
  set({ kept: session && gamesLeft(session).length > 0 ? session : null });
  await progressStore()
    .putSetting(SETTINGS.gameSession, get().kept)
    .catch(() => undefined);
}

let readKept: Promise<void> | null = null;

/** Reads the session kept from before, once. */
export function loadKeptSession(): Promise<void> {
  readKept ??= (async () => {
    const value = await progressStore()
      .getSetting(SETTINGS.gameSession)
      .catch(() => null);
    if (!get().going) set({ kept: keptSession(value) });
  })();
  return readKept;
}

/** Forgets the session kept: the games left are not added. */
export function forgetKeptSession(): void {
  void keep(null);
}

// ---------------------------------------------------------------------------
// The steps

async function askFree(): Promise<void> {
  set({ free: undefined });
  const free = desktop ? await desktop.library.freeSpace().catch(() => null) : null;
  set({ free });
}

/** The list of games the plan came from, to go back to it. */
let backTo: GamePick | null = null;

/** "Add the ticked games one at a time": the plan of the games ticked in a list of games. */
export async function planGames(pick: GamePick): Promise<void> {
  const importer = (await loadImporters()).find((i) => i.id === pick.importerId);
  const listSystem = importer ? (catalogueAt(importer, pick.url)?.system ?? '') : '';
  const games = pick.games
    .filter((game) => pick.ticked.includes(game.id))
    .map((game): SessionGame => ({
      id: game.id,
      name: game.name,
      address: game.address,
      direct: game.direct,
      ...(game.maps !== undefined ? { maps: game.maps } : {}),
      ...(game.bytes !== undefined ? { bytes: game.bytes } : {}),
      ...(game.system ? { system: game.system } : {}),
    }));
  if (games.length === 0) return;
  backTo = pick;
  set({
    session: {
      importerId: pick.importerId,
      importerTitle: pick.importerTitle,
      site: pick.site ?? pick.importerTitle,
      catalogue: pick.url,
      system: listSystem,
      games,
      results: {},
      stopped: null,
      startedAt: new Date().toISOString(),
    },
    stopAsked: false,
  });
  showGamesStep('plan');
  void askFree();
}

/** Back from the plan: to the list of games as it was ticked, or to the address box. */
export function leavePlan(): void {
  const pick = backTo;
  backTo = null;
  set({ session: null });
  if (pick) showCatalogue(pick);
  else useImport.setState({ phase: { kind: 'idle' } });
}

/** Shows the session kept from before, with the games left, to continue it. */
export async function continueKeptSession(): Promise<void> {
  await loadKeptSession();
  const kept = get().kept;
  if (!kept || get().going) return;
  backTo = null;
  set({ session: { ...kept, stopped: null }, stopAsked: false });
  showGamesStep('plan');
  void askFree();
}

/** The system the games are filed under when the list does not say one of a game. */
export function setSessionSystem(system: string): void {
  const session = get().session;
  if (session && !get().going) set({ session: { ...session, system: system.slice(0, 80) } });
}

/** Wakes the pause between two pages, when Stop is pressed. */
let wake: (() => void) | null = null;

/** Stops the session after the page open now; what is left is kept. */
export function stopGames(): void {
  if (!get().going) return;
  set({ stopAsked: true });
  stopRun();
  wake?.();
}

/** Done with the summary: back to the address box. */
export function closeGames(): void {
  if (get().going) return;
  set({ session: null, current: null, nextAt: null });
  useImport.setState({ phase: { kind: 'idle' } });
}

function pause(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  set({ nextAt: Date.now() + ms });
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wake = null;
      set({ nextAt: null });
      resolve();
    }
    wake = done;
  });
}

const STOPPED = 'You stopped adding games. The games left are kept, to continue later.';
const NO_DATA_TWICE =
  'The pages of two games in a row did not provide their data, so this app stopped rather than read the rest. The site may be asking you to sign in or to confirm you are a person, or it may not be letting pages load just now. You can continue later.';

/** Starts, or continues, adding the games of the plan shown, one at a time. */
export async function startGames(): Promise<void> {
  const planned = get().session;
  if (!planned || get().going) return;
  let session: GameSession = { ...planned, stopped: null };
  const update = (next: GameSession) => {
    session = next;
    set({ session });
  };
  const note = async (id: string, result: GameResult) => {
    update({ ...session, results: { ...session.results, [id]: result } });
    await keep(session);
  };
  set({ going: true, stopAsked: false, session, kept: null });
  showGamesStep('going');
  await keep(session);
  try {
    const importer = (await loadImporters()).find((i) => i.id === session.importerId);
    if (!importer) {
      update({
        ...session,
        stopped: 'The importer of this list is not in this app now, so nothing was read.',
      });
      return;
    }
    if ((await siteWayOf(importer, session.catalogue)) === 'browse') {
      update({
        ...session,
        stopped:
          'You chose to read this site only as you browse it, so this app does not open its pages by itself. Choose another way to read it to add its games.',
      });
      return;
    }
    // Games here before the session, and those it adds, are never matched with each other.
    const apart = new Set(session.games.map((game) => game.id));
    let lastRead = 0;
    let noDataInARow = 0;
    const waitPause = async (url: string) => {
      // The pause of the site's rules file between two pages, never less than the app's own.
      const ms = Math.max(RUN_PAUSE_MS, sitePauseMs(importer, url));
      const left = lastRead + ms - Date.now();
      if (lastRead === 0 || left <= 0) return;
      showGamesStep('going');
      await pause(left);
    };
    for (const game of session.games) {
      if (!isLeft(session, game.id)) continue;
      if (get().stopAsked) {
        update({ ...session, stopped: STOPPED });
        break;
      }
      set({ current: game.id });
      showGamesStep('going');
      let listed: ListedPage[];
      if (game.direct) {
        listed = [{ url: game.address, kind: MAP_KIND, title: game.name }];
      } else {
        await waitPause(game.address);
        if (get().stopAsked) {
          update({ ...session, stopped: STOPPED });
          break;
        }
        const read = await readGamePage(importer, game.address);
        lastRead = Date.now();
        if (!read) {
          update({ ...session, stopped: 'Adding games was cancelled. The games left are kept.' });
          break;
        }
        if (read.run.stopReason) {
          update({ ...session, stopped: stopReasonText(read.run.stopReason) });
          break;
        }
        if (!read.pages) {
          const noData = read.run.pages.some(
            (page) => page.state.kind === 'failed' && page.state.cause === 'no-data',
          );
          await note(game.id, {
            kind: 'failed',
            message: read.message ?? 'Its game page could not be read.',
            ...(noData ? { noData } : {}),
          });
          noDataInARow = noData ? noDataInARow + 1 : 0;
          if (noDataInARow >= 2) {
            update({ ...session, stopped: NO_DATA_TWICE });
            break;
          }
          continue;
        }
        listed = read.pages;
      }
      const pages = pagesToAdd(importer, listed, recordedKeys());
      if (pages.length === 0) {
        const any = pagesToAdd(importer, listed, new Set()).length > 0;
        await note(game.id, {
          kind: 'nothing',
          message: any
            ? 'Its maps are in your maps folder already.'
            : 'Its game page lists no map this app can add.',
        });
        continue;
      }
      await waitPause(pages[0]!.url);
      if (get().stopAsked) {
        update({ ...session, stopped: STOPPED });
        break;
      }
      const before = new Set(useAtlas.getState().library?.packs.map((pack) => pack.id) ?? []);
      const final = await addGamePages(importer, pages);
      lastRead = Date.now();
      if (!final) {
        update({ ...session, stopped: 'This app cannot read pages here.' });
        break;
      }
      const outcome = goOutcome(final);
      const stopped = final.stopReason;
      if (outcome.packId) {
        const packId = outcome.packId;
        const entry = useAtlas.getState().catalog.find((e) => e.id === packId);
        const system = (game.system ?? session.system).trim();
        const filed = system !== '' && (await fileUnderSystem(packId, system));
        const isNew = !before.has(packId);
        const match = isNew ? await joinSameTitle(packId, apart) : null;
        apart.add(packId);
        await note(game.id, {
          kind: 'added',
          packId,
          title: entry?.title ?? game.name,
          added: outcome.added,
          failed: outcome.failed,
          match,
          system: filed ? system : null,
          ...(stopped ? { partial: true } : {}),
        });
        noDataInARow = 0;
      } else if (!stopped) {
        const first = final.pages.find((page) => page.state.kind === 'failed')?.state;
        await note(game.id, {
          kind: 'failed',
          message: first?.kind === 'failed' ? first.message : 'None of its pages could be added.',
          ...(outcome.noData ? { noData: true } : {}),
        });
        noDataInARow = outcome.noData ? noDataInARow + 1 : 0;
        if (noDataInARow >= 2) {
          update({ ...session, stopped: NO_DATA_TWICE });
          break;
        }
      }
      if (stopped) {
        update({
          ...session,
          stopped: stopped === 'stop' ? STOPPED : stopReasonText(stopped),
        });
        break;
      }
    }
  } finally {
    set({ going: false, current: null, nextAt: null });
    await keep(session);
    // Another import that took over shows its own steps.
    const phase = useImport.getState().phase;
    if (phase.kind === 'games' || phase.kind === 'listing' || phase.kind === 'run') {
      showGamesStep('done');
    }
  }
}
