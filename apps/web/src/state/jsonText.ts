/**
 * The text of a JSON file as the rules file editor needs it: where each
 * field stands in the text, so that a problem of the checker can lead the
 * person to its field, and where a text stops being JSON, in any browser
 * (the error messages of `JSON.parse` differ between engines, and some give
 * no position). It reads JSON exactly as `JSON.parse` does and runs nothing.
 */

/** Where one field stands in the text: its name (for a field of an object) and its value. */
export interface JsonSpot {
  /** The start of its name in quotation marks; its value's start for an entry of a list. */
  start: number;
  /** The start and the end of its value. */
  valueStart: number;
  valueEnd: number;
}

export type JsonScan =
  { ok: true; spots: Map<string, JsonSpot> } | { ok: false; at: number; message: string };

class NotJson extends Error {
  constructor(
    readonly at: number,
    message: string,
  ) {
    super(message);
  }
}

const SPACE = new Set([' ', '\t', '\n', '\r']);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

/** A field's path, as `checkSiteRules` names fields: `parts[0].article.title`. */
const childPath = (path: string, key: string | number) =>
  typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;

/**
 * Reads a JSON text, with a byte order mark at its start allowed: where
 * each field stands (by its path; the whole text is `''`), or where and why
 * it stops being JSON.
 */
export function scanJson(text: string): JsonScan {
  const spots = new Map<string, JsonSpot>();
  let at = text.startsWith('\uFEFF') ? 1 : 0;
  const space = () => {
    while (at < text.length && SPACE.has(text[at]!)) at++;
  };
  const fail = (message: string): never => {
    throw new NotJson(at, at >= text.length ? 'the text ends too soon' : message);
  };
  const string = (): string => {
    const start = at;
    at++;
    while (at < text.length) {
      const char = text[at]!;
      if (char === '"') {
        at++;
        return JSON.parse(text.slice(start, at)) as string;
      }
      if (char === '\\') {
        const next = text[at + 1];
        if (next === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(at + 2, at + 6))) {
            at++;
            fail('\\u must be followed by four hexadecimal digits');
          }
          at += 6;
          continue;
        }
        if (next === undefined || !ESCAPES.has(next)) {
          at++;
          fail('a \\ in text must be followed by ", \\, /, b, f, n, r, t or u');
        }
        at += 2;
        continue;
      }
      if (char.charCodeAt(0) < 0x20) {
        fail('text in quotation marks cannot hold a line break or a tab: write \\n or \\t');
      }
      at++;
    }
    return fail('the text ends too soon');
  };
  const value = (path: string, start: number): void => {
    space();
    const valueStart = at;
    const char = text[at];
    if (char === '{') {
      at++;
      space();
      if (text[at] === '}') at++;
      else {
        for (;;) {
          space();
          if (text[at] !== '"') fail('a name in double quotation marks is expected here');
          const keyStart = at;
          const key = string();
          space();
          if (text[at] !== ':') fail('a : is expected after the name');
          at++;
          value(childPath(path, key), keyStart);
          space();
          if (text[at] === ',') {
            at++;
            space();
            if (text[at] === '}') fail('a comma cannot stand after the last entry');
            continue;
          }
          if (text[at] === '}') {
            at++;
            break;
          }
          fail('a , or } is expected here');
        }
      }
    } else if (char === '[') {
      at++;
      space();
      if (text[at] === ']') at++;
      else {
        for (let index = 0; ; index++) {
          space();
          value(childPath(path, index), at);
          space();
          if (text[at] === ',') {
            at++;
            space();
            if (text[at] === ']') fail('a comma cannot stand after the last entry');
            continue;
          }
          if (text[at] === ']') {
            at++;
            break;
          }
          fail('a , or ] is expected here');
        }
      }
    } else if (char === '"') {
      string();
    } else if (char !== undefined && /[-0-9]/u.test(char)) {
      NUMBER.lastIndex = at;
      const match = NUMBER.exec(text);
      if (!match) fail('this is not a number as JSON writes one');
      at += match![0].length;
    } else {
      const word = ['true', 'false', 'null'].find((w) => text.startsWith(w, at));
      if (!word) {
        fail(
          char === "'"
            ? 'text and names must be in double quotation marks, not single ones'
            : char === '/'
              ? 'JSON has no comments'
              : 'a value is expected here: text in double quotation marks, a number, true, false, null, a list or an object',
        );
      }
      at += word!.length;
    }
    spots.set(path, { start, valueStart, valueEnd: at });
  };
  try {
    space();
    value('', at);
    space();
    if (at < text.length) fail('there is more after the end of the file’s object');
    return { ok: true, spots };
  } catch (error) {
    if (error instanceof NotJson) return { ok: false, at: error.at, message: error.message };
    throw error;
  }
}

/** A position in a text as its line and column, both from 1. */
export function lineAndColumnOf(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index).split('\n');
  return { line: before.length, column: before.at(-1)!.length + 1 };
}

/**
 * Where a field of a problem stands: the field itself, or for a field that
 * is not there (one that is missing) the nearest field around it that is.
 * The whole text's spot when none is.
 */
export function spotOfField(spots: ReadonlyMap<string, JsonSpot>, field: string): JsonSpot | null {
  let path = field;
  for (;;) {
    const spot = spots.get(path);
    if (spot) return spot;
    if (path === '') return null;
    const cut = Math.max(path.lastIndexOf('.'), path.lastIndexOf('['));
    path = cut < 0 ? '' : path.slice(0, cut);
  }
}

/** The text re-indented by two spaces, when it is JSON; null when it is not. */
export function formatJson(text: string): string | null {
  try {
    return `${JSON.stringify(JSON.parse(text.replace(/^\uFEFF/u, '')), null, 2)}\n`;
  } catch {
    return null;
  }
}
