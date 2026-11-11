import { ByteWriter, packedString } from './index';

/**
 * A small writer of synthetic CR2W files, for tests only: the header, the
 * string, name, import and export tables, and each export's data as a
 * property bag, the way the reader in `gamefiles/cr2w.ts` expects them.
 * The files hold only what a test puts in them; they come from nothing in
 * the game.
 */

/** Gives the 1-based index of names and imports while values are written. */
export interface Cr2wWriteContext {
  name(name: string): number;
  importOf(path: string, className: string): number;
}

/** A value to write, with its type name. */
export interface Cr2wTestValue {
  type: string;
  write(writer: ByteWriter, context: Cr2wWriteContext): void;
}

const scalar = (type: string, write: (writer: ByteWriter) => void): Cr2wTestValue => ({
  type,
  write: (writer) => {
    write(writer);
  },
});

/** A property bag: a lead 0, then each property with its size, then a name of 0. */
function writeBag(
  writer: ByteWriter,
  context: Cr2wWriteContext,
  properties: Record<string, Cr2wTestValue | undefined>,
): void {
  writer.u8(0);
  for (const [name, value] of Object.entries(properties)) {
    if (!value) continue;
    writer.u16(context.name(name)).u16(context.name(value.type));
    const at = writer.length;
    writer.u32(0);
    value.write(writer, context);
    writer.setU32(at, writer.length - at);
  }
  writer.u16(0);
}

/** The game's small count: 6 bits and a continuation bit, then 7 bits a byte. */
function bit6(writer: ByteWriter, count: number): void {
  if (count === 0) {
    writer.u8(0x80);
    return;
  }
  writer.u8((count & 0x3f) | (count > 0x3f ? 0x40 : 0));
  let rest = Math.floor(count / 64);
  while (rest > 0) {
    writer.u8((rest & 0x7f) | (rest > 0x7f ? 0x80 : 0));
    rest = Math.floor(rest / 128);
  }
}

/** Builders for CR2W values. */
export const cr2w = {
  bool: (v: boolean) => scalar('Bool', (w) => w.u8(v ? 1 : 0)),
  u32: (v: number) => scalar('Uint32', (w) => w.u32(v)),
  i32: (v: number) => scalar('Int32', (w) => w.i32(v)),
  float: (v: number) => scalar('Float', (w) => w.f32(v)),
  string: (v: string) => scalar('String', (w) => w.bytes(packedString(v))),
  cname: (v: string): Cr2wTestValue => ({ type: 'CName', write: (w, c) => w.u16(c.name(v)) }),
  tags: (tags: string[]): Cr2wTestValue => ({
    type: 'TagList',
    write: (w, c) => {
      bit6(w, tags.length);
      for (const tag of tags) w.u16(c.name(tag));
    },
  }),
  /** A soft handle to a resource: an index into the imports. */
  soft: (className: string, path: string): Cr2wTestValue => ({
    type: `soft:${className}`,
    write: (w, c) => w.u16(c.importOf(path, className)),
  }),
  /** A structure: a bag of its own. Members set to undefined are left out, as defaults are. */
  struct: (type: string, members: Record<string, Cr2wTestValue | undefined>): Cr2wTestValue => ({
    type,
    write: (w, c) => {
      writeBag(w, c, members);
    },
  }),
  /** A `Vector`; members that are 0 are left out, as the game leaves defaults out. */
  vector: (v: { x: number; y: number; z?: number; w?: number }) =>
    cr2w.struct('Vector', {
      X: v.x === 0 ? undefined : cr2w.float(v.x),
      Y: v.y === 0 ? undefined : cr2w.float(v.y),
      Z: (v.z ?? 0) === 0 ? undefined : cr2w.float(v.z ?? 0),
      W: cr2w.float(v.w ?? 1),
    }),
  array: (elementType: string, items: Cr2wTestValue[]): Cr2wTestValue => ({
    type: `array:2,0,${elementType}`,
    write: (w, c) => {
      w.u32(items.length);
      for (const item of items) item.write(w, c);
    },
  }),
};

export interface Cr2wTestExport {
  className: string;
  /** 1-based index of the parent export; 0 for none. */
  parent?: number;
  properties: Record<string, Cr2wTestValue | undefined>;
}

export interface Cr2wTestFile {
  /** Default 163. */
  version?: number;
  exports: Cr2wTestExport[];
}

/** Writes a CR2W file. */
export function writeCr2w(options: Cr2wTestFile): Uint8Array {
  const strings = new ByteWriter();
  const stringOffsets = new Map<string, number>();
  const stringAt = (text: string) => {
    let at = stringOffsets.get(text);
    if (at === undefined) {
      at = strings.length;
      strings.text(text).u8(0);
      stringOffsets.set(text, at);
    }
    return at;
  };
  // Name 0 is the empty name, which ends a property bag.
  const names: string[] = [''];
  const nameIndex = new Map<string, number>([['', 0]]);
  const imports: { path: string; className: string }[] = [];
  const context: Cr2wWriteContext = {
    name(name) {
      let at = nameIndex.get(name);
      if (at === undefined) {
        at = names.length;
        names.push(name);
        nameIndex.set(name, at);
      }
      return at;
    },
    importOf(path, className) {
      const at = imports.findIndex((i) => i.path === path && i.className === className);
      if (at >= 0) return at + 1;
      imports.push({ path, className });
      return imports.length;
    },
  };
  const datas = options.exports.map((item) => {
    const writer = new ByteWriter();
    writeBag(writer, context, item.properties);
    return { className: context.name(item.className), parent: item.parent ?? 0, writer };
  });
  for (const i of imports) context.name(i.className);
  for (const name of names) stringAt(name);
  for (const i of imports) stringAt(i.path);

  const tablesAt = 0x28;
  const stringsAt = tablesAt + 10 * 12;
  const namesAt = stringsAt + strings.length;
  const importsAt = namesAt + names.length * 8;
  const exportsAt = importsAt + imports.length * 8;
  const dataAt = exportsAt + datas.length * 24;
  const size = dataAt + datas.reduce((sum, d) => sum + d.writer.length, 0);

  const out = new ByteWriter();
  out
    .text('CR2W')
    .u32(options.version ?? 163)
    .u32(0);
  out.u32(0).u32(0); // timestamp
  out.u32(0).u32(size).u32(size).u32(0).u32(0);
  const table = (offset: number, count: number) => out.u32(offset).u32(count).u32(0);
  table(stringsAt, strings.length);
  table(namesAt, names.length);
  table(importsAt, imports.length);
  table(0, 0); // properties
  table(exportsAt, datas.length);
  for (let i = 5; i < 10; i++) table(0, 0);
  out.bytes(strings.toBytes());
  for (const name of names) out.u32(stringAt(name)).u32(0);
  for (const i of imports) out.u32(stringAt(i.path)).u16(context.name(i.className)).u16(0);
  let at = dataAt;
  for (const data of datas) {
    out.u16(data.className).u16(0).u32(data.parent).u32(data.writer.length).u32(at).u32(0).u32(0);
    at += data.writer.length;
  }
  for (const data of datas) out.bytes(data.writer.toBytes());
  return out.toBytes();
}

// ---------------------------------------------------------------------------
// The Witcher 3's map pin resources

export interface TestEntityMapPin {
  name?: string;
  tags?: string[];
  type?: string;
  x: number;
  y: number;
  z?: number;
  radius?: number;
  /** Leave the position out entirely. */
  noPosition?: boolean;
}

/** A `.w2em`: a `CEntityMapPinsResource` with these pins. Defaults are left out. */
export function entityMapPinsFile(
  pins: readonly TestEntityMapPin[],
  options: { version?: number } = {},
): Uint8Array {
  const info = pins.map((pin) =>
    cr2w.struct('SEntityMapPinInfo', {
      entityName: pin.name ? cr2w.cname(pin.name) : undefined,
      entityCustomNameId: cr2w.u32(0),
      entityTags: cr2w.tags(pin.tags ?? (pin.name ? [pin.name] : [])),
      entityPosition: pin.noPosition ? undefined : cr2w.vector(pin),
      entityRadius: pin.radius ? cr2w.float(pin.radius) : undefined,
      entityType: pin.type ? cr2w.cname(pin.type) : undefined,
      alternateVersion: cr2w.i32(0),
      fastTravelSpotName: pin.type === 'RoadSign' && pin.name ? cr2w.cname(pin.name) : undefined,
    }),
  );
  return writeCr2w({
    ...options,
    exports: [
      {
        className: 'CEntityMapPinsResource',
        properties: { mappinsInfo: cr2w.array('SEntityMapPinInfo', info) },
      },
    ],
  });
}

/** `game\world.w2am`: a `CAreaMapPinsResource` listing these world paths. */
export function areaMapPinsFile(worldPaths: readonly string[]): Uint8Array {
  const info = worldPaths.map((worldPath, i) =>
    cr2w.struct('SAreaMapPinInfo', {
      areaType: cr2w.i32(i),
      position: cr2w.vector({ x: 10 * i, y: 5 * i }),
      worldPath: cr2w.string(worldPath),
    }),
  );
  return writeCr2w({
    exports: [
      {
        className: 'CAreaMapPinsResource',
        properties: { mappinsInfo: cr2w.array('SAreaMapPinInfo', info) },
      },
    ],
  });
}

/** A DLC's `.reddlc` with a map pin mounter for each world it adds pins to. */
export function mappinsDlcFile(
  mounters: readonly { world: string; pins: string; questPins?: string }[],
): Uint8Array {
  return writeCr2w({
    exports: [
      {
        className: 'CDLCDefinition',
        properties: { id: cr2w.cname('test_dlc'), localizedNameKey: cr2w.string('test') },
      },
      ...mounters.map((m) => ({
        className: 'CR4MappinsDLCMounter',
        parent: 1,
        properties: {
          worldFilePath: cr2w.soft('CWorld', m.world),
          mappinsFilePath: cr2w.soft('CEntityMapPinsResource', m.pins),
          questMappinsFilePath: m.questPins
            ? cr2w.soft('CQuestMapPinsResource', m.questPins)
            : undefined,
        },
      })),
    ],
  });
}
