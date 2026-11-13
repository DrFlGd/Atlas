import {
  addOwnLocation,
  changeOwnLocation,
  ChecklistIndex,
  indexPack,
  mergeOwnFiles,
  mergeOwnLocations,
  newOwnArea,
  newOwnId,
  newOwnType,
  newOwnTypeGroup,
  OWN_TYPE_COLOURS,
  ProgressCounter,
  putOwnArea,
  putOwnType,
  removeOwnArea,
  removeOwnLocation,
  removeOwnOfMap,
  removeOwnType,
  SearchIndex,
  takenRecordIds,
  type LoadedPack,
  type OwnLocationChanges,
  type OwnTypeFields,
} from '@atlas/core';
import {
  countOwnLocations,
  isOwnId,
  NO_OWN_LOCATIONS,
  OWN_LOCATIONS_VERSION,
  readOwnLocationsFile,
  writeOwnLocationsFile,
  type Category,
  type CategoryGroup,
  type OwnLocation,
  type OwnLocations,
  type Region,
} from '@atlas/schema';
import { create } from 'zustand';
import { desktop } from '../desktop';
import { progressStore } from './services';
import { useAtlas } from './store';
import type { SaveState } from './ownLists';

/**
 * A person's own locations, types and areas of the game shown (see
 * `ownLocations.ts` in the schema package), and where they are kept, as own
 * lists are (see `ownLists.ts`):
 *
 * - in the desktop app, a file beside the game's folder in the maps folder
 *   (`<game id>.my-locations.json`), through the shell
 *   (`desktop.ownLocations`);
 * - in the Android app and a browser, in the app's own storage, where
 *   progress is kept, as a setting of the game (`ownLocations:<game id>`).
 *
 * They are read before the game is shown and added to its pack data
 * (`mergeOwnLocations`), so the game the app shows has them like any other.
 * The pack as it was read is kept here, and each change makes the game
 * again from it. Changes are saved a short while after the last one, and at
 * once when the page is hidden or closed and when asked
 * (`flushOwnLocations`). Every change can be undone while the game is shown.
 */

export interface OwnLocationsState {
  /** The game they are of; null before a game is loaded. */
  gameId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Why they could not be read (status `error`); nothing is written over them then. */
  error: string | null;
  /** Why they can be shown but not changed here (a newer app wrote them), or null. */
  readOnly: string | null;
  own: OwnLocations;
  save: SaveState;
  saveError: string | null;
  /** What each change replaced, newest last, for Undo; and what it was. */
  undo: { before: OwnLocations; label: string }[];
}

const INITIAL: OwnLocationsState = {
  gameId: null,
  status: 'idle',
  error: null,
  readOnly: null,
  own: NO_OWN_LOCATIONS,
  save: 'saved',
  saveError: null,
  undo: [],
};

export const useOwnLocations = create<OwnLocationsState>()(() => INITIAL);

const get = useOwnLocations.getState;
const set = useOwnLocations.setState;

/** The most changes Undo keeps. */
const MAX_UNDO = 100;

// ---------------------------------------------------------------------------
// Where they are kept

/** The key of a game's own locations among the settings, where the shell has no file for them. */
export const ownLocationsSetting = (gameId: string) => `ownLocations:${gameId}`;

interface Backend {
  read(gameId: string): Promise<string | null>;
  write(gameId: string, text: string, keepCopy?: string): Promise<void>;
  remove(gameId: string): Promise<boolean>;
}

const browserBackend: Backend = {
  async read(gameId) {
    const value = await progressStore().getSetting(ownLocationsSetting(gameId));
    return typeof value === 'string' ? value : null;
  },
  async write(gameId, text, keepCopy) {
    const store = progressStore();
    if (keepCopy) {
      const before = await store.getSetting(ownLocationsSetting(gameId));
      if (typeof before === 'string') {
        await store.putSetting(`${ownLocationsSetting(gameId)}:copy:${keepCopy}`, before);
      }
    }
    await store.putSetting(ownLocationsSetting(gameId), text);
  },
  async remove(gameId) {
    const store = progressStore();
    const before = await store.getSetting(ownLocationsSetting(gameId));
    await store.putSetting(ownLocationsSetting(gameId), null);
    return typeof before === 'string';
  },
};

/** Where own locations are kept on this device (see the top of this file). */
export function ownLocationsBackend(): Backend {
  const { app } = useAtlas.getState();
  if (desktop && app?.ownLocationFiles === true) {
    const bridge = desktop;
    return {
      read: (gameId) => bridge.ownLocations.read(gameId),
      write: async (gameId, text, keepCopy) => {
        await bridge.ownLocations.write(gameId, text, keepCopy);
      },
      remove: (gameId) => bridge.ownLocations.delete(gameId),
    };
  }
  return browserBackend;
}

/** Where own locations are kept, in words, for the person. */
export function ownLocationsPlace(): string {
  const { app } = useAtlas.getState();
  return desktop && app?.ownLocationFiles === true
    ? 'in a file of their own beside the game’s folder in the maps folder'
    : 'in this app’s storage on this device, with your progress';
}

// ---------------------------------------------------------------------------
// Reading, and the game with them

/** The pack of the game shown as it was read, without the person's own records. */
let base: { gameId: string; pack: LoadedPack } | null = null;
let readToken = 0;
let keepCopyNext = false;

/** What reading a game's own locations found. */
export interface OwnLocationsLoaded {
  own: OwnLocations;
  /** A sentence for the person when something could not be read, or null. */
  problem: string | null;
}

/** Parses the text of an own locations file of a game. */
export function parseOwnLocations(
  gameId: string,
  text: string,
): { ok: true; own: OwnLocations; newer: boolean; skipped: number } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  const read = readOwnLocationsFile(value);
  if (!read.ok) return read;
  if (read.file.gameId !== gameId) {
    return { ok: false, error: 'These locations and types are of another game.' };
  }
  return {
    ok: true,
    own: read.file.own,
    newer: read.file.version > OWN_LOCATIONS_VERSION,
    skipped: read.file.skipped,
  };
}

/**
 * Reads the own locations, types and areas of a game as it opens. Never
 * throws: what cannot be read is left as it is, said in `problem`, and not
 * written over.
 */
export async function readOwnLocationsOf(gameId: string): Promise<OwnLocationsLoaded> {
  const token = ++readToken;
  void flushOwnLocations();
  keepCopyNext = false;
  set({ ...INITIAL, gameId, status: 'loading' });
  try {
    const text = await ownLocationsBackend().read(gameId);
    if (token !== readToken) return { own: NO_OWN_LOCATIONS, problem: null };
    if (text === null) {
      set({ status: 'ready' });
      return { own: NO_OWN_LOCATIONS, problem: null };
    }
    const parsed = parseOwnLocations(gameId, text);
    if (!parsed.ok) {
      const error =
        'Your locations and types for this game could not be read, so they were left as they are. Nothing will be written over them.';
      set({ status: 'error', error });
      return { own: NO_OWN_LOCATIONS, problem: error };
    }
    set({
      status: 'ready',
      own: parsed.own,
      readOnly: parsed.newer
        ? 'Your locations and types were saved by a newer version of Atlas, so they are shown here but can be changed only there.'
        : null,
    });
    if (parsed.skipped > 0 && !parsed.newer) {
      keepCopyNext = true;
      return {
        own: parsed.own,
        problem:
          parsed.skipped === 1
            ? 'One of your locations or types could not be read and is left out. A copy of the file as it was is kept when you next change one.'
            : `${parsed.skipped} of your locations and types could not be read and are left out. A copy of the file as it was is kept when you next change one.`,
      };
    }
    return { own: parsed.own, problem: null };
  } catch (error) {
    if (token !== readToken) return { own: NO_OWN_LOCATIONS, problem: null };
    const message = `Your locations and types for this game could not be read: ${error instanceof Error ? error.message : String(error)}`;
    set({ status: 'error', error: message });
    return { own: NO_OWN_LOCATIONS, problem: message };
  }
}

/**
 * The pack with a person's own records added (the same pack when they add
 * nothing), and how many were left out. Keeps `pack` as the game's pack as
 * read, which every change starts from.
 */
export function packWithOwn(
  pack: LoadedPack,
  own: OwnLocations,
): { pack: LoadedPack; skipped: number } {
  base = { gameId: pack.manifest.gameId, pack };
  const merged = mergeOwnLocations(pack.data, own);
  return {
    pack: merged.data === pack.data ? pack : indexPack(merged.data, pack.baseUrl),
    skipped: merged.skipped,
  };
}

/** Makes the game shown again with the own records as they are now. */
function remakeGame(): void {
  const { game, selectedId } = useAtlas.getState();
  if (!game || base?.gameId !== game.pack.manifest.gameId) return;
  if (get().gameId !== base.gameId) return;
  const { pack } = packWithOwn(base.pack, get().own);
  const counter = new ProgressCounter(pack);
  const search = new SearchIndex(pack);
  const checklists = new ChecklistIndex(pack, (id) => counter.isTrackable(id));
  useAtlas.setState({
    game: { ...game, pack, counter, search, checklists },
    ...(selectedId !== null && !pack.locations.has(selectedId) ? { selectedId: null } : {}),
  });
}

/** Whether own locations can be changed now. */
export function canChangeOwnLocations(state: OwnLocationsState = get()): boolean {
  return state.status === 'ready' && state.readOnly === null;
}

/** Whether a location, type, group or area is the person's own (and so can be changed here). */
export const isOwnRecord = (id: string): boolean => isOwnId(id);

// ---------------------------------------------------------------------------
// Saving

const SAVE_DELAY_MS = 700;
let timer: number | undefined;
let writing: Promise<void> = Promise.resolve();
let dirty = false;

function scheduleSave(): void {
  dirty = true;
  set({ save: 'unsaved', saveError: null });
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    void flushOwnLocations();
  }, SAVE_DELAY_MS);
}

/** Saves what has changed now, after any save under way. */
export function flushOwnLocations(): Promise<void> {
  window.clearTimeout(timer);
  timer = undefined;
  if (!dirty) return writing;
  const { gameId, own } = get();
  if (!gameId || !canChangeOwnLocations()) return writing;
  dirty = false;
  let text: string;
  try {
    text = writeOwnLocationsFile(gameId, own, new Date());
  } catch (error) {
    set({ save: 'failed', saveError: 'Your locations could not be saved: one is not valid.' });
    console.error(error);
    return writing;
  }
  const keepCopy = keepCopyNext ? new Date().toISOString() : undefined;
  keepCopyNext = false;
  set({ save: 'saving' });
  writing = writing
    .then(() => ownLocationsBackend().write(gameId, text, keepCopy))
    .then(
      () => {
        if (get().gameId === gameId && !dirty) set({ save: 'saved', saveError: null });
      },
      (error: unknown) => {
        if (get().gameId !== gameId) return;
        dirty = true;
        set({ save: 'failed', saveError: error instanceof Error ? error.message : String(error) });
      },
    );
  return writing;
}

// ---------------------------------------------------------------------------
// Changing them

/** Makes a change; it can be undone. Returns whether anything changed. */
function apply(next: OwnLocations, label: string): boolean {
  if (!canChangeOwnLocations()) return false;
  const { own, undo } = get();
  if (next === own) return false;
  set({ own: next, undo: [...undo.slice(-(MAX_UNDO - 1)), { before: own, label }] });
  scheduleSave();
  remakeGame();
  return true;
}

/** Takes the last change back; what it was, or null when there is none. */
export function undoOwnChange(): string | null {
  if (!canChangeOwnLocations()) return null;
  const { undo } = get();
  const last = undo.at(-1);
  if (!last) return null;
  set({ own: last.before, undo: undo.slice(0, -1) });
  scheduleSave();
  remakeGame();
  return last.label;
}

/** The game's id and the ids taken now. */
function context() {
  const game = useAtlas.getState().game;
  if (!game || !base || get().gameId !== game.pack.manifest.gameId) return null;
  return { game, gameId: game.pack.manifest.gameId, data: base.pack.data, own: get().own };
}

/** The type a new location gets: the last one chosen, if it is still there. */
let lastTypeId: string | null = null;

/** The name and colour of the type made when a game has none. */
export const FIRST_TYPE = { name: 'Location', group: 'My types', icon: 'pin' } as const;

/** Puts a new location of the person's own at a point of a map's level. Returns it. */
export function dropOwnLocation(
  mapId: string,
  layerId: string,
  x: number,
  y: number,
  name = 'New location',
): OwnLocation | null {
  const ctx = context();
  if (!ctx || !canChangeOwnLocations()) return null;
  let own = ctx.own;
  const pack = ctx.game.pack;
  let categoryId =
    lastTypeId && pack.categories.has(lastTypeId)
      ? lastTypeId
      : (own.categories[0]?.id ?? pack.data.categories.find((c) => c.trackable)?.id ?? null);
  if (categoryId === null) {
    const group = newOwnTypeGroup(ctx.gameId, FIRST_TYPE.group, ctx.data, own);
    const type = newOwnType(
      ctx.gameId,
      {
        name: FIRST_TYPE.name,
        color: OWN_TYPE_COLOURS[0],
        icon: FIRST_TYPE.icon,
        groupId: group.id,
      },
      ctx.data,
      own,
    );
    own = putOwnType(own, type, group);
    categoryId = type.id;
  }
  const now = new Date().toISOString();
  const location: OwnLocation = {
    id: newOwnId(ctx.gameId, 'loc', takenRecordIds(ctx.data, own)),
    mapId,
    layerId,
    x: Math.round(x),
    y: Math.round(y),
    categoryId,
    regionId: null,
    name,
    createdAt: now,
    updatedAt: now,
  };
  return apply(addOwnLocation(own, location), 'Location added') ? location : null;
}

/** Changes a location of the person's own. */
export function changeOwn(
  id: string,
  changes: OwnLocationChanges,
  label = 'Location changed',
): void {
  const { own } = get();
  if (changes.categoryId) lastTypeId = changes.categoryId;
  const next = changeOwnLocation(own, id, changes, new Date());
  apply(next, label);
}

/** Deletes a location of the person's own; Undo puts it back. */
export function deleteOwn(id: string): OwnLocation | null {
  const location = get().own.locations.find((l) => l.id === id) ?? null;
  if (!location) return null;
  return apply(removeOwnLocation(get().own, id), `Deleted “${location.name}”`) ? location : null;
}

/** How many of the person's own locations are of a type. */
export function ownLocationsOfTypeCount(own: OwnLocations, typeId: string): number {
  return own.locations.filter((location) => location.categoryId === typeId).length;
}

/** A location of the person's own, by id. */
export function ownLocationById(id: string): OwnLocation | undefined {
  return get().own.locations.find((location) => location.id === id);
}

/** What a person gives a type in the type form: its group by id, or a new group's name. */
export interface TypeForm {
  name: string;
  color: string;
  icon: string;
  /** An existing group's id, or null for a new group named `newGroup`. */
  groupId: string | null;
  newGroup: string;
}

/** Makes a new type, or changes one of the person's own. Returns its id. */
export function saveOwnType(form: TypeForm, id?: string): string | null {
  const ctx = context();
  if (!ctx || !canChangeOwnLocations()) return null;
  let group: CategoryGroup | undefined;
  let groupId = form.groupId;
  if (groupId === null) {
    group = newOwnTypeGroup(ctx.gameId, form.newGroup || FIRST_TYPE.group, ctx.data, ctx.own);
    groupId = group.id;
  }
  const fields: OwnTypeFields = {
    name: form.name,
    color: form.color,
    icon: form.icon,
    groupId,
  };
  let type: Category;
  if (id) {
    const before = ctx.own.categories.find((c) => c.id === id);
    if (!before) return null;
    type = {
      ...before,
      name: fields.name.trim(),
      color: fields.color.toLowerCase(),
      icon: fields.icon,
      groupId,
    };
  } else {
    type = newOwnType(ctx.gameId, fields, ctx.data, ctx.own);
  }
  const changed = apply(
    putOwnType(ctx.own, type, group),
    id ? `Type “${type.name}” changed` : `Type “${type.name}” made`,
  );
  if (changed && !id) lastTypeId = type.id;
  return changed || id ? type.id : null;
}

/** Deletes a type of the person's own that no location of theirs is of. */
export function deleteOwnType(id: string): boolean {
  const type = get().own.categories.find((c) => c.id === id);
  if (!type) return false;
  return apply(removeOwnType(get().own, id), `Deleted the type “${type.name}”`);
}

/** Makes a new area of a map, or renames one of the person's own. Returns its id. */
export function saveOwnArea(mapId: string, name: string, id?: string): string | null {
  const ctx = context();
  if (!ctx || !canChangeOwnLocations()) return null;
  let area: Region;
  if (id) {
    const before = ctx.own.regions.find((r) => r.id === id);
    if (!before) return null;
    area = { ...before, name: name.trim() };
  } else {
    area = newOwnArea(ctx.gameId, mapId, name, ctx.data, ctx.own);
  }
  apply(putOwnArea(ctx.own, area), id ? `Area renamed “${area.name}”` : `Area “${area.name}” made`);
  return area.id;
}

/** Deletes an area of the person's own; their locations in it are then in no area. */
export function deleteOwnArea(id: string): boolean {
  const area = get().own.regions.find((r) => r.id === id);
  if (!area) return false;
  return apply(removeOwnArea(get().own, id, new Date()), `Deleted the area “${area.name}”`);
}

/** Forgets the person's own records on a map that was deleted. */
export function forgetOwnOfMap(mapId: string): void {
  const next = removeOwnOfMap(get().own, mapId);
  if (
    next.locations.length !== get().own.locations.length ||
    next.regions.length !== get().own.regions.length
  ) {
    apply(next, 'Map deleted');
  }
}

/** The colours offered for a type. */
export { OWN_TYPE_COLOURS };

// ---------------------------------------------------------------------------
// Other games: deleting and importing

/** Deletes a game's own locations, when the person asks for it as they delete the game. */
export async function deleteOwnLocationsOf(gameId: string): Promise<boolean> {
  if (get().gameId === gameId) {
    window.clearTimeout(timer);
    dirty = false;
    await writing;
    set({ own: NO_OWN_LOCATIONS, undo: [], save: 'saved' });
  }
  return ownLocationsBackend().remove(gameId);
}

/** Whether a game has own locations, types or areas kept (for the delete confirmation). */
export async function hasOwnLocations(gameId: string): Promise<boolean> {
  if (get().gameId === gameId) return countOwnLocations(get().own) > 0;
  try {
    const text = await ownLocationsBackend().read(gameId);
    if (text === null) return false;
    const parsed = parseOwnLocations(gameId, text);
    return !parsed.ok || countOwnLocations(parsed.own) > 0;
  } catch {
    return false;
  }
}

/**
 * Adds the own locations, types and areas a map pack file carried to the
 * person's of that game: a record with the same id is replaced by the
 * file's. Returns how many records the file had.
 */
export async function addImportedOwnLocations(gameId: string, text: string): Promise<number> {
  const incoming = parseOwnLocations(gameId, text);
  if (!incoming.ok) throw new Error(incoming.error);
  if (get().gameId === gameId && get().status === 'ready') {
    if (!canChangeOwnLocations()) throw new Error(get().readOnly ?? 'They cannot be changed now.');
    apply(mergeOwnFiles(get().own, incoming.own), 'Locations imported');
    await flushOwnLocations();
    return countOwnLocations(incoming.own);
  }
  const backend = ownLocationsBackend();
  const before = await backend.read(gameId);
  let here = NO_OWN_LOCATIONS;
  if (before !== null) {
    const parsed = parseOwnLocations(gameId, before);
    if (!parsed.ok || parsed.newer) {
      throw new Error('The locations and types you have for this game could not be read.');
    }
    here = parsed.own;
  }
  const merged = mergeOwnFiles(here, incoming.own);
  await backend.write(
    gameId,
    writeOwnLocationsFile(gameId, merged, new Date()),
    before !== null ? new Date().toISOString() : undefined,
  );
  return countOwnLocations(incoming.own);
}

// ---------------------------------------------------------------------------
// Saving when the page goes

if (typeof window !== 'undefined') {
  const flush = () => {
    void flushOwnLocations();
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
