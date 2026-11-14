import {
  layoutFor,
  looseSections,
  moveShownEntry,
  shownContentsFor,
  type ContentsParent,
  type LoadedPack,
  type ShownContents,
} from '@atlas/core';
import {
  NO_OWN_PAGES,
  OWN_PAGES_VERSION,
  readOwnPagesFile,
  writeOwnPagesFile,
  type OwnPages,
  type PagesLayout,
  type Picture,
} from '@atlas/schema';
import { create } from 'zustand';
import { desktop } from '../desktop';
import { notify } from './actions';
import type { SaveState } from './ownLists';
import { addOwnPictureSource, sweepOwnPicturesLater } from './ownPictures';
import { progressStore } from './services';
import { useAtlas, type LoadedGame } from './store';

/**
 * A person's own guide pages of the game shown: the pack's pages they
 * changed or hid, the pages and sections they added, and the contents as
 * they arranged it (see `ownPages.ts` in the schema package, and in core
 * for how they are laid over the pack's pages). Kept apart from what the
 * importer wrote, as own lists are (see `ownLists.ts`):
 *
 * - in the desktop app, a file beside the game's folder in the maps folder
 *   (`<game id>.my-pages.json`), through the shell (`desktop.ownPages`);
 * - in the Android app and a browser, in the app's own storage, where
 *   progress is kept, as a setting of the game (`ownPages:<game id>`).
 *
 * Reading the pack again never changes them. A change is saved a moment
 * after it is made, and at once when the page is hidden or closed. A file
 * a newer Atlas wrote is used and not written over; one with records this
 * app could not read is kept as a copy at the first save.
 */

export interface OwnPagesState {
  /** The game they are of; null before a game is loaded. */
  gameId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** Why they can be shown but not changed here (a newer app wrote them), or null. */
  readOnly: string | null;
  own: OwnPages;
  save: SaveState;
  saveError: string | null;
  /** Changes to the contents that can be undone while the game is shown, the last last. */
  undo: { before: OwnPages; label: string }[];
  /** Photos added to the page being edited and not saved yet, so they are kept. */
  draftPictures: readonly Picture[];
}

const MAX_UNDO = 30;

export const useOwnPages = create<OwnPagesState>()(() => ({
  gameId: null,
  status: 'idle',
  error: null,
  readOnly: null,
  own: NO_OWN_PAGES,
  save: 'saved',
  saveError: null,
  undo: [],
  draftPictures: [],
}));

const get = useOwnPages.getState;
const set = useOwnPages.setState;

// ---------------------------------------------------------------------------
// Where they are kept

/** The key of a game's own pages among the settings, where the shell has no file for them. */
export const ownPagesSetting = (gameId: string) => `ownPages:${gameId}`;

interface Backend {
  read(gameId: string): Promise<string | null>;
  write(gameId: string, text: string, keepCopy?: string): Promise<void>;
  remove(gameId: string): Promise<boolean>;
}

const browserBackend: Backend = {
  async read(gameId) {
    const value = await progressStore().getSetting(ownPagesSetting(gameId));
    return typeof value === 'string' ? value : null;
  },
  async write(gameId, text, keepCopy) {
    const store = progressStore();
    if (keepCopy) {
      const before = await store.getSetting(ownPagesSetting(gameId));
      if (typeof before === 'string') {
        await store.putSetting(`${ownPagesSetting(gameId)}:copy:${keepCopy}`, before);
      }
    }
    await store.putSetting(ownPagesSetting(gameId), text);
  },
  async remove(gameId) {
    const store = progressStore();
    const before = await store.getSetting(ownPagesSetting(gameId));
    await store.putSetting(ownPagesSetting(gameId), null);
    return typeof before === 'string';
  },
};

/** Where own pages are kept on this device: with the own lists (see the top of this file). */
export function ownPagesBackend(): Backend {
  const { app } = useAtlas.getState();
  if (desktop && app?.ownListFiles === true) {
    const bridge = desktop;
    return {
      read: (gameId) => bridge.ownPages.read(gameId),
      write: async (gameId, text, keepCopy) => {
        await bridge.ownPages.write(gameId, text, keepCopy);
      },
      remove: (gameId) => bridge.ownPages.delete(gameId),
    };
  }
  return browserBackend;
}

// ---------------------------------------------------------------------------
// Reading

let loadingFor: string | null = null;
let loading: Promise<void> | null = null;

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Reads the own pages of a game, once per game. */
export function loadOwnPages(game: LoadedGame): Promise<void> {
  const gameId = game.pack.manifest.gameId;
  if (loadingFor === gameId && loading) return loading;
  void flushOwnPages();
  loadingFor = gameId;
  keepCopyNext = false;
  set({
    gameId,
    status: 'loading',
    error: null,
    readOnly: null,
    own: NO_OWN_PAGES,
    save: 'saved',
    saveError: null,
    undo: [],
    draftPictures: [],
  });
  loading = (async () => {
    try {
      const text = await ownPagesBackend().read(gameId);
      if (loadingFor !== gameId) return;
      if (text !== null) {
        const read = readOwnPagesFile(parse(text));
        if (!read.ok || read.file.gameId !== gameId) {
          set({
            status: 'error',
            error:
              'Your changes to the pages could not be read, so they were left as they are. Nothing will be written over them.',
          });
          return;
        }
        const { file } = read;
        const newer = file.version > OWN_PAGES_VERSION;
        set({
          own: file.own,
          readOnly: newer
            ? 'Your pages were saved by a newer version of Atlas, so they can be read here but changed only there.'
            : null,
        });
        if (file.skipped > 0 && !newer) {
          keepCopyNext = true;
          notify(
            `${file.skipped === 1 ? 'One of your pages or sections' : `${file.skipped} of your pages and sections`} could not be read and ${file.skipped === 1 ? 'is' : 'are'} left out. A copy of the file as it was is kept when you next change a page.`,
            'error',
          );
        }
      }
      set({ status: 'ready' });
    } catch (error) {
      if (loadingFor !== gameId) return;
      set({
        status: 'error',
        error: `Your changes to the pages could not be read: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  })();
  return loading;
}

/** Whether the own pages can be changed now. */
export function canChangeOwnPages(state: OwnPagesState = get()): boolean {
  return state.status === 'ready' && state.readOnly === null;
}

/** The own pages of a game, when they are the ones read; none otherwise. */
export function ownPagesOf(gameId: string, state: OwnPagesState = get()): OwnPages {
  return state.gameId === gameId ? state.own : NO_OWN_PAGES;
}

/** The contents as the person arranged it, hidden pages included. */
export function layoutOf(game: LoadedGame): PagesLayout {
  return layoutFor(game.pack.data, ownPagesOf(game.pack.manifest.gameId));
}

const shownKnown = new WeakMap<LoadedPack, { own: OwnPages; shown: ShownContents }>();

/**
 * The contents as the arrange tool shows it: the person's layout with the
 * pages placed by their links, hidden pages included (see
 * `shownContentsFor`). Worked out once per pack and change.
 */
export function shownContentsOf(game: LoadedGame): ShownContents {
  const own = ownPagesOf(game.pack.manifest.gameId);
  const known = shownKnown.get(game.pack);
  if (known?.own === own) return known.shown;
  const shown = shownContentsFor(game.pack.data, own);
  shownKnown.set(game.pack, { own, shown });
  return shown;
}

/**
 * Moves an entry of the contents as shown, under a page too, and says so
 * with a way to undo it (see `moveInContents`). Returns whether it moved.
 */
export function moveInContentsOf(
  game: LoadedGame,
  id: string,
  to: ContentsParent,
  before: string | null,
  said: string,
): boolean {
  const data = game.pack.data;
  return changeContents(
    (own, layout) =>
      moveShownEntry(
        own,
        layout,
        shownContentsFor(data, own).layout,
        id,
        to,
        before,
        looseSections(data),
      ),
    said,
  );
}

// ---------------------------------------------------------------------------
// Changing them

const SAVE_DELAY_MS = 500;
let timer: number | undefined;
let writing: Promise<void> = Promise.resolve();
let dirty = false;
let keepCopyNext = false;

function scheduleSave(): void {
  dirty = true;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    void flushOwnPages();
  }, SAVE_DELAY_MS);
}

/** Saves what has changed now, after any save under way. */
export function flushOwnPages(): Promise<void> {
  window.clearTimeout(timer);
  timer = undefined;
  if (!dirty) return writing;
  const { gameId, own } = get();
  if (!gameId || !canChangeOwnPages()) return writing;
  dirty = false;
  let text: string;
  try {
    text = writeOwnPagesFile(gameId, own, new Date());
  } catch (error) {
    set({ save: 'failed', saveError: 'Your pages could not be saved: they are not valid.' });
    console.error(error);
    return writing;
  }
  const keepCopy = keepCopyNext ? new Date().toISOString() : undefined;
  keepCopyNext = false;
  set({ save: 'saving' });
  writing = writing
    .then(() => ownPagesBackend().write(gameId, text, keepCopy))
    .then(
      () => {
        if (get().gameId === gameId && !dirty) set({ save: 'saved', saveError: null });
      },
      (error: unknown) => {
        if (get().gameId !== gameId) return;
        dirty = true;
        const message = error instanceof Error ? error.message : String(error);
        set({ save: 'failed', saveError: message });
        notify(`Your pages could not be saved: ${message}`, 'error');
      },
    );
  return writing;
}

/** The own pictures the own pages still show: those no saved page names any more are let go. */
function keepShownPictures(own: OwnPages): OwnPages {
  if (!own.pictures || own.pictures.length === 0) return own;
  const bodies = own.pages.map((page) => page.body ?? '').join('\n');
  const pictures = own.pictures.filter((picture) => bodies.includes(picture.id));
  if (pictures.length === own.pictures.length) return own;
  const next: OwnPages = { ...own };
  if (pictures.length > 0) next.pictures = pictures;
  else delete next.pictures;
  return next;
}

/**
 * Changes the own pages: `change` is given them and the contents as
 * arranged now, and returns them changed (the same object when nothing
 * changed). With `label`, it can be undone. Returns whether anything
 * changed.
 */
export function changeOwnPages(
  change: (own: OwnPages, layout: PagesLayout) => OwnPages,
  label?: string,
): boolean {
  const { gameId, own, undo } = get();
  if (!gameId || !canChangeOwnPages()) return false;
  const game = useAtlas.getState().game;
  if (game?.pack.manifest.gameId !== gameId) return false;
  const next = change(own, layoutFor(game.pack.data, own));
  if (next === own) return false;
  const kept = keepShownPictures(next);
  set({
    own: kept,
    save: 'unsaved',
    saveError: null,
    undo: label ? [...undo.slice(-(MAX_UNDO - 1)), { before: own, label }] : undo,
  });
  scheduleSave();
  if (kept.pictures?.length !== own.pictures?.length) sweepOwnPicturesLater();
  return true;
}

/** Undoes the last change to the contents; what it was, or null when there is none. */
export function undoOwnPagesChange(): string | null {
  if (!canChangeOwnPages()) return null;
  const { undo } = get();
  const last = undo.at(-1);
  if (!last) return null;
  set({ own: last.before, undo: undo.slice(0, -1), save: 'unsaved' });
  scheduleSave();
  return last.label;
}

/** Changes the contents and says so, with a way to undo it. */
export function changeContents(
  change: (own: OwnPages, layout: PagesLayout) => OwnPages,
  said: string,
): boolean {
  const changed = changeOwnPages(change, said);
  if (changed) {
    notify(said, 'info', {
      action: {
        label: 'Undo',
        run: () => {
          const label = undoOwnPagesChange();
          if (label) notify(`Undone: ${label.charAt(0).toLowerCase()}${label.slice(1)}`);
        },
      },
    });
  }
  return changed;
}

/** Keeps the photos added to the page being edited until it is saved or cancelled. */
export function setDraftPictures(pictures: readonly Picture[]): void {
  set({ draftPictures: pictures });
}

// The photos own pages show are never taken for unused ones.
addOwnPictureSource({
  ready: (gameId) => {
    const state = get();
    return state.gameId === gameId && canChangeOwnPages(state);
  },
  pictures: () => {
    const { own, undo, draftPictures } = get();
    return [
      ...(own.pictures ?? []),
      ...undo.flatMap((step) => step.before.pictures ?? []),
      ...draftPictures,
    ];
  },
});

// ---------------------------------------------------------------------------
// Saving when the page goes

if (typeof window !== 'undefined') {
  const flush = () => {
    void flushOwnPages();
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

// ---------------------------------------------------------------------------
// With the game: deleted, or carried in a map pack file

/** Deletes a game's own pages, when the person asks for it as they delete the game. */
export async function deleteOwnPagesOf(gameId: string): Promise<boolean> {
  if (get().gameId === gameId) {
    window.clearTimeout(timer);
    dirty = false;
    await writing;
    set({ own: NO_OWN_PAGES, undo: [], save: 'saved' });
  }
  return ownPagesBackend().remove(gameId);
}

/**
 * The own pages of one file added to another's: a page or section in the
 * file replaces the one with its id; the contents as the file arranged
 * them are used when there was none here.
 */
export function mergeOwnPages(here: OwnPages, incoming: OwnPages): OwnPages {
  const byId = <T extends { id: string }>(a: readonly T[], b: readonly T[]): T[] => {
    const map = new Map(a.map((item) => [item.id, item]));
    for (const item of b) map.set(item.id, item);
    return [...map.values()];
  };
  const merged: OwnPages = {
    pages: byId(here.pages, incoming.pages),
    sections: byId(here.sections, incoming.sections),
  };
  const contents = here.contents ?? incoming.contents;
  if (contents) merged.contents = contents;
  const pictures = byId(here.pictures ?? [], incoming.pictures ?? []);
  if (pictures.length > 0) merged.pictures = pictures;
  return merged;
}

/**
 * Adds the own pages a map pack file carried to the person's of that game.
 * Returns how many pages and sections the file had.
 */
export async function addImportedOwnPages(
  gameId: string,
  text: string,
): Promise<{ pages: number; sections: number }> {
  const read = readOwnPagesFile(parse(text));
  if (!read.ok || read.file.gameId !== gameId) {
    throw new Error('The pages in the file could not be read.');
  }
  const incoming = read.file.own;
  const counts = { pages: incoming.pages.length, sections: incoming.sections.length };
  if (get().gameId === gameId && get().status === 'ready') {
    if (!canChangeOwnPages()) throw new Error(get().readOnly ?? 'They cannot be changed now.');
    set({ own: mergeOwnPages(get().own, incoming), save: 'unsaved', undo: [] });
    scheduleSave();
    await flushOwnPages();
    return counts;
  }
  const store = ownPagesBackend();
  const before = await store.read(gameId);
  let here: OwnPages = NO_OWN_PAGES;
  if (before !== null) {
    const was = readOwnPagesFile(parse(before));
    if (!was.ok || was.file.version > OWN_PAGES_VERSION) {
      throw new Error('The pages you have for this game could not be read.');
    }
    here = was.file.own;
  }
  await store.write(
    gameId,
    writeOwnPagesFile(gameId, mergeOwnPages(here, incoming), new Date()),
    before !== null ? new Date().toISOString() : undefined,
  );
  return counts;
}
