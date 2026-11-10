import type { Layer } from '@atlas/schema';
import type { MapLayerSpec, MapMarker } from '../mapview/types';
import { passesFilter, type MarkerFilter } from '../filters/visibility';
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

export interface LayerMarkerOptions {
  /** Category and found filter; every location is included when absent. */
  filter?: MarkerFilter;
  /** A location to include even when the filter hides it, such as the selection. */
  alwaysInclude?: string | null;
}

/**
 * Map markers for the locations on a layer, with their category's colour and
 * glyph. Found locations are muted.
 */
export function layerMarkers(
  pack: LoadedPack,
  layerId: string,
  options: LayerMarkerOptions = {},
): MapMarker[] {
  const { filter, alwaysInclude = null } = options;
  const markers: MapMarker[] = [];
  for (const location of pack.locationsOn(layerId)) {
    if (filter && location.id !== alwaysInclude && !passesFilter(location, filter)) continue;
    const category = pack.categories.get(location.categoryId);
    const marker: MapMarker = {
      id: location.id,
      x: location.x,
      y: location.y,
      color: category?.color ?? '#cccccc',
      icon: category?.icon ?? 'pin',
    };
    if (filter?.isFound(location.id)) marker.muted = true;
    markers.push(marker);
  }
  return markers;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
