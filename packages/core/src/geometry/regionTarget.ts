/**
 * Where the map goes when someone picks a region: the region's centre when
 * the pack gives one, else the middle of its outline, at a zoom that shows
 * the outline. Pure, in image pixels.
 */

import type { Region } from '@atlas/schema';
import { polygonBounds, zoomScale, type PixelBounds, type PixelPoint } from './coords';

/** A size in screen pixels. */
export interface ScreenSize {
  width: number;
  height: number;
}

/** A point to move the map to, and the zoom to show it at. */
export interface RegionTarget extends PixelPoint {
  zoom: number;
}

/** How many levels below the layer's 1:1 level a region with a centre but no outline is shown. */
export const REGION_CENTER_ZOOM_OUT = 2;

/** Share of the map area an outline may fill, so its edges stay clear of the map's sides. */
const OUTLINE_FILL = 0.9;

/** The map view zooms in quarter steps; a fitted zoom is rounded down to one. */
const ZOOM_STEP = 0.25;

/** Whether the map can go to a region: it has a centre or an outline. */
export function hasRegionTarget(region: Pick<Region, 'polygon' | 'center'>): boolean {
  return region.center !== undefined || (region.polygon?.length ?? 0) >= 3;
}

/**
 * Where the map goes for a region, or null when the region has neither a
 * centre nor an outline.
 *
 * - With an outline, the zoom fits the whole outline into `viewport` around
 *   the target point (the centre, or else the middle of the outline), never
 *   closer than the layer's 1:1 level.
 * - With a centre only, the zoom is {@link REGION_CENTER_ZOOM_OUT} levels
 *   below the layer's 1:1 level.
 *
 * The zoom always stays within the layer's range.
 */
export function regionTarget(
  region: Pick<Region, 'polygon' | 'center'>,
  layer: { minZoom: number; maxZoom: number },
  viewport: ScreenSize,
): RegionTarget | null {
  const outline =
    region.polygon && region.polygon.length >= 3 ? polygonBounds(region.polygon) : null;
  const clamp = (zoom: number) => Math.min(layer.maxZoom, Math.max(layer.minZoom, zoom));
  const centerZoom = clamp(layer.maxZoom - REGION_CENTER_ZOOM_OUT);
  if (region.center) {
    const [x, y] = region.center;
    return {
      x,
      y,
      zoom: outline ? fitZoom(outline, { x, y }, layer, viewport, centerZoom) : centerZoom,
    };
  }
  if (!outline) return null;
  const middle = { x: (outline.minX + outline.maxX) / 2, y: (outline.minY + outline.maxY) / 2 };
  return { ...middle, zoom: fitZoom(outline, middle, layer, viewport, centerZoom) };
}

/** The zoom at which `bounds` fits into `viewport` with the view centred on `at`. */
function fitZoom(
  bounds: PixelBounds,
  at: PixelPoint,
  layer: { minZoom: number; maxZoom: number },
  viewport: ScreenSize,
  fallback: number,
): number {
  // The view is centred on `at`, so the outline must fit on both sides of it.
  const width = 2 * Math.max(at.x - bounds.minX, bounds.maxX - at.x);
  const height = 2 * Math.max(at.y - bounds.minY, bounds.maxY - at.y);
  const scale = Math.min(
    (viewport.width * OUTLINE_FILL) / width,
    (viewport.height * OUTLINE_FILL) / height,
  );
  // A zero-size outline or an unknown map area: show it like a centre.
  if (!Number.isFinite(scale) || scale <= 0) return fallback;
  const zoom = Math.floor((layer.maxZoom + Math.log2(scale)) / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(layer.maxZoom, Math.max(layer.minZoom, zoom));
}

/**
 * The map area's size in screen pixels, from a view of a layer whose 1:1
 * level is `maxZoom`: the visible image pixels times the scale.
 */
export function viewportSize(
  view: { zoom: number; bounds: PixelBounds },
  maxZoom: number,
): ScreenSize {
  const scale = zoomScale(view.zoom, maxZoom);
  return {
    width: (view.bounds.maxX - view.bounds.minX) * scale,
    height: (view.bounds.maxY - view.bounds.minY) * scale,
  };
}
