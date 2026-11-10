/** A polygon as a list of `[x, y]` vertices, implicitly closed. */
export type Polygon = [number, number][];

/**
 * Clips a convex polygon to the half-plane of points closer to `a` than to
 * `b` (Sutherland–Hodgman against their perpendicular bisector).
 */
function clipCloserTo(
  polygon: Polygon,
  a: readonly [number, number],
  b: readonly [number, number],
): Polygon {
  const nx = b[0] - a[0];
  const ny = b[1] - a[1];
  const c = (b[0] * b[0] + b[1] * b[1] - a[0] * a[0] - a[1] * a[1]) / 2;
  const side = (p: readonly [number, number]) => c - (p[0] * nx + p[1] * ny); // >= 0 means closer to a
  const out: Polygon = [];
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    const sc = side(current);
    const sn = side(next);
    if (sc >= 0) out.push(current);
    if (sc >= 0 !== sn >= 0) {
      const t = sc / (sc - sn);
      out.push([current[0] + (next[0] - current[0]) * t, current[1] + (next[1] - current[1]) * t]);
    }
  }
  return out;
}

/**
 * Voronoi cells of `sites` inside a convex `boundary`, one cell per site in
 * the same order. Cells are convex and together cover the boundary exactly.
 * Quadratic in the number of sites, which is fine for a handful of regions.
 */
export function voronoiCells(
  sites: readonly (readonly [number, number])[],
  boundary: Polygon,
): Polygon[] {
  return sites.map((site, i) => {
    let cell = boundary.map(([x, y]) => [x, y] as [number, number]);
    sites.forEach((other, j) => {
      if (i !== j && cell.length > 0) cell = clipCloserTo(cell, site, other);
    });
    return cell;
  });
}

/** An axis-aligned rectangle as a clockwise polygon (in y-down image space). */
export function rectangle(minX: number, minY: number, maxX: number, maxY: number): Polygon {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}
