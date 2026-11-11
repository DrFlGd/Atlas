import {
  exportsOf,
  isCr2w,
  readCr2w,
  type Cr2wFile,
  type Cr2wRecord,
  type Cr2wValue,
} from '../gamefiles/cr2w';
import type { GamePinTable, GameTablePin } from '../gamefiles/table';
import { WITCHER3_WORLDS, worldIdOf } from './tuning';

/**
 * The Witcher 3's own map pins, from its files: the resources the desktop
 * app unpacks from the game's bundles (read-only, from the folder the
 * person chose). What each holds, from the game's scripts and public
 * references:
 *
 * - `game\hub_pins\<world>.w2em`: a `CEntityMapPinsResource` per world,
 *   `mappinsInfo : array<SEntityMapPinInfo>`, each with `entityName`
 *   (CName), `entityTags` (TagList), `entityPosition` (Vector),
 *   `entityRadius` (Float) and `entityType` (CName), among others;
 * - `game\world.w2am`: a `CAreaMapPinsResource`, one entry per world with
 *   its `worldPath`;
 * - a DLC's `.reddlc`: a `CR4MappinsDLCMounter` per world it adds pins to,
 *   with `worldFilePath` and `mappinsFilePath` (soft handles, so import
 *   paths).
 *
 * Fields left at their default value are not written, so every field is
 * optional here.
 */

export interface EntityMapPin {
  /** `entityName`, else the first tag; empty when it has neither. */
  name: string;
  tags: string[];
  /** `entityType`; empty when the file does not say. */
  type: string;
  /** Null when the file gives no position. */
  position: { x: number; y: number; z: number } | null;
  radius: number;
}

export interface MappinsMounter {
  /** The world's path, such as `dlc\bob\data\levels\bob\bob.w2w`. */
  world: string;
  /** The `.w2em` path of the pins it adds. */
  pins: string;
}

const text = (value: Cr2wValue | undefined): string => (typeof value === 'string' ? value : '');

const number = (value: Cr2wValue | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const isRecord = (value: Cr2wValue | undefined): value is Cr2wRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The array of records a resource lists its pins in: the property of that
 * name when it has one (without case), else its first array of records.
 */
function pinRecords(resource: Cr2wRecord, name: string): Cr2wRecord[] {
  const wanted = name.toLowerCase();
  const named = Object.entries(resource).find(([key]) => key.toLowerCase() === wanted)?.[1];
  const list = Array.isArray(named)
    ? named
    : Object.values(resource).find(
        (value): value is Cr2wValue[] => Array.isArray(value) && value.some(isRecord),
      );
  return (list ?? []).filter(isRecord);
}

/** A `Vector` as x, y, z; members left out are 0 (their default). Null for anything else. */
function vector(value: Cr2wValue | undefined): { x: number; y: number; z: number } | null {
  if (!isRecord(value)) return null;
  return { x: number(value.X) ?? 0, y: number(value.Y) ?? 0, z: number(value.Z) ?? 0 };
}

/** The pins of a `.w2em` file. */
export function entityMapPinsOf(file: Cr2wFile): EntityMapPin[] {
  const pins: EntityMapPin[] = [];
  for (const resource of exportsOf(file, 'CEntityMapPinsResource')) {
    for (const record of pinRecords(resource, 'mappinsInfo')) {
      const tags = Array.isArray(record.entityTags)
        ? record.entityTags.filter((tag): tag is string => typeof tag === 'string' && tag !== '')
        : [];
      pins.push({
        name: text(record.entityName) || (tags[0] ?? ''),
        tags,
        type: text(record.entityType),
        position: vector(record.entityPosition),
        radius: number(record.entityRadius) ?? 0,
      });
    }
  }
  return pins;
}

/** The world paths `game\world.w2am` lists. */
export function areaWorldsOf(file: Cr2wFile): string[] {
  const worlds: string[] = [];
  for (const resource of exportsOf(file, 'CAreaMapPinsResource')) {
    for (const record of pinRecords(resource, 'mappinsInfo')) {
      const path = text(record.worldPath);
      if (path) worlds.push(path);
    }
  }
  return worlds;
}

/** The map pin mounters of a DLC's `.reddlc`. */
export function mappinsMountersOf(file: Cr2wFile): MappinsMounter[] {
  const mounters: MappinsMounter[] = [];
  for (const record of exportsOf(file, 'CR4MappinsDLCMounter')) {
    const world = text(record.worldFilePath);
    const pins = text(record.mappinsFilePath);
    if (world && pins) mounters.push({ world, pins });
  }
  return mounters;
}

// ---------------------------------------------------------------------------
// The table

/** A file the desktop app unpacked: its path in the game, and its bytes. */
export interface GameFileInput {
  path: string;
  bytes: Uint8Array;
}

/** How building a table went, in counts only: nothing names a pin or says where one is. */
export interface PinTableStats {
  /** Files given. */
  files: number;
  /** Files read as CR2W. */
  parsed: number;
  /** Files that are not CR2W, or that could not be read. */
  failed: number;
  /** Files by CR2W version. */
  versions: Record<string, number>;
  /** `.w2em` files read, and how many of them gave pins. */
  pinFiles: number;
  pinFilesWithPins: number;
  /** Worlds `world.w2am` lists. */
  areaWorlds: number;
  /** DLC mounters of map pins found. */
  mounters: number;
  /** Pins by world, and by type in each world. */
  worlds: Record<string, { pins: number; types: Record<string, number> }>;
  /** Pins in files that no world could be found for. */
  unassigned: number;
  /** Pins with no position. */
  withoutPosition: number;
  /** Pins whose name came again in the same world (the later file wins). */
  duplicates: number;
}

export interface BuildPinTableInput {
  files: readonly GameFileInput[];
  stamp: string;
  now?: number;
}

/** Game paths are compared lowercase, with backslashes. */
const normalise = (path: string) => path.toLowerCase().replace(/\//g, '\\');

const extension = (path: string) => /\.([a-z0-9]+)$/.exec(normalise(path))?.[1] ?? '';

/** The file name without its folder and extension. */
const baseName = (path: string) =>
  normalise(path)
    .split('\\')
    .pop()!
    .replace(/\.[^.]*$/, '');

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Builds the map pin table from the files the desktop app unpacked. A pin
 * file's world is the one a DLC mounter names for it, else the world its
 * name is (`game\hub_pins\novigrad.w2em` is `novigrad`), when that is a
 * world `world.w2am`, a mounter or Atlas knows. Files are taken in the
 * order given; a later pin of the same name in a world replaces an
 * earlier one.
 */
export function buildPinTable(input: BuildPinTableInput): {
  table: GamePinTable;
  stats: PinTableStats;
} {
  const stats: PinTableStats = {
    files: input.files.length,
    parsed: 0,
    failed: 0,
    versions: {},
    pinFiles: 0,
    pinFilesWithPins: 0,
    areaWorlds: 0,
    mounters: 0,
    worlds: {},
    unassigned: 0,
    withoutPosition: 0,
    duplicates: 0,
  };
  const parsed: { path: string; file: Cr2wFile }[] = [];
  for (const { path, bytes } of input.files) {
    if (!isCr2w(bytes)) {
      stats.failed++;
      continue;
    }
    try {
      const file = readCr2w(bytes);
      stats.parsed++;
      stats.versions[file.version] = (stats.versions[file.version] ?? 0) + 1;
      parsed.push({ path, file });
    } catch {
      stats.failed++;
    }
  }

  const knownWorlds = new Set<string>(WITCHER3_WORLDS.map((world) => world.id));
  const mounted = new Map<string, string>();
  for (const { path, file } of parsed) {
    const ext = extension(path);
    if (ext === 'w2am') {
      for (const world of areaWorldsOf(file)) {
        const id = worldIdOf(world);
        if (id) knownWorlds.add(id);
        stats.areaWorlds++;
      }
    } else if (ext === 'reddlc') {
      for (const mounter of mappinsMountersOf(file)) {
        const id = worldIdOf(mounter.world);
        if (!id) continue;
        stats.mounters++;
        mounted.set(normalise(mounter.pins), id);
        knownWorlds.add(id);
      }
    }
  }

  const worlds = new Map<string, Map<string, GameTablePin>>();
  const unnamed = new Map<string, GameTablePin[]>();
  for (const { path, file } of parsed) {
    if (extension(path) !== 'w2em') continue;
    stats.pinFiles++;
    const pins = entityMapPinsOf(file);
    if (pins.length > 0) stats.pinFilesWithPins++;
    const name = baseName(path);
    const world = mounted.get(normalise(path)) ?? (knownWorlds.has(name) ? name : null);
    if (!world) {
      stats.unassigned += pins.length;
      continue;
    }
    let byName = worlds.get(world);
    if (!byName) {
      byName = new Map();
      worlds.set(world, byName);
    }
    for (const pin of pins) {
      if (!pin.position) {
        stats.withoutPosition++;
        continue;
      }
      const entry: GameTablePin = {
        name: pin.name,
        type: pin.type,
        x: round(pin.position.x),
        y: round(pin.position.y),
        z: round(pin.position.z),
        radius: round(pin.radius),
      };
      if (pin.tags.length > 0 && !(pin.tags.length === 1 && pin.tags[0] === pin.name)) {
        entry.tags = pin.tags;
      }
      if (!pin.name) {
        const list = unnamed.get(world) ?? [];
        list.push(entry);
        unnamed.set(world, list);
        continue;
      }
      if (byName.has(pin.name)) {
        stats.duplicates++;
        byName.delete(pin.name);
      }
      byName.set(pin.name, entry);
    }
  }

  const table: GamePinTable = {
    format: 1,
    game: 'witcher3',
    stamp: input.stamp,
    builtAt: input.now ?? Date.now(),
    worlds: {},
  };
  for (const [world, byName] of worlds) {
    const pins = [...byName.values(), ...(unnamed.get(world) ?? [])];
    if (pins.length === 0) continue;
    table.worlds[world] = pins;
    const types: Record<string, number> = {};
    for (const pin of pins) {
      const type = pin.type || '(none)';
      types[type] = (types[type] ?? 0) + 1;
    }
    stats.worlds[world] = { pins: pins.length, types };
  }
  return { table, stats };
}
