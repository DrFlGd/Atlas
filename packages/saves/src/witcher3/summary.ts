import type {
  SaveAgentPin,
  SaveMapState,
  SavePin,
  SavePlayer,
  SaveQuestPin,
  SaveWorld,
} from '../summary';
import { readFacts } from './facts';
import { worldIdOf, worldName } from './tuning';
import {
  childNamed,
  childrenNamed,
  streamBytes,
  topBlock,
  valueBytes,
  walk,
  type SaveNode,
  type SaveTree,
} from './tree';
import { isRecord, memberNumber, readValue, vectorOf, type SaveValue } from './values';

/**
 * The parts of a Witcher 3 save that Atlas uses, read from the variable
 * tree. Where each lives (checked on real saves of patch 4.04, save
 * version 64, and patch 5.01, save version 67):
 *
 * - current world: `worldInfo` > `world` (String), the world's file path;
 * - player: `universe` > `Player` > `position` (Vector, world metres,
 *   z up) and `rotation` (EulerAngles; the yaw is the facing in degrees);
 * - worlds with data: `universe` > `world` > `name`;
 * - facts: the `SS` stream in `facts`;
 * - the map: `CCommonMapManager`, a block of lists. Each list is a block
 *   that starts with `VL Size : Uint32` and then holds its entries:
 *   `KnownMapPinTags`, `DiscoveredMapPinTags`, `DisabledMapPinTags` (map
 *   pins by tag alone, with no position), `QuestMapPinStates`,
 *   `DiscoveredAgentEntityTags`, `DiscoveredPaths`, `CustomEntityMapPins`,
 *   `CustomAgentMapPins`, `UserMapPin` (`UserMapPinsCount`),
 *   `CachedWorldDataMap` (per world: `CachedWorldDataPath`,
 *   `CachedWorldVisited`, then `CachedQuestMapPinsMap`,
 *   `CachedShopkeeperDataMap`, `CachedBoatDataArray`),
 *   `MapPinFilterHiddenList` and `MapBorderData`. Entries are variables
 *   after the `Size`, one per field: a `QuestMapPinStates` entry is
 *   `ObjectiveGuid`, `MapPinGuid` (CGUID) and `MapPinState` (Bool); a
 *   `CustomAgentMapPins` entry is `CustomAgentMapPinTag`,
 *   `CustomAgentMapPinType` (CName) and `CustomAgentMapPinShowAlways`
 *   (Bool); a `CachedBoatDataArray` entry is `CachedBoatDataPosition`
 *   (Vector) (seen in a 5.01 save). The tag lists were empty in every save
 *   checked, so their entries' layout is NOT KNOWN yet: an entry is read as
 *   one `VL` with a name (most likely `VL KnownMapPinTag : CName`), a block
 *   holding one, or one array value.
 */

/** The value of a `VL`/`OP` node, or undefined when it has none that can be read. */
export function nodeValue(tree: SaveTree, node: SaveNode | undefined): SaveValue | undefined {
  if (!node || (node.kind !== 'VL' && node.kind !== 'OP')) return undefined;
  return readValue(node.type, valueBytes(tree.payload.data, node), tree.payload.names);
}

const isWorldPath = (value: SaveValue | undefined): value is string =>
  typeof value === 'string' && /\.w2w$/i.test(value);

function worldOf(path: string): SaveWorld | null {
  const id = worldIdOf(path);
  return id ? { id, path, name: worldName(id) } : null;
}

export function readWorld(tree: SaveTree): SaveWorld | null {
  const path = nodeValue(tree, childNamed(topBlock(tree, 'worldInfo'), 'world'));
  if (isWorldPath(path)) return worldOf(path);
  // Older layouts might only name the loading screen: map_location_<world>.
  const screen = nodeValue(
    tree,
    childNamed(topBlock(tree, 'AdditionalSaveInfo'), 'LoadingScreenName'),
  );
  if (typeof screen === 'string' && screen.startsWith('map_location_')) {
    const id = screen.slice('map_location_'.length);
    return { id, path: '', name: worldName(id) };
  }
  return null;
}

export function readWorlds(
  tree: SaveTree,
  current: SaveWorld | null,
  visited: readonly string[] = [],
): SaveWorld[] {
  const found = new Map<string, SaveWorld>();
  const add = (value: SaveValue | undefined) => {
    if (!isWorldPath(value)) return;
    const world = worldOf(value);
    if (world && !found.has(world.id)) found.set(world.id, world);
  };
  if (current) found.set(current.id, current);
  for (const world of childrenNamed(topBlock(tree, 'universe'), 'world')) {
    add(nodeValue(tree, childNamed(world, 'name')));
  }
  // Worlds the map marks visited, by their path in the map.
  const visitedIds = new Set(visited);
  walk(topBlock(tree, 'CCommonMapManager')?.children ?? [], (node) => {
    if (node.kind !== 'VL' || node.name !== 'CachedWorldDataPath') return;
    const path = nodeValue(tree, node);
    if (isWorldPath(path) && visitedIds.has(worldIdOf(path) ?? '')) add(path);
  });
  return [...found.values()];
}

export function readPlayer(tree: SaveTree, world: SaveWorld | null): SavePlayer | null {
  const player = childNamed(topBlock(tree, 'universe'), 'Player');
  const position = vectorOf(nodeValue(tree, childNamed(player, 'position')));
  if (!position) return null;
  const rotation = nodeValue(tree, childNamed(player, 'rotation'));
  const yaw = isRecord(rotation) ? memberNumber(rotation, 'Yaw') : null;
  return {
    world: world?.id ?? null,
    position,
    yaw: yaw !== null && Number.isFinite(yaw) ? yaw : null,
  };
}

export function readFactsOf(tree: SaveTree, notes: string[]): Record<string, number> {
  const block = topBlock(tree, 'facts');
  const stream = block?.children.find((child) => child.kind === 'SS');
  if (!stream) {
    notes.push('The save has no facts block, so quest progress cannot be read from it.');
    return {};
  }
  try {
    const result = readFacts(streamBytes(tree.payload.data, stream));
    if (result.read < result.declared) {
      notes.push(
        `Read ${result.read} of ${result.declared} facts; the rest has a layout Atlas does not know.`,
      );
    }
    return result.facts;
  } catch {
    notes.push('The facts block has a layout Atlas does not know.');
    return {};
  }
}

// ---------------------------------------------------------------------------
// The map

/** The lists of map pins by tag, and the state each sets. */
const TAG_LISTS = [
  { list: 'KnownMapPinTags', state: 'known', label: 'known map pins' },
  { list: 'DiscoveredMapPinTags', state: 'discovered', label: 'discovered map pins' },
  { list: 'DisabledMapPinTags', state: 'cleared', label: 'disabled map pins' },
] as const;

/** Names of a list's length, before its entries. */
const isLengthName = (name: string | null) => name === 'Size' || (name ?? '').endsWith('Count');

/** World paths that are not a world: the map lists a `dummy.w2w`. */
const isRealWorld = (id: string | null): id is string => id !== null && id !== 'dummy';

interface TagList {
  /** The length the list declares; null when it declares none. */
  declared: number | null;
  tags: string[];
  /** Entries Atlas could not read a tag from. */
  unread: number;
}

/** The text of a value that names something: a CName or a string. */
const nameIn = (value: SaveValue | undefined): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * Reads a list of tags, tolerant of the layouts its entries might have:
 * a block whose `Size` is followed by one variable per entry (or one block
 * per entry), or a single variable holding an array.
 */
function readTagList(tree: SaveTree, node: SaveNode): TagList {
  const value = (child: SaveNode) => nodeValue(tree, child);
  if (node.kind === 'VL' || node.kind === 'OP') {
    const items = value(node);
    if (!Array.isArray(items)) return { declared: null, tags: [], unread: 1 };
    const tags = items.map(nameIn).filter((tag) => tag !== null);
    return { declared: items.length, tags, unread: items.length - tags.length };
  }
  const result: TagList = { declared: null, tags: [], unread: 0 };
  for (const child of node.children) {
    if ((child.kind === 'VL' || child.kind === 'OP') && isLengthName(child.name)) {
      const size = value(child);
      if (result.declared === null && typeof size === 'number') {
        result.declared = size;
        continue;
      }
    }
    if (child.kind === 'VL' || child.kind === 'OP') {
      const entry = value(child);
      if (Array.isArray(entry)) {
        for (const item of entry) {
          const tag = nameIn(item);
          if (tag) result.tags.push(tag);
          else result.unread++;
        }
        continue;
      }
      const tag = nameIn(entry);
      if (tag) result.tags.push(tag);
      else result.unread++;
    } else if (child.kind === 'BS') {
      // One block per entry: its first name is the tag.
      const named = child.children.find(
        (part) => (part.kind === 'VL' || part.kind === 'OP') && nameIn(value(part)) !== null,
      );
      const tag = named ? nameIn(value(named)) : null;
      if (tag) result.tags.push(tag);
      else result.unread++;
    } else {
      result.unread++;
    }
  }
  return result;
}

interface RecordList {
  declared: number | null;
  records: Record<string, SaveValue>[];
}

/**
 * Reads a list of records: after its `Size`, one variable per field, a new
 * record starting where a field name comes again (as `QuestMapPinStates`
 * and `CustomAgentMapPins` are laid out), or one block per record.
 */
function readRecordList(tree: SaveTree, node: SaveNode): RecordList {
  const result: RecordList = { declared: null, records: [] };
  let current: Record<string, SaveValue> = {};
  const finish = () => {
    if (Object.keys(current).length > 0) result.records.push(current);
    current = {};
  };
  for (const child of node.children) {
    if (child.kind === 'BS') {
      finish();
      for (const part of child.children) {
        const value = part.name === null ? undefined : nodeValue(tree, part);
        if (value !== undefined) current[part.name!] = value;
      }
      finish();
      continue;
    }
    if ((child.kind !== 'VL' && child.kind !== 'OP') || child.name === null) continue;
    const value = nodeValue(tree, child);
    if (result.declared === null && isLengthName(child.name) && typeof value === 'number') {
      result.declared = value;
      continue;
    }
    if (value === undefined) continue;
    if (Object.hasOwn(current, child.name)) finish();
    current[child.name] = value;
  }
  finish();
  return result;
}

/** The records of a list of the map, with a note when some could not be read. */
function recordsOf(
  tree: SaveTree,
  manager: SaveNode,
  list: string,
  label: string,
  notes: string[],
): Record<string, SaveValue>[] {
  const node = childNamed(manager, list);
  if (node?.kind !== 'BS') return [];
  const { declared, records } = readRecordList(tree, node);
  if (declared !== null && declared > records.length) {
    notes.push(
      `Read ${records.length} of ${declared} ${label}; the rest has a layout Atlas does not know.`,
    );
  }
  return records;
}

function readQuestPins(tree: SaveTree, manager: SaveNode, notes: string[]): SaveQuestPin[] {
  const pins: SaveQuestPin[] = [];
  for (const record of recordsOf(tree, manager, 'QuestMapPinStates', 'quest map pins', notes)) {
    const objective = record.ObjectiveGuid;
    const pin = record.MapPinGuid;
    if (typeof objective !== 'string' || typeof pin !== 'string') continue;
    pins.push({ objective, pin, shown: record.MapPinState === true });
  }
  return pins;
}

function readAgentPins(tree: SaveTree, manager: SaveNode, notes: string[]): SaveAgentPin[] {
  const pins: SaveAgentPin[] = [];
  for (const record of recordsOf(tree, manager, 'CustomAgentMapPins', 'pins on people', notes)) {
    const tag = nameIn(record.CustomAgentMapPinTag);
    if (!tag) continue;
    const showAlways = record.CustomAgentMapPinShowAlways;
    pins.push({
      tag,
      type: nameIn(record.CustomAgentMapPinType),
      showAlways: typeof showAlways === 'boolean' ? showAlways : null,
    });
  }
  return pins;
}

/** Every list's declared length in the map manager, added up by name. */
function listLengths(tree: SaveTree, manager: SaveNode): Record<string, number> {
  const lengths: Record<string, number> = {};
  walk(manager.children, (node) => {
    if (node.kind !== 'BS' || node.name === null) return;
    const first = node.children[0];
    if (!first || (first.kind !== 'VL' && first.kind !== 'OP') || !isLengthName(first.name)) return;
    const size = nodeValue(tree, first);
    if (typeof size === 'number') lengths[node.name] = (lengths[node.name] ?? 0) + size;
  });
  return lengths;
}

/** World ids the map marks visited: each `CachedWorldVisited` after its world's path. */
function visitedWorlds(tree: SaveTree, manager: SaveNode): string[] {
  const visited = new Set<string>();
  let world: string | null = null;
  walk(manager.children, (node) => {
    if (node.kind !== 'VL' && node.kind !== 'OP') return;
    if (node.name === 'CachedWorldDataPath') {
      const path = nodeValue(tree, node);
      world = isWorldPath(path) ? worldIdOf(path) : null;
    } else if (node.name === 'CachedWorldVisited' && nodeValue(tree, node) === true) {
      if (isRealWorld(world)) visited.add(world);
    }
  });
  return [...visited];
}

/** The save's map: its pins by tag, with their state, and what it holds in counts. */
export function readMap(
  tree: SaveTree,
  notes: string[],
): { map: SaveMapState | null; pins: SavePin[] } {
  const manager = topBlock(tree, 'CCommonMapManager');
  if (!manager) {
    notes.push('The save has no map manager, so its map cannot be read.');
    return { map: null, pins: [] };
  }
  const pins = new Map<string, SavePin>();
  const counts = { known: 0, discovered: 0, cleared: 0 };
  let lists = 0;
  for (const { list, state, label } of TAG_LISTS) {
    const node = childNamed(manager, list);
    if (!node) continue;
    lists++;
    const read = readTagList(tree, node);
    const unique = new Set(read.tags);
    counts[state] = Math.max(unique.size, read.declared ?? 0);
    if (read.unread > 0 || (read.declared !== null && read.declared > read.tags.length)) {
      const total = Math.max(read.declared ?? 0, read.tags.length + read.unread);
      notes.push(
        `Read ${read.tags.length} of ${total} ${label}; the rest has a layout Atlas does not know.`,
      );
    }
    for (const tag of unique) {
      let pin = pins.get(tag);
      if (!pin) {
        pin = { id: tag, world: null, type: null, kind: null, position: null };
        pins.set(tag, pin);
      }
      pin[state] = true;
    }
  }
  if (lists === 0) {
    notes.push('The save’s map has a layout Atlas does not know, so its map pins cannot be read.');
    return { map: null, pins: [] };
  }
  return {
    map: {
      known: counts.known,
      discovered: counts.discovered,
      disabled: counts.cleared,
      visited: visitedWorlds(tree, manager),
      questPins: readQuestPins(tree, manager, notes),
      agentPins: readAgentPins(tree, manager, notes),
      lists: listLengths(tree, manager),
    },
    pins: [...pins.values()],
  };
}
