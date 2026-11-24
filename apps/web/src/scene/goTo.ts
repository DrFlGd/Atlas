/**
 * The arithmetic of going to a location or an area in the 3D view, apart
 * from the renderer so it can be tested: how high the model is cut above a
 * location, from how far the view looks down at it or at an area, and how
 * a flight moves between two views.
 *
 * Going to a location shows its floor (see `floorAt` in `@atlas/schema`),
 * cuts the model at about head height above it ({@link headCut}), and flies
 * the view to look down at it from close by ({@link goToDistance}), a
 * little tilted ({@link GO_TO_TILT}), facing the way it faced.
 */

/** How far above a location the model is cut when the view goes to it: about head height, in metres. */
export const HEAD_ROOM = 3;
/** Where the head room would reach past its floor's top, the cut is this far below the top. */
export const TOP_MARGIN = 0.2;
/** How far above a location the view looks down from, in metres, before the map's size limits it. */
export const GO_TO_HEIGHT = 26;
/** The view's tilt from straight down when it goes to a location or an area. */
export const GO_TO_TILT = (10 * Math.PI) / 180;
/** How long the flight to a location takes. */
export const GO_TO_MS = 700;
/** How long the flight to an area takes. */
export const FRAME_MS = 800;
/** The least an area reaches from its point, in metres, when the view frames it. */
export const MIN_AREA_RADIUS = 8;

/**
 * The height the model is cut at when the view goes to a location at
 * `height`, on a floor whose top is `top` (null: a map without floors, or
 * no top known): head room above the location, but never above the
 * floor's top, where it is just under the top. A location at the top or
 * above it (the highest floor takes what is above it) is cut above its
 * head all the same, so it stays in sight.
 */
export function headCut(height: number, top: number | null): number {
  const head = height + HEAD_ROOM;
  if (top === null || head <= top) return head;
  if (height < top - TOP_MARGIN) return top - TOP_MARGIN;
  return height >= top ? head : top;
}

/**
 * How far from a location the view is when it goes to it: {@link
 * GO_TO_HEIGHT} above it along a view tilted by {@link GO_TO_TILT}, kept
 * between a hundredth and six tenths of the model's size (`size`, its
 * widest extent), and never nearer than the view may come (`minDistance`).
 */
export function goToDistance(size: number, minDistance = 0): number {
  const along = GO_TO_HEIGHT / Math.cos(GO_TO_TILT);
  const clamped = Math.min(Math.max(along, size * 0.01), size * 0.6);
  return Math.max(clamped, minDistance);
}

/**
 * How far from an area's point the view must be to show all of it: a
 * circle of `radius` round the point, seen nearly from above, in a view of
 * vertical field `fovDegrees` and of `aspect` (width over height), with a
 * margin.
 */
export function frameDistance(radius: number, fovDegrees: number, aspect: number): number {
  const vertical = (fovDegrees * Math.PI) / 360;
  const horizontal = Math.atan(Math.tan(vertical) * Math.max(aspect, 0.01));
  const half = Math.min(vertical, horizontal);
  return (Math.max(radius, MIN_AREA_RADIUS) / Math.tan(half)) * 1.2;
}

/**
 * The point to look at so that `target` shows `shift` CSS pixels above the
 * middle of a view `height` pixels high (vertical field `fovDegrees`), the
 * camera `distance` from it nearly straight down, facing `azimuth`: on a
 * phone, the middle of what the place card leaves free. Up the screen is
 * away from the camera along the ground.
 */
export function shiftedTarget(
  target: readonly [number, number, number],
  shift: number,
  options: { distance: number; azimuth: number; fovDegrees: number; height: number },
): [number, number, number] {
  const { distance, azimuth, fovDegrees, height } = options;
  if (shift === 0 || height <= 0) return [target[0], target[1], target[2]];
  const perPixel = (2 * distance * Math.tan((fovDegrees * Math.PI) / 360)) / height;
  const along = shift * perPixel;
  return [target[0] + Math.sin(azimuth) * along, target[1], target[2] + Math.cos(azimuth) * along];
}

/** Where the camera is from the point it looks at: three.js's spherical angles, Y up. */
export function cameraOffset(
  distance: number,
  polar: number,
  azimuth: number,
): [number, number, number] {
  const across = distance * Math.sin(polar);
  return [across * Math.sin(azimuth), distance * Math.cos(polar), across * Math.cos(azimuth)];
}

/** Slow, then fast, then slow: cubic. */
export function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** The turn from one compass direction to another, the short way round, in radians. */
export function shortestTurn(from: number, to: number): number {
  const turn = to - from;
  return ((((turn + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}

export interface FlightAngles {
  distance: number;
  azimuth: number;
  polar: number;
}

/**
 * The view's distance and angles at `t` (0 to 1) of a flight, and how far
 * along the target is (`k`, eased): the distance changes evenly in scale,
 * the turn goes the short way round.
 */
export function flightStep(
  from: FlightAngles,
  to: FlightAngles,
  t: number,
): FlightAngles & { k: number } {
  const k = ease(Math.min(1, Math.max(0, t)));
  return {
    k,
    distance: from.distance * (to.distance / from.distance) ** k,
    azimuth: from.azimuth + shortestTurn(from.azimuth, to.azimuth) * k,
    polar: from.polar + (to.polar - from.polar) * k,
  };
}
