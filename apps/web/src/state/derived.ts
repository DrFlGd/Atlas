import { layerMarkers, visibleCategoryIds, type ProgressSummary } from '@atlas/core';
import type { MapMarker } from '@atlas/core/mapview';
import { useMemo } from 'react';
import { markerFilter } from './actions';
import { useNotedLocations } from './ownNotes';
import { useAtlas } from './store';

/** Progress counts for the active profile, recomputed when progress changes. */
export function useSummary(): ProgressSummary | null {
  const game = useAtlas((s) => s.game);
  const found = useAtlas((s) => s.found);
  return useMemo(() => (game ? game.counter.summarize(found.keys()) : null), [game, found]);
}

export function useVisibleCategories(): ReadonlySet<string> {
  const game = useAtlas((s) => s.game);
  const overrides = useAtlas((s) => s.overrides);
  return useMemo(
    () => visibleCategoryIds(game?.pack.data.categories ?? [], overrides),
    [game, overrides],
  );
}

/** The markers to draw on the active layer: filtered, styled, and always including the selection. */
export function useLayerMarkers(): readonly MapMarker[] {
  const game = useAtlas((s) => s.game);
  const layerId = useAtlas((s) => s.layerId);
  const overrides = useAtlas((s) => s.overrides);
  const hideFound = useAtlas((s) => s.hideFound);
  const listOnly = useAtlas((s) => s.listOnly);
  const notesOnly = useAtlas((s) => s.notesOnly);
  const found = useAtlas((s) => s.found);
  const selectedId = useAtlas((s) => s.selectedId);
  // The locations with a note of the person's own carry a mark.
  const noted = useNotedLocations(game);
  return useMemo(() => {
    if (!game || !layerId) return [];
    const filter = markerFilter({ game, overrides, hideFound, found, listOnly, notesOnly }, noted);
    return layerMarkers(game.pack, layerId, { filter, alwaysInclude: selectedId, noted });
  }, [game, layerId, overrides, hideFound, found, listOnly, notesOnly, noted, selectedId]);
}

export const numberFormat = new Intl.NumberFormat('en');
