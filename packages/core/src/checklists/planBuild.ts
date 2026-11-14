import { parseId, type ChecklistItem, type OwnList } from '@atlas/schema';
import type { LoadedPack } from '../pack/loadedPack';
import { nameKey } from '../guides/linking';
import type { LocationNameIndex } from '../guides/locationNames';
import { changeStep, insertRows, newStep, stepsOf } from './ownLists';

/**
 * The build planner: things collected into a Build guide (a wiki page, a
 * row of a page's table, a location), and their locations found on the map.
 *
 * A thing collected is an ordinary step of an own list: its name, a note
 * that starts with a link to its page when it came from one, and its
 * location when it came from one. Nothing else is kept, so a list of the
 * planner is a list like any other and its file is unchanged. The page a
 * step is about is the page its note starts with a link to (see
 * {@link stepPageId}).
 *
 * "Find on the map" looks, for each step with no location yet, in this
 * order, and stops at the first that gives any location:
 *
 * 1. the locations the step's page is linked to (the person's links between
 *    pages and the map: a name, one location, a type, a region);
 * 2. the locations whose name fits the step's name (see `locationNames.ts`);
 * 3. the page itself: its part about where the thing is, under a general
 *    heading ("Location", "Where to find", "How to get" and the like, see
 *    {@link isLocationWords}), in a table column or a row of that name, or a
 *    line that starts with it. Its links to pages linked to the map and to
 *    locations, and the location names written in it, count.
 *
 * One location is found; several are possible, for the person to choose
 * one; none is not found. Nothing is put on a step here: the app shows what
 * was found and puts what the person confirms (see {@link placeLocations}).
 * A step keeps one location, since a step of several is done only when
 * every one is found.
 *
 * Only general words and the structure of pages and links: nothing here
 * knows a game, a site or a wiki.
 */

// ---------------------------------------------------------------------------
// Collecting

/** A thing to add to a build: a page, a row of a page's table, or a location. */
export interface BuildThing {
  name: string;
  /** The page it came from, linked at the start of the step's note. */
  guideId?: string;
  /** The location it came from (a location's card). */
  locationId?: string;
}

/** How long a step's name may be, as the list editor lets it be typed. */
const MOST_NAME = 200;

/** Markdown link text: brackets and backslashes escaped. */
function linkText(text: string): string {
  return text.replace(/([\\[\]])/g, '\\$1');
}

/** A thing's name as a step keeps it: on one line, trimmed, not too long. */
export function thingName(name: string): string {
  return name.replace(/\s+/gu, ' ').trim().slice(0, MOST_NAME).trim();
}

/** The note of a step made from a thing: a link to its page, or none. */
export function thingNote(thing: BuildThing): string | undefined {
  return thing.guideId ? `[${linkText(thingName(thing.name))}](${thing.guideId})` : undefined;
}

const NOTE_LINK = /^\s*\[(?:\\.|[^\]\\])*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/u;

/** The page a step is about: the page its note starts with a link to, or null. */
export function stepPageId(item: Pick<ChecklistItem, 'note'>): string | null {
  const match = item.note ? NOTE_LINK.exec(item.note) : null;
  const target = match?.[1];
  return target && parseId(target)?.kind === 'guide' ? target : null;
}

/**
 * The step of a list that already is the thing, if any: one about the same
 * page, one at the same location, or one of the same name about no page.
 * `samePage` says whether two page ids are the same page (one may be
 * another name of the other).
 */
export function stepOfThing(
  list: OwnList,
  thing: BuildThing,
  samePage: (a: string, b: string) => boolean = (a, b) => a === b,
): ChecklistItem | undefined {
  const key = nameKey(thing.name);
  return list.items.find((item) => {
    const page = stepPageId(item);
    if (thing.locationId) return item.locationIds.includes(thing.locationId);
    if (thing.guideId && page) return samePage(page, thing.guideId);
    return page === null && key !== '' && nameKey(item.name) === key;
  });
}

/** The list with the thing as a new step at its end. */
export function addThing(list: OwnList, thing: BuildThing, stepId: string): OwnList {
  const note = thingNote(thing);
  const row = newStep(list, stepId, {
    name: thingName(thing.name),
    ...(thing.locationId ? { locationIds: [thing.locationId] } : {}),
    ...(note ? { note } : {}),
  });
  return insertRows(list, null, [row]);
}

// ---------------------------------------------------------------------------
// Where a page says a thing is

/**
 * The general words of a heading, a table column or a line about where a
 * thing is, compared tidied (case, punctuation and plurals do not count).
 */
const LOCATION_WORDS = new Set(
  [
    'Location',
    'Where to find',
    'Where to find it',
    'Where to find them',
    'Where found',
    'Where',
    'Found in',
    'Found at',
    'Found',
    'Can be found',
    'How to find',
    'How to get',
    'How to get it',
    'How to obtain',
    'How to obtain it',
    'How to acquire',
    'Obtained',
    'Obtained from',
    'Obtained in',
    'Obtaining',
    'Obtain',
    'Acquired',
    'Acquired from',
    'Acquisition',
  ].map(nameKey),
);

/** Whether a heading, a column's title or a line's start says where a thing is. */
export function isLocationWords(text: string): boolean {
  const key = nameKey(text.replace(/[*_`:]+/gu, ' '));
  return key !== '' && LOCATION_WORDS.has(key);
}

/** What a page's part about where a thing is holds. */
export interface LocationParts {
  /** The targets of its in-app links (pages and locations), each once, in order. */
  links: string[];
  /** Its text, a piece at a time (a line, a cell), links as their words. */
  texts: string[];
  /** Pieces that may be a name on their own: cells, list items and links' words. */
  names: string[];
}

const LINK = /\[((?:\\.|[^\]\\])*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu;

/** A piece of Markdown as words: links as their words, marks and pictures left out. */
function plainOf(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(LINK, (_whole, words: string) => words.replace(/\\(.)/gu, '$1'))
    .replace(/<br\s*\/?>/giu, ' ')
    .replace(/(\*\*|__|~~|`|\^)/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Hidden text (`||like this||`) left out of one line, carried over lines by `open`. */
function withoutHidden(line: string, state: { open: boolean }): string {
  const pieces = line.replace(/\\\|/gu, '\u0001').split('||');
  let out = '';
  pieces.forEach((piece, i) => {
    if (i > 0) state.open = !state.open;
    if (!state.open) out += piece;
    else out += ' ';
  });
  return out.replaceAll('\u0001', '|');
}

/** The cells of a table row, hidden text left out of each. */
function cellsOf(line: string): string[] {
  const inner = line.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  return inner
    .replace(/\\\|/gu, '\u0001')
    .split(/(?<!\|)\|(?!\|)/u)
    .map((cell) => withoutHidden(cell, { open: false }).replaceAll('\u0001', '|').trim());
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u;
const RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/u;
const LABEL = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?([^:*_|]{2,40}?)(?:\*\*|__)?\s*:(?:\*\*|__)?\s*(.+)$/u;

/**
 * A page's parts about where a thing is (see the top of this file): the
 * part under a heading of general words, up to the next heading as high;
 * in a table, the cells of a column of that title and the rest of a row of
 * that first cell (a box of facts); and the rest of a line that starts
 * with them and a colon. Hidden text is left out, so nothing found gives
 * an answer away. Read line by line, without a Markdown parser.
 */
export function locationParts(body: string): LocationParts {
  const links: string[] = [];
  const texts: string[] = [];
  const names: string[] = [];
  const addPiece = (markdown: string, name: boolean) => {
    const plain = plainOf(markdown);
    if (!plain) return;
    texts.push(plain);
    if (name) names.push(plain);
    for (const match of markdown.matchAll(LINK)) {
      const target = match[2]!;
      if (parseId(target) && !links.includes(target)) links.push(target);
      const words = plainOf(match[1]!);
      if (words) names.push(words);
    }
  };

  const hidden = { open: false };
  const lines = body.split(/\r?\n/u);
  /** The level of the heading whose part this is, or 0 outside one. */
  let part = 0;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (/^ {0,3}(`{3,}|~{3,})/u.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (/^\s*\|/u.test(raw)) {
      // A table: its rows up to the first line that is not one.
      const rows: string[][] = [];
      let j = i;
      for (; j < lines.length && /^\s*\|/u.test(lines[j]!); j++) {
        if (!RULE.test(lines[j]!)) rows.push(cellsOf(lines[j]!));
      }
      i = j - 1;
      readTable(rows, part > 0);
      continue;
    }
    const line = withoutHidden(raw, hidden);
    if (hidden.open && !line.trim()) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (isLocationWords(heading[2]!)) part = level;
      else if (part > 0 && level <= part) part = 0;
      continue;
    }
    if (part > 0) {
      const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/u.exec(line);
      addPiece(item ? item[1]! : line, item !== null);
      continue;
    }
    const label = LABEL.exec(line);
    if (label && isLocationWords(label[1]!)) addPiece(label[2]!, true);
  }

  /** A table: every cell in a part; else the cells of a column, or a row, of general words. */
  function readTable(rows: string[][], inPart: boolean): void {
    if (rows.length === 0) return;
    if (inPart) {
      for (const row of rows) for (const cell of row) addPiece(cell, true);
      return;
    }
    const [head, ...body] = rows;
    const columns = head!.map((cell, at) => (isLocationWords(plainOf(cell)) ? at : -1));
    for (const row of body) {
      row.forEach((cell, at) => {
        if (columns[at] === at) addPiece(cell, true);
      });
    }
    // A box of facts: a row whose first cell says where, the rest of it.
    for (const row of rows) {
      if (row.length > 1 && isLocationWords(plainOf(row[0]!))) {
        for (const cell of row.slice(1)) addPiece(cell, true);
      }
    }
  }

  return { links, texts, names };
}

// ---------------------------------------------------------------------------
// Finding

/** Where the locations of a step were found. */
export type FoundBy = 'linked' | 'name' | 'page';

/** What "Find on the map" found for one step. */
export interface StepFinding {
  stepId: string;
  name: string;
  /** One location; several possible; or none. */
  outcome: 'found' | 'several' | 'none';
  /** Where they were found; null when none was. */
  by: FoundBy | null;
  /** The locations, each once (one when found). */
  locationIds: string[];
}

/** What finding needs of the app: the person's links, the pages, the names of the map. */
export interface BuildFinder {
  /** The page of an id as the game has it now (an old id of it, say), or null when it has none. */
  pageId(guideId: string): string | null;
  /** A page's text, in Markdown. */
  pageBody(guideId: string): string | undefined;
  /** The locations a page is linked to on the map, each once; none when it is not linked. */
  linkedLocations(guideId: string): readonly string[];
  /** Whether a location is on the map. */
  hasLocation(locationId: string): boolean;
  /** The map's location names (made once per game). */
  names: LocationNameIndex;
}

/** The locations a step's name fits: the same name, else names spelt near it. */
function byName(name: string, finder: BuildFinder): { ids: string[]; sure: boolean } {
  const hits = finder.names.find(name);
  const exact = hits.find((hit) => hit.exact);
  if (exact) return { ids: exact.ids, sure: true };
  return { ids: [...new Set(hits.flatMap((hit) => hit.ids))], sure: false };
}

/** The locations a page's part about where a thing is names or links to. */
function byPage(pageId: string, finder: BuildFinder): string[] {
  const body = finder.pageBody(pageId);
  if (!body) return [];
  const parts = locationParts(body);
  const ids = new Set<string>();
  for (const target of parts.links) {
    const kind = parseId(target)?.kind;
    if (kind === 'loc') {
      if (finder.hasLocation(target)) ids.add(target);
    } else if (kind === 'guide') {
      const page = finder.pageId(target);
      if (page && page !== pageId) for (const id of finder.linkedLocations(page)) ids.add(id);
    }
  }
  for (const text of parts.texts) {
    for (const hit of finder.names.namesIn(text)) for (const id of hit.ids) ids.add(id);
  }
  // A cell or an item that is a name, spelt a little otherwise.
  if (ids.size === 0) {
    for (const name of parts.names) {
      if (name.split(' ').length > 6) continue;
      const hit = finder.names.find(name).find((h) => h.exact || h.score >= 0.85);
      if (hit) for (const id of hit.ids) ids.add(id);
    }
  }
  return [...ids].filter((id) => finder.hasLocation(id));
}

/** Where one step may be on the map (see the top of this file). */
export function findStep(item: ChecklistItem, finder: BuildFinder): StepFinding {
  const result = (by: FoundBy | null, ids: readonly string[], sure: boolean): StepFinding => {
    const locationIds = [...new Set(ids)];
    return {
      stepId: item.id,
      name: item.name,
      outcome:
        locationIds.length === 0 ? 'none' : locationIds.length === 1 && sure ? 'found' : 'several',
      by: locationIds.length === 0 ? null : by,
      locationIds,
    };
  };
  const noted = stepPageId(item);
  const page = noted ? finder.pageId(noted) : null;
  if (page) {
    const linked = finder.linkedLocations(page).filter((id) => finder.hasLocation(id));
    if (linked.length > 0) return result('linked', linked, true);
  }
  const named = byName(item.name, finder);
  const known = named.ids.filter((id) => finder.hasLocation(id));
  if (known.length > 0) return result('name', known, named.sure);
  if (page) {
    const inPage = byPage(page, finder);
    if (inPage.length > 0) return result('page', inPage, true);
  }
  return result(null, [], false);
}

/** What finding gives a list: its steps with no location, each as found. */
export interface BuildFindings {
  findings: StepFinding[];
  /** Steps that have a location already, left as they are. */
  located: number;
}

/** "Find on the map" for every step of a list that has no location on the map. */
export function findSteps(list: OwnList, finder: BuildFinder): BuildFindings {
  const findings: StepFinding[] = [];
  let located = 0;
  for (const item of stepsOf(list)) {
    if (item.locationIds.some((id) => finder.hasLocation(id))) {
      located++;
      continue;
    }
    findings.push(findStep(item, finder));
  }
  return { findings, located };
}

/**
 * The possible locations of a step, nearest first to the step before it
 * that has a location (or, failing one, the step after it), those on its
 * map first; in the order found when no step has a location.
 */
export function nearestCandidates(
  list: OwnList,
  pack: LoadedPack,
  stepId: string,
  locationIds: readonly string[],
): string[] {
  const steps = stepsOf(list);
  const at = steps.findIndex((step) => step.id === stepId);
  const located = (step: ChecklistItem | undefined) =>
    step?.locationIds.map((id) => pack.locations.get(id)).find((l) => l !== undefined);
  let from = undefined as ReturnType<typeof located>;
  for (let i = at - 1; i >= 0 && !from; i--) from = located(steps[i]);
  for (let i = at + 1; i < steps.length && !from; i++) from = located(steps[i]);
  if (!from) return [...locationIds];
  const anchor = from;
  const distance = (id: string) => {
    const location = pack.locations.get(id);
    if (!location) return Infinity;
    const away = location.mapId === anchor.mapId ? 0 : 1e18;
    return away + (location.x - anchor.x) ** 2 + (location.y - anchor.y) ** 2;
  };
  return locationIds
    .map((id, index) => ({ id, index, distance: distance(id) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .map((entry) => entry.id);
}

/**
 * The list with locations put on its steps, as the person confirmed them:
 * by step id, one location each (in place of any it had that the map does
 * not have). A step no longer in the list is left out.
 */
export function placeLocations(list: OwnList, chosen: ReadonlyMap<string, string>): OwnList {
  let out = list;
  for (const [stepId, locationId] of chosen) {
    if (!out.items.some((i) => i.id === stepId)) continue;
    out = changeStep(out, stepId, { locationIds: [locationId] });
  }
  return out;
}
