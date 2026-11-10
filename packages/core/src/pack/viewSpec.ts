import type { Layer } from '@atlas/schema';
import type { MapLayerSpec, MapMarker } from '../mapview/types';
import type { LoadedPack } from './loadedPack';

/** Describes a pack layer for the map view, with its tile URL made absolute. */
export function layerViewSpec(pack: LoadedPack, layer: Layer): MapLayerSpec {
  const map = pack.maps.get(layer.mapId);
  if (!map) throw new Error(`Layer ${layer.id} refers to unknown map ${layer.mapId}`);
  const attribution = pack.manifest.attribution.map((a) => escapeHtml(a.name)).join(', ');
  return {
    id: layer.id,
    width: map.width,
    height: map.height,
    tileSize: layer.tileSize,
    minZoom: layer.minZoom,
    maxZoom: layer.maxZoom,
    tiles: { type: layer.tiles.type, url: pack.resolveUrl(layer.tiles.url) },
    ...(attribution ? { attribution } : {}),
  };
}

/**
 * Map markers for the locations on a layer, coloured by category. When
 * `visibleCategoryIds` is given, only those categories are included.
 */
export function layerMarkers(
  pack: LoadedPack,
  layerId: string,
  visibleCategoryIds?: ReadonlySet<string>,
): MapMarker[] {
  const markers: MapMarker[] = [];
  for (const location of pack.locationsOn(layerId)) {
    if (visibleCategoryIds && !visibleCategoryIds.has(location.categoryId)) continue;
    const category = pack.categories.get(location.categoryId);
    markers.push({
      id: location.id,
      x: location.x,
      y: location.y,
      color: category?.color ?? '#cccccc',
    });
  }
  return markers;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
