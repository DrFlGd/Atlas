import { Field, createPerlin, fbm } from '../noise';
import { deriveSeed } from '../random';

/** Low-resolution elevation and moisture fields for the demo world. */
export interface Terrain {
  /** Edge length of the square world in image pixels. */
  size: number;
  /** Elevation; below 0 is water. Covers the whole world. */
  elevation: Field;
  /** Moisture in [0, 1]. Covers the whole world. */
  moisture: Field;
  /** Tileable fine-detail noise used for texture at full resolution. */
  detail: Field;
}

const ELEVATION_GRID = 1024;
const MOISTURE_GRID = 256;
const DETAIL_GRID = 512;

/** Builds the terrain fields for a square world of `size` pixels. */
export function createTerrain(seed: number, size: number): Terrain {
  const base = createPerlin(deriveSeed(seed, 'elevation'));
  const warpX = createPerlin(deriveSeed(seed, 'warp-x'));
  const warpY = createPerlin(deriveSeed(seed, 'warp-y'));
  const ridges = createPerlin(deriveSeed(seed, 'ridges'));
  const wet = createPerlin(deriveSeed(seed, 'moisture'));

  const elevation = Field.generate(ELEVATION_GRID, ELEVATION_GRID, (gx, gy) => {
    const u = gx / (ELEVATION_GRID - 1);
    const v = gy / (ELEVATION_GRID - 1);
    const wx = u + 0.09 * fbm(warpX, u * 3, v * 3, 3);
    const wy = v + 0.09 * fbm(warpY, u * 3 + 7.3, v * 3 + 1.9, 3);
    const dx = (wx - 0.5) * 2;
    const dy = (wy - 0.5) * 2;
    // Blend round and square falloff so the land mass fills the frame
    // without touching the edges.
    const distance = 0.6 * Math.hypot(dx, dy) + 0.4 * Math.max(Math.abs(dx), Math.abs(dy));
    let h = fbm(base, wx * 4, wy * 4, 6) * 0.95 + 0.3 - 1.05 * distance ** 2.6;
    if (h > 0) {
      const ridge = 1 - Math.abs(fbm(ridges, wx * 5, wy * 5, 4));
      h += h * 0.9 * ridge ** 4;
    }
    return h;
  });

  const moisture = Field.generate(MOISTURE_GRID, MOISTURE_GRID, (gx, gy) => {
    const u = gx / (MOISTURE_GRID - 1);
    const v = gy / (MOISTURE_GRID - 1);
    return Math.min(1, Math.max(0, 0.5 + 0.9 * fbm(wet, u * 5 + 11, v * 5 + 3, 4)));
  });

  // Octaves with doubling lattice periods so the sum still tiles.
  const detailOctaves = [0, 1, 2, 3].map((i) => ({
    noise: createPerlin(deriveSeed(seed, `detail-${i}`), 8 * 2 ** i),
    scale: (8 * 2 ** i) / DETAIL_GRID,
    amplitude: 0.5 ** i,
  }));
  const detail = Field.generate(DETAIL_GRID, DETAIL_GRID, (x, y) => {
    let sum = 0;
    for (const octave of detailOctaves) {
      sum += octave.amplitude * octave.noise(x * octave.scale, y * octave.scale);
    }
    return sum / 1.875;
  });

  return { size, elevation, moisture, detail };
}

/** Elevation at an image pixel, without fine detail. */
export function elevationAt(terrain: Terrain, x: number, y: number): number {
  const f = (ELEVATION_GRID - 1) / terrain.size;
  return terrain.elevation.sample(x * f, y * f);
}

/** Moisture at an image pixel. */
export function moistureAt(terrain: Terrain, x: number, y: number): number {
  const f = (MOISTURE_GRID - 1) / terrain.size;
  return terrain.moisture.sample(x * f, y * f);
}

type Rgb = readonly [number, number, number];

const hex = (value: string): Rgb => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];

const DEEP_WATER = hex('#0d2236');
const OPEN_WATER = hex('#173b57');
const SHALLOW_WATER = hex('#2a6c83');
const SAND = hex('#c8b27a');
const DRY_GRASS = hex('#a79a5c');
const GRASS = hex('#6a8f45');
const FOREST = hex('#2f5a33');
const HILLS = hex('#77704f');
const ROCK = hex('#857d72');
const SNOW = hex('#e9edf0');

const smooth = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export interface RenderOptions {
  /** Border strength (0 to 1) at a world pixel; borders are darkened into the land. */
  borders?: (x: number, y: number) => number;
}

/**
 * Renders the terrain as a raw RGB image of `outSize` x `outSize` pixels.
 * The image is a coloured relief map: water deepening away from the coast,
 * vegetation by moisture, rock and snow with height, hill shading lit from the
 * north-west, contour lines and region borders on land.
 */
export function renderTerrain(
  terrain: Terrain,
  outSize: number,
  options: RenderOptions = {},
): Buffer {
  const { borders } = options;
  const { elevation, moisture, detail } = terrain;
  const out = Buffer.alloc(outSize * outSize * 3);
  const elevationScale = (ELEVATION_GRID - 1) / outSize;
  const moistureScale = (MOISTURE_GRID - 1) / outSize;
  // Fine detail is defined per world pixel so its look does not depend on the output size.
  const worldPerOut = terrain.size / outSize;
  const contourStep = 0.07;

  // Hill shading uses slope fields computed once on the coarse grids and then
  // interpolated, which keeps the shading smooth across grid cells.
  const elevationCell = terrain.size / (ELEVATION_GRID - 1);
  const elevationSlope = slopeField(elevation, elevationCell, false);
  const detailSlope = slopeField(detail, 1, true);
  const fineOctaves = [
    { scale: 0.5, amplitude: 0.022, offset: 0 },
    { scale: 0.137, amplitude: 0.03, offset: 91 },
    { scale: 1.9, amplitude: 0.006, offset: 17 },
  ];
  const lightStrength = 160;

  let previousBands = new Int16Array(outSize);
  let currentBands = new Int16Array(outSize);

  for (let y = 0; y < outSize; y++) {
    const wy = y * worldPerOut;
    let previousBand = 0;
    for (let x = 0; x < outSize; x++) {
      const wx = x * worldPerOut;
      const ex = x * elevationScale;
      const ey = y * elevationScale;
      const base = elevation.sample(ex, ey);
      let fine = 0;
      let fineSlope = 0;
      for (const octave of fineOctaves) {
        const dx = wx * octave.scale + octave.offset;
        const dy = wy * octave.scale + octave.offset;
        fine += detail.sampleWrapped(dx, dy) * octave.amplitude;
        fineSlope += detailSlope.sampleWrapped(dx, dy) * octave.amplitude * octave.scale;
      }
      const landness = smooth(-0.02, 0.05, base);
      const h = base + fine * (0.25 + 0.75 * landness);
      const band = base > 0 ? Math.floor(base / contourStep) : -1;
      currentBands[x] = band;

      let r: number;
      let g: number;
      let b: number;
      if (base < 0) {
        const depth = smooth(0, 0.35, -base);
        const c0 = depth < 0.5 ? SHALLOW_WATER : OPEN_WATER;
        const c1 = depth < 0.5 ? OPEN_WATER : DEEP_WATER;
        const t = depth < 0.5 ? depth * 2 : depth * 2 - 1;
        const ripple = 1 + fine * 1.4;
        r = (c0[0] + (c1[0] - c0[0]) * t) * ripple;
        g = (c0[1] + (c1[1] - c0[1]) * t) * ripple;
        b = (c0[2] + (c1[2] - c0[2]) * t) * ripple;
      } else {
        const wet = moisture.sample(x * moistureScale, y * moistureScale) + fine * 2;
        // Vegetation: dry grass -> grass -> forest as moisture rises.
        const veg0 = wet < 0.5 ? DRY_GRASS : GRASS;
        const veg1 = wet < 0.5 ? GRASS : FOREST;
        const vt = wet < 0.5 ? smooth(0.2, 0.5, wet) : smooth(0.5, 0.75, wet);
        let cr = veg0[0] + (veg1[0] - veg0[0]) * vt;
        let cg = veg0[1] + (veg1[1] - veg0[1]) * vt;
        let cb = veg0[2] + (veg1[2] - veg0[2]) * vt;
        const beach = 1 - smooth(0.0, 0.025, h);
        cr += (SAND[0] - cr) * beach;
        cg += (SAND[1] - cg) * beach;
        cb += (SAND[2] - cb) * beach;
        const hill = smooth(0.22, 0.4, h);
        cr += (HILLS[0] - cr) * hill;
        cg += (HILLS[1] - cg) * hill;
        cb += (HILLS[2] - cb) * hill;
        const rock = smooth(0.4, 0.55, h);
        cr += (ROCK[0] - cr) * rock;
        cg += (ROCK[1] - cg) * rock;
        cb += (ROCK[2] - cb) * rock;
        const snow = smooth(0.62, 0.7, h);
        cr += (SNOW[0] - cr) * snow;
        cg += (SNOW[1] - cg) * snow;
        cb += (SNOW[2] - cb) * snow;

        // Light from the north-west: slopes rising towards the south-east are lit.
        const slope = elevationSlope.sample(ex, ey) + fineSlope * landness;
        let shade = 1 + slope * lightStrength;
        shade = shade < 0.55 ? 0.55 : shade > 1.35 ? 1.35 : shade;
        const onContour =
          band >= 0 && ((x > 0 && band !== previousBand) || (y > 0 && band !== previousBands[x]));
        const contour = onContour ? 0.82 : 1;
        const border = borders ? 1 - 0.5 * borders(Math.round(wx), Math.round(wy)) : 1;
        r = cr * shade * contour * border;
        g = cg * shade * contour * border;
        b = cb * shade * contour * border;
      }
      // Dark coastline where land meets water.
      const land = band >= 0;
      if ((x > 0 && land !== previousBand >= 0) || (y > 0 && land !== previousBands[x]! >= 0)) {
        r *= 0.55;
        g *= 0.55;
        b *= 0.55;
      }
      const o = (y * outSize + x) * 3;
      out[o] = r < 0 ? 0 : r > 255 ? 255 : r;
      out[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      out[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      previousBand = band;
    }
    [previousBands, currentBands] = [currentBands, previousBands];
  }
  return out;
}

/**
 * Sum of the x and y derivatives of a field, per world pixel, by central
 * differences. `cellSize` is the world size of one field cell.
 */
function slopeField(field: Field, cellSize: number, wrap: boolean): Field {
  const { width, height, data } = field;
  const at = (x: number, y: number) => {
    const cx = wrap ? (x + width) % width : Math.min(width - 1, Math.max(0, x));
    const cy = wrap ? (y + height) % height : Math.min(height - 1, Math.max(0, y));
    return data[cy * width + cx]!;
  };
  return Field.generate(
    width,
    height,
    (x, y) => (at(x + 1, y) - at(x - 1, y) + at(x, y + 1) - at(x, y - 1)) / (2 * cellSize),
  );
}
