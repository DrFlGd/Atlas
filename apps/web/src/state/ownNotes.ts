import {
  mergeOwnNotes,
  notesOnPack,
  noteTexts,
  ownNoteId,
  putNote,
  removeNote,
  type NoteFields,
  type NotesOnPack,
  type NoteText,
  type ShownNote,
} from '@atlas/core';
import {
  countOwnNotes,
  isOwnId,
  NO_OWN_NOTES,
  OWN_NOTES_VERSION,
  readOwnNotesFile,
  writeOwnNotesFile,
  type OwnNotes,
  type Picture,
} from '@atlas/schema';
import { create } from 'zustand';
import { desktop } from '../desktop';
import { notify, provideNotedLocations } from './actions';
import type { SaveState } from './ownLists';
import { addOwnPictureSource, sweepOwnPicturesLater } from './ownPictures';
import { progressStore } from './services';
import { useAtlas, type LoadedGame } from './store';

/**
 * A person's own notes on the locations of the game shown (see
 * `ownNotes.ts` in the schema package, and in core for where each note is
 * shown). Kept apart from what the importer wrote, as own lists are (see
 * `ownLists.ts`):
 *
 * - in the desktop app, a file beside the game's folder in the maps folder
 *   (`<game id>.my-notes.json`), through the shell (`desktop.ownNotes`);
 * - in the Android app and a browser, in the app's own storage, where
 *   progress is kept, as a setting of the game (`ownNotes:<game id>`).
 *
 * The note of a location of the person's own is not here: it is kept with
 * the location (see `ownLocations.ts`) and shown as their note too.
 *
 * Reading the pack again never changes them. A change is saved a moment
 * after it is made, and at once when the page is hidden or closed. A file
 * a newer Atlas wrote is used and not written over; one with notes this
 * app could not read is kept as a copy at the first save.
 */

export interface OwnNotesState {
  /** The game they are of; null before a game is loaded. */
  gameId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** Why they can be shown but not changed here (a newer app wrote them), or null. */
  readOnly: string | null;
  own: OwnNotes;
  save: SaveState;
  saveError: string | null;
  /** Changes that can be undone while the game is shown, the last last. */
  undo: { before: OwnNotes; label: string }[];
  /** Photos added to the note being written and not saved yet, so they are kept. */
  draftPictures: readonly Picture[];
}

const MAX_UNDO = 30;

export const useOwnNotes = create<OwnNotesState>()(() => ({
  gameId: null,
  status: 'idle',
  error: null,
  readOnly: null,
  own: NO_OWN_NOTES,
  save: 'saved',
  saveError: null,
  undo: [],
  draftPictures: [],
}));

const get = useOwnNotes.getState;
const set = useOwnNotes.setState;

// ---------------------------------------------------------------------------
// Where they are kept

/** The key of a game's own notes among the settings, where the shell has no file for them. */
export const ownNotesSetting = (gameId: string) => `ownNotes:${gameId}`;

interface Backend {
  read(gameId: string): Promise<string | null>;
  write(gameId: string, text: string, keepCopy?: string): Promise<void>;
  remove(gameId: string): Promise<boolean>;
}

const browserBackend: Backend = {
  async read(gameId) {
    const value = await progressStore().getSetting(ownNotesSetting(gameId));
    return typeof value === 'string' ? value : null;
  },
  async write(gameId, text, keepCopy) {
    const store = progressStore();
    if (keepCopy) {
      const before = await store.getSetting(ownNotesSetting(gameId));
      if (typeof before === 'string') {
        await store.putSetting(`${ownNotesSetting(gameId)}:copy:${keepCopy}`, before);
      }
    }
    await store.putSetting(ownNotesSetting(gameId), text);
  },
  async remove(gameId) {
    const store = progressStore();
    const before = await store.getSetting(ownNotesSetting(gameId));
    await store.putSetting(ownNotesSetting(gameId), null);
    return typeof before === 'string';
  },
};

/** Where own notes are kept on this device: with the own lists (see the top of this file). */
export function ownNotesBackend(): Backend {
  const { app } = useAtlas.getState();
  if (desktop && app?.ownListFiles === true) {
    const bridge = desktop;
    return {
      read: (gameId) => bridge.ownNotes.read(gameId),
      write: async (gameId, text, keepCopy) => {
        await bridge.ownNotes.write(gameId, text, keepCopy);
      },
      remove: (gameId) => bridge.ownNotes.delete(gameId),
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

/** Reads the own notes of a game, once per game. */
export function loadOwnNotes(game: LoadedGame): Promise<void> {
  const gameId = game.pack.manifest.gameId;
  if (loadingFor === gameId && loading) return loading;
  void flushOwnNotes();
  loadingFor = gameId;
  keepCopyNext = false;
  set({
    gameId,
    status: 'loading',
    error: null,
    readOnly: null,
    own: NO_OWN_NOTES,
    save: 'saved',
    saveError: null,
    undo: [],
    draftPictures: [],
  });
  // The filter of locations with notes is of the game it was set on.
  if (useAtlas.getState().notesOnly) useAtlas.setState({ notesOnly: false });
  loading = (async () => {
    try {
      const text = await ownNotesBackend().read(gameId);
      if (loadingFor !== gameId) return;
      if (text !== null) {
        const read = readOwnNotesFile(parse(text));
        if (!read.ok || read.file.gameId !== gameId) {
          set({
            status: 'error',
            error:
              'Your notes could not be read, so they were left as they are. Nothing will be written over them.',
          });
          return;
        }
        const { file } = read;
        const newer = file.version > OWN_NOTES_VERSION;
        set({
          own: file.own,
          readOnly: newer
            ? 'Your notes were saved by a newer version of Atlas, so they can be read here but changed only there.'
            : null,
        });
        if (file.skipped > 0 && !newer) {
          keepCopyNext = true;
          notify(
            `${file.skipped === 1 ? 'One of your notes' : `${file.skipped} of your notes`} could not be read and ${file.skipped === 1 ? 'is' : 'are'} left out. A copy of the file as it was is kept when you next change a note.`,
            'error',
          );
        }
      }
      set({ status: 'ready' });
    } catch (error) {
      if (loadingFor !== gameId) return;
      set({
        status: 'error',
        error: `Your notes could not be read: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  })();
  return loading;
}

/** Whether the own notes can be changed now. */
export function canChangeOwnNotes(state: OwnNotesState = get()): boolean {
  return state.status === 'ready' && state.readOnly === null;
}

/** Why the notes cannot be changed now, in words; null when they can. */
export function whyNotesCannotChange(state: OwnNotesState = get()): string | null {
  if (canChangeOwnNotes(state)) return null;
  if (state.readOnly) return state.readOnly;
  if (state.status === 'error') return state.error ?? 'Your notes could not be read.';
  return 'Your notes are still being read. Try again in a moment.';
}

/** The own notes of a game, when they are the ones read; none otherwise. */
export function ownNotesOf(gameId: string, state: OwnNotesState = get()): OwnNotes {
  return state.gameId === gameId ? state.own : NO_OWN_NOTES;
}

// ---------------------------------------------------------------------------
// As shown on the pack

const shownKnown = new WeakMap<LoadedGame['pack'], { own: OwnNotes; shown: NotesOnPack }>();

/**
 * Where each note of the game shown is: on the location its id leads to
 * now (following the pack's id migrations), or apart when the game no
 * longer has that location. Worked out once per pack and change.
 */
export function notesShownOf(
  game: LoadedGame,
  own: OwnNotes = ownNotesOf(game.pack.manifest.gameId),
): NotesOnPack {
  const known = shownKnown.get(game.pack);
  if (known?.own === own) return known.shown;
  const { pack } = game;
  const shown = notesOnPack(own, (id) => !isOwnId(id) && pack.locations.has(id), pack.currentId);
  shownKnown.set(game.pack, { own, shown });
  return shown;
}

/** The notes of the game shown, kept up to date. */
export function useNotesShown(game: LoadedGame): NotesOnPack {
  const own = useOwnNotes((s) => ownNotesOf(game.pack.manifest.gameId, s));
  return notesShownOf(game, own);
}

const notedKnown = new WeakMap<NotesOnPack, Map<LoadedGame['pack'], ReadonlySet<string>>>();

/**
 * The locations of the game shown that have a note of the person's: those
 * of the game with a note, and their own locations with a note.
 */
export function notedLocations(
  game: LoadedGame,
  shown: NotesOnPack = notesShownOf(game),
): ReadonlySet<string> {
  let byPack = notedKnown.get(shown);
  const known = byPack?.get(game.pack);
  if (known) return known;
  const noted = new Set(shown.byLocation.keys());
  for (const location of game.pack.data.locations) {
    if (isOwnId(location.id) && location.guideId === ownNoteId(location.id)) noted.add(location.id);
  }
  if (!byPack) {
    byPack = new Map();
    notedKnown.set(shown, byPack);
  }
  byPack.set(game.pack, noted);
  return noted;
}

/** The locations of the game shown with a note, kept up to date. */
export function useNotedLocations(game: LoadedGame | null): ReadonlySet<string> | null {
  const own = useOwnNotes((s) => (game ? ownNotesOf(game.pack.manifest.gameId, s) : NO_OWN_NOTES));
  if (!game) return null;
  return notedLocations(game, notesShownOf(game, own));
}

provideNotedLocations((game) => notedLocations(game));

const textsKnown = new WeakMap<NotesOnPack, Map<LoadedGame['pack'], NoteText[]>>();

/** Every note's text of the game shown, to search (see `noteTexts`). */
export function noteTextsOf(game: LoadedGame, shown: NotesOnPack = notesShownOf(game)): NoteText[] {
  let byPack = textsKnown.get(shown);
  const known = byPack?.get(game.pack);
  if (known) return known;
  const texts = noteTexts(game.pack.data, shown);
  if (!byPack) {
    byPack = new Map();
    textsKnown.set(shown, byPack);
  }
  byPack.set(game.pack, texts);
  return texts;
}

/** The note shown on a location of the game, if it has one. */
export function noteAt(game: LoadedGame, locationId: string): ShownNote | undefined {
  return notesShownOf(game).byLocation.get(locationId);
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
    void flushOwnNotes();
  }, SAVE_DELAY_MS);
}

/** Saves what has changed now, after any save under way. */
export function flushOwnNotes(): Promise<void> {
  window.clearTimeout(timer);
  timer = undefined;
  if (!dirty) return writing;
  const { gameId, own } = get();
  if (!gameId || !canChangeOwnNotes()) return writing;
  dirty = false;
  let text: string;
  try {
    text = writeOwnNotesFile(gameId, own, new Date());
  } catch (error) {
    set({ save: 'failed', saveError: 'Your notes could not be saved: they are not valid.' });
    console.error(error);
    return writing;
  }
  const keepCopy = keepCopyNext ? new Date().toISOString() : undefined;
  keepCopyNext = false;
  set({ save: 'saving' });
  writing = writing
    .then(() => ownNotesBackend().write(gameId, text, keepCopy))
    .then(
      () => {
        if (get().gameId === gameId && !dirty) set({ save: 'saved', saveError: null });
      },
      (error: unknown) => {
        if (get().gameId !== gameId) return;
        dirty = true;
        const message = error instanceof Error ? error.message : String(error);
        set({ save: 'failed', saveError: message });
        notify(`Your notes could not be saved: ${message}`, 'error');
      },
    );
  return writing;
}

/**
 * Changes the own notes of the game shown: `change` returns them changed
 * (the same object when nothing changed). With `label`, it can be undone.
 * Returns whether anything changed.
 */
function changeOwnNotes(change: (own: OwnNotes) => OwnNotes, label?: string): boolean {
  const { gameId, own, undo } = get();
  if (!gameId || !canChangeOwnNotes()) return false;
  const next = change(own);
  if (next === own) return false;
  set({
    own: next,
    save: 'unsaved',
    saveError: null,
    undo: label ? [...undo.slice(-(MAX_UNDO - 1)), { before: own, label }] : undo,
  });
  scheduleSave();
  if ((next.pictures?.length ?? 0) < (own.pictures?.length ?? 0)) sweepOwnPicturesLater();
  return true;
}

/** Undoes the last change to the notes; what it was, or null when there is none. */
export function undoOwnNotesChange(): string | null {
  if (!canChangeOwnNotes()) return null;
  const { undo } = get();
  const last = undo.at(-1);
  if (!last) return null;
  set({ own: last.before, undo: undo.slice(0, -1), save: 'unsaved' });
  scheduleSave();
  return last.label;
}

/** Says a change to the notes, with a way to undo it. */
function sayWithUndo(said: string): void {
  notify(said, 'info', {
    action: {
      label: 'Undo',
      run: () => {
        const label = undoOwnNotesChange();
        if (label) notify(`Undone: ${label.charAt(0).toLowerCase()}${label.slice(1)}`);
      },
    },
  });
}

/**
 * Writes the note of a location of the game shown (its id and name now):
 * an empty note deletes it. The photos just added to it (`pictures`) are
 * kept with the notes. Returns whether anything changed.
 */
export function saveNote(
  game: LoadedGame,
  location: { id: string; name: string },
  fields: NoteFields,
  pictures: readonly Picture[] = get().draftPictures,
): boolean {
  const had = noteAt(game, location.id) !== undefined;
  const changed = changeOwnNotes(
    (own) => putNote(own, location, fields, new Date(), game.pack.currentId, pictures),
    had ? 'Note changed' : 'Note added',
  );
  set({ draftPictures: [] });
  return changed;
}

/** Deletes a note, by the id it is kept under, and says so with Undo. */
export function deleteNote(keptAs: string, name: string): boolean {
  const done = changeOwnNotes((own) => removeNote(own, keptAs), `Deleted your note on “${name}”`);
  if (done) sayWithUndo(`Deleted your note on “${name}”`);
  return done;
}

/** Keeps the photos added to the note being written until it is saved or cancelled. */
export function setNoteDraftPictures(pictures: readonly Picture[]): void {
  set({ draftPictures: pictures });
}

// The photos the notes show are never taken for unused ones.
addOwnPictureSource({
  ready: (gameId) => {
    const state = get();
    return state.gameId === gameId && canChangeOwnNotes(state);
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
    void flushOwnNotes();
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

// ---------------------------------------------------------------------------
// With the game: deleted, or carried in a map pack file

/** Deletes a game's own notes, when the person asks for it as they delete the game. */
export async function deleteOwnNotesOf(gameId: string): Promise<boolean> {
  if (get().gameId === gameId) {
    window.clearTimeout(timer);
    dirty = false;
    await writing;
    set({ own: NO_OWN_NOTES, undo: [], save: 'saved', draftPictures: [] });
  }
  return ownNotesBackend().remove(gameId);
}

/**
 * Adds the notes a map pack file carried to the person's of that game: a
 * note on the same location is replaced by the file's. Returns how many
 * notes the file had.
 */
export async function addImportedOwnNotes(gameId: string, text: string): Promise<number> {
  const read = readOwnNotesFile(parse(text));
  if (!read.ok || read.file.gameId !== gameId) {
    throw new Error('The notes in the file could not be read.');
  }
  const incoming = read.file.own;
  const count = countOwnNotes(incoming);
  if (get().gameId === gameId && get().status === 'ready') {
    if (!canChangeOwnNotes()) throw new Error(get().readOnly ?? 'They cannot be changed now.');
    set({ own: mergeOwnNotes(get().own, incoming), save: 'unsaved', undo: [] });
    scheduleSave();
    await flushOwnNotes();
    return count;
  }
  const store = ownNotesBackend();
  const before = await store.read(gameId);
  let here: OwnNotes = NO_OWN_NOTES;
  if (before !== null) {
    const was = readOwnNotesFile(parse(before));
    if (!was.ok || was.file.version > OWN_NOTES_VERSION) {
      throw new Error('The notes you have for this game could not be read.');
    }
    here = was.file.own;
  }
  await store.write(
    gameId,
    writeOwnNotesFile(gameId, mergeOwnNotes(here, incoming), new Date()),
    before !== null ? new Date().toISOString() : undefined,
  );
  return count;
}
