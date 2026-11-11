import { ByteReader, FormatError, hex } from '../binary';
import { readPackedString } from '../witcher3/values';

/**
 * CR2W, the container of The Witcher 3's own resources (`.w2em`, `.w2am`,
 * `.reddlc` and most others), as unpacked from the game's bundles by the
 * desktop shell. Read-only and tolerant: a property that cannot be read is
 * left out rather than failing the file.
 *
 * Layout (all little-endian):
 *
 * - header: `CR2W`, u32 version, u32 flags, u64 timestamp, u32 build,
 *   u32 file size, u32 buffer size, u32 CRC32, u32 chunk count;
 * - from 0x28, ten table headers of (u32 offset, u32 count, u32 CRC): the
 *   string buffer (count is its size in bytes), names (u32 string offset,
 *   u32 hash), imports (u32 path offset, u16 class name, u16 flags),
 *   properties (16 bytes), exports (u16 class name, u16 flags, u32 parent,
 *   u32 data size, u32 data offset, u32 template, u32 CRC), buffers and
 *   embedded files;
 * - each export's data is a property bag: a lead byte (0), then per
 *   property u16 name, u16 type, u32 size (counting itself) and the value,
 *   until a name of 0. Properties left at their default are not written.
 *
 * Values: numbers as they are; `CName` a u16 name index; `String` a packed
 * string; `array:a,b,T` a u32 count and the elements; `soft:T` a u16
 * import index (1-based); `TagList` a count and u16 name indices; any
 * other type a structure, written as a property bag of its own.
 */

/** A decoded value: structures are records of their properties by name. */
export type Cr2wValue =
  boolean | number | string | null | Cr2wValue[] | { readonly [property: string]: Cr2wValue };

export type Cr2wRecord = Record<string, Cr2wValue>;

export interface Cr2wImport {
  /** The depot path, such as `dlc\bob\data\levels\bob\bob.w2w`. */
  path: string;
  className: string;
}

export interface Cr2wExport {
  className: string;
  /** 1-based index of the parent export; 0 for none. */
  parent: number;
  offset: number;
  size: number;
}

export interface Cr2wFile {
  version: number;
  names: string[];
  imports: Cr2wImport[];
  exports: Cr2wExport[];
  bytes: Uint8Array;
}

const TABLES_AT = 0x28;
const TABLE_COUNT = 10;
/** Versions seen in The Witcher 3 are 162 to 164; others are read with care. */
export const CR2W_VERSION_RANGE = { min: 100, max: 255 } as const;
/** No resource Atlas reads has more of anything than this. */
const MAX_ITEMS = 1 << 20;

/** Whether the bytes start like a CR2W file. */
export function isCr2w(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x43 &&
    bytes[1] === 0x52 &&
    bytes[2] === 0x32 &&
    bytes[3] === 0x57
  );
}

/** Reads the header and tables of a CR2W file. Throws {@link FormatError}. */
export function readCr2w(bytes: Uint8Array): Cr2wFile {
  if (!isCr2w(bytes)) throw new FormatError('not a CR2W file');
  const reader = new ByteReader(bytes);
  reader.skip(4);
  const version = reader.u32();
  if (version < CR2W_VERSION_RANGE.min || version > CR2W_VERSION_RANGE.max) {
    throw new FormatError(`CR2W version ${version} is not one Atlas reads`);
  }
  reader.pos = TABLES_AT;
  const tables: { offset: number; count: number }[] = [];
  for (let i = 0; i < TABLE_COUNT; i++) {
    const offset = reader.u32();
    const count = reader.u32();
    reader.skip(4);
    tables.push({ offset, count });
  }
  const [strings, nameTable, importTable, , exportTable] = tables as [
    (typeof tables)[number],
    (typeof tables)[number],
    (typeof tables)[number],
    (typeof tables)[number],
    (typeof tables)[number],
  ];
  const fits = (table: { offset: number; count: number }, size: number) =>
    table.count <= MAX_ITEMS && table.offset + table.count * size <= bytes.length;
  if (!fits(strings, 1) || !fits(nameTable, 8) || !fits(importTable, 8) || !fits(exportTable, 24)) {
    throw new FormatError('the CR2W tables do not fit in the file');
  }
  const stringAt = (offset: number): string => {
    if (offset >= strings.count) return '';
    let end = strings.offset + offset;
    const limit = strings.offset + strings.count;
    while (end < limit && bytes[end] !== 0) end++;
    let text = '';
    for (let i = strings.offset + offset; i < end; i++) text += String.fromCharCode(bytes[i]!);
    return text;
  };
  const names: string[] = [];
  reader.pos = nameTable.offset;
  for (let i = 0; i < nameTable.count; i++) {
    names.push(stringAt(reader.u32()));
    reader.skip(4);
  }
  const nameAt = (index: number) => names[index] ?? '';
  const imports: Cr2wImport[] = [];
  reader.pos = importTable.offset;
  for (let i = 0; i < importTable.count; i++) {
    const path = stringAt(reader.u32());
    const className = nameAt(reader.u16());
    reader.skip(2);
    imports.push({ path, className });
  }
  const exports: Cr2wExport[] = [];
  reader.pos = exportTable.offset;
  for (let i = 0; i < exportTable.count; i++) {
    const className = nameAt(reader.u16());
    reader.skip(2);
    const parent = reader.u32();
    const size = reader.u32();
    const offset = reader.u32();
    reader.skip(8);
    if (offset + size > bytes.length) {
      throw new FormatError(`export ${i + 1} ends past the end of the file`);
    }
    exports.push({ className, parent, offset, size });
  }
  return { version, names, imports, exports, bytes };
}

/** The properties of an export, by name; those that cannot be read are left out. */
export function exportProperties(file: Cr2wFile, item: Cr2wExport): Cr2wRecord {
  const reader = new ByteReader(file.bytes, item.offset, item.offset + item.size);
  try {
    return readBag(reader, file);
  } catch {
    return {};
  }
}

/** Every export of a class, with its properties. */
export function exportsOf(file: Cr2wFile, className: string): Cr2wRecord[] {
  return file.exports
    .filter((item) => item.className === className)
    .map((item) => exportProperties(file, item));
}

/** A property bag: a lead byte, then properties until a name of 0. */
function readBag(reader: ByteReader, file: Cr2wFile): Cr2wRecord {
  const lead = reader.u8();
  if (lead === 0x80) return {};
  if (lead === 1) reader.skip(4);
  else if (lead !== 0) throw new FormatError(`unexpected property bag lead ${lead}`);
  const record: Cr2wRecord = {};
  for (let count = 0; count < MAX_ITEMS; count++) {
    if (reader.remaining < 2) break;
    const nameIndex = reader.u16();
    if (nameIndex === 0) return record;
    const typeIndex = reader.u16();
    const size = reader.u32();
    if (size < 4 || size - 4 > reader.remaining) {
      throw new FormatError(`property size ${size} does not fit`);
    }
    const end = reader.pos + size - 4;
    const name = file.names[nameIndex];
    const type = file.names[typeIndex];
    if (name !== undefined && type !== undefined) {
      const value = readProperty(type, new ByteReader(reader.bytes, reader.pos, end), file);
      if (value !== undefined) record[name] = value;
    }
    reader.pos = end;
  }
  return record;
}

/** A whole property value, or undefined when it does not read to its last byte. */
function readProperty(type: string, reader: ByteReader, file: Cr2wFile): Cr2wValue | undefined {
  try {
    if (type === 'TagList') return readTagList(reader, file);
    const value = readValue(type, reader, file);
    return reader.remaining === 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

const ARRAY = /^array:\d+,\d+,(.+)$/;
const BUFFER = /^CBuffer(?:VLQInt32|Bit6):(.+)$/;

function readValue(type: string, reader: ByteReader, file: Cr2wFile): Cr2wValue {
  switch (type) {
    case 'Bool':
      return reader.u8() !== 0;
    case 'Int8':
      return reader.i8();
    case 'Uint8':
      return reader.u8();
    case 'Int16':
      return reader.i16();
    case 'Uint16':
      return reader.u16();
    case 'Int32':
      return reader.i32();
    case 'Uint32':
      return reader.u32();
    case 'Int64': {
      const value = reader.i64();
      return typeof value === 'number' ? value : Number(value);
    }
    case 'Uint64': {
      const value = reader.u64();
      return typeof value === 'number' ? value : Number(value);
    }
    case 'Float':
      return reader.f32();
    case 'Double':
      return reader.f64();
    case 'CName':
      return file.names[reader.u16()] ?? null;
    case 'String':
      return readPackedString(reader);
    case 'CGUID':
      return hex(reader.bytesView(16));
    case 'TagList':
      return readTags(reader, file);
    default:
      break;
  }
  const array = ARRAY.exec(type);
  if (array) {
    const count = reader.u32();
    if (count > reader.remaining) throw new FormatError('array count does not fit');
    const items: Cr2wValue[] = [];
    for (let i = 0; i < count; i++) items.push(readValue(array[1]!, reader, file));
    return items;
  }
  const buffer = BUFFER.exec(type);
  if (buffer) {
    const count = readBit6(reader);
    if (count > reader.remaining) throw new FormatError('buffer count does not fit');
    const items: Cr2wValue[] = [];
    for (let i = 0; i < count; i++) items.push(readValue(buffer[1]!, reader, file));
    return items;
  }
  if (type.startsWith('soft:')) {
    const index = reader.u16();
    return index > 0 ? (file.imports[index - 1]?.path ?? null) : null;
  }
  if (type.startsWith('handle:') || type.startsWith('ptr:')) return reader.i32();
  if (/^E[A-Z]|^e[A-Z]/.test(type) && reader.remaining === 2) {
    // An enumeration, written as the name of its value.
    return file.names[reader.u16()] ?? null;
  }
  // A structure (Vector, EulerAngles, SEntityMapPinInfo, ...).
  return readBag(reader, file);
}

/**
 * A `TagList` property: a count and u16 name indices. Some tools show it as
 * a structure with a `tags` buffer, so that layout is accepted too.
 */
function readTagList(reader: ByteReader, file: Cr2wFile): Cr2wValue | undefined {
  const start = reader.pos;
  try {
    const tags = readTags(reader, file);
    if (reader.remaining === 0) return tags;
  } catch {
    // Not a plain list; try a structure.
  }
  reader.pos = start;
  const record = readBag(reader, file);
  return Array.isArray(record.tags) ? record.tags : undefined;
}

function readTags(reader: ByteReader, file: Cr2wFile): string[] {
  const count = readBit6(reader);
  if (count * 2 > reader.remaining) throw new FormatError('tag count does not fit');
  const tags: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = file.names[reader.u16()];
    if (name) tags.push(name);
  }
  return tags;
}

/**
 * The game's small variable-length count: 0x80 alone is 0; the first byte
 * holds 6 bits and a continuation bit (0x40), each later byte 7 bits and a
 * continuation bit (0x80).
 */
export function readBit6(reader: ByteReader): number {
  const first = reader.u8();
  if (first === 0x80) return 0;
  let value = first & 0x3f;
  if ((first & 0x40) === 0) return value;
  let shift = 6;
  for (;;) {
    const byte = reader.u8();
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0 || shift > 27) break;
  }
  return value;
}
