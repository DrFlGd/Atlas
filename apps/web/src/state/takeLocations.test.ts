import type { PackEntry } from '@atlas/core';
import {
  NO_OWN_LOCATIONS,
  pixelToWorld,
  type Affine,
  type Category,
  type Layer,
  type Location,
  type PackData,
} from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import {
  carryAcross,
  castFrom,
  CAST_ABOVE,
  noSurfaceNote,
  planTake,
  readyToTake,
  sameGameSources,
  takeIntoOwn,
  type TakeTarget,
} from './takeLocations';

/** The map shown: 4 pixels a world unit, world y up the map, world (0, 256) at its top left. */
const HERE: Affine = { a: 0.25, b: 0, c: 0, d: -0.25, e: 0, f: 256 };
/** The other pack's map of the same world: 2 pixels a unit, moved, with world y down the map. */
const THERE: Affine = { a: 0.5, b: 0, c: 0, d: 0.5, e: -64, f: 32 };

const loc = (id: string, x: number, y: number, extra: Partial<Location> = {}): Location => ({
  id: `other:loc:${id}`,
  mapId: 'other:map:valley',
  layerId: 'other:layer:ground',
  x,
  y,
  categoryId: 'other:cat:chest',
  regionId: null,
  name: id,
  entityIds: [],
  guideId: null,
  since: '1.0.0',
  ...extra,
});

/** The pixel of the other map at a world point. */
function there(wx: number, wy: number): [number, number] {
  // THERE: wx = 0.5 px - 64, wy = 0.5 py + 32.
  return [(wx + 64) * 2, (wy - 32) * 2];
}

const layer = (id: string, name: string, heights?: [number, number]): Layer => ({
  id: `demo:layer:${id}`,
  mapId: 'demo:map:keep',
  name,
  tiles: { type: 'xyz', url: 'x/{z}/{x}/{y}.png' },
  minZoom: 0,
  maxZoom: 2,
  tileSize: 256,
  ...(heights ? { heights } : {}),
});

const LAYERS = [
  layer('caves', 'Caves', [-12, -1]),
  layer('ground', 'Ground floor', [-1, 22]),
  layer('upper', 'Upper floor', [22, 40]),
];

function target(over: Partial<TakeTarget> = {}): TakeTarget {
  return {
    map: {
      id: 'demo:map:keep',
      name: 'Mossgate Keep',
      width: 1024,
      height: 1024,
      worldTransform: HERE,
    },
    layers: LAYERS,
    floors: LAYERS,
    shownLayer: 'demo:layer:ground',
    hasScene: true,
    existing: [],
    ...over,
  };
}

const SOURCE: Pick<PackData, 'maps' | 'layers' | 'locations'> = {
  maps: [
    { id: 'other:map:valley', name: 'Valley', width: 2048, height: 2048, worldTransform: THERE },
    { id: 'other:map:sketch', name: 'Sketch', width: 100, height: 100 },
  ],
  layers: [
    {
      id: 'other:layer:ground',
      mapId: 'other:map:valley',
      name: 'Upper floor',
      tiles: { type: 'xyz', url: 'x/{z}/{x}/{y}.png' },
      minZoom: 0,
      maxZoom: 2,
      tileSize: 256,
    },
  ],
  locations: [
    loc('well', ...there(80, 70)),
    loc('tower', ...there(100, 200), { height: 30 }),
    loc('far shore', ...there(400, 70)),
    loc('below', ...there(10, -5)),
    loc('in the sketch', 5, 5, { mapId: 'other:map:sketch' }),
  ],
};

describe('lining up the maps of two packs by world position', () => {
  it('carries a pixel of one map to the pixel of another at the same world point', () => {
    const [px, py] = there(80, 70);
    expect(carryAcross(THERE, HERE, px, py)).toEqual([320, 744]);
    const [wx, wy] = pixelToWorld(HERE, 320, 744);
    expect([wx, wy]).toEqual([80, 70]);
    // And back again.
    const back = carryAcross(HERE, THERE, 320, 744)!;
    expect(back[0]).toBeCloseTo(px);
    expect(back[1]).toBeCloseTo(py);
    // A transform that cannot be turned round leads nowhere.
    expect(carryAcross(THERE, { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }, 1, 1)).toBeNull();
  });

  it('plans what lands on the map shown, what lands off it, and what cannot be lined up', () => {
    const plan = planTake(SOURCE, ['other:map:valley', 'other:map:sketch'], target());
    expect(plan.inside.map((c) => [c.source.name, c.x, c.y])).toEqual([
      ['well', 320, 744],
      ['tower', 400, 224],
    ]);
    expect(plan.inside[0]).toMatchObject({ mapName: 'Valley', layerName: 'Upper floor' });
    expect(plan.outside.map((o) => o.source.name)).toEqual(['far shore', 'below']);
    expect(plan.unplaced).toEqual(['Sketch']);
    expect(plan.already).toEqual([]);
  });

  it('takes only the maps chosen', () => {
    const plan = planTake(SOURCE, ['other:map:sketch'], target());
    expect(plan.inside).toEqual([]);
    expect(plan.outside).toEqual([]);
    expect(plan.unplaced).toEqual(['Sketch']);
  });

  it('leaves out what is on the map shown already: the same name on the same spot', () => {
    const plan = planTake(
      SOURCE,
      ['other:map:valley'],
      target({
        existing: [
          { name: 'Well', x: 321, y: 745 },
          { name: 'tower', x: 300, y: 224 },
        ],
      }),
    );
    expect(plan.already.map((a) => a.source.name)).toEqual(['well']);
    expect(plan.inside.map((c) => c.source.name)).toEqual(['tower']);
  });

  it('leaves out a second location of one name on one spot', () => {
    const twice = {
      ...SOURCE,
      locations: [loc('well', ...there(80, 70)), loc('well2', ...there(80, 70), { name: 'well' })],
    };
    const plan = planTake(twice, ['other:map:valley'], target());
    expect(plan.inside).toHaveLength(1);
    expect(plan.already).toHaveLength(1);
  });

  it('cannot line up with a map shown that has no world position', () => {
    const plan = planTake(
      SOURCE,
      ['other:map:valley'],
      target({ map: { ...target().map, worldTransform: undefined } }),
    );
    expect(plan.inside).toEqual([]);
    expect(plan.unplaced).toEqual(['Valley']);
  });
});

describe('heights and floors of the locations taken', () => {
  const plan = planTake(SOURCE, ['other:map:valley'], target());

  it('casts down from just above a height a location has, or from the top', () => {
    expect(castFrom({ height: 30 })).toBe(30 + CAST_ABOVE);
    expect(castFrom({})).toBeNull();
  });

  it('gives each the surface’s height, its floor from it, and flags one with no surface below', () => {
    const ready = readyToTake(plan, target(), [4.567, null]);
    expect(ready[0]).toMatchObject({
      layerId: 'demo:layer:ground',
      height: 4.57,
      noSurface: false,
    });
    // No surface: its own height is kept, and it is flagged.
    expect(ready[1]).toMatchObject({ layerId: 'demo:layer:upper', height: 30, noSurface: true });
  });

  it('gives no height on a map without a model, and the level of the same name', () => {
    const ready = readyToTake(plan, target({ hasScene: false, floors: [] }), null);
    expect(ready[0]).toEqual({
      candidate: plan.inside[0],
      layerId: 'demo:layer:upper',
      noSurface: false,
    });
  });

  it('uses the level shown where none has the same name', () => {
    const plain = [layer('surface', 'Surface'), layer('night', 'At night')];
    const ready = readyToTake(
      plan,
      target({ hasScene: false, floors: [], layers: plain, shownLayer: 'demo:layer:night' }),
      null,
    );
    expect(ready.map((r) => r.layerId)).toEqual(['demo:layer:night', 'demo:layer:night']);
  });

  it('keeps the heights the locations had where the model could not be read', () => {
    const ready = readyToTake(plan, target(), null);
    expect(ready[0]).toMatchObject({ noSurface: false });
    expect(ready[0]).not.toHaveProperty('height');
    expect(ready[1]).toMatchObject({ height: 30, layerId: 'demo:layer:upper', noSurface: false });
  });
});

describe('adding them as the person’s own', () => {
  const data = {
    categoryGroups: [{ id: 'demo:catgroup:things', name: 'Things', order: 1 }],
    categories: [
      {
        id: 'demo:cat:chest',
        groupId: 'demo:catgroup:things',
        name: 'Chest',
        icon: 'chest',
        color: '#aa8800',
        trackable: true,
        defaultVisible: true,
      },
    ],
    regions: [],
    locations: [],
    guides: [],
  } as unknown as PackData;
  const sourceTypes: Category[] = [
    { ...data.categories[0]!, id: 'other:cat:chest', name: 'chest ' },
    {
      id: 'other:cat:shrine',
      groupId: 'other:catgroup:x',
      name: 'Shrine',
      icon: 'not-an-icon',
      color: '#123456',
      trackable: true,
      defaultVisible: true,
    },
  ];

  it('uses this game’s type of the same name, makes the others, and flags no surface', () => {
    const plan = planTake(
      {
        ...SOURCE,
        locations: [
          loc('well', ...there(80, 70)),
          loc('altar', ...there(90, 60), { categoryId: 'other:cat:shrine' }),
          loc('altar 2', ...there(91, 61), { categoryId: 'other:cat:shrine' }),
        ],
      },
      ['other:map:valley'],
      target(),
    );
    const ready = readyToTake(plan, target(), [3, null, 5]);
    const { own, types } = takeIntoOwn({
      gameId: 'demo',
      data,
      own: NO_OWN_LOCATIONS,
      mapId: 'demo:map:keep',
      ready,
      sourceTypes,
      packTitle: 'Other pack',
      now: new Date('2026-11-24T10:00:00.000Z'),
    });
    expect(types).toBe(1);
    expect(own.categoryGroups.map((g) => g.name)).toEqual(['From Other pack']);
    expect(own.categories).toMatchObject([{ name: 'Shrine', icon: 'pin', color: '#123456' }]);
    const shrine = own.categories[0]!.id;
    expect(own.locations).toHaveLength(3);
    expect(new Set(own.locations.map((l) => l.id)).size).toBe(3);
    expect(own.locations[0]).toMatchObject({
      name: 'well',
      categoryId: 'demo:cat:chest',
      mapId: 'demo:map:keep',
      x: 320,
      y: 744,
      height: 3,
      layerId: 'demo:layer:ground',
    });
    expect(own.locations[0]).not.toHaveProperty('note');
    expect(own.locations[1]).toMatchObject({
      name: 'altar',
      categoryId: shrine,
      note: noSurfaceNote('Other pack'),
    });
    expect(own.locations[1]).not.toHaveProperty('height');
    expect(own.locations[2]).toMatchObject({ categoryId: shrine, height: 5 });
    expect(own.locations.every((l) => l.id.startsWith('demo:loc:own.'))).toBe(true);
  });
});

describe('the other packs of the game', () => {
  const catalog: PackEntry[] = [
    { id: 'demo', url: 'packs/demo/', title: 'Atlas demo world' },
    { id: 'copy', url: 'packs/copy/', title: 'Atlas Demo World!' },
    { id: 'grouped', url: 'packs/grouped/', title: 'Something else' },
    { id: 'other', url: 'packs/other/', title: 'Another game' },
  ];

  it('are those of the same title and those shown with it under one title', () => {
    const groups = [
      { id: 'g1', title: 'Demo', members: [{ gameId: 'demo' }, { gameId: 'grouped' }] },
    ];
    expect(sameGameSources(catalog, groups, 'demo').map((e) => e.id)).toEqual(['copy', 'grouped']);
    expect(sameGameSources(catalog, [], 'demo').map((e) => e.id)).toEqual(['copy']);
    expect(sameGameSources(catalog, [], 'other')).toEqual([]);
  });
});
