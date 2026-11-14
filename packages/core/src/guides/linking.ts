import type { GuideEntry, LinkTarget, Location, PackData, Region } from '@atlas/schema';
import { normalizeText } from '../search/searchIndex';

/**
 * Linking guide pages to the map by name.
 *
 * Each page that was read from a site (a guide with a `source`, such as a
 * wiki page) is compared with the game's types, the names of its
 * locations and its regions. Names are compared without case, accents,
 * punctuation, a leading article ("the", "a", "an"), a note in brackets at
 * the end ("Wolf (enemy)") and simple plurals, so "The Waystones" is
 * "waystone". A location's name is also compared without a number at its
 * end, so a page "Stone wardens" is the page of every "Stone warden 12".
 *
 * One page can stand for many locations: a page named like a type links to
 * every location of the type, one named like a location to every location
 * of that name, one named like a region to the region. The results fall in
 * three groups: `sure` (one clear match, named exactly), `unsure` (several
 * candidates, or only a near one) and `none`. Nothing here links anything:
 * the app asks the person, and keeps what they say (see `guideLinks.ts` in
 * the schema package).
 */

/** What a target is, in the person's words. */
export type TargetWhat = 'type' | 'name' | 'region' | 'location';

/** A target as the app shows it: what it is, its name, and its locations. */
export interface TargetInfo {
  target: LinkTarget;
  what: TargetWhat;
  label: string;
  /** The ids of its locations, in pack order. */
  locations: readonly string[];
}

/** A target a page may be linked to; `exact` when the names are the same. */
export interface Candidate extends TargetInfo {
  exact: boolean;
}

export type MatchGroup = 'sure' | 'unsure' | 'none';

/** How a page matches the map: its group, and its candidates, the best first. */
export interface PageMatch {
  guideId: string;
  title: string;
  group: MatchGroup;
  candidates: Candidate[];
}

/** Candidates kept for one page at most. */
const MAX_CANDIDATES = 6;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);
const ARTICLES = new Set(['the', 'a', 'an']);

/** One word without a simple plural ending, so that its singular and plural meet. */
export function stemWord(word: string): string {
  let w = word;
  if (w.length <= 3 || /\d/u.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (/(?:s|x|z|ch|sh)es$/u.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(?:ss|us|is)$/u.test(w)) w = w.slice(0, -1);
  // "wolves" and "wolf", "knives" and "knife", "caves" and "cave" meet here.
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  if (w.endsWith('v')) w = `${w.slice(0, -1)}f`;
  return w;
}

/**
 * The words of a name as they are written, tidied as names are compared
 * (see the top of this file) but not made singular: without case, accents,
 * punctuation, a note in brackets at the end or a leading article.
 */
export function tidyNameWords(text: string): string[] {
  const trimmed = text.replace(/\s*\([^()]*\)\s*$/u, '').trim() || text;
  const words = normalizeText(trimmed)
    .replace(/['’ʼ`]/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length > 1 && ARTICLES.has(words[0]!)) words.shift();
  return words;
}

/** The words of a name, compared as names are (see the top of this file). */
export function nameWords(text: string): string[] {
  return tidyNameWords(text).map(stemWord);
}

/** A name as one key: two names with the same key are the same name. */
export function nameKey(text: string): string {
  return nameWords(text).join('');
}

/** A location's name without a number at its end: "Stone warden 12" is "Stone warden". */
export function baseName(name: string): string {
  const base = name.replace(/\s*(?:#|no\.?\s*)?\d+$/iu, '').trim();
  return base || name;
}

/** Whether a word says little about what a name is about: "of", "the" and the like. */
export const isStopWord = (word: string): boolean => STOP_WORDS.has(word);

/** The words that say what a name is about, without "of", "the" and the like. */
const meaningWords = (words: readonly string[]) =>
  new Set(words.filter((word) => !STOP_WORDS.has(word)));

/** Whether two keys differ by at most one letter: one changed, added, left out or two swapped. */
function oneApart(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff: number[] = [];
    for (let i = 0; i < a.length && diff.length < 3; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 1) return true;
    if (diff.length !== 2) return false;
    const [i, j] = diff as [number, number];
    // Two letters swapped.
    return j === i + 1 && a[i] === b[j] && a[j] === b[i];
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return short.slice(i) === long.slice(i + 1);
}

/** Something a page can be linked to, as it is matched. */
interface Entry {
  info: TargetInfo;
  key: string;
  words: Set<string>;
  /** Offered when a page matches it nearly, and in a search (not a name with a number). */
  offered: boolean;
}

const WHAT_ORDER: Record<TargetWhat, number> = { type: 0, name: 1, region: 2, location: 3 };

/** The parts of a pack the names come from. */
export type NamesSource = Pick<PackData, 'locations' | 'categories' | 'regions'>;

/**
 * The names a game's map offers to link pages to: its types, the names of
 * its locations and its regions, each with its locations. Made once per
 * pack.
 */
export class MapNames {
  private readonly entries: Entry[] = [];
  private readonly byKey = new Map<string, Entry[]>();
  private readonly byWord = new Map<string, Entry[]>();
  private readonly byLength = new Map<number, Entry[]>();
  private readonly types = new Map<string, Entry>();
  private readonly regions = new Map<string, Entry>();
  private readonly names = new Map<string, Entry>();
  /** Each location's name, for a page linked to one location alone. */
  private readonly locationNames = new Map<string, string>();

  constructor(data: NamesSource) {
    const byType = new Map<string, string[]>();
    const byName = new Map<string, { label: string; ids: string[]; numbered: boolean }>();
    const addName = (key: string, label: string, id: string, numbered: boolean) => {
      if (!key) return;
      const group = byName.get(key);
      if (group) group.ids.push(id);
      else byName.set(key, { label, ids: [id], numbered });
    };
    for (const location of data.locations) {
      this.locationNames.set(location.id, location.name);
      const ids = byType.get(location.categoryId);
      if (ids) ids.push(location.id);
      else byType.set(location.categoryId, [location.id]);
      const full = nameKey(location.name);
      const base = baseName(location.name);
      const baseKey = nameKey(base);
      addName(full, location.name, location.id, baseKey !== full);
      if (baseKey !== full) addName(baseKey, base, location.id, false);
    }

    for (const category of data.categories) {
      const entry = this.add(
        { to: 'type', id: category.id },
        'type',
        category.name,
        byType.get(category.id) ?? [],
        true,
      );
      this.types.set(category.id, entry);
    }
    for (const [key, group] of byName) {
      const entry = this.add(
        { to: 'name', name: group.label },
        'name',
        group.label,
        group.ids,
        !group.numbered,
        key,
      );
      this.names.set(key, entry);
    }
    const inRegion = regionLocations(data.regions, data.locations);
    for (const region of data.regions) {
      const entry = this.add(
        { to: 'region', id: region.id },
        'region',
        region.name,
        inRegion.get(region.id) ?? [],
        true,
      );
      this.regions.set(region.id, entry);
    }
  }

  private add(
    target: LinkTarget,
    what: TargetWhat,
    label: string,
    locations: readonly string[],
    offered: boolean,
    key = nameKey(label),
  ): Entry {
    const words = nameWords(label);
    const entry: Entry = {
      info: { target, what, label, locations },
      key,
      words: meaningWords(words),
      offered,
    };
    this.entries.push(entry);
    if (!key) return entry;
    push(this.byKey, key, entry);
    if (offered) {
      for (const word of entry.words) push(this.byWord, word, entry);
      push(this.byLength, key.length, entry);
    }
    return entry;
  }

  /** What a target stands for now, or null when the map no longer has it. */
  resolve(target: LinkTarget): TargetInfo | null {
    switch (target.to) {
      case 'type':
        return this.types.get(target.id)?.info ?? null;
      case 'region':
        return this.regions.get(target.id)?.info ?? null;
      case 'name': {
        const entry = this.names.get(nameKey(target.name));
        return entry ? { ...entry.info, target } : null;
      }
      case 'location': {
        const name = this.locationNames.get(target.id);
        return name === undefined
          ? null
          : { target, what: 'location', label: name, locations: [target.id] };
      }
    }
  }

  /**
   * The name target that stands for every location with a location's name
   * (its name without a number at its end, when that is how the map names
   * them), with its locations; null when the map has no such location.
   */
  nameTargetOf(locationId: string): TargetInfo | null {
    const name = this.locationNames.get(locationId);
    if (name === undefined) return null;
    const base = this.names.get(nameKey(baseName(name)));
    if (base?.info.locations.includes(locationId)) return { ...base.info };
    const full = this.names.get(nameKey(name));
    return full ? { ...full.info } : null;
  }

  /** The locations of several targets, each once, in the order of the targets. */
  locationsOf(targets: readonly LinkTarget[]): string[] {
    const ids = new Set<string>();
    for (const target of targets)
      for (const id of this.resolve(target)?.locations ?? []) ids.add(id);
    return [...ids];
  }

  /** How a page's title matches the map (see the top of this file). */
  match(title: string): { group: MatchGroup; candidates: Candidate[] } {
    const key = nameKey(title);
    if (!key) return { group: 'none', candidates: [] };
    const exact = dropSameAsType(this.byKey.get(key) ?? []).map((entry): Candidate => ({
      ...entry.info,
      exact: true,
    }));
    exact.sort(byWhat);
    if (exact.length === 1) return { group: 'sure', candidates: exact };
    if (exact.length > 1) return { group: 'unsure', candidates: exact.slice(0, MAX_CANDIDATES) };
    const near = this.near(key, meaningWords(nameWords(title)));
    return near.length > 0
      ? { group: 'unsure', candidates: near.slice(0, MAX_CANDIDATES) }
      : { group: 'none', candidates: [] };
  }

  /** Names that are nearly the page's: one's words all in the other's, or one letter apart. */
  private near(key: string, words: ReadonlySet<string>): Candidate[] {
    const found = new Map<Entry, number>();
    if (words.size > 0) {
      const sharing = new Set<Entry>();
      for (const word of words) for (const entry of this.byWord.get(word) ?? []) sharing.add(entry);
      for (const entry of sharing) {
        if (entry.words.size === 0) continue;
        const inPage = [...entry.words].every((word) => words.has(word));
        const inEntry = [...words].every((word) => entry.words.has(word));
        if (inPage || inEntry) {
          const apart = Math.abs(entry.words.size - words.size);
          found.set(entry, apart);
        }
      }
    }
    if (key.length >= 5) {
      for (const length of [key.length - 1, key.length, key.length + 1]) {
        for (const entry of this.byLength.get(length) ?? []) {
          if (
            !found.has(entry) &&
            entry.key.startsWith(key.charAt(0)) &&
            oneApart(entry.key, key)
          ) {
            found.set(entry, 1);
          }
        }
      }
    }
    return [...found.entries()]
      .sort(
        ([a, apartA], [b, apartB]) =>
          apartA - apartB ||
          WHAT_ORDER[a.info.what] - WHAT_ORDER[b.info.what] ||
          b.info.locations.length - a.info.locations.length,
      )
      .map(([entry]) => ({ ...entry.info, exact: false }));
  }

  /**
   * Targets whose names hold what is typed (each word the start of one of
   * theirs), for picking another target by hand: types, names, regions.
   */
  find(query: string, limit = 20): TargetInfo[] {
    const typed = normalizeText(query)
      .replace(/['’ʼ`]/gu, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    if (typed.length === 0) return [];
    const hits: { info: TargetInfo; score: number }[] = [];
    for (const entry of this.entries) {
      if (!entry.offered) continue;
      const label = normalizeText(entry.info.label).replace(/['’ʼ`]/gu, '');
      const labelWords = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      if (!typed.every((t) => labelWords.some((w) => w.startsWith(t)))) continue;
      const score =
        (labelWords.join(' ') === typed.join(' ')
          ? 0
          : labelWords[0]!.startsWith(typed[0]!)
            ? 1
            : 2) *
          10 +
        WHAT_ORDER[entry.info.what];
      hits.push({ info: entry.info, score });
    }
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    hits.sort((a, b) => a.score - b.score || collator.compare(a.info.label, b.info.label));
    return hits.slice(0, limit).map((hit) => hit.info);
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const byWhat = (a: TargetInfo, b: TargetInfo) => WHAT_ORDER[a.what] - WHAT_ORDER[b.what];

/** A name whose locations are exactly a type's is that type: the type is kept. */
function dropSameAsType(entries: readonly Entry[]): Entry[] {
  const types = entries.filter((entry) => entry.info.what === 'type');
  return entries.filter((entry) => {
    if (entry.info.what !== 'name') return true;
    const ids = entry.info.locations;
    return !types.some((type) => {
      if (type.info.locations.length !== ids.length) return false;
      const of = new Set(type.info.locations);
      return ids.every((id) => of.has(id));
    });
  });
}

/** Each region's locations: its own and those of the regions inside it. */
function regionLocations(
  regions: readonly Region[],
  locations: readonly Location[],
): Map<string, string[]> {
  const parent = new Map(regions.map((region) => [region.id, region.parentId ?? null]));
  const out = new Map<string, string[]>();
  for (const location of locations) {
    let at = location.regionId;
    const seen = new Set<string>();
    while (at && !seen.has(at)) {
      seen.add(at);
      push(out, at, location.id);
      at = parent.get(at) ?? null;
    }
  }
  return out;
}

/** The pages to link: guides read from a site (with a `source`). */
export function linkablePages(guides: readonly GuideEntry[]): GuideEntry[] {
  return guides.filter((guide) => guide.source !== undefined);
}

/** How each page matches the map, in the pages' order. */
export function matchPages(names: MapNames, guides: readonly GuideEntry[]): PageMatch[] {
  return linkablePages(guides).map((guide) => ({
    guideId: guide.id,
    title: guide.title,
    ...names.match(guide.title),
  }));
}

/**
 * How specific a target is for one location, for showing its pages: a page
 * linked to it alone first, then one of its own name, then of its type, then
 * of its region; of two of the same, the one with fewer locations. Lower is
 * more specific.
 */
const SPECIFIC_ORDER: Record<TargetWhat, number> = { location: 0, name: 1, type: 2, region: 3 };

export function specificity(info: TargetInfo): number {
  return SPECIFIC_ORDER[info.what] * 1e9 + info.locations.length;
}
