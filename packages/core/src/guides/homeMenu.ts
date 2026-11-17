import type { GuideEntry } from '@atlas/schema';
import { guideFiling } from './pageFiling';
import { headingParents } from './pageTree';
import { sectionName } from './sections';

/**
 * A wiki's menu made from its home page: the headed blocks of the page's
 * main part, in its order, each with the pages it lists (its tiles, its
 * lists, a heading that is a link to a page), read from the home page's
 * Markdown alone (see `pageFiling.ts` for which links list a page).
 *
 * - A block is the part of the page under one heading, down to the next
 *   heading of the same level or higher; a heading of a lower level inside
 *   it is a block inside it. A heading that is one link to a page puts
 *   that page first in its block.
 * - A home page with no heading at all is one block: its pages are the top
 *   of the menu. What stands before the first heading of a page with
 *   headings (a welcome box) is no block.
 * - A home page left with one block (the others empty or left out) gives
 *   that block's pages and inner blocks as the top of the menu, with no
 *   section around them.
 * - Left out: a block that lists no page the caller keeps (`isPage`: a
 *   page of the wiki read so far, not about the wiki itself), a block of
 *   news (see {@link isNewsBlock}), and a block whose heading's words the
 *   caller leaves out; a block whose heading's words the caller keeps is
 *   never left out as news. A block left out takes its inner blocks with it.
 * - A page is listed once, in the first block that lists it (also when that
 *   block is left out: it is then among the pages nothing places).
 *
 * An importer writes the menu as the pack's sections (an importer knows the
 * side menu and which pages are about the wiki itself, which the pack does
 * not); the pages under each page are worked out by their links, as for
 * any page of the contents (see `pageTree.ts`).
 */

/** An entry of a menu made from a home page: a page, or a block with what it holds. */
export type HomeMenuEntry =
  | { kind: 'page'; id: string }
  | {
      kind: 'block';
      /** The heading's words. */
      title: string;
      /** The heading's section (see `sections.ts`): the home page opens there. */
      section: string;
      /** The page the heading is a link to, first of its entries when it is one to list; else null. */
      page: string | null;
      entries: HomeMenuEntry[];
    };

/** What {@link homeMenuOf} leaves out and keeps. */
export interface HomeMenuOptions {
  /** Whether a page is one to list (a page of the pack, not about the wiki itself). */
  isPage?: (id: string) => boolean;
  /** Headings whose blocks are left out, by their words (upper and lower case do not count). */
  leaveOut?: readonly string[];
  /** Headings whose blocks are kept whatever the rules on news say, by their words. */
  keep?: readonly string[];
}

/** A block of news has at least this many dated items or links leaving the wiki. */
export const NEWS_MIN_ITEMS = 2;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})(?:\s+|$)/;
const LIST_MARK = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
/** A link (not a picture) and its address: `[words](address`. */
const LINK = /(?<!!)\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)/g;
const MONTH =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
/**
 * A line that starts with a date (after a list mark or bold marks): `Aug 19,
 * 2026`, `19 August 2026`, `2026-08-19`, `19.08.2026`, `08/19/26`.
 */
const DATED = new RegExp(
  `^[\\s*_]*(?:(?:${MONTH})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\.?\\s+(?:${MONTH})\\.?,?\\s+\\d{4}|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[./]\\d{1,2}[./]\\d{2,4})\\b`,
  'iu',
);

/** What one heading's own part of a page holds, for {@link isNewsBlock}. */
export interface BlockText {
  /** Links to pages of the pack (by guide id). */
  pageLinks: number;
  /** Links that leave the pack: web addresses. */
  webLinks: number;
  /** Lines and list items that hold a link. */
  linkedLines: number;
  /** Of those, the ones that start with a date. */
  datedLines: number;
}

/**
 * Whether a block is news, by what its own part of the page holds: most of
 * its links leave the wiki, or most of its linked lines are dated items.
 */
export function isNewsBlock(text: BlockText): boolean {
  if (text.webLinks >= NEWS_MIN_ITEMS && text.webLinks > text.pageLinks) return true;
  return text.datedLines >= NEWS_MIN_ITEMS && text.datedLines * 2 >= text.linkedLines;
}

/**
 * The text of each heading's own part of a page (to the next heading of
 * any level), by heading, in order; null when the headings found differ
 * from those `pageFiling.ts` read (then nothing is taken for news).
 */
function blockTexts(body: string, headings: number): BlockText[] | null {
  const texts: BlockText[] = [];
  let at: BlockText | null = null;
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    if (fence !== null) {
      if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    const opens = FENCE.exec(line);
    if (opens) {
      fence = opens[1]!;
      continue;
    }
    if (HEADING.test(line)) {
      at = { pageLinks: 0, webLinks: 0, linkedLines: 0, datedLines: 0 };
      texts.push(at);
      continue;
    }
    if (!at) continue;
    let linked = false;
    LINK.lastIndex = 0;
    for (let match = LINK.exec(line); match; match = LINK.exec(line)) {
      const address = match[1]!;
      if (/^https?:/iu.test(address)) at.webLinks += 1;
      else if (address.includes(':guide:')) at.pageLinks += 1;
      else continue;
      linked = true;
    }
    if (!linked) continue;
    at.linkedLines += 1;
    if (DATED.test(line.replace(LIST_MARK, ''))) at.datedLines += 1;
  }
  return texts.length === headings ? texts : null;
}

const wordsKey = (words: string) => words.trim().replace(/\s+/gu, ' ').toLowerCase();

/** The menu a home page gives (see the top of this file), its top level in order. */
export function homeMenuOf(home: GuideEntry, options: HomeMenuOptions = {}): HomeMenuEntry[] {
  const isPage = (id: string) => id !== home.id && (options.isPage?.(id) ?? true);
  const filing = guideFiling(home);
  const headings = filing.headings ?? [];
  const listedUnder = filing.listedUnder ?? [];
  if (headings.length === 0) {
    return filing.listing.filter(isPage).map((id) => ({ kind: 'page', id }));
  }
  const left = new Set((options.leaveOut ?? []).map(wordsKey));
  const kept = new Set((options.keep ?? []).map(wordsKey));
  const texts = blockTexts(home.body, headings.length);
  // By heading, the pages it lists itself, in order: a heading's own page first.
  const pagesOf = headings.map((): string[] => []);
  const ownPage = new Map<string, number>();
  headings.forEach((heading, i) => {
    if (heading.guide !== null && !ownPage.has(heading.guide)) ownPage.set(heading.guide, i);
  });
  for (const [page, i] of ownPage) pagesOf[i]!.push(page);
  filing.listing.forEach((id, n) => {
    if (ownPage.has(id)) return;
    const under = listedUnder[n] ?? -1;
    if (under >= 0) pagesOf[under]!.push(id);
  });
  const parents = headingParents(headings);
  const children = headings.map((): number[] => []);
  const roots: number[] = [];
  parents.forEach((parent, i) => {
    if (parent < 0) roots.push(i);
    else children[parent]!.push(i);
  });
  const shown = new Set<string>();
  const blockOf = (i: number): HomeMenuEntry | null => {
    const heading = headings[i]!;
    const words = wordsKey(heading.words);
    if (left.has(words)) return null;
    if (!kept.has(words) && texts !== null && isNewsBlock(texts[i]!)) return null;
    const entries: HomeMenuEntry[] = [];
    for (const id of pagesOf[i]!) {
      if (!isPage(id) || shown.has(id)) continue;
      shown.add(id);
      entries.push({ kind: 'page', id });
    }
    for (const child of children[i]!) {
      const entry = blockOf(child);
      if (entry) entries.push(entry);
    }
    if (entries.length === 0) return null;
    const own = heading.guide !== null && entries[0]?.kind === 'page' ? entries[0].id : null;
    return {
      kind: 'block',
      title: heading.words.trim() || heading.section,
      section: heading.section || sectionName(heading.words),
      page: own === heading.guide ? own : null,
      entries,
    };
  };
  const top = roots.flatMap((i) => {
    const entry = blockOf(i);
    return entry ? [entry] : [];
  });
  const only = top.length === 1 ? top[0]! : null;
  return only?.kind === 'block' ? only.entries : top;
}
