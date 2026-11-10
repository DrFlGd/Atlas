/**
 * Coordinate maths shared by the app and the pipeline.
 *
 * Map positions are pixels of the full-resolution map image, origin top-left,
 * x to the right and y downwards. A tile pyramid of `tileSize` tiles has its
 * highest level `maxZoom` at one tile pixel per image pixel, and each level
 * below halves the scale.
 */

import type { WorldTransform } from '@atlas/schema';

export interface PixelPoint {
  x: number;
  y: number;
}

export interface PixelBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The lowest pyramid level whose full extent covers the image at 1:1. */
export function pyramidMaxZoom(width: number, height: number, tileSize: number): number {
  const longest = Math.max(width, height);
  return Math.max(0, Math.ceil(Math.log2(longest / tileSize) - 1e-9));
}

/** Screen pixels per image pixel at a (possibly fractional) zoom. */
export function zoomScale(zoom: number, maxZoom: number): number {
  return 2 ** (zoom - maxZoom);
}

/** Edge length, in image pixels, of the square the pyramid covers. */
export function pyramidWorldSize(tileSize: number, maxZoom: number): number {
  return tileSize * 2 ** maxZoom;
}

export interface PyramidLevel {
  zoom: number;
  /** Image size at this level, rounded up. */
  width: number;
  height: number;
  /** Tile grid size at this level. */
  columns: number;
  rows: number;
}

/** Dimensions of one pyramid level. */
export function pyramidLevel(
  width: number,
  height: number,
  tileSize: number,
  maxZoom: number,
  zoom: number,
): PyramidLevel {
  const scale = zoomScale(zoom, maxZoom);
  const levelWidth = Math.max(1, Math.ceil(width * scale));
  const levelHeight = Math.max(1, Math.ceil(height * scale));
  return {
    zoom,
    width: levelWidth,
    height: levelHeight,
    columns: Math.ceil(levelWidth / tileSize),
    rows: Math.ceil(levelHeight / tileSize),
  };
}

/** Inclusive tile index range at `zoom` that covers a pixel rectangle, clipped to the level. */
export function tileRangeForBounds(
  bounds: PixelBounds,
  level: PyramidLevel,
  tileSize: number,
  maxZoom: number,
): { minCol: number; minRow: number; maxCol: number; maxRow: number } | null {
  const scale = zoomScale(level.zoom, maxZoom) / tileSize;
  const minCol = Math.max(0, Math.floor(bounds.minX * scale));
  const minRow = Math.max(0, Math.floor(bounds.minY * scale));
  const maxCol = Math.min(level.columns - 1, Math.floor(bounds.maxX * scale));
  const maxRow = Math.min(level.rows - 1, Math.floor(bounds.maxY * scale));
  if (minCol > maxCol || minRow > maxRow) return null;
  return { minCol, minRow, maxCol, maxRow };
}

/**
 * Converts an image pixel to Leaflet `CRS.Simple` latitude/longitude, where
 * zoom `maxZoom` shows the image at 1:1. CRS.Simple has y pointing up, so the
 * latitude is negated.
 */
export function pixelToSimpleLatLng(
  point: PixelPoint,
  maxZoom: number,
): [lat: number, lng: number] {
  const factor = 2 ** maxZoom;
  return [-point.y / factor, point.x / factor];
}

/** Inverse of {@link pixelToSimpleLatLng}. */
export function simpleLatLngToPixel(lat: number, lng: number, maxZoom: number): PixelPoint {
  const factor = 2 ** maxZoom;
  return { x: lng * factor, y: -lat * factor };
}

/**
 * Converts an image pixel to the longitude/latitude that a Web Mercator
 * projection maps to the same relative position within a square of side
 * `worldSize`. Point libraries that assume geographic input (such as the
 * clustering index) then work in image space without distortion.
 */
export function pixelToMercatorLngLat(
  point: PixelPoint,
  worldSize: number,
): [lng: number, lat: number] {
  const u = point.x / worldSize;
  const v = point.y / worldSize;
  const lng = (u - 0.5) * 360;
  const lat = (360 / Math.PI) * Math.atan(Math.exp(((180 - v * 360) * Math.PI) / 180)) - 90;
  return [lng, lat];
}

/** Inverse of {@link pixelToMercatorLngLat}. */
export function mercatorLngLatToPixel(lng: number, lat: number, worldSize: number): PixelPoint {
  const u = lng / 360 + 0.5;
  const sin = Math.sin((lat * Math.PI) / 180);
  const v = 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI;
  return { x: u * worldSize, y: v * worldSize };
}

export const IDENTITY_TRANSFORM: WorldTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Maps an image pixel to in-game world coordinates. */
export function pixelToWorld(point: PixelPoint, t: WorldTransform): PixelPoint {
  return { x: t.a * point.x + t.c * point.y + t.e, y: t.b * point.x + t.d * point.y + t.f };
}

/** Maps in-game world coordinates back to an image pixel. Throws for a singular transform. */
export function worldToPixel(point: PixelPoint, t: WorldTransform): PixelPoint {
  const det = t.a * t.d - t.b * t.c;
  if (Math.abs(det) < 1e-12) throw new Error('worldTransform is not invertible');
  const x = point.x - t.e;
  const y = point.y - t.f;
  return { x: (t.d * x - t.c * y) / det, y: (-t.b * x + t.a * y) / det };
}

/** Even-odd point-in-polygon test; points exactly on an edge may fall either way. */
export function pointInPolygon(
  point: PixelPoint,
  polygon: readonly (readonly [number, number])[],
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    const crosses = yi > point.y !== yj > point.y;
    if (crosses && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Bounding box of a polygon. */
export function polygonBounds(polygon: readonly (readonly [number, number])[]): PixelBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of polygon) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/** Area of a simple polygon (shoelace formula), always positive. */
export function polygonArea(polygon: readonly (readonly [number, number])[]): number {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    sum += xj * yi - xi * yj;
  }
  return Math.abs(sum) / 2;
}
