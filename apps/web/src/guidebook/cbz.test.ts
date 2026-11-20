import { describe, expect, it } from 'vitest';
import { findDirectory, picturesIn } from './cbz';

/** A ZIP file of stored entries, made here: its bytes. */
function zip(entries: { name: string; data: Uint8Array; flags?: number }[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const local = new Uint8Array(30 + name.length + entry.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(6, entry.flags ?? 0x800, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(8, entry.flags ?? 0x800, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directorySize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const all = [...locals, ...centrals, end];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const bytes = (n: number) => new Uint8Array(n).fill(7);
const read = (file: Uint8Array) => (begin: number, end: number) =>
  Promise.resolve(file.subarray(begin, end));

describe('reading a CBZ file', () => {
  it('lists its pictures of pages in natural order', async () => {
    const file = zip([
      { name: 'pages/p10.jpg', data: bytes(5) },
      { name: 'pages/p2.png', data: bytes(4) },
      { name: 'readme.txt', data: bytes(3) },
      { name: '__MACOSX/pages/p1.jpg', data: bytes(2) },
      { name: 'pages/p1.webp', data: bytes(6) },
      { name: 'pages/secret.jpg', data: bytes(6), flags: 0x801 },
    ]);
    const { offset, size, entries } = await findDirectory(file, file.length, read(file));
    expect(entries).toBe(6);
    const pictures = picturesIn(file.subarray(offset, offset + size), entries, file.length);
    expect(pictures.map((p) => p.name)).toEqual(['pages/p1.webp', 'pages/p2.png', 'pages/p10.jpg']);
    expect(pictures[0]).toMatchObject({ method: 0, packed: 6, size: 6 });
  });

  it('refuses a file that is not a ZIP, or a damaged directory', async () => {
    const junk = bytes(100);
    await expect(findDirectory(junk, junk.length, read(junk))).rejects.toThrow(
      'not a CBZ file that can be read',
    );
    const file = zip([{ name: 'p1.jpg', data: bytes(5) }]);
    const { offset, size } = await findDirectory(file, file.length, read(file));
    const directory = file.slice(offset, offset + size);
    directory[0] = 0;
    expect(() => picturesIn(directory, 1, file.length)).toThrow('not a CBZ file');
    // An entry said to lie past the end of the file is left out.
    expect(picturesIn(file.subarray(offset, offset + size), 1, 4)).toEqual([]);
  });
});
