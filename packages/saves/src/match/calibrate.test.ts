import { describe, expect, it } from 'vitest';
import { autoCalibrate, fitPoints, KindGrid, mulberry32, type KindPoint } from './calibrate';
import {
  affineScale,
  applyAffine,
  fitSimilarity,
  invertAffine,
  isReflected,
  rmsError,
  type Affine,
  type Point2,
} from './transform';

/** World to pixels for a map with y down: scale 0.5, turned a little, mirrored. */
const TRUE: Affine = (() => {
  const s = 0.5;
  const t = 0.1;
  return {
    a: s * Math.cos(t),
    b: s * Math.sin(t),
    c: s * Math.sin(t),
    d: -s * Math.cos(t),
    e: 1200,
    f: 900,
  };
})();

const close = (p: Point2, q: Point2, tolerance = 1e-6) => {
  expect(Math.abs(p.x - q.x)).toBeLessThan(tolerance);
  expect(Math.abs(p.y - q.y)).toBeLessThan(tolerance);
};

describe('transforms', () => {
  it('fits a similarity exactly, mirrored or not', () => {
    const world = [
      { x: 0, y: 0 },
      { x: 100, y: 50 },
      { x: -30, y: 80 },
    ];
    for (const reflect of [true, false]) {
      const truth = reflect ? TRUE : { ...TRUE, c: -TRUE.b, d: TRUE.a };
      const pairs = world.map((from) => ({ from, to: applyAffine(truth, from) }));
      const fit = fitSimilarity(pairs, reflect)!;
      expect(isReflected(fit)).toBe(reflect);
      expect(rmsError(fit, pairs)).toBeLessThan(1e-9);
      for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
        expect(fit[key]).toBeCloseTo(truth[key], 9);
      }
    }
    expect(fitSimilarity([{ from: { x: 1, y: 1 }, to: { x: 2, y: 2 } }], true)).toBeNull();
    expect(
      fitSimilarity(
        [
          { from: { x: 1, y: 1 }, to: { x: 2, y: 2 } },
          { from: { x: 1, y: 1 }, to: { x: 3, y: 3 } },
        ],
        false,
      ),
    ).toBeNull();
  });

  it('inverts and measures', () => {
    const inverse = invertAffine(TRUE)!;
    close(applyAffine(inverse, applyAffine(TRUE, { x: 12, y: -34 })), { x: 12, y: -34 });
    expect(affineScale(TRUE)).toBeCloseTo(0.5, 12);
    expect(isReflected(TRUE)).toBe(true);
    expect(invertAffine({ a: 1, b: 2, c: 2, d: 4, e: 0, f: 0 })).toBeNull();
  });
});

describe('fitPoints', () => {
  it('lines up from two points, mirrored', () => {
    const points = [
      { world: { x: 0, y: 0 }, pixel: applyAffine(TRUE, { x: 0, y: 0 }) },
      { world: { x: 500, y: 300 }, pixel: applyAffine(TRUE, { x: 500, y: 300 }) },
    ];
    const fit = fitPoints(points)!;
    expect(fit.reflected).toBe(true);
    expect(fit.points).toBe(2);
    close(applyAffine(fit.transform, { x: -200, y: 700 }), applyAffine(TRUE, { x: -200, y: 700 }));
  });

  it('picks the better of mirrored or not from three points', () => {
    const notMirrored: Affine = { a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 };
    const world = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    const fit = fitPoints(world.map((w) => ({ world: w, pixel: applyAffine(notMirrored, w) })))!;
    expect(fit.reflected).toBe(false);
    expect(fit.rms).toBeLessThan(1e-9);
  });

  it('refuses points that are too few or too close', () => {
    expect(fitPoints([])).toBeNull();
    expect(fitPoints([{ world: { x: 0, y: 0 }, pixel: { x: 0, y: 0 } }])).toBeNull();
    expect(
      fitPoints([
        { world: { x: 0, y: 0 }, pixel: { x: 0, y: 0 } },
        { world: { x: 0.2, y: 0 }, pixel: { x: 50, y: 0 } },
      ]),
    ).toBeNull();
  });
});

describe('KindGrid', () => {
  it('finds points of a kind near a spot', () => {
    const points: KindPoint[] = [
      { x: 10, y: 10, kind: 'a' },
      { x: 12, y: 10, kind: 'b' },
      { x: 30, y: 30, kind: 'a' },
      { x: -5, y: 10, kind: 'a' }, // off the map: left out
    ];
    const grid = new KindGrid(points, 100, 100, 8);
    expect(grid.within({ x: 11, y: 10 }, 'a', 5)).toEqual([points[0]]);
    expect(grid.nearest({ x: 25, y: 25 }, 'a', 10)).toBe(points[2]);
    expect(grid.nearest({ x: 25, y: 25 }, 'a', 3)).toBeNull();
    expect(grid.within({ x: 0, y: 10 }, 'a', 10)).toEqual([points[0]]);
    expect(grid.within({ x: NaN, y: 0 }, 'a', 10)).toEqual([]);
    expect(grid.within({ x: 10, y: 10 }, 'c', 10)).toEqual([]);
  });
});

/**
 * A synthetic world: places of several kinds over a 4096 px map, the pins a
 * save would have for some of them (in world metres, with a little noise),
 * pins of places the pack does not have, and places the save has no pin for.
 */
function scene(options: {
  seed: number;
  transform: Affine;
  perKind: Record<string, number>;
  share: number;
  extraPins: number;
  noise: number;
}) {
  const random = mulberry32(options.seed);
  const toWorld = invertAffine(options.transform)!;
  const places: KindPoint[] = [];
  const pins: KindPoint[] = [];
  for (const [kind, count] of Object.entries(options.perKind)) {
    for (let i = 0; i < count; i++) {
      const place = { x: 100 + random() * 3896, y: 100 + random() * 3896, kind };
      places.push(place);
      if (random() < options.share) {
        const world = applyAffine(toWorld, place);
        pins.push({
          x: world.x + (random() - 0.5) * options.noise,
          y: world.y + (random() - 0.5) * options.noise,
          kind,
        });
      }
    }
  }
  for (let i = 0; i < options.extraPins; i++) {
    const kinds = Object.keys(options.perKind);
    const world = applyAffine(toWorld, { x: random() * 4096, y: random() * 4096 });
    pins.push({ ...world, kind: kinds[i % kinds.length]! });
  }
  return { places, pins };
}

describe('autoCalibrate', () => {
  const kinds = { signpost: 60, nest: 40, camp: 25, power: 8 };
  const base = { radiusWorld: 25, minRadiusPx: 6, mapSize: { width: 4096, height: 4096 } };

  it('finds the transform from pins of a save and places of a pack', () => {
    const { places, pins } = scene({
      seed: 1,
      transform: TRUE,
      perKind: kinds,
      share: 0.7,
      extraPins: 15,
      noise: 6,
    });
    const fit = autoCalibrate({ ...base, pins, places })!;
    expect(fit).not.toBeNull();
    expect(fit.reflected).toBe(true);
    expect(fit.scale).toBeCloseTo(0.5, 2);
    expect(fit.inliers).toBeGreaterThan(0.6 * fit.candidates);
    expect(fit.rms).toBeLessThan(3);
    for (const world of [
      { x: 0, y: 0 },
      { x: -1500, y: 1500 },
      { x: 2000, y: -900 },
    ]) {
      close(applyAffine(fit.transform, world), applyAffine(TRUE, world), 3);
    }
  });

  it('finds a transform that is not mirrored, at another scale', () => {
    const plain: Affine = { a: 1.6, b: 0, c: 0, d: 1.6, e: 2048, f: 2048 };
    const { places, pins } = scene({
      seed: 2,
      transform: plain,
      perKind: kinds,
      share: 0.5,
      extraPins: 5,
      noise: 4,
    });
    const fit = autoCalibrate({ ...base, pins, places })!;
    expect(fit.reflected).toBe(false);
    close(
      applyAffine(fit.transform, { x: 300, y: 300 }),
      applyAffine(plain, { x: 300, y: 300 }),
      3,
    );
  });

  it('gives the same answer every time', () => {
    const input = {
      ...base,
      ...scene({ seed: 3, transform: TRUE, perKind: kinds, share: 0.6, extraPins: 10, noise: 5 }),
    };
    expect(autoCalibrate(input)).toEqual(autoCalibrate(input));
  });

  it('gives up when the pins do not fit the places', () => {
    const random = mulberry32(9);
    const places = Array.from({ length: 80 }, (_, i) => ({
      x: random() * 4096,
      y: random() * 4096,
      kind: i % 2 ? 'signpost' : 'nest',
    }));
    const pins = Array.from({ length: 40 }, (_, i) => ({
      x: random() * 5000,
      y: random() * 5000,
      kind: i % 2 ? 'signpost' : 'nest',
    }));
    expect(autoCalibrate({ ...base, pins, places, iterations: 3000 })).toBeNull();
  });

  it('gives up with too few pins or no shared kinds', () => {
    const { places, pins } = scene({
      seed: 4,
      transform: TRUE,
      perKind: kinds,
      share: 0.7,
      extraPins: 0,
      noise: 0,
    });
    expect(autoCalibrate({ ...base, pins: pins.slice(0, 4), places })).toBeNull();
    expect(
      autoCalibrate({ ...base, pins: pins.map((p) => ({ ...p, kind: 'other' })), places }),
    ).toBeNull();
  });
});
