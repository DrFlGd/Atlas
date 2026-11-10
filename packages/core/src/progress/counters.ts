import type { LoadedPack } from '../pack/loadedPack';

/**
 * Progress over a set of locations: `found` and `total` count trackable
 * locations only, `count` counts every location (trackable or not).
 */
export interface Tally {
  found: number;
  total: number;
  count: number;
}

const EMPTY: Tally = Object.freeze({ found: 0, total: 0, count: 0 });

/** Progress counts for one profile, as computed by {@link ProgressCounter.summarize}. */
export interface ProgressSummary {
  /** The whole pack. */
  readonly pack: Tally;
  map(mapId: string): Tally;
  layer(layerId: string): Tally;
  /** A region, including its sub-regions. */
  region(regionId: string): Tally;
  /** A category, on one map or (`mapId` null) across the pack. */
  category(categoryId: string, mapId?: string | null): Tally;
  /** A category group, on one map or (`mapId` null) across the pack. */
  group(groupId: string, mapId?: string | null): Tally;
}

interface Placement {
  trackable: boolean;
  /** Keys of every tally the location counts towards. */
  keys: string[];
}

const PACK_KEY = 'p';
const keyOf = {
  map: (id: string) => `m|${id}`,
  layer: (id: string) => `l|${id}`,
  region: (id: string) => `r|${id}`,
  category: (id: string, mapId: string | null) => `c|${mapId ?? ''}|${id}`,
  group: (id: string, mapId: string | null) => `g|${mapId ?? ''}|${id}`,
};

/**
 * Derives found/total counts per category, group, region, layer, map and
 * pack from a pack and a set of found location ids. Totals are computed once
 * per pack; each summary only walks the found ids, so recounting after every
 * change stays cheap. Counts are never stored.
 */
export class ProgressCounter {
  private readonly placements = new Map<string, Placement>();
  private readonly totals = new Map<string, { total: number; count: number }>();

  constructor(pack: LoadedPack) {
    const regionChains = new Map<string, string[]>();
    const chainOf = (regionId: string): string[] => {
      let chain = regionChains.get(regionId);
      if (chain) return chain;
      chain = [];
      let current = pack.regions.get(regionId);
      // Bounded so a parent cycle cannot hang the app.
      for (let depth = 0; current && depth < 32; depth++) {
        chain.push(current.id);
        current = current.parentId ? pack.regions.get(current.parentId) : undefined;
      }
      regionChains.set(regionId, chain);
      return chain;
    };

    for (const location of pack.data.locations) {
      const category = pack.categories.get(location.categoryId);
      if (!category) continue;
      const keys = [
        PACK_KEY,
        keyOf.map(location.mapId),
        keyOf.layer(location.layerId),
        keyOf.category(category.id, location.mapId),
        keyOf.category(category.id, null),
        keyOf.group(category.groupId, location.mapId),
        keyOf.group(category.groupId, null),
        ...(location.regionId ? chainOf(location.regionId).map(keyOf.region) : []),
      ];
      const placement = { trackable: category.trackable, keys };
      this.placements.set(location.id, placement);
      for (const key of keys) {
        const entry = this.totals.get(key) ?? { total: 0, count: 0 };
        entry.count++;
        if (category.trackable) entry.total++;
        this.totals.set(key, entry);
      }
    }
  }

  /** Whether a location exists in the pack and can be marked found. */
  isTrackable(locationId: string): boolean {
    return this.placements.get(locationId)?.trackable ?? false;
  }

  /** Counts for the given found ids. Ids that are unknown or not trackable are ignored. */
  summarize(found: Iterable<string>): ProgressSummary {
    const foundBy = new Map<string, number>();
    for (const id of found) {
      const placement = this.placements.get(id);
      if (!placement?.trackable) continue;
      for (const key of placement.keys) foundBy.set(key, (foundBy.get(key) ?? 0) + 1);
    }
    const tally = (key: string): Tally => {
      const totals = this.totals.get(key);
      if (!totals) return EMPTY;
      return { found: foundBy.get(key) ?? 0, total: totals.total, count: totals.count };
    };
    return {
      pack: tally(PACK_KEY),
      map: (id) => tally(keyOf.map(id)),
      layer: (id) => tally(keyOf.layer(id)),
      region: (id) => tally(keyOf.region(id)),
      category: (id, mapId = null) => tally(keyOf.category(id, mapId)),
      group: (id, mapId = null) => tally(keyOf.group(id, mapId)),
    };
  }
}

/** A whole-number percentage, rounded down so 100% means everything is found. */
export function percent(tally: Tally): number {
  return tally.total === 0 ? 0 : Math.floor((tally.found / tally.total) * 100);
}
