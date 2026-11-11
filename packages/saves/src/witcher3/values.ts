import { ByteReader, FormatError, hex, latin1 } from '../binary';
import { nameAt } from './payload';

/**
 * Values of `VL` and `OP` variables, by their type name. A variable's
 * size is known from the variable table, so a value is only accepted when
 * it is read to its last byte; anything else is left undecoded.
 *
 * Small structures such as `Vector`, `EulerAngles` and `GameTime` are
 * stored inline as their members: one byte (0 on every save seen), then
 * `{ u16 name, u16 type, value }` per member, then a u16 0. A `Vector` is
 * 35 bytes: 1 + 4 x (2 + 2 + 4) + 2.
 */

export type SaveValue =
  boolean | number | string | null | SaveValue[] | { readonly [member: string]: SaveValue };

/** A decoded structure: its members by name. */
export type SaveRecord = Record<string, SaveValue>;

const ARRAY = /^array:\d+,\d+,(.+)$/;

/** Reads a whole value, or returns undefined when its type or layout is not known. */
export function readValue(
  type: string | null,
  bytes: Uint8Array,
  names: readonly string[],
): SaveValue | undefined {
  if (type === null) return undefined;
  // Enumerations are a name index, by the samples seen.
  if (/^e[A-Z]|^E[A-Z]/.test(type) && bytes.length === 2) {
    return nameAt(names, bytes[0]! | (bytes[1]! << 8));
  }
  if (type === 'TagList') return readTagList(bytes, names);
  try {
    const reader = new ByteReader(bytes);
    const value = readFrom(reader, type, names, 0);
    return reader.remaining === 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function readTagList(bytes: Uint8Array, names: readonly string[]): SaveValue | undefined {
  if (bytes.length === 0) return undefined;
  const count = bytes[0]! & 0x7f;
  if (bytes.length !== 1 + 2 * count) return undefined;
  const tags: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = nameAt(names, bytes[1 + 2 * i]! | (bytes[2 + 2 * i]! << 8));
    if (name === null) return undefined;
    tags.push(name);
  }
  return tags;
}

/** Reads one value of `type` at the reader's position. Throws for types it does not know. */
function readFrom(
  reader: ByteReader,
  type: string,
  names: readonly string[],
  depth: number,
): SaveValue {
  switch (type) {
    case 'Bool': {
      const byte = reader.u8();
      return byte === 0 ? false : byte === 1 ? true : byte;
    }
    case 'Uint8':
      return reader.u8();
    case 'Int8':
      return reader.i8();
    case 'Uint16':
      return reader.u16();
    case 'Int16':
      return reader.i16();
    case 'Uint32':
      return reader.u32();
    case 'Int32':
      return reader.i32();
    case 'Uint64':
      return reader.u64();
    case 'Int64':
      return reader.i64();
    case 'Float':
      return reader.f32();
    case 'Double':
      return reader.f64();
    case 'CName':
      return nameAt(names, reader.u16());
    case 'String':
      return readPackedString(reader);
    case 'StringAnsi':
      return reader.latin1(reader.u8()).replace(/\0+$/, '');
    case 'CGUID':
      return hex(reader.bytesView(16));
    case 'IdTag':
      return hex(reader.bytesView(17));
    default:
      break;
  }
  const array = ARRAY.exec(type);
  if (array) {
    const count = reader.u32();
    if (count > reader.remaining) throw new FormatError(`array of ${count} cannot fit`);
    const items: SaveValue[] = [];
    for (let i = 0; i < count; i++) items.push(readFrom(reader, array[1]!, names, depth + 1));
    return items;
  }
  if (depth < 4 && /^[A-Z][A-Za-z0-9_]*$/.test(type)) return readInlineStruct(reader, names, depth);
  throw new FormatError(`no layout for type ${type}`);
}

/** A structure stored inline as its members (see the module comment). */
function readInlineStruct(reader: ByteReader, names: readonly string[], depth: number): SaveRecord {
  reader.u8();
  const members: Record<string, SaveValue> = {};
  for (;;) {
    const nameIndex = reader.u16();
    if (nameIndex === 0) return members;
    const name = nameAt(names, nameIndex);
    const type = nameAt(names, reader.u16());
    if (name === null || type === null) throw new FormatError('member name out of range');
    members[name] = readFrom(reader, type, names, depth + 1);
  }
}

/**
 * A "packed string": the first byte holds a flag for one-byte characters
 * (bit 7), a flag for more length bytes (bit 6) and the low 6 bits of the
 * length; each further length byte adds 7 bits, with bit 7 meaning another
 * follows. Then the characters: Latin-1 bytes, or UTF-16LE code units.
 */
export function readPackedString(reader: ByteReader): string {
  const first = reader.u8();
  const oneByte = (first & 0x80) !== 0;
  let length = first & 0x3f;
  if (first & 0x40) {
    let shift = 6;
    for (;;) {
      const byte = reader.u8();
      if (shift > 27) throw new FormatError('packed string length is too long');
      length += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
  }
  if (oneByte) return latin1(reader.bytesView(length));
  const units = reader.bytesView(length * 2);
  let text = '';
  for (let i = 0; i < length; i++)
    text += String.fromCharCode(units[2 * i]! | (units[2 * i + 1]! << 8));
  return text;
}

/** A plain `{ x, y, z }` from a decoded `Vector`, or null when it is not one. */
export function vectorOf(value: SaveValue | undefined): { x: number; y: number; z: number } | null {
  if (!isRecord(value)) return null;
  const x = memberNumber(value, 'X');
  const y = memberNumber(value, 'Y');
  const z = memberNumber(value, 'Z');
  if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, z: z !== null && Number.isFinite(z) ? z : 0 };
}

export function isRecord(value: SaveValue | undefined): value is SaveRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A numeric member, matched without case. */
export function memberNumber(value: SaveRecord, name: string): number | null {
  const key = Object.keys(value).find((k) => k.toLowerCase() === name.toLowerCase());
  const member = key === undefined ? undefined : value[key];
  return typeof member === 'number' ? member : null;
}
