import { describe, expect, it } from 'vitest';
import { readerForPack, readSave, SaveReadError } from '../index';
import {
  bs,
  factsStream,
  packedString,
  ss,
  typicalSave,
  value,
  vl,
  WORLD_PATHS,
  writeSave,
  type TestNode,
} from '../testing';
import { readFacts } from './facts';
import { readWitcher3, readWitcher3Tree, witcher3Reader } from './reader';
import { childNamed, topBlock, walk } from './tree';
import { nodeValue } from './summary';
import { ByteReader } from '../binary';
import { readPackedString } from './values';

function readError(run: () => unknown): SaveReadError {
  try {
    run();
  } catch (error) {
    if (error instanceof SaveReadError) return error;
    throw error;
  }
  throw new Error('expected a SaveReadError');
}

const save = (blocks: TestNode[], version?: [number, number, number]) =>
  writeSave(version ? { blocks, version } : { blocks });

describe('reading a Witcher 3 save', () => {
  const bytes = typicalSave({
    world: WORLD_PATHS.novigrad,
    player: { x: 123.5, y: -456.25, z: 7, yaw: 90 },
    facts: {
      q001_done: 1,
      counter: [{ value: 2 }, { value: 3 }],
      timer_only: [{ value: 5, expiry: 30 }],
    },
    pins: {
      [WORLD_PATHS.novigrad]: [
        { name: 'sign_crossroads', type: 'RoadSign', x: 10, y: 20, discovered: true },
        { name: 'nest_01', type: 'MonsterNestDisabled', x: 30, y: 40 },
        { name: 'nest_02', type: 'MonsterNest', x: 50, y: 60, discovered: true },
      ],
      [WORLD_PATHS.skellige]: [{ name: 'sign_harbour', type: 'RoadSign', x: 1, y: 2 }],
    },
    discovered: { [WORLD_PATHS.skellige]: ['sign_harbour'] },
  });

  it('reads the version, world, player and facts', () => {
    const summary = readWitcher3(bytes);
    expect(summary.game).toBe('witcher3');
    expect(summary.version.numbers).toEqual([67, 29, 164]);
    expect(summary.world).toEqual({
      id: 'novigrad',
      path: WORLD_PATHS.novigrad,
      name: 'Velen and Novigrad',
    });
    expect(summary.worlds.map((w) => w.id).sort()).toEqual(['novigrad', 'skellige']);
    expect(summary.player).toEqual({
      world: 'novigrad',
      position: { x: 123.5, y: -456.25, z: 7 },
      yaw: 90,
    });
    expect(summary.facts).toEqual({ q001_done: 1, counter: 5, timer_only: 0 });
    expect(summary.notes).toEqual([]);
    expect(summary.unpackedBytes).toBeGreaterThan(100);
  });

  it('finds map pins with their world, kind and state', () => {
    const pins = new Map(readWitcher3(bytes).pins.map((pin) => [pin.id, pin]));
    expect(pins.get('sign_crossroads')).toEqual({
      id: 'sign_crossroads',
      world: 'novigrad',
      type: 'RoadSign',
      kind: 'signpost',
      position: { x: 10, y: 20, z: 0 },
      discovered: true,
    });
    expect(pins.get('nest_01')).toMatchObject({ kind: 'monster-nest', cleared: true });
    expect(pins.get('nest_02')).toMatchObject({ kind: 'monster-nest', discovered: true });
    expect(pins.get('nest_02')?.cleared).toBeUndefined();
    expect(pins.get('sign_harbour')).toMatchObject({ world: 'skellige', discovered: true });
  });

  it('reads saves of patch 4.0x', () => {
    const old = typicalSave({ version: [64, 27, 163], player: { x: 1, y: 2 } });
    expect(readWitcher3(old).version.numbers).toEqual([64, 27, 163]);
  });

  it('reads saves cut into many chunks, compressed or not', () => {
    const options = {
      player: { x: 5, y: 6 },
      facts: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`fact_${i}`, i])),
    };
    const many = typicalSave({ ...options, chunkSize: 97 });
    const plain = typicalSave({ ...options, chunkSize: 1000, literalsOnly: true });
    const one = readWitcher3(typicalSave(options));
    expect(readWitcher3(many)).toEqual(one);
    expect(readWitcher3(plain)).toEqual(one);
    expect(Object.keys(one.facts)).toHaveLength(200);
  });

  it('finds itself among the readers and matches Witcher 3 packs', () => {
    expect(readSave(bytes).world?.id).toBe('novigrad');
    expect(witcher3Reader.detect(bytes)).toBe(true);
    expect(readerForPack({ gameId: 'witcher-3', title: 'Anything' })?.id).toBe('witcher3');
    expect(readerForPack({ gameId: 'tw3', title: 'The Witcher 3: Wild Hunt' })?.id).toBe(
      'witcher3',
    );
    expect(readerForPack({ gameId: 'demo', title: 'Demo Island' })).toBeNull();
  });
});

describe('refusing saves it cannot read', () => {
  it('refuses other files', () => {
    expect(readError(() => readSave(Uint8Array.of(104, 101, 108, 108, 111))).code).toBe(
      'not-a-save',
    );
    expect(readError(() => readWitcher3(new Uint8Array(0))).code).toBe('not-a-save');
  });

  it('refuses versions it does not know, saying so plainly', () => {
    for (const version of [
      [54, 10, 162],
      [65, 29, 164],
      [67, 29, 165],
      [64, 27, 164],
    ] as [number, number, number][]) {
      const error = readError(() => readWitcher3(typicalSave({ version })));
      expect(error.code).toBe('unsupported-version');
      expect(error.message).toContain(`save version ${version[0]}`);
      expect(error.message).toContain('Nothing was changed');
    }
  });

  it('refuses saves that are cut short or damaged', () => {
    const bytes = typicalSave({ player: { x: 1, y: 2 }, chunkSize: 200 });
    for (const length of [12, 40, 3084, bytes.length - 1, bytes.length - 100]) {
      expect(readError(() => readWitcher3(bytes.subarray(0, length))).code).toBe('damaged');
    }
    const badCount = bytes.slice();
    badCount.set([0, 0, 0, 0], 8);
    expect(readError(() => readWitcher3(badCount)).code).toBe('damaged');
  });

  it('refuses a payload whose footer or table is wrong', () => {
    const blocks = [bs('universe', [vl('x', value.u32(1))])];
    const good = save(blocks);
    expect(() => readWitcher3Tree(good)).not.toThrow();
    // Uncompressed so single bytes can be changed.
    const plain = writeSave({ blocks, literalsOnly: true });
    const footer = plain.length - 2; // "SE"
    const broken = plain.slice();
    broken[footer] = 0x58;
    expect(readError(() => readWitcher3Tree(broken)).code).toBe('damaged');
  });

  it('refuses saves that unpack to more than allowed', () => {
    const bytes = typicalSave({ facts: { a: 1 } });
    expect(readError(() => readWitcher3(bytes, { maxUnpackedBytes: 3200 })).code).toBe('too-large');
  });
});

describe('the variable tree', () => {
  it('nests blocks and keeps untagged parts under their value', () => {
    const tree = readWitcher3Tree(
      save([
        bs('outer', [
          bs('inner', [vl('count', value.u32(7))]),
          // Table entries for the vector's members, as real saves have.
          vl('position', value.vector({ x: 1, y: 2 }), [
            [1, 8],
            [9, 8],
          ]),
        ]),
        bs('second', []),
      ]),
    );
    expect(tree.top.map((n) => n.name)).toEqual(['outer', 'second']);
    const outer = topBlock(tree, 'OUTER')!;
    expect(outer.children.map((n) => `${n.kind}:${n.name}`)).toEqual(['BS:inner', 'VL:position']);
    const position = childNamed(outer, 'position')!;
    expect(position.type).toBe('Vector');
    expect(position.children.map((n) => n.kind)).toEqual(['raw', 'raw']);
    expect(nodeValue(tree, position)).toEqual({ X: 1, Y: 2, Z: 0, W: 1 });
    expect(nodeValue(tree, childNamed(childNamed(outer, 'inner'), 'count'))).toBe(7);
    let visited = 0;
    walk(tree.top, () => visited++);
    expect(visited).toBe(tree.entries);
  });

  it('reads values of every type it knows', () => {
    const fields: [string, ReturnType<typeof value.u32>, unknown][] = [
      ['b', value.bool(true), true],
      ['u8', value.u8(200), 200],
      ['u16', value.u16(60000), 60000],
      ['i16', value.i16(-5), -5],
      ['u32', value.u32(4_000_000_000), 4_000_000_000],
      ['i32', value.i32(-7), -7],
      ['f', value.float(0.5), 0.5],
      ['d', value.double(1 / 3), 1 / 3],
      ['name', value.cname('SomeName'), 'SomeName'],
      ['text', value.string('Ciri'), 'Ciri'],
      ['wide', value.string('Żółw', { utf16: true }), 'Żółw'],
      ['long', value.string('x'.repeat(300)), 'x'.repeat(300)],
      ['kind', value.enumeration('EMapPinType', 'MPT_Quest'), 'MPT_Quest'],
      ['tags', value.tags(['a', 'b']), ['a', 'b']],
      ['list', value.array([value.cname('one'), value.cname('two')]), ['one', 'two']],
      ['empty', value.array([], 'CName'), []],
      ['angles', value.euler({ yaw: 45 }), { Pitch: 0, Yaw: 45, Roll: 0 }],
      [
        'nested',
        value.struct('SPin', { pos: value.vector({ x: 3, y: 4 }), ok: value.bool(false) }),
        { pos: { X: 3, Y: 4, Z: 0, W: 1 }, ok: false },
      ],
      ['unknown', value.raw('lowercaseType', Uint8Array.of(1, 2, 3)), undefined],
    ];
    const tree = readWitcher3Tree(
      save([
        bs(
          'v',
          fields.map(([n, v]) => vl(n, v)),
        ),
      ]),
    );
    const block = topBlock(tree, 'v')!;
    for (const [name, , expected] of fields) {
      expect(nodeValue(tree, childNamed(block, name)), name).toEqual(expected);
    }
  });

  it('reads packed strings of every length', () => {
    for (const length of [0, 1, 63, 64, 127, 8191, 8192, 70_000]) {
      const text = 'ab'.repeat(length).slice(0, length);
      expect(readPackedString(new ByteReader(packedString(text)))).toBe(text);
      expect(readPackedString(new ByteReader(packedString(text, { utf16: true })))).toBe(text);
    }
  });
});

describe('facts', () => {
  it('adds up lasting records and leaves timers out', () => {
    const result = readFacts(
      factsStream({
        a: 1,
        b: [{ value: 2 }, { value: -1 }],
        c: [
          { value: 4, expiry: 100 },
          { value: 1, expiry: -1 },
        ],
      }),
    );
    expect(result).toEqual({ facts: { a: 1, b: 1, c: 1 }, declared: 3, read: 3 });
  });

  it('keeps what it read when the stream holds more than it understands', () => {
    const stream = factsStream({ a: 1, b: 2 }, { declared: 5, end: false });
    const result = readFacts(stream);
    expect(result.read).toBe(2);
    expect(result.facts).toEqual({ a: 1, b: 2 });
  });

  it('notes a partial read in the summary', () => {
    const bytes = save([
      bs('facts', [ss(factsStream({ a: 1 }, { declared: 3, end: false }))]),
      bs('worldInfo', [vl('world', value.string(WORLD_PATHS.skellige))]),
    ]);
    const summary = readWitcher3(bytes);
    expect(summary.facts).toEqual({ a: 1 });
    expect(summary.notes.some((note) => note.includes('Read 1 of 3 facts'))).toBe(true);
    expect(summary.world?.id).toBe('skellige');
    expect(summary.player).toBeNull();
    expect(summary.pins).toEqual([]);
  });

  it('falls back on the loading screen name for the world', () => {
    const bytes = save([
      bs('AdditionalSaveInfo', [vl('LoadingScreenName', value.cname('map_location_bob'))]),
    ]);
    expect(readWitcher3(bytes).world).toEqual({ id: 'bob', path: '', name: 'Toussaint' });
  });
});
