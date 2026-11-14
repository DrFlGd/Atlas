import type { GuideEntry } from '@atlas/schema';
import { guideLinks, guideLinksIn } from './pageTree';

/**
 * Which links of a page list other pages, read from its Markdown: what
 * decides where the pages of a section placed by links go (see
 * `pageTree.ts`).
 *
 * A link is a *listing* link when it is what an entry of a list is about:
 *
 * - the main link of a list item: the item starts with it (after a
 *   picture, bold or italic marks), and the item is short;
 * - in a table, the main link of a cell of the table's name column: the
 *   column whose cells start with links to the most different pages (of
 *   two such columns, the one further left), so a weapons table files the
 *   weapon of each row, not the location a later column names;
 * - a tile (an item of a list of tiles is a list item whose main link is
 *   its linked picture or its name).
 *
 * Every other link is a *mention*: a link in a sentence, a heading or a
 * quote; in a box of facts; in hidden text (`||…||`); in a list item or a
 * table cell that starts with words before the link ("Drops from …"), or
 * whose words run long enough to read as prose; in another column of a
 * table. A mention never files a page.
 *
 * A *list page* is a page that lists enough pages, and whose listing links
 * are a large share of the pages it links to (see the constants below).
 */

/**
 * A list item or a table cell holding more words than this (in characters,
 * links counted by their words, link addresses and marks left out) reads
 * as prose: its links are mentions. A name and a few words of what it is
 * ("Rusty blade: a short sword with a long reach.") fit well within it.
 */
export const LISTING_WORDS_MAX = 100;

/**
 * A list page lists at least this many pages. Two links in a list ("See
 * also") are no index; three is the least an index of a type of thing has.
 */
export const LIST_PAGE_MIN_LISTED = 3;

/**
 * A list page lists at least this share of the pages it links to. An item
 * page has a few listing links of its own (a "See also" list, a list of
 * upgrades) among many mentions (its box, its sentences), and an article
 * with one table about things of a type (a page of the game's rules with a
 * table of each location's rewards) lists about half of what it links to:
 * both stay below. An index of a type of thing lists most of what it links
 * to, its introduction of a few sentences aside.
 */
export const LIST_PAGE_SHARE = 0.6;

/** The listing links of a page (see the top of this file). */
export interface PageFiling {
  /** The pages it lists, by guide id, in order, each once, never itself. */
  listing: readonly string[];
  /** How many pages it links to in any way, each once (see `guideLinksIn`). */
  linked: number;
}

/** Whether a page lists enough pages to be a list page (see the constants above). */
export function isListPage(filing: PageFiling): boolean {
  return (
    filing.listing.length >= LIST_PAGE_MIN_LISTED &&
    filing.listing.length >= LIST_PAGE_SHARE * filing.linked
  );
}

/** A guide id as a link's address, with or without `<…>`. */
const GUIDE_TARGET = /^<?([a-z0-9][a-z0-9-]*:guide:[A-Za-z0-9][A-Za-z0-9_.-]*)>?$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])(?:\s+|$)/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** The address of a link or a picture, with its title: `](game:guide:x "#drops")`. */
const ADDRESS = /\]\((?:<[^>]*>|[^()\s]*)(?:\s+"[^"]*")?\)/g;
const TABLE_ROW = /^\s*\|/;
const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const BOX_MARK = '{box}';

/** A link or a picture in a line of Markdown: where it is, and the guide it leads to. */
interface Span {
  start: number;
  end: number;
  /** The guide id it leads to; null for a picture or any other address. */
  guide: string | null;
  picture: boolean;
  /** Its words (or a picture's text), as written. */
  inner: string;
}

/** Where a run of backticks that opens code at `at` is closed; -1 when it is not. */
function codeEnd(text: string, at: number): number {
  let run = 0;
  while (text[at + run] === '`') run++;
  const close = text.indexOf('`'.repeat(run), at + run);
  return close < 0 ? -1 : close + run;
}

/** Where the `]` that closes the `[` at `open` is; -1 when none does. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return i;
  }
  return -1;
}

/** The address of a link from `(` at `at`, and where the link ends; null when it is no link. */
function destination(text: string, at: number): { target: string; end: number } | null {
  let i = at + 1;
  while (text[i] === ' ') i++;
  let target: string;
  if (text[i] === '<') {
    const close = text.indexOf('>', i);
    if (close < 0) return null;
    target = text.slice(i + 1, close);
    i = close + 1;
  } else {
    const from = i;
    let depth = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') i++;
      else if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (c === ' ' || c === '\t') break;
    }
    target = text.slice(from, i);
  }
  while (text[i] === ' ') i++;
  const quote = text[i];
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, i + 1);
    if (close < 0) return null;
    i = close + 1;
    while (text[i] === ' ') i++;
  }
  return text[i] === ')' ? { target, end: i + 1 } : null;
}

/** What may start a link, or keep one from starting: a bracket, an escape, code. */
const SPAN_START = /[[\\`]/g;

/** The links and pictures of a line, outermost only, in order; with `untilGuide`, up to the first link to a guide. */
function spansIn(text: string, untilGuide = false): Span[] {
  const spans: Span[] = [];
  if (!text.includes('](')) return spans;
  SPAN_START.lastIndex = 0;
  for (let found = SPAN_START.exec(text); found; found = SPAN_START.exec(text)) {
    const i = found.index;
    const c = text[i];
    if (c === '\\') {
      SPAN_START.lastIndex = i + 2;
      continue;
    }
    if (c === '`') {
      const end = codeEnd(text, i);
      if (end > 0) SPAN_START.lastIndex = end;
      continue;
    }
    const picture = i > 0 && text[i - 1] === '!' && text[i - 2] !== '\\';
    const close = closingBracket(text, i);
    if (close < 0 || text[close + 1] !== '(') continue;
    const to = destination(text, close + 1);
    if (!to) continue;
    const guide = picture ? null : (GUIDE_TARGET.exec(to.target)?.[1] ?? null);
    const start = picture ? i - 1 : i;
    spans.push({ start, end: to.end, guide, picture, inner: text.slice(i + 1, close) });
    if (untilGuide && guide !== null) break;
    SPAN_START.lastIndex = to.end;
  }
  return spans;
}

/** The words of a piece of Markdown as read: links by their words, pictures and marks left out. */
function wordsOf(text: string): string {
  const spans = spansIn(text);
  let out = '';
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start);
    if (!span.picture) out += wordsOf(span.inner);
    at = span.end;
  }
  out += text.slice(at);
  return out
    .replace(/\{color=#[0-9a-fA-F]{3,6}\}/g, '')
    .replace(/<br>/g, ' ')
    .replace(/\\?\|\\?\|/g, '')
    .replace(/[*_~^`[\]\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether text holds no words: only marks, spaces and punctuation. */
const noWords = (text: string) => !/[\p{L}\p{N}]/u.test(text);

/** The positions of the hidden-text bars of a line: `||`, or `\|\|` in a table cell. */
function barsIn(text: string, escaped: boolean): number[] {
  const at: number[] = [];
  const bar = escaped ? '\\|\\|' : '||';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '`') {
      const end = codeEnd(text, i);
      if (end > 0) i = end - 1;
      continue;
    }
    if (text.startsWith(bar, i)) {
      at.push(i);
      i += bar.length - 1;
    } else if (c === '\\') i++;
  }
  return at;
}

/**
 * The guide a list item or a cell is about: its first link, when only a
 * picture or marks stand before it, it is not hidden, and the words of the
 * whole are short; null otherwise.
 */
function mainLink(text: string, hiddenAtStart: boolean, escapedBars: boolean): string | null {
  if (!text.includes(':guide:')) return null;
  const first = spansIn(text, true).find((span) => span.guide !== null);
  if (!first) return null;
  const before = text.slice(0, first.start);
  if (!noWords(before) && !noWords(wordsOf(before))) return null;
  const bars = text.includes(escapedBars ? '\\|\\|' : '||')
    ? barsIn(text, escapedBars).filter((at) => at < first.start).length
    : 0;
  if (hiddenAtStart !== (bars % 2 === 1)) return null;
  // The words are never longer than the text without the links' addresses.
  if (
    text.length > LISTING_WORDS_MAX &&
    text.replace(ADDRESS, ']').length > LISTING_WORDS_MAX &&
    wordsOf(text).length > LISTING_WORDS_MAX
  ) {
    return null;
  }
  return first.guide;
}

/** The cells of a table row, split at bars that are not escaped or in code. */
function cellsOf(row: string): string[] {
  let text = row.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  if (!text.includes('\\') && !text.includes('`')) return text.split('|');
  const cells: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '`') {
      const end = codeEnd(text, i);
      if (end > 0) i = end - 1;
    } else if (c === '|') {
      cells.push(text.slice(from, i));
      from = i + 1;
    }
  }
  cells.push(text.slice(from));
  return cells;
}

/** The listing links of a table: the main links of its name column (none for a box of facts). */
function tableListing(rows: readonly string[], hidden: boolean): string[] {
  if (hidden) return [];
  if (rows[0]!.includes(BOX_MARK)) {
    const head = cellsOf(rows[0]!);
    if (head.length === 2 && head[1]!.trim() === BOX_MARK) return [];
  }
  const leads = rows.map((row) =>
    row.includes(':guide:') ? cellsOf(row).map((cell) => mainLink(cell, false, true)) : [],
  );
  const width = Math.max(0, ...leads.map((row) => row.length));
  let column = -1;
  let most = 0;
  for (let c = 0; c < width; c++) {
    const different = new Set(leads.map((row) => row[c]).filter((id) => id != null)).size;
    if (different > most) {
      most = different;
      column = c;
    }
  }
  return column < 0 ? [] : leads.flatMap((row) => row[column] ?? []);
}

/**
 * The listing links of a page's Markdown, and how many pages it links to
 * (see the top of this file); `linked` when that is known already.
 */
export function pageFilingIn(
  body: string,
  self?: string,
  linked: number = guideLinksIn(body, self).length,
): PageFiling {
  if (linked === 0) return { listing: [], linked: 0 };
  const listing: string[] = [];
  const seen = new Set<string>();
  const list = (id: string | null) => {
    if (id === null || id === self || seen.has(id)) return;
    seen.add(id);
    listing.push(id);
  };
  const lines = body.split('\n');
  /** Inside `||…||` that runs over lines. */
  let hidden = false;
  const passBars = (text: string) => {
    if (text.includes('||') && barsIn(text, false).length % 2 === 1) hidden = !hidden;
  };
  let fence: string | null = null;
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (fence !== null) {
      if (line.trimStart().startsWith(fence)) fence = null;
      i++;
      continue;
    }
    const opens = FENCE.exec(line);
    if (opens) {
      fence = opens[1]!;
      i++;
      continue;
    }
    // A table: a row, its line of dashes, and the rows after.
    if (TABLE_ROW.test(line) && DELIMITER_ROW.test(lines[i + 1] ?? '')) {
      const rows = [line];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW.test(lines[j]!)) rows.push(lines[j++]!);
      for (const id of tableListing(rows, hidden)) list(id);
      i = j;
      continue;
    }
    // A list: its items, each with the lines that continue it.
    if (LIST_ITEM.test(line)) {
      let j = i;
      while (j < lines.length) {
        const start = LIST_ITEM.exec(lines[j]!);
        if (!start) break;
        let text = lines[j]!.slice(start[0].length);
        j++;
        // Lines that continue the item: not blank, not an item, not a table or code.
        while (
          j < lines.length &&
          lines[j]!.trim() !== '' &&
          !LIST_ITEM.test(lines[j]!) &&
          !FENCE.test(lines[j]!) &&
          !TABLE_ROW.test(lines[j]!)
        ) {
          text += ` ${lines[j]!.trim()}`;
          j++;
        }
        list(mainLink(text, hidden, false));
        passBars(text);
        // A blank line between items keeps the list going.
        let next = j;
        while (next < lines.length && lines[next]!.trim() === '') next++;
        if (next > j && next < lines.length && LIST_ITEM.test(lines[next]!)) j = next;
      }
      i = j;
      continue;
    }
    // Anything else (a paragraph, a heading, a quote): mentions only.
    passBars(line);
    i++;
  }
  return { listing, linked };
}

/**
 * Whether a page may be a list page, by a quick look at its lines: a page
 * lists at most one page in each line that starts a list item or a table
 * row with a link, so a page with too few such lines for its links is no
 * list page, and need not be read closely (most pages of a wiki).
 */
export function mayBeListPage(body: string, linked: number): boolean {
  if (linked < LIST_PAGE_MIN_LISTED) return false;
  const least = Math.max(LIST_PAGE_MIN_LISTED, LIST_PAGE_SHARE * linked);
  let lines = 0;
  // The next link to a guide, and the lines before it skipped at once.
  let link = body.indexOf(':guide:');
  while (link >= 0) {
    const start = body.lastIndexOf('\n', link) + 1;
    let at = start;
    while (body[at] === ' ' || body[at] === '\t') at++;
    const c = body.charCodeAt(at);
    // `|`, `-`, `*`, `+`, or a digit.
    if (c === 0x7c || c === 0x2d || c === 0x2a || c === 0x2b || (c >= 0x30 && c <= 0x39)) {
      if (LIST_START.test(body.slice(at, at + 12)) && ++lines >= least) return true;
    }
    const end = body.indexOf('\n', link);
    if (end < 0) break;
    link = body.indexOf(':guide:', end);
  }
  return false;
}

/** The start of a list item or a table row, at the first character of a line that is not a space. */
const LIST_START = /^(?:\||[-*+][ \t]|\d{1,9}[.)][ \t])/;

/** The listing links of each guide object, read once: a guide is never changed in place. */
const filingOfGuide = new WeakMap<GuideEntry, PageFiling>();
/** The guides found to be no list page at a quick look, with how many pages each links to. */
const noListOfGuide = new WeakMap<GuideEntry, PageFiling>();
const NO_LISTING: readonly string[] = [];

/**
 * The listing links of a guide (see {@link pageFilingIn}), read once per
 * guide. With `onlyListPage`, a page that cannot be a list page (see
 * {@link mayBeListPage}) is not read closely: its listing is then empty.
 */
export function guideFiling(guide: GuideEntry, onlyListPage = false): PageFiling {
  let filing = filingOfGuide.get(guide) ?? (onlyListPage ? noListOfGuide.get(guide) : undefined);
  if (filing) return filing;
  const linked = guideLinks(guide).length;
  if (onlyListPage && !mayBeListPage(guide.body, linked)) {
    filing = { listing: NO_LISTING, linked };
    noListOfGuide.set(guide, filing);
    return filing;
  }
  filing = pageFilingIn(guide.body, guide.id, linked);
  filingOfGuide.set(guide, filing);
  return filing;
}
