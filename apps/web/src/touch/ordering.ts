import type { ChecklistEntry, IsDone, SearchHit } from '@atlas/core';

export interface Point {
  x: number;
  y: number;
}

/** Where a location is: its map and image pixel. */
export interface Placed extends Point {
  mapId: string;
}

/**
 * Search hits for the touch layout. The match itself ranks first, as
 * everywhere (`SearchIndex.search`); among equally good matches, places on
 * the map shown come first, nearest to `center` first, then the rest in
 * the order they came. Does not change `hits`.
 */
export function orderHits(
  hits: readonly SearchHit[],
  mapId: string | null,
  center: Point | null,
  placeOf: (locationId: string) => Placed | undefined,
): SearchHit[] {
  const distance = hits.map((hit) => {
    if (hit.entry.kind !== 'location' || !center) return Infinity;
    const place = placeOf(hit.entry.id);
    if (place?.mapId !== mapId) return Infinity;
    return (place.x - center.x) ** 2 + (place.y - center.y) ** 2;
  });
  return hits
    .map((hit, index) => ({ hit, index }))
    .sort(
      (a, b) =>
        a.hit.score - b.hit.score ||
        compareDistance(distance[a.index]!, distance[b.index]!) ||
        a.index - b.index,
    )
    .map(({ hit }) => hit);
}

const compareDistance = (a: number, b: number) =>
  a === b ? 0 : a === Infinity ? 1 : b === Infinity ? -1 : a - b;

/** An entry of a checklist to show next, and the place to show it at. */
export interface NextEntry {
  itemId: string;
  locationId: string;
}

/**
 * The entry after `fromItemId` on a checklist that is not done yet and has
 * a place, going round to the start; null when there is none. Its place is
 * the first one not found yet, or else its first.
 */
export function nextOnList(
  entry: ChecklistEntry,
  fromItemId: string,
  isDone: IsDone,
): NextEntry | null {
  const items = entry.items;
  const from = items.findIndex((i) => i.item.id === fromItemId);
  for (let step = 1; step <= items.length; step++) {
    const item = items[(from + step + items.length) % items.length]!;
    if (item.item.id === fromItemId || item.places.length === 0) continue;
    const done = item.ownMark ? isDone(item.item.id) : item.targets.every(isDone);
    if (done) continue;
    const place = item.places.find((id) => !isDone(id)) ?? item.places[0]!;
    return { itemId: item.item.id, locationId: place };
  }
  return null;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * How far to move the map, in screen pixels, so that a marker at `point`
 * can be seen: null when it is inside `free` (less `margin`) and under
 * none of `covered` (plus `margin`). Otherwise the marker goes to the
 * middle of `free`, above the top of any covering sheet or card that
 * reaches into it.
 */
export function revealShift(
  point: Point,
  free: Rect,
  covered: readonly Rect[],
  margin: number,
): Point | null {
  const inside =
    point.x >= free.left + margin &&
    point.x <= free.right - margin &&
    point.y >= free.top + margin &&
    point.y <= free.bottom - margin;
  const hidden = covered.some(
    (r) =>
      point.x >= r.left - margin &&
      point.x <= r.right + margin &&
      point.y >= r.top - margin &&
      point.y <= r.bottom + margin,
  );
  if (inside && !hidden) return null;
  const bottom = Math.min(
    free.bottom,
    ...covered.filter((r) => r.top > free.top).map((r) => r.top),
  );
  const target = { x: (free.left + free.right) / 2, y: (free.top + bottom) / 2 };
  return { x: point.x - target.x, y: point.y - target.y };
}
