import type { Location, Region } from '@atlas/schema';

/**
 * The names of areas floating over the 3D view, from what a pack already
 * has: its regions (areas, and the areas within them) and the locations
 * in them. Nothing is added to the pack for them, so every pack with
 * regions on a 3D map has them.
 *
 * A title stands at its area's point: the region's `center`, else the
 * middle of its outline (where the 2D map goes for it), else the middle of
 * its locations. Its height is the middle height of the locations in the
 * area (and in the areas within it) that have one; with none, it stands on
 * the model's surface. How far the area reaches is the farthest of its
 * outline's corners, else of its locations.
 *
 * Over the view, titles fade with distance ({@link titleOpacity}): a small
 * area's name only shows near it, a large area's from far, and a large
 * area's fades as the view goes down inside it. They never overlap
 * ({@link placeTitles}): of two that would, the larger area's stays.
 */

export interface AreaTitle {
  /** The region's id. */
  id: string;
  name: string;
  /** Map pixel. */
  px: number;
  py: number;
  /** Its height in the world; null: on the surface below it. */
  height: number | null;
  /** How far the area reaches from its point, in map pixels (0 when nothing says). */
  radius: number;
  /** 0 for a top-level area, 1 for an area within it, and so on. */
  depth: number;
}

/** The middle of a list of numbers, or null for none. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The titles of the areas of a map: those with a point to stand at, larger areas first. */
export function areaTitles(
  regions: Iterable<Region>,
  locations: Iterable<Location>,
  mapId: string,
): AreaTitle[] {
  const own = [...regions].filter((region) => region.mapId === mapId);
  const byId = new Map(own.map((region) => [region.id, region] as const));
  // Each region's locations, with those of the regions within it.
  const inside = new Map<string, Location[]>();
  for (const location of locations) {
    if (location.mapId !== mapId || location.regionId === null) continue;
    const seen = new Set<string>();
    for (
      let region = byId.get(location.regionId);
      region && !seen.has(region.id);
      region = region.parentId ? byId.get(region.parentId) : undefined
    ) {
      seen.add(region.id);
      const list = inside.get(region.id);
      if (list) list.push(location);
      else inside.set(region.id, [location]);
    }
  }
  const depthOf = (region: Region): number => {
    let depth = 0;
    const seen = new Set<string>([region.id]);
    for (let parent = region.parentId; parent && !seen.has(parent); depth++) {
      seen.add(parent);
      parent = byId.get(parent)?.parentId ?? null;
    }
    return depth;
  };

  const titles: AreaTitle[] = [];
  for (const region of own) {
    const located = inside.get(region.id) ?? [];
    let point: [number, number] | null = null;
    const outline = region.polygon && region.polygon.length >= 3 ? region.polygon : null;
    if (region.center) point = [region.center[0], region.center[1]];
    else if (outline) {
      const xs = outline.map((p) => p[0]);
      const ys = outline.map((p) => p[1]);
      point = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    } else if (located.length > 0) {
      point = [
        located.reduce((sum, l) => sum + l.x, 0) / located.length,
        located.reduce((sum, l) => sum + l.y, 0) / located.length,
      ];
    }
    if (!point) continue;
    const [px, py] = point;
    const reach = (outline ?? located.map((l) => [l.x, l.y] as const)).map((p) =>
      Math.hypot(p[0] - px, p[1] - py),
    );
    titles.push({
      id: region.id,
      name: region.name,
      px,
      py,
      height: median(located.flatMap((l) => (l.height === undefined ? [] : [l.height]))),
      radius: reach.length > 0 ? Math.max(...reach) : 0,
      depth: depthOf(region),
    });
  }
  return titles.sort(byPriority);
}

/** Larger areas first, then those higher up the tree, then by name. */
function byPriority(
  a: Pick<AreaTitle, 'radius' | 'depth' | 'id'>,
  b: Pick<AreaTitle, 'radius' | 'depth' | 'id'>,
): number {
  return b.radius - a.radius || a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** Titles fainter than this are left out. */
export const MIN_TITLE_OPACITY = 0.05;

/**
 * How plainly a title shows with the camera `distance` from its point (all
 * in metres): in full up to ten times its area's `radius` plus three
 * tenths of the model's `size`, gone at twice that; and an area larger
 * than the view's surroundings fades as the view goes down into it (under
 * a fifth of its radius).
 */
export function titleOpacity(distance: number, radius: number, size: number): number {
  const far = radius * 10 + size * 0.3;
  const fadeFar = 1 - smoothstep(far, far * 2, distance);
  const near = radius * 0.2;
  const fadeNear = near > 0 ? smoothstep(near * 0.5, near, distance) : 1;
  return fadeFar * fadeNear;
}

/** A title as the view shows it now. */
export interface TitleOnScreen {
  id: string;
  /** Its point in the view's box, in CSS pixels; the title stands centred above it. */
  x: number;
  y: number;
  /** The title's size, in CSS pixels. */
  width: number;
  height: number;
  /** From the camera to its point, in metres. */
  distance: number;
  /** How far its area reaches, in metres. */
  radius: number;
  depth: number;
  /** In front of the camera and not cut away. */
  shown: boolean;
}

/** The gap kept between two titles, in CSS pixels. */
const TITLE_GAP = 4;

/** A box in the view, in CSS pixels. */
export interface ViewBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * How plainly each title shows (0: hidden): faded by distance (see {@link
 * titleOpacity}), and never over another: where two would overlap, the
 * larger area's stays and the other is hidden. The `keep` title (the one
 * with the focus) stays whatever it meets. Titles not wholly inside the
 * view, under something over it (`covered`: the view's tools), behind the
 * camera or cut away are hidden.
 */
export function placeTitles(
  titles: readonly TitleOnScreen[],
  view: { width: number; height: number },
  size: number,
  keep: string | null = null,
  covered: readonly ViewBox[] = [],
): Map<string, number> {
  const out = new Map<string, number>();
  const candidates: { title: TitleOnScreen; opacity: number }[] = [];
  for (const title of titles) {
    out.set(title.id, 0);
    if (!title.shown) continue;
    const opacity = titleOpacity(title.distance, title.radius, size);
    if (opacity < MIN_TITLE_OPACITY && title.id !== keep) continue;
    const left = title.x - title.width / 2;
    const top = title.y - title.height;
    if (left < 0 || left + title.width > view.width || top < 0 || title.y > view.height) continue;
    candidates.push({ title, opacity: Math.max(opacity, title.id === keep ? 1 : 0) });
  }
  candidates.sort(
    (a, b) =>
      Number(b.title.id === keep) - Number(a.title.id === keep) || byPriority(a.title, b.title),
  );
  const placed: ViewBox[] = [...covered];
  for (const { title, opacity } of candidates) {
    const box = {
      left: title.x - title.width / 2 - TITLE_GAP / 2,
      top: title.y - title.height - TITLE_GAP / 2,
      right: title.x + title.width / 2 + TITLE_GAP / 2,
      bottom: title.y + TITLE_GAP / 2,
    };
    const hit = placed.some(
      (other) =>
        box.left < other.right &&
        other.left < box.right &&
        box.top < other.bottom &&
        other.top < box.bottom,
    );
    if (hit) continue;
    placed.push(box);
    out.set(title.id, opacity);
  }
  return out;
}
