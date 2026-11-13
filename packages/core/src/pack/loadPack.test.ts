import type { PackData } from '@atlas/schema';
import { makeFixturePack, makeGuidesFixturePack } from '@atlas/schema/testing';
import { describe, expect, it } from 'vitest';
import { layerMarkers, layerViewSpec, placesFocus } from './viewSpec';
import { PackLoadError, loadPack } from './loadPack';

const BASE = 'https://packs.example.test/games/demo/';

/** Serves a pack's files from memory, as a static web server would. */
function servePack(files: Record<string, unknown>) {
  const requested: string[] = [];
  const fetchFn = ((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requested.push(url.href);
    const name = url.href.startsWith(BASE) ? url.href.slice(BASE.length) : null;
    const body = name === null ? undefined : files[name];
    if (body === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return Promise.resolve(new Response(text, { status: 200 }));
  }) as typeof fetch;
  return { fetchFn, requested };
}

function packFiles(pack: PackData): Record<string, unknown> {
  return {
    'manifest.json': pack.manifest,
    'maps.json': pack.maps,
    'layers.json': pack.layers,
    'regions.json': pack.regions,
    'categoryGroups.json': pack.categoryGroups,
    'categories.json': pack.categories,
    'locations.json': pack.locations,
    'entities.json': pack.entities,
    'checklists.json': pack.checklists,
    'checklistItems.json': pack.checklistItems,
    'guides.json': pack.guides,
    'links.json': pack.links,
    'presets.json': pack.presets,
  };
}

async function loadError(files: Record<string, unknown>, url = BASE): Promise<PackLoadError> {
  const { fetchFn } = servePack(files);
  try {
    await loadPack(url, { fetch: fetchFn });
  } catch (error) {
    if (error instanceof PackLoadError) return error;
    throw error;
  }
  throw new Error('expected loadPack to fail');
}

describe('loadPack', () => {
  it('loads and indexes a valid pack', async () => {
    const { fetchFn } = servePack(packFiles(makeFixturePack()));
    const pack = await loadPack(BASE, { fetch: fetchFn });
    expect(pack.manifest.title).toBe('Fixture pack');
    expect(pack.locations.get('demo:loc:0001')?.name).toBe('Moss herb');
    expect(pack.locationsOn('demo:layer:surface')).toHaveLength(2);
    expect(pack.layersOf('demo:map:world').map((l) => l.id)).toEqual(['demo:layer:surface']);
    expect(pack.currentId('demo:loc:old-1')).toBe('demo:loc:0001');
    expect(pack.currentId('demo:loc:0002')).toBe('demo:loc:0002');
  });

  it('accepts a pack URL without a trailing slash', async () => {
    const { fetchFn, requested } = servePack(packFiles(makeFixturePack()));
    await loadPack(BASE.slice(0, -1), { fetch: fetchFn });
    expect(requested[0]).toBe(`${BASE}manifest.json`);
  });

  it('treats missing optional files as empty', async () => {
    const files = packFiles(makeFixturePack());
    const pack = makeFixturePack();
    // Drop everything that refers to optional content, then the files themselves.
    files['locations.json'] = pack.locations.map((l) => ({
      ...l,
      entityIds: [],
      guideId: null,
      regionId: null,
    }));
    for (const name of [
      'regions',
      'entities',
      'checklists',
      'checklistItems',
      'guides',
      'links',
      'presets',
    ]) {
      files[`${name}.json`] = undefined;
    }
    const { fetchFn } = servePack(files);
    const loaded = await loadPack(BASE, { fetch: fetchFn });
    expect(loaded.data.regions).toEqual([]);
    expect(loaded.data.presets).toEqual([]);
  });

  it('fails when a required file is missing', async () => {
    const files = packFiles(makeFixturePack());
    delete files['locations.json'];
    const error = await loadError(files);
    expect(error.file).toBe('locations.json');
    expect(error.message).toContain('HTTP 404');
  });

  it('rejects an unsupported schema version before reading anything else', async () => {
    const files = packFiles(makeFixturePack());
    files['manifest.json'] = { ...makeFixturePack().manifest, schemaVersion: 99 };
    const error = await loadError(files);
    expect(error.file).toBe('manifest.json');
    expect(error.message).toContain('Unsupported pack schema version 99');
  });

  it('reports schema violations with their paths', async () => {
    const files = packFiles(makeFixturePack());
    const [first, second] = makeFixturePack().locations;
    files['locations.json'] = [first, { ...second, x: 'east' }];
    const error = await loadError(files);
    expect(error.file).toBe('locations.json');
    expect(error.issues.some((issue) => issue.startsWith('1.x:'))).toBe(true);
  });

  it('skips fields and list types it does not know, as a newer pack may have them', async () => {
    const pack = makeFixturePack();
    const files = packFiles(pack);
    files['manifest.json'] = { ...pack.manifest, addedLater: true };
    files['locations.json'] = pack.locations.map((l) => ({ ...l, photo: 'photos/a.webp' }));
    files['checklists.json'] = [
      { ...pack.checklists[0]!, type: 'timeline', addedLater: 1 },
      { id: 'demo:checklist:two', name: 'Two', order: 1, type: 'secrets' },
    ];
    const { fetchFn } = servePack(files);
    const loaded = await loadPack(BASE, { fetch: fetchFn });
    expect(loaded.data.locations[0]).toEqual(pack.locations[0]);
    expect(loaded.data.checklists[0]).not.toHaveProperty('addedLater');
    expect(loaded.data.checklists[0]!.type).toBeUndefined();
    expect(loaded.data.checklists[1]!.type).toBe('secrets');
    expect(loaded.data.manifest).not.toHaveProperty('addedLater');
  });

  it('reports invalid JSON', async () => {
    const files = packFiles(makeFixturePack());
    files['maps.json'] = '{ not json';
    const error = await loadError(files);
    expect(error.file).toBe('maps.json');
    expect(error.message).toContain('not valid JSON');
  });

  it('reports cross-file inconsistencies', async () => {
    const pack = makeFixturePack();
    pack.locations[0]!.categoryId = 'demo:cat:missing';
    const error = await loadError(packFiles(pack));
    expect(error.issues).toEqual(['locations[0].categoryId: unknown category demo:cat:missing']);
  });

  it('reports network failures', async () => {
    const fetchFn = (() => Promise.reject(new TypeError('offline'))) as typeof fetch;
    await expect(loadPack(BASE, { fetch: fetchFn })).rejects.toThrow(/Could not fetch .*offline/);
  });
});

describe('view helpers', () => {
  it('resolves tile URLs against the pack root and keeps template braces', async () => {
    const { fetchFn } = servePack(packFiles(makeFixturePack()));
    const pack = await loadPack(BASE, { fetch: fetchFn });
    const spec = layerViewSpec(pack, pack.data.layers[0]!);
    expect(spec.tiles).toEqual({ type: 'xyz', url: `${BASE}tiles/surface/{z}/{x}/{y}.webp` });
    expect(spec).toMatchObject({ width: 1000, height: 600, maxZoom: 2, tileSize: 256 });
    expect(spec.attribution).toBe('Atlas test suite');
    // The fixture's places reach across the image: the map shows all of it.
    expect(spec.focus).toBeUndefined();
  });

  it('names the part of the image the places take up when that is much less than all of it', () => {
    // Places in the lower right quarter of a 4000 x 4000 image, as when the
    // image is sized by its source's tiles and most of them are empty.
    const places = [
      { x: 2100, y: 2200 },
      { x: 3500, y: 2300 },
      { x: 2800, y: 3600 },
    ];
    // The margin is a tenth of the longer side (1400), but at least a
    // twentieth of the image (200); the image's edge cuts it off.
    expect(placesFocus(places, 4000, 4000)).toEqual({
      minX: 1900,
      minY: 2000,
      maxX: 3700,
      maxY: 3800,
    });
    expect(placesFocus([{ x: 3950, y: 3900 }], 4000, 4000)).toEqual({
      minX: 3750,
      minY: 3700,
      maxX: 4000,
      maxY: 4000,
    });
    // Places across the image, or across most of it both ways: all of it.
    expect(
      placesFocus(
        [
          { x: 300, y: 400 },
          { x: 3500, y: 3300 },
        ],
        4000,
        4000,
      ),
    ).toBeUndefined();
    // Across the width but only part of the height: that band.
    expect(
      placesFocus(
        [
          { x: 100, y: 1500 },
          { x: 3900, y: 2300 },
        ],
        4000,
        4000,
      ),
    ).toEqual({ minX: 0, minY: 1120, maxX: 4000, maxY: 2680 });
    expect(placesFocus([], 4000, 4000)).toBeUndefined();
  });

  it('builds markers with colour and glyph, filtered and muted by progress', async () => {
    const { fetchFn } = servePack(packFiles(makeFixturePack()));
    const pack = await loadPack(BASE, { fetch: fetchFn });
    expect(layerMarkers(pack, 'demo:layer:surface')).toEqual([
      { id: 'demo:loc:0001', x: 120, y: 80, color: '#4caf50', icon: 'leaf' },
      { id: 'demo:loc:0002', x: 900, y: 500, color: '#4caf50', icon: 'leaf' },
    ]);
    const filter = {
      visibleCategories: new Set(['demo:cat:herb']),
      hideFound: false,
      isFound: (id: string) => id === 'demo:loc:0002',
    };
    expect(layerMarkers(pack, 'demo:layer:surface', { filter }).map((m) => m.muted)).toEqual([
      undefined,
      true,
    ]);
    const hideFound = { ...filter, hideFound: true };
    expect(layerMarkers(pack, 'demo:layer:surface', { filter: hideFound })).toHaveLength(1);
    const nothing = { ...filter, visibleCategories: new Set<string>() };
    expect(layerMarkers(pack, 'demo:layer:surface', { filter: nothing })).toEqual([]);
    expect(
      layerMarkers(pack, 'demo:layer:surface', { filter: nothing, alwaysInclude: 'demo:loc:0001' }),
    ).toHaveLength(1);
  });
});

describe('loadPack: a game with no map', () => {
  const files = () => {
    const pack = makeGuidesFixturePack();
    return {
      ...packFiles(pack),
      'sections.json': pack.sections,
      'pictures.json': pack.pictures,
    } as Record<string, unknown>;
  };

  it('loads with empty map files, and with none', async () => {
    const empty = await loadPack(BASE, { fetch: servePack(files()).fetchFn });
    expect(empty.data.maps).toEqual([]);
    expect(empty.data.sections).toHaveLength(2);
    expect(empty.data.pictures![0]!.file).toBe('pictures/gate.png');
    const mapFiles = ['maps', 'layers', 'categoryGroups', 'categories', 'locations'];
    const without = Object.fromEntries(
      Object.entries(files()).filter(([file]) => !mapFiles.includes(file.replace('.json', ''))),
    );
    const pack = await loadPack(BASE, { fetch: servePack(without).fetchFn });
    expect(pack.data.locations).toEqual([]);
    expect(pack.data.guides.map((g) => g.id)).toEqual(['pages:guide:start', 'pages:guide:bells']);
  });

  it('refuses a pack that leaves out only some map files', async () => {
    const some = files();
    delete some['maps.json'];
    const error = await loadError(some);
    expect(error.file).toBe('maps.json');
  });

  it('loads a pack made before contents and pictures with both empty', async () => {
    const pack = await loadPack(BASE, { fetch: servePack(packFiles(makeFixturePack())).fetchFn });
    expect(pack.data.sections).toEqual([]);
    expect(pack.data.pictures).toEqual([]);
  });

  it('asks for the contents and pictures only of a pack with guides', async () => {
    const asked = (requested: string[]) =>
      requested.filter((url) => /(sections|pictures)\.json$/u.test(url));
    const withGuides = servePack(files());
    await loadPack(BASE, { fetch: withGuides.fetchFn });
    expect(asked(withGuides.requested)).toEqual([`${BASE}sections.json`, `${BASE}pictures.json`]);
    const fixture = makeFixturePack();
    const plain: PackData = {
      ...fixture,
      guides: [],
      locations: fixture.locations.map((location) => ({ ...location, guideId: null })),
    };
    const noGuides = servePack(packFiles(plain));
    const pack = await loadPack(BASE, { fetch: noGuides.fetchFn });
    expect(asked(noGuides.requested)).toEqual([]);
    expect(pack.data.sections).toEqual([]);
  });
});
