import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TileSource } from '@atlas/schema';
import { cutPyramid } from '../tiles/cutPyramid';
import { writePmtiles } from '../tiles/pmtiles';
import { assertValidPack, writePackJson, writeTileFolder } from '../pack/writePack';
import { generateDemoContent, layoutRegions, regionBorderStrength } from './content';
import { createTerrain, renderTerrain } from './terrain';

export type TileFormat = 'pmtiles' | 'xyz';

export interface DemoPackOptions {
  seed: number;
  /** Edge length of the square map image in pixels. */
  size: number;
  tileSize: number;
  locationCount: number;
  tileFormat: TileFormat;
}

export const DEFAULT_DEMO_OPTIONS: DemoPackOptions = {
  seed: 20261110,
  size: 8192,
  tileSize: 256,
  locationCount: 5000,
  tileFormat: 'pmtiles',
};

/** Files in the output folder that belong to the repository, not to the build. */
const KEPT_FILES = new Set(['README.md', '.gitignore']);
export const STAMP_FILE = '.build-stamp.json';

export interface DemoPackSummary {
  locations: number;
  regions: number;
  tiles: number;
  tileBytes: number;
  maxZoom: number;
  millis: { content: number; render: number; tiles: number; write: number };
}

const LAYER_TILE_PATH = 'tiles/surface';

/**
 * Generates the demo pack into `outDir`: procedural map image, tile pyramid,
 * regions, categories and locations. Everything is derived from the seed, so
 * the same options always give the same pack. The pack is assembled in a
 * staging folder next to `outDir` and moved in at the end, so a failed build
 * leaves the previous pack in place.
 */
export async function buildDemoPack(
  outDir: string,
  options: DemoPackOptions,
  extraStamp: Record<string, unknown> = {},
  log?: (message: string) => void,
): Promise<DemoPackSummary> {
  const started = performance.now();
  const lap = (() => {
    let last = started;
    return () => {
      const now = performance.now();
      const elapsed = Math.round(now - last);
      last = now;
      return elapsed;
    };
  })();

  const tiles: TileSource =
    options.tileFormat === 'pmtiles'
      ? { type: 'pmtiles', url: `${LAYER_TILE_PATH}.pmtiles` }
      : { type: 'xyz', url: `${LAYER_TILE_PATH}/{z}/{x}/{y}.webp` };

  log?.(`Generating terrain and content (seed ${options.seed}, ${options.size} px)`);
  const terrain = createTerrain(options.seed, options.size);
  const layout = layoutRegions(options.seed, terrain);
  const data = assertValidPack(
    generateDemoContent(terrain, layout, {
      seed: options.seed,
      size: options.size,
      tileSize: options.tileSize,
      locationCount: options.locationCount,
      tiles,
    }),
  );
  const contentMs = lap();

  log?.('Rendering map image');
  const image = renderTerrain(terrain, options.size, { borders: regionBorderStrength(layout) });
  const renderMs = lap();

  log?.('Cutting tiles');
  const pyramid = await cutPyramid(
    { data: image, width: options.size, height: options.size, channels: 3 },
    { tileSize: options.tileSize },
  );
  const tilesMs = lap();

  const staging = `${outDir.replace(/[/\\]+$/, '')}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, 'tiles'), { recursive: true });
  await writePackJson(staging, data);
  if (options.tileFormat === 'pmtiles') {
    const archive = writePmtiles(pyramid.tiles, {
      tileType: 'webp',
      minZoom: pyramid.minZoom,
      maxZoom: pyramid.maxZoom,
      metadata: {
        name: data.manifest.title,
        attribution: data.manifest.attribution.map((a) => a.name).join(', '),
        atlas: { width: options.size, height: options.size, tileSize: options.tileSize },
      },
    });
    await writeFile(join(staging, `${LAYER_TILE_PATH}.pmtiles`), archive);
  } else {
    await writeTileFolder(join(staging, LAYER_TILE_PATH), pyramid.tiles);
  }
  await writeFile(
    join(staging, STAMP_FILE),
    `${JSON.stringify({ ...extraStamp, options }, null, 2)}\n`,
  );

  await mkdir(outDir, { recursive: true });
  for (const name of await readdir(outDir)) {
    if (!KEPT_FILES.has(name)) await rm(join(outDir, name), { recursive: true, force: true });
  }
  for (const name of await readdir(staging)) {
    await rename(join(staging, name), join(outDir, name));
  }
  await rm(staging, { recursive: true, force: true });
  const writeMs = lap();

  return {
    locations: data.locations.length,
    regions: data.regions.length,
    tiles: pyramid.tiles.length,
    tileBytes: pyramid.tiles.reduce((sum, tile) => sum + tile.data.length, 0),
    maxZoom: pyramid.maxZoom,
    millis: { content: contentMs, render: renderMs, tiles: tilesMs, write: writeMs },
  };
}
