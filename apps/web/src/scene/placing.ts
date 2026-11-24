import type { SceneFrame } from '@atlas/core';
import { floorAt, type FloorLike } from '@atlas/schema';

/**
 * The arithmetic of putting a location on a 3D map in Edit locations,
 * apart from the renderer so it can be tested: the model is pressed, the
 * view casts a ray from the camera through that point of the screen, and
 * the first surface it meets that is not cut away (by the floor's top, the
 * height cut, the cut above a location gone to, or the cut toward the
 * camera) is where the location goes.
 *
 * The view's frame (see `sceneFrame` in `@atlas/core`) lines up with the
 * map image: a point (x, h, z) of it is above the map pixel (x / unit,
 * z / unit), at the height h in the world's units. So a point pressed gives
 * the location's `x` and `y` on the map (through the map's `worldTransform`
 * and the scene's `axes`, `scale` and `offset`, which the frame holds), and
 * its `height`. Its level is the floor that height is on ({@link floorAt}),
 * on a map with floors; on one without, the level shown.
 */

/** A point of the view's frame: x and z across the map, y the height. */
export interface ViewPoint {
  x: number;
  y: number;
  z: number;
}

/** A plane that cuts the model away: what lies on the side its normal points from is gone. */
export interface CutPlane {
  normal: ViewPoint;
  constant: number;
}

/** A surface the ray met, as a raycaster gives it: the point, and how far along the ray. */
export interface RayHit {
  point: ViewPoint;
  distance: number;
}

/** Where a location put on the model goes. */
export interface Placement {
  /** Map pixels, rounded as the 2D editor rounds them. */
  x: number;
  y: number;
  /** In the world's units. */
  height: number;
  /** The floor its height is on, or the level given for a map without floors. */
  layerId: string;
}

/**
 * Whether a point is kept by the cuts: on the side of each plane its normal
 * points to (as the renderer's clipping planes keep it), within a hair.
 */
export function keptByCuts(point: ViewPoint, cuts: readonly CutPlane[]): boolean {
  return cuts.every(
    (cut) =>
      cut.normal.x * point.x + cut.normal.y * point.y + cut.normal.z * point.z + cut.constant >=
      -1e-6,
  );
}

/**
 * The first surface a ray met that is not cut away: what the person sees
 * where they pressed. Null when every surface on the ray is cut away, or
 * there is none.
 */
export function firstKept<T extends RayHit>(
  hits: readonly T[],
  cuts: readonly CutPlane[],
): T | null {
  let best: T | null = null;
  for (const hit of hits) {
    if (!keptByCuts(hit.point, cuts)) continue;
    if (!best || hit.distance < best.distance) best = hit;
  }
  return best;
}

/** The floor a height is on, of a map's floors lowest first; null on a map without floors. */
export function floorIdAt(floors: readonly FloorLike[], height: number): string | null {
  return floorAt(floors, height)?.id ?? null;
}

/**
 * Where a location goes when the model is pressed at `point`: the map pixel
 * under it, its height, and its floor (or `shownLayer` on a map without
 * floors). Null when the point is off the map image (`width` by `height`
 * pixels), where a location cannot be.
 */
export function placementAt(
  frame: Pick<SceneFrame, 'toPixel'>,
  point: ViewPoint,
  map: { width: number; height: number },
  floors: readonly FloorLike[],
  shownLayer: string,
): Placement | null {
  const [px, py] = frame.toPixel(point.x, point.z);
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(point.y)) return null;
  if (px < 0 || py < 0 || px > map.width || py > map.height) return null;
  return {
    x: Math.round(px),
    y: Math.round(py),
    height: Math.round(point.y * 100) / 100,
    layerId: floorIdAt(floors, point.y) ?? shownLayer,
  };
}
