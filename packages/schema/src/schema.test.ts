import { describe, expect, it } from 'vitest';
import {
  COLLECTION_NAMES,
  FALLBACK_ICON,
  ICON_NAMES,
  PACK_COLLECTIONS,
  checkPackIntegrity,
  checklistItemSchema,
  checklistSchema,
  guideEntrySchema,
  idOf,
  layerSchema,
  locationSchema,
  makeId,
  manifestSchema,
  packDataReadSchema,
  packDataSchema,
  packReadSchemas,
  parseId,
  regionSchema,
  resolveIconName,
  tileSourceSchema,
} from './index';
import { makeFixturePack } from './testing/fixture';

describe('content ids', () => {
  it('parses well-formed ids', () => {
    expect(parseId('demo:loc:0412')).toEqual({ gameId: 'demo', kind: 'loc', localId: '0412' });
    expect(makeId('my-game', 'cat', 'herb')).toBe('my-game:cat:herb');
  });

  it('rejects malformed ids', () => {
    for (const bad of ['demo:loc', 'Demo:loc:1', 'demo:unknown:1', 'demo:loc:', 'demo:loc:a b']) {
      expect(parseId(bad)).toBeNull();
    }
  });

  it('checks the kind of a typed id', () => {
    expect(idOf('loc').safeParse('demo:loc:0412').success).toBe(true);
    expect(idOf('loc').safeParse('demo:cat:0412').success).toBe(false);
  });
});

describe('entity schemas', () => {
  it('accepts the fixture pack', () => {
    expect(() => packDataSchema.parse(makeFixturePack())).not.toThrow();
  });

  it('rejects unknown manifest fields and unsupported schema versions', () => {
    const { manifest } = makeFixturePack();
    expect(manifestSchema.safeParse({ ...manifest, extra: true }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, schemaVersion: 3 }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, packVersion: 'v1' }).success).toBe(false);
  });

  it('requires a {z}/{x}/{y} template for xyz tiles', () => {
    expect(tileSourceSchema.safeParse({ type: 'xyz', url: 'tiles/{z}/{x}.webp' }).success).toBe(
      false,
    );
    expect(tileSourceSchema.safeParse({ type: 'pmtiles', url: 'tiles/a.pmtiles' }).success).toBe(
      true,
    );
    expect(tileSourceSchema.safeParse({ type: 'wms', url: 'x' }).success).toBe(false);
  });

  it('accepts a remote source on xyz tiles and checks its levels', () => {
    const [layer] = makeFixturePack().layers;
    const remote = {
      urlTemplate: 'https://tiles.example.com/world/{z}/{x}/{y}.jpg',
      levels: [
        { z: layer!.maxZoom - 1, sourceZ: 11, offsetX: 16, offsetY: 32 },
        { z: layer!.maxZoom, sourceZ: 12, offsetX: 32, offsetY: 64 },
      ],
    };
    const xyz = (r: unknown) => ({
      ...layer,
      tiles: { type: 'xyz', url: 'tiles/a/{z}/{x}/{y}.jpg', remote: r },
    });
    expect(layerSchema.safeParse(xyz(remote)).success).toBe(true);
    expect(layerSchema.safeParse(xyz({ ...remote, levels: [remote.levels[0]] })).success).toBe(
      false,
    );
    expect(
      layerSchema.safeParse(xyz({ ...remote, levels: [remote.levels[1], remote.levels[0]] }))
        .success,
    ).toBe(false);
    expect(
      layerSchema.safeParse(xyz({ ...remote, urlTemplate: 'http://tiles.example.com/{z}/{x}/{y}' }))
        .success,
    ).toBe(false);
    expect(
      layerSchema.safeParse({
        ...layer,
        tiles: { type: 'pmtiles', url: 'tiles/a.pmtiles', remote },
      }).success,
    ).toBe(false);
    // Plain http only to this computer, for tests and local mirrors.
    for (const urlTemplate of [
      'http://127.0.0.1:4431/{z}/{x}/{y}.png',
      'http://localhost/{z}/{x}/{y}.png',
    ]) {
      expect(layerSchema.safeParse(xyz({ ...remote, urlTemplate })).success).toBe(true);
    }
    for (const urlTemplate of [
      'http://127.0.0.1.example.com/{z}/{x}/{y}.png',
      'http://localhost.example.com/{z}/{x}/{y}.png',
      'http://localhost:80@tiles.example.com/{z}/{x}/{y}.png',
      'ftp://localhost/{z}/{x}/{y}.png',
    ]) {
      expect(layerSchema.safeParse(xyz({ ...remote, urlTemplate })).success).toBe(false);
    }
  });

  it('validates layer zoom range and tile size', () => {
    const [layer] = makeFixturePack().layers;
    expect(layerSchema.safeParse({ ...layer, minZoom: 3 }).success).toBe(false);
    expect(layerSchema.safeParse({ ...layer, tileSize: 300 }).success).toBe(false);
  });

  it('validates location fields', () => {
    const [loc] = makeFixturePack().locations;
    expect(locationSchema.safeParse(loc).success).toBe(true);
    expect(locationSchema.safeParse({ ...loc, x: Number.NaN }).success).toBe(false);
    expect(locationSchema.safeParse({ ...loc, categoryId: 'demo:loc:1' }).success).toBe(false);
    const { flagId: _flag, ...withoutFlag } = { ...loc, flagId: 'f' };
    expect(locationSchema.safeParse(withoutFlag).success).toBe(true);
  });
});

describe('region schema', () => {
  const [region] = makeFixturePack().regions;
  const { polygon: _polygon, ...withoutOutline } = region!;

  it('accepts an outline, a centre, both or neither', () => {
    expect(regionSchema.safeParse(region).success).toBe(true);
    expect(regionSchema.safeParse({ ...region, center: [500, 150] }).success).toBe(true);
    expect(regionSchema.safeParse({ ...withoutOutline, center: [500, 150] }).success).toBe(true);
    // Neither: the region still groups its locations for progress.
    expect(regionSchema.safeParse(withoutOutline).success).toBe(true);
  });

  it('rejects a malformed outline or centre', () => {
    const bad = [
      { ...region, polygon: [] },
      { ...region, polygon: region!.polygon!.slice(0, 2) },
      { ...region, polygon: null },
      { ...region, center: null },
      { ...region, center: [500] },
      { ...region, center: [500, 150, 0] },
      { ...region, center: ['500', '150'] },
      { ...region, center: [Number.NaN, 150] },
      { ...region, center: [Number.POSITIVE_INFINITY, 150] },
      { ...region, centre: [500, 150] },
    ];
    for (const value of bad) expect(regionSchema.safeParse(value).success).toBe(false);
  });

  it('keeps a pack with regions without geometry valid', () => {
    const pack = makeFixturePack();
    pack.regions = pack.regions.map(({ polygon: _p, ...rest }, i) =>
      i === 0 ? rest : { ...rest, center: [750, 150] as [number, number] },
    );
    expect(packDataSchema.safeParse(pack).success).toBe(true);
    expect(checkPackIntegrity(pack)).toEqual([]);
  });
});

describe('checklist and guide schemas', () => {
  const pack = makeFixturePack();
  const item = pack.checklistItems[0]!;
  const guide = pack.guides[0]!;

  it('accepts items with a section and a Markdown note, and guides with an order', () => {
    expect(checklistItemSchema.safeParse(item).success).toBe(true);
    expect(
      checklistItemSchema.safeParse({ ...item, section: 'Chapter 1', note: 'Ask *twice*.' })
        .success,
    ).toBe(true);
    expect(checklistItemSchema.safeParse({ ...item, locationIds: [] }).success).toBe(true);
    expect(guideEntrySchema.safeParse(guide).success).toBe(true);
    expect(guideEntrySchema.safeParse({ ...guide, order: -2 }).success).toBe(true);
    const withAll = makeFixturePack();
    withAll.checklistItems[0] = { ...item, section: 'Chapter 1', note: '' };
    withAll.guides[0] = { ...guide, order: 3 };
    expect(packDataSchema.safeParse(withAll).success).toBe(true);
    expect(checkPackIntegrity(withAll)).toEqual([]);
  });

  it('accepts a checklist kind of checklist or guide, and nothing else', () => {
    const [checklist] = pack.checklists;
    expect(checklistSchema.safeParse(checklist).success).toBe(true);
    for (const kind of ['checklist', 'guide']) {
      expect(checklistSchema.safeParse({ ...checklist, kind }).success).toBe(true);
    }
    for (const kind of ['Guide', 'route', '', null]) {
      expect(checklistSchema.safeParse({ ...checklist, kind }).success).toBe(false);
    }
  });

  it('accepts the six list types, and nothing else when writing', () => {
    const [checklist] = pack.checklists;
    for (const type of ['collection', 'secrets', 'photos', 'route', 'build', 'plain']) {
      expect(checklistSchema.safeParse({ ...checklist, type }).success).toBe(true);
      // Older packs' kind stays next to it.
      expect(checklistSchema.safeParse({ ...checklist, kind: 'guide', type }).success).toBe(true);
    }
    for (const type of ['timeline', 'Route', '', null, 3]) {
      expect(checklistSchema.safeParse({ ...checklist, type }).success).toBe(false);
    }
  });

  it('refuses malformed values and unknown fields', () => {
    const badItems = [
      { ...item, section: '' },
      { ...item, section: '   ' },
      { ...item, section: 'x'.repeat(201) },
      { ...item, note: 5 },
      { ...item, heading: 'Chapter 1' },
    ];
    for (const value of badItems) expect(checklistItemSchema.safeParse(value).success).toBe(false);
    const badGuides = [
      { ...guide, order: 1.5 },
      { ...guide, order: '1' },
      { ...guide, chapter: 1 },
    ];
    for (const value of badGuides) expect(guideEntrySchema.safeParse(value).success).toBe(false);
  });
});

describe('reading tolerantly, writing strictly', () => {
  /** One record of each collection with a field no app knows yet. */
  const withUnknownKeys = () => {
    const pack = makeFixturePack();
    const extra = { addedLater: { any: 'shape' } };
    return {
      ...pack,
      manifest: { ...pack.manifest, ...extra },
      maps: pack.maps.map((r) => ({ ...r, ...extra })),
      layers: pack.layers.map((r) => ({ ...r, ...extra, tiles: { ...r.tiles, ...extra } })),
      regions: pack.regions.map((r) => ({ ...r, ...extra })),
      categoryGroups: pack.categoryGroups.map((r) => ({ ...r, ...extra })),
      categories: pack.categories.map((r) => ({ ...r, ...extra })),
      locations: pack.locations.map((r) => ({ ...r, ...extra })),
      entities: pack.entities.map((r) => ({ ...r, ...extra })),
      checklists: pack.checklists.map((r) => ({ ...r, ...extra, type: 'timeline' })),
      checklistItems: pack.checklistItems.map((r) => ({ ...r, ...extra })),
      guides: pack.guides.map((r) => ({ ...r, ...extra })),
      links: pack.links.map((r) => ({ ...r, ...extra })),
      presets: pack.presets.map((r) => ({ ...r, ...extra })),
    };
  };

  it('reads a pack with unknown keys and an unknown list type, without them', () => {
    const parsed = packDataReadSchema.safeParse(withUnknownKeys());
    expect(parsed.success).toBe(true);
    // What is left is the pack as this app knows it.
    expect(JSON.parse(JSON.stringify(parsed.data))).toEqual(makeFixturePack());
    expect(parsed.data!.checklists[0]!.type).toBeUndefined();
    expect(checkPackIntegrity(parsed.data!)).toEqual([]);
  });

  it('refuses the same pack when writing', () => {
    const result = packDataSchema.safeParse(withUnknownKeys());
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((issue) => issue.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['manifest', 'maps.0', 'checklists.0.type']));
    for (const name of COLLECTION_NAMES) {
      const records = withUnknownKeys()[name] ?? [];
      if (records.length === 0) continue;
      expect(PACK_COLLECTIONS[name].schema.safeParse(records).success, name).toBe(false);
      expect(PACK_COLLECTIONS[name].readSchema.safeParse(records).success, name).toBe(true);
    }
  });

  it('reads a known list type, and treats only unknown words as absent', () => {
    const [checklist] = makeFixturePack().checklists;
    const read = packReadSchemas.checklistSchema;
    expect(read.parse({ ...checklist, type: 'secrets' }).type).toBe('secrets');
    expect(read.parse({ ...checklist, type: 'timeline' }).type).toBeUndefined();
    expect(read.parse({ ...checklist, kind: 'chronicle' }).kind).toBeUndefined();
    // A value of the wrong shape is still an error.
    expect(read.safeParse({ ...checklist, type: 3 }).success).toBe(false);
    expect(read.safeParse({ ...checklist, type: null }).success).toBe(false);
  });

  it('still refuses what is wrong rather than new when reading', () => {
    const pack = makeFixturePack();
    const [location] = pack.locations;
    expect(packReadSchemas.locationSchema.safeParse({ ...location, x: 'far' }).success).toBe(false);
    expect(
      packReadSchemas.locationSchema.safeParse({ ...location, categoryId: undefined }).success,
    ).toBe(false);
    expect(
      packReadSchemas.manifestSchema.safeParse({ ...pack.manifest, schemaVersion: 3 }).success,
    ).toBe(false);
    expect(
      packReadSchemas.layerSchema.safeParse({
        ...pack.layers[0],
        tiles: { type: 'wms', url: 'x' },
      }).success,
    ).toBe(false);
  });
});

describe('checkPackIntegrity', () => {
  it('finds no issues in a consistent pack', () => {
    expect(checkPackIntegrity(makeFixturePack())).toEqual([]);
  });

  it('reports duplicate ids and ids from another game', () => {
    const pack = makeFixturePack();
    pack.locations.push({ ...pack.locations[0]!, name: 'Copy' });
    pack.entities.push({ id: 'other:entity:x', name: 'X', kind: 'item' });
    const paths = checkPackIntegrity(pack).map((issue) => issue.path);
    expect(paths).toContain('locations[2].id');
    expect(paths).toContain('entities[1].id');
  });

  it('reports dangling references', () => {
    const pack = makeFixturePack();
    pack.locations[0]!.categoryId = 'demo:cat:missing';
    pack.locations[0]!.regionId = 'demo:region:missing';
    pack.checklistItems[0]!.locationIds.push('demo:loc:missing');
    pack.links[0]!.toId = 'demo:loc:missing';
    const paths = checkPackIntegrity(pack).map((issue) => issue.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'locations[0].categoryId',
        'locations[0].regionId',
        'checklistItems[0].locationIds[1]',
        'links[0].toId',
      ]),
    );
  });

  it('reports locations outside their map', () => {
    const pack = makeFixturePack();
    pack.locations[1]!.x = 1001;
    expect(checkPackIntegrity(pack)).toEqual([
      { path: 'locations[1]', message: 'point (1001, 500) lies outside demo:map:world' },
    ]);
  });

  it('reports region outlines and centres outside their map', () => {
    const pack = makeFixturePack();
    pack.regions[0]!.center = [1200, 100];
    pack.regions[1]!.polygon![2] = [1000, 601];
    expect(checkPackIntegrity(pack)).toEqual([
      { path: 'regions[0].center', message: 'point (1200, 100) lies outside demo:map:world' },
      { path: 'regions[1].polygon[2]', message: 'point (1000, 601) lies outside demo:map:world' },
    ]);
  });

  it('reports a tile pyramid that does not match its map', () => {
    const pack = makeFixturePack();
    pack.layers[0]!.maxZoom = 3;
    const [issue] = checkPackIntegrity(pack);
    expect(issue?.path).toBe('layers[0].maxZoom');
    expect(issue?.message).toContain('expected 2');
  });

  it('checks id migrations', () => {
    const pack = makeFixturePack();
    pack.manifest.idMigrations = { 'demo:loc:0001': 'demo:loc:0404' };
    expect(checkPackIntegrity(pack)).toHaveLength(2);
  });
});

describe('icon names', () => {
  it('lists thirty unique names and falls back to pin', () => {
    expect(ICON_NAMES).toHaveLength(30);
    expect(new Set(ICON_NAMES).size).toBe(30);
    expect(FALLBACK_ICON).toBe('pin');
    expect(resolveIconName('skull')).toBe('skull');
    expect(resolveIconName('campfire')).toBe('pin');
  });

  it('is used by the fixture pack', () => {
    for (const category of makeFixturePack().categories) {
      expect(resolveIconName(category.icon)).toBe(category.icon);
    }
  });
});
