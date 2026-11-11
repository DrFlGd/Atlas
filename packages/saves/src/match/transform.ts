/**
 * Plane transforms between a game's world coordinates and a map's pixels.
 * An affine transform uses the canvas matrix order of the pack schema's
 * `worldTransform`: `x' = a*x + c*y + e`, `y' = b*x + d*y + f`.
 */

export interface Point2 {
  x: number;
  y: number;
}

export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export function applyAffine(t: Affine, p: Point2): Point2 {
  return { x: t.a * p.x + t.c * p.y + t.e, y: t.b * p.x + t.d * p.y + t.f };
}

/** Applies only the linear part, for directions. */
export function applyLinear(t: Affine, v: Point2): Point2 {
  return { x: t.a * v.x + t.c * v.y, y: t.b * v.x + t.d * v.y };
}

/** The inverse, or null for a transform that flattens the plane. */
export function invertAffine(t: Affine): Affine | null {
  const det = t.a * t.d - t.b * t.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = t.d / det;
  const b = -t.b / det;
  const c = -t.c / det;
  const d = t.a / det;
  return { a, b, c, d, e: -(a * t.e + c * t.f), f: -(b * t.e + d * t.f) };
}

/** How many target units one source unit becomes (the mean scale). */
export function affineScale(t: Affine): number {
  return Math.sqrt(Math.abs(t.a * t.d - t.b * t.c));
}

/** Whether the transform mirrors (a map with y down from a world with y up does). */
export function isReflected(t: Affine): boolean {
  return t.a * t.d - t.b * t.c < 0;
}

export function distance(p: Point2, q: Point2): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/**
 * The similarity transform (scale, rotation, shift, and a mirror when
 * `reflect`) that best maps each `from` point onto its `to` point in the
 * least-squares sense. Needs two distinct points; null otherwise.
 */
export function fitSimilarity(
  pairs: readonly { from: Point2; to: Point2 }[],
  reflect: boolean,
): Affine | null {
  if (pairs.length < 2) return null;
  const sign = reflect ? -1 : 1;
  let fx = 0;
  let fy = 0;
  let tx = 0;
  let ty = 0;
  for (const { from, to } of pairs) {
    fx += from.x;
    fy += sign * from.y;
    tx += to.x;
    ty += to.y;
  }
  const n = pairs.length;
  fx /= n;
  fy /= n;
  tx /= n;
  ty /= n;
  let sum = 0;
  let re = 0;
  let im = 0;
  for (const { from, to } of pairs) {
    const px = from.x - fx;
    const py = sign * from.y - fy;
    const qx = to.x - tx;
    const qy = to.y - ty;
    sum += px * px + py * py;
    re += qx * px + qy * py;
    im += qy * px - qx * py;
  }
  if (sum < 1e-12) return null;
  const alphaRe = re / sum;
  const alphaIm = im / sum;
  if (Math.hypot(alphaRe, alphaIm) < 1e-12) return null;
  // to = alpha * (x, sign*y) + shift, as complex numbers.
  const a = alphaRe;
  const b = alphaIm;
  const c = -alphaIm * sign;
  const d = alphaRe * sign;
  return {
    a,
    b,
    c,
    d,
    e: tx - (alphaRe * fx - alphaIm * fy),
    f: ty - (alphaIm * fx + alphaRe * fy),
  };
}

/** Root mean square distance between the mapped `from` points and the `to` points. */
export function rmsError(t: Affine, pairs: readonly { from: Point2; to: Point2 }[]): number {
  if (pairs.length === 0) return 0;
  let sum = 0;
  for (const { from, to } of pairs) {
    const p = applyAffine(t, from);
    sum += (p.x - to.x) ** 2 + (p.y - to.y) ** 2;
  }
  return Math.sqrt(sum / pairs.length);
}
