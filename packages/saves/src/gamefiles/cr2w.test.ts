import { describe, expect, it } from 'vitest';
import { ByteReader } from '../binary';
import type { ByteWriter } from '../testing';
import { cr2w, writeCr2w } from '../testing/cr2w';
import { exportProperties, exportsOf, isCr2w, readBit6, readCr2w } from './cr2w';

describe('CR2W files', () => {
  it('reads names, imports, exports and their properties', () => {
    const bytes = writeCr2w({
      version: 163,
      exports: [
        {
          className: 'CTestResource',
          properties: {
            flag: cr2w.bool(true),
            count: cr2w.u32(7),
            offset: cr2w.i32(-3),
            size: cr2w.float(2.5),
            label: cr2w.string('Crossroads'),
            kind: cr2w.cname('RoadSign'),
            tags: cr2w.tags(['sign_a', 'sign_a_alt']),
            world: cr2w.soft('CWorld', 'levels\\novigrad\\novigrad.w2w'),
            where: cr2w.vector({ x: 0, y: -12.5, z: 3 }),
            items: cr2w.array('SItem', [
              cr2w.struct('SItem', { name: cr2w.cname('first') }),
              cr2w.struct('SItem', { name: cr2w.cname('second'), weight: cr2w.float(1) }),
            ]),
          },
        },
        { className: 'COther', parent: 1, properties: {} },
      ],
    });
    expect(isCr2w(bytes)).toBe(true);
    const file = readCr2w(bytes);
    expect(file.version).toBe(163);
    expect(file.exports.map((e) => [e.className, e.parent])).toEqual([
      ['CTestResource', 0],
      ['COther', 1],
    ]);
    expect(file.imports).toEqual([{ path: 'levels\\novigrad\\novigrad.w2w', className: 'CWorld' }]);
    expect(exportsOf(file, 'CTestResource')).toEqual([
      {
        flag: true,
        count: 7,
        offset: -3,
        size: 2.5,
        label: 'Crossroads',
        kind: 'RoadSign',
        tags: ['sign_a', 'sign_a_alt'],
        world: 'levels\\novigrad\\novigrad.w2w',
        // X is 0, its default, so it is not written.
        where: { Y: -12.5, Z: 3, W: 1 },
        items: [{ name: 'first' }, { name: 'second', weight: 1 }],
      },
    ]);
    expect(exportsOf(file, 'COther')).toEqual([{}]);
  });

  it('leaves out a property it cannot read and keeps the rest', () => {
    const bytes = writeCr2w({
      exports: [
        {
          className: 'CTestResource',
          properties: {
            before: cr2w.u32(1),
            // A Uint32 property that holds 6 bytes: not read to its end.
            odd: { type: 'Uint32', write: (w) => w.u32(5).u16(0) },
            after: cr2w.cname('kept'),
          },
        },
      ],
    });
    expect(exportsOf(readCr2w(bytes), 'CTestResource')).toEqual([{ before: 1, after: 'kept' }]);
  });

  it('gives no properties for an export whose data is not a property bag', () => {
    const bytes = writeCr2w({
      exports: [{ className: 'CTestResource', properties: { a: cr2w.u32(1) } }],
    });
    const file = readCr2w(bytes);
    const item = file.exports[0]!;
    bytes[item.offset] = 7;
    expect(exportProperties(file, item)).toEqual({});
  });

  it('refuses what is not a CR2W file it can read', () => {
    expect(() => readCr2w(Uint8Array.from('POTATO70', (c) => c.charCodeAt(0)))).toThrow(
      'not a CR2W file',
    );
    const good = writeCr2w({ exports: [] });
    const old = good.slice();
    new DataView(old.buffer).setUint32(4, 40, true);
    expect(() => readCr2w(old)).toThrow('version 40');
    // The export table said to be far past the end.
    const broken = writeCr2w({
      exports: [{ className: 'CTestResource', properties: {} }],
    });
    new DataView(broken.buffer).setUint32(0x28 + 4 * 12, 1 << 24, true);
    expect(() => readCr2w(broken)).toThrow('do not fit');
  });

  it('reads the game’s small counts', () => {
    const read = (...bytes: number[]) => readBit6(new ByteReader(Uint8Array.from(bytes)));
    expect(read(0x80)).toBe(0);
    expect(read(5)).toBe(5);
    expect(read(0x3f)).toBe(63);
    // 70 = 6 + 1 * 64.
    expect(read(0x46, 0x01)).toBe(70);
    // A tag list of 70 tags reads whole.
    const tags = Array.from({ length: 70 }, (_, i) => `tag_${i}`);
    const file = readCr2w(
      writeCr2w({ exports: [{ className: 'CTags', properties: { tags: cr2w.tags(tags) } }] }),
    );
    expect(exportsOf(file, 'CTags')[0]!.tags).toEqual(tags);
  });

  it('accepts a tag list written as a structure with a tags buffer', () => {
    const asStruct = {
      type: 'TagList',
      write: (w: ByteWriter, c: { name(n: string): number }) => {
        w.u8(0).u16(c.name('tags')).u16(c.name('CBufferVLQInt32:CName'));
        const at = w.length;
        w.u32(0).u8(2).u16(c.name('one')).u16(c.name('two'));
        w.setU32(at, w.length - at);
        w.u16(0);
      },
    };
    const file = readCr2w(
      writeCr2w({ exports: [{ className: 'CTags', properties: { entityTags: asStruct } }] }),
    );
    expect(exportsOf(file, 'CTags')[0]!.entityTags).toEqual(['one', 'two']);
  });
});
