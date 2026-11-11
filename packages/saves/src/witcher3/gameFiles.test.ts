import { describe, expect, it } from 'vitest';
import { readCr2w } from '../gamefiles/cr2w';
import { isPinTable, PinTableIndex, tableCounts } from '../gamefiles/table';
import { areaMapPinsFile, entityMapPinsFile, mappinsDlcFile } from '../testing/cr2w';
import {
  areaWorldsOf,
  buildPinTable,
  entityMapPinsOf,
  mappinsMountersOf,
  type GameFileInput,
} from './gameFiles';

/** Made-up pins: names and positions are this test's own. */
const VELEN = [
  { name: 'sign_a', type: 'RoadSign', x: 100, y: 200, z: 5 },
  { name: 'sign_b', type: 'RoadSign', x: 0, y: -300 },
  { name: 'nest_a', type: 'MonsterNest', x: -50.123, y: 75.456, radius: 20 },
  { tags: ['camp_a', 'camp_a_fire'], type: 'BanditCampfire', x: 10, y: 10 },
  { name: 'lost', type: 'RoadSign', x: 1, y: 1, noPosition: true },
];

describe('The Witcher 3’s map pin resources', () => {
  it('reads the pins of a hub pins file, with defaults left out', () => {
    // Floats are single precision in the file.
    const pins = entityMapPinsOf(readCr2w(entityMapPinsFile(VELEN))).map((pin) => ({
      ...pin,
      position: pin.position && {
        x: Number(pin.position.x.toFixed(3)),
        y: Number(pin.position.y.toFixed(3)),
        z: pin.position.z,
      },
    }));
    expect(pins).toEqual([
      {
        name: 'sign_a',
        tags: ['sign_a'],
        type: 'RoadSign',
        position: { x: 100, y: 200, z: 5 },
        radius: 0,
      },
      {
        name: 'sign_b',
        tags: ['sign_b'],
        type: 'RoadSign',
        position: { x: 0, y: -300, z: 0 },
        radius: 0,
      },
      {
        name: 'nest_a',
        tags: ['nest_a'],
        type: 'MonsterNest',
        position: { x: -50.123, y: 75.456, z: 0 },
        radius: 20,
      },
      {
        // No entity name: the first tag names it.
        name: 'camp_a',
        tags: ['camp_a', 'camp_a_fire'],
        type: 'BanditCampfire',
        position: { x: 10, y: 10, z: 0 },
        radius: 0,
      },
      { name: 'lost', tags: ['lost'], type: 'RoadSign', position: null, radius: 0 },
    ]);
  });

  it('reads the worlds of the area pins and the paths of DLC mounters', () => {
    expect(
      areaWorldsOf(
        readCr2w(
          areaMapPinsFile(['levels\\novigrad\\novigrad.w2w', 'levels\\skellige\\skellige.w2w']),
        ),
      ),
    ).toEqual(['levels\\novigrad\\novigrad.w2w', 'levels\\skellige\\skellige.w2w']);
    expect(
      mappinsMountersOf(
        readCr2w(
          mappinsDlcFile([
            {
              world: 'dlc\\bob\\data\\levels\\bob\\bob.w2w',
              pins: 'dlc\\bob\\data\\gameplay\\bob_pins.w2em',
              questPins: 'dlc\\bob\\data\\gameplay\\bob_pins.w2qm',
            },
          ]),
        ),
      ),
    ).toEqual([
      {
        world: 'dlc\\bob\\data\\levels\\bob\\bob.w2w',
        pins: 'dlc\\bob\\data\\gameplay\\bob_pins.w2em',
      },
    ]);
  });
});

describe('building the table', () => {
  const files: GameFileInput[] = [
    { path: 'game\\world.w2am', bytes: areaMapPinsFile(['levels\\novigrad\\novigrad.w2w']) },
    { path: 'game\\hub_pins\\novigrad.w2em', bytes: entityMapPinsFile(VELEN) },
    {
      path: 'game\\hub_pins\\skellige.w2em',
      bytes: entityMapPinsFile([{ name: 'harbor_a', type: 'Harbor', x: 5, y: 5 }], {
        version: 162,
      }),
    },
    // A DLC adds Toussaint, and a pin to Velen that replaces one.
    {
      path: 'dlc\\bob\\data\\bob.reddlc',
      bytes: mappinsDlcFile([
        {
          world: 'dlc\\bob\\data\\levels\\bob\\bob.w2w',
          pins: 'dlc\\bob\\data\\gameplay\\bob_pins.w2em',
        },
        {
          world: 'levels\\novigrad\\novigrad.w2w',
          pins: 'dlc\\bob\\data\\gameplay\\velen_extra.w2em',
        },
      ]),
    },
    {
      path: 'DLC/BOB/data/gameplay/bob_pins.w2em',
      bytes: entityMapPinsFile([{ name: 'sign_t', type: 'RoadSign', x: -1, y: 2 }]),
    },
    {
      path: 'dlc\\bob\\data\\gameplay\\velen_extra.w2em',
      bytes: entityMapPinsFile([{ name: 'sign_b', type: 'RoadSign', x: 0, y: -301 }]),
    },
    // A pin file of no world Atlas can tell, and a file that is not CR2W.
    {
      path: 'game\\hub_pins\\somewhere.w2em',
      bytes: entityMapPinsFile([{ name: 'x', type: 'RoadSign', x: 1, y: 1 }]),
    },
    {
      path: 'game\\hub_pins\\broken.w2em',
      bytes: Uint8Array.from('not a resource', (c) => c.charCodeAt(0)),
    },
  ];

  it('puts each pin file in its world and counts what it read', () => {
    const { table, stats } = buildPinTable({ files, stamp: '1234-5678', now: 42 });
    expect(isPinTable(table)).toBe(true);
    expect(table.stamp).toBe('1234-5678');
    expect(table.builtAt).toBe(42);
    expect(tableCounts(table)).toEqual({ novigrad: 4, skellige: 1, bob: 1 });
    expect(table.worlds.novigrad).toEqual([
      { name: 'sign_a', type: 'RoadSign', x: 100, y: 200, z: 5, radius: 0 },
      { name: 'nest_a', type: 'MonsterNest', x: -50.12, y: 75.46, z: 0, radius: 20 },
      {
        name: 'camp_a',
        type: 'BanditCampfire',
        x: 10,
        y: 10,
        z: 0,
        radius: 0,
        tags: ['camp_a', 'camp_a_fire'],
      },
      // The DLC's pin of the same name replaced the base one.
      { name: 'sign_b', type: 'RoadSign', x: 0, y: -301, z: 0, radius: 0 },
    ]);
    expect(stats).toEqual({
      files: 8,
      parsed: 7,
      failed: 1,
      versions: { 162: 1, 163: 6 },
      pinFiles: 5,
      pinFilesWithPins: 5,
      areaWorlds: 1,
      mounters: 2,
      worlds: {
        novigrad: { pins: 4, types: { RoadSign: 2, MonsterNest: 1, BanditCampfire: 1 } },
        skellige: { pins: 1, types: { Harbor: 1 } },
        bob: { pins: 1, types: { RoadSign: 1 } },
      },
      unassigned: 1,
      withoutPosition: 1,
      duplicates: 1,
    });
  });

  it('finds a pin by its name or one of its tags, preferring the world asked for', () => {
    const { table } = buildPinTable({
      files: [
        ...files,
        {
          path: 'game\\hub_pins\\kaer_morhen.w2em',
          bytes: entityMapPinsFile([{ name: 'sign_a', type: 'RoadSign', x: 9, y: 9 }]),
        },
      ],
      stamp: 's',
    });
    const index = new PinTableIndex(table);
    expect(index.find('sign_a', 'kaer_morhen')).toMatchObject({ world: 'kaer_morhen' });
    expect(index.find('sign_a', 'novigrad')).toMatchObject({ world: 'novigrad', pin: { x: 100 } });
    expect(index.find('camp_a_fire', null)).toMatchObject({ pin: { name: 'camp_a' } });
    expect(index.find('Camp_A_Fire', null)).toMatchObject({ pin: { name: 'camp_a' } });
    expect(index.find('SIGN_A', 'novigrad')).toMatchObject({ world: 'novigrad' });
    expect(index.find('nowhere', null)).toBeNull();
    expect(index.pinsOf('skellige')).toHaveLength(1);
    expect(index.pinsOf('the_spiral')).toEqual([]);
  });

  it('says what is not a table', () => {
    expect(isPinTable(null)).toBe(false);
    expect(isPinTable({ format: 2, game: 'witcher3', stamp: '', builtAt: 0, worlds: {} })).toBe(
      false,
    );
    expect(
      isPinTable({ format: 1, game: 'witcher3', stamp: '', builtAt: 0, worlds: { a: 1 } }),
    ).toBe(false);
  });
});
