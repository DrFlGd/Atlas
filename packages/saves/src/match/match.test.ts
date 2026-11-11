import { describe, expect, it } from 'vitest';
import type { SavePin, SaveSummary } from '../summary';
import { WITCHER3_TUNING } from '../witcher3/tuning';
import { mulberry32 } from './calibrate';
import {
  categoryKinds,
  headingOnMap,
  matchSave,
  type MapCalibration,
  type PackForMatching,
} from './match';
import { applyAffine, invertAffine, type Affine } from './transform';

/** Map pixels to world metres: 2 m a pixel, y up, the map's centre at the origin. */
const PIXELS_TO_WORLD: Affine = { a: 2, b: 0, c: 0, d: -2, e: -4096, f: 4096 };

const pack: PackForMatching = {
  maps: [
    {
      id: 'map-1',
      name: 'Velen & Novigrad',
      width: 4096,
      height: 4096,
      worldTransform: PIXELS_TO_WORLD,
    },
    { id: 'map-2', name: 'Skellige', width: 4096, height: 4096 },
  ],
  categories: [
    { id: 'cat-sign', name: 'Signposts', trackable: true },
    { id: 'cat-sign-old', name: 'Signpost labels', trackable: false },
    { id: 'cat-nest', name: 'Monster Nests', trackable: true },
    { id: 'cat-camp', name: 'Bandit Camps', trackable: true },
    { id: 'cat-herb', name: 'Herbs', trackable: true },
    { id: 'cat-quest', name: 'Quests', trackable: true },
  ],
  locations: [
    { id: 'sign-a', mapId: 'map-1', x: 2048, y: 2048, categoryId: 'cat-sign' },
    { id: 'sign-a-label', mapId: 'map-1', x: 2048, y: 2048, categoryId: 'cat-sign-old' },
    { id: 'sign-b', mapId: 'map-1', x: 2148, y: 2048, categoryId: 'cat-sign' },
    { id: 'nest-a', mapId: 'map-1', x: 1000, y: 1000, categoryId: 'cat-nest' },
    { id: 'nest-b', mapId: 'map-1', x: 3000, y: 3000, categoryId: 'cat-nest' },
    { id: 'camp-a', mapId: 'map-1', x: 500, y: 3500, categoryId: 'cat-camp' },
    { id: 'herb-a', mapId: 'map-1', x: 2050, y: 2050, categoryId: 'cat-herb' },
    { id: 'quest-a', mapId: 'map-1', x: 10, y: 10, categoryId: 'cat-quest', flagId: 'q001_done' },
    { id: 'quest-b', mapId: 'map-1', x: 20, y: 10, categoryId: 'cat-quest', flagId: 'q002_done' },
    { id: 'special', mapId: 'map-1', x: 30, y: 10, categoryId: 'cat-camp', flagId: 'p-special' },
  ],
};

const pin = (
  id: string,
  type: string,
  kind: string | null,
  position: { x: number; y: number } | null,
  state: Partial<SavePin> = {},
  world = 'novigrad',
): SavePin => ({ id, world, type, kind, position, ...state });

function summary(parts: Partial<SaveSummary> = {}): SaveSummary {
  return {
    game: 'witcher3',
    gameTitle: 'The Witcher 3: Wild Hunt',
    version: { numbers: [67, 29, 164], label: 'save version 67' },
    world: { id: 'novigrad', path: 'levels\\novigrad\\novigrad.w2w', name: 'Velen and Novigrad' },
    worlds: [],
    player: { world: 'novigrad', position: { x: 0, y: 100, z: 0 }, yaw: 0 },
    facts: { q001_done: 1, q002_done: 0 },
    pins: [
      pin('p-sign-a', 'RoadSign', 'signpost', { x: 3, y: 4 }, { discovered: true }),
      pin('p-sign-b', 'RoadSign', 'signpost', { x: 200, y: 0 }, { discovered: false }),
      pin(
        'p-nest-a',
        'MonsterNestDisabled',
        'monster-nest',
        { x: -2086, y: 2096 },
        { cleared: true },
      ),
      pin('p-nest-b', 'MonsterNest', 'monster-nest', { x: 1904, y: -1904 }, { discovered: true }),
      pin('p-nest-c', 'MonsterNestDisabled', 'monster-nest', { x: 500, y: 500 }, { cleared: true }),
      pin(
        'p-nest-d',
        'MonsterNestDisabled',
        'monster-nest',
        { x: -2108, y: 2096 },
        { cleared: true },
      ),
      pin('p-treasure', 'BossAndTreasure', 'guarded-treasure', { x: 0, y: 0 }, { cleared: true }),
      pin('p-camp', 'BanditCamp', 'bandit-camp', null, { cleared: true }),
      pin(
        'p-special',
        'BanditCampDisabled',
        'bandit-camp',
        { x: 9999, y: 9999 },
        { cleared: true },
      ),
    ],
    map: { known: 0, discovered: 3, disabled: 6, visited: ['novigrad'], lists: {} },
    unpackedBytes: 1000,
    notes: [],
    ...parts,
  };
}

const base = { pack, tuning: WITCHER3_TUNING, worldMaps: {}, calibrations: {}, now: 1 };

describe('categoryKinds', () => {
  it('gives categories the pin kind their name holds', () => {
    const kinds = categoryKinds(
      [
        ...pack.categories,
        { id: 'c1', name: 'Smugglers’ Caches' },
        { id: 'c2', name: 'Places of Power' },
        { id: 'c3', name: 'Nests and Dens' },
      ],
      WITCHER3_TUNING.pinKinds,
    );
    expect(Object.fromEntries(kinds)).toEqual({
      'cat-sign': 'signpost',
      'cat-sign-old': 'signpost',
      'cat-nest': 'monster-nest',
      'cat-camp': 'bandit-camp',
      c1: 'smugglers-cache',
      c2: 'place-of-power',
    });
  });
});

describe('matchSave', () => {
  it('places the player and marks the places the save shows done', () => {
    const match = matchSave({ ...base, summary: summary() });
    expect(match.current).toEqual({
      worldId: 'novigrad',
      name: 'Velen and Novigrad',
      mapId: 'map-1',
      mapSource: 'suggested',
      calibration: 'pack',
    });
    expect(match.player).toEqual({ mapId: 'map-1', x: 2048, y: 1998, heading: 0, onMap: true });
    expect(match.needsCalibration).toBe(false);
    expect(match.calibrated).toEqual({});

    const found = Object.fromEntries(match.found.map((f) => [f.locationId, f]));
    expect(Object.keys(found).sort()).toEqual(['nest-a', 'quest-a', 'sign-a', 'special']);
    expect(found['sign-a']).toEqual({
      locationId: 'sign-a',
      kind: 'signpost',
      reason: 'Signpost discovered in the save, 5 m from this place.',
    });
    expect(found['nest-a']?.reason).toBe('Monster nest cleared in the save, 10 m from this place.');
    expect(found['quest-a']).toMatchObject({ kind: 'flag' });
    expect(found['quest-a']?.reason).toContain('q001_done');
    expect(found.special?.reason).toContain('p-special');

    expect(match.categories.sort((a, b) => a.categoryId.localeCompare(b.categoryId))).toEqual([
      { categoryId: 'cat-camp', kind: 'flag', matched: 1 },
      { categoryId: 'cat-nest', kind: 'monster-nest', matched: 1 },
      { categoryId: 'cat-quest', kind: 'flag', matched: 1 },
      { categoryId: 'cat-sign', kind: 'signpost', matched: 1 },
    ]);
    const unmatched = Object.fromEntries(
      match.unmatched.map((u) => [`${u.kind}/${u.reason}`, u.count]),
    );
    expect(unmatched).toEqual({
      'monster-nest/no-place-nearby': 2,
      'guarded-treasure/no-category': 1,
      'bandit-camp/no-position': 1,
    });
  });

  it('uses the person’s marked points over the pack’s transform', () => {
    const manual: MapCalibration = {
      source: 'manual',
      transform: { a: 0.5, b: 0, c: 0, d: -0.5, e: 2000, f: 2000 },
      at: 1,
    };
    const match = matchSave({ ...base, summary: summary(), calibrations: { 'map-1': manual } });
    expect(match.current?.calibration).toBe('manual');
    expect(match.player).toMatchObject({ x: 2000, y: 1950 });
  });

  it('shows no map when the person chose none for the world', () => {
    const match = matchSave({ ...base, summary: summary(), worldMaps: { novigrad: null } });
    expect(match.current).toMatchObject({ mapId: null, mapSource: 'chosen', calibration: null });
    expect(match.player).toBeNull();
    expect(match.needsCalibration).toBe(false);
    expect(match.found.map((f) => f.locationId).sort()).toEqual(['quest-a', 'special']);
    expect(match.unmatched.filter((u) => u.reason === 'no-map')).toEqual([
      { kind: 'signpost', label: 'Signposts', reason: 'no-map', count: 1 },
      { kind: 'monster-nest', label: 'Monster nests', reason: 'no-map', count: 3 },
    ]);
  });

  it('asks for points when a map cannot be lined up', () => {
    const match = matchSave({
      ...base,
      summary: summary({
        world: { id: 'skellige', path: 'levels\\skellige\\skellige.w2w', name: 'Skellige' },
        player: { world: 'skellige', position: { x: 1, y: 2 }, yaw: null },
        pins: [pin('s1', 'RoadSign', 'signpost', { x: 1, y: 1 }, { discovered: true }, 'skellige')],
      }),
    });
    expect(match.current).toMatchObject({ worldId: 'skellige', mapId: 'map-2', calibration: null });
    expect(match.player).toBeNull();
    expect(match.needsCalibration).toBe(true);
    expect(match.unmatched).toEqual([
      { kind: 'signpost', label: 'Signposts', reason: 'not-lined-up', count: 1 },
    ]);
  });

  it('lines a map up from the save’s pins and keeps the fit', () => {
    const truth: Affine = { a: 0.8, b: 0, c: 0, d: -0.8, e: 2048, f: 2048 };
    const toWorld = invertAffine(truth)!;
    const random = mulberry32(5);
    const locations: PackForMatching['locations'][number][] = [];
    const pins: SavePin[] = [];
    for (let i = 0; i < 60; i++) {
      const kind = i % 3 === 0 ? 'cat-nest' : 'cat-sign';
      const place = { x: 200 + random() * 3700, y: 200 + random() * 3700 };
      locations.push({ id: `s-${i}`, mapId: 'map-2', ...place, categoryId: kind });
      if (i % 4 !== 0) {
        const world = applyAffine(toWorld, place);
        pins.push(
          kind === 'cat-sign'
            ? pin(`sp-${i}`, 'RoadSign', 'signpost', world, { discovered: true }, 'skellige')
            : pin(
                `sp-${i}`,
                'MonsterNestDisabled',
                'monster-nest',
                world,
                { cleared: true },
                'skellige',
              ),
        );
      }
    }
    const skellige = {
      ...base,
      pack: { ...pack, locations: [...pack.locations, ...locations] },
      summary: summary({
        world: { id: 'skellige', path: 'levels\\skellige\\skellige.w2w', name: 'Skellige' },
        player: { world: 'skellige', position: { x: 0, y: 0 }, yaw: 90 },
        pins,
        facts: {},
      }),
    };
    const first = matchSave(skellige);
    expect(first.current?.calibration).toBe('auto');
    expect(first.needsCalibration).toBe(false);
    const kept = first.calibrated['map-2']!;
    expect(kept).toMatchObject({ source: 'auto', at: 1, fit: { inliers: pins.length } });
    expect(first.player?.x).toBeCloseTo(2048, 3);
    expect(first.player?.y).toBeCloseTo(2048, 3);
    expect(first.player?.heading).toBeCloseTo(270, 6);
    expect(first.found).toHaveLength(pins.length);

    const again = matchSave({ ...skellige, calibrations: first.calibrated, autoCalibrate: false });
    expect(again.calibrated).toEqual({});
    expect(again.current?.calibration).toBe('auto');
    expect(again.found).toEqual(first.found);
  });
});

describe('headingOnMap', () => {
  it('turns the game’s yaw into degrees clockwise from up on the map', () => {
    const yDown: Affine = { a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 };
    expect(headingOnMap(yDown, 0)).toBeCloseTo(0, 9);
    expect(headingOnMap(yDown, 90)).toBeCloseTo(270, 9);
    expect(headingOnMap(yDown, 180)).toBeCloseTo(180, 9);
    expect(headingOnMap(yDown, -90)).toBeCloseTo(90, 9);
    // A map turned a quarter: world north points right on it.
    const turned: Affine = { a: 0, b: 1, c: 1, d: 0, e: 0, f: 0 };
    expect(headingOnMap(turned, 0)).toBeCloseTo(90, 9);
  });

  it('marks places a pack names by tag from the save’s lists, by what their category counts as done', () => {
    const tag = (id: string, state: Partial<SavePin>): SavePin => ({
      id,
      world: null,
      type: null,
      kind: null,
      position: null,
      ...state,
    });
    const named = (id: string, categoryId: string) => ({
      id,
      mapId: 'map-1',
      x: 100,
      y: 100,
      categoryId,
      flagId: `tag_${id}`,
    });
    const match = matchSave({
      ...base,
      pack: {
        ...pack,
        locations: [
          named('sign', 'cat-sign'),
          named('nest-seen', 'cat-nest'),
          named('nest-done', 'cat-nest'),
          named('quest-seen', 'cat-quest'),
          named('quest-heard', 'cat-quest'),
        ],
      },
      summary: summary({
        facts: {},
        pins: [
          tag('tag_sign', { discovered: true }),
          tag('tag_nest-seen', { discovered: true }),
          tag('tag_nest-done', { discovered: true, cleared: true }),
          tag('tag_quest-seen', { discovered: true }),
          tag('tag_quest-heard', { known: true }),
          tag('tag_elsewhere', { discovered: true }),
        ],
      }),
    });
    expect(match.found.map((f) => f.locationId).sort()).toEqual([
      'nest-done',
      'quest-seen',
      'sign',
    ]);
    expect(match.found.find((f) => f.locationId === 'sign')?.reason).toBe(
      'The save shows the map pin “tag_sign” as discovered.',
    );
    expect(match.unplaced).toBe(1);
    expect(match.nothingBecause).toBeNull();
    expect(match.unmatched).toEqual([]);
  });

  it('says why a save marks nothing', () => {
    const newGame = summary({
      facts: { q001_done: 0 },
      pins: [],
      map: { known: 0, discovered: 0, disabled: 0, visited: ['kaer_morhen'], lists: {} },
    });
    const nothing = matchSave({ ...base, summary: newGame });
    expect(nothing.found).toEqual([]);
    expect(nothing.nothingBecause).toBe('nothing-done');
    expect(nothing.unplaced).toBe(0);

    const tagged = matchSave({
      ...base,
      summary: {
        ...newGame,
        pins: ['a', 'b', 'c'].map((id) => ({
          id,
          world: null,
          type: null,
          kind: null,
          position: null,
          discovered: id !== 'c',
          known: true,
        })),
      },
    });
    expect(tagged.found).toEqual([]);
    expect(tagged.nothingBecause).toBe('no-tag-table');
    expect(tagged.unplaced).toBe(2);
    expect(tagged.unmatched).toEqual([]);

    const unread = matchSave({ ...base, summary: { ...newGame, map: null } });
    expect(unread.nothingBecause).toBe('no-map');

    // Something found, or positioned pins that `unmatched` explains: no reason.
    expect(matchSave({ ...base, summary: summary() }).nothingBecause).toBeNull();
    const far = matchSave({
      ...base,
      summary: {
        ...newGame,
        pins: [pin('p', 'RoadSign', 'signpost', { x: 3000, y: 3000 }, { discovered: true })],
      },
    });
    expect(far.found).toEqual([]);
    expect(far.nothingBecause).toBeNull();
    expect(far.unmatched).toEqual([
      { kind: 'signpost', label: 'Signposts', reason: 'no-place-nearby', count: 1 },
    ]);
  });
});
