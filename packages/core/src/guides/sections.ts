/**
 * Sections of a guide page: every heading has a name, worked out from its
 * words whenever the page is shown, so nothing is stored for it; and a
 * link to a page can name a section of it, which the page opens at.
 *
 * - A heading's name ({@link sectionName}) is its words in lower case,
 *   accents and apostrophes left out, every other run of characters that
 *   are not letters or digits one dash: "The Ember Blade's Forge" is
 *   `the-ember-blades-forge`. The same words always give the same name,
 *   and a name is its own name, so a name can be written anywhere words are.
 * - Two headings with the same words get the names a wiki gives them: the
 *   first the name alone, the second the name and `-2`, the third `-3`,
 *   each a name no other heading of the page has ({@link headingNames}).
 * - A link names a section with its title, `#` and the section's name:
 *   `[Runes](game:guide:cards-and-runes "#runes")` (see
 *   {@link sectionOfTitle}). An app that does not know sections opens the
 *   page at its top, as for any title. Only a title that starts with `#`
 *   names a section; any other title is what the link says when pointed at.
 * - Finding the heading a section names is forgiving
 *   ({@link findSection}): the section may come from a site's address, so
 *   case, underscores for spaces, percent-encoded characters, punctuation,
 *   accents and the number after a repeated heading do not count. When no
 *   heading fits, the page opens at its top.
 */

/** What a heading with no letters or digits at all is named. */
const NO_WORDS = 'section';

/** The longest name a section has; longer words are cut. */
export const MAX_SECTION_NAME = 120;

/** Percent-encoded characters read, where they can be. */
function decoded(text: string): string {
  if (!text.includes('%')) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The name of a heading from its words, or of a section from a link or an
 * address; empty for words with no letters or digits.
 */
export function sectionName(words: string): string {
  return decoded(words)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/['’‘`´]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_SECTION_NAME)
    .replace(/-+$/u, '');
}

/**
 * The names of a page's headings, in order, from their words: each its
 * {@link sectionName}, a repeated one numbered as a wiki numbers it (the
 * second `-2`, the third `-3`), so no two headings share a name.
 */
export function headingNames(words: readonly string[]): string[] {
  const used = new Set<string>();
  const seen = new Map<string, number>();
  return words.map((text) => {
    const base = sectionName(text) || NO_WORDS;
    let count = seen.get(base) ?? 0;
    let name = base;
    while (used.has(name)) {
      count += 1;
      name = `${base}-${count + 1}`;
    }
    seen.set(base, count);
    used.add(name);
    return name;
  });
}

const NUMBERED = /^(.+)-(\d{1,4})$/u;
const withoutDashes = (name: string) => name.replaceAll('-', '');

/**
 * The heading of `names` (as {@link headingNames} gives them) a section
 * names, by its index; -1 when none fits.
 *
 * The section is read as {@link sectionName} reads words. A name the page
 * has fits first. Then a section with a number after it (`drops-2`, from
 * a wiki that numbered a repeated heading) is that heading of the same
 * words, counted from the first: the last of them when the page has
 * fewer. Then a heading whose name has the same letters and digits.
 */
export function findSection(section: string, names: readonly string[]): number {
  const wanted = sectionName(section);
  if (!wanted) return -1;
  const exact = names.indexOf(wanted);
  if (exact >= 0) return exact;
  const numbered = NUMBERED.exec(wanted);
  if (numbered) {
    const base = numbered[1]!;
    const nth = Number(numbered[2]);
    const same = names.flatMap((name, i) =>
      name === base || (name.startsWith(`${base}-`) && /^\d+$/u.test(name.slice(base.length + 1)))
        ? [i]
        : [],
    );
    if (same.length > 0) return same[Math.min(nth, same.length) - 1]!;
  }
  const letters = withoutDashes(wanted);
  return names.findIndex((name) => withoutDashes(name) === letters);
}

/** The section a link's title names (`"#runes"`), or null for any other title. */
export function sectionOfTitle(title: string | null | undefined): string | null {
  const text = title?.trim() ?? '';
  if (!text.startsWith('#')) return null;
  const name = sectionName(text.slice(1));
  return name || null;
}

/** The title of a link to a section: `#` and the section's name; empty when it has no name. */
export function sectionTitle(section: string): string {
  const name = sectionName(section);
  return name ? `#${name}` : '';
}
