import {
  isOwnId,
  makeId,
  MAX_HEADING_LENGTH,
  OWN_ID_PREFIX,
  parseId,
  type ChecklistItem,
  type ChecklistType,
  type OwnHeading,
  type OwnList,
} from '@atlas/schema';
import type { LoadedPack } from '../pack/loadedPack';
import type { ChecklistEntry } from './checklists';
import { followsSteps, listType } from './listTypes';

/**
 * A person's own lists (see `ownLists.ts` in the schema package): making
 * them, copying a pack's list, changing them step by step, and what the app
 * shows of them. Every function here is pure: it returns a new list and
 * leaves the one it was given as it was, so a change can be undone by
 * keeping the list from before.
 *
 * A list's outline is its headings and its steps (its items) in one order:
 * each has an `order`, and the items' `section` is always the title of the
 * heading above them, so the views made for packs' lists show the headings
 * as their stages.
 */

/** Where random parts of ids come from; tests give their own. */
export type RandomText = () => string;

/** The kinds of record a person makes, each with own ids (see `OWN_ID_PREFIX`). */
export type OwnIdKind = 'checklist' | 'checkitem' | 'loc' | 'cat' | 'catgroup' | 'region';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Eight random letters and digits. */
export const randomText: RandomText = () => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
};

/**
 * A new own id of a game: `<gameId>:<kind>:own.<random>`, never one in
 * `taken`. Own ids are valid content ids, and packs may not use them, so
 * they never collide with a pack's.
 */
export function newOwnId(
  gameId: string,
  kind: OwnIdKind,
  taken: ReadonlySet<string>,
  random: RandomText = randomText,
): string {
  for (;;) {
    const id = makeId(gameId, kind, `${OWN_ID_PREFIX}${random()}`);
    if (!taken.has(id)) return id;
  }
}

/** Every id a list uses: its own, its steps' and its headings'. */
export function idsOf(list: OwnList): string[] {
  return [list.checklist.id, ...list.items.map((i) => i.id), ...list.headings.map((h) => h.id)];
}

/** An id maker that remembers what it gave, so one change never gives an id twice. */
export function idMaker(
  gameId: string,
  taken: Iterable<string>,
  random: RandomText = randomText,
): (kind: 'checklist' | 'checkitem') => string {
  const used = new Set(taken);
  return (kind) => {
    const id = newOwnId(gameId, kind, used, random);
    used.add(id);
    return id;
  };
}

// ---------------------------------------------------------------------------
// Templates

/** What each template is, in the order the app offers them. */
export const TEMPLATES: readonly {
  type: ChecklistType;
  name: string;
  /** One line on what it is for. */
  line: string;
  /** What it offers, as the template card's last line. */
  offers: string;
  /** What a list of it starts with, to show once it is chosen. */
  startsWith: readonly string[];
}[] = [
  {
    type: 'collection',
    name: 'Collection',
    line: 'Things to find, grouped by area or by type.',
    offers: 'By area · By type',
    startsWith: ['Grouped by area or by type', 'Found marks from the map', 'A note on every entry'],
  },
  {
    type: 'secrets',
    name: 'Secrets guide',
    line: 'Clues, with each answer hidden until you ask for it.',
    offers: 'By area · Hidden answers',
    startsWith: ['Grouped by area or by type', 'Hidden text in notes', 'Links to locations'],
  },
  {
    type: 'photos',
    name: 'Photo guide',
    line: 'A picture of each spot, with a line on how to reach it.',
    offers: 'By area · Photos',
    startsWith: [
      'Grouped by area or by type',
      'A note on every entry',
      'Photos in a later version',
    ],
  },
  {
    type: 'route',
    name: '100% route',
    line: 'Everything in the game, in the order to do it.',
    offers: 'In order · By area · By type',
    startsWith: ['Followed in order, with Next up', 'Headings for stages', 'Optional steps'],
  },
  {
    type: 'build',
    name: 'Build guide',
    line: 'Steps to put a character build together, in order.',
    offers: 'In order · Steps without a location',
    startsWith: [
      'Followed in order, with Next up',
      'Steps that have no location',
      'Optional steps',
      'A note on every step',
    ],
  },
  {
    type: 'plain',
    name: 'Plain list',
    line: 'Tick boxes with no locations on the map.',
    offers: 'As written',
    startsWith: ['Shown as written', 'Tick boxes of their own', 'A note on every entry'],
  },
];

/** The name of a template, as the app says it. */
export function templateName(type: ChecklistType): string {
  return TEMPLATES.find((t) => t.type === type)?.name ?? 'List';
}

/**
 * Whether a template's steps are followed in order, with Next up: its
 * steps are numbered and joined on the map, and a step may be optional.
 */
export function isOrdered(type: ChecklistType): boolean {
  return followsSteps(type);
}

// ---------------------------------------------------------------------------
// Making lists

/** A new, empty own list. */
export function newOwnList(
  gameId: string,
  name: string,
  type: ChecklistType,
  now: Date,
  taken: Iterable<string>,
  random: RandomText = randomText,
): OwnList {
  const id = newOwnId(gameId, 'checklist', new Set(taken), random);
  const time = now.toISOString();
  return {
    checklist: { id, name: name.trim() || 'My list', order: 0, type },
    items: [],
    headings: [],
    createdAt: time,
    updatedAt: time,
  };
}

/**
 * An own list made from one of the game's lists: the same name, type,
 * steps, notes and sections (as headings), with ids of its own. The game's
 * list is not changed. The copy's type is the list's type as the app shows
 * it, worked out when the pack does not say (see `listType`).
 */
export function copyList(
  entry: ChecklistEntry,
  gameId: string,
  now: Date,
  taken: Iterable<string>,
  random: RandomText = randomText,
  name = entry.checklist.name,
): OwnList {
  const next = idMaker(gameId, taken, random);
  const id = next('checklist');
  const time = now.toISOString();
  const headings: OwnHeading[] = [];
  const items: ChecklistItem[] = [];
  let order = 0;
  let section: string | undefined;
  for (const { item } of entry.items) {
    if (item.section !== undefined && item.section !== section) {
      headings.push({ id: next('checkitem'), title: item.section, order: order++ });
    }
    section = item.section;
    items.push({
      id: next('checkitem'),
      checklistId: id,
      name: item.name,
      order: order++,
      locationIds: [...item.locationIds],
      entityIds: [...item.entityIds],
      ...(item.section !== undefined ? { section: item.section } : {}),
      ...(item.note !== undefined ? { note: item.note } : {}),
      ...(item.optional ? { optional: true } : {}),
    });
  }
  return {
    checklist: {
      id,
      name,
      order: 0,
      type: listType(entry),
      ...(entry.checklist.description !== undefined
        ? { description: entry.checklist.description }
        : {}),
    },
    items,
    headings,
    copiedFrom: entry.checklist.id,
    createdAt: time,
    updatedAt: time,
  };
}

/**
 * An own list as the app's views take a list (as `ChecklistIndex` makes a
 * pack's): items in order, each with its places in the pack and the ones
 * that can be marked found.
 */
export function ownListEntry(
  list: OwnList,
  pack: LoadedPack,
  isTrackable: (locationId: string) => boolean,
): ChecklistEntry {
  const items = [...list.items]
    .sort((a, b) => a.order - b.order)
    .map((item, index) => {
      const places = [...new Set(item.locationIds.filter((id) => pack.locations.has(id)))];
      const targets = places.filter(isTrackable);
      return { item, index, places, targets, ownMark: targets.length === 0 };
    });
  return { checklist: list.checklist, items };
}

// ---------------------------------------------------------------------------
// The outline

/** One row of a list's outline: a heading, or a step (an item). */
export type OutlineRow =
  { kind: 'heading'; heading: OwnHeading } | { kind: 'step'; item: ChecklistItem };

/** The id of an outline row. */
export function rowId(row: OutlineRow): string {
  return row.kind === 'heading' ? row.heading.id : row.item.id;
}

/** A list's headings and steps in order. */
export function outlineOf(list: OwnList): OutlineRow[] {
  const rows: (OutlineRow & { order: number; rank: number })[] = [
    ...list.headings.map((heading) => ({
      kind: 'heading' as const,
      heading,
      order: heading.order,
      rank: 0,
    })),
    ...list.items.map((item) => ({ kind: 'step' as const, item, order: item.order, rank: 1 })),
  ];
  // A heading and a step with the same order: the heading first.
  rows.sort((a, b) => a.order - b.order || a.rank - b.rank);
  return rows.map((row) =>
    row.kind === 'heading'
      ? { kind: 'heading', heading: row.heading }
      : { kind: 'step', item: row.item },
  );
}

/**
 * A list with this outline: orders numbered from 0 in the outline's order,
 * and each step's section set to the heading above it (or none).
 */
export function withOutline(list: OwnList, rows: readonly OutlineRow[]): OwnList {
  const headings: OwnHeading[] = [];
  const items: ChecklistItem[] = [];
  let section: string | undefined;
  rows.forEach((row, order) => {
    if (row.kind === 'heading') {
      section = row.heading.title;
      headings.push({ ...row.heading, order });
    } else {
      const { section: _old, ...rest } = row.item;
      items.push({
        ...rest,
        checklistId: list.checklist.id,
        order,
        ...(section !== undefined ? { section } : {}),
      });
    }
  });
  return { ...list, headings, items };
}

/** The steps of a list in order. */
export function stepsOf(list: OwnList): ChecklistItem[] {
  return outlineOf(list)
    .filter((row) => row.kind === 'step')
    .map((row) => row.item);
}

/** Where a row is in the outline, or -1. */
function indexOf(rows: readonly OutlineRow[], id: string | null): number {
  return id === null ? -1 : rows.findIndex((row) => rowId(row) === id);
}

/**
 * Puts rows into a list after the row `after` (at the end when it is null
 * or not in the list).
 */
export function insertRows(
  list: OwnList,
  after: string | null,
  added: readonly OutlineRow[],
): OwnList {
  const rows = outlineOf(list);
  const at = indexOf(rows, after);
  const position = at < 0 ? rows.length : at + 1;
  return withOutline(list, [...rows.slice(0, position), ...added, ...rows.slice(position)]);
}

/** A new step, to put into a list with {@link insertRows}. */
export function newStep(
  list: OwnList,
  id: string,
  fields: { name: string; locationIds?: readonly string[]; note?: string; optional?: boolean },
): OutlineRow {
  return {
    kind: 'step',
    item: {
      id,
      checklistId: list.checklist.id,
      name: fields.name.trim() || 'New step',
      order: 0,
      locationIds: [...(fields.locationIds ?? [])],
      entityIds: [],
      ...(fields.note ? { note: fields.note } : {}),
      ...(fields.optional ? { optional: true } : {}),
    },
  };
}

/** A new heading, to put into a list with {@link insertRows}. */
export function newHeading(id: string, title: string): OutlineRow {
  return {
    kind: 'heading',
    heading: { id, title: headingTitle(title), order: 0 },
  };
}

/** A heading's title as it can be kept: trimmed, not empty, not too long. */
export function headingTitle(title: string): string {
  return title.trim().slice(0, MAX_HEADING_LENGTH) || 'New heading';
}

/** Moves a row to another place in the outline (an index of the outline without the row). */
export function moveRow(list: OwnList, id: string, to: number): OwnList {
  const rows = outlineOf(list);
  const from = indexOf(rows, id);
  if (from < 0) return list;
  const [row] = rows.splice(from, 1);
  const target = Math.max(0, Math.min(rows.length, to));
  rows.splice(target, 0, row!);
  return withOutline(list, rows);
}

/** Moves a row one place up (`-1`) or down (`1`); the same list when it cannot move. */
export function moveRowBy(list: OwnList, id: string, by: -1 | 1): OwnList {
  const rows = outlineOf(list);
  const from = indexOf(rows, id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= rows.length) return list;
  return moveRow(list, id, to);
}

/** Takes a row out of the list. */
export function removeRow(list: OwnList, id: string): OwnList {
  return withOutline(
    list,
    outlineOf(list).filter((row) => rowId(row) !== id),
  );
}

/** A copy of a step right after it, with a new id; the same list when there is no such step. */
export function duplicateStep(list: OwnList, id: string, newId: string): OwnList {
  const rows = outlineOf(list);
  const at = indexOf(rows, id);
  const row = rows[at];
  if (row?.kind !== 'step') return list;
  const copy: OutlineRow = { kind: 'step', item: { ...row.item, id: newId } };
  return withOutline(list, [...rows.slice(0, at + 1), copy, ...rows.slice(at + 1)]);
}

/** What can be changed of a step. */
export interface StepChanges {
  name?: string;
  note?: string;
  locationIds?: readonly string[];
  optional?: boolean;
}

/** A list with one step changed. An empty note, and an optional flag that is off, are left out. */
export function changeStep(list: OwnList, id: string, changes: StepChanges): OwnList {
  return {
    ...list,
    items: list.items.map((item) => {
      if (item.id !== id) return item;
      const { note: _note, optional: _optional, ...rest } = item;
      const note = changes.note ?? item.note;
      const optional = changes.optional ?? item.optional;
      return {
        ...rest,
        ...(changes.name !== undefined ? { name: changes.name.trim() || item.name } : {}),
        ...(changes.locationIds !== undefined ? { locationIds: [...changes.locationIds] } : {}),
        ...(note ? { note } : {}),
        ...(optional ? { optional: true } : {}),
      };
    }),
  };
}

/** A list with one heading renamed; the steps under it follow. */
export function renameHeading(list: OwnList, id: string, title: string): OwnList {
  const rows = outlineOf(list).map((row): OutlineRow =>
    row.kind === 'heading' && row.heading.id === id
      ? { kind: 'heading', heading: { ...row.heading, title: headingTitle(title) } }
      : row,
  );
  return withOutline(list, rows);
}

/** A list with another name. */
export function renameList(list: OwnList, name: string): OwnList {
  const trimmed = name.trim();
  return trimmed ? { ...list, checklist: { ...list.checklist, name: trimmed } } : list;
}

/**
 * A list of another template. Nothing is lost: the steps, notes and
 * locations stay, and optional steps stay marked for when the list is
 * ordered again.
 */
export function changeTemplate(list: OwnList, type: ChecklistType): OwnList {
  return { ...list, checklist: { ...list.checklist, type } };
}

// ---------------------------------------------------------------------------
// Locations, nearest first

interface Point {
  id: string;
  mapId: string;
  x: number;
  y: number;
}

/** The first location of a step that is in the pack, as a point. */
function pointOf(pack: LoadedPack, item: ChecklistItem): Point | null {
  for (const id of item.locationIds) {
    const location = pack.locations.get(id);
    if (location) return { id: item.id, mapId: location.mapId, x: location.x, y: location.y };
  }
  return null;
}

/**
 * Points in "nearest next" order: from `start` (or the first point when
 * there is none), always on to the nearest point not visited yet. Ties
 * keep the order given.
 */
export function nearestNext<T extends { x: number; y: number }>(
  points: readonly T[],
  start?: { x: number; y: number },
): T[] {
  const left = [...points];
  const ordered: T[] = [];
  let here: { x: number; y: number } | undefined = start;
  while (left.length > 0) {
    let best = 0;
    if (here) {
      let bestDistance = Infinity;
      left.forEach((point, i) => {
        const d = (point.x - here!.x) ** 2 + (point.y - here!.y) ** 2;
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      });
    }
    const [point] = left.splice(best, 1);
    ordered.push(point!);
    here = point;
  }
  return ordered;
}

/**
 * "Suggest an order": within each heading (or the whole list when it has
 * none), the steps that have a location are put nearest next, starting
 * from the first of them, map by map (the maps in the order their first
 * step comes). A step with no location stays right after the step it
 * followed; one that comes first under its heading stays first.
 */
export function suggestOrder(list: OwnList, pack: LoadedPack): OwnList {
  const rows = outlineOf(list);
  const result: OutlineRow[] = [];
  let group: OutlineRow[] = [];
  const flush = () => {
    result.push(...orderGroup(group, pack));
    group = [];
  };
  for (const row of rows) {
    if (row.kind === 'heading') {
      flush();
      result.push(row);
    } else {
      group.push(row);
    }
  }
  flush();
  return withOutline(list, result);
}

/** The steps under one heading, nearest next (see {@link suggestOrder}). */
function orderGroup(steps: readonly OutlineRow[], pack: LoadedPack): OutlineRow[] {
  const leading: OutlineRow[] = [];
  const followers = new Map<string, OutlineRow[]>();
  const anchors: (Point & { row: OutlineRow })[] = [];
  for (const row of steps) {
    const point = row.kind === 'step' ? pointOf(pack, row.item) : null;
    if (point) {
      anchors.push({ ...point, row });
      followers.set(point.id, []);
    } else if (anchors.length === 0) {
      leading.push(row);
    } else {
      followers.get(anchors.at(-1)!.id)!.push(row);
    }
  }
  const maps: string[] = [];
  for (const anchor of anchors) if (!maps.includes(anchor.mapId)) maps.push(anchor.mapId);
  const ordered = maps.flatMap((mapId) => nearestNext(anchors.filter((a) => a.mapId === mapId)));
  return [...leading, ...ordered.flatMap((anchor) => [anchor.row, ...followers.get(anchor.id)!])];
}

/**
 * Locations to add after a step, nearest first: from the step's own
 * location when it is on the same map as some of them, else from the
 * first of them; locations already in the list are left out, and none is
 * added twice.
 */
export function locationsToAdd(
  list: OwnList,
  pack: LoadedPack,
  locationIds: readonly string[],
  after: string | null,
): string[] {
  const inList = new Set(list.items.flatMap((item) => item.locationIds));
  const points: Point[] = [];
  for (const id of new Set(locationIds)) {
    const location = pack.locations.get(id);
    if (!location || inList.has(id)) continue;
    points.push({ id, mapId: location.mapId, x: location.x, y: location.y });
  }
  const step = after === null ? undefined : list.items.find((item) => item.id === after);
  const from = step ? pointOf(pack, step) : null;
  const maps: string[] = [];
  if (from && points.some((p) => p.mapId === from.mapId)) maps.push(from.mapId);
  for (const point of points) if (!maps.includes(point.mapId)) maps.push(point.mapId);
  return maps.flatMap((mapId) =>
    nearestNext(
      points.filter((p) => p.mapId === mapId),
      from?.mapId === mapId ? from : undefined,
    ).map((p) => p.id),
  );
}

// ---------------------------------------------------------------------------
// Importing a list file

/** Why a list file cannot be imported into a game, or the list to add. */
export type ListImport =
  { ok: true; list: OwnList; renamed: boolean } | { ok: false; error: string };

/**
 * A list read from a file, ready to add to a game's own lists: refused when
 * it was made for another game; given new ids, all of them, when any of
 * its ids is taken (by another own list, or a pack's list or entry), so
 * importing the same file twice gives two lists.
 */
export function importList(
  list: OwnList,
  fileGameId: string,
  game: { gameId: string; title: string },
  taken: ReadonlySet<string>,
  now: Date,
  random: RandomText = randomText,
  fileGameTitle?: string | null,
): ListImport {
  if (fileGameId !== game.gameId) {
    const other = fileGameTitle ?? `another game (${fileGameId})`;
    return {
      ok: false,
      error: `This list was made for ${other}, not for ${game.title}, so it was not imported.`,
    };
  }
  const ids = idsOf(list);
  const clash = ids.some(
    (id) => taken.has(id) || !isOwnId(id) || parseId(id)?.gameId !== fileGameId,
  );
  const time = now.toISOString();
  if (!clash) return { ok: true, list: { ...list, updatedAt: time }, renamed: false };
  const next = idMaker(game.gameId, [...taken, ...ids], random);
  const listId = next('checklist');
  const renamed: OwnList = {
    ...list,
    checklist: { ...list.checklist, id: listId },
    items: list.items.map((item) => ({ ...item, id: next('checkitem'), checklistId: listId })),
    headings: list.headings.map((heading) => ({ ...heading, id: next('checkitem') })),
    updatedAt: time,
  };
  return { ok: true, list: renamed, renamed: true };
}
