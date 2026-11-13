import type { Location } from '@atlas/schema';
import { pointInPolygon } from '../geometry/coords';
import type { LoadedPack } from '../pack/loadedPack';
import type { ChecklistEntry, ItemState } from './checklists';

/**
 * Ways of looking at one checklist: by area, by kind, and in its own order.
 * Pure functions over a {@link ChecklistEntry} and the states of its items
 * (see `itemState`), so every view reads the same items and found marks.
 *
 * Areas. An item's areas are the areas of its places: a place's area is the
 * top-level ancestor of its region, and a place without a region is in
 * {@link NO_AREA}, as is an item without any place. An item with places in
 * several areas is listed in each of them, and counts as one entry in each.
 * In every area it shows the item's own state (done when the whole item is
 * done, as `itemState` says), so a tick means the same everywhere and the
 * list's own figure stays `checklistTally`. The areas' totals can therefore
 * add up to more than the list's total.
 *
 * Kinds. An item's kinds are the categories of its places (only those in
 * the area, when one is open); an item with no place is in the kind
 * {@link NO_KIND}. An item with places of several kinds is in each.
 */

/** The id of the list of every trackable place in the game, made when needed and never stored. */
export const EVERYTHING_ID = 'atlas:everything';

/** The area of places without a region, and of items without a place. */
export const NO_AREA = '';

/** The kind of items without a place. */
export const NO_KIND = '';

/** A point on a map, in image pixels. */
export interface MapPoint {
  x: number;
  y: number;
}

/**
 * Every trackable place of the game as one list, map by map in the pack's
 * order and in the pack's order within a map. Each item is one place, and
 * its id is the place's id.
 */
export function everythingList(
  pack: LoadedPack,
  isTrackable: (locationId: string) => boolean,
  name = 'Everything',
): ChecklistEntry {
  const mapOrder = new Map(pack.data.maps.map((map, i) => [map.id, i]));
  const places = pack.data.locations
    .filter((location) => isTrackable(location.id))
    .map((location, i) => ({ location, i }))
    .sort(
      (a, b) =>
        (mapOrder.get(a.location.mapId) ?? Infinity) -
          (mapOrder.get(b.location.mapId) ?? Infinity) || a.i - b.i,
    );
  return {
    checklist: { id: EVERYTHING_ID, name, order: -1, kind: 'checklist' },
    items: places.map(({ location }, index) => ({
      item: {
        id: location.id,
        checklistId: EVERYTHING_ID,
        name: location.name,
        order: index,
        locationIds: [location.id],
        entityIds: [],
      },
      index,
      targets: [location.id],
      places: [location.id],
      ownMark: false,
    })),
  };
}

const topRegions = new WeakMap<LoadedPack, Map<string, string>>();

/** The top-level ancestor of a region (itself when it has no parent). */
export function topRegionOf(pack: LoadedPack, regionId: string): string {
  let cache = topRegions.get(pack);
  if (!cache) {
    cache = new Map();
    topRegions.set(pack, cache);
  }
  const known = cache.get(regionId);
  if (known !== undefined) return known;
  let top = regionId;
  let current = pack.regions.get(regionId);
  // Bounded so a parent cycle cannot hang the app.
  for (let depth = 0; current?.parentId && depth < 32; depth++) {
    const parent = pack.regions.get(current.parentId);
    if (!parent) break;
    top = parent.id;
    current = parent;
  }
  cache.set(regionId, top);
  return top;
}

/** The area of a place: its region's top-level ancestor, or {@link NO_AREA}. */
export function areaOfPlace(pack: LoadedPack, location: Location): string {
  return location.regionId && pack.regions.has(location.regionId)
    ? topRegionOf(pack, location.regionId)
    : NO_AREA;
}

/** The items of a list by area. */
export interface ListAreas {
  /** Areas that have items: the pack's top-level regions in map and pack order, then {@link NO_AREA}. */
  readonly keys: readonly string[];
  /** Indices of each area's items, in list order. */
  readonly items: ReadonlyMap<string, readonly number[]>;
}

/** Sorts a list's items into areas (see the rules at the top of this file). Built once per list. */
export function listAreas(entry: ChecklistEntry, pack: LoadedPack): ListAreas {
  const items = new Map<string, number[]>();
  for (const item of entry.items) {
    const areas = new Set<string>();
    for (const id of item.places) {
      const location = pack.locations.get(id);
      if (location) areas.add(areaOfPlace(pack, location));
    }
    if (areas.size === 0) areas.add(NO_AREA);
    for (const area of areas) {
      const list = items.get(area);
      if (list) list.push(item.index);
      else items.set(area, [item.index]);
    }
  }
  const mapOrder = new Map(pack.data.maps.map((map, i) => [map.id, i]));
  const regionOrder = new Map(pack.data.regions.map((region, i) => [region.id, i]));
  // Areas by map, then in the pack's order of regions; places without one last.
  const last = pack.data.maps.length;
  const mapRank = (key: string) =>
    key === NO_AREA ? last + 1 : (mapOrder.get(pack.regions.get(key)?.mapId ?? '') ?? last);
  const regionRank = (key: string) => regionOrder.get(key) ?? pack.data.regions.length;
  const keys = [...items.keys()].sort(
    (a, b) => mapRank(a) - mapRank(b) || regionRank(a) - regionRank(b),
  );
  return { keys, items };
}

/** Done and all items of one area, or of one kind. */
export interface GroupTally {
  key: string;
  found: number;
  total: number;
}

function tallyOf(key: string, indices: readonly number[], states: readonly ItemState[]) {
  let found = 0;
  for (const i of indices) if (states[i]!.done) found++;
  return { key, found, total: indices.length };
}

/** The tally of each area, in the order of `areas.keys`. */
export function areaTallies(areas: ListAreas, states: readonly ItemState[]): GroupTally[] {
  return areas.keys.map((key) => tallyOf(key, areas.items.get(key)!, states));
}

/**
 * Areas in the order the "By area" view lists them: the area the map is
 * in (`here`) first, unless everything in it is found; then the other
 * areas with something left to find, in pack order, the places without an
 * area last of them; then the finished areas, in the same order.
 */
export function orderAreas(tallies: readonly GroupTally[], here: string | null): GroupTally[] {
  const finished = (t: GroupTally) => t.total > 0 && t.found === t.total;
  const open = tallies.filter((t) => !finished(t));
  const first = open.find((t) => t.key === here);
  const rest = open.filter((t) => t !== first);
  const ordered = [
    ...(first ? [first] : []),
    ...rest.filter((t) => t.key !== NO_AREA),
    ...rest.filter((t) => t.key === NO_AREA),
  ];
  return [...ordered, ...tallies.filter(finished)];
}

/**
 * The area after `current` in `ordered` that still has something to find,
 * going round to the start; null when no other area has.
 */
export function nextArea(ordered: readonly GroupTally[], current: string): GroupTally | null {
  const at = ordered.findIndex((t) => t.key === current);
  for (let step = 1; step < ordered.length + (at < 0 ? 1 : 0); step++) {
    const t = ordered[(at + step + ordered.length) % ordered.length]!;
    if (t.key !== current && t.found < t.total) return t;
  }
  return null;
}

/**
 * The area a point of a map is in: the top-level area of a region of that
 * map whose outline holds the point, the smallest such outline first; null
 * when no outline holds it.
 */
export function areaAt(pack: LoadedPack, mapId: string, point: MapPoint): string | null {
  let best: { area: string; size: number } | null = null;
  for (const region of pack.data.regions) {
    if (region.mapId !== mapId || !region.polygon || region.polygon.length < 3) continue;
    if (!pointInPolygon(point, region.polygon)) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of region.polygon) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const size = (maxX - minX) * (maxY - minY);
    if (!best || size < best.size) best = { area: topRegionOf(pack, region.id), size };
  }
  return best?.area ?? null;
}

/** The places of an item that are in `area`, or all of them when `area` is undefined. */
export function placesIn(
  pack: LoadedPack,
  places: readonly string[],
  area: string | undefined,
): string[] {
  if (area === undefined) return [...places];
  return places.filter((id) => {
    const location = pack.locations.get(id);
    return location !== undefined && areaOfPlace(pack, location) === area;
  });
}

/** One kind's items, in the order given. */
export interface KindGroup {
  /** A category id, or {@link NO_KIND}. */
  key: string;
  indices: number[];
}

/**
 * The items at `indices` grouped by kind (see the rules at the top of this
 * file), kinds in the pack's category order and items without a place
 * last. Inside a kind, items keep the order of `indices`.
 */
export function kindGroups(
  entry: ChecklistEntry,
  pack: LoadedPack,
  indices: readonly number[],
  area?: string,
): KindGroup[] {
  const groups = new Map<string, number[]>();
  for (const index of indices) {
    const kinds = new Set<string>();
    for (const id of placesIn(pack, entry.items[index]!.places, area)) {
      const location = pack.locations.get(id);
      if (location) kinds.add(location.categoryId);
    }
    if (kinds.size === 0) kinds.add(NO_KIND);
    for (const kind of kinds) {
      const list = groups.get(kind);
      if (list) list.push(index);
      else groups.set(kind, [index]);
    }
  }
  const order = new Map(pack.data.categories.map((c, i) => [c.id, i]));
  const unknown = order.size;
  const rank = (key: string) => (key === NO_KIND ? unknown + 1 : (order.get(key) ?? unknown));
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || 0)
    .map(([key, list]) => ({ key, indices: list }));
}

/** The tally of each kind group. */
export function kindTallies(groups: readonly KindGroup[], states: readonly ItemState[]) {
  return groups.map((g) => tallyOf(g.key, g.indices, states));
}

/** Distances compare with places on other maps (Infinity) last. */
export function compareDistance(a: number, b: number): number {
  return a === b ? 0 : a === Infinity ? 1 : b === Infinity ? -1 : a - b;
}

/**
 * Squared distance from `center` to the nearest of `places` on the map
 * `mapId`; Infinity when none of them is on that map or there is no centre.
 */
export function distanceTo(
  pack: LoadedPack,
  places: readonly string[],
  mapId: string | null,
  center: MapPoint | null,
): number {
  if (!center || !mapId) return Infinity;
  let best = Infinity;
  for (const id of places) {
    const location = pack.locations.get(id);
    if (location?.mapId !== mapId) continue;
    best = Math.min(best, (location.x - center.x) ** 2 + (location.y - center.y) ** 2);
  }
  return best;
}

/**
 * The items at `indices`, nearest to the map's centre first (as search
 * orders places): measured from the nearest of an item's places in `area`
 * on the map shown. Items with no such place keep their order, after the
 * others.
 */
export function nearestFirst(
  entry: ChecklistEntry,
  pack: LoadedPack,
  indices: readonly number[],
  mapId: string | null,
  center: MapPoint | null,
  area?: string,
): number[] {
  if (!center || !mapId) return [...indices];
  const distance = new Map<number, number>();
  for (const index of indices) {
    const places = placesIn(pack, entry.items[index]!.places, area);
    distance.set(index, distanceTo(pack, places, mapId, center));
  }
  return indices
    .map((index, position) => ({ index, position }))
    .sort(
      (a, b) =>
        compareDistance(distance.get(a.index)!, distance.get(b.index)!) || a.position - b.position,
    )
    .map(({ index }) => index);
}

// ---------------------------------------------------------------------------
// In order

/** A run of items in list order that share a `section` (or have none). */
export interface Stage {
  /** The section, or null for items without one. */
  title: string | null;
  /** First item index. */
  start: number;
  /** One past the last item index. */
  end: number;
  /** The stage's number among the titled stages, from 1; 0 for an untitled one. */
  number: number;
}

/** The list's stages: consecutive items with the same section, in order. */
export function listStages(entry: ChecklistEntry): Stage[] {
  const stages: Stage[] = [];
  let number = 0;
  entry.items.forEach((item, index) => {
    const title = item.item.section ?? null;
    const last = stages.at(-1);
    if (last?.title === title) {
      last.end = index + 1;
    } else {
      if (title !== null) number++;
      stages.push({ title, start: index, end: index + 1, number: title === null ? 0 : number });
    }
  });
  return stages;
}

/** The stage that holds an item index. */
export function stageOf(stages: readonly Stage[], index: number): Stage | undefined {
  return stages.find((s) => index >= s.start && index < s.end);
}

/**
 * The step to do next: the first one not done at or after `from`, going
 * round to the start; null when every step is done. `from` moves on when a
 * step is skipped.
 */
export function nextStep(states: readonly Pick<ItemState, 'done'>[], from = 0): number | null {
  const n = states.length;
  if (n === 0) return null;
  const start = ((from % n) + n) % n;
  for (let step = 0; step < n; step++) {
    const index = (start + step) % n;
    if (!states[index]!.done) return index;
  }
  return null;
}

/**
 * The done steps right before `index`, in its stage, to fold into one row
 * ("Steps a to b are done"): null when there are fewer than two.
 */
export function doneRunBefore(
  states: readonly Pick<ItemState, 'done'>[],
  stages: readonly Stage[],
  index: number,
): { from: number; to: number } | null {
  const stage = stageOf(stages, index);
  const start = stage?.start ?? 0;
  let from = index;
  while (from > start && states[from - 1]!.done) from--;
  return index - from >= 2 ? { from, to: index - 1 } : null;
}

/** One row of the "In order" view. */
export type OrderRow =
  | {
      kind: 'stage';
      /** Index into the stages. */
      stage: number;
      open: boolean;
      done: number;
      total: number;
    }
  /** The link to the rest of the area of the next step. */
  | { kind: 'here' }
  /** Done steps folded into one row. */
  | { kind: 'run'; from: number; to: number }
  | { kind: 'item'; index: number };

export interface OrderOptions {
  /** The highlighted step (see {@link nextStep}). */
  highlight: number | null;
  /** Stages opened or closed by hand, by stage index; the others follow {@link OrderRow} rules. */
  stageOpen?: ReadonlyMap<number, boolean>;
  /** The folded done steps are shown. */
  runShown?: boolean;
  /**
   * Only these item indices, in order (a search): stages are then all open
   * and nothing is folded.
   */
  only?: readonly number[];
}

/**
 * The rows of the "In order" view. Titled stages have a header with their
 * tally; a stage is open when it holds the highlighted step (and closed
 * otherwise, a finished one too) unless opened or closed by hand. The done
 * steps right before the highlighted one fold into one row (see
 * {@link doneRunBefore}), and a "here" row comes under the header of the
 * highlighted step's stage, or first when it has none.
 */
export function orderRows(
  states: readonly Pick<ItemState, 'done'>[],
  stages: readonly Stage[],
  options: OrderOptions,
): OrderRow[] {
  const { highlight, stageOpen, runShown = false, only } = options;
  const rows: OrderRow[] = [];
  if (only) {
    const shown = new Set(only);
    stages.forEach((stage, s) => {
      let header = false;
      for (let i = stage.start; i < stage.end; i++) {
        if (!shown.has(i)) continue;
        if (!header && stage.title !== null) {
          rows.push({ kind: 'stage', stage: s, open: true, ...stageTally(stage, states) });
        }
        header = true;
        rows.push({ kind: 'item', index: i });
      }
    });
    return rows;
  }
  const current = highlight === null ? undefined : stageOf(stages, highlight);
  const run = highlight === null || runShown ? null : doneRunBefore(states, stages, highlight);
  // With no stage header to go under, the link comes first.
  if (highlight !== null && (current === undefined || current.title === null)) {
    rows.push({ kind: 'here' });
  }
  stages.forEach((stage, s) => {
    const titled = stage.title !== null;
    if (titled) {
      const open = stageOpen?.get(s) ?? stage === current;
      rows.push({ kind: 'stage', stage: s, open, ...stageTally(stage, states) });
      if (stage === current) rows.push({ kind: 'here' });
      if (!open) return;
    }
    for (let i = stage.start; i < stage.end; i++) {
      if (i === run?.from) {
        rows.push({ kind: 'run', from: run.from, to: run.to });
        i = run.to;
        continue;
      }
      rows.push({ kind: 'item', index: i });
    }
  });
  return rows;
}

function stageTally(stage: Stage, states: readonly Pick<ItemState, 'done'>[]) {
  let done = 0;
  for (let i = stage.start; i < stage.end; i++) if (states[i]!.done) done++;
  return { done, total: stage.end - stage.start };
}

/** What a hidden part of a note reads as where the note is one plain line. */
export const HIDDEN_TEXT = '(Hidden)';

/**
 * The hidden parts of a note: `||like this||`, possibly over several
 * paragraphs. Bars pair up left to right; a last one without a partner is
 * plain text. Bars in code (between backticks) and escaped bars (`\|`) do
 * not count, as the app's Markdown renderer does not count them. Returns
 * `[start, end)` offsets that include the bars.
 */
export function hiddenParts(markdown: string): [start: number, end: number][] {
  const marks: number[] = [];
  for (let i = 0; i < markdown.length; i++) {
    const c = markdown[i];
    if (c === '\\') {
      i++;
    } else if (c === '`') {
      let run = 1;
      while (markdown[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      // The code ends at the next run of exactly as many backticks.
      let close = markdown.indexOf(fence, i + run);
      while (close >= 0 && markdown[close + run] === '`') {
        let past = close;
        while (markdown[past] === '`') past++;
        close = markdown.indexOf(fence, past);
      }
      i = close < 0 ? i + run - 1 : close + run - 1;
    } else if (c === '|' && markdown[i + 1] === '|') {
      marks.push(i);
      i++;
    }
  }
  const parts: [number, number][] = [];
  for (let m = 0; m + 1 < marks.length; m += 2) parts.push([marks[m]!, marks[m + 1]! + 2]);
  return parts;
}

/**
 * A note with each hidden part (see {@link hiddenParts}) put as
 * `replacement`, so that no hidden word shows or can be found where the
 * note is plain text.
 */
export function withoutHiddenText(markdown: string, replacement = HIDDEN_TEXT): string {
  let out = '';
  let at = 0;
  for (const [start, end] of hiddenParts(markdown)) {
    out += markdown.slice(at, start) + replacement;
    at = end;
  }
  return out + markdown.slice(at);
}

/**
 * A note in Markdown as one line of plain text: links keep their text,
 * marks and markup go, hidden parts read "(Hidden)", and only the first
 * paragraph is kept.
 */
export function plainNote(markdown: string): string {
  const first =
    withoutHiddenText(markdown)
      .trim()
      .split(/\n\s*\n/)[0] ?? '';
  return first
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
