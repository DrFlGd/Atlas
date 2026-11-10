import L from 'leaflet';
import { PMTiles, leafletRasterLayer } from 'pmtiles';
import { pixelToSimpleLatLng } from '../../geometry/coords';
import type { MapLayerSpec } from '../types';

/** The image's extent as CRS.Simple bounds. */
export function imageBounds(spec: MapLayerSpec): L.LatLngBounds {
  return L.latLngBounds(
    pixelToSimpleLatLng({ x: 0, y: 0 }, spec.maxZoom),
    pixelToSimpleLatLng({ x: spec.width, y: spec.height }, spec.maxZoom),
  );
}

/**
 * Creates the raster layer for a tile pyramid. Native levels run from
 * `spec.minZoom` to `spec.maxZoom`; beyond that Leaflet scales the last level.
 *
 * `bounds` is required for both sources: under CRS.Simple the grid is
 * unbounded, and without it Leaflet would request tiles with negative or
 * out-of-range indices around the image.
 */
export function createTileLayer(spec: MapLayerSpec, maxMapZoom: number): L.GridLayer {
  const options: L.GridLayerOptions = {
    tileSize: spec.tileSize,
    minZoom: spec.minZoom,
    maxZoom: maxMapZoom,
    minNativeZoom: spec.minZoom,
    maxNativeZoom: spec.maxZoom,
    bounds: imageBounds(spec),
    noWrap: true,
    className: 'atlas-tiles',
    ...(spec.attribution === undefined ? {} : { attribution: spec.attribution }),
  };

  if (spec.tiles.type === 'xyz') return L.tileLayer(spec.tiles.url, options);

  // pmtiles' Leaflet adapter extends the global `L` rather than importing
  // Leaflet, so make sure the global exists before creating the layer.
  const scope = globalThis as { L?: typeof L };
  scope.L ??= L;
  return leafletRasterLayer(new PMTiles(spec.tiles.url), options) as L.GridLayer;
}
