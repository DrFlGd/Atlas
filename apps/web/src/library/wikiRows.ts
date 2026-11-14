import { pageKey } from '@atlas/importer-api';
import { titleFromAddress } from '../state/gameChoice';
import type { WikiContents, WikiFailure, WikiNotes } from '../state/wikiNotes';

/**
 * The rows of the Library's wiki screen, worked out from what is on this
 * computer only: the wiki's contents as last read, the pages the game was
 * read from, its guides (of the game shown), and the notes of `wikiNotes.ts`.
 */

/** Where a page stands. "Changed on the wiki" is not one: telling would mean reading the wiki. */
export type WikiPageState = 'read' | 'not-read' | 'failed' | 'left-out';

export interface WikiRow {
  key: string;
  url: string;
  title: string;
  /** The heading it is under in the wiki's contents (or the guides' section, for a page read). */
  group: string;
  state: WikiPageState;
  /** When it was read (ISO time), for a page read. */
  readAt: string | null;
  /** Why it could not be read the last time it was tried. */
  failure: WikiFailure | null;
  /** Its guide, when read and the game is shown. */
  guideId: string | null;
  changedByYou: boolean;
  /** The pages of the same wiki it links to (for a page read). */
  links: string[];
  /** In the wiki's contents. */
  listed: boolean;
}

/** Pages a read page links to that the contents do not list and that were not read. */
export interface FoundRows {
  /** The page they were found on. */
  from: WikiRow;
  pages: WikiRow[];
}

export interface WikiGroup {
  title: string;
  rows: WikiRow[];
  found: FoundRows[];
}

/** A guide of the game shown that was read from a page of the wiki. */
export interface ReadGuide {
  id: string;
  title: string;
  url: string;
  /** The section it is in. */
  section: string | null;
  changedByYou: boolean;
}

/** Pages read but under no heading of the contents. */
export const OTHER_PAGES = 'Other pages';

/**
 * Page keys of addresses seen before: the rows are worked out again after
 * every page of a go, over every link of every page read (thousands).
 */
const keys = new Map<string, string>();
function keyOf(url: string): string {
  let key = keys.get(url);
  if (key === undefined) {
    if (keys.size >= 500_000) keys.clear();
    key = pageKey(url);
    keys.set(url, key);
  }
  return key;
}

export function wikiGroups(options: {
  contents: WikiContents | null;
  read: readonly { url: string; importedAt?: string | undefined }[];
  guides: readonly ReadGuide[];
  notes: WikiNotes;
}): WikiGroup[] {
  const { contents, notes } = options;
  const leftOut = new Set(notes.leftOut);
  // A page asked for under another name of it is the page it was read as: one row.
  const otherNames = notes.otherNames;
  const named = Object.keys(otherNames).length > 0;
  const sameKey = (key: string): string => {
    if (!named) return key;
    let current = key;
    for (let step = 0; step < 8 && otherNames[current] !== undefined; step++) {
      const next = keyOf(otherNames[current]!);
      if (next === current || next === key) break;
      current = next;
    }
    return current;
  };
  const canon = (url: string) => sameKey(keyOf(url));
  const read = new Map(options.read.map((page) => [canon(page.url), page]));
  const guides = new Map(options.guides.map((guide) => [canon(guide.url), guide]));
  const groups = new Map<string, WikiGroup>();
  const seen = new Set<string>();

  const row = (asked: string, named: string | null, group: string | null, listed: boolean) => {
    const key = canon(asked);
    const page = read.get(key);
    const guide = guides.get(key);
    // Under another name: shown as the page it was read as, with its own title.
    const other = key !== keyOf(asked);
    const url = other ? (guide?.url ?? otherNames[keyOf(asked)] ?? asked) : asked;
    const title = other ? (guide?.title ?? null) : named;
    const failure = notes.failed[key] ?? null;
    const state: WikiPageState =
      leftOut.has(key) || leftOut.has(keyOf(asked))
        ? 'left-out'
        : page || guide
          ? 'read'
          : failure
            ? 'failed'
            : 'not-read';
    return {
      key,
      url,
      title: title ?? guide?.title ?? titleFromAddress(url),
      group: group ?? guide?.section ?? OTHER_PAGES,
      state,
      readAt: page?.importedAt ?? null,
      failure,
      guideId: guide?.id ?? null,
      changedByYou: guide?.changedByYou ?? false,
      links: notes.links[key] ?? [],
      listed,
    } satisfies WikiRow;
  };
  const add = (entry: WikiRow) => {
    seen.add(entry.key);
    let group = groups.get(entry.group);
    if (!group) {
      group = { title: entry.group, rows: [], found: [] };
      groups.set(entry.group, group);
    }
    group.rows.push(entry);
  };

  for (const page of contents?.pages ?? []) {
    if (seen.has(canon(page.url))) continue;
    add(row(page.url, page.title, page.group ?? null, true));
  }
  // Pages read that the contents do not list (or before the contents were read).
  for (const guide of options.guides) {
    if (!seen.has(canon(guide.url))) add(row(guide.url, guide.title, null, false));
  }
  for (const page of options.read) {
    if (!seen.has(canon(page.url))) add(row(page.url, null, null, false));
  }
  // The pages each read page links to that are neither listed nor read: found there.
  for (const group of groups.values()) {
    for (const from of group.rows) {
      if (from.links.length === 0) continue;
      const pages: WikiRow[] = [];
      for (const link of from.links) {
        const key = canon(link);
        if (seen.has(key)) continue;
        seen.add(key);
        pages.push({ ...row(link, null, group.title, false), group: group.title });
      }
      if (pages.length > 0) group.found.push({ from, pages });
    }
  }
  return [...groups.values()];
}

/** The filters of the list, in order. */
export const WIKI_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'not-read', label: 'Not read' },
  { id: 'read', label: 'Read' },
  { id: 'failed', label: 'Could not be read' },
  { id: 'left-out', label: 'Left out' },
] as const;

export type WikiFilter = (typeof WIKI_FILTERS)[number]['id'];

/** Every page of the groups, those found through links too. */
export function allRows(groups: readonly WikiGroup[]): WikiRow[] {
  return groups.flatMap((group) => [...group.rows, ...group.found.flatMap((found) => found.pages)]);
}

export function matchesFilter(row: WikiRow, filter: WikiFilter): boolean {
  return filter === 'all' || row.state === filter;
}

/** Pages that a go can read now: not left out. */
export const canTick = (row: WikiRow) => row.state !== 'left-out';

/**
 * The pages a heading's box ticks: every page shown under it, the pages
 * listed under the heading and those found on them, each once, read before
 * or not, never one left out. Called with the heading as the filter shows
 * it, so with a filter on it ticks only what that filter shows.
 */
export function headingPages(group: WikiGroup): WikiRow[] {
  const seen = new Set<string>();
  return [...group.rows, ...group.found.flatMap((found) => found.pages)].filter((row) => {
    if (!canTick(row) || seen.has(row.key)) return false;
    seen.add(row.key);
    return true;
  });
}

/** How a heading's box shows: ticked when every page it ticks is, in between when some are. */
export function headingTick(
  pages: readonly WikiRow[],
  ticked: ReadonlySet<string>,
): { checked: boolean; indeterminate: boolean; disabled: boolean } {
  const some = pages.some((row) => ticked.has(row.key));
  const all = pages.length > 0 && pages.every((row) => ticked.has(row.key));
  return { checked: all, indeterminate: some && !all, disabled: pages.length === 0 };
}

/** Pages "Tick every page not read" ticks: of the contents, not read yet, not left out. */
export const unread = (row: WikiRow) => row.state === 'not-read' || row.state === 'failed';

/**
 * "About 9 minutes": how long reading `pages` takes, one at a time with the
 * pause: about 5 seconds a page fetched by the app, about 2 seconds a page
 * read in the window kept for a go (its shorter pause, `WINDOW_PAGE_PAUSE_MS`).
 */
export function readingTime(pages: number, inWindow = false): string {
  const seconds = pages * (inWindow ? 2 : 5);
  if (seconds < 60) return 'Less than a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return minutes === 1 ? 'About a minute' : `About ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return `About ${hours} hours`;
}

/** "Read today at 6:14 AM", "Read on 3 May 2026". */
export function readWhen(iso: string | null, now = new Date()): string {
  if (!iso) return 'Read';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'Read';
  const time = at.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return `Read today at ${time}`;
  const date = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `Read on ${date}`;
}
