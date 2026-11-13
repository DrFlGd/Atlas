import { pointInPolygon, polygonArea } from '@atlas/core';
import { checkPackIntegrity, isIconName, packDataSchema, type Region } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { rectangle, voronoiCells } from '../geometry/voronoi';
import { createRandom, deriveSeed } from '../random';
import { generateDemoContent, layoutRegions } from './content';
import { createTerrain, elevationAt, renderTerrain } from './terrain';
import { DEMO_CHECKLISTS, DEMO_GUIDES, addChecklists } from './checklists';
import { DEEP_MAP_ID, addUnderground, tintAsCave } from './underground';
import { WIKI_PAGES, WIKI_PICTURE, addWiki, wikiPictureFiles } from './wiki';

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

describe('demo checklists and guides', () => {
  const caves = createTerrain(SEED + 1, 512);
  const pack = addChecklists(
    addUnderground(generate(), {
      seed: SEED,
      size: 512,
      tileSize: 256,
      locationsPerLayer: 60,
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
    }),
  );
  const items = (checklistId: string) =>
    pack.checklistItems.filter((i) => i.checklistId === checklistId);
  const locations = new Map(pack.locations.map((l) => [l.id, l]));

  it('is valid', () => {
    expect(checkPackIntegrity(pack)).toEqual([]);
    expect(packDataSchema.safeParse(pack).success).toBe(true);
  });

  it('has a checklist tied to one category, one of steps and a long mixed one', () => {
    expect(pack.checklists.map((c) => c.id)).toEqual(Object.values(DEMO_CHECKLISTS));
    const waystones = items(DEMO_CHECKLISTS.waystones);
    expect(waystones.length).toBeGreaterThan(0);
    for (const item of waystones) {
      expect(item.locationIds.map((l) => locations.get(l)?.categoryId)).toEqual([
        'demo:cat:waystone',
      ]);
    }
    const story = items(DEMO_CHECKLISTS.story);
    expect(story.every((i) => i.locationIds.length === 0 && i.section)).toBe(true);
    const lore = items(DEMO_CHECKLISTS.lore);
    const kinds = new Set(
      lore.map((i) =>
        i.locationIds.length === 0
          ? 'step'
          : i.locationIds.length > 1
            ? 'several'
            : locations.get(i.locationIds[0]!)!.categoryId,
      ),
    );
    expect(kinds).toEqual(
      new Set(['step', 'several', 'demo:cat:tablet', 'demo:cat:camp', 'demo:cat:relic']),
    );
    // Some items are on the second map.
    expect(
      lore.some((i) => i.locationIds.some((l) => locations.get(l)?.mapId === DEEP_MAP_ID)),
    ).toBe(true);
    expect(lore.map((i) => i.order)).toEqual(lore.map((_, n) => n));
  });

  it('has a long guide list of single places across both maps', () => {
    const route = items(DEMO_CHECKLISTS.route);
    const checklist = pack.checklists.find((c) => c.id === DEMO_CHECKLISTS.route);
    // A type for apps that know types, and a kind for those that do not.
    expect(checklist?.type).toBe('route');
    expect(checklist?.kind).toBe('guide');
    expect(route.filter((i) => i.locationIds.length === 0)).toHaveLength(2);
    expect(route.every((i) => i.locationIds.length <= 1)).toBe(true);
    const maps = new Set(route.flatMap((i) => i.locationIds.map((l) => locations.get(l)!.mapId)));
    expect(maps.size).toBe(2);
  });

  it('has secrets: entries of one name, told apart by notes that hide their answers', () => {
    const checklist = pack.checklists.find((c) => c.id === DEMO_CHECKLISTS.riddles);
    expect(checklist?.type).toBe('secrets');
    expect(checklist?.kind).toBeUndefined();
    const riddles = items(DEMO_CHECKLISTS.riddles);
    expect(riddles).toHaveLength(8);
    expect(new Set(riddles.map((i) => i.name))).toEqual(new Set(['Carved riddle']));
    const notes = new Map(pack.guides.map((g) => [g.id, g]));
    const bodies = riddles.map((i) => {
      const place = locations.get(i.locationIds[0]!)!;
      expect(place.categoryId).toBe('demo:cat:ruin');
      const note = notes.get(place.guideId!)!;
      expect(note.locationIds).toEqual([place.id]);
      return note.body;
    });
    expect(new Set(bodies.map((b) => b.split('||')[0])).size).toBe(8);
    for (const body of bodies) {
      // One hidden part, with a place named in it.
      expect(body.match(/\|\|/g)).toHaveLength(2);
      expect(body.split('||')[1]).toMatch(/\]\(demo:loc:\d+\)/);
    }
    // One answer spans a list.
    expect(bodies[0]).toMatch(/\|\|[^|]*\n\n1\. [^|]*\|\|$/);
    // Both top-level areas have riddles.
    const tops = new Set(
      riddles.map((i) => {
        let region = pack.regions.find((r) => r.id === locations.get(i.locationIds[0]!)!.regionId);
        while (region?.parentId) region = pack.regions.find((r) => r.id === region!.parentId);
        return region?.id;
      }),
    );
    expect(tops.size).toBe(2);
  });

  it('gives tablets and chests on the surface a note of their own', () => {
    const notes = new Map(pack.guides.map((g) => [g.id, g]));
    const chest = pack.locations.find(
      (l) => l.categoryId === 'demo:cat:chest' && l.mapId !== DEEP_MAP_ID,
    )!;
    const note = notes.get(chest.guideId!)!;
    expect(note.locationIds).toEqual([chest.id]);
    expect(note.title).toBe(chest.name);
    expect(note.body).toMatch(/\]\(demo:loc:\d+\)/);
  });

  it('adds walkthrough guides whose in-app links all point at content of the pack', () => {
    const ids = new Set(
      [
        pack.locations,
        pack.regions,
        pack.maps,
        pack.checklists,
        pack.checklistItems,
        pack.guides,
      ].flatMap((list) => list.map((x) => x.id)),
    );
    const guideIds = new Set<string>(Object.values(DEMO_GUIDES));
    const listed = pack.guides.filter((g) => guideIds.has(g.id));
    expect(listed.map((g) => g.order)).toEqual([1, 2, 3]);
    const texts = [
      ...pack.guides.map((g) => g.body),
      ...pack.checklistItems.flatMap((i) => i.note ?? []),
    ];
    const targets = texts.flatMap((text) =>
      [...text.matchAll(/\]\((demo:[a-z]+:[^)\s]+)\)/g)].map((m) => m[1]!),
    );
    expect(targets.length).toBeGreaterThan(10);
    for (const target of targets) expect(ids.has(target), target).toBe(true);
  });

  it('uses no real game, site or brand names', () => {
    const text = JSON.stringify([pack.checklists, pack.checklistItems, pack.guides]);
    expect(text).not.toMatch(/https?:\/\/(?!github\.com\/DrFlGd\/atlas)/);
  });
});

describe('demo wiki', () => {
  const pack = addWiki(generate());
  const pages = new Set<string>(Object.values(WIKI_PAGES));
  const wiki = pack.guides.filter((g) => pages.has(g.id));

  it('is valid, and its contents lists every page once', () => {
    expect(checkPackIntegrity(pack)).toEqual([]);
    expect(packDataSchema.safeParse(pack).success).toBe(true);
    const listed = (pack.sections ?? []).flatMap((s) => s.items).filter((id) => pages.has(id));
    expect(listed.sort()).toEqual([...pages].sort());
    expect(pack.sections).toHaveLength(3);
  });

  it('has a table, a picture, hidden text and links that all lead to its own pages', () => {
    const bodies = wiki.map((g) => g.body).join('\n');
    expect(bodies).toMatch(/^\| --- \|/m);
    expect(bodies).toContain(`](${WIKI_PICTURE})`);
    expect(bodies).toMatch(/\|\|[^|]+\|\|/);
    const targets = [...bodies.matchAll(/\]\((demo:guide:[^)\s]+)\)/g)].map((m) => m[1]!);
    expect(targets.length).toBeGreaterThan(10);
    for (const target of targets) expect(pages.has(target), target).toBe(true);
  });

  it('credits a made-up wiki under an open licence on every page', () => {
    for (const guide of wiki) {
      expect(guide.source?.url).toMatch(/^https:\/\/wiki\.example\.org\//);
      expect(guide.source?.license.name).toBe('CC BY-SA 4.0');
    }
    expect(pack.manifest.attribution.map((a) => a.name)).toContain('Example Wiki');
  });

  it('draws its picture at the size the pack gives', async () => {
    const files = await wikiPictureFiles();
    const picture = pack.pictures?.[0];
    const png = picture ? files.get(picture.file) : undefined;
    expect(png?.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(png?.readUInt32BE(16)).toBe(picture?.width);
    expect(png?.readUInt32BE(20)).toBe(picture?.height);
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
