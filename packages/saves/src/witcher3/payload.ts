import { ByteReader, FormatError, hasTag, latin1 } from '../binary';

/**
 * The unpacked save ("payload"). All offsets are absolute: they count the
 * container header in front of it (see `container.ts`).
 *
 * ```text
 * "SAV3" i32 saveVersion i32 gameVersion i32 formatVersion   at dataStart
 * variables (a tree, described by the variable table)
 * "RB" u32 n, n x { u16 name, u32 offset }                   one per top-level block
 * "NM" "MANU" u32 count, u32 0, count x { u8 length, Latin-1 }, u32 0, "ENOD"
 * u32 nmOffset, u32 rbOffset, "SC"                            10 bytes before the table
 * u32 count, count x { u32 offset, u32 size }                 the variable table
 * u32 tableOffset, "SE"                                       the last 6 bytes
 * ```
 *
 * The name table ("NM") holds every property name and type name the
 * variables refer to, by a 1-based 16-bit index.
 *
 * This layout follows Atvaark's W3SavegameEditor (MIT, 2015) and the notes
 * of the Another Life project (MIT, 2026), checked against saves of patch
 * 1.3x, 4.0x and 5.0x there; the code here is Atlas's own.
 */

export interface PayloadHeader {
  saveVersion: number;
  gameVersion: number;
  formatVersion: number;
}

export interface Payload {
  data: Uint8Array;
  /** Where "SAV3" is. */
  start: number;
  header: PayloadHeader;
  /** The name table; index `i` here is name index `i + 1` in the variables. */
  names: string[];
  /** Variable table entries: `offset` at `2 * i`, `size` at `2 * i + 1`. */
  table: Uint32Array;
  tableOffset: number;
}

/** Reads the header only, so a version can be checked before anything else. */
export function readHeader(data: Uint8Array, start: number): PayloadHeader {
  const reader = new ByteReader(data, start);
  reader.expect('SAV3');
  return { saveVersion: reader.i32(), gameVersion: reader.i32(), formatVersion: reader.i32() };
}

export function readPayload(data: Uint8Array, start: number): Payload {
  const header = readHeader(data, start);
  if (data.length < start + 16 + 16 || !hasTag(data, data.length - 2, 'SE')) {
    throw new FormatError('the save has no footer');
  }
  const tail = new ByteReader(data, data.length - 6);
  const tableOffset = tail.u32();
  if (tableOffset < start + 16 + 10 || tableOffset + 4 > data.length - 6) {
    throw new FormatError(`variable table offset ${tableOffset} is out of range`);
  }
  const pointers = new ByteReader(data, tableOffset - 10, tableOffset);
  const nmOffset = pointers.u32();
  pointers.u32(); // rbOffset: not needed to read
  pointers.expect('SC');
  const names = readNames(data, nmOffset, tableOffset - 10);

  const table = new ByteReader(data, tableOffset, data.length - 6);
  const count = table.u32();
  if (count * 8 !== table.remaining) {
    throw new FormatError(
      `variable table of ${count} entries does not fill ${table.remaining} bytes`,
    );
  }
  const entries = new Uint32Array(count * 2);
  for (let i = 0; i < count * 2; i++) entries[i] = table.u32();
  return { data, start, header, names, table: entries, tableOffset };
}

function readNames(data: Uint8Array, nmOffset: number, end: number): string[] {
  if (nmOffset < 0 || nmOffset >= end) throw new FormatError('the name table is out of range');
  const reader = new ByteReader(data, nmOffset, end);
  reader.expect('NM');
  reader.expect('MANU');
  const count = reader.u32();
  reader.u32();
  if (count > reader.remaining) throw new FormatError(`${count} names cannot fit`);
  const names = new Array<string>(count);
  for (let i = 0; i < count; i++) names[i] = reader.latin1(reader.u8());
  reader.u32();
  reader.expect('ENOD');
  return names;
}

/** Name `index` (1-based), or null when it is out of range. */
export function nameAt(names: readonly string[], index: number): string | null {
  return index >= 1 && index <= names.length ? names[index - 1]! : null;
}

/** The first four bytes at `at` as printable text, for the dump tool. */
export function describeTag(data: Uint8Array, at: number): string {
  return latin1(data.subarray(at, Math.min(at + 4, data.length))).replace(/[^\x20-\x7e]/g, '.');
}
