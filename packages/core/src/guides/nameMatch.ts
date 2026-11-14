import { parseId } from '@atlas/schema';
import { baseName, isStopWord, stemWord, tidyNameWords } from './linking';

/**
 * Finding the pages whose names fit a name best, with room for how people
 * and wikis write names: a location's name ("Iron-bound chest 3") against
 * the titles of the pages a game has saved ("Ironbound chests").
 *
 * Names are tidied as `linking.ts` tidies them: case, accents, punctuation,
 * a leading article, simple plurals, a note in brackets at the end and a
 * number at the end do not count. Then:
 *
 * - Words may come in any order.
 * - A word may be misspelt: by no letter in words of up to 3 letters, one
 *   in words of 4 to 7, two in words of 8 or more; two neighbouring
 *   letters swapped count as one. A word with a digit is never misspelt.
 * - Words written together or apart are the same: "great sword" is
 *   "greatsword".
 * - Rarer words weigh more than common ones, by how many titles have them,
 *   so "Frost wyrm" fits "Wyrms" better than "Frost".
 * - A page's other names (a name a site forwarded to it) count as its
 *   name, each as a title of its own.
 *
 * A page fits by how much of the name its title holds and how much of its
 * title the name holds, both by weight; a misspelt word takes a little off.
 * The titles are indexed by word once, so a search looks up its words and
 * their near spellings, never every page; pages that only mention the name
 * in their text are found elsewhere (see `GuideSearch`) and put after every
 * title (see {@link withMentions}).
 *
 * Nothing here knows a site, a wiki or a game: only words.
 */

/** A page to find by name: its id, its title and its other names. */
export interface NamedPage {
  id: string;
  title: string;
  otherNames?: readonly string[];
}

/** How a page was found: by its title, another of its names, or its text. */
export type NameVia = 'title' | 'other-name' | 'text';

/** A page that fits a name, and how well. */
export interface NameHit {
  id: string;
  /** From 0 (nothing in common) to 1 (the same name). */
  score: number;
  /** The same name, word for word, every word spelt alike. */
  exact: boolean;
  via: NameVia;
  /** The title or other name that fits (the page's title for a mention). */
  name: string;
}

/**
 * The most letters a word may be misspelt by, for a word this long. Two
 * words written together go by the shorter of them (`shortest`), so a short
 * word is never misspelt by being written with another.
 */
export function letterSlack(word: string, shortest = word.length): number {
  if (/\d/u.test(word)) return 0;
  const length = Math.min(word.length, shortest);
  return length <= 3 ? 0 : length <= 7 ? 1 : 2;
}

/**
 * How many letters apart two words are: one changed, added or left out,
 * or two neighbours swapped, each count one. Stops counting past `most`
 * and then gives `most + 1`.
 */
export function lettersApart(a: string, b: string, most = Infinity): number {
  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > most) return most + 1;
  // Three rows of the table, used in turn.
  let before = new Int32Array(m + 1);
  let previous = new Int32Array(m + 1);
  let row = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) previous[j] = j;
  for (let i = 1; i <= n; i++) {
    row[0] = i;
    let best = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const bj = b.charCodeAt(j - 1);
      let value = Math.min(
        previous[j]! + 1,
        row[j - 1]! + 1,
        previous[j - 1]! + (ai === bj ? 0 : 1),
      );
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bj) {
        value = Math.min(value, before[j - 2]! + 1);
      }
      row[j] = value;
      if (value < best) best = value;
    }
    if (best > most) return most + 1;
    const spare = before;
    before = previous;
    previous = row;
    row = spare;
  }
  const distance = previous[m]!;
  return distance > most ? most + 1 : distance;
}

/** The letters a word has, as bits: two words a few letters apart have nearly the same. */
function letterBits(word: string): number {
  let bits = 0;
  for (let i = 0; i < word.length; i++) bits |= 1 << (word.charCodeAt(i) & 31);
  return bits;
}

/** How many bits are set. */
function bitCount(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * A name as words to compare: tidied (see the top of this file), without a
 * number at its end, each word singular. Words like "of" and "the" are left
 * out when there are others.
 */
export function nameTokens(text: string): { words: string[]; raw: string[] } {
  const unbracketed = text.replace(/\s*\([^()]*\)\s*$/u, '').trim() || text;
  const raw = tidyNameWords(baseName(unbracketed));
  const kept = raw.filter((word) => !isStopWord(word));
  const words = kept.length > 0 ? kept : raw;
  return { words: words.map(stemWord), raw: words };
}

/**
 * Another name of a page, from its id: the words of the local id of a
 * guide id kept as another name of the page (a pack's `idMigrations`),
 * which a reader makes from the address a site forwarded. Null when it has
 * no words.
 */
export function otherNameOfId(id: string): string | null {
  const local = parseId(id)?.localId;
  if (!local) return null;
  const words = local.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length > 0 ? words.join(' ') : null;
}

/** One way to read a run of a name's words: one word, or two written together. */
interface Token {
  text: string;
  /** How many letters its shortest word has. */
  shortest: number;
  /** The first word it stands for, and how many (1 or 2). */
  at: number;
  span: 1 | 2;
}

/** The tokens of a name's words: each word, and each two neighbours written together. */
function tokensOf(words: readonly string[], raw: readonly string[]): Token[] {
  const tokens: Token[] = words.map((text, at) => ({ text, shortest: text.length, at, span: 1 }));
  for (let at = 0; at + 1 < raw.length; at++) {
    tokens.push({
      text: stemWord(`${raw[at]!}${raw[at + 1]!}`),
      shortest: Math.min(raw[at]!.length, raw[at + 1]!.length),
      at,
      span: 2,
    });
  }
  return tokens;
}

/** A title or other name, indexed. */
interface Entry {
  page: number;
  via: 'title' | 'other-name';
  name: string;
  words: string[];
  weights: number[];
  total: number;
}

/** Where a token of an entry is. */
interface Posting {
  entry: number;
  at: number;
  span: 1 | 2;
}

/** A token of the name met in an entry. */
interface Meeting {
  queryAt: number;
  querySpan: 1 | 2;
  entryAt: number;
  entrySpan: 1 | 2;
  apart: number;
}

/** What a misspelt word takes off a page's fit, for each letter. */
const PER_LETTER = 0.92;
/** A page fits a name at least this well to be found. */
const LEAST_SCORE = 0.2;

/**
 * The titles (and other names) of a game's pages, indexed by word, to find
 * the pages that fit a name (see the top of this file). Made once per set
 * of pages; a search costs about the number of words the titles have, not
 * the number of pages.
 */
export class PageNameIndex {
  readonly size: number;
  private readonly pages: readonly NamedPage[];
  private readonly entries: Entry[] = [];
  /** By token, where it is. */
  private readonly postings = new Map<string, Posting[]>();
  /** Every token, by its length in letters, with its letters as bits, to find near spellings. */
  private readonly byLength = new Map<
    number,
    { texts: string[]; bits: number[]; slacks: number[] }
  >();
  /** Where each token is in `byLength`, to let it be misspelt as much as its words allow. */
  private readonly slotOf = new Map<string, number>();
  /** How many entries have each word. */
  private readonly counts = new Map<string, number>();
  /** How many titles and other names there are, for the weights. */
  private readonly named: number;
  private readonly rarest: number;
  private readonly titles = new Map<string, string>();

  constructor(pages: readonly NamedPage[]) {
    this.pages = pages;
    this.size = pages.length;
    for (const page of pages) if (!this.titles.has(page.id)) this.titles.set(page.id, page.title);
    const tidied: {
      page: number;
      via: Entry['via'];
      name: string;
      words: string[];
      raw: string[];
    }[] = [];
    pages.forEach((page, index) => {
      const names = new Set<string>();
      const add = (name: string, via: Entry['via']) => {
        const { words, raw } = nameTokens(name);
        const key = words.join(' ');
        if (words.length === 0 || names.has(key)) return;
        names.add(key);
        tidied.push({ page: index, via, name, words, raw });
      };
      add(page.title, 'title');
      for (const other of page.otherNames ?? []) add(other, 'other-name');
    });
    for (const { words } of tidied) {
      for (const word of new Set(words)) this.counts.set(word, (this.counts.get(word) ?? 0) + 1);
    }
    this.named = Math.max(1, tidied.length);
    this.rarest = Math.log(1 + this.named);
    for (const { page, via, name, words, raw } of tidied) {
      const weights = words.map((word) => this.weightOf(word));
      const entry = this.entries.length;
      this.entries.push({
        page,
        via,
        name,
        words,
        weights,
        total: weights.reduce((sum, w) => sum + w, 0),
      });
      for (const token of tokensOf(words, raw)) {
        let list = this.postings.get(token.text);
        const length = token.text.length;
        let same = this.byLength.get(length);
        if (!same) {
          same = { texts: [], bits: [], slacks: [] };
          this.byLength.set(length, same);
        }
        const slack = letterSlack(token.text, token.shortest);
        if (!list) {
          list = [];
          this.postings.set(token.text, list);
          this.slotOf.set(token.text, same.texts.length);
          same.texts.push(token.text);
          same.bits.push(letterBits(token.text));
          same.slacks.push(slack);
        } else {
          // The same letters as one word and as two: the more it may be misspelt.
          const slot = this.slotOf.get(token.text)!;
          same.slacks[slot] = Math.max(same.slacks[slot]!, slack);
        }
        list.push({ entry, at: token.at, span: token.span });
      }
    }
  }

  /** How much a word weighs: more the fewer titles have it. */
  private weightOf(word: string): number {
    const count = this.counts.get(word);
    return count === undefined ? this.rarest : Math.log(1 + this.named / count);
  }

  /** The tokens of the titles a token of the name may be, and how far apart. */
  private near(token: string, shortest = token.length): { text: string; apart: number }[] {
    const slack = letterSlack(token, shortest);
    const found: { text: string; apart: number }[] = [];
    if (this.postings.has(token)) found.push({ text: token, apart: 0 });
    if (slack === 0) return found;
    const length = token.length;
    const bits = letterBits(token);
    for (let other = length - slack; other <= length + slack; other++) {
      const same = this.byLength.get(other);
      if (!same) continue;
      for (let i = 0; i < same.texts.length; i++) {
        // Each letter changed changes at most two of the letters a word has.
        if (bitCount(bits ^ same.bits[i]!) > 2 * slack) continue;
        const text = same.texts[i]!;
        if (text === token) continue;
        // The shorter word says how far apart they may be.
        const most = Math.min(slack, same.slacks[i]!);
        if (most === 0) continue;
        const apart = lettersApart(token, text, most);
        if (apart <= most) found.push({ text, apart });
      }
    }
    return found;
  }

  /** The pages whose title or other names fit a name, best first; at most `limit`. */
  find(name: string, limit = 20): NameHit[] {
    const { words, raw } = nameTokens(name);
    if (words.length === 0 || limit <= 0) return [];
    // The weight of each word of the name, from the titles: its own, else its nearest spelling's.
    const queryWeights = words.map((word) => {
      if (this.counts.has(word)) return this.weightOf(word);
      const near = this.near(word).sort((a, b) => a.apart - b.apart)[0];
      return near ? this.weightOf(near.text) : this.rarest;
    });
    const queryTotal = queryWeights.reduce((sum, w) => sum + w, 0);

    const meetings = new Map<number, Meeting[]>();
    for (const token of tokensOf(words, raw)) {
      for (const { text, apart } of this.near(token.text, token.shortest)) {
        for (const posting of this.postings.get(text) ?? []) {
          const meeting: Meeting = {
            queryAt: token.at,
            querySpan: token.span,
            entryAt: posting.at,
            entrySpan: posting.span,
            apart,
          };
          const list = meetings.get(posting.entry);
          if (list) list.push(meeting);
          else meetings.set(posting.entry, [meeting]);
        }
      }
    }

    const best = new Map<number, NameHit>();
    for (const [index, list] of meetings) {
      const entry = this.entries[index]!;
      const hit = this.fit(entry, list, queryWeights, queryTotal, words.length);
      if (!hit || hit.score < LEAST_SCORE) continue;
      const was = best.get(entry.page);
      if (!was || hit.score > was.score || (hit.score === was.score && hit.via === 'title')) {
        best.set(entry.page, hit);
      }
    }
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    return [...best.values()]
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.exact) - Number(a.exact) ||
          collator.compare(this.titleOf(a.id), this.titleOf(b.id)),
      )
      .slice(0, limit);
  }

  private titleOf(id: string): string {
    return this.titles.get(id) ?? '';
  }

  /**
   * How well an entry fits the name, from the words they share: each word
   * of either used once, the widest and best spelt first.
   */
  private fit(
    entry: Entry,
    meetings: Meeting[],
    queryWeights: readonly number[],
    queryTotal: number,
    queryWords: number,
  ): NameHit | null {
    const covered = (from: number, span: number, weights: readonly number[]) =>
      weights.slice(from, from + span).reduce((sum, w) => sum + w, 0);
    meetings.sort(
      (a, b) =>
        a.apart - b.apart ||
        covered(b.queryAt, b.querySpan, queryWeights) -
          covered(a.queryAt, a.querySpan, queryWeights),
    );
    const usedQuery = new Set<number>();
    const usedEntry = new Set<number>();
    let queryMet = 0;
    let entryMet = 0;
    let apart = 0;
    for (const meeting of meetings) {
      const queryAt = Array.from({ length: meeting.querySpan }, (_, i) => meeting.queryAt + i);
      const entryAt = Array.from({ length: meeting.entrySpan }, (_, i) => meeting.entryAt + i);
      if (queryAt.some((i) => usedQuery.has(i)) || entryAt.some((i) => usedEntry.has(i))) continue;
      for (const i of queryAt) usedQuery.add(i);
      for (const i of entryAt) usedEntry.add(i);
      queryMet += covered(meeting.queryAt, meeting.querySpan, queryWeights);
      entryMet += covered(meeting.entryAt, meeting.entrySpan, entry.weights);
      apart += meeting.apart;
    }
    if (queryMet === 0 || entryMet === 0) return null;
    const ofName = Math.min(1, queryMet / queryTotal);
    const ofTitle = Math.min(1, entryMet / entry.total);
    const score = ((2 * ofName * ofTitle) / (ofName + ofTitle)) * PER_LETTER ** apart;
    const exact =
      apart === 0 && usedQuery.size === queryWords && usedEntry.size === entry.words.length;
    return {
      id: this.pages[entry.page]!.id,
      score: exact ? 1 : Math.min(score, 0.999),
      exact,
      via: entry.via,
      name: entry.name,
    };
  }
}

/**
 * The pages that fit a name by title, then those that only mention it in
 * their text (`mentions`, page ids in the order a text search gave them),
 * each page once, at most `limit`.
 */
export function withMentions(
  hits: readonly NameHit[],
  mentions: readonly { id: string; title: string }[],
  limit = 20,
): NameHit[] {
  const seen = new Set(hits.map((hit) => hit.id));
  const out = hits.slice(0, limit);
  for (const page of mentions) {
    if (out.length >= limit) break;
    if (seen.has(page.id)) continue;
    seen.add(page.id);
    out.push({ id: page.id, score: 0, exact: false, via: 'text', name: page.title });
  }
  return out;
}
