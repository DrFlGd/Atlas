import { areaOfPlace, type SearchEntry } from '@atlas/core';
import { useDeferredValue, useMemo } from 'react';
import type { LoadedGame } from '../../state/store';
import { areaName } from '../listViews';

/** A location's type and area (or map), as one line. */
export function locationDetail(game: LoadedGame, locationId: string): string {
  const location = game.pack.locations.get(locationId);
  if (!location) return '';
  const type = game.pack.categories.get(location.categoryId)?.name;
  const area = areaName(game, areaOfPlace(game.pack, location));
  return [type, area === 'No area' ? game.pack.maps.get(location.mapId)?.name : area]
    .filter(Boolean)
    .join(' · ');
}

/** Locations whose names match what is typed. */
export function useLocationHits(game: LoadedGame, query: string, limit = 8): SearchEntry[] {
  const deferred = useDeferredValue(query);
  return useMemo(() => {
    const text = deferred.trim();
    if (!text) return [];
    return game.search
      .search(text, limit * 4)
      .map((hit) => hit.entry)
      .filter((entry) => entry.kind === 'location')
      .slice(0, limit);
  }, [game, deferred, limit]);
}
