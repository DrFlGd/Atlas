import { layerMarkers, visibleCategoryIds, type ProgressSummary } from '@atlas/core';
import type { MapMarker } from '@atlas/core/mapview';
import { useMemo } from 'react';
import { markerFilter } from './actions';
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
  const found = useAtlas((s) => s.found);
  const selectedId = useAtlas((s) => s.selectedId);
  return useMemo(() => {
    if (!game || !layerId) return [];
    const filter = markerFilter({ game, overrides, hideFound, found });
    return layerMarkers(game.pack, layerId, { filter, alwaysInclude: selectedId });
  }, [game, layerId, overrides, hideFound, found, selectedId]);
}

export const numberFormat = new Intl.NumberFormat('en');
