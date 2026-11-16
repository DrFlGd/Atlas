/**
 * The three ways a site rules file (`siteRules.ts`) points at things, each
 * with one exact form and none of them a regular expression or a script:
 *
 * - a selector, a CSS selector as a style sheet takes it, which this
 *   module only checks the form of: a file's selectors are stored, and only
 *   a reader that reads a page runs them;
 * - an address pattern, `/` and a path in which `*` stands for any run of
 *   characters without `/` and `**` for any run of characters with them;
 * - a data path, field names with `.` between them, each name followed by
 *   `[*]` (every entry of that list) or `[<n>]` (one entry) where needed.
 */

/** The longest selector a file may hold. */
export const MAX_SELECTOR_CHARS = 200;
/** The longest address pattern a file may hold. */
export const MAX_PATTERN_CHARS = 300;
/** The longest data path a file may hold. */
export const MAX_DATA_PATH_CHARS = 200;

// ---------------------------------------------------------------------------
// Selectors

/**
 * Pseudo-classes that depend on what the reader of a page does (pointing,
 * focus, a visited link) and every pseudo-element: they match nothing in a
 * page as it stands after loading.
 */
const STATE_PSEUDO =
  /::|:(?:hover|focus|focus-within|focus-visible|active|visited|target|checked|autofill|playing|paused)\b/iu;

/**
 * Why `text` cannot be a selector of a file, in a few plain words, or null
 * when its form is usable. This is not a full CSS parser: it refuses what a
 * file must never hold (an empty text, more than {@link MAX_SELECTOR_CHARS}
 * characters, a line break, a pseudo-class of a state or a pseudo-element,
 * brackets and quotes that are not closed) and leaves the rest to the
 * reader that runs it, which treats a selector it cannot use as matching
 * nothing.
 */
export function selectorProblem(text: string): string | null {
  if (text.trim() === '') return 'must not be empty';
  if (text.length > MAX_SELECTOR_CHARS) {
    return `must be at most ${MAX_SELECTOR_CHARS} characters`;
  }
  if (/[\n\r\t{};]/u.test(text)) {
    return 'must be one CSS selector, without line breaks, braces or semicolons';
  }
  if (STATE_PSEUDO.test(text)) {
    return 'names a state (such as :hover) or a part of an element (such as ::before), which match nothing in a page as it stands after loading';
  }
  let square = 0;
  let round = 0;
  let quote: string | null = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '[') square++;
    else if (char === ']') square--;
    else if (char === '(') round++;
    else if (char === ')') round--;
    if (square < 0 || round < 0) return 'has a bracket that closes before it opens';
  }
  if (quote) return 'has a quotation mark that is not closed';
  if (square !== 0 || round !== 0) return 'has a bracket that is not closed';
  return null;
}

// ---------------------------------------------------------------------------
// Address patterns

/**
 * Why `text` cannot be an address pattern, in a few plain words, or null.
 * A pattern begins with `/`, holds no query (`?`), fragment (`#`), space or
 * backslash, and no run of three `*`.
 */
export function patternProblem(text: string): string | null {
  if (!text.startsWith('/')) return 'must begin with /';
  if (text.length > MAX_PATTERN_CHARS) return `must be at most ${MAX_PATTERN_CHARS} characters`;
  if (/[?#\s\\]/u.test(text)) return 'must be a path only, without ?, #, spaces or backslashes';
  if (text.includes('***')) return 'may hold * or **, but not three * in a row';
  return null;
}

/** Without a `/` at the end, but for `/` itself. */
const withoutEndSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/u, '') : path);

/**
 * Whether the path of an address matches an address pattern: the whole
 * path, upper and lower case counting, a `/` at the end of either ignored.
 * `*` stands for any run of characters without `/`, `**` for any run of
 * characters, `/` included; every other character stands for itself.
 * A pattern with a problem ({@link patternProblem}) matches nothing.
 */
export function patternMatches(pattern: string, path: string): boolean {
  if (patternProblem(pattern) !== null) return false;
  const source = withoutEndSlash(pattern)
    .split(/(\*\*|\*)/u)
    .map((part) =>
      part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'),
    )
    .join('');
  return new RegExp(`^${source}$`, 'u').test(withoutEndSlash(path));
}

// ---------------------------------------------------------------------------
// Data paths

/** One step of a data path: a field by its name, every entry of a list, or one entry. */
export type DataStep =
  | { field: string }
  | { every: true }
  | {
      entry: number;
    };

const NAME = /^[A-Za-z_$][A-Za-z0-9_$-]*/u;
const INDEX = /^\[(\*|\d{1,6})\]/u;

/** The steps of a data path, or null when it is not one. */
export function dataPathSteps(text: string): DataStep[] | null {
  if (text.length === 0 || text.length > MAX_DATA_PATH_CHARS) return null;
  const steps: DataStep[] = [];
  let rest = text;
  let first = true;
  while (rest.length > 0) {
    if (!first) {
      if (!rest.startsWith('.')) return null;
      rest = rest.slice(1);
    }
    const name = NAME.exec(rest)?.[0];
    if (name) {
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') return null;
      steps.push({ field: name });
      rest = rest.slice(name.length);
    } else if (!(first && rest.startsWith('['))) {
      return null;
    }
    let index = INDEX.exec(rest);
    while (index) {
      steps.push(index[1] === '*' ? { every: true } : { entry: Number(index[1]) });
      rest = rest.slice(index[0].length);
      index = INDEX.exec(rest);
    }
    first = false;
  }
  return steps.length > 0 ? steps : null;
}

/** Why `text` cannot be a data path, in a few plain words, or null. */
export function dataPathProblem(text: string): string | null {
  if (text.length > MAX_DATA_PATH_CHARS) {
    return `must be at most ${MAX_DATA_PATH_CHARS} characters`;
  }
  return dataPathSteps(text)
    ? null
    : 'must be field names with . between them, each followed by [*] or [0] where needed, such as markers[*] or position.x';
}

/**
 * Every value a data path names in `data`: one value, several for each
 * `[*]`, none where a field or an entry is not there. Only a JSON object's
 * own fields are read. A path with a problem names nothing.
 */
export function readDataPath(data: unknown, path: string): unknown[] {
  const steps = dataPathSteps(path);
  if (!steps) return [];
  let values: unknown[] = [data];
  for (const step of steps) {
    const next: unknown[] = [];
    for (const value of values) {
      if ('field' in step) {
        if (
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value) &&
          Object.hasOwn(value, step.field)
        ) {
          next.push((value as Record<string, unknown>)[step.field]);
        }
      } else if (Array.isArray(value)) {
        if ('every' in step) next.push(...(value as unknown[]));
        else if (step.entry < value.length) next.push((value as unknown[])[step.entry]);
      }
    }
    values = next;
  }
  return values;
}
