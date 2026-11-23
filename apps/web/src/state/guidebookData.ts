import { GuideSearch, type GuideHit } from '@atlas/core';
import type { GameGroup } from '@atlas/schema';
import { z } from 'zod';
import type { ListedPack } from '../desktop';

/**
 * Guidebooks: published guides a person has as one file, a PDF or a CBZ
 * (a ZIP of page pictures), in a pack of their own, one per game (version 8
 * of the pack file format, see `crates/atlas-pack`). This module holds what
 * needs no page: which games a pack of guidebooks joins, reading its list
 * (`guidebooks.json`) and the text of a guidebook's pages, and searching
 * that text. `guidebooks.ts` keeps the state; `guidebook/` reads the pages.
 *
 * Everything read from a pack is untrusted: sizes, counts and names are
 * bounded, and an entry that does not fit is left out.
 */

/** The most guidebooks one pack lists, as the pack format says. */
export const MAX_GUIDEBOOKS = 100;
/** The longest title of a guidebook, in characters. */
export const MAX_GUIDEBOOK_TITLE = 200;
/** The most pages of one guidebook. */
export const MAX_GUIDEBOOK_PAGES = 100_000;
/** The largest guidebook file: 16 GB. */
export const MAX_GUIDEBOOK_BYTES = 16 * 1024 ** 3;
/** The largest text file of one guidebook. */
export const MAX_GUIDEBOOK_TEXT_BYTES = 64 * 1024 * 1024;
/** The largest list of guidebooks (`guidebooks.json`) read. */
const MAX_LIST_BYTES = 4 * 1024 * 1024;

export type GuidebookType = 'pdf' | 'cbz';

/** One guidebook, as the app shows it. */
export interface Guidebook {
  /** `<pack id>/<entry name>`: what the place read last and the kept text are known by. */
  key: string;
  packId: string;
  /** The entry name in the pack, `guidebooks/<name>.pdf` or `.cbz`. */
  file: string;
  /** Where the pack protocol serves the file, read in parts. */
  url: string;
  title: string;
  pages: number;
  bytes: number;
  type: GuidebookType;
  /** Where the text of its pages is, when the pack has it. */
  textUrl: string | null;
  /** Atlas wrote its pack, so the person can remove it here. */
  byAtlas: boolean;
}

// ---------------------------------------------------------------------------
// Which game a pack of guidebooks joins

/**
 * A title tidied for comparing, as the shell compares titles (`title_key`
 * in `background/titles.rs`, which the start option `--show-game` uses):
 * without regard to case, to space around it, and to runs of punctuation
 * and space inside it, so "Hollow Marsh" and " hollow-marsh! " are one.
 */
export function titleKey(title: string): string {
  return title
    .split(/[^\p{Alphabetic}\p{N}]+/u)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase())
    .join(' ');
}

/**
 * The games each pack of guidebooks joins, by the pack's id: every game
 * that is not a pack of guidebooks whose own title, the title its pack file
 * shows it under, or the title the person put it under (`game-groups.json`)
 * is the guidebooks' game's title (see {@link titleKey}), and every game
 * the person put under one title with the pack. A pack that joins none and
 * shares its title with another such pack listed before it joins that
 * one, so one game's guidebooks from two apps are one entry. A pack that
 * joins nothing is not in the map: it is an entry of its own, which opens
 * on its guidebooks.
 */
export function joinGuidebooks(
  packs: readonly Pick<ListedPack, 'id' | 'title' | 'gameTitle' | 'guidebooks' | 'magazines'>[],
  groups: readonly GameGroup[],
): Map<string, string[]> {
  // A pack of magazines is no game.
  const games = packs.filter((pack) => !pack.guidebooks && !pack.magazines);
  const groupOf = new Map<string, GameGroup>();
  for (const group of groups) {
    for (const member of group.members) groupOf.set(member.gameId, group);
  }
  // Every title a game is known by.
  const gamesByKey = new Map<string, string[]>();
  const note = (key: string, id: string) => {
    if (!key) return;
    const ids = gamesByKey.get(key) ?? [];
    if (!ids.includes(id)) ids.push(id);
    gamesByKey.set(key, ids);
  };
  for (const game of games) {
    note(titleKey(game.title), game.id);
    if (game.gameTitle) note(titleKey(game.gameTitle), game.id);
    const group = groupOf.get(game.id);
    if (group) note(titleKey(group.title), game.id);
  }
  const listed = new Set(games.map((game) => game.id));
  const joined = new Map<string, string[]>();
  const hosts = new Map<string, string>();
  for (const pack of packs) {
    if (!pack.guidebooks) continue;
    const key = titleKey(pack.gameTitle ?? pack.title);
    const ids = [...(gamesByKey.get(key) ?? [])];
    const group = groupOf.get(pack.id);
    for (const member of group?.members ?? []) {
      if (listed.has(member.gameId) && !ids.includes(member.gameId)) ids.push(member.gameId);
    }
    if (ids.length > 0) {
      joined.set(pack.id, ids);
      continue;
    }
    const host = hosts.get(key);
    if (host !== undefined) joined.set(pack.id, [host]);
    else if (key) hosts.set(key, pack.id);
  }
  return joined;
}

/**
 * Every game a pack of guidebooks can join: the packs listed, and the
 * games that come with the app that are not listed (by id).
 */
export function joinable<T extends { id: string; title: string }>(
  listed: readonly T[],
  bundled: readonly { id: string; title: string }[],
): (T | { id: string; title: string })[] {
  const ids = new Set(listed.map((pack) => pack.id));
  return [
    ...listed,
    ...bundled.filter((entry) => !ids.has(entry.id)).map(({ id, title }) => ({ id, title })),
  ];
}

/** The packs of guidebooks whose guidebooks a game lists: those that join it, and itself when it is one. */
export function guidebookPacksOf(
  gameId: string,
  packs: readonly ListedPack[],
  joined: ReadonlyMap<string, readonly string[]>,
): ListedPack[] {
  return packs.filter(
    (pack) =>
      pack.guidebooks === true && (pack.id === gameId || joined.get(pack.id)?.includes(gameId)),
  );
}

// ---------------------------------------------------------------------------
// The list of a pack's guidebooks

const NAME = /^guidebooks\/([a-z0-9][a-z0-9_-]{0,79})\.(pdf|cbz)$/;

const entrySchema = z.object({
  file: z.string().regex(NAME),
  title: z.string().trim().min(1).max(MAX_GUIDEBOOK_TITLE),
  pages: z.int().min(1).max(MAX_GUIDEBOOK_PAGES),
  bytes: z.int().min(1).max(MAX_GUIDEBOOK_BYTES),
  text: z.string().nullish(),
});

const listSchema = z.object({
  format: z.literal('atlas-guidebooks'),
  version: z.int().min(1),
  guidebooks: z.array(z.unknown()).max(MAX_GUIDEBOOKS),
});

/**
 * The guidebooks a pack's `guidebooks.json` lists, from its text: an entry
 * that does not fit (a name outside `guidebooks/`, a type other than PDF
 * and CBZ, a title, pages or size out of bounds, a text file of another
 * name) is left out, and one listed twice is taken once. Throws a sentence
 * when the list itself cannot be read.
 */
export function parseGuidebookList(text: string, pack: ListedPack): Guidebook[] {
  if (text.length > MAX_LIST_BYTES) throw new Error('The list of guidebooks is too large.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('The list of guidebooks cannot be read.');
  }
  const list = listSchema.safeParse(raw);
  if (!list.success) throw new Error('The list of guidebooks cannot be read.');
  const base = pack.url.endsWith('/') ? pack.url : `${pack.url}/`;
  const seen = new Set<string>();
  const out: Guidebook[] = [];
  for (const item of list.data.guidebooks) {
    const entry = entrySchema.safeParse(item);
    if (!entry.success) continue;
    const { file, title, pages, bytes, text: textName } = entry.data;
    const [, stem, type] = NAME.exec(file) ?? [];
    if (!stem || seen.has(stem)) continue;
    if (textName && textName !== `guidebooks/${stem}.text.json`) continue;
    seen.add(stem);
    out.push({
      key: `${pack.id}/${file}`,
      packId: pack.id,
      file,
      url: base + file,
      title,
      pages,
      bytes,
      type: type as GuidebookType,
      textUrl: textName ? base + textName : null,
      byAtlas: pack.guidebooksByAtlas === true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The text of a guidebook's pages

const textSchema = z.object({
  format: z.literal('atlas-guidebook-text'),
  version: z.int().min(1),
  pages: z.array(z.object({ page: z.int().min(1), text: z.string() })),
});

/**
 * The text of each page (the first is page 1, a page without text is
 * empty) from a guidebook's text file: at most
 * {@link MAX_GUIDEBOOK_TEXT_BYTES}, in its format, a version this app
 * reads, its pages in increasing order up to `pages`. Throws a sentence
 * when it cannot be used.
 */
export function parseGuidebookText(text: string, pages: number): string[] {
  const unusable = 'The text of this guidebook cannot be read.';
  if (text.length > MAX_GUIDEBOOK_TEXT_BYTES)
    throw new Error('The text of this guidebook is too large.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(unusable);
  }
  const parsed = textSchema.safeParse(raw);
  if (!parsed.success) throw new Error(unusable);
  if (parsed.data.version > 1) {
    throw new Error(
      'The text of this guidebook was written in a newer format, so it cannot be read.',
    );
  }
  const out = Array.from({ length: pages }, () => '');
  let last = 0;
  for (const { page, text: pageText } of parsed.data.pages) {
    if (page <= last || page > pages) throw new Error(unusable);
    last = page;
    out[page - 1] = pageText;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Searching

/** A page of a guidebook that has the words looked for. */
export interface GuidebookHit {
  guidebook: Guidebook;
  page: number;
  /** A line of the page's text around the words, and where they are in it. */
  snippet: string;
  marks: GuideHit['marks'];
}

const searches = new WeakMap<readonly string[], GuideSearch>();

/** A search over the pages of one guidebook's text. */
function searchOf(pages: readonly string[]): GuideSearch {
  let search = searches.get(pages);
  if (!search) {
    search = new GuideSearch(
      pages.flatMap((body, index) =>
        body.trim()
          ? [{ id: String(index + 1), title: '', body, locationIds: [] as string[] } as never]
          : [],
      ),
      (text) => text.replace(/\s+/g, ' ').trim(),
    );
    searches.set(pages, search);
  }
  return search;
}

/**
 * The pages of the guidebooks whose text has every word of `query`, in
 * each guidebook's order and then by page: at most `limit`. A guidebook
 * whose text is not known (`texts` has none for it) has none.
 */
export function searchGuidebooks(
  guidebooks: readonly Guidebook[],
  texts: ReadonlyMap<string, readonly string[]>,
  query: string,
  limit = 100,
): GuidebookHit[] {
  const hits: GuidebookHit[] = [];
  if (!query.trim()) return hits;
  for (const guidebook of guidebooks) {
    const pages = texts.get(guidebook.key);
    if (!pages) continue;
    const found = searchOf(pages)
      .search(query, MAX_GUIDEBOOK_PAGES)
      .map((hit) => ({
        guidebook,
        page: Number(hit.guide.id),
        snippet: hit.snippet,
        marks: hit.marks,
      }))
      .sort((a, b) => a.page - b.page);
    for (const hit of found) {
      if (hits.length >= limit) return hits;
      hits.push(hit);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Words for people

const sizeFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

/** A size in bytes, in words: "148 MB". */
export function sizeWords(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  if (unit === 0) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  return `${sizeFormat.format(value)} ${units[unit]}`;
}

/** What a guidebook is, in a few words: "PDF, 212 pages, 148 MB". */
export function guidebookFacts(guidebook: Pick<Guidebook, 'type' | 'pages' | 'bytes'>): string {
  const pages = `${new Intl.NumberFormat('en-GB').format(guidebook.pages)} ${guidebook.pages === 1 ? 'page' : 'pages'}`;
  return `${guidebook.type === 'pdf' ? 'PDF' : 'CBZ'}, ${pages}, ${sizeWords(guidebook.bytes)}`;
}

/**
 * Names of CBZ pictures in reading order: by name, numbers in them
 * compared as numbers ("page2" before "page10").
 */
export function naturalOrder(names: readonly string[]): string[] {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return [...names].sort((a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Whether a CBZ entry is a picture of a page: as the pack code counts them. */
export function isPagePicture(name: string): boolean {
  if (name.endsWith('/') || name.startsWith('__MACOSX/')) return false;
  const last = name.split('/').pop() ?? name;
  if (last.startsWith('.')) return false;
  return /\.(?:jpe?g|png|webp|gif|avif)$/i.test(last);
}
