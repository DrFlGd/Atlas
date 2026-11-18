/**
 * Reading the values of a map page in the app's window, for a map part of
 * a site rules file whose data is `"from": "values"` (see `siteRules.ts`
 * and "data" in the guide): one reader for every such file, run in the
 * page, and driven by what the file declares. Nothing in a file is ever
 * run: the reader is fixed code here, and what a file gives it is data,
 * made only from paths the checker has passed.
 *
 * What the reader does in the page, and nothing else:
 *
 * - it walks each declared page path from the page's window, one field at a
 *   time, taking a field only when it is the object's own plain value: it
 *   never runs a getter, never looks up an inherited field, and never calls
 *   a function, with one exception a file declares by name: a store's
 *   `getState`, called with no arguments, whose answer it walks by the
 *   value's path;
 * - for an element a file names (a script element that holds JSON, say),
 *   it reads the element's text and that text as JSON, and walks it by the
 *   value's path; the same for the element of a part whose data is
 *   `"from": "page"`, read in the window;
 * - it copies out only JSON data (text, numbers, true and false, null, lists
 *   and plain objects), and of those only the fields the part's other data
 *   paths name (a "keep" tree made from them), within fixed bounds of depth,
 *   count and size; anything else is left in the page;
 * - it changes nothing in the page and makes no request, and it answers
 *   nothing until every declared value is there, and every list the part
 *   reads (its maps, types and locations) holds something: an empty list,
 *   or one that is not there, counts only once the page has loaded and has
 *   been open for {@link PAGE_VALUES_EMPTY_WAIT_MS}. A page that asks whether the
 *   reader is a person holds none of the values, so the reader waits and
 *   the person answers, never the reader.
 *
 * The same reader, with the same declared values, makes the console line
 * the rules editor offers ({@link pageValuesConsoleLine}): pasted in a
 * browser's console on the map page, it saves what the window reader would
 * hand over as a `.json` file, which "Try on a saved page" takes.
 */

import { MAX_JSON_TEXT, dataPathSteps, pagePathProblem, selectorProblem } from './sitePatterns';
import {
  MAX_PAGE_VALUES,
  PAGE_VALUE_NAME_PATTERN,
  mapTopPaths,
  type RulesMapPart,
} from './siteRules';

/** The mark of what the reader hands over (`PageValues.atlasPageValues`). */
export const PAGE_VALUES_FORMAT = 1;
/** Depth of a value the reader copies at most, from the value a page path names. */
export const MAX_PAGE_VALUE_DEPTH = 24;
/** Lists, objects and values the reader copies at most, all values together. */
export const MAX_PAGE_VALUE_NODES = 4_000_000;
/** The longest text the reader copies; a longer one is left out and counted. */
export const MAX_PAGE_VALUE_TEXT = 200_000;
/** Characters of text the reader copies at most, all values together. */
export const MAX_PAGE_VALUE_CHARS = 48_000_000;
/** Entries of one list the reader copies at most. */
export const MAX_PAGE_VALUE_ENTRIES = 200_000;
/**
 * How long a page must have been open, once it has loaded, before the
 * reader takes a list of the part (its maps, types or locations) that is
 * empty or not there: a page's scripts may fill them a while after the
 * page has loaded.
 */
export const PAGE_VALUES_EMPTY_WAIT_MS = 15_000;

/** What the reader hands over: the declared values by their names. */
export interface PageValues {
  atlasPageValues: typeof PAGE_VALUES_FORMAT;
  values: Record<string, unknown>;
  /** How many parts of the values were left out for the bounds; 0 or absent for none. */
  cut?: number;
}

/**
 * The fields of a value that are kept: `1` for the whole value, or an
 * object of fields, where `*` stands for every entry of a list or every
 * value of an object.
 */
export type KeepTree = 1 | KeepFields;
/** The kept fields of an object, by name, `*` standing for every one. */
export interface KeepFields {
  [field: string]: KeepTree;
}

/**
 * One declared value as the reader takes it: steps from the window (or an
 * element), and for a store or an element the steps inside what it gives.
 */
export interface PageValueSpec {
  name: string;
  /** Field names and entry numbers from the page's window; empty for an element. */
  from: (string | number)[];
  /** How the value gives its data: its own (absent), a store's `getState`, or an element's JSON text. */
  call?: 'store' | 'element';
  /** For an element: its selector. */
  element?: string;
  /** For a store or an element: the steps inside what it gives. */
  inside?: (string | number)[];
}

/** What the reader is given: the values, the fields of each that are kept, and the lists it waits for. */
export interface PageValuesSpec {
  values: PageValueSpec[];
  keep: KeepFields;
  /** The lists of the part, each as a value's name and the fields to it, that must hold something before the page has settled. */
  wait: { name: string; steps: string[] }[];
}

/** The steps of a checked path as the reader takes them; null when a step is `[*]` or `[json]`, or it is not a path. */
function stepsOf(path: string): (string | number)[] | null {
  const steps = dataPathSteps(path);
  if (!steps) return null;
  const out: (string | number)[] = [];
  for (const step of steps) {
    if ('every' in step || 'json' in step) return null;
    out.push('field' in step ? step.field : step.entry);
  }
  return out;
}

/** Adds a path's steps to a keep tree; the end of the path keeps its whole value. */
function keepPath(tree: KeepFields, steps: readonly string[]): void {
  let node: KeepFields = tree;
  steps.forEach((step, index) => {
    const last = index === steps.length - 1;
    const known = node[step];
    if (known === 1) return;
    if (last) {
      node[step] = 1;
      return;
    }
    const next = known ?? {};
    node[step] = next;
    node = next;
  });
}

/**
 * A path's steps as keys of a keep tree: an entry number stands for every
 * entry, and a `[json]` step ends it, as the text it reads is kept whole.
 */
function keyStepsOf(path: string | undefined): string[] {
  if (path === undefined) return [];
  const keys: string[] = [];
  for (const step of dataPathSteps(path) ?? []) {
    if ('json' in step) break;
    keys.push('field' in step ? step.field : '*');
  }
  return keys;
}

/** The name the data of a part whose data is `"from": "page"` is handed over under, read in the window. */
export const PAGE_ELEMENT_VALUE = 'page';

/**
 * What the reader is given for a map part with `"from": "values"`, or with
 * `"from": "page"` read in the window: each declared value (for `page`, the
 * part's element, under the name {@link PAGE_ELEMENT_VALUE}) and the fields
 * of each that the part's data paths name. Null for a part of another form,
 * or one whose paths do not pass the checker (so nothing unchecked is ever
 * handed to the reader).
 */
export function pageValuesSpec(part: RulesMapPart): PageValuesSpec | null {
  const values: PageValueSpec[] = [];
  /** The name every top path is read under: none for values, which begin with their own. */
  let prefix: string[] = [];
  if (part.data.from === 'page') {
    const element = part.data.element;
    if (element === undefined || selectorProblem(element) !== null) return null;
    values.push({ name: PAGE_ELEMENT_VALUE, from: [], call: 'element', element, inside: [] });
    prefix = [PAGE_ELEMENT_VALUE];
  } else if (part.data.from === 'values' && part.data.values) {
    const entries = Object.entries(part.data.values);
    if (entries.length === 0 || entries.length > MAX_PAGE_VALUES) return null;
    for (const [name, value] of entries) {
      if (!PAGE_VALUE_NAME_PATTERN.test(name)) return null;
      if (typeof value === 'string') {
        const from = pagePathProblem(value) === null ? stepsOf(value) : null;
        if (!from) return null;
        values.push({ name, from });
        continue;
      }
      const inside = value.path === undefined ? [] : stepsOf(value.path);
      if (!inside || (value.path !== undefined && pagePathProblem(value.path, true) !== null)) {
        return null;
      }
      if ('element' in value) {
        if (selectorProblem(value.element) !== null) return null;
        values.push({ name, from: [], call: 'element', element: value.element, inside });
        continue;
      }
      const from = pagePathProblem(value.store) === null ? stepsOf(value.store) : null;
      if (!from) return null;
      values.push({ name, from, call: 'store', inside });
    }
  } else {
    return null;
  }
  const tree: KeepFields = {};
  const under = (list: string | undefined, fields: readonly (string | undefined)[]) => {
    if (list === undefined) return;
    const base = [...prefix, ...keyStepsOf(list)];
    const inEntry = fields.flatMap((field) => (field === undefined ? [] : [field]));
    if (inEntry.length === 0) keepPath(tree, base);
    for (const field of inEntry) keepPath(tree, [...base, ...keyStepsOf(field)]);
  };
  const { maps, types, locations } = part;
  if (part.game) keepPath(tree, [...prefix, ...keyStepsOf(part.game.name)]);
  const size = maps.size;
  const sizePaths = typeof size === 'string' ? [size] : size?.filter((s) => typeof s === 'string');
  const zoom = (value: unknown) => (typeof value === 'string' ? value : undefined);
  under(maps.path, [
    maps.id,
    maps.name,
    ...(sizePaths ?? []),
    zoom(maps.maxZoom),
    zoom(maps.minZoom),
    maps.group,
    maps.floor,
    maps.picture.pattern,
  ]);
  const shared = maps.shared;
  if (shared) {
    const sharedSize = typeof shared.size === 'string' ? [shared.size] : (shared.size ?? []);
    const facts = [shared.id, ...sharedSize, shared.maxZoom, shared.minZoom];
    // Only the facts it names: a shared object that names none (which the checker refuses) gives nothing.
    if (facts.some((fact) => fact !== undefined)) under(shared.path, facts);
  }
  const sets = maps.picture.sets;
  if (sets) {
    under(sets.path, [
      sets.map,
      sets.pattern,
      sets.extension,
      sets.minZoom,
      sets.maxZoom,
      sets.bounds,
    ]);
  }
  under(types.path, [types.id, types.name, types.group, types.icon, types.order]);
  if (types.groups) {
    under(types.groups.path, [types.groups.id, types.groups.name, types.groups.order]);
  }
  const pictures = locations.pictures;
  under(locations.path, [
    ...Object.values(locations.fields),
    ...(pictures
      ? [pictures.address, pictures.hidden].map((field) =>
          field === undefined ? undefined : `${pictures.path}.${field}`,
        )
      : []),
  ]);
  const names = new Set(values.map((value) => value.name));
  // The lists the part reads (each path up to its first `[*]` or entry), waited for.
  const wait: PageValuesSpec['wait'] = [];
  for (const { field, path } of mapTopPaths(part)) {
    if (field[0] === 'game') continue;
    const steps: string[] = [...prefix];
    for (const step of dataPathSteps(path) ?? []) {
      if (!('field' in step)) break;
      steps.push(step.field);
    }
    const [name, ...rest] = steps;
    if (name !== undefined && names.has(name)) wait.push({ name, steps: rest });
  }
  const keep: KeepFields = {};
  for (const [name, node] of Object.entries(tree)) {
    if (names.has(name)) keep[name] = node;
  }
  // A value no path of the part names is not taken at all; one named whole is taken whole.
  if (prefix.length === 0) {
    for (const { path } of mapTopPaths(part)) {
      const first = keyStepsOf(path)[0];
      if (first !== undefined && !names.has(first)) return null;
    }
  }
  return { values: values.filter((value) => keep[value.name] !== undefined), keep, wait };
}

/** The name the JSON of a list of games' element is handed over under (see {@link gamesListSpec}). */
export const GAMES_LIST_VALUE = 'games';

/**
 * What the reader is given for the site's list of games of a map part
 * (`games`): the JSON of the list page's element, under the name
 * {@link GAMES_LIST_VALUE}, and of it only the list and, in each game, the
 * fields its data paths name. Null for a part without `games`, or one whose
 * paths do not pass the checker.
 */
export function gamesListSpec(part: RulesMapPart): PageValuesSpec | null {
  const games = part.games;
  if (!games || selectorProblem(games.element) !== null) return null;
  const paths = [games.path, games.id, games.name, games.only?.path];
  if (paths.some((path) => path !== undefined && dataPathSteps(path) === null)) return null;
  const tree: KeepFields = {};
  const base = keyStepsOf(games.path);
  for (const field of [games.id, games.name, games.only?.path]) {
    if (field !== undefined) keepPath(tree, [...base, ...keyStepsOf(field)]);
  }
  const steps: string[] = [];
  for (const step of dataPathSteps(games.path) ?? []) {
    if (!('field' in step)) break;
    steps.push(step.field);
  }
  return {
    values: [
      { name: GAMES_LIST_VALUE, from: [], call: 'element', element: games.element, inside: [] },
    ],
    keep: { [GAMES_LIST_VALUE]: tree },
    wait: [{ name: GAMES_LIST_VALUE, steps }],
  };
}

/** The window reader of a part's list of games: {@link PAGE_VALUES_READER} with {@link gamesListSpec}. */
export function gamesListReader(part: RulesMapPart): string | null {
  const spec = gamesListSpec(part);
  return spec ? `() => (${PAGE_VALUES_READER})(${specText(spec)})` : null;
}

/**
 * The reader, as the source of a function of one argument (the spec): run
 * in the page, it returns {@link PageValues}, or null while a declared value
 * is not there. Plain JavaScript, exactly as the page receives it.
 */
export const PAGE_VALUES_READER = String.raw`(spec) => {
  const win = window;
  const doc = win.document;
  if (!doc || doc.readyState === 'loading') return null;
  const clock = win.performance;
  const settled =
    doc.readyState === 'complete' &&
    (!clock || typeof clock.now !== 'function' || clock.now() >= ${PAGE_VALUES_EMPTY_WAIT_MS});
  const own = (value, key) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && 'value' in field ? field.value : undefined;
  };
  const walk = (value, steps) => {
    let at = value;
    for (const step of steps) {
      if (at === undefined || at === null) return undefined;
      if (typeof step === 'number') {
        at = Array.isArray(at) ? own(at, String(step)) : undefined;
      } else {
        at = own(at, step);
      }
    }
    return at;
  };
  const plain = (value) => {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  };
  const join = (a, b) => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    if (a === 1 || b === 1) return 1;
    const out = {};
    for (const key of Object.keys(a)) out[key] = a[key];
    for (const key of Object.keys(b)) out[key] = join(out[key], b[key]);
    return out;
  };
  let nodes = 0;
  let chars = 0;
  let cut = 0;
  const copy = (value, keep, depth) => {
    if (value === null) return null;
    const type = typeof value;
    if (type === 'string') {
      if (value.length > ${MAX_PAGE_VALUE_TEXT} || chars + value.length > ${MAX_PAGE_VALUE_CHARS}) {
        cut++;
        return undefined;
      }
      chars += value.length;
      return value;
    }
    if (type === 'number') return Number.isFinite(value) ? value : null;
    if (type === 'boolean') return value;
    if (type !== 'object') return undefined;
    if (depth >= ${MAX_PAGE_VALUE_DEPTH} || nodes >= ${MAX_PAGE_VALUE_NODES}) {
      cut++;
      return undefined;
    }
    nodes++;
    if (Array.isArray(value)) {
      if (keep !== 1 && keep['*'] === undefined) return [];
      const inner = keep === 1 ? 1 : keep['*'];
      const length = own(value, 'length');
      const count = typeof length === 'number' ? Math.min(length, ${MAX_PAGE_VALUE_ENTRIES}) : 0;
      if (typeof length === 'number' && length > count) cut++;
      const out = [];
      for (let i = 0; i < count; i++) {
        const entry = copy(own(value, String(i)), inner, depth + 1);
        out.push(entry === undefined ? null : entry);
      }
      return out;
    }
    if (!plain(value)) return undefined;
    const out = {};
    const keys = keep === 1 || keep['*'] !== undefined ? Object.keys(value) : Object.keys(keep);
    for (const key of keys) {
      if (key === '__proto__') continue;
      const inner = keep === 1 ? 1 : join(keep[key], keep['*']);
      if (inner === undefined) continue;
      const entry = copy(own(value, key), inner, depth + 1);
      if (entry !== undefined) out[key] = entry;
    }
    return out;
  };
  const empty = (value) =>
    (Array.isArray(value) && value.length === 0) ||
    (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
  const method = (value, key) => {
    let at = value;
    for (let i = 0; i < 8 && at !== null && (typeof at === 'object' || typeof at === 'function'); i++) {
      const field = Object.getOwnPropertyDescriptor(at, key);
      if (field) return 'value' in field && typeof field.value === 'function' ? field.value : undefined;
      at = Object.getPrototypeOf(at);
    }
    return undefined;
  };
  const values = {};
  for (const one of spec.values) {
    let value;
    if (one.call === 'element') {
      const element = doc.querySelector(one.element);
      const text = element ? element.textContent : null;
      if (typeof text !== 'string' || text.length > ${MAX_JSON_TEXT}) return null;
      try {
        value = JSON.parse(text);
      } catch (error) {
        return null;
      }
    } else {
      value = walk(win, one.from);
    }
    if (one.call === 'store') {
      const read = method(value, 'getState');
      if (!read) return null;
      try {
        value = read.call(value);
      } catch (error) {
        return null;
      }
    }
    if (one.inside) value = walk(value, one.inside);
    if (value === undefined || value === null) return null;
    if (!settled && empty(value)) return null;
    const copied = copy(value, spec.keep[one.name] === undefined ? 1 : spec.keep[one.name], 0);
    if (copied === undefined) return null;
    values[one.name] = copied;
  }
  if (!settled) {
    for (const list of spec.wait || []) {
      let at = values[list.name];
      for (const step of list.steps) at = at === null || typeof at !== 'object' ? undefined : at[step];
      if (at === undefined || at === null || empty(at)) return null;
    }
  }
  return cut > 0 ? { atlasPageValues: 1, values, cut } : { atlasPageValues: 1, values };
}`;

/** The spec as a JavaScript value: JSON, with the characters that could end a script written as escapes. */
function specText(spec: PageValuesSpec): string {
  return JSON.stringify(spec)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}

/**
 * The page reader for a map part read in the window (`"from": "values"`, or
 * `"from": "page"`): a function of no arguments that runs
 * {@link PAGE_VALUES_READER} with the part's declared values. Null for a
 * part of another form, or one whose paths are not usable.
 */
export function pageValuesReader(part: RulesMapPart): string | null {
  const spec = pageValuesSpec(part);
  return spec ? `() => (${PAGE_VALUES_READER})(${specText(spec)})` : null;
}

/** The name of the file the console line saves. */
export const PAGE_VALUES_FILE_NAME = 'map-values.json';

/**
 * A line to paste in a browser's console on the map page, which saves what
 * the window reader would hand over as a `.json` file
 * ({@link PAGE_VALUES_FILE_NAME}), or says that the values are not there
 * yet. It is made from the part's checked paths only, by the same reader
 * the app runs, so it takes nothing the app would not. Null for a part
 * whose data is neither `"from": "values"` nor `"from": "page"`.
 */
export function pageValuesConsoleLine(part: RulesMapPart): string | null {
  const spec = pageValuesSpec(part);
  if (!spec) return null;
  return [
    '(() => {',
    ` const got = (${PAGE_VALUES_READER.replace(/\n\s*/gu, ' ')})(${specText(spec)});`,
    " if (!got) { console.log('The map’s values are not there yet. Wait until the map has loaded, then paste the line again.'); return; }",
    " const link = document.createElement('a');",
    " link.href = URL.createObjectURL(new Blob([JSON.stringify(got)], { type: 'application/json' }));",
    ` link.download = '${PAGE_VALUES_FILE_NAME}';`,
    ' link.click();',
    '})();',
  ].join('');
}

/**
 * Whether every value a part declares is an element of the page whose text
 * is JSON (`{ "element": … }`): such values are in a saved copy of the map
 * page too, so "Try on a saved page" can take them from it
 * ({@link pageValuesOfElements}).
 */
export function valuesAreElements(part: RulesMapPart): boolean {
  const values = part.data.from === 'values' ? Object.values(part.data.values ?? {}) : [];
  return (
    values.length > 0 && values.every((value) => typeof value === 'object' && 'element' in value)
  );
}

/** A JSON value's own field, or an entry of a list by its number; undefined for anything else. */
function ownStep(value: unknown, step: string | number): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  if (typeof step === 'number') return Array.isArray(value) ? (value[step] as unknown) : undefined;
  return Object.hasOwn(value, step) ? (value as Record<string, unknown>)[step] : undefined;
}

/**
 * The values of a part whose values are all elements of the page
 * ({@link valuesAreElements}), taken from a saved copy of the map page, as
 * the window reader takes them from the page it has open: each element's
 * text read as JSON (at most {@link MAX_JSON_TEXT} characters), walked by
 * the value's path, and of that only the fields the part's data paths name,
 * within the reader's bounds of depth, count and size. `textOf` gives the
 * text of the first element a selector finds in the saved page, or null
 * when it finds none: the page is only parsed as text, never loaded. Null
 * for a part of another form; else the values, or a plain sentence that
 * says which value is missing.
 */
export function pageValuesOfElements(
  part: RulesMapPart,
  textOf: (selector: string) => string | null,
): PageValues | { problem: string } | null {
  if (!valuesAreElements(part)) return null;
  const spec = pageValuesSpec(part);
  if (!spec) return null;
  let nodes = 0;
  let chars = 0;
  let cut = 0;
  const copy = (value: unknown, keep: KeepTree, depth: number): unknown => {
    if (value === null) return null;
    if (typeof value === 'string') {
      if (value.length > MAX_PAGE_VALUE_TEXT || chars + value.length > MAX_PAGE_VALUE_CHARS) {
        cut++;
        return undefined;
      }
      chars += value.length;
      return value;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'object') return undefined;
    if (depth >= MAX_PAGE_VALUE_DEPTH || nodes >= MAX_PAGE_VALUE_NODES) {
      cut++;
      return undefined;
    }
    nodes++;
    if (Array.isArray(value)) {
      if (keep !== 1 && keep['*'] === undefined) return [];
      const inner = keep === 1 ? 1 : keep['*']!;
      const count = Math.min(value.length, MAX_PAGE_VALUE_ENTRIES);
      if (value.length > count) cut++;
      const out: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const entry = copy(value[i], inner, depth + 1);
        out.push(entry === undefined ? null : entry);
      }
      return out;
    }
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = keep === 1 || keep['*'] !== undefined ? Object.keys(record) : Object.keys(keep);
    for (const key of keys) {
      if (key === '__proto__' || !Object.hasOwn(record, key)) continue;
      const inner = keep === 1 ? 1 : joinKeep(keep[key], keep['*']);
      if (inner === undefined) continue;
      const entry = copy(record[key], inner, depth + 1);
      if (entry !== undefined) out[key] = entry;
    }
    return out;
  };
  const values: Record<string, unknown> = {};
  for (const one of spec.values) {
    const selector = one.element ?? '';
    const field = `data.values.${one.name}`;
    const text = textOf(selector);
    if (text === null) {
      return { problem: `The saved page has no element ${selector} (${field}).` };
    }
    if (text.length > MAX_JSON_TEXT) {
      return { problem: `The text of the element ${selector} (${field}) is too large to read.` };
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return { problem: `The text of the element ${selector} (${field}) is not JSON.` };
    }
    for (const step of one.inside ?? []) value = ownStep(value, step);
    if (value === undefined || value === null) {
      return {
        problem: `The path of ${field} found nothing in the JSON of the element ${selector}.`,
      };
    }
    const copied = copy(value, spec.keep[one.name] ?? 1, 0);
    if (copied === undefined) {
      return { problem: `The value of ${field} is too large to read.` };
    }
    values[one.name] = copied;
  }
  return cut > 0
    ? { atlasPageValues: PAGE_VALUES_FORMAT, values, cut }
    : { atlasPageValues: PAGE_VALUES_FORMAT, values };
}

/** Two keep trees joined, as the window reader joins them: a whole value wins. */
function joinKeep(a: KeepTree | undefined, b: KeepTree | undefined): KeepTree | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === 1 || b === 1) return 1;
  const out: KeepFields = { ...a };
  for (const key of Object.keys(b)) out[key] = joinKeep(out[key], b[key])!;
  return out;
}

/**
 * What a window reader handed over, or a `.json` file the console line
 * saved, checked: the values by their names, or null when it is not that.
 */
export function pageValuesOf(value: unknown): PageValues | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.atlasPageValues !== PAGE_VALUES_FORMAT) return null;
  const values = record.values;
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return null;
  const cut = typeof record.cut === 'number' && record.cut > 0 ? Math.floor(record.cut) : 0;
  return {
    atlasPageValues: PAGE_VALUES_FORMAT,
    values: values as Record<string, unknown>,
    ...(cut > 0 ? { cut } : {}),
  };
}
