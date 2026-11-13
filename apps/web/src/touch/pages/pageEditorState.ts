import { isOwnId } from '@atlas/schema';
import { deleteOwnPage, pageTitle, savePage } from '@atlas/core';
import type { GuideEntry, OwnPages, Picture } from '@atlas/schema';
import { create } from 'zustand';
import { readPage, writePage, type EditPage } from '../../markdownEdit/draft';
import type { Inline, InlineContext } from '../../markdownEdit/inline';
import { notify } from '../../state/actions';
import { guidesOf } from '../../state/guides';
import {
  canChangeOwnPages,
  changeOwnPages,
  setDraftPictures,
  useOwnPages,
} from '../../state/ownPages';
import { useAtlas, type LoadedGame } from '../../state/store';
import { openPlace } from '../reader';

/**
 * The page editor of the Guides section: which page is edited, its title
 * and text as they are being changed (see `markdownEdit/draft.ts`), Undo
 * and Redo of those changes, and whether the person is asked to save
 * before leaving. Nothing is kept as the person's until they save; till
 * then the page being edited is kept in this browser's storage too, so a
 * closed window loses nothing.
 */

export interface Snapshot {
  title: string;
  text: string;
}

export type EditorMode = 'formatted' | 'markdown';

export interface PageEditorState {
  /** The editor is shown in place of the reader. */
  open: boolean;
  /** The page edited; null while none is chosen. */
  guideId: string | null;
  /** A page of one's own just added, not saved yet. */
  isNew: boolean;
  title: string;
  page: EditPage;
  /** The page's text now (from `page`, or as typed in the Markdown view). */
  text: string;
  /** The title and text as opened or last saved. */
  base: Snapshot;
  mode: EditorMode;
  undo: Snapshot[];
  redo: Snapshot[];
  /** "See the wiki's version": the pack's text is shown in place of the editor. */
  wikiView: boolean;
  /** The field the text tools act on, and the block it is in. */
  focused: { field: string; block: number } | null;
  /** A field to put the cursor in once it is shown. */
  pendingFocus: { field: string; at: number | 'end' } | null;
  /** A picture chosen in the text: its field and place. */
  picture: { field: string; at: number } | null;
  /** Leaving with changes not saved: what to do after the person answers. */
  leaving: { then: () => void } | null;
  /** Changes not saved found from before, offered back. */
  restore: Snapshot | null;
  /** Why saving did not work. */
  error: string | null;
}

const EMPTY_PAGE = readPage('');

export const usePageEditor = create<PageEditorState>()(() => ({
  open: false,
  guideId: null,
  isNew: false,
  title: '',
  page: EMPTY_PAGE,
  text: '',
  base: { title: '', text: '' },
  mode: 'formatted',
  undo: [],
  redo: [],
  wikiView: false,
  focused: null,
  pendingFocus: null,
  picture: null,
  leaving: null,
  restore: null,
  error: null,
}));

const get = usePageEditor.getState;
const set = usePageEditor.setState;

export const isDirty = (state: PageEditorState = get()) =>
  state.guideId !== null && (state.title !== state.base.title || state.text !== state.base.text);

// ---------------------------------------------------------------------------
// Fields of the text, for the text tools

/** What the text tools can do with a field of text being edited. */
export interface FieldApi {
  id: string;
  block: number;
  context: InlineContext;
  element: HTMLElement;
  pieces(): Inline[];
  /** The selection in it, as places in the text: the last one when it is not focused. */
  selection(): [number, number];
  /** Changes its pieces, and selects from `select[0]` to `select[1]`. */
  apply(pieces: Inline[], select?: [number, number]): void;
}

export const fields = new Map<string, FieldApi>();

export function focusedField(): FieldApi | null {
  const focused = get().focused;
  return focused ? (fields.get(focused.field) ?? null) : null;
}

export function setFocused(field: string, block: number): void {
  const focused = get().focused;
  if (focused?.field === field) return;
  set({ focused: { field, block }, picture: null });
}

export function setFocusedBlock(block: number): void {
  set({ focused: { field: `${block}`, block } });
}

export function focusField(field: string, at: number | 'end'): void {
  set({ pendingFocus: { field, at } });
}

export function clearPendingFocus(): void {
  set({ pendingFocus: null });
}

export function choosePicture(picture: { field: string; at: number } | null): void {
  set({ picture });
}

// ---------------------------------------------------------------------------
// Opening and leaving

/** The page as the editor starts from it: as the reader shows it. */
function shownPage(game: LoadedGame, guideId: string): GuideEntry | undefined {
  return guidesOf(game).contents.guide(guideId);
}

const draftKey = (gameId: string, guideId: string) => `atlas:pageDraft:${gameId}:${guideId}`;

interface StoredDraft extends Snapshot {
  base: Snapshot;
}

function storedDraft(gameId: string, guideId: string): StoredDraft | null {
  try {
    const text = window.localStorage.getItem(draftKey(gameId, guideId));
    if (!text) return null;
    const value = JSON.parse(text) as Partial<StoredDraft>;
    if (typeof value.title !== 'string' || typeof value.text !== 'string') return null;
    return {
      title: value.title,
      text: value.text,
      base: {
        title: typeof value.base?.title === 'string' ? value.base.title : '',
        text: typeof value.base?.text === 'string' ? value.base.text : '',
      },
    };
  } catch {
    return null;
  }
}

function forgetDraft(gameId: string, guideId: string): void {
  try {
    window.localStorage.removeItem(draftKey(gameId, guideId));
  } catch {
    // Not kept: nothing to forget.
  }
}

let draftTimer: number | undefined;

/** Keeps the page being edited in this browser's storage a moment after each change. */
function keepDraftSoon(): void {
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(keepDraftNow, 800);
}

function keepDraftNow(): void {
  window.clearTimeout(draftTimer);
  const state = get();
  const gameId = useAtlas.getState().game?.pack.manifest.gameId;
  if (!gameId || !state.guideId) return;
  try {
    if (!isDirty(state)) {
      window.localStorage.removeItem(draftKey(gameId, state.guideId));
      return;
    }
    const draft: StoredDraft = { title: state.title, text: state.text, base: state.base };
    window.localStorage.setItem(draftKey(gameId, state.guideId), JSON.stringify(draft));
  } catch {
    // Storage full or not allowed: the page is still asked about before leaving.
  }
}

/** Starts editing a page (or none, with null): from the text the reader shows. */
function startEditing(guideId: string | null, isNew = false): void {
  const game = useAtlas.getState().game;
  const guide = game && guideId ? shownPage(game, guideId) : undefined;
  const text = guide?.body ?? '';
  const title = guide?.title ?? '';
  const stored = game && guide ? storedDraft(game.pack.manifest.gameId, guide.id) : null;
  set({
    open: true,
    guideId: guide ? guide.id : null,
    isNew,
    title,
    text,
    page: readPage(text),
    base: { title, text },
    undo: [],
    redo: [],
    wikiView: false,
    focused: null,
    pendingFocus: null,
    picture: null,
    leaving: null,
    restore:
      stored && (stored.title !== title || stored.text !== text)
        ? { title: stored.title, text: stored.text }
        : null,
    error: null,
  });
  setDraftPictures([]);
}

/** Asks first when there are changes not saved; then does `then`. */
export function requestLeave(then: () => void): void {
  if (!isDirty()) {
    then();
    return;
  }
  set({ leaving: { then } });
}

/** The answer to "Save your changes?". */
export function answerLeave(answer: 'save' | 'discard' | 'stay'): void {
  const leaving = get().leaving;
  set({ leaving: null });
  if (!leaving || answer === 'stay') return;
  if (answer === 'save') {
    if (!savePageEdits()) return;
  } else {
    discardEdits();
  }
  leaving.then();
}

/** Opens the editor on a page, or on none (the contents only). */
export function openPageEditor(guideId: string | null): void {
  if (get().open) {
    if (guideId === get().guideId) return;
    requestLeave(() => {
      startEditing(guideId);
    });
    return;
  }
  startEditing(guideId);
}

/** A page of one's own just added: edited at once. */
export function editNewPage(guideId: string): void {
  requestLeave(() => {
    startEditing(guideId, true);
  });
}

/** Leaves the editor for the reader, at the page that was edited. */
export function closePageEditor(): void {
  requestLeave(() => {
    const { guideId } = get();
    forgetIfNewAndEmpty();
    set({ open: false, guideId: null, leaving: null, restore: null, wikiView: false });
    setDraftPictures([]);
    if (
      guideId &&
      useAtlas.getState().game &&
      guidesOf(useAtlas.getState().game!).contents.isPage(guideId)
    ) {
      openPlace({ kind: 'page', guideId });
    }
  });
}

/** Closes the editor at once, saving nothing (another game is shown). */
export function dropPageEditor(): void {
  window.clearTimeout(draftTimer);
  set({ open: false, guideId: null, leaving: null, restore: null });
  setDraftPictures([]);
}

/** A new page of one's own left as it was made: it goes again. */
function forgetIfNewAndEmpty(): void {
  const { isNew, guideId, title, text } = get();
  if (!isNew || !guideId || text.trim() !== '' || !isOwnId(guideId)) return;
  const page = useOwnPages.getState().own.pages.find((p) => p.id === guideId);
  if (!page || (page.body ?? '') !== '' || page.title !== title) return;
  changeOwnPages((own, layout) => deleteOwnPage(own, layout, guideId));
}

// ---------------------------------------------------------------------------
// Changing the page

const COALESCE_MS = 1000;
let lastChange: { key: string; at: number } | null = null;

/** Keeps the page as it is for Undo, unless the same kind of change was made a moment ago. */
function remember(coalesce?: string): void {
  const now = Date.now();
  const state = get();
  const same =
    coalesce !== undefined && lastChange?.key === coalesce && now - lastChange.at < COALESCE_MS;
  lastChange = coalesce === undefined ? null : { key: coalesce, at: now };
  if (same) {
    if (state.redo.length > 0) set({ redo: [] });
    return;
  }
  set({ undo: [...state.undo.slice(-199), { title: state.title, text: state.text }], redo: [] });
}

/** Changes the page's blocks. With `coalesce`, typing in one field is one step of Undo. */
export function changePage(change: (page: EditPage) => EditPage, coalesce?: string): void {
  const state = get();
  const page = change(state.page);
  if (page === state.page) return;
  const text = writePage(page);
  if (text === state.text) {
    set({ page });
    return;
  }
  remember(coalesce);
  set({ page, text, error: null });
  keepDraftSoon();
}

export function setTitle(title: string): void {
  if (title === get().title) return;
  remember('title');
  set({ title, error: null });
  keepDraftSoon();
}

/** The text as typed in the Markdown view. */
export function setMarkdown(text: string): void {
  if (text === get().text) return;
  remember('markdown');
  set({ text, error: null });
  keepDraftSoon();
}

/** The whole page read again from its text: its blocks start again. */
function reread(snapshot: Snapshot): void {
  set({
    title: snapshot.title,
    text: snapshot.text,
    page: readPage(snapshot.text),
    focused: null,
    picture: null,
    pendingFocus: null,
  });
  keepDraftSoon();
}

export function setMode(mode: EditorMode): void {
  const state = get();
  if (state.mode === mode) return;
  lastChange = null;
  // Back from Markdown: the blocks read from the text as typed.
  if (mode === 'formatted') reread({ title: state.title, text: state.text });
  set({ mode, focused: null, picture: null });
}

/** Reads the blocks again from the text (after a block was edited as Markdown). */
export function rereadBlocks(): void {
  const { title, text } = get();
  reread({ title, text });
}

export function undoEdit(): void {
  const state = get();
  const last = state.undo.at(-1);
  if (!last) return;
  lastChange = null;
  set({
    undo: state.undo.slice(0, -1),
    redo: [...state.redo, { title: state.title, text: state.text }],
  });
  reread(last);
}

export function redoEdit(): void {
  const state = get();
  const next = state.redo.at(-1);
  if (!next) return;
  lastChange = null;
  set({
    redo: state.redo.slice(0, -1),
    undo: [...state.undo, { title: state.title, text: state.text }],
  });
  reread(next);
}

/** Takes back the changes found from before, or forgets them. */
export function answerRestore(take: boolean): void {
  const { restore, guideId } = get();
  set({ restore: null });
  const gameId = useAtlas.getState().game?.pack.manifest.gameId;
  if (!restore) return;
  if (take) {
    remember();
    reread(restore);
  } else if (gameId && guideId) {
    forgetDraft(gameId, guideId);
  }
}

export function setWikiView(wikiView: boolean): void {
  set({ wikiView });
}

/** Adds a photo record to the page being edited (its file is kept already). */
export function addDraftPicture(picture: Picture): void {
  setDraftPictures([...useOwnPages.getState().draftPictures, picture]);
}

/** Changes a photo of one's own shown in the page: its caption, say. */
export function changeDraftPicture(picture: Picture): void {
  const { draftPictures } = useOwnPages.getState();
  setDraftPictures([...draftPictures.filter((p) => p.id !== picture.id), picture]);
}

// ---------------------------------------------------------------------------
// Saving and cancelling

/** The pack's own page of an id: what a change of the person's is kept apart from. */
export function packPage(game: LoadedGame, id: string): GuideEntry | undefined {
  return isOwnId(id) ? undefined : game.pack.data.guides.find((guide) => guide.id === id);
}

/** The own pictures with those of the page being edited in place of theirs. */
function withPictures(own: OwnPages, pictures: readonly Picture[]): OwnPages {
  if (pictures.length === 0) return own;
  const byId = new Map((own.pictures ?? []).map((picture) => [picture.id, picture]));
  for (const picture of pictures) byId.set(picture.id, picture);
  return { ...own, pictures: [...byId.values()] };
}

/** Saves the page as edited. Returns whether it was saved (or had nothing to save). */
export function savePageEdits(): boolean {
  const state = get();
  const game = useAtlas.getState().game;
  if (!game || !state.guideId) return false;
  const guideId = state.guideId;
  const pictures = useOwnPages.getState().draftPictures;
  if (!isDirty(state) && pictures.length === 0) {
    forgetDraft(game.pack.manifest.gameId, guideId);
    return true;
  }
  const title = pageTitle(state.title);
  if (!title) {
    set({ error: 'Give the page a title before saving it.' });
    return false;
  }
  if (!canChangeOwnPages()) {
    set({
      error:
        useOwnPages.getState().readOnly ??
        useOwnPages.getState().error ??
        'Your pages cannot be changed now.',
    });
    return false;
  }
  const text = state.text;
  if (title === state.base.title && text === state.base.text) {
    changeOwnPages((own) => withPictures(own, pictures));
  } else {
    changeOwnPages((own) =>
      withPictures(
        savePage(own, packPage(game, guideId), guideId, title, text, new Date()),
        pictures,
      ),
    );
  }
  forgetDraft(game.pack.manifest.gameId, guideId);
  setDraftPictures([]);
  set({ base: { title, text }, title, isNew: false, error: null });
  return true;
}

/** Drops the changes not saved: the page as it was opened. */
export function discardEdits(): void {
  const state = get();
  const gameId = useAtlas.getState().game?.pack.manifest.gameId;
  if (gameId && state.guideId) forgetDraft(gameId, state.guideId);
  window.clearTimeout(draftTimer);
  setDraftPictures([]);
  set({
    title: state.base.title,
    text: state.base.text,
    page: readPage(state.base.text),
    undo: [],
    redo: [],
  });
}

/** Saves and goes back to reading the page. */
export function saveAndClose(): void {
  if (!savePageEdits()) return;
  notify('Saved the page.');
  closePageEditor();
}

/** Drops the changes (once asked) and goes back to reading. */
export function cancelEditing(): void {
  closePageEditor();
}

/** The page was changed outside the editor (taken back to the wiki's text): edited from there. */
export function reloadPage(): void {
  const { guideId } = get();
  const game = useAtlas.getState().game;
  if (!game || !guideId) return;
  const gameId = game.pack.manifest.gameId;
  forgetDraft(gameId, guideId);
  startEditing(guideId);
}

// Changes not saved are asked about before the window closes.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    keepDraftNow();
    if (get().open && isDirty()) event.preventDefault();
  });
  window.addEventListener('pagehide', () => {
    keepDraftNow();
  });
}
