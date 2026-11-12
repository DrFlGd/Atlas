import { NONE, type ChecklistEntry } from '@atlas/core';
import { useMemo } from 'react';
import type { LoadedGame } from '../state/store';

/** The names the filters and rows show for a region or category key. */
export function useFacetNames(game: LoadedGame, entry: ChecklistEntry) {
  return useMemo(() => {
    const { pack } = game;
    const maps = new Set<string>();
    for (const item of entry.items) {
      for (const id of item.places) {
        const mapId = pack.locations.get(id)?.mapId;
        if (mapId) maps.add(mapId);
      }
    }
    const severalMaps = maps.size > 1;
    // Region keys are region ids, map ids (places outside any region), or
    // NONE (items with no place); see `itemFacets`.
    const region = (key: string) => {
      if (key === NONE) return 'Not on the map';
      if (pack.maps.has(key)) return 'No region';
      return pack.regions.get(key)?.name ?? key;
    };
    const mapOf = (key: string) =>
      pack.maps.has(key) ? key : (pack.regions.get(key)?.mapId ?? NONE);
    const mapName = (key: string) =>
      key === NONE ? 'Not on the map' : (pack.maps.get(key)?.name ?? key);
    const category = (key: string) =>
      key === NONE ? 'Not on the map' : (pack.categories.get(key)?.name ?? key);
    const mapOrder = new Map(pack.data.maps.map((m, i) => [m.id, i]));
    const regionOrder = new Map(pack.data.regions.map((r, i) => [r.id, i]));
    const categoryOrder = new Map(pack.data.categories.map((c, i) => [c.id, i]));
    /** Regions by map, each map's places outside any region last, items with no place at the end. */
    const compareRegions = (a: string, b: string) =>
      (mapOrder.get(mapOf(a)) ?? Infinity) - (mapOrder.get(mapOf(b)) ?? Infinity) ||
      (regionOrder.get(a) ?? Infinity) - (regionOrder.get(b) ?? Infinity) ||
      0;
    const compareCategories = (a: string, b: string) =>
      (categoryOrder.get(a) ?? Infinity) - (categoryOrder.get(b) ?? Infinity) || 0;
    return { region, category, mapOf, mapName, compareRegions, compareCategories, severalMaps };
  }, [game, entry]);
}
