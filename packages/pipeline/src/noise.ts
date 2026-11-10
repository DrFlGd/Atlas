import { createRandom } from './random';

/** A 2D gradient-noise function returning values in roughly [-1, 1]. */
export type Noise2D = (x: number, y: number) => number;

const GRADIENTS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [Math.SQRT1_2, Math.SQRT1_2],
  [-Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2],
  [-Math.SQRT1_2, -Math.SQRT1_2],
] as const;

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Perlin gradient noise. With `period`, the lattice wraps every `period`
 * units in both axes, which makes the noise tile seamlessly.
 */
export function createPerlin(seed: number, period = 256): Noise2D {
  const random = createRandom(seed);
  const size = 256;
  const perm = new Uint8Array(size * 2);
  const base = Array.from({ length: size }, (_, i) => i);
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [base[i], base[j]] = [base[j]!, base[i]!];
  }
  for (let i = 0; i < size * 2; i++) perm[i] = base[i % size]!;
  const wrap = Math.min(period, size);

  const gradientDot = (ix: number, iy: number, dx: number, dy: number) => {
    const hx = ((ix % wrap) + wrap) % wrap;
    const hy = ((iy % wrap) + wrap) % wrap;
    const g = GRADIENTS[perm[perm[hx]! + hy]! & 7]!;
    return g[0] * dx + g[1] * dy;
  };

  return (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const n00 = gradientDot(x0, y0, fx, fy);
    const n10 = gradientDot(x0 + 1, y0, fx - 1, fy);
    const n01 = gradientDot(x0, y0 + 1, fx, fy - 1);
    const n11 = gradientDot(x0 + 1, y0 + 1, fx - 1, fy - 1);
    const u = fade(fx);
    const v = fade(fy);
    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return (a + v * (b - a)) * 1.4142;
  };
}

/** Fractal Brownian motion: octaves of noise at doubling frequency and halving amplitude. */
export function fbm(noise: Noise2D, x: number, y: number, octaves: number, gain = 0.5): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * noise(x * frequency, y * frequency);
    norm += amplitude;
    amplitude *= gain;
    frequency *= 2;
  }
  return sum / norm;
}

/** A float raster with bilinear sampling. */
export class Field {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly data: Float32Array = new Float32Array(width * height),
  ) {}

  static generate(width: number, height: number, fn: (x: number, y: number) => number): Field {
    const field = new Field(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) field.data[y * width + x] = fn(x, y);
    }
    return field;
  }

  /** Bilinear sample at fractional cell coordinates, clamped at the edges. */
  sample(x: number, y: number): number {
    const maxX = this.width - 1;
    const maxY = this.height - 1;
    const cx = x < 0 ? 0 : x > maxX ? maxX : x;
    const cy = y < 0 ? 0 : y > maxY ? maxY : y;
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = x0 < maxX ? x0 + 1 : x0;
    const y1 = y0 < maxY ? y0 + 1 : y0;
    const fx = cx - x0;
    const fy = cy - y0;
    const d = this.data;
    const top = d[y0 * this.width + x0]! * (1 - fx) + d[y0 * this.width + x1]! * fx;
    const bottom = d[y1 * this.width + x0]! * (1 - fx) + d[y1 * this.width + x1]! * fx;
    return top * (1 - fy) + bottom * fy;
  }

  /** Bilinear sample that wraps around both edges, for tileable textures. */
  sampleWrapped(x: number, y: number): number {
    const w = this.width;
    const h = this.height;
    const fx0 = Math.floor(x);
    const fy0 = Math.floor(y);
    const fx = x - fx0;
    const fy = y - fy0;
    const x0 = ((fx0 % w) + w) % w;
    const y0 = ((fy0 % h) + h) % h;
    const x1 = (x0 + 1) % w;
    const y1 = (y0 + 1) % h;
    const d = this.data;
    const top = d[y0 * w + x0]! * (1 - fx) + d[y0 * w + x1]! * fx;
    const bottom = d[y1 * w + x0]! * (1 - fx) + d[y1 * w + x1]! * fx;
    return top * (1 - fy) + bottom * fy;
  }
}
