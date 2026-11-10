import { describe, expect, it } from 'vitest';
import {
  FALLBACK_ICON,
  ICON_NAMES,
  checkPackIntegrity,
  idOf,
  layerSchema,
  locationSchema,
  makeId,
  manifestSchema,
  packDataSchema,
  parseId,
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
    expect(manifestSchema.safeParse({ ...manifest, schemaVersion: 2 }).success).toBe(false);
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
