import type { GuideEntry } from '@atlas/schema';

/**
 * "All pages": every page of a source from A to Z, the way to any page
 * whether its source's menu names it or not. Pages are grouped under the
 * first letter of their title (its accents left out, upper and lower case
 * alike); a title that starts with a digit or a sign is under `#`, which
 * comes first. Within a group, pages are in the order of their titles as
 * people read them: numbers by their value ("Item 9" before "Item 10"),
 * upper and lower case and accents alike (as `localeCompare` orders them,
 * numeric, base sensitivity, through one collator, which is quicker for
 * thousands), and two pages of one title in the order of their ids, so the
 * list is the same every time. Nothing of it is stored: it is worked out
 * from the pages whenever it is shown.
 */

/** A letter of "All pages", and its pages in order. */
export interface PagesOfLetter {
  /** An upper-case letter, or `#` for titles that start with a digit or a sign. */
  letter: string;
  pages: GuideEntry[];
}

/** The group of titles that start with a digit or a sign. */
export const OTHER_LETTER = '#';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** The letter a title is listed under (see the top of this file). */
export function letterOf(title: string): string {
  const point = title.trim().normalize('NFD').replace(/\p{M}/gu, '').codePointAt(0);
  const first = point === undefined ? '' : String.fromCodePoint(point);
  return /\p{L}/u.test(first) ? first.toLocaleUpperCase('en') : OTHER_LETTER;
}

/** Every page from A to Z, grouped by letter, `#` first (see the top of this file). */
export function pagesAToZ(pages: readonly GuideEntry[]): PagesOfLetter[] {
  const sorted = pages
    .map((guide) => ({ guide, letter: letterOf(guide.title) }))
    .sort(
      (a, b) =>
        collator.compare(a.guide.title, b.guide.title) ||
        (a.guide.id < b.guide.id ? -1 : a.guide.id > b.guide.id ? 1 : 0),
    );
  const groups = new Map<string, GuideEntry[]>();
  for (const { guide, letter } of sorted) {
    const group = groups.get(letter);
    if (group) group.push(guide);
    else groups.set(letter, [guide]);
  }
  return [...groups]
    .map(([letter, inLetter]) => ({ letter, pages: inLetter }))
    .sort((a, b) =>
      a.letter === OTHER_LETTER
        ? b.letter === OTHER_LETTER
          ? 0
          : -1
        : b.letter === OTHER_LETTER
          ? 1
          : collator.compare(a.letter, b.letter),
    );
}
