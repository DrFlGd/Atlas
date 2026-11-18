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
 *   `[*]` (every entry of that list, or every value of that object) or
 *   `[<n>]` (one entry) where needed, or by `[json]` where a field's text
 *   is itself JSON, read and gone into;
 * - a page path, a data path that starts at a value the scripts of a map
 *   page set on its window, which names one value and no field the reader
 *   must never look at ({@link pagePathProblem}).
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
// Named pieces

/** Without a `/` at the end, but for `/` itself. */
const withoutEndSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/u, '') : path);

/**
 * The named pieces an address or pattern of a part read by rules may hold:
 * `{game}` and `{guide}` in a wiki or guide part, `{game}` and `{map}` in a
 * map part, `{system}` and `{game}` in a map part of whole pictures listed
 * on a page (where `{game}` may also be the address's fragment, after `#`).
 */
const PIECE_NAMES = ['game', 'guide', 'map', 'system'] as const;
export type PieceName = (typeof PIECE_NAMES)[number];
/** The values of named pieces, as they stand in an address's path. */
export type PieceValues = Partial<Record<PieceName, string>>;

/**
 * The named pieces an address or pattern holds (`{game}`, `{guide}`,
 * `{map}`), in order, or why it cannot hold them: every `{` and `}` must be
 * one of these pieces, each piece a whole segment of the path (between two
 * `/`, or at its end) and there once. Which pieces a part may hold is the
 * checker's to say, by the part's type.
 */
export function piecesOf(text: string): { pieces: PieceName[]; problem: string | null } {
  const pieces: PieceName[] = [];
  const path = text.replace(/^https:\/\/[^/]*/u, '');
  if (!/[{}]/u.test(path)) return { pieces, problem: /[{}]/u.test(text) ? BRACES : null };
  for (const segment of path.split(/[/?#]/u)) {
    if (!/[{}]/u.test(segment)) continue;
    const named = /^\{([a-z]+)\}$/u.exec(segment)?.[1];
    if (!named || !(PIECE_NAMES as readonly string[]).includes(named)) {
      return { pieces, problem: BRACES };
    }
    if (pieces.includes(named as PieceName)) {
      return { pieces, problem: `holds {${named}} twice; a piece stands once in an address` };
    }
    pieces.push(named as PieceName);
  }
  return { pieces, problem: null };
}

const BRACES =
  'may hold { and } only as the named pieces {game}, {guide}, {map} and {system}, each a whole part of the path between two /';

/** An address or pattern with its named pieces filled in; a piece with no value is left as it is. */
export function fillPieces(text: string, values: PieceValues): string {
  return text.replace(
    /\{(game|guide|map|system)\}/gu,
    (whole, name: PieceName) => values[name] ?? whole,
  );
}

/**
 * The values of the named pieces of `start` (a path, with pieces, already
 * without its host) in `path`: each piece one whole segment, everything
 * else the same, a `/` at the end of either ignored. Null when the path is
 * not one `start` describes.
 */
export function piecesIn(start: string, path: string): PieceValues | null {
  const names: PieceName[] = [];
  const source = withoutEndSlash(start)
    .split(/(\{(?:game|guide|map|system)\})/u)
    .map((part) => {
      const named = /^\{(game|guide|map|system)\}$/u.exec(part)?.[1] as PieceName | undefined;
      if (named) {
        names.push(named);
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    })
    .join('');
  const match = new RegExp(`^${source}$`, 'u').exec(withoutEndSlash(path));
  if (!match) return null;
  const values: PieceValues = {};
  names.forEach((name, index) => {
    values[name] = match[index + 1]!;
  });
  return values;
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
  return piecesOf(text).problem;
}

/** The longest address beginning a file may hold ({@link addressBeginningProblem}). */
export const MAX_ADDRESS_BEGINNING_CHARS = 300;
/** Entries `reading.keepOff` and `reading.permission.allows` hold at most. */
export const MAX_ADDRESS_BEGINNINGS = 50;

/**
 * Why `text` cannot be the beginning of addresses of a site (an entry of
 * `reading.keepOff` or of `reading.permission.allows`), in a few plain
 * words, or null. It is written as a `Disallow` line of a `robots.txt`
 * without its special signs: `/`, then a path, and a query after `?` when
 * one is meant. No `*` (nothing stands for anything else), no `$` at its
 * end, no `#`, space or backslash, and no `?` with nothing after it.
 */
export function addressBeginningProblem(text: string): string | null {
  if (!text.startsWith('/') || text.startsWith('//')) {
    return 'must begin with a single /, such as /private/ or /tools/list.php';
  }
  if (text.length > MAX_ADDRESS_BEGINNING_CHARS) {
    return `must be at most ${MAX_ADDRESS_BEGINNING_CHARS} characters`;
  }
  if (/[#\s\\]/u.test(text)) return 'must be an address without #, spaces or backslashes';
  if (text.includes('*')) {
    return 'must be the plain beginning of addresses: * stands for nothing here, as every entry already covers every address that begins with it';
  }
  if (text.endsWith('$')) {
    return 'must be the plain beginning of addresses: $ marks no end here, so leave it out';
  }
  if (text.endsWith('?')) return 'must not end with ?: write the query after it, or leave ? out';
  return null;
}

/** The path and query of an address as the URL parser writes them (`/wiki/Caf%C3%A9?x=1`), or null. */
function pathAndQuery(text: string): string | null {
  try {
    const url = new URL(text, 'https://site.invalid/');
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/**
 * Whether an address of a site begins with one of `beginnings`, entries of
 * `reading.keepOff` or `reading.permission.allows` (see
 * {@link addressBeginningProblem}), as a `Disallow` line of a `robots.txt`
 * matches: the address's path, followed by its query when it has one
 * (`?` and what follows), begins with the entry, character for character,
 * upper and lower case counting. Both are first written as the URL parser
 * writes them, so `/wiki/Café` and `/wiki/Caf%C3%A9` are the same; the
 * address's fragment is ignored. `/` covers every address of the site.
 * Only the path and query are looked at: which hosts the list is for is
 * the file's to say (its site's hosts). An entry with a problem covers
 * nothing.
 */
export function addressBegins(beginnings: readonly string[], address: string): boolean {
  const at = pathAndQuery(address);
  if (at === null) return false;
  return beginnings.some((entry) => {
    if (addressBeginningProblem(entry) !== null) return false;
    const start = pathAndQuery(entry);
    return start !== null && at.startsWith(start);
  });
}

/**
 * Whether two beginnings of addresses overlap: one of them covers an
 * address the other covers too (the one is the beginning of the other).
 */
export function beginningsOverlap(a: string, b: string): boolean {
  const one = pathAndQuery(a);
  const other = pathAndQuery(b);
  return one !== null && other !== null && (one.startsWith(other) || other.startsWith(one));
}

/**
 * Whether the path of an address matches an address pattern: the whole
 * path, upper and lower case counting, a `/` at the end of either ignored.
 * `*` stands for any run of characters without `/`, `**` for any run of
 * characters, `/` included; every other character stands for itself.
 * A pattern with a problem ({@link patternProblem}) matches nothing.
 */
export function patternMatches(pattern: string, path: string): boolean {
  return patternPieces(pattern, path) !== null;
}

/**
 * The values of the named pieces a pattern holds in the path it matches
 * (`{game}` and `{guide}`, each one whole segment), or null when the path
 * does not match. A pattern without pieces gives no values.
 */
export function patternPieces(pattern: string, path: string): PieceValues | null {
  if (patternProblem(pattern) !== null) return null;
  const names: PieceName[] = [];
  const source = withoutEndSlash(pattern)
    .split(/(\*\*|\*|\{(?:game|guide|map)\})/u)
    .map((part) => {
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      const named = /^\{(game|guide|map)\}$/u.exec(part)?.[1] as PieceName | undefined;
      if (named) {
        names.push(named);
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    })
    .join('');
  const match = new RegExp(`^${source}$`, 'u').exec(withoutEndSlash(path));
  if (!match) return null;
  const values: PieceValues = {};
  names.forEach((name, index) => {
    values[name] = match[index + 1]!;
  });
  return values;
}

// ---------------------------------------------------------------------------
// Data paths

/**
 * One step of a data path: a field by its name, every entry of a list (or
 * value of an object), one entry, or the JSON a text holds.
 */
export type DataStep =
  | { field: string }
  | { every: true }
  | {
      entry: number;
    }
  | { json: true };

/** The longest text a `[json]` step reads as JSON; a longer one names nothing. */
export const MAX_JSON_TEXT = 16 * 1024 * 1024;

const NAME = /^[A-Za-z_$][A-Za-z0-9_$-]*/u;
const INDEX = /^\[(\*|\d{1,6}|json)\]/u;

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
      steps.push(
        index[1] === '*'
          ? { every: true }
          : index[1] === 'json'
            ? { json: true }
            : { entry: Number(index[1]) },
      );
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
    : 'must be field names with . between them, each followed by [*], [0] or [json] where needed, such as markers[*] or position.x';
}

/** The JSON texts read last, so that a text many paths go into is read once. */
const readTexts = new Map<string, unknown>();

/** The JSON a text holds, or undefined when it holds none or is longer than {@link MAX_JSON_TEXT}. */
function jsonIn(text: string): unknown {
  if (text.length > MAX_JSON_TEXT) return undefined;
  if (readTexts.has(text)) return readTexts.get(text);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    value = undefined;
  }
  if (readTexts.size >= 4) readTexts.delete(readTexts.keys().next().value!);
  readTexts.set(text, value);
  return value;
}

/**
 * Every value a data path names in `data`: one value, several for each
 * `[*]` (every entry of a list, or every value of an object, in its order),
 * none where a field or an entry is not there. `[json]` reads a text as the
 * JSON it holds (at most {@link MAX_JSON_TEXT} characters) and goes on in
 * it; a text that is not JSON names nothing. Only a JSON object's own
 * fields are read. A path with a problem names nothing.
 */
export function readDataPath(data: unknown, path: string): unknown[] {
  const steps = dataPathSteps(path);
  if (!steps) return [];
  let values: unknown[] = [data];
  for (const step of steps) {
    const next: unknown[] = [];
    for (const value of values) {
      if ('json' in step) {
        const inner = typeof value === 'string' ? jsonIn(value) : undefined;
        if (inner !== undefined) next.push(inner);
      } else if ('field' in step) {
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
      } else if ('every' in step && typeof value === 'object' && value !== null) {
        next.push(...(Object.values(value) as unknown[]));
      }
    }
    values = next;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Page paths

/** Steps one page path holds at most. */
export const MAX_PAGE_PATH_STEPS = 12;

/**
 * Names a page path never holds, in lower case: what the browser gives a
 * page besides its data (its document, address, history, storage, cookies,
 * the frames around it and the means to make requests), the fields every
 * object has, the one function a store has (named by `store`, never by a
 * path), and fields that name a signed-in person or a key. A file that
 * names one is refused, whatever the site keeps under it.
 */
export const REFUSED_PAGE_NAMES: readonly string[] = [
  'window',
  'self',
  'globalthis',
  'top',
  'parent',
  'opener',
  'frames',
  'frameelement',
  'document',
  'location',
  'history',
  'navigator',
  'origin',
  'name',
  'cookie',
  'cookies',
  'cookiestore',
  'storage',
  'localstorage',
  'sessionstorage',
  'indexeddb',
  'caches',
  'crypto',
  'credentials',
  'clipboard',
  'serviceworker',
  'external',
  'chrome',
  'webkit',
  'fetch',
  'xmlhttprequest',
  'websocket',
  'eventsource',
  'postmessage',
  'eval',
  'function',
  'open',
  'close',
  'alert',
  'confirm',
  'prompt',
  'print',
  'getstate',
  'dispatch',
  'subscribe',
  '__proto__',
  'prototype',
  'constructor',
  'user',
  'account',
  'auth',
  'session',
  'token',
  'password',
];

/** The first step of a page path: the name of a value on the page's window, as a script names it. */
const PAGE_ROOT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;

/**
 * Why `text` cannot be a page path, in a few plain words, or null. A page
 * path is a data path ({@link dataPathProblem}) that begins with the name
 * of a value the page's scripts set on its window (letters, digits, `_`
 * and `$`, not beginning with a digit), names one value (no `[*]`), has at
 * most {@link MAX_PAGE_PATH_STEPS} steps, and holds none of
 * {@link REFUSED_PAGE_NAMES}. With `fromStore`, it is the path inside what
 * a store gives, which may begin with any field name.
 */
export function pagePathProblem(text: string, fromStore = false): string | null {
  const form = dataPathProblem(text);
  if (form) return form;
  const steps = dataPathSteps(text)!;
  const first = steps[0]!;
  if (!fromStore && !('field' in first && PAGE_ROOT.test(first.field))) {
    return 'must begin with the name of a value of the page, such as mapState, written with letters, digits, _ and $';
  }
  if (steps.some((step) => 'every' in step || 'json' in step)) {
    return 'must name one value as the page keeps it: write [*] and [json] in the other data paths of the part, not here';
  }
  if (steps.length > MAX_PAGE_PATH_STEPS) {
    return `must have at most ${MAX_PAGE_PATH_STEPS} steps`;
  }
  const refused = steps.find(
    (step) => 'field' in step && REFUSED_PAGE_NAMES.includes(step.field.toLowerCase()),
  );
  if (refused && 'field' in refused) {
    return `holds ${refused.field}, which a page path never names: the reader reads only the values the page's own scripts keep, never what the browser gives the page, nor a signed-in person's data`;
  }
  return null;
}
