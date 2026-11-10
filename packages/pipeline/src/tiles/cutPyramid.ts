import { availableParallelism } from 'node:os';
import { pyramidLevel, pyramidMaxZoom } from '@atlas/core';
import sharp from 'sharp';

/** An uncompressed image held in memory, as sharp's raw format describes it. */
export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 3 | 4;
}

export interface Tile {
  z: number;
  x: number;
  y: number;
  data: Buffer;
}

export interface CutOptions {
  tileSize?: number;
  /** Lowest level to produce; defaults to 0. */
  minZoom?: number;
  /** WebP quality, 1 to 100. */
  quality?: number;
  /** Tiles encoded concurrently. */
  concurrency?: number;
}

export interface Pyramid {
  tileSize: number;
  minZoom: number;
  maxZoom: number;
  tiles: Tile[];
}

/**
 * Cuts an image into a WebP tile pyramid. The top level `maxZoom` holds the
 * image at full resolution; each level below is downscaled by half. Tiles on
 * the right and bottom edges that the image does not fill are padded with
 * transparency so every tile is `tileSize` square.
 */
export async function cutPyramid(image: RawImage, options: CutOptions = {}): Promise<Pyramid> {
  const tileSize = options.tileSize ?? 256;
  const minZoom = options.minZoom ?? 0;
  const quality = options.quality ?? 82;
  const concurrency = options.concurrency ?? Math.max(2, availableParallelism());
  const maxZoom = pyramidMaxZoom(image.width, image.height, tileSize);
  const tiles: Tile[] = [];

  let level: RawImage = image;
  for (let z = maxZoom; z >= minZoom; z--) {
    const spec = pyramidLevel(image.width, image.height, tileSize, maxZoom, z);
    if (z < maxZoom) level = await downscale(level, spec.width, spec.height);

    const jobs: (() => Promise<Tile>)[] = [];
    for (let row = 0; row < spec.rows; row++) {
      for (let col = 0; col < spec.columns; col++) {
        jobs.push(() => encodeTile(level, z, col, row, tileSize, quality));
      }
    }
    tiles.push(...(await runPool(jobs, concurrency)));
  }
  return { tileSize, minZoom, maxZoom, tiles };
}

async function downscale(image: RawImage, width: number, height: number): Promise<RawImage> {
  const { data, info } = await sharp(image.data, { raw: rawInfo(image) })
    .resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels as 3 | 4 };
}

async function encodeTile(
  level: RawImage,
  z: number,
  x: number,
  y: number,
  tileSize: number,
  quality: number,
): Promise<Tile> {
  const left = x * tileSize;
  const top = y * tileSize;
  const width = Math.min(tileSize, level.width - left);
  const height = Math.min(tileSize, level.height - top);
  let pipeline = sharp(level.data, { raw: rawInfo(level) }).extract({ left, top, width, height });
  if (width < tileSize || height < tileSize) {
    pipeline = pipeline.ensureAlpha().extend({
      right: tileSize - width,
      bottom: tileSize - height,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }
  const data = await pipeline.webp({ quality, effort: 4 }).toBuffer();
  return { z, x, y, data };
}

function rawInfo(image: RawImage) {
  return { width: image.width, height: image.height, channels: image.channels };
}

/** Runs async jobs with at most `limit` in flight, keeping results in job order. */
async function runPool<T>(jobs: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await jobs[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}
