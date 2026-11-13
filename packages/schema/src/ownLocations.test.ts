import { describe, expect, it } from 'vitest';
import {
  categorySchema,
  countOwnLocations,
  locationSchema,
  manifestSchema,
  OWN_LOCATIONS_FORMAT,
  readOwnLocationsFile,
  regionSchema,
  writeOwnLocationsFile,
  type OwnLocations,
} from './index';

const NOW = new Date('2026-11-13T10:00:00.000Z');

function own(): OwnLocations {
  return {
    categoryGroups: [{ id: 'demo:catgroup:own.g1', name: 'My types', order: 100 }],
    categories: [
      {
        id: 'demo:cat:own.t1',
        groupId: 'demo:catgroup:own.g1',
        name: 'Campfire',
        icon: 'flame',
        color: '#e07a2f',
        trackable: true,
        defaultVisible: true,
      },
    ],
    regions: [
      { id: 'demo:region:own.a1', mapId: 'demo:map:world', parentId: null, name: 'Low fields' },
    ],
    locations: [
      {
        id: 'demo:loc:own.l1',
        mapId: 'demo:map:world',
        layerId: 'demo:layer:surface',
        x: 10,
        y: 20,
        categoryId: 'demo:cat:own.t1',
        regionId: 'demo:region:own.a1',
        name: 'Camp by the river',
        note: 'Rest here.',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
      {
        id: 'demo:loc:own.l2',
        mapId: 'demo:map:world',
        layerId: 'demo:layer:surface',
        x: 30,
        y: 40,
        // A type and an area of the pack.
        categoryId: 'demo:cat:chest',
        regionId: 'demo:region:north',
        name: 'Hidden chest',
      },
    ],
  };
}

describe('own locations file', () => {
  it('writes strictly and reads back what it wrote', () => {
    const text = writeOwnLocationsFile('demo', own(), NOW);
    const read = readOwnLocationsFile(JSON.parse(text));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.file.gameId).toBe('demo');
    expect(read.file.skipped).toBe(0);
    expect(read.file.own).toEqual(own());
    expect(countOwnLocations(read.file.own)).toBe(5);
  });

  it('refuses to write ids that are not own, and records that are not valid', () => {
    const notOwn = own();
    notOwn.locations[0]!.id = 'demo:loc:0001';
    expect(() => writeOwnLocationsFile('demo', notOwn, NOW)).toThrow();
    const noName = own();
    noName.categories[0]!.name = ' ';
    expect(() => writeOwnLocationsFile('demo', noName, NOW)).toThrow();
    const unknown = own();
    (unknown.locations[0] as unknown as Record<string, unknown>).extra = 1;
    expect(() => writeOwnLocationsFile('demo', unknown, NOW)).toThrow();
  });

  it('reads tolerantly: a bad record is left out and counted, the rest kept', () => {
    const file = JSON.parse(writeOwnLocationsFile('demo', own(), NOW)) as Record<string, unknown>;
    const locations = file.locations as Record<string, unknown>[];
    locations.push(
      { ...locations[0], id: 'demo:loc:own.l1' }, // used twice
      { ...locations[0], id: 'other:loc:own.l3' }, // another game
      { ...locations[0], id: 'demo:loc:own.l4', x: 'far' }, // not valid
      { ...locations[0], id: 'demo:loc:0099' }, // not an own id
      { ...locations[0], id: 'demo:loc:own.l5', layerId: 'other:layer:a' },
    );
    (file.categories as unknown[]).push({ nope: true });
    file.newerField = { anything: 1 };
    (locations[1] as Record<string, unknown>).newerKey = 'x';
    const read = readOwnLocationsFile(file);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.file.skipped).toBe(6);
    expect(read.file.own.locations.map((l) => l.id)).toEqual([
      'demo:loc:own.l1',
      'demo:loc:own.l2',
    ]);
    expect(read.file.own.locations[1]).not.toHaveProperty('newerKey');
  });

  it('reads a file of a newer version, and refuses what is not one', () => {
    const file = JSON.parse(writeOwnLocationsFile('demo', own(), NOW)) as Record<string, unknown>;
    const read = readOwnLocationsFile({ ...file, version: 3 });
    expect(read.ok && read.file.version).toBe(3);
    expect(readOwnLocationsFile({ ...file, format: 'atlas-own-lists' }).ok).toBe(false);
    expect(readOwnLocationsFile(null).ok).toBe(false);
    expect(readOwnLocationsFile({ format: OWN_LOCATIONS_FORMAT }).ok).toBe(false);
  });
});

describe('own ids in packs', () => {
  it('a pack being written may not use own ids for locations, types and areas', () => {
    const location = {
      id: 'demo:loc:own.x',
      mapId: 'demo:map:world',
      layerId: 'demo:layer:surface',
      x: 1,
      y: 1,
      categoryId: 'demo:cat:chest',
      regionId: null,
      name: 'A',
      entityIds: [],
      guideId: null,
      since: '1.0.0',
    };
    expect(locationSchema.safeParse(location).success).toBe(false);
    expect(locationSchema.safeParse({ ...location, id: 'demo:loc:x' }).success).toBe(true);
    expect(
      categorySchema.safeParse({
        id: 'demo:cat:own.x',
        groupId: 'demo:catgroup:g',
        name: 'A',
        icon: 'pin',
        color: '#000000',
        trackable: true,
        defaultVisible: true,
      }).success,
    ).toBe(false);
    expect(
      regionSchema.safeParse({
        id: 'demo:region:own.x',
        mapId: 'demo:map:world',
        parentId: null,
        name: 'A',
      }).success,
    ).toBe(false);
  });

  it('a manifest may say the game was made in the app', () => {
    const manifest = {
      schemaVersion: 2,
      gameId: 'my-island',
      title: 'My island',
      packVersion: '1.0.0',
      gamePatch: 'any',
      attribution: [],
      idMigrations: {},
      madeInApp: true,
    };
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    const odd = manifestSchema.safeParse({ ...manifest, madeInApp: 'yes' });
    expect(odd.success && 'madeInApp' in odd.data ? odd.data.madeInApp : undefined).toBeUndefined();
  });
});
