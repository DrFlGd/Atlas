import { describe, expect, it } from 'vitest';
import type { GamePinTable, GameTablePin } from '../gamefiles/table';
import type { SavePin, SaveSummary } from '../summary';
import { WITCHER3_TUNING } from '../witcher3/tuning';
import { mulberry32 } from './calibrate';
import { kindOfType, matchSave, TABLE_FIT, type PackForMatching } from './match';
import { applyAffine, type Affine } from './transform';

/**
 * Matching with a table of the game's own map pins. Every pin and place
 * here is made up by the test: random points in a made-up world.
 */

/** World metres to map pixels: half a pixel a metre, y down, the origin at the map's centre. */
const WORLD_TO_PIXELS: Affine = { a: 0.5, b: 0, c: 0, d: -0.5, e: 2048, f: 2048 };

const random = mulberry32(7);
const spot = () => ({ x: (random() - 0.5) * 7000, y: (random() - 0.5) * 7000 });

const tablePins: GameTablePin[] = [
  ...Array.from({ length: 60 }, (_, i) => ({ name: `sign_${i}`, type: 'RoadSign', ...spot() })),
  ...Array.from({ length: 15 }, (_, i) => ({ name: `nest_${i}`, type: 'MonsterNest', ...spot() })),
  ...Array.from({ length: 5 }, (_, i) => ({ name: `power_${i}`, type: 'PlaceOfPower', ...spot() })),
  ...Array.from({ length: 30 }, (_, i) => ({ name: `board_${i}`, type: 'NoticeBoard', ...spot() })),
].map((pin) => ({ ...pin, z: 0, radius: 0 }));

const table: GamePinTable = {
  format: 1,
  game: 'witcher3',
  stamp: '1000-2000',
  builtAt: 1,
  worlds: { novigrad: tablePins, skellige: [] },
};

const categories = [
  { id: 'cat-sign', name: 'Signposts', trackable: true },
  { id: 'cat-nest', name: 'Monster Nests', trackable: true },
  { id: 'cat-power', name: 'Places of Power', trackable: true },
];

const categoryOf: Record<string, string> = {
  RoadSign: 'cat-sign',
  MonsterNest: 'cat-nest',
  PlaceOfPower: 'cat-power',
};

/**
 * A pack map of the world without a world transform. Its places are the
 * table's pins, a few pixels off, with every sixth signpost missing and
 * a few places the table does not have.
 */
function packWith(places: (pin: GameTablePin, i: number) => { x: number; y: number } | null) {
  const locations: PackForMatching['locations'][number][] = [];
  tablePins.forEach((pin, i) => {
    const category = categoryOf[pin.type];
    const at = category ? places(pin, i) : null;
    if (!category || !at) return;
    locations.push({ id: `loc-${pin.name}`, mapId: 'map-v', categoryId: category, ...at });
  });
  for (let i = 0; i < 4; i++) {
    locations.push({
      id: `loc-extra-${i}`,
      mapId: 'map-v',
      categoryId: 'cat-sign',
      x: 300 + 900 * i,
      y: 3900,
    });
  }
  const pack: PackForMatching = {
    maps: [{ id: 'map-v', name: 'Velen & Novigrad', width: 4096, height: 4096 }],
    categories,
    locations,
  };
  return pack;
}

const near = random;
const matching = packWith((pin, i) => {
  if (pin.type === 'RoadSign' && i % 6 === 5) return null;
  const at = applyAffine(WORLD_TO_PIXELS, pin);
  return { x: at.x + (near() - 0.5) * 4, y: at.y + (near() - 0.5) * 4 };
});

const tag = (id: string, state: Partial<SavePin>): SavePin => ({
  id,
  world: null,
  type: null,
  kind: null,
  position: null,
  ...state,
});

function summary(pins: SavePin[]): SaveSummary {
  return {
    game: 'witcher3',
    gameTitle: 'The Witcher 3: Wild Hunt',
    version: { numbers: [67, 29, 164], label: 'save version 67' },
    world: { id: 'novigrad', path: 'levels\\novigrad\\novigrad.w2w', name: 'Velen and Novigrad' },
    worlds: [],
    player: { world: 'novigrad', position: { x: 400, y: -600, z: 0 }, yaw: 0 },
    facts: {},
    pins,
    map: {
      known: 0,
      discovered: 3,
      disabled: 1,
      visited: ['novigrad'],
      questPins: [],
      agentPins: [],
      lists: {},
    },
    unpackedBytes: 1,
    notes: [],
  };
}

const SAVE = summary([
  tag('sign_3', { discovered: true }),
  tag('nest_2', { discovered: true, cleared: true }),
  tag('nest_4', { discovered: true }),
  tag('not_in_the_table', { discovered: true }),
]);

describe('matching with the game’s map pin table', () => {
  it('knows the kind of each game pin type', () => {
    expect(kindOfType('RoadSign', WITCHER3_TUNING.pinKinds)).toBe('signpost');
    expect(kindOfType('MonsterNestDisabled', WITCHER3_TUNING.pinKinds)).toBe('monster-nest');
    expect(kindOfType('NoticeBoard', WITCHER3_TUNING.pinKinds)).toBeNull();
    expect(kindOfType('', WITCHER3_TUNING.pinKinds)).toBeNull();
  });

  it('lines the map up from every signpost, places the save’s tags and shows the player', () => {
    const result = matchSave({
      summary: SAVE,
      pack: matching,
      tuning: WITCHER3_TUNING,
      worldMaps: {},
      calibrations: {},
      table,
      now: 5,
    });
    const world = result.current!;
    expect(world.calibration).toBe('auto');
    expect(world.fit).toMatchObject({ kinds: 'first', candidates: 60, places: 54, passed: true });
    expect(world.fit!.inliers).toBeGreaterThanOrEqual(48);
    expect(world.fit!.rms).toBeLessThan(TABLE_FIT.maxRmsShare * world.fit!.radius);
    expect(result.calibrated['map-v']).toMatchObject({ source: 'auto', from: 'table:1000-2000' });

    const expected = applyAffine(WORLD_TO_PIXELS, { x: 400, y: -600 });
    expect(result.player!.x).toBeCloseTo(expected.x, -0.5);
    expect(result.player!.y).toBeCloseTo(expected.y, -0.5);
    expect(result.player!.onMap).toBe(true);
    expect(result.needsCalibration).toBe(false);

    // The signpost discovered and the nest cleared; the nest only discovered is not done.
    expect(result.found.map((f) => f.locationId).sort()).toEqual(['loc-nest_2', 'loc-sign_3']);
    expect(result.table).toEqual({ tags: 4, found: 3 });
    expect(result.unplaced).toBe(1);
    expect(result.nothingBecause).toBeNull();

    // Matched again with that fit kept, it is used as it is.
    const again = matchSave({
      summary: SAVE,
      pack: matching,
      tuning: WITCHER3_TUNING,
      worldMaps: {},
      calibrations: result.calibrated,
      table,
    });
    expect(again.calibrated).toEqual({});
    expect(again.current!.calibration).toBe('auto');
    expect(again.current!.fit).toMatchObject({ passed: true, inliers: world.fit!.inliers });
    expect(again.found).toHaveLength(2);
  });

  it('falls back to every anchor kind when the signposts alone do not fit', () => {
    // The pack has none of the signposts (only its four of its own), but its nests and places of power.
    const pack = packWith((pin) =>
      pin.type === 'RoadSign' ? null : applyAffine(WORLD_TO_PIXELS, pin),
    );
    const result = matchSave({
      summary: SAVE,
      pack,
      tuning: WITCHER3_TUNING,
      worldMaps: {},
      calibrations: {},
      table,
    });
    expect(result.current!.fit).toMatchObject({ kinds: 'anchors', passed: true });
    expect(result.current!.calibration).toBe('auto');
  });

  it('reports a fit that does not pass, and leaves the map not lined up', () => {
    const unrelated = mulberry32(99);
    const pack = packWith(() => ({ x: unrelated() * 4096, y: unrelated() * 4096 }));
    const result = matchSave({
      summary: SAVE,
      pack,
      tuning: WITCHER3_TUNING,
      worldMaps: {},
      calibrations: {},
      table,
    });
    expect(result.current!.calibration).toBeNull();
    expect(result.current!.fit?.passed).toBe(false);
    expect(result.calibrated).toEqual({});
    expect(result.needsCalibration).toBe(true);
    expect(result.player).toBeNull();
    // The save's pins are placed in the world, but the map is not lined up.
    expect(result.unmatched).toContainEqual(
      expect.objectContaining({ kind: 'signpost', reason: 'not-lined-up', count: 1 }),
    );
  });

  it('keeps a map the pack lines up, and says when the table does not hold the save’s tags', () => {
    const lined = {
      ...matching,
      maps: [
        {
          ...matching.maps[0]!,
          worldTransform: { a: 2, b: 0, c: 0, d: -2, e: -4096, f: 4096 },
        },
      ],
    };
    const result = matchSave({
      summary: summary([
        tag('unknown_a', { discovered: true }),
        tag('unknown_b', { cleared: true }),
      ]),
      pack: lined,
      tuning: WITCHER3_TUNING,
      worldMaps: {},
      calibrations: {},
      table,
    });
    expect(result.current!.calibration).toBe('pack');
    expect(result.current!.fit).toBeUndefined();
    expect(result.table).toEqual({ tags: 2, found: 0 });
    expect(result.nothingBecause).toBe('not-in-table');
    expect(result.unplaced).toBe(2);
  });

  it('makes a new fit when the table was read again after a patch', () => {
    const first = matchSave({
      summary: SAVE,
      pack: matching,
      tuning: WITCHER3_TUNING,
      worldMaps: {},
      calibrations: {},
      table,
    });
    const patched = { ...table, stamp: '1000-3000' };
    const again = matchSave({
      summary: SAVE,
      pack: matching,
      tuning: WITCHER3_TUNING,
      worldMaps: {},
      calibrations: first.calibrated,
      table: patched,
    });
    expect(again.calibrated['map-v']).toMatchObject({ from: 'table:1000-3000' });
  });
});
