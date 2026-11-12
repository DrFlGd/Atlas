import type { Category, Location } from '@atlas/schema';
import type { LoadedPack } from '../pack/loadedPack';

/**
 * Category visibility as the user's changes on top of the pack defaults:
 * `overrides` holds only the categories the user showed or hid, so a
 * category added by a pack update starts at its `defaultVisible`.
 */
export type VisibilityOverrides = Readonly<Record<string, boolean>>;

export function isCategoryVisible(category: Category, overrides: VisibilityOverrides): boolean {
  return overrides[category.id] ?? category.defaultVisible;
}

/** Ids of the visible categories. */
export function visibleCategoryIds(
  categories: readonly Category[],
  overrides: VisibilityOverrides,
): Set<string> {
  return new Set(categories.filter((c) => isCategoryVisible(c, overrides)).map((c) => c.id));
}

/** Overrides that show exactly `categoryIds` and hide every other category. */
export function overridesShowingOnly(
  categories: readonly Category[],
  categoryIds: Iterable<string>,
): Record<string, boolean> {
  const shown = new Set(categoryIds);
  return Object.fromEntries(categories.map((c) => [c.id, shown.has(c.id)]));
}

export interface MarkerFilter {
  visibleCategories: ReadonlySet<string>;
  hideFound: boolean;
  isFound: (locationId: string) => boolean;
  /**
   * Only these locations, whatever kinds are shown (the places of one list,
   * shown alone for a while). The category choices stay as they are, so
   * they are back as soon as this goes.
   */
  only?: ReadonlySet<string> | null;
}

/** Whether a location passes the category filter (or the `only` set) and the "hide found" toggle. */
export function passesFilter(location: Location, filter: MarkerFilter): boolean {
  if (filter.only) {
    if (!filter.only.has(location.id)) return false;
  } else if (!filter.visibleCategories.has(location.categoryId)) {
    return false;
  }
  return !(filter.hideFound && filter.isFound(location.id));
}

/**
 * The location nearest to `from` on a layer that passes the filter and is
 * trackable but not found; null when there is none. Distances are in image
 * pixels.
 */
export function nearestUnfound(
  pack: LoadedPack,
  layerId: string,
  from: { x: number; y: number },
  filter: MarkerFilter,
  exclude?: string | null,
): Location | null {
  let best: Location | null = null;
  let bestDistance = Infinity;
  for (const location of pack.locationsOn(layerId)) {
    if (location.id === exclude) continue;
    if (!pack.categories.get(location.categoryId)?.trackable) continue;
    if (filter.isFound(location.id) || !passesFilter(location, filter)) continue;
    const distance = (location.x - from.x) ** 2 + (location.y - from.y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = location;
    }
  }
  return best;
}
