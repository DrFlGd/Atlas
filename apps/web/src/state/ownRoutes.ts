import {
  OWN_ROUTES_VERSION,
  readOwnRoutesFile,
  writeOwnRoutesFile,
  type OwnRoute,
} from '@atlas/schema';
import { create } from 'zustand';
import { desktop } from '../desktop';
import { notify } from './actions';
import type { SaveState } from './ownLists';
import { progressStore } from './services';
import { useAtlas, type LoadedGame } from './store';

/**
 * A person's own routes of the game shown (see `routes.ts` in the schema
 * package), kept apart from what the importer wrote, as own lists are:
 *
 * - in the desktop app, a file beside the game's folder in the maps folder
 *   (`<game id>.my-routes.json`), through the shell (`desktop.ownRoutes`);
 * - in the Android app and a browser, in the app's own storage, where
 *   progress is kept, as a setting of the game (`ownRoutes:<game id>`).
 *
 * Reading the pack again never changes them. A change is saved a moment
 * after it is made, and at once when the page is hidden or closed. A file
 * a newer Atlas wrote is used and not written over; one with routes this
 * app could not read is kept as a copy at the first save.
 */

export interface OwnRoutesState {
  /** The game they are of; null before a game is loaded. */
  gameId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** Why they can be shown but not changed here (a newer app wrote them), or null. */
  readOnly: string | null;
  routes: readonly OwnRoute[];
  save: SaveState;
  saveError: string | null;
  /** Changes that can be undone while the game is shown, the last last. */
  undo: { before: readonly OwnRoute[]; label: string }[];
}

const MAX_UNDO = 50;

export const useOwnRoutes = create<OwnRoutesState>()(() => ({
  gameId: null,
  status: 'idle',
  error: null,
  readOnly: null,
  routes: [],
  save: 'saved',
  saveError: null,
  undo: [],
}));

const get = useOwnRoutes.getState;
const set = useOwnRoutes.setState;

// ---------------------------------------------------------------------------
// Where they are kept

/** The key of a game's own routes among the settings, where the shell has no file for them. */
export const ownRoutesSetting = (gameId: string) => `ownRoutes:${gameId}`;

interface Backend {
  read(gameId: string): Promise<string | null>;
  write(gameId: string, text: string, keepCopy?: string): Promise<void>;
  remove(gameId: string): Promise<boolean>;
}

const browserBackend: Backend = {
  async read(gameId) {
    const value = await progressStore().getSetting(ownRoutesSetting(gameId));
    return typeof value === 'string' ? value : null;
  },
  async write(gameId, text, keepCopy) {
    const store = progressStore();
    if (keepCopy) {
      const before = await store.getSetting(ownRoutesSetting(gameId));
      if (typeof before === 'string') {
        await store.putSetting(`${ownRoutesSetting(gameId)}:copy:${keepCopy}`, before);
      }
    }
    await store.putSetting(ownRoutesSetting(gameId), text);
  },
  async remove(gameId) {
    const store = progressStore();
    const before = await store.getSetting(ownRoutesSetting(gameId));
    await store.putSetting(ownRoutesSetting(gameId), null);
    return typeof before === 'string';
  },
};

/** Where own routes are kept on this device: with the own lists (see the top of this file). */
export function ownRoutesBackend(): Backend {
  const { app } = useAtlas.getState();
  if (desktop && app?.ownListFiles === true) {
    const bridge = desktop;
    return {
      read: (gameId) => bridge.ownRoutes.read(gameId),
      write: async (gameId, text, keepCopy) => {
        await bridge.ownRoutes.write(gameId, text, keepCopy);
      },
      remove: (gameId) => bridge.ownRoutes.delete(gameId),
    };
  }
  return browserBackend;
}

// ---------------------------------------------------------------------------
// Reading

let loadingFor: string | null = null;
let loading: Promise<void> | null = null;
let keepCopyNext = false;

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Reads the own routes of a game, once per game. */
export function loadOwnRoutes(game: LoadedGame): Promise<void> {
  const gameId = game.pack.manifest.gameId;
  if (loadingFor === gameId && loading) return loading;
  void flushOwnRoutes();
  loadingFor = gameId;
  keepCopyNext = false;
  set({
    gameId,
    status: 'loading',
    error: null,
    readOnly: null,
    routes: [],
    save: 'saved',
    saveError: null,
    undo: [],
  });
  loading = (async () => {
    try {
      const text = await ownRoutesBackend().read(gameId);
      if (loadingFor !== gameId) return;
      if (text !== null) {
        const read = readOwnRoutesFile(parse(text));
        if (!read.ok || read.file.gameId !== gameId) {
          set({
            status: 'error',
            error:
              'Your routes could not be read, so they were left as they are. Nothing will be written over them.',
          });
          return;
        }
        const { file } = read;
        const newer = file.version > OWN_ROUTES_VERSION;
        set({
          routes: file.routes,
          readOnly: newer
            ? 'Your routes were saved by a newer version of Atlas, so they can be followed here but changed only there.'
            : null,
        });
        if (file.skipped > 0 && !newer) {
          keepCopyNext = true;
          notify(
            `${file.skipped === 1 ? 'One of your routes' : `${file.skipped} of your routes`} could not be read and ${file.skipped === 1 ? 'is' : 'are'} left out. A copy of the file as it was is kept when you next change a route.`,
            'error',
          );
        }
      }
      set({ status: 'ready' });
    } catch (error) {
      if (loadingFor !== gameId) return;
      set({
        status: 'error',
        error: `Your routes could not be read: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  })();
  return loading;
}

/** Whether the own routes can be changed now. */
export function canChangeOwnRoutes(state: OwnRoutesState = get()): boolean {
  return state.status === 'ready' && state.readOnly === null;
}

/** Why the routes cannot be changed now, in words; null when they can. */
export function whyRoutesCannotChange(state: OwnRoutesState = get()): string | null {
  if (canChangeOwnRoutes(state)) return null;
  if (state.readOnly) return state.readOnly;
  if (state.status === 'error') return state.error ?? 'Your routes could not be read.';
  return 'Your routes are still being read. Try again in a moment.';
}

// ---------------------------------------------------------------------------
// Changing them

const SAVE_DELAY_MS = 500;
let timer: number | undefined;
let writing: Promise<void> = Promise.resolve();
let dirty = false;

function scheduleSave(): void {
  dirty = true;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    void flushOwnRoutes();
  }, SAVE_DELAY_MS);
}

/** Saves what has changed now, after any save under way. */
export function flushOwnRoutes(): Promise<void> {
  window.clearTimeout(timer);
  timer = undefined;
  if (!dirty) return writing;
  const { gameId, routes } = get();
  if (!gameId || !canChangeOwnRoutes()) return writing;
  dirty = false;
  let text: string;
  try {
    text = writeOwnRoutesFile(gameId, routes, new Date());
  } catch (error) {
    set({ save: 'failed', saveError: 'Your routes could not be saved: they are not valid.' });
    console.error(error);
    return writing;
  }
  const keepCopy = keepCopyNext ? new Date().toISOString() : undefined;
  keepCopyNext = false;
  set({ save: 'saving' });
  writing = writing
    .then(() => ownRoutesBackend().write(gameId, text, keepCopy))
    .then(
      () => {
        if (get().gameId === gameId && !dirty) set({ save: 'saved', saveError: null });
      },
      (error: unknown) => {
        if (get().gameId !== gameId) return;
        dirty = true;
        const message = error instanceof Error ? error.message : String(error);
        set({ save: 'failed', saveError: message });
        notify(`Your routes could not be saved: ${message}`, 'error');
      },
    );
  return writing;
}

/**
 * Changes the own routes of the game shown: `change` returns them changed
 * (the same array when nothing changed). With `label`, it can be undone.
 * Returns whether anything changed.
 */
export function changeOwnRoutes(
  change: (routes: readonly OwnRoute[]) => readonly OwnRoute[],
  label?: string,
): boolean {
  const { gameId, routes, undo } = get();
  if (!gameId || !canChangeOwnRoutes()) return false;
  const next = change(routes);
  if (next === routes) return false;
  set({
    routes: next,
    save: 'unsaved',
    saveError: null,
    undo: label ? [...undo.slice(-(MAX_UNDO - 1)), { before: routes, label }] : undo,
  });
  scheduleSave();
  return true;
}

/** Puts a route in: in place of the one with its id, or after the others. */
export function putOwnRoute(route: OwnRoute, label?: string): boolean {
  return changeOwnRoutes((routes) => {
    const at = routes.findIndex((r) => r.id === route.id);
    if (at < 0) return [...routes, route];
    if (routes[at] === route) return routes;
    return routes.map((r, i) => (i === at ? route : r));
  }, label);
}

/** Deletes a route of the person's own. */
export function deleteOwnRoute(routeId: string, title: string): boolean {
  const done = changeOwnRoutes(
    (routes) => routes.filter((route) => route.id !== routeId),
    `Deleted the route “${title}”`,
  );
  if (done) {
    notify(`Deleted the route “${title}”.`, 'info', {
      action: {
        label: 'Undo',
        run: () => {
          const label = undoOwnRoutesChange();
          if (label) notify(`Undone: ${label.charAt(0).toLowerCase()}${label.slice(1)}`);
        },
      },
    });
  }
  return done;
}

/** Undoes the last change to the routes; what it was, or null when there is none. */
export function undoOwnRoutesChange(): string | null {
  if (!canChangeOwnRoutes()) return null;
  const { undo } = get();
  const last = undo.at(-1);
  if (!last) return null;
  set({ routes: last.before, undo: undo.slice(0, -1), save: 'unsaved' });
  scheduleSave();
  return last.label;
}

// ---------------------------------------------------------------------------
// Saving when the page goes

if (typeof window !== 'undefined') {
  const flush = () => {
    void flushOwnRoutes();
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

// ---------------------------------------------------------------------------
// With the game: deleted, or carried in a pack file

/** Deletes a game's own routes, when the person asks for it as they delete the game. */
export async function deleteOwnRoutesOf(gameId: string): Promise<boolean> {
  if (get().gameId === gameId) {
    window.clearTimeout(timer);
    dirty = false;
    await writing;
    set({ routes: [], undo: [], save: 'saved' });
  }
  return ownRoutesBackend().remove(gameId);
}

/**
 * Adds the routes a pack file carried to the person's of that game: a
 * route with the same id is replaced by the file's. Returns how many
 * routes the file had.
 */
export async function addImportedOwnRoutes(gameId: string, text: string): Promise<number> {
  const read = readOwnRoutesFile(parse(text));
  if (!read.ok || read.file.gameId !== gameId) {
    throw new Error('The routes in the file could not be read.');
  }
  const incoming = read.file.routes;
  const merge = (here: readonly OwnRoute[]) => [
    ...here.filter((route) => !incoming.some((other) => other.id === route.id)),
    ...incoming,
  ];
  if (get().gameId === gameId && get().status === 'ready') {
    if (!canChangeOwnRoutes()) throw new Error(get().readOnly ?? 'They cannot be changed now.');
    set({ routes: merge(get().routes), save: 'unsaved', undo: [] });
    scheduleSave();
    await flushOwnRoutes();
    return incoming.length;
  }
  const store = ownRoutesBackend();
  const before = await store.read(gameId);
  let here: readonly OwnRoute[] = [];
  if (before !== null) {
    const was = readOwnRoutesFile(parse(before));
    if (!was.ok || was.file.version > OWN_ROUTES_VERSION) {
      throw new Error('The routes you have for this game could not be read.');
    }
    here = was.file.routes;
  }
  await store.write(
    gameId,
    writeOwnRoutesFile(gameId, merge(here), new Date()),
    before !== null ? new Date().toISOString() : undefined,
  );
  return incoming.length;
}
