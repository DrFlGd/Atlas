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
    locations[1]!.newerKey = 'x';
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

describe('names of maps and levels in the own locations file', () => {
  const named = (): OwnLocations => ({
    ...own(),
    names: [
      { id: 'demo:map:world', name: 'Home', original: 'World' },
      { id: 'demo:layer:surface', name: 'Up top', original: 'Surface' },
    ],
  });

  it('keeps the original name beside the person name, as version 2', () => {
    const text = writeOwnLocationsFile('demo', named(), NOW);
    expect(JSON.parse(text)).toMatchObject({ version: 2 });
    const read = readOwnLocationsFile(JSON.parse(text));
    expect(read.ok && read.file.own).toEqual(named());
    expect(read.ok && read.file.version).toBe(2);
    expect(countOwnLocations(named())).toBe(7);
  });

  it('stays version 1 without names, so older apps go on changing it', () => {
    expect(JSON.parse(writeOwnLocationsFile('demo', own(), NOW))).toMatchObject({ version: 1 });
    expect(
      JSON.parse(writeOwnLocationsFile('demo', { ...own(), names: [] }, NOW)),
    ).not.toHaveProperty('names');
  });

  it('keeps the height of a location put on a 3D map, and reads past one it cannot', () => {
    const mine = own();
    mine.locations[0] = { ...mine.locations[0]!, height: 12.5 };
    const text = writeOwnLocationsFile('demo', mine, NOW);
    // A height alone keeps the file's version: an older app reads it, without the height.
    expect(JSON.parse(text)).toMatchObject({ version: 1 });
    const read = readOwnLocationsFile(JSON.parse(text));
    expect(read.ok && read.file.own.locations[0]!.height).toBe(12.5);
    const file = JSON.parse(text) as { locations: Record<string, unknown>[] };
    file.locations[0]!.height = 'high';
    const tolerant = readOwnLocationsFile(file);
    expect(tolerant.ok && tolerant.file.own.locations[0]!.height).toBeUndefined();
    expect(tolerant.ok && tolerant.file.skipped).toBe(0);
    mine.locations[0] = { ...mine.locations[0], height: Number.NaN };
    expect(() => writeOwnLocationsFile('demo', mine, NOW)).toThrow();
  });

  it('leaves out a name that is not of a map or a level of the game, and reads the others', () => {
    const value = JSON.parse(writeOwnLocationsFile('demo', named(), NOW)) as {
      names: unknown[];
    };
    value.names.push(
      { id: 'other:map:world', name: 'Elsewhere', original: 'World' },
      { id: 'demo:loc:0001', name: 'Not a map', original: '' },
      { id: 'demo:map:cave', name: ' ', original: 'Cave' },
    );
    const read = readOwnLocationsFile(value);
    expect(read.ok && read.file.own.names).toEqual(named().names);
    expect(read.ok && read.file.skipped).toBe(3);
  });

  it('refuses to write a name that is empty', () => {
    const empty = named();
    empty.names![0]!.name = '  ';
    expect(() => writeOwnLocationsFile('demo', empty, NOW)).toThrow();
  });
});

describe('colours and icons of the pack’s types in the own locations file', () => {
  const looked = (): OwnLocations => ({
    ...own(),
    typeLooks: [
      { id: 'demo:cat:herb', color: '#ff00ff' },
      { id: 'demo:cat:chest', icon: 'star' },
      { id: 'demo:cat:waystone', color: '#123abc', icon: 'eye' },
    ],
  });

  it('keeps them as version 3, and reads them back', () => {
    const text = writeOwnLocationsFile('demo', looked(), NOW);
    expect(JSON.parse(text)).toMatchObject({ version: 3 });
    const read = readOwnLocationsFile(JSON.parse(text));
    expect(read.ok && read.file.own).toEqual(looked());
    expect(read.ok && read.file.version).toBe(3);
    expect(countOwnLocations(looked())).toBe(countOwnLocations(own()) + 3);
    // Names without looks stay version 2; neither, version 1.
    const named = { ...own(), names: [{ id: 'demo:map:world', name: 'Home', original: 'World' }] };
    expect(JSON.parse(writeOwnLocationsFile('demo', named, NOW))).toMatchObject({ version: 2 });
    expect(
      JSON.parse(writeOwnLocationsFile('demo', { ...own(), typeLooks: [] }, NOW)),
    ).not.toHaveProperty('typeLooks');
  });

  it('refuses to write a look without a colour or an icon, or with a colour that is not #rrggbb', () => {
    expect(() =>
      writeOwnLocationsFile('demo', { ...own(), typeLooks: [{ id: 'demo:cat:herb' }] }, NOW),
    ).toThrow();
    expect(() =>
      writeOwnLocationsFile(
        'demo',
        { ...own(), typeLooks: [{ id: 'demo:cat:herb', color: 'pink' }] },
        NOW,
      ),
    ).toThrow();
  });

  it('reads past a look it cannot use, and keeps what it can of one', () => {
    const value = JSON.parse(writeOwnLocationsFile('demo', looked(), NOW)) as {
      typeLooks: unknown[];
    };
    value.typeLooks.push(
      { id: 'other:cat:herb', color: '#00ff00' },
      { id: 'demo:loc:0001', color: '#00ff00' },
      { id: 'demo:cat:gem', color: 'green' },
      { id: 'demo:cat:coin', color: 'green', icon: 'coin' },
      { id: 'demo:cat:flag', color: '#ABCDEF' },
    );
    const read = readOwnLocationsFile(value);
    expect(read.ok && read.file.own.typeLooks).toEqual([
      ...looked().typeLooks!,
      { id: 'demo:cat:coin', icon: 'coin' },
      { id: 'demo:cat:flag', color: '#abcdef' },
    ]);
    expect(read.ok && read.file.skipped).toBe(3);
  });
});
