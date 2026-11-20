import { useMemo } from 'react';
import { create } from 'zustand';
import type { GameGroup } from '@atlas/schema';
import { desktop, type GuidebooksChanged, type ListedPack, type PickedGuidebook } from '../desktop';
import { notify } from './actions';
import { useGameGroups } from './gameGroups';
import {
  guidebookPacksOf,
  joinable,
  joinGuidebooks,
  parseGuidebookList,
  parseGuidebookText,
  searchGuidebooks,
  type Guidebook,
  type GuidebookHit,
} from './guidebookData';
import { forgetKeptText, keptText, keepText } from './guidebookTexts';
import { applyListing } from './library';
import { useAtlas, type AtlasState } from './store';

/**
 * The guidebooks of the games on this device (see `guidebookData.ts`):
 * the list of each pack of guidebooks the shell lists, read again with
 * every listing; the text of the pages of the shown game's guidebooks,
 * for search; the guidebook open in the reader (`guidebook/`), and the
 * page each one was left at on this device; and "Add a guidebook…" and
 * "Remove this guidebook…", on a desktop.
 */

/** The list of one pack of guidebooks, as read. */
export interface PackGuidebooks {
  url: string;
  status: 'loading' | 'ready' | 'error';
  guidebooks: readonly Guidebook[];
  /** Why it cannot be read, in a sentence. */
  error: string | null;
}

/** The guidebook open in the reader. */
export interface OpenGuidebook {
  guidebook: Guidebook;
  /** The page to show first. */
  page: number;
  /** Words to look for as it opens (a result of search), or null. */
  query: string | null;
  /** Grows with each opening, so the same guidebook opened again starts again. */
  seq: number;
}

/** "Add a guidebook…", from a file picked to the guidebook added. */
export interface AddingGuidebook {
  gameId: string;
  gameTitle: string;
  picked: PickedGuidebook;
  phase: 'title' | 'reading' | 'writing';
  /** Pages read for their text, while reading. */
  done: number;
  total: number;
  /** Why it could not be added, in a sentence. */
  error: string | null;
}

export interface GuidebooksState {
  lists: Readonly<Record<string, PackGuidebooks>>;
  /** The text of each page of a guidebook, by its key, as far as known. */
  texts: ReadonlyMap<string, readonly string[]>;
  /** A guidebook's text is being read from its pack or its file: pages done of all. */
  reading: Readonly<Record<string, { done: number; total: number }>>;
  open: OpenGuidebook | null;
  adding: AddingGuidebook | null;
  /** The guidebook "Remove this guidebook…" asks about. */
  removing: Guidebook | null;
  busy: boolean;
}

export const useGuidebooks = create<GuidebooksState>()(() => ({
  lists: {},
  texts: new Map(),
  reading: {},
  open: null,
  adding: null,
  removing: null,
  busy: false,
}));

const get = useGuidebooks.getState;
const set = useGuidebooks.setState;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Which guidebooks a game has

let joinedKnown: {
  packs: readonly ListedPack[];
  groups: readonly GameGroup[];
  joined: Map<string, string[]>;
} | null = null;

/** Which games each pack of guidebooks joins, worked out once per listing and titles. */
export function joinedNow(
  packs: readonly ListedPack[] = useAtlas.getState().library?.packs ?? [],
  groups: readonly GameGroup[] = useGameGroups.getState().groups,
): Map<string, string[]> {
  if (joinedKnown?.packs === packs && joinedKnown.groups === groups) return joinedKnown.joined;
  const joined = joinGuidebooks(joinable(packs, useAtlas.getState().bundledCatalog), groups);
  joinedKnown = { packs, groups, joined };
  return joined;
}

/** The guidebooks of a game, from every pack of guidebooks it has, in the order of their packs. */
export function guidebooksOfGame(
  gameId: string,
  packs: readonly ListedPack[],
  groups: readonly GameGroup[],
  lists: GuidebooksState['lists'],
): Guidebook[] {
  return guidebookPacksOf(gameId, packs, joinedNow(packs, groups)).flatMap(
    (pack) => lists[pack.id]?.guidebooks ?? [],
  );
}

/** The guidebooks of a game, kept up to date. */
export function useGameGuidebooks(gameId: string | null | undefined): readonly Guidebook[] {
  const packs = useAtlas((s) => s.library?.packs);
  const groups = useGameGroups((s) => s.groups);
  const lists = useGuidebooks((s) => s.lists);
  return useMemo(
    () => (gameId && packs ? guidebooksOfGame(gameId, packs, groups, lists) : NONE),
    [gameId, packs, groups, lists],
  );
}

const NONE: readonly Guidebook[] = [];

/** The pages of a game's guidebooks that have the words looked for, at most `limit`. */
export function useGuidebookHits(
  gameId: string | null | undefined,
  query: string,
  limit = 100,
): GuidebookHit[] {
  const guidebooks = useGameGuidebooks(gameId);
  const texts = useGuidebooks((s) => s.texts);
  return useMemo(
    () => (query.trim() ? searchGuidebooks(guidebooks, texts, query, limit) : []),
    [guidebooks, texts, query, limit],
  );
}

/** The guidebooks of the game shown, now. */
export function shownGuidebooks(): Guidebook[] {
  const id = useAtlas.getState().game?.entry.id;
  const packs = useAtlas.getState().library?.packs;
  if (!id || !packs) return [];
  return guidebooksOfGame(id, packs, useGameGroups.getState().groups, get().lists);
}

/** A pack of guidebooks of the game shown, by its id, as the shell lists it. */
export function packOfGuidebook(guidebook: Guidebook): ListedPack | undefined {
  return useAtlas.getState().library?.packs.find((pack) => pack.id === guidebook.packId);
}

/**
 * Whether "Add a guidebook…" and "Remove this guidebook…" are there: in
 * the desktop app, not the Android one, which reads the guidebooks of the
 * packs imported into it but writes none.
 */
export function guidebookChangesOffered(state: Pick<AtlasState, 'app'>): boolean {
  return desktop !== null && state.app !== null && state.app.platform !== 'android';
}

// ---------------------------------------------------------------------------
// Reading the lists

let generation = 0;

/** Reads the list of every pack of guidebooks listed (again), and forgets packs no longer listed. */
export async function loadGuidebookLists(packs: readonly ListedPack[]): Promise<void> {
  const mine = ++generation;
  const books = packs.filter((pack) => pack.guidebooks === true);
  const before = get().lists;
  const lists: Record<string, PackGuidebooks> = {};
  for (const pack of books) {
    const was = before[pack.id];
    lists[pack.id] =
      was?.url === pack.url
        ? { ...was, status: was.status === 'error' ? 'loading' : was.status }
        : { url: pack.url, status: 'loading', guidebooks: [], error: null };
  }
  set({ lists });
  const read = await Promise.all(
    books.map(async (pack): Promise<[string, PackGuidebooks]> => {
      try {
        const response = await fetch(new URL('guidebooks.json', withSlash(pack.url)), {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('The list of guidebooks cannot be read.');
        const guidebooks = parseGuidebookList(await response.text(), pack);
        return [pack.id, { url: pack.url, status: 'ready', guidebooks, error: null }];
      } catch (error) {
        return [
          pack.id,
          { url: pack.url, status: 'error', guidebooks: [], error: errorText(error) },
        ];
      }
    }),
  );
  if (mine !== generation) return;
  set({ lists: Object.fromEntries(read) });
  closeIfGone();
}

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

/** The reader closes when its guidebook is no longer listed (removed, or its pack gone). */
function closeIfGone(): void {
  const open = get().open;
  if (!open) return;
  const still = get().lists[open.guidebook.packId]?.guidebooks.some(
    (guidebook) => guidebook.key === open.guidebook.key && guidebook.bytes === open.guidebook.bytes,
  );
  if (!still) set({ open: null });
}

/**
 * Follows the listings of the shell: the lists of the packs of
 * guidebooks are read again with each one. Returns the way to stop.
 */
export function followGuidebooks(): () => void {
  if (!desktop) return () => undefined;
  const packs = useAtlas.getState().library?.packs;
  if (packs) void loadGuidebookLists(packs);
  return useAtlas.subscribe((state, before) => {
    if (state.library && state.library !== before.library) {
      void loadGuidebookLists(state.library.packs);
    }
  });
}

// ---------------------------------------------------------------------------
// The text of the pages

const textLoads = new Map<string, Promise<void>>();

/**
 * Reads the text of the guidebooks' pages, for search, once each: from
 * the pack's text file when it has one, else (a PDF) the text read from
 * its pages before and kept on this device. A PDF without either has its
 * text read when it is first opened (see `guidebook/pdf.ts`).
 */
export function loadGuidebookTexts(guidebooks: readonly Guidebook[]): Promise<void> {
  return Promise.all(
    guidebooks.map((guidebook) => {
      if (get().texts.has(guidebook.key)) return Promise.resolve();
      const id = textId(guidebook);
      let load = textLoads.get(id);
      if (!load) {
        load = loadText(guidebook).finally(() => {
          textLoads.delete(id);
        });
        textLoads.set(id, load);
      }
      return load;
    }),
  ).then(() => undefined);
}

/** What a guidebook's text is kept under: its key, and the size and pages of its file. */
export const textId = (guidebook: Guidebook) =>
  `${guidebook.key}|${guidebook.bytes}|${guidebook.pages}`;

async function loadText(guidebook: Guidebook): Promise<void> {
  if (guidebook.textUrl) {
    try {
      const response = await fetch(guidebook.textUrl);
      if (!response.ok) return;
      const pages = parseGuidebookText(await response.text(), guidebook.pages);
      setText(guidebook.key, pages);
    } catch {
      // A text file that cannot be read: the guidebook is not searched.
    }
    return;
  }
  if (guidebook.type !== 'pdf') return;
  const kept = await keptText(textId(guidebook));
  if (kept?.length === guidebook.pages) setText(guidebook.key, kept);
}

function setText(key: string, pages: readonly string[]): void {
  const texts = new Map(get().texts);
  texts.set(key, pages);
  set({ texts });
}

/** Whether the text of a guidebook is to be read from its pages: a PDF with no text known. */
export function textToRead(guidebook: Guidebook): boolean {
  return (
    guidebook.type === 'pdf' &&
    guidebook.textUrl === null &&
    !get().texts.has(guidebook.key) &&
    get().reading[guidebook.key] === undefined
  );
}

/** How far reading a guidebook's text has come; `null` once it is over. */
export function noteReading(key: string, done: number | null, total: number): void {
  const others = Object.entries(get().reading).filter(([other]) => other !== key);
  set({
    reading: Object.fromEntries(done === null ? others : [...others, [key, { done, total }]]),
  });
}

/** The text read from a guidebook's pages: known now, and kept on this device. */
export async function keepReadText(guidebook: Guidebook, pages: readonly string[]): Promise<void> {
  setText(guidebook.key, pages);
  await keepText(textId(guidebook), pages);
}

/** Forgets the text of a guidebook kept on this device (it was removed). */
async function forgetText(guidebook: Guidebook): Promise<void> {
  const texts = new Map(get().texts);
  texts.delete(guidebook.key);
  set({ texts });
  await forgetKeptText(textId(guidebook));
}

// ---------------------------------------------------------------------------
// The reader

const PLACE_KEY = 'atlas-guidebook-page:';

/** The page a guidebook was left at on this device, or null. */
export function lastPage(guidebook: Guidebook): number | null {
  try {
    const value = Number(localStorage.getItem(PLACE_KEY + guidebook.key));
    return Number.isInteger(value) && value >= 1 && value <= guidebook.pages ? value : null;
  } catch {
    return null;
  }
}

/** Remembers the page a guidebook is at, on this device. */
export function rememberPage(guidebook: Guidebook, page: number): void {
  try {
    localStorage.setItem(PLACE_KEY + guidebook.key, String(page));
  } catch {
    // Storage that cannot be written: the guidebook opens at its start next time.
  }
}

let opened = 0;

/** Opens a guidebook in the reader: at `page`, else where it was left, else at its start. */
export function openGuidebook(guidebook: Guidebook, page?: number, query?: string): void {
  const at = page ?? lastPage(guidebook) ?? 1;
  set({
    open: {
      guidebook,
      page: Math.min(Math.max(1, at), guidebook.pages),
      query: query?.trim() ? query.trim() : null,
      seq: ++opened,
    },
  });
}

export function closeGuidebook(): void {
  set({ open: null });
}

// ---------------------------------------------------------------------------
// Adding and removing

/** The game guidebooks are added to: one of Atlas's packs of guidebooks of the game, else the game. */
function gameToAddTo(gameId: string): string {
  if (gameId.startsWith('guidebooks-')) return gameId;
  const packs = useAtlas.getState().library?.packs ?? [];
  const mine = guidebookPacksOf(gameId, packs, joinedNow(packs)).find(
    (pack) => pack.guidebooksByAtlas === true,
  );
  return mine?.id ?? gameId;
}

/** "Add a guidebook…": asks for the file, then for its title (see `GuidebookDialogs.tsx`). */
export async function startAddingGuidebook(gameId: string, gameTitle: string): Promise<void> {
  if (!desktop || get().adding || get().busy) return;
  set({ busy: true });
  try {
    const picked = await desktop.guidebooks.pick();
    if (!picked) return;
    set({
      adding: {
        gameId: gameToAddTo(gameId),
        gameTitle,
        picked,
        phase: 'title',
        done: 0,
        total: picked.pages ?? 0,
        error: null,
      },
    });
  } catch (error) {
    notify(errorText(error), 'error');
  } finally {
    set({ busy: false });
  }
}

/** Closes "Add a guidebook…" without adding it. */
export function cancelAddingGuidebook(): void {
  if (!get().adding) return;
  set({ adding: null });
  void desktop?.guidebooks.forgetPicked().catch(() => undefined);
}

let addRun = 0;

/**
 * Adds the picked file under `title`: a PDF's pages are counted and its
 * text read here, in the web app, with pdf.js (`guidebook/pdf.ts`), then
 * the shell writes the game's pack of guidebooks.
 */
export async function addGuidebook(title: string): Promise<void> {
  const adding = get().adding;
  if (!desktop || adding?.phase !== 'title') return;
  const run = ++addRun;
  const still = () => run === addRun && get().adding !== null;
  const { picked } = adding;
  let pages = picked.pages;
  let text: string[] | null = null;
  if (picked.type === 'pdf') {
    set({ adding: { ...adding, phase: 'reading', done: 0, error: null } });
    try {
      const { readPdfText } = await import('../guidebook/pdf');
      const read = await readPdfText(
        picked.url,
        picked.bytes,
        (done, total) => {
          const now = get().adding;
          if (still() && now) set({ adding: { ...now, done, total } });
        },
        still,
      );
      if (!still()) return;
      pages = read.pages;
      text = read.text;
    } catch (error) {
      if (!still()) return;
      set({ adding: { ...adding, phase: 'title', error: errorText(error) } });
      return;
    }
  }
  const now = get().adding;
  if (!now || !still()) return;
  set({ adding: { ...now, phase: 'writing' } });
  try {
    const changed = await desktop.guidebooks.add({
      gameId: adding.gameId,
      gameTitle: adding.gameTitle,
      token: picked.token,
      title: title.trim(),
      pages,
      text,
    });
    set({ adding: null });
    void desktop.guidebooks.forgetPicked().catch(() => undefined);
    await taken(changed);
  } catch (error) {
    const was = get().adding;
    if (was) set({ adding: { ...was, phase: 'title', error: errorText(error) } });
  }
}

/** Takes in the listing after a change, reads the lists again and says what was done. */
async function taken(changed: GuidebooksChanged): Promise<void> {
  applyListing(changed.listing);
  await loadGuidebookLists(changed.listing.packs);
  notify(changed.message);
}

/** "Remove this guidebook…": asks first (see `GuidebookDialogs.tsx`). */
export function askToRemoveGuidebook(guidebook: Guidebook | null): void {
  set({ removing: guidebook });
}

/** Removes the guidebook asked about from its pack, which Atlas wrote. */
export async function removeGuidebook(): Promise<void> {
  const guidebook = get().removing;
  if (!desktop || !guidebook || get().busy) return;
  set({ busy: true });
  try {
    const changed = await desktop.guidebooks.remove(guidebook.packId, guidebook.file);
    set({ removing: null });
    if (get().open?.guidebook.key === guidebook.key) set({ open: null });
    await forgetText(guidebook);
    await taken(changed);
  } catch (error) {
    notify(errorText(error), 'error');
  } finally {
    set({ busy: false });
  }
}
