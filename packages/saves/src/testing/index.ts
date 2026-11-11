/**
 * A small writer of synthetic Witcher 3 saves, for tests only. It writes
 * the container, the LZ4 chunks, the payload with its variable tree,
 * name table and footer, and a facts stream, the way the reader expects
 * them. It is not a save editor: the saves it makes hold only what a test
 * puts in them, and the game would not load them.
 */

// ---------------------------------------------------------------------------
// Bytes

/** A growable little-endian byte buffer. */
export class ByteWriter {
  private buffer = new Uint8Array(256);
  private view = new DataView(this.buffer.buffer);
  length = 0;

  private room(n: number): number {
    if (this.length + n > this.buffer.length) {
      let size = this.buffer.length * 2;
      while (size < this.length + n) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buffer.subarray(0, this.length));
      this.buffer = next;
      this.view = new DataView(next.buffer);
    }
    const at = this.length;
    this.length += n;
    return at;
  }

  u8(value: number): this {
    const at = this.room(1);
    this.buffer[at] = value & 0xff;
    return this;
  }

  i8(value: number): this {
    const at = this.room(1);
    this.view.setInt8(at, value);
    return this;
  }

  u16(value: number): this {
    const at = this.room(2);
    this.view.setUint16(at, value, true);
    return this;
  }

  i16(value: number): this {
    const at = this.room(2);
    this.view.setInt16(at, value, true);
    return this;
  }

  u32(value: number): this {
    const at = this.room(4);
    this.view.setUint32(at, value, true);
    return this;
  }

  i32(value: number): this {
    const at = this.room(4);
    this.view.setInt32(at, value, true);
    return this;
  }

  f32(value: number): this {
    const at = this.room(4);
    this.view.setFloat32(at, value, true);
    return this;
  }

  f64(value: number): this {
    const at = this.room(8);
    this.view.setFloat64(at, value, true);
    return this;
  }

  bytes(bytes: Uint8Array): this {
    const at = this.room(bytes.length);
    this.buffer.set(bytes, at);
    return this;
  }

  /** ASCII or Latin-1 text, one byte per character. */
  text(text: string): this {
    const at = this.room(text.length);
    for (let i = 0; i < text.length; i++) this.buffer[at + i] = text.charCodeAt(i) & 0xff;
    return this;
  }

  /** Overwrites a u32 written earlier. */
  setU32(at: number, value: number): this {
    this.view.setUint32(at, value, true);
    return this;
  }

  toBytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

/** A packed string (see `readPackedString`): Latin-1 when every character fits, else UTF-16. */
export function packedString(text: string, options: { utf16?: boolean } = {}): Uint8Array {
  let oneByte = !options.utf16;
  for (let i = 0; i < text.length && oneByte; i++) oneByte = text.charCodeAt(i) <= 0xff;
  const writer = new ByteWriter();
  const length = text.length;
  writer.u8((oneByte ? 0x80 : 0) | (length > 0x3f ? 0x40 : 0) | (length & 0x3f));
  let rest = Math.floor(length / 64);
  if (length > 0x3f) {
    for (;;) {
      const more = rest >= 0x80;
      writer.u8((rest & 0x7f) | (more ? 0x80 : 0));
      rest = Math.floor(rest / 128);
      if (!more) break;
    }
  }
  if (oneByte) writer.text(text);
  else for (let i = 0; i < length; i++) writer.u16(text.charCodeAt(i));
  return writer.toBytes();
}

// ---------------------------------------------------------------------------
// LZ4

/**
 * Compresses one raw LZ4 block, greedily with a hash of four bytes. It
 * keeps to the block format's end rules (the last five bytes are
 * literals, no match starts in the last twelve), so any LZ4 decoder reads
 * it. With `literalsOnly`, the block is one run of literals.
 */
export function compressLz4Block(src: Uint8Array, literalsOnly = false): Uint8Array {
  const out = new ByteWriter();
  const length = (n: number) => {
    let rest = n - 15;
    while (rest >= 255) {
      out.u8(255);
      rest -= 255;
    }
    out.u8(rest);
  };
  const sequence = (from: number, to: number, offset: number, match: number) => {
    const literals = to - from;
    const matchNibble = match === 0 ? 0 : Math.min(match - 4, 15);
    out.u8((Math.min(literals, 15) << 4) | matchNibble);
    if (literals >= 15) length(literals);
    out.bytes(src.subarray(from, to));
    if (match === 0) return;
    out.u16(offset);
    if (match - 4 >= 15) length(match - 4);
  };
  const read32 = (at: number) =>
    (src[at]! | (src[at + 1]! << 8) | (src[at + 2]! << 16) | (src[at + 3]! << 24)) >>> 0;

  let anchor = 0;
  if (!literalsOnly) {
    const table = new Int32Array(1 << 16).fill(-1);
    const lastMatchStart = src.length - 12;
    const matchEnd = src.length - 5;
    let i = 0;
    while (i < lastMatchStart) {
      const word = read32(i);
      const hash = Math.imul(word, 2654435761) >>> 16;
      const ref = table[hash]!;
      table[hash] = i;
      if (ref >= 0 && i - ref <= 0xffff && read32(ref) === word) {
        let match = 4;
        while (i + match < matchEnd && src[ref + match] === src[i + match]) match++;
        sequence(anchor, i, i - ref, match);
        i += match;
        anchor = i;
      } else {
        i++;
      }
    }
  }
  sequence(anchor, src.length, 0, 0);
  return out.toBytes();
}

// ---------------------------------------------------------------------------
// Values

/** A value to write, with its type name. */
export interface TestValue {
  type: string;
  write(writer: ByteWriter, names: NameTable): void;
}

/** Collects names while writing and gives their 1-based index. */
export class NameTable {
  readonly names: string[] = [];
  private readonly index = new Map<string, number>();

  of(name: string): number {
    let at = this.index.get(name);
    if (at === undefined) {
      this.names.push(name);
      at = this.names.length;
      this.index.set(name, at);
    }
    return at;
  }
}

const scalar = (type: string, write: (writer: ByteWriter) => void): TestValue => ({
  type,
  write: (writer) => {
    write(writer);
  },
});

/** Builders for values of the types the reader knows. */
export const value = {
  bool: (v: boolean) => scalar('Bool', (w) => w.u8(v ? 1 : 0)),
  u8: (v: number) => scalar('Uint8', (w) => w.u8(v)),
  u16: (v: number) => scalar('Uint16', (w) => w.u16(v)),
  i16: (v: number) => scalar('Int16', (w) => w.i16(v)),
  u32: (v: number) => scalar('Uint32', (w) => w.u32(v)),
  i32: (v: number) => scalar('Int32', (w) => w.i32(v)),
  float: (v: number) => scalar('Float', (w) => w.f32(v)),
  double: (v: number) => scalar('Double', (w) => w.f64(v)),
  string: (v: string, options?: { utf16?: boolean }) =>
    scalar('String', (w) => w.bytes(packedString(v, options))),
  cname: (v: string): TestValue => ({ type: 'CName', write: (w, n) => w.u16(n.of(v)) }),
  /** An enumeration value, stored as a name. */
  enumeration: (type: string, v: string): TestValue => ({ type, write: (w, n) => w.u16(n.of(v)) }),
  tags: (tags: string[]): TestValue => ({
    type: 'TagList',
    write: (w, n) => {
      w.u8(tags.length);
      for (const tag of tags) w.u16(n.of(tag));
    },
  }),
  /** A structure stored inline as its members. */
  struct: (type: string, members: Record<string, TestValue>): TestValue => ({
    type,
    write: (w, n) => {
      w.u8(0);
      for (const [name, member] of Object.entries(members)) {
        w.u16(n.of(name)).u16(n.of(member.type));
        member.write(w, n);
      }
      w.u16(0);
    },
  }),
  vector: (v: { x: number; y: number; z?: number; w?: number }) =>
    value.struct('Vector', {
      X: value.float(v.x),
      Y: value.float(v.y),
      Z: value.float(v.z ?? 0),
      W: value.float(v.w ?? 1),
    }),
  euler: (v: { pitch?: number; yaw: number; roll?: number }) =>
    value.struct('EulerAngles', {
      Pitch: value.float(v.pitch ?? 0),
      Yaw: value.float(v.yaw),
      Roll: value.float(v.roll ?? 0),
    }),
  /** An array; `elementType` is needed for an empty one. */
  array: (items: TestValue[], elementType = items[0]?.type ?? 'Uint32'): TestValue => ({
    type: `array:2,0,${elementType}`,
    write: (w, n) => {
      w.u32(items.length);
      for (const item of items) item.write(w, n);
    },
  }),
  /** Bytes as they are, under any type name. */
  raw: (type: string, bytes: Uint8Array): TestValue => ({ type, write: (w) => w.bytes(bytes) }),
};

// ---------------------------------------------------------------------------
// Variables

export type TestNode =
  | { tag: 'BS'; name: string; children: TestNode[] }
  | {
      tag: 'VL' | 'OP';
      name: string;
      value: TestValue;
      /** Extra table entries inside the value, as [start in the value, size]. */
      parts?: [number, number][];
    }
  | { tag: 'SS'; body: Uint8Array };

export const bs = (name: string, children: TestNode[]): TestNode => ({ tag: 'BS', name, children });
export const vl = (name: string, v: TestValue, parts?: [number, number][]): TestNode =>
  parts ? { tag: 'VL', name, value: v, parts } : { tag: 'VL', name, value: v };
export const op = (name: string, v: TestValue): TestNode => ({ tag: 'OP', name, value: v });
export const ss = (body: Uint8Array): TestNode => ({ tag: 'SS', body });

/** A fact for {@link factsStream}: a value (one permanent record) or its records. */
export type TestFact = number | { value: number; time?: number; expiry?: number }[];

/** The body of the `facts` stream. */
export function factsStream(
  facts: Record<string, TestFact>,
  options: { version?: [number, number, number]; declared?: number; end?: boolean } = {},
): Uint8Array {
  const writer = new ByteWriter().text('SXAP');
  for (const n of options.version ?? [67, 29, 164]) writer.i32(n);
  const entries = Object.entries(facts);
  writer.text('SBDF').u32(options.declared ?? entries.length);
  for (const [name, fact] of entries) {
    const records = typeof fact === 'number' ? [{ value: fact }] : fact;
    writer.bytes(packedString(name)).u16(0).u16(records.length);
    for (const record of records) {
      writer
        .i16(record.value)
        .f32(record.time ?? 0)
        .f32(record.expiry ?? -1);
    }
  }
  if (options.end !== false) writer.text('EBDF');
  return writer.toBytes();
}

// ---------------------------------------------------------------------------
// The save

export interface TestSaveOptions {
  /** Save version, game version, format. Default [67, 29, 164] (patch 5.01). */
  version?: [number, number, number];
  blocks: TestNode[];
  /** Unpacked bytes per chunk. Default 1 MiB, as the game does. */
  chunkSize?: number;
  /** Store chunks as literals only (faster, larger). */
  literalsOnly?: boolean;
  /** Bytes of container header before the data. Default 3,084, as the game does. */
  dataStart?: number;
}

/** The unpacked save data alone, as it sits after `dataStart`, with the offsets it uses. */
export function writePayload(options: TestSaveOptions): Uint8Array {
  const dataStart = options.dataStart ?? 3084;
  const [saveVersion, gameVersion, format] = options.version ?? [67, 29, 164];
  const names = new NameTable();
  const out = new ByteWriter().text('SAV3').i32(saveVersion).i32(gameVersion).i32(format);
  const table: [number, number][] = [];
  const at = () => dataStart + out.length;

  const write = (node: TestNode): void => {
    const start = at();
    const entry: [number, number] = [start, 0];
    table.push(entry);
    switch (node.tag) {
      case 'BS':
        out.text('BS').u16(names.of(node.name));
        for (const child of node.children) write(child);
        break;
      case 'VL':
      case 'OP': {
        out.text(node.tag).u16(names.of(node.name)).u16(names.of(node.value.type));
        const valueStart = at();
        node.value.write(out, names);
        for (const [from, size] of node.parts ?? []) table.push([valueStart + from, size]);
        break;
      }
      case 'SS':
        out.text('SS').u32(node.body.length).bytes(node.body);
        break;
    }
    entry[1] = at() - start;
  };
  const tops: [string, number][] = [];
  for (const block of options.blocks) {
    if (block.tag === 'BS') tops.push([block.name, at()]);
    write(block);
  }

  const rbOffset = at();
  out.text('RB').u32(tops.length);
  for (const [name, offset] of tops) out.u16(names.of(name)).u32(offset);
  const nmOffset = at();
  out.text('NM').text('MANU').u32(names.names.length).u32(0);
  for (const name of names.names) out.u8(name.length).text(name);
  out.u32(0).text('ENOD');
  out.u32(nmOffset).u32(rbOffset).text('SC');
  const tableOffset = at();
  out.u32(table.length);
  for (const [offset, size] of table) out.u32(offset).u32(size);
  out.u32(tableOffset).text('SE');
  return out.toBytes();
}

/** A whole save file: the container around the compressed payload. */
export function writeSave(options: TestSaveOptions): Uint8Array {
  const dataStart = options.dataStart ?? 3084;
  const payload = writePayload(options);
  const chunkSize = options.chunkSize ?? 1 << 20;
  const chunks: { packed: Uint8Array; unpacked: number }[] = [];
  for (let from = 0; from < payload.length; from += chunkSize) {
    const part = payload.subarray(from, Math.min(from + chunkSize, payload.length));
    chunks.push({ packed: compressLz4Block(part, options.literalsOnly), unpacked: part.length });
  }
  const out = new ByteWriter().text('SNFHFZLC').u32(chunks.length).u32(dataStart);
  let end = dataStart;
  for (const chunk of chunks) {
    end += chunk.packed.length;
    out.u32(chunk.packed.length).u32(chunk.unpacked).u32(end);
  }
  if (out.length > dataStart) throw new Error('too many chunks for the container header');
  while (out.length < dataStart) out.u8(0);
  for (const chunk of chunks) out.bytes(chunk.packed);
  return out.toBytes();
}

// ---------------------------------------------------------------------------
// A typical save

export interface TestPin {
  /** The pin's name (an entity tag). */
  name: string;
  type: string;
  x: number;
  y: number;
  z?: number;
  discovered?: boolean;
  /** World path; pins without one take the world of their group. */
  world?: string;
}

export interface TypicalSaveOptions {
  version?: [number, number, number];
  /** World path, such as `levels\novigrad\novigrad.w2w`. */
  world?: string;
  player?: { x: number; y: number; z?: number; yaw?: number };
  facts?: Record<string, TestFact>;
  /** Pins by world path, written as the reader's guess of the map manager's layout. */
  pins?: Record<string, TestPin[]>;
  /** Names of pins listed as discovered or disabled, by world path. */
  discovered?: Record<string, string[]>;
  extraBlocks?: TestNode[];
  literalsOnly?: boolean;
  chunkSize?: number;
}

export const WORLD_PATHS = {
  novigrad: 'levels\\novigrad\\novigrad.w2w',
  skellige: 'levels\\skellige\\skellige.w2w',
  whiteOrchard: 'levels\\prolog_village\\prolog_village.w2w',
  toussaint: 'dlc\\bob\\data\\levels\\bob\\bob.w2w',
} as const;

/**
 * A save with the blocks Atlas reads, laid out as the reader expects.
 * The map pin layout is the reader's GUESS (the real one is not known yet):
 * per world, a world path followed by a block per pin with its name, type,
 * position and a discovered flag.
 */
export function typicalSave(options: TypicalSaveOptions = {}): Uint8Array {
  return writeSave({ ...typicalSaveOptions(options), literalsOnly: options.literalsOnly ?? false });
}

export function typicalSaveOptions(options: TypicalSaveOptions = {}): TestSaveOptions {
  const world = options.world ?? WORLD_PATHS.novigrad;
  const blocks: TestNode[] = [
    bs('CCommonMapManager', mapManager(options.pins ?? {}, options.discovered ?? {})),
    bs('worldInfo', [vl('world', value.string(world))]),
    bs('AdditionalSaveInfo', [
      vl('LoadingScreenName', value.cname(`map_location_${worldFolder(world)}`)),
    ]),
  ];
  const universe: TestNode[] = [bs('world', [vl('name', value.string(world))])];
  if (options.player) {
    const { x, y, z, yaw } = options.player;
    universe.push(
      bs('Player', [
        vl('position', value.vector({ x, y, z: z ?? 0 })),
        vl('rotation', value.euler({ yaw: yaw ?? 0 })),
      ]),
    );
  }
  blocks.push(bs('universe', universe));
  blocks.push(bs('facts', [ss(factsStream(options.facts ?? {}, { version: options.version }))]));
  blocks.push(...(options.extraBlocks ?? []));
  const result: TestSaveOptions = { blocks };
  if (options.version) result.version = options.version;
  if (options.chunkSize) result.chunkSize = options.chunkSize;
  return result;
}

function worldFolder(path: string): string {
  const parts = path.split('\\');
  return parts[parts.length - 2] ?? 'unknown';
}

function mapManager(
  pins: Record<string, TestPin[]>,
  discovered: Record<string, string[]>,
): TestNode[] {
  const worlds = new Set([...Object.keys(pins), ...Object.keys(discovered)]);
  const nodes: TestNode[] = [];
  for (const world of worlds) {
    const group: TestNode[] = [vl('CachedWorldDataPath', value.string(world))];
    for (const pin of pins[world] ?? []) {
      const fields: TestNode[] = [
        vl('entityName', value.cname(pin.name)),
        vl('type', value.cname(pin.type)),
        vl('position', value.vector({ x: pin.x, y: pin.y, z: pin.z ?? 0 })),
      ];
      if (pin.discovered !== undefined) fields.push(vl('isDiscovered', value.bool(pin.discovered)));
      if (pin.world) fields.push(vl('worldPath', value.string(pin.world)));
      group.push(bs('mapPin', fields));
    }
    const names = discovered[world];
    if (names) {
      group.push(vl('discoveredPins', value.array(names.map(value.cname), 'CName')));
    }
    nodes.push(bs('CachedWorldData', group));
  }
  return nodes;
}
