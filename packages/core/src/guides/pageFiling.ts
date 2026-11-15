import type { GuideEntry } from '@atlas/schema';
import { guideLinks, guideLinksIn } from './pageTree';
import { headingNames } from './sections';

/**
 * Which links of a page list other pages, read from its Markdown: what
 * decides where the pages of a section placed by links go (see
 * `pageTree.ts`).
 *
 * A link is a *listing* link when it is what an entry of a list is about:
 *
 * - the main link of a list item: the item starts with it (after a
 *   picture, bold or italic marks), and the item is short;
 * - in a table, the main link of each line of a cell of the table's name
 *   column: a row is about its first cell, so the name column is the
 *   first column with content, past columns only of pictures (an icon,
 *   linked or not). When its cells are no links (words, numbers, a level),
 *   the table lists nothing, whatever later columns name: a weapons table
 *   files the weapon of each row, never the location a later column names,
 *   and an item's table of upgrades ("Level | Cost | Where") files nothing;
 * - a tile (an item of a list of tiles is a list item whose main link is
 *   its linked picture or its name);
 * - an index written without a list: a line of a paragraph (the whole
 *   paragraph, or one of its lines, split at hard line breaks and `<br>`)
 *   that is one link, after at most a picture or marks, and after it
 *   nothing, or a few words led by a dash, a colon or a bracket ("Gauntlet
 *   – a short weapon"), or at most two words that end no sentence;
 * - a run of links: a line (of a paragraph, a list item, or of a cell of
 *   the name column) of two links or more with nothing but separators
 *   between them (`·`, `•`, `|`, `/`, `,`, `;`, dashes, spaces);
 * - a heading that is one link and nothing else (`### [Heavy](…)`).
 *
 * Every other link is a *mention*: a link in a sentence or a quote; in a
 * heading with words beside it; in a box of facts; in hidden text
 * (`||…||`); in a list item, a line or a table cell that starts with words
 * before the link ("Drops from …", "See also: …"), or whose words run long
 * enough to read as prose; in a line of links with words between them, or
 * other separators (a trail of the way, "Home › Weapons › Sword"); in the
 * line right after a line that is only a picture (its caption); in
 * another column of a table. A mention never files a page.
 *
 * A *listing unit* is what lists a page: a table row whose name cell lists
 * one, a list item whose main link (or run of links) lists one, a tile, a
 * line of a paragraph and a heading that list one. Its other links (a
 * row's "found at" column, the location named in an item after its name)
 * describe the page it lists: they file nothing, and they do not count
 * against the page being a list page.
 *
 * A *list page* is a page that lists enough pages, and whose listing links
 * are a large share of the pages it lists or mentions outside its listing
 * units (see the constants below).
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
 * A list page lists at least this share of the pages it lists or mentions
 * outside its listing units (a link in a row, an item or a line that lists
 * a page describes that page, and is left out). An item page has a few
 * listing links of its own (a "See also" list) among many mentions (its
 * box, its sentences, a table of upgrades whose first column is a level),
 * and an article with one table about things of a type (a boss page with a
 * small table of what it drops, among long prose) lists a small part of
 * what it names: both stay below. An index of a type of thing lists most
 * of what it names outside its rows, its introduction of a few sentences
 * aside, however many locations and characters its rows name beside each
 * thing.
 */
export const LIST_PAGE_SHARE = 0.6;

/** The listing links of a page (see the top of this file). */
export interface PageFiling {
  /** The pages it lists, by guide id, in order, each once, never itself. */
  listing: readonly string[];
  /** How many pages it links to in any way, each once (see `guideLinksIn`). */
  linked: number;
  /**
   * How many pages it links to outside its listing units (a sentence, a
   * box, a table that lists nothing) and does not list, each once. For a
   * page that lists too few pages to be a list page: every page it links
   * to and does not list.
   */
  mentioned: number;
  /**
   * The headings of the page, in order (none when it is not read closely):
   * where its listed pages are listed, see {@link listedUnder}.
   */
  headings?: readonly ListingHeading[];
  /**
   * By listed page, as `listing` has them: the innermost heading it is
   * first listed under, by its index in `headings`; -1 for none. The
   * headings around that one are those before it of a lower level.
   */
  listedUnder?: readonly number[];
}

/** A heading of a page, as {@link PageFiling.headings} has it. */
export interface ListingHeading {
  /** 1 to 6, as `#` to `######`. */
  level: number;
  /** Its words, links by their words, marks left out. */
  words: string;
  /** Its section's name, as `sections.ts` names a heading: a link to it opens the page there. */
  section: string;
  /** The page it links to, when it is one link and nothing else (`### [Short blades](…)`). */
  guide: string | null;
}

/** Whether a page lists enough pages to be a list page (see the constants above). */
export function isListPage(filing: PageFiling): boolean {
  const listed = filing.listing.length;
  return listed >= LIST_PAGE_MIN_LISTED && listed >= LIST_PAGE_SHARE * (listed + filing.mentioned);
}

/** A guide id as a link's address, with or without `<…>`. */
const GUIDE_TARGET = /^<?([a-z0-9][a-z0-9-]*:guide:[A-Za-z0-9][A-Za-z0-9_.-]*)>?$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])(?:\s+|$)/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** The address of a link or a picture, with its title: `](game:guide:x "#drops")`. */
const ADDRESS = /\]\((?:<[^>]*>|[^()\s]*)(?:\s+"[^"]*")?\)/g;
const TABLE_ROW = /^\s*\|/;
const HEADING = /^\s{0,3}(#{1,6})(?:\s+|$)/;
const QUOTE = /^\s{0,3}>/;
/** Whether a line ends with a hard line break: two spaces or more, or a backslash. */
const hardBreak = (line: string) => line.endsWith('  ') || line.endsWith('\\');
/** What may stand between the links of a run: separators, spaces and marks. */
const RUN_SEPARATORS = /^[\s·•|/,;\-–—*_~]*$/u;
/** What may lead the words after a line's one link: a dash, a colon, a bracket. */
const LEADS_WORDS = /^[\s*_~]*[-–—:([]/u;
/** At most this many words after a line's one link, with no lead, end no sentence ("Cudgel Hammer"). */
const PLAIN_WORDS_AFTER = 2;
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

/** The guide links of a line that is a run of them (see the top of this file); null when it is none. */
function runOf(spans: readonly Span[], text: string): string[] | null {
  const ids: string[] = [];
  let at = 0;
  for (const span of spans) {
    const gap = text.slice(at, span.start);
    if (at === 0 ? !noWords(gap) : !RUN_SEPARATORS.test(gap)) return null;
    if (span.guide !== null) ids.push(span.guide);
    at = span.end;
  }
  if (!RUN_SEPARATORS.test(text.slice(at))) return null;
  return new Set(ids).size >= 2 ? ids : null;
}

/**
 * The listing links of one line of a paragraph or a heading (see the top
 * of this file): a run of links, or one link alone (in a heading, with
 * nothing after it).
 */
function lineListing(text: string, heading: boolean): string[] {
  // A line that starts with a word (most lines of a page) lists nothing.
  if (!text.includes(':guide:') || text.includes('||') || WORD_START.test(text)) return [];
  const spans = spansIn(text);
  const guides = spans.filter((span) => span.guide !== null);
  if (guides.length === 0) return [];
  if (new Set(guides.map((span) => span.guide)).size >= 2) {
    return heading ? [] : (runOf(spans, text) ?? []);
  }
  // One link (a tile's picture and name lead to the same page): only a picture or marks before it.
  const first = guides[0]!;
  const before = text.slice(0, first.start);
  if (!noWords(before) && !noWords(wordsOf(before))) return [];
  const after = text.slice(spans.at(-1)!.end);
  const words = wordsOf(after);
  if (noWords(words)) return [first.guide!];
  if (heading) return [];
  if (LEADS_WORDS.test(after)) {
    return wordsOf(text).length > LISTING_WORDS_MAX ? [] : [first.guide!];
  }
  const plain = words.split(' ');
  return plain.length <= PLAIN_WORDS_AFTER && !/[.!?]$/.test(words) ? [first.guide!] : [];
}

/** A line that starts with a picture, after marks. */
const PICTURE_START = /^[\s*_~]*!\[/;

/** Whether a line is only pictures (and marks): the line after it is their caption. */
const onlyPictures = (text: string) => {
  if (!PICTURE_START.test(text)) return false;
  const spans = spansIn(text);
  return spans.length > 0 && spans.every((span) => span.picture) && noWords(wordsOf(text));
};

/**
 * The listing links of a list item or a cell: a run of links, else its
 * main link (see {@link mainLink}).
 */
function itemListing(text: string, hiddenAtStart: boolean, escapedBars: boolean): string[] {
  // A run has two links or more: most items have one, and are read for it alone.
  const first = text.indexOf(':guide:');
  if (
    first >= 0 &&
    text.includes(':guide:', first + 7) &&
    !hiddenAtStart &&
    !text.includes(escapedBars ? '\\|\\|' : '||')
  ) {
    const spans = spansIn(text);
    if (spans.filter((span) => span.guide !== null).length >= 2) {
      const run = runOf(spans, text);
      if (run) return run;
    }
  }
  const id = mainLink(text, hiddenAtStart, escapedBars);
  return id === null ? [] : [id];
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

/** Whether a cell is empty, or only pictures (linked or not) and marks. */
function emptyOrPictures(cell: string): boolean {
  if (cell.replace(/<br>/g, '').trim() === '') return true;
  if (!cell.includes('![')) return false;
  if (!noWords(wordsOf(cell))) return false;
  const spans = spansIn(cell);
  return (
    spans.length > 0 &&
    spans.every(
      (span) =>
        span.picture || (span.inner.trimStart().startsWith('![') && noWords(wordsOf(span.inner))),
    )
  );
}

/**
 * The listing links of a table: the main links of each line of the cells
 * of its name column, the first column with more than pictures (none for
 * a box of facts). A table whose name column holds no links lists nothing:
 * when it is unsure what a table lists, the contents stays flat.
 *
 * By row under the heading row: what it lists.
 */
function tableListing(rows: readonly string[], hidden: boolean): (readonly string[])[] | null {
  if (hidden || !rows.some((row) => row.includes(':guide:'))) return null;
  if (rows[0]!.includes(BOX_MARK)) {
    const head = cellsOf(rows[0]!);
    if (head.length === 2 && head[1]!.trim() === BOX_MARK) return null;
  }
  // The rows under the heading row, by cell.
  const cells = rows.slice(1).map(cellsOf);
  const width = Math.max(0, ...cells.map((row) => row.length));
  let column = 0;
  while (column < width && cells.every((row) => emptyOrPictures(row[column] ?? ''))) column++;
  if (column >= width) return null;
  return cells.map((row) => {
    const cell = row[column];
    if (!cell?.includes(':guide:')) return NO_IDS;
    return cell.split('<br>').flatMap((line) => itemListing(line, false, true));
  });
}

const NO_IDS: readonly string[] = [];

/** A guide id in a Markdown link, read as `guideLinksIn` reads it. */
const GUIDE_LINK = /\]\(\s*<?([a-z0-9][a-z0-9-]*:guide:[A-Za-z0-9][A-Za-z0-9_.-]*)/g;

/** Adds `by` to the count of each link to a guide in a piece of Markdown, the page itself left out. */
function countLinks(
  text: string,
  self: string | undefined,
  counts: Map<string, number>,
  by: number,
): void {
  if (!text.includes(':guide:')) return;
  GUIDE_LINK.lastIndex = 0;
  for (let match = GUIDE_LINK.exec(text); match; match = GUIDE_LINK.exec(text)) {
    const id = match[1]!;
    if (id !== self) counts.set(id, (counts.get(id) ?? 0) + by);
  }
}

/**
 * The listing links of a page's Markdown, how many pages it links to, and
 * how many it mentions outside its listing units (see the top of this
 * file); `linked` when that is known already.
 */
export function pageFilingIn(
  body: string,
  self?: string,
  linked: number = guideLinksIn(body, self).length,
): PageFiling {
  if (linked === 0) return { listing: [], linked: 0, mentioned: 0 };
  const listing: string[] = [];
  const seen = new Set<string>();
  /** The headings read, and those open around the line read (innermost last), by index. */
  const headings: { level: number; words: string; guide: string | null }[] = [];
  const openHeadings: number[] = [];
  const listedUnder: number[] = [];
  const list = (id: string | null) => {
    if (id === null || id === self || seen.has(id)) return;
    seen.add(id);
    listing.push(id);
    listedUnder.push(openHeadings.at(-1) ?? -1);
  };
  /** The listing units read (a row, an item, a line, a heading), as written. */
  const units: string[] = [];
  /** Lists what a listing unit lists; a unit that lists nothing is no unit. */
  const listUnit = (ids: readonly string[], text: string) => {
    if (ids.length === 0) return;
    for (const id of ids) list(id);
    units.push(text);
  };
  const lines = body.split('\n');
  /** Inside `||…||` that runs over lines. */
  let hidden = false;
  const passBars = (text: string) => {
    if (text.includes('||') && barsIn(text, false).length % 2 === 1) hidden = !hidden;
  };
  /** Whether the line read now is outside hidden text (read anew: `passBars` changes it). */
  const shown = () => !hidden;
  let fence: string | null = null;
  /** The last paragraph line was only a picture: the next line is its caption. */
  let afterPicture = false;
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (fence !== null) {
      if (line.trimStart().startsWith(fence)) fence = null;
      i++;
      continue;
    }
    const opens = FENCE.exec(line);
    if (opens) {
      afterPicture = false;
      fence = opens[1]!;
      i++;
      continue;
    }
    // A table: a row, its line of dashes, and the rows after.
    if (TABLE_ROW.test(line) && DELIMITER_ROW.test(lines[i + 1] ?? '')) {
      const rows = [line];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW.test(lines[j]!)) rows.push(lines[j++]!);
      const byRow = tableListing(rows, hidden);
      if (byRow) {
        byRow.forEach((ids, at) => {
          listUnit(ids, rows[at + 1]!);
        });
      }
      afterPicture = false;
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
        // Lines that continue the item: not blank, not an item, a heading, a table or code.
        while (
          j < lines.length &&
          lines[j]!.trim() !== '' &&
          !LIST_ITEM.test(lines[j]!) &&
          !HEADING.test(lines[j]!) &&
          !FENCE.test(lines[j]!) &&
          !TABLE_ROW.test(lines[j]!)
        ) {
          text += ` ${lines[j]!.trim()}`;
          j++;
        }
        listUnit(itemListing(text, hidden, false), text);
        passBars(text);
        // A blank line between items keeps the list going.
        let next = j;
        while (next < lines.length && lines[next]!.trim() === '') next++;
        if (next > j && next < lines.length && LIST_ITEM.test(lines[next]!)) j = next;
      }
      afterPicture = false;
      i = j;
      continue;
    }
    // A heading: one link alone in it is listed.
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      while (openHeadings.length > 0 && headings[openHeadings.at(-1)!]!.level >= level) {
        openHeadings.pop();
      }
      const text = line.slice(heading[0].length).replace(/\s+#+\s*$/, '');
      // A heading that is one link lists that page, under the headings around it.
      const ids = shown() ? lineListing(text, true) : [];
      listUnit(ids, text);
      const guide = ids.length === 1 && ids[0] !== self ? ids[0]! : null;
      openHeadings.push(headings.length);
      headings.push({ level, words: wordsOf(text), guide });
      passBars(line);
      afterPicture = false;
      i++;
      continue;
    }
    // A paragraph: its lines, split at hard line breaks and `<br>`.
    if (line.trim() !== '' && !QUOTE.test(line)) {
      let j = i;
      let text = '';
      const pieces: string[] = [];
      while (j < lines.length) {
        const next = lines[j]!;
        if (
          next.trim() === '' ||
          (j > i &&
            (HEADING.test(next) ||
              LIST_ITEM.test(next) ||
              FENCE.test(next) ||
              TABLE_ROW.test(next) ||
              QUOTE.test(next)))
        ) {
          break;
        }
        text += (text ? ' ' : '') + next.trim().replace(/\\$/, '');
        if (hardBreak(next)) {
          pieces.push(text);
          text = '';
        }
        j++;
      }
      if (text) pieces.push(text);
      for (const piece of pieces.flatMap((piece) => piece.split('<br>'))) {
        if (shown() && !afterPicture) listUnit(lineListing(piece, false), piece);
        afterPicture = onlyPictures(piece);
        passBars(piece);
      }
      i = j;
      continue;
    }
    // Anything else (a quote, a blank line): mentions only.
    passBars(line);
    if (line.trim() !== '') afterPicture = false;
    i++;
  }
  const names = headingNames(headings.map((heading) => heading.words));
  return {
    listing,
    linked,
    mentioned: mentionedOutside(body, self, linked, listing, seen, units),
    headings: headings.map((heading, i) => ({ ...heading, section: names[i]! })),
    listedUnder,
  };
}

/**
 * How many pages a page links to outside its listing units, and does not
 * list: each link of the page counted, less those of its listing units.
 * A page that lists too few pages is no list page, whatever it mentions:
 * then every page it links to and does not list is counted.
 */
function mentionedOutside(
  body: string,
  self: string | undefined,
  linked: number,
  listing: readonly string[],
  listed: ReadonlySet<string>,
  units: readonly string[],
): number {
  if (listing.length < LIST_PAGE_MIN_LISTED) return Math.max(0, linked - listing.length);
  const counts = new Map<string, number>();
  countLinks(body, self, counts, 1);
  for (const unit of units) countLinks(unit, self, counts, -1);
  let mentioned = 0;
  for (const [id, count] of counts) if (count > 0 && !listed.has(id)) mentioned++;
  return mentioned;
}

/**
 * Whether a page may be a list page, by a quick look at its lines: a line
 * that starts with a word lists no page up to a `<br>` (it is a sentence,
 * or a list item, a line or a heading that starts with words), and any
 * other line (or the rest of one after a `<br>`) lists at most the pages
 * it links to. A line that starts with a word right after a
 * blank line (or first in the page) opens a paragraph: its links, up to a
 * `<br>`, are outside any listing unit, so the pages it names are listed
 * or mentioned. A page whose other lines hold too few links to list enough
 * of those pages is no list page, and need not be read closely (most pages
 * of a wiki).
 */
export function mayBeListPage(body: string, linked: number, self?: string): boolean {
  if (linked < LIST_PAGE_MIN_LISTED) return false;
  // Never more pages are named outside listing units than are linked: as many links surely do.
  const surely = Math.max(LIST_PAGE_MIN_LISTED, LIST_PAGE_SHARE * linked);
  let links = 0;
  /** The pages named in lines that open a paragraph. */
  const outside = new Set<string>();
  /** The next `<br>` from the line read: the lines are read in order. */
  let nextBreak = -1;
  // The next link to a guide, and the lines before it skipped at once.
  let link = body.indexOf(':guide:');
  while (link >= 0) {
    const start = body.lastIndexOf('\n', link) + 1;
    let end = body.indexOf('\n', link);
    if (end < 0) end = body.length;
    let at = start;
    while (body[at] === ' ' || body[at] === '\t') at++;
    // A line that starts with a word may list after a `<br>`, as a line of its own.
    let from = link;
    if (WORD_START.test(body[at] ?? '')) {
      if (nextBreak !== Infinity && nextBreak < at) {
        nextBreak = body.indexOf('<br>', at);
        if (nextBreak < 0) nextBreak = Infinity;
      }
      const head = Math.min(nextBreak, end);
      if (start === 0 || body.slice(body.lastIndexOf('\n', start - 2) + 1, start).trim() === '') {
        for (const id of guideLinksIn(body.slice(at, head), self)) outside.add(id);
      }
      from = head === end ? -1 : body.indexOf(':guide:', head);
    }
    for (let found = from; found >= 0 && found < end; found = body.indexOf(':guide:', found + 7)) {
      if (++links >= surely) return true;
    }
    link = body.indexOf(':guide:', end);
  }
  return links >= LIST_PAGE_MIN_LISTED && links >= LIST_PAGE_SHARE * outside.size;
}

/** A letter: a line that starts with one starts with a word. */
const WORD_START = /^\p{L}/u;

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
  if (onlyListPage && !mayBeListPage(guide.body, linked, guide.id)) {
    filing = { listing: NO_LISTING, linked, mentioned: linked };
    noListOfGuide.set(guide, filing);
    return filing;
  }
  filing = pageFilingIn(guide.body, guide.id, linked);
  filingOfGuide.set(guide, filing);
  return filing;
}
