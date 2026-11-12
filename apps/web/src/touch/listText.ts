import { plainNote, type ChecklistItemEntry, type ItemState } from '@atlas/core';
import { numberFormat } from '../state/derived';
import type { LoadedGame } from '../state/store';

/** The words and figures of the Lists rows. */

/** Height of an entry row before it is measured. */
export const ROW_HEIGHT = 64;

/**
 * The second line of an entry in an area or a kind: the entry's note, or
 * else its place's own note, or else where it is.
 */
export function entryNote(game: LoadedGame, entry: ChecklistItemEntry): string | undefined {
  if (entry.item.note) return plainNote(entry.item.note);
  const first = entry.places.length > 0 ? game.pack.locations.get(entry.places[0]!) : undefined;
  const guide = first?.guideId ? game.checklists.guide(first.guideId) : undefined;
  if (guide && !game.checklists.isListed(guide.id)) return plainNote(guide.body) || undefined;
  return undefined;
}

/** Where an entry is: its first place's region (or map), how many places it has, how many are found. */
export function entryWhere(
  game: LoadedGame,
  entry: ChecklistItemEntry,
  state: ItemState,
  placeId: string | undefined,
): string {
  const { pack } = game;
  const place = placeId ? pack.locations.get(placeId) : undefined;
  const region = place?.regionId ? pack.regions.get(place.regionId) : undefined;
  return [
    region?.name ?? (place ? pack.maps.get(place.mapId)?.name : undefined),
    entry.places.length > 1 ? `${entry.places.length} places` : undefined,
    !entry.ownMark && state.total > 1 && !state.done
      ? `${state.found} of ${state.total} found`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "12 of 31" and the like. */
export function ofText(found: number, total: number): string {
  return `${numberFormat.format(found)} of ${numberFormat.format(total)}`;
}

/** A whole-number percentage, rounded down so 100% means all of it. */
export function percentOf(found: number, total: number): number {
  return total === 0 ? 0 : Math.floor((found / total) * 100);
}
