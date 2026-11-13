import {
  copyList,
  idsOf,
  importList,
  newOwnList,
  ownListEntry,
  type ChecklistEntry,
  type ChecklistItemEntry,
} from '@atlas/core';
import {
  OWN_LISTS_VERSION,
  readListFile,
  readOwnListsFile,
  writeListFile,
  writeOwnListsFile,
  type ChecklistType,
  type OwnList,
} from '@atlas/schema';
import { create } from 'zustand';
import { desktop } from '../desktop';
import { notify } from './actions';
import { progressStore } from './services';
import { useAtlas, type LoadedGame } from './store';

/**
 * A person's own lists and guides of the game shown (see `ownLists.ts` in
 * the schema package), and where they are kept:
 *
 * - in the desktop app, a file beside the game's folder in the maps folder
 *   (`<game id>.my-lists.json`), through the shell (`desktop.ownLists`);
 * - in the Android app and a browser, in the app's own storage, where
 *   progress is kept, as a setting of the game (`ownLists:<game id>`).
 *   Android keeps its maps folder out of backups, and found marks in the
 *   web view's storage are backed up, so the lists are kept with them.
 *
 * Changes are saved as they are made: a short while after the last one,
 * and at once when the editor is left, when the page is hidden or closed,
 * and when asked (`flushOwnLists`). The file is written whole, strictly
 * checked, one write at a time. A file a newer Atlas wrote is shown and not
 * written over; one with lists this app could not read is kept as a copy
 * beside the new one at the first save.
 */

/** Saving, as the editor's header says it. */
export type SaveState = 'saved' | 'unsaved' | 'saving' | 'failed';

export interface OwnListsState {
  /** The game the lists are of; null before a game is loaded. */
  gameId: string | null;
  /** Read yet: until then the lists are not offered for changing. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Why the lists could not be read (status `error`). */
  error: string | null;
  /** Why the lists can be used but not changed here (a newer app wrote them), or null. */
  readOnly: string | null;
  lists: readonly OwnList[];
  save: SaveState;
  saveError: string | null;
}

export const useOwnLists = create<OwnListsState>()(() => ({
  gameId: null,
  status: 'idle',
  error: null,
  readOnly: null,
  lists: [],
  save: 'saved',
  saveError: null,
}));

const get = useOwnLists.getState;
const set = useOwnLists.setState;

// ---------------------------------------------------------------------------
// Where they are kept

/** The key of a game's own lists among the settings, where the shell has no file for them. */
export const ownListsSetting = (gameId: string) => `ownLists:${gameId}`;

interface Backend {
  read(gameId: string): Promise<string | null>;
  /** Writes; with `keepCopy`, keeps what was there first, under that time. */
  write(gameId: string, text: string, keepCopy?: string): Promise<void>;
  remove(gameId: string): Promise<boolean>;
}

const browserBackend: Backend = {
  async read(gameId) {
    const value = await progressStore().getSetting(ownListsSetting(gameId));
    return typeof value === 'string' ? value : null;
  },
  async write(gameId, text, keepCopy) {
    const store = progressStore();
    if (keepCopy) {
      const before = await store.getSetting(ownListsSetting(gameId));
      if (typeof before === 'string') {
        await store.putSetting(`${ownListsSetting(gameId)}:copy:${keepCopy}`, before);
      }
    }
    await store.putSetting(ownListsSetting(gameId), text);
  },
  async remove(gameId) {
    const store = progressStore();
    const before = await store.getSetting(ownListsSetting(gameId));
    await store.putSetting(ownListsSetting(gameId), null);
    return typeof before === 'string';
  },
};

function shellBackend(bridge: NonNullable<typeof desktop>): Backend {
  return {
    read: (gameId) => bridge.ownLists.read(gameId),
    write: async (gameId, text, keepCopy) => {
      await bridge.ownLists.write(gameId, text, keepCopy);
    },
    remove: (gameId) => bridge.ownLists.delete(gameId),
  };
}

/** Where own lists are kept on this device (see the top of this file). */
export function ownListsBackend(): Backend {
  const { app } = useAtlas.getState();
  return desktop && app?.ownListFiles === true ? shellBackend(desktop) : browserBackend;
}

/** Where own lists are kept, in words, for the person. */
export function ownListsPlace(): string {
  const { app } = useAtlas.getState();
  return desktop && app?.ownListFiles === true
    ? 'in a file of their own beside the game’s folder in the maps folder'
    : 'in this app’s storage on this device, with your progress';
}

// ---------------------------------------------------------------------------
// Reading

let loading: Promise<void> | null = null;
let loadingFor: string | null = null;

/** Reads the own lists of a game, once per game. */
export function loadOwnLists(game: LoadedGame): Promise<void> {
  const gameId = game.pack.manifest.gameId;
  if (loadingFor === gameId && loading) return loading;
  void flushOwnLists();
  loadingFor = gameId;
  set({
    gameId,
    status: 'loading',
    error: null,
    readOnly: null,
    lists: [],
    save: 'saved',
    saveError: null,
  });
  keepCopyNext = false;
  loading = (async () => {
    try {
      const text = await ownListsBackend().read(gameId);
      if (loadingFor !== gameId) return;
      if (text === null) {
        set({ status: 'ready' });
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        value = null;
      }
      const read = readOwnListsFile(value);
      if (!read.ok || read.file.gameId !== gameId) {
        set({
          status: 'error',
          error:
            'Your lists for this game could not be read, so they were left as they are. Nothing will be written over them.',
        });
        return;
      }
      const { file } = read;
      const newer = file.version > OWN_LISTS_VERSION;
      set({
        status: 'ready',
        lists: file.lists,
        readOnly: newer
          ? 'These lists were saved by a newer version of Atlas, so they can be used here but changed only there.'
          : null,
      });
      if (file.skipped > 0 && !newer) {
        keepCopyNext = true;
        notify(
          file.skipped === 1
            ? 'One of your lists could not be read and is left out. A copy of the file as it was is kept when you next change a list.'
            : `${file.skipped} of your lists could not be read and are left out. A copy of the file as it was is kept when you next change a list.`,
          'error',
        );
      }
    } catch (error) {
      if (loadingFor !== gameId) return;
      set({
        status: 'error',
        error: `Your lists for this game could not be read: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  })();
  return loading;
}

/** Whether own lists can be changed now. */
export function canChangeOwnLists(state: OwnListsState = get()): boolean {
  return state.status === 'ready' && state.readOnly === null;
}

// ---------------------------------------------------------------------------
// The app's views of them

const entries = new WeakMap<OwnList, WeakMap<LoadedGame, ChecklistEntry>>();

/** An own list as the app's views take a list; the same object until the list changes. */
export function entryOfOwn(game: LoadedGame, list: OwnList): ChecklistEntry {
  let byGame = entries.get(list);
  if (!byGame) {
    byGame = new WeakMap();
    entries.set(list, byGame);
  }
  let entry = byGame.get(game);
  if (!entry) {
    entry = ownListEntry(list, game.pack, (id) => game.counter.isTrackable(id));
    byGame.set(game, entry);
  }
  return entry;
}

/** An own list of the game shown, by id. */
export function ownListById(id: string): OwnList | undefined {
  return get().lists.find((list) => list.checklist.id === id);
}

/** The own list entry of an id, for the game shown. */
export function ownEntryById(game: LoadedGame, id: string): ChecklistEntry | undefined {
  const { gameId } = get();
  if (gameId !== game.pack.manifest.gameId) return undefined;
  const list = ownListById(id);
  return list ? entryOfOwn(game, list) : undefined;
}

/** An entry of an own list of the game shown, by its id. */
export function ownItemById(game: LoadedGame, itemId: string): ChecklistItemEntry | undefined {
  const { gameId, lists } = get();
  if (gameId !== game.pack.manifest.gameId) return undefined;
  const list = lists.find((l) => l.items.some((item) => item.id === itemId));
  return list ? entryOfOwn(game, list).items.find((i) => i.item.id === itemId) : undefined;
}

/** Every id that a new own id must not be: the own lists' and the pack's lists' and entries'. */
export function takenIds(game: LoadedGame): Set<string> {
  const taken = new Set<string>();
  for (const list of get().lists) for (const id of idsOf(list)) taken.add(id);
  for (const entry of game.checklists.checklists) {
    taken.add(entry.checklist.id);
    for (const item of entry.items) taken.add(item.item.id);
  }
  return taken;
}

// ---------------------------------------------------------------------------
// Changing them

/** How long after the last change the lists are saved. */
const SAVE_DELAY_MS = 700;
let timer: number | undefined;
let writing: Promise<void> = Promise.resolve();
let dirty = false;
let keepCopyNext = false;

function changed(lists: readonly OwnList[]): void {
  set({ lists, save: 'unsaved', saveError: null });
  dirty = true;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    void flushOwnLists();
  }, SAVE_DELAY_MS);
}

/**
 * Saves what has changed now, after any save under way. Resolves once it is
 * written (or has failed, which the state says).
 */
export function flushOwnLists(): Promise<void> {
  window.clearTimeout(timer);
  timer = undefined;
  if (!dirty) return writing;
  const { gameId, lists } = get();
  if (!gameId || !canChangeOwnLists()) return writing;
  dirty = false;
  let text: string;
  try {
    text = writeOwnListsFile(gameId, lists, new Date());
  } catch (error) {
    set({ save: 'failed', saveError: 'A list could not be saved: it is not valid.' });
    console.error(error);
    return writing;
  }
  const keepCopy = keepCopyNext ? new Date().toISOString() : undefined;
  keepCopyNext = false;
  set({ save: 'saving' });
  writing = writing
    .then(() => ownListsBackend().write(gameId, text, keepCopy))
    .then(
      () => {
        if (get().gameId === gameId && !dirty) set({ save: 'saved', saveError: null });
      },
      (error: unknown) => {
        if (get().gameId !== gameId) return;
        dirty = true;
        set({
          save: 'failed',
          saveError: error instanceof Error ? error.message : String(error),
        });
      },
    );
  return writing;
}

/** Changes one list; returns the list as it is now. */
export function updateOwnList(id: string, change: (list: OwnList) => OwnList): OwnList | undefined {
  if (!canChangeOwnLists()) return undefined;
  let result: OwnList | undefined;
  const lists = get().lists.map((list) => {
    if (list.checklist.id !== id) return list;
    const next = change(list);
    if (next === list) {
      result = list;
      return list;
    }
    result = { ...next, updatedAt: new Date().toISOString() };
    return result;
  });
  if (result && result !== ownListById(id)) changed(lists);
  return result;
}

/** Puts a list back as it was (an undo). */
export function restoreOwnList(list: OwnList): void {
  if (!canChangeOwnLists()) return;
  const lists = get().lists;
  const at = lists.findIndex((l) => l.checklist.id === list.checklist.id);
  changed(at < 0 ? [...lists, list] : lists.map((l, i) => (i === at ? list : l)));
}

/** Adds a list; returns it. */
function addList(list: OwnList): OwnList {
  changed([...get().lists, list]);
  return list;
}

/** Starts a new list from a template. */
export function createOwnList(game: LoadedGame, name: string, type: ChecklistType): OwnList | null {
  if (!canChangeOwnLists()) return null;
  const list = newOwnList(game.pack.manifest.gameId, name, type, new Date(), takenIds(game));
  return addList(list);
}

/** Makes an own list from one of the game's lists, which is not changed. */
export function copyGameList(
  game: LoadedGame,
  entry: ChecklistEntry,
  name?: string,
): OwnList | null {
  if (!canChangeOwnLists()) return null;
  const list = copyList(
    entry,
    game.pack.manifest.gameId,
    new Date(),
    takenIds(game),
    undefined,
    name?.trim() ? name.trim() : entry.checklist.name,
  );
  return addList(list);
}

/** Deletes a list. Its done marks stay with the progress, unused. */
export function deleteOwnList(id: string): OwnList | undefined {
  if (!canChangeOwnLists()) return undefined;
  const list = ownListById(id);
  if (!list) return undefined;
  changed(get().lists.filter((l) => l !== list));
  return list;
}

// ---------------------------------------------------------------------------
// Files of one list

/** The suggested file name for a list. */
export function listFileName(list: OwnList): string {
  const base = list.checklist.name
    .replace(/[^A-Za-z0-9 _-]+/g, '')
    .trim()
    .slice(0, 60);
  return `${base || 'list'}.atlaslist`;
}

/** Exports one list to a file: the shell's save dialog, or a download in a browser. */
export async function exportOwnList(game: LoadedGame, list: OwnList): Promise<void> {
  const text = writeListFile(game.pack.manifest.gameId, game.pack.manifest.title, list, new Date());
  const name = listFileName(list);
  try {
    if (desktop) {
      const saved = await desktop.listFiles.save(name, text);
      if (saved) notify(`Exported “${list.checklist.name}” as ${saved.name}.`);
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 10_000);
    notify(`Exported “${list.checklist.name}” as ${name}.`);
  } catch (error) {
    notify(
      `Could not export the list: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  }
}

/** What importing a list file did. */
export type ImportOutcome = { ok: true; list: OwnList } | { ok: false; error: string };

/**
 * Adds the list in a list file's text to the game's own lists: checked,
 * refused when it was made for another game, with new ids when any of its
 * ids is taken.
 */
export function importOwnListText(game: LoadedGame, text: string): ImportOutcome {
  if (!canChangeOwnLists()) {
    return { ok: false, error: get().readOnly ?? 'Your lists cannot be changed right now.' };
  }
  const read = readListFile(text);
  if (!read.ok) return read;
  const result = importList(
    read.list,
    read.gameId,
    { gameId: game.pack.manifest.gameId, title: game.pack.manifest.title },
    takenIds(game),
    new Date(),
    undefined,
    read.gameTitle,
  );
  if (!result.ok) return result;
  addList(result.list);
  return { ok: true, list: result.list };
}

/** Asks for a list file (the shell's open dialog, or a file picker) and imports it. */
export async function pickListFile(): Promise<string | null> {
  if (desktop) {
    const opened = await desktop.listFiles.open();
    return opened?.contents ?? null;
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.atlaslist,application/json,.json';
    input.style.display = 'none';
    input.dataset.testid = 'list-file-input';
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        done(null);
        return;
      }
      if (file.size > 16 << 20) {
        done('');
        return;
      }
      void file.text().then(done, () => {
        done('');
      });
    });
    input.addEventListener('cancel', () => {
      done(null);
    });
    document.body.append(input);
    input.click();
  });
}

/** Deletes a game's own lists, when the person asks for it as they delete the game. */
export async function deleteOwnListsOf(gameId: string): Promise<boolean> {
  if (get().gameId === gameId) {
    window.clearTimeout(timer);
    dirty = false;
    await writing;
    set({ lists: [], save: 'saved' });
  }
  return ownListsBackend().remove(gameId);
}

/**
 * Adds the own lists a map pack file carried to the person's of that game:
 * a list with the same id is replaced by the file's. Returns how many lists
 * the file had.
 */
export async function addImportedOwnLists(gameId: string, text: string): Promise<number> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  const read = readOwnListsFile(value);
  if (!read.ok || read.file.gameId !== gameId) {
    throw new Error('The lists in the file could not be read.');
  }
  const incoming = read.file.lists;
  const merge = (here: readonly OwnList[]) => {
    const ids = new Set(incoming.map((list) => list.checklist.id));
    return [...here.filter((list) => !ids.has(list.checklist.id)), ...incoming];
  };
  if (get().gameId === gameId && get().status === 'ready') {
    if (!canChangeOwnLists()) throw new Error(get().readOnly ?? 'They cannot be changed now.');
    changed(merge(get().lists));
    await flushOwnLists();
    return incoming.length;
  }
  const backend = ownListsBackend();
  const before = await backend.read(gameId);
  let here: readonly OwnList[] = [];
  if (before !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(before);
    } catch {
      parsed = null;
    }
    const was = readOwnListsFile(parsed);
    if (!was.ok || was.file.version > OWN_LISTS_VERSION) {
      throw new Error('The lists you have for this game could not be read.');
    }
    here = was.file.lists;
  }
  await backend.write(
    gameId,
    writeOwnListsFile(gameId, merge(here), new Date()),
    before !== null ? new Date().toISOString() : undefined,
  );
  return incoming.length;
}

// ---------------------------------------------------------------------------
// Saving when the page goes

if (typeof window !== 'undefined') {
  const flush = () => {
    void flushOwnLists();
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
