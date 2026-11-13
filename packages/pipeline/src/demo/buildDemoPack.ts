import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TileSource } from '@atlas/schema';
import { cutPyramid } from '../tiles/cutPyramid';
import { writePmtiles } from '../tiles/pmtiles';
import { assertValidPack, writePackJson, writeTileFolder } from '../pack/writePack';
import { deriveSeed } from '../random';
import { addChecklists } from './checklists';
import { generateDemoContent, layoutRegions, regionBorderStrength } from './content';
import { createTerrain, renderTerrain } from './terrain';
import { addUnderground, tintAsCave } from './underground';
import { addWiki, wikiPictureFiles } from './wiki';

export type TileFormat = 'pmtiles' | 'xyz';

export interface DemoPackOptions {
  seed: number;
  /** Edge length of the square map image in pixels. */
  size: number;
  tileSize: number;
  /** Locations on the surface map. */
  locationCount: number;
  /** Locations on each of the two underground layers. */
  undergroundLocations: number;
  tileFormat: TileFormat;
}

export const DEFAULT_DEMO_OPTIONS: DemoPackOptions = {
  seed: 20261110,
  size: 8192,
  tileSize: 256,
  locationCount: 5000,
  undergroundLocations: 240,
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
const UNDERGROUND_SIZE = 2048;
const UNDERGROUND_LAYERS = [
  { local: 'deep-upper', name: 'Upper galleries', tint: [196, 170, 140] },
  { local: 'deep-lower', name: 'Lower galleries', tint: [132, 168, 196] },
] as const;

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

  const tileSource = (path: string): TileSource =>
    options.tileFormat === 'pmtiles'
      ? { type: 'pmtiles', url: `${path}.pmtiles` }
      : { type: 'xyz', url: `${path}/{z}/{x}/{y}.webp` };
  const tiles = tileSource(LAYER_TILE_PATH);

  log?.(`Generating terrain and content (seed ${options.seed}, ${options.size} px)`);
  const terrain = createTerrain(options.seed, options.size);
  const layout = layoutRegions(options.seed, terrain);
  const underground = UNDERGROUND_LAYERS.map((layer) => ({
    ...layer,
    terrain: createTerrain(deriveSeed(options.seed, layer.local), UNDERGROUND_SIZE),
    tiles: tileSource(`tiles/${layer.local}`),
  }));
  const surface = generateDemoContent(terrain, layout, {
    seed: options.seed,
    size: options.size,
    tileSize: options.tileSize,
    locationCount: options.locationCount,
    tiles,
  });
  const data = assertValidPack(
    addWiki(
      addChecklists(
        addUnderground(surface, {
          seed: options.seed,
          size: UNDERGROUND_SIZE,
          tileSize: options.tileSize,
          locationsPerLayer: options.undergroundLocations,
          layers: underground,
        }),
      ),
    ),
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
  const deepPyramids = [];
  for (const layer of underground) {
    const relief = tintAsCave(renderTerrain(layer.terrain, UNDERGROUND_SIZE), layer.tint);
    deepPyramids.push({
      path: `tiles/${layer.local}`,
      pyramid: await cutPyramid(
        { data: relief, width: UNDERGROUND_SIZE, height: UNDERGROUND_SIZE, channels: 3 },
        { tileSize: options.tileSize },
      ),
    });
  }
  const tilesMs = lap();

  const staging = `${outDir.replace(/[/\\]+$/, '')}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, 'tiles'), { recursive: true });
  await writePackJson(staging, data);
  const pictures = await wikiPictureFiles();
  if (pictures.size > 0) await mkdir(join(staging, 'pictures'), { recursive: true });
  for (const [path, png] of pictures) await writeFile(join(staging, path), png);
  const layerPyramids = [
    { path: LAYER_TILE_PATH, pyramid, size: options.size },
    ...deepPyramids.map((deep) => ({ ...deep, size: UNDERGROUND_SIZE })),
  ];
  for (const layer of layerPyramids) {
    if (options.tileFormat === 'pmtiles') {
      const archive = writePmtiles(layer.pyramid.tiles, {
        tileType: 'webp',
        minZoom: layer.pyramid.minZoom,
        maxZoom: layer.pyramid.maxZoom,
        metadata: {
          name: data.manifest.title,
          attribution: data.manifest.attribution.map((a) => a.name).join(', '),
          atlas: { width: layer.size, height: layer.size, tileSize: options.tileSize },
        },
      });
      await writeFile(join(staging, `${layer.path}.pmtiles`), archive);
    } else {
      await writeTileFolder(join(staging, layer.path), layer.pyramid.tiles);
    }
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
    tiles: layerPyramids.reduce((sum, layer) => sum + layer.pyramid.tiles.length, 0),
    tileBytes: layerPyramids.reduce(
      (sum, layer) => sum + layer.pyramid.tiles.reduce((s, tile) => s + tile.data.length, 0),
      0,
    ),
    maxZoom: pyramid.maxZoom,
    millis: { content: contentMs, render: renderMs, tiles: tilesMs, write: writeMs },
  };
}
