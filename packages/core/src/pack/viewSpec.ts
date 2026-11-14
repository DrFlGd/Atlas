import type { Layer } from '@atlas/schema';
import type { PixelBounds, PixelPoint } from '../geometry/coords';
import type { MapLayerSpec, MapMarker } from '../mapview/types';
import { passesFilter, type MarkerFilter } from '../filters/visibility';
import type { LoadedPack } from './loadedPack';

/** Describes a pack layer for the map view, with its tile URL made absolute. */
export function layerViewSpec(pack: LoadedPack, layer: Layer): MapLayerSpec {
  const map = pack.maps.get(layer.mapId);
  if (!map) throw new Error(`Layer ${layer.id} refers to unknown map ${layer.mapId}`);
  const attribution = pack.manifest.attribution.map((a) => escapeHtml(a.name)).join(', ');
  const focus = placesFocus(pack.locationsOn(layer.id), map.width, map.height);
  return {
    id: layer.id,
    width: map.width,
    height: map.height,
    tileSize: layer.tileSize,
    minZoom: layer.minZoom,
    maxZoom: layer.maxZoom,
    tiles: { type: layer.tiles.type, url: pack.resolveUrl(layer.tiles.url) },
    ...(focus ? { focus } : {}),
    ...(attribution ? { attribution } : {}),
  };
}

/** Margin around the places, as a share of the longer side of the area they take up. */
const FOCUS_MARGIN = 0.1;
/** The margin is at least this share of the image's longer side, so a single place is not shown alone. */
const FOCUS_MIN_MARGIN = 0.05;
/** Places that take up this share of the image's width and of its height cover the map. */
const FOCUS_COVERS = 0.75;

/**
 * The part of a map's image that its places take up, with a margin, when
 * that is clearly less than the whole image; undefined when the places cover
 * the map or there are none. It is what the map shows first: a map's image
 * can reach well beyond its places (an importer may size it by the tiles of
 * the image source, most of which can be empty), and fitting all of it would
 * open the map small, in a corner of the view.
 */
export function placesFocus(
  places: Iterable<PixelPoint>,
  width: number,
  height: number,
): PixelBounds | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of places) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || width <= 0 || height <= 0) {
    return undefined;
  }
  const margin = Math.max(
    FOCUS_MARGIN * Math.max(maxX - minX, maxY - minY),
    FOCUS_MIN_MARGIN * Math.max(width, height),
  );
  const focus = {
    minX: Math.max(0, minX - margin),
    minY: Math.max(0, minY - margin),
    maxX: Math.min(width, maxX + margin),
    maxY: Math.min(height, maxY + margin),
  };
  if (focus.maxX <= focus.minX || focus.maxY <= focus.minY) return undefined;
  const covers =
    focus.maxX - focus.minX >= FOCUS_COVERS * width &&
    focus.maxY - focus.minY >= FOCUS_COVERS * height;
  return covers ? undefined : focus;
}

export interface LayerMarkerOptions {
  /** Category and found filter; every location is included when absent. */
  filter?: MarkerFilter;
  /** A location to include even when the filter hides it, such as the selection. */
  alwaysInclude?: string | null;
  /** The locations with a note of the person's own, marked as such. */
  noted?: ReadonlySet<string> | null;
}

/**
 * Map markers for the locations on a layer, with their category's colour and
 * glyph. Found locations are muted; locations with a note of one's own carry
 * a mark.
 */
export function layerMarkers(
  pack: LoadedPack,
  layerId: string,
  options: LayerMarkerOptions = {},
): MapMarker[] {
  const { filter, alwaysInclude = null, noted = null } = options;
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
    if (noted?.has(location.id)) marker.noted = true;
    markers.push(marker);
  }
  return markers;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
