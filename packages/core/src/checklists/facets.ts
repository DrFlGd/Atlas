import type { LoadedPack } from '../pack/loadedPack';
import { normalizeText } from '../search/searchIndex';
import type { ChecklistItemEntry, ItemState } from './checklists';

/**
 * Filtering one checklist by region, category, text and "hide found".
 *
 * An item's regions and categories are those of its places. A place with no
 * region counts under its map's id instead, so "no region" stays apart per
 * map; an item with no place at all (a step) is in the region and the
 * category {@link NONE}. An item
 * with places in several regions or categories is in each of them.
 */
export const NONE = '';

export interface ItemFacets {
  readonly regions: readonly string[];
  readonly categories: readonly string[];
  /** Normalised name, section, category and region names, for the search box. */
  readonly text: string;
}

export function itemFacets(entry: ChecklistItemEntry, pack: LoadedPack): ItemFacets {
  const regions = new Set<string>();
  const categories = new Set<string>();
  const words: string[] = [entry.item.name, entry.item.section ?? ''];
  for (const id of entry.places) {
    const location = pack.locations.get(id);
    if (!location) continue;
    regions.add(location.regionId ?? location.mapId);
    categories.add(location.categoryId);
    words.push(pack.categories.get(location.categoryId)?.name ?? '');
    if (location.regionId) words.push(pack.regions.get(location.regionId)?.name ?? '');
  }
  if (regions.size === 0) regions.add(NONE);
  if (categories.size === 0) categories.add(NONE);
  return {
    regions: [...regions],
    categories: [...categories],
    text: normalizeText(words.join(' ')),
  };
}

/** Found (or done) items and all items in one region or category of a checklist. */
export interface FacetCount {
  key: string;
  found: number;
  total: number;
}

/** Counts per region or per category, over the whole checklist, in order of first appearance. */
export function countFacets(
  facets: readonly ItemFacets[],
  states: readonly ItemState[],
  kind: 'regions' | 'categories',
): FacetCount[] {
  const counts = new Map<string, FacetCount>();
  facets.forEach((f, i) => {
    for (const key of f[kind]) {
      let count = counts.get(key);
      if (!count) {
        count = { key, found: 0, total: 0 };
        counts.set(key, count);
      }
      count.total++;
      if (states[i]!.done) count.found++;
    }
  });
  return [...counts.values()];
}

export interface ChecklistFilter {
  /** Words that must all occur in the item's name, section, category or region. */
  query: string;
  /** Leave out items that are found (or, for steps, done). */
  hideFound: boolean;
  /** Regions and categories switched off. An item stays while any of its own is on. */
  hiddenRegions: ReadonlySet<string>;
  hiddenCategories: ReadonlySet<string>;
}

/**
 * Indices of the items the filter lets through. `keep` names items to show
 * whatever the filter says, such as the one just ticked or the one asked
 * for from a link.
 */
export function filterChecklist(
  facets: readonly ItemFacets[],
  states: readonly ItemState[],
  filter: ChecklistFilter,
  keep: (index: number) => boolean = () => false,
): number[] {
  const terms = normalizeText(filter.query).split(/\s+/).filter(Boolean);
  const anyShown = (keys: readonly string[], hidden: ReadonlySet<string>) =>
    hidden.size === 0 || keys.some((k) => !hidden.has(k));
  const result: number[] = [];
  facets.forEach((f, i) => {
    if (
      keep(i) ||
      ((!filter.hideFound || !states[i]!.done) &&
        anyShown(f.regions, filter.hiddenRegions) &&
        anyShown(f.categories, filter.hiddenCategories) &&
        terms.every((t) => f.text.includes(t)))
    ) {
      result.push(i);
    }
  });
  return result;
}
