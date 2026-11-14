import { normalizeText } from '../search/searchIndex';
import { baseName, isStopWord, nameKey, stemWord } from './linking';
import { PageNameIndex } from './nameMatch';

/**
 * Finding the locations of a map by name, with the forgiving matching of
 * `nameMatch.ts`: the names of a game's locations, indexed once, to find
 * the locations a name fits ("Frost wyrms" fits every "Frost wyrm 12"),
 * and the location names written in a line of text ("Lies in Sunken
 * shrine 3, past the hall").
 *
 * Names are compared as `linking.ts` compares them: case, accents,
 * punctuation, a leading article and simple plurals do not count. A name
 * with a number at its end ("Frost wyrm 3") is that location when the map
 * has it; a name without one stands for every location of that name,
 * whatever their numbers. A name the map does not have is looked up with
 * the room for spelling of {@link PageNameIndex}: words in any order, a
 * letter or two wrong, words written together or apart.
 *
 * Nothing here knows a site, a wiki or a game: only words.
 */

/** A location to find by name. */
export interface NamedLocation {
  id: string;
  name: string;
}

/** The locations a name fits, and how well. */
export interface LocationNameHit {
  /** The name as the map writes it: the location's own, or the name it shares with others. */
  name: string;
  /** The ids of its locations, in the order the index was given them. */
  ids: string[];
  /** From 0 to 1; 1 for the same name. */
  score: number;
  /** The same name, word for word. */
  exact: boolean;
}

/** How well a name that is not the same must fit to count, by default. */
export const LEAST_LOCATION_SCORE = 0.8;

/** The most words a name read in a text may have. */
const MOST_WORDS = 8;

/** The words of a text as they are compared, in order, numbers kept. */
function textWords(text: string): string[] {
  return normalizeText(text)
    .replace(/['’ʼ`]/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

interface Group {
  label: string;
  ids: string[];
}

/**
 * The names of a game's locations, to find the locations a name fits (see
 * the top of this file). Made once per set of locations; a lookup costs
 * about the number of words the names have, never the number of locations.
 */
export class LocationNameIndex {
  readonly size: number;
  /** By the key of a location's whole name, number and all. */
  private readonly byFull = new Map<string, Group>();
  /** By the key of a name without a number at its end: every location of that name. */
  private readonly byBase = new Map<string, Group>();
  /** The names without numbers, as pages are indexed, to find names spelt otherwise. */
  private readonly near: PageNameIndex;
  /** How many words the longest name has. */
  private readonly longest: number;

  constructor(locations: readonly NamedLocation[]) {
    this.size = locations.length;
    let longest = 1;
    const add = (map: Map<string, Group>, key: string, label: string, id: string) => {
      if (!key) return;
      const group = map.get(key);
      if (group) group.ids.push(id);
      else map.set(key, { label, ids: [id] });
    };
    for (const location of locations) {
      const base = baseName(location.name);
      add(this.byFull, nameKey(location.name), location.name, location.id);
      add(this.byBase, nameKey(base), base, location.id);
      longest = Math.max(longest, textWords(location.name).length);
    }
    this.longest = Math.min(MOST_WORDS, longest);
    this.near = new PageNameIndex(
      [...this.byBase].map(([key, group]) => ({ id: key, title: group.label })),
    );
  }

  /**
   * The locations a name fits, the best first: the location of that very
   * name; else every location of the name without its number; else the
   * names spelt near it that fit at least `least` (see `nameMatch.ts`).
   */
  find(name: string, least = LEAST_LOCATION_SCORE, limit = 5): LocationNameHit[] {
    const trimmed = name.trim();
    if (!trimmed) return [];
    const base = baseName(trimmed);
    if (base !== trimmed) {
      const full = this.byFull.get(nameKey(trimmed));
      if (full) return [{ name: full.label, ids: [...full.ids], score: 1, exact: true }];
    }
    const same = this.byBase.get(nameKey(base));
    if (same) return [{ name: same.label, ids: [...same.ids], score: 1, exact: true }];
    return this.near.find(trimmed, limit).flatMap((hit) => {
      const group = this.byBase.get(hit.id);
      if (!group || hit.score < least) return [];
      return [{ name: group.label, ids: [...group.ids], score: hit.score, exact: hit.exact }];
    });
  }

  /**
   * The location names written in a text, word for word as the map has
   * them (tidied, see the top of this file), each once, in the order they
   * come: at each word the longest name that starts there. A name with its
   * number is that location; one without is every location of the name.
   */
  namesIn(text: string): LocationNameHit[] {
    const words = textWords(text);
    const stems = words.map(stemWord);
    const hits: LocationNameHit[] = [];
    const seen = new Set<string>();
    for (let at = 0; at < words.length;) {
      let matched = 0;
      for (let length = Math.min(this.longest, words.length - at); length >= 1; length--) {
        // A name is never one small word ("of", "the") or a number alone.
        if (length === 1 && (isStopWord(words[at]!) || /^\d+$/u.test(words[at]!))) break;
        const key = stems.slice(at, at + length).join('');
        if (key.length < 3) continue;
        // With its number, that location; without, every location of the name.
        const group = /\d$/u.test(key)
          ? (this.byFull.get(key) ?? this.byBase.get(key))
          : (this.byBase.get(key) ?? this.byFull.get(key));
        if (!group) continue;
        if (!seen.has(key)) {
          seen.add(key);
          hits.push({ name: group.label, ids: [...group.ids], score: 1, exact: true });
        }
        matched = length;
        break;
      }
      at += Math.max(1, matched);
    }
    return hits;
  }
}
