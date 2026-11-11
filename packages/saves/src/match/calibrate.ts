import {
  affineScale,
  applyAffine,
  distance,
  fitSimilarity,
  isReflected,
  rmsError,
  type Affine,
  type Point2,
} from './transform';

/**
 * Lining a map up with the game world: finding the transform from world
 * coordinates to map pixels, by hand from points the person marks, or
 * automatically from map pins in the save and places in the pack.
 */

/** A spot the person marked: where the save says they stood, and where they clicked on the map. */
export interface CalibrationPoint {
  world: Point2;
  pixel: Point2;
}

export interface PointFit {
  transform: Affine;
  reflected: boolean;
  /** Root mean square error in map pixels; 0 for two points. */
  rms: number;
  points: number;
}

/**
 * Fits world-to-pixel from marked points. With two points the transform is
 * exact, and mirrored (maps have y down where game worlds have y up, which
 * holds for The Witcher 3); with three or more, whichever of mirrored or
 * not fits better. Null when the points are too close together.
 */
export function fitPoints(
  points: readonly CalibrationPoint[],
  minSpreadWorld = 1,
): PointFit | null {
  if (points.length < 2) return null;
  let spread = 0;
  for (const p of points)
    for (const q of points) spread = Math.max(spread, distance(p.world, q.world));
  if (spread < minSpreadWorld) return null;
  const pairs = points.map((p) => ({ from: p.world, to: p.pixel }));
  const options = points.length === 2 ? [true] : [true, false];
  let best: PointFit | null = null;
  for (const reflect of options) {
    const transform = fitSimilarity(pairs, reflect);
    if (!transform) continue;
    const rms = rmsError(transform, pairs);
    if (!best || rms < best.rms)
      best = { transform, reflected: reflect, rms, points: points.length };
  }
  return best;
}

/** A point of some kind (a map pin kind), in either space. */
export interface KindPoint extends Point2 {
  kind: string;
}

export interface AutoCalibrationInput {
  /** Pins of the save, in world coordinates. */
  pins: readonly KindPoint[];
  /** Places of the pack, in map pixels, with the pin kind of their category. */
  places: readonly KindPoint[];
  /** Matching radius in world units, and the smallest radius in pixels. */
  radiusWorld: number;
  minRadiusPx: number;
  /** Map size, to reject transforms that put the pins far off the map. */
  mapSize: { width: number; height: number };
  /** Hypotheses to try (each is tried mirrored and not). Default 12,000. */
  iterations?: number;
  seed?: number;
  /**
   * Also guess from neighbours: a pin and its n-th nearest pin of the same
   * kind against a place and its n-th nearest place. When pins and places
   * are mostly the same points (a table of every pin of a kind against a
   * pack's places of that kind), this finds the transform with hundreds of
   * points, where pairs picked at random would almost never be right.
   */
  neighbourPairs?: boolean;
}

export interface AutoCalibration {
  transform: Affine;
  reflected: boolean;
  /** Pins that landed on a place of their kind. */
  inliers: number;
  /** Pins of kinds that the pack has places of: the most that could land. */
  candidates: number;
  /** Root mean square distance of the inliers from their places, in map pixels. */
  rms: number;
  /** Map pixels per world unit. */
  scale: number;
}

/** The least share of candidate pins that must land on a place for a fit to count. */
export const MIN_INLIER_SHARE = 0.3;
/** The least number of pins that must land on a place for a fit to count. */
export const MIN_INLIERS = 5;

/** The best fit {@link findFit} found, before any bar is applied. */
export interface FitFound extends AutoCalibration {
  /** Places of the kinds of the candidate pins: the most that could be matched from that side. */
  places: number;
  /** The matching radius in map pixels, at the fit's scale. */
  radius: number;
}

/**
 * Finds world-to-pixel by registering the save's pins against the pack's
 * places of the same kinds, without knowing which pin is which place:
 * RANSAC over similarity transforms (mirrored or not). Each round picks
 * two pins and two places of one kind, assumes they correspond, and counts
 * how many other pins then land within the radius of a place of their
 * kind. The best guess is refined by least squares over its matches.
 * Returns null when no transform makes enough pins land (see
 * {@link MIN_INLIERS}, {@link MIN_INLIER_SHARE}).
 */
export function autoCalibrate(input: AutoCalibrationInput): AutoCalibration | null {
  const fit = findFit(input);
  if (!fit || fit.inliers < MIN_INLIERS || fit.inliers < MIN_INLIER_SHARE * fit.candidates) {
    return null;
  }
  const { places: _places, radius: _radius, ...calibration } = fit;
  return calibration;
}

/**
 * The best world-to-pixel fit of pins to places (see {@link autoCalibrate}),
 * however few pins land: the caller decides whether it is good enough.
 * Null when no guess made even a few pins land.
 */
export function findFit(input: AutoCalibrationInput): FitFound | null {
  const random = mulberry32(input.seed ?? 0x5a7e);
  const pinsByKind = groupByKind(input.pins);
  const placesByKind = groupByKind(input.places);
  const kinds = [...pinsByKind.keys()].filter(
    (kind) => (placesByKind.get(kind)?.length ?? 0) >= 2 && pinsByKind.get(kind)!.length >= 2,
  );
  const candidatePins = input.pins.filter((pin) => placesByKind.has(pin.kind));
  const candidatePlaces = input.places.filter((place) => pinsByKind.has(place.kind)).length;
  if (kinds.length === 0 || candidatePins.length < 3) return null;

  // Rarer kinds give a correct guess more often, so they are tried more.
  const weights = kinds.map((k) => 1 / (pinsByKind.get(k)!.length * placesByKind.get(k)!.length));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const pickKind = () => {
    let r = random() * totalWeight;
    for (let i = 0; i < kinds.length; i++) {
      r -= weights[i]!;
      if (r <= 0) return kinds[i]!;
    }
    return kinds[kinds.length - 1]!;
  };
  const grid = new KindGrid(input.places, input.mapSize.width, input.mapSize.height);
  // Enough pins that about eight land when the guess is right, even where
  // the places cover only part of the pins.
  const probeSize = Math.min(
    400,
    Math.max(24, Math.ceil((8 * candidatePins.length) / Math.max(1, candidatePlaces))),
  );
  const probe = sample(candidatePins, probeSize, random);
  const extent = Math.max(input.mapSize.width, input.mapSize.height);
  const enough = 0.9 * Math.min(candidatePins.length, candidatePlaces);
  const pinNeighbours = input.neighbourPairs ? neighboursByKind(pinsByKind, kinds) : null;
  const placeNeighbours = input.neighbourPairs ? neighboursByKind(placesByKind, kinds) : null;

  let best: { transform: Affine; reflected: boolean; score: number } | null = null;
  const iterations = input.iterations ?? 12_000;
  for (let i = 0; i < iterations; i++) {
    const kind = pickKind();
    const pins = pinsByKind.get(kind)!;
    const places = placesByKind.get(kind)!;
    let a: KindPoint, b: KindPoint, c: KindPoint, d: KindPoint;
    if (pinNeighbours && placeNeighbours && i % 2 === 0) {
      // A pin and one of its nearest pins against a place and one of its
      // nearest places. The same rank is tried more often: where pins and
      // places are the same points, it is the right one.
      const n = Math.floor(random() * NEIGHBOURS);
      const m = random() < 0.5 ? n : Math.floor(random() * NEIGHBOURS);
      const pin = Math.floor(random() * pins.length);
      const place = Math.floor(random() * places.length);
      const pinNext = pinNeighbours.get(kind)![pin]![n];
      const placeNext = placeNeighbours.get(kind)![place]![m];
      if (pinNext === undefined || placeNext === undefined) continue;
      a = pins[pin]!;
      b = pins[pinNext]!;
      c = places[place]!;
      d = places[placeNext]!;
    } else {
      a = pins[Math.floor(random() * pins.length)]!;
      b = pins[Math.floor(random() * pins.length)]!;
      c = places[Math.floor(random() * places.length)]!;
      d = places[Math.floor(random() * places.length)]!;
    }
    if (a === b || c === d || distance(a, b) < 1e-6) continue;
    for (const reflected of [true, false]) {
      const transform = fitSimilarity(
        [
          { from: a, to: c },
          { from: b, to: d },
        ],
        reflected,
      );
      if (!transform) continue;
      const scale = affineScale(transform);
      const radius = Math.max(input.minRadiusPx, input.radiusWorld * scale);
      // A radius this large would make anything match: no game world is that small.
      if (radius > extent / 24) continue;
      if (countLanding(probe, transform, radius, grid) < 3) continue;
      const score = countLanding(candidatePins, transform, radius, grid);
      if (!best || score > best.score) best = { transform, reflected, score };
    }
    if (best && best.score >= enough) break;
  }
  if (!best) return null;

  // Refine: match one to one, fit by least squares, repeat.
  let transform = best.transform;
  for (let round = 0; round < 4; round++) {
    const radius = Math.max(input.minRadiusPx, input.radiusWorld * affineScale(transform));
    const matched = oneToOne(candidatePins, transform, radius, grid);
    const refined = matched.length >= 2 ? fitSimilarity(matched, best.reflected) : null;
    if (!refined) break;
    transform = refined;
  }
  const radius = Math.max(input.minRadiusPx, input.radiusWorld * affineScale(transform));
  const pairs = oneToOne(candidatePins, transform, radius, grid);
  return {
    transform,
    reflected: isReflected(transform),
    inliers: pairs.length,
    candidates: candidatePins.length,
    rms: pairs.length > 0 ? rmsError(transform, pairs) : 0,
    scale: affineScale(transform),
    places: candidatePlaces,
    radius,
  };
}

/** How many nearest neighbours of its kind each point keeps, for guesses from neighbours. */
const NEIGHBOURS = 4;

/** For each kind, each point's nearest points of that kind, by index, nearest first. */
function neighboursByKind(
  byKind: ReadonlyMap<string, readonly KindPoint[]>,
  kinds: readonly string[],
): Map<string, number[][]> {
  const result = new Map<string, number[][]>();
  for (const kind of kinds) {
    const points = byKind.get(kind)!;
    result.set(
      kind,
      points.map((point, i) => {
        const nearest: { index: number; distance: number }[] = [];
        for (let j = 0; j < points.length; j++) {
          if (j === i) continue;
          const d = distance(point, points[j]!);
          if (d < 1e-6) continue;
          if (nearest.length < NEIGHBOURS || d < nearest[nearest.length - 1]!.distance) {
            nearest.push({ index: j, distance: d });
            nearest.sort((p, q) => p.distance - q.distance);
            if (nearest.length > NEIGHBOURS) nearest.pop();
          }
        }
        return nearest.map((n) => n.index);
      }),
    );
  }
  return result;
}

function groupByKind<T extends KindPoint>(points: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const point of points) {
    const list = groups.get(point.kind);
    if (list) list.push(point);
    else groups.set(point.kind, [point]);
  }
  return groups;
}

/**
 * How many places pins land on, each place counted once: a guess that
 * shrinks the world onto a few places must not score as if every pin
 * landed on one of its own.
 */
function countLanding(
  pins: readonly KindPoint[],
  transform: Affine,
  radius: number,
  grid: KindGrid,
): number {
  const landed = new Set<KindPoint>();
  for (const pin of pins) {
    const place = grid.nearest(applyAffine(transform, pin), pin.kind, radius);
    if (place) landed.add(place);
  }
  return landed.size;
}

/** Pins and the places they land on, each place used once, nearest first. */
function oneToOne(
  pins: readonly KindPoint[],
  transform: Affine,
  radius: number,
  grid: KindGrid,
): { from: Point2; to: Point2 }[] {
  const options: { pin: KindPoint; place: KindPoint; distance: number }[] = [];
  for (const pin of pins) {
    const at = applyAffine(transform, pin);
    for (const place of grid.within(at, pin.kind, radius)) {
      options.push({ pin, place, distance: distance(at, place) });
    }
  }
  options.sort((p, q) => p.distance - q.distance);
  const usedPins = new Set<KindPoint>();
  const usedPlaces = new Set<KindPoint>();
  const pairs: { from: Point2; to: Point2 }[] = [];
  for (const option of options) {
    if (usedPins.has(option.pin) || usedPlaces.has(option.place)) continue;
    usedPins.add(option.pin);
    usedPlaces.add(option.place);
    pairs.push({ from: option.pin, to: option.place });
  }
  return pairs;
}

/** A uniform grid of points by kind over a map, for "what is near here". */
export class KindGrid<T extends KindPoint = KindPoint> {
  private readonly grids = new Map<string, (T[] | undefined)[]>();
  private readonly cell: number;
  private readonly columns: number;
  private readonly rows: number;

  constructor(points: readonly T[], width: number, height: number, cells = 64) {
    this.cell = Math.max(Math.max(width, height, 1) / cells, 1e-6);
    this.columns = Math.max(1, Math.ceil(width / this.cell));
    this.rows = Math.max(1, Math.ceil(height / this.cell));
    for (const point of points) {
      const index = this.index(point);
      if (index === null) continue;
      let grid = this.grids.get(point.kind);
      if (!grid) {
        grid = new Array<T[] | undefined>(this.columns * this.rows);
        this.grids.set(point.kind, grid);
      }
      (grid[index] ??= []).push(point);
    }
  }

  private index(point: Point2): number | null {
    const cx = Math.floor(point.x / this.cell);
    const cy = Math.floor(point.y / this.cell);
    if (cx < 0 || cy < 0 || cx >= this.columns || cy >= this.rows) return null;
    return cy * this.columns + cx;
  }

  /** Points of a kind within `radius` of `at`. */
  within(at: Point2, kind: string, radius: number): T[] {
    const grid = this.grids.get(kind);
    if (!grid || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return [];
    const x0 = Math.max(0, Math.floor((at.x - radius) / this.cell));
    const x1 = Math.min(this.columns - 1, Math.floor((at.x + radius) / this.cell));
    const y0 = Math.max(0, Math.floor((at.y - radius) / this.cell));
    const y1 = Math.min(this.rows - 1, Math.floor((at.y + radius) / this.cell));
    const found: T[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        for (const point of grid[y * this.columns + x] ?? []) {
          if (distance(at, point) <= radius) found.push(point);
        }
      }
    }
    return found;
  }

  /** The nearest point of a kind within `radius`, or null. */
  nearest(at: Point2, kind: string, radius: number): T | null {
    let best: T | null = null;
    let bestDistance = Infinity;
    for (const point of this.within(at, kind, radius)) {
      const d = distance(at, point);
      if (d < bestDistance) {
        best = point;
        bestDistance = d;
      }
    }
    return best;
  }
}

function sample<T>(items: readonly T[], count: number, random: () => number): T[] {
  if (items.length <= count) return [...items];
  const copy = [...items];
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, count);
}

/** A small seeded random number generator, so calibration gives the same answer every time. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
