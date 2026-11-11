import { pointInPolygon, polygonArea } from '@atlas/core';
import { checkPackIntegrity, isIconName, type Region } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { rectangle, voronoiCells } from '../geometry/voronoi';
import { createRandom, deriveSeed } from '../random';
import { generateDemoContent, layoutRegions } from './content';
import { createTerrain, elevationAt, renderTerrain } from './terrain';
import { DEEP_MAP_ID, addUnderground, tintAsCave } from './underground';

const SIZE = 2048;
const SEED = 7;
const terrain = createTerrain(SEED, SIZE);
/** Every demo region has an outline; an empty one fails the checks that use it. */
const outline = (region: Region) => region.polygon ?? [];

function generate(seed = SEED) {
  const layout = layoutRegions(seed, terrain);
  return generateDemoContent(terrain, layout, {
    seed,
    size: SIZE,
    tileSize: 256,
    locationCount: 400,
    tiles: { type: 'pmtiles', url: 'tiles/surface.pmtiles' },
  });
}

describe('random', () => {
  it('repeats for the same seed and differs between labels', () => {
    const a = createRandom(1);
    const b = createRandom(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(deriveSeed(1, 'x')).not.toBe(deriveSeed(1, 'y'));
  });
});

describe('voronoiCells', () => {
  it('partitions the boundary into one convex cell per site', () => {
    const boundary = rectangle(0, 0, 100, 100);
    const sites = [
      [20, 20],
      [80, 30],
      [50, 80],
    ] as const;
    const cells = voronoiCells(sites, boundary);
    const area = cells.reduce((sum, cell) => sum + polygonArea(cell), 0);
    expect(area).toBeCloseTo(10000, 6);
    cells.forEach((cell, i) => {
      const [x, y] = sites[i]!;
      expect(pointInPolygon({ x, y }, cell)).toBe(true);
    });
  });
});

describe('demo content', () => {
  const pack = generate();

  it('is valid and consistent', () => {
    expect(checkPackIntegrity(pack)).toEqual([]);
    expect(pack.locations).toHaveLength(400);
    expect(pack.layers[0]!.maxZoom).toBe(3);
  });

  it('uses icon names from the app icon set', () => {
    for (const category of pack.categories) expect(isIconName(category.icon)).toBe(true);
  });

  it('is deterministic for a seed', () => {
    expect(generate()).toEqual(pack);
    expect(generate(SEED + 1).locations).not.toEqual(pack.locations);
  });

  it('uses stable, zero-padded location ids', () => {
    expect(pack.locations[0]!.id).toBe('demo:loc:0001');
    expect(pack.locations.at(-1)!.id).toBe('demo:loc:0400');
  });

  it('places locations inside the map, mostly on land, and in the region that contains them', () => {
    const regions = new Map(pack.regions.map((r) => [r.id, r]));
    let onLand = 0;
    for (const loc of pack.locations) {
      expect(loc.x).toBeGreaterThanOrEqual(0);
      expect(loc.x).toBeLessThanOrEqual(SIZE);
      if (elevationAt(terrain, loc.x, loc.y) > 0) onLand++;
      const region = loc.regionId ? regions.get(loc.regionId) : undefined;
      if (region) expect(pointInPolygon(loc, outline(region))).toBe(true);
    }
    expect(onLand / pack.locations.length).toBeGreaterThan(0.9);
  });

  it('gives child regions a centre inside their outline, and top-level regions none', () => {
    for (const region of pack.regions) {
      if (region.parentId === null) {
        expect(region.center).toBeUndefined();
      } else {
        const [x, y] = region.center!;
        expect(pointInPolygon({ x, y }, outline(region))).toBe(true);
      }
    }
  });

  it('splits each top-level region into child regions that cover it', () => {
    const parents = pack.regions.filter((r) => r.parentId === null);
    expect(parents).toHaveLength(2);
    for (const parent of parents) {
      const children = pack.regions.filter((r) => r.parentId === parent.id);
      expect(children.length).toBeGreaterThan(1);
      const childArea = children.reduce((sum, r) => sum + polygonArea(outline(r)), 0);
      // Child vertices are rounded to whole pixels, so allow a small tolerance.
      expect(childArea / polygonArea(outline(parent))).toBeCloseTo(1, 2);
    }
  });
});

describe('underground map', () => {
  const caves = createTerrain(SEED + 1, 512);
  const pack = addUnderground(generate(), {
    seed: SEED,
    size: 512,
    tileSize: 256,
    locationsPerLayer: 30,
    layers: [
      {
        local: 'deep-upper',
        name: 'Upper',
        terrain: caves,
        tiles: { type: 'pmtiles', url: 'tiles/u.pmtiles' },
      },
      {
        local: 'deep-lower',
        name: 'Lower',
        terrain: caves,
        tiles: { type: 'pmtiles', url: 'tiles/l.pmtiles' },
      },
    ],
  });

  it('adds a second map with two layers and valid content', () => {
    expect(checkPackIntegrity(pack)).toEqual([]);
    expect(pack.maps.map((m) => m.id)).toEqual(['demo:map:world', DEEP_MAP_ID]);
    expect(pack.layers.filter((l) => l.mapId === DEEP_MAP_ID)).toHaveLength(2);
    const deep = pack.locations.filter((l) => l.mapId === DEEP_MAP_ID);
    expect(deep).toHaveLength(60);
    expect(deep[0]!.id).toBe('demo:loc:deep-0001');
    // The surface locations keep their ids.
    expect(pack.locations.filter((l) => l.mapId !== DEEP_MAP_ID)).toEqual(generate().locations);
  });

  it('tints a relief image as cave rock', () => {
    const image = Buffer.from([40, 80, 200, 200, 180, 120]);
    const tinted = tintAsCave(image, [200, 100, 50]);
    expect(tinted[0]!).toBeLessThan(tinted[3]!); // water darker than land
    expect(tinted[3]!).toBeGreaterThan(tinted[4]!); // hue follows the tint
  });
});

describe('renderTerrain', () => {
  it('renders an RGB image with both water and land', () => {
    const image = renderTerrain(terrain, 128);
    expect(image.length).toBe(128 * 128 * 3);
    const corner = [image[0]!, image[1]!, image[2]!];
    const centre = (64 * 128 + 64) * 3;
    expect(corner[2]).toBeGreaterThan(corner[0]!); // blue-ish water at the edge
    expect([image[centre], image[centre + 1], image[centre + 2]]).not.toEqual(corner);
  });
});
