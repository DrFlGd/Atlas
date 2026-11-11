import type { SavePin, SavePlayer, SaveWorld } from '../summary';
import { readFacts } from './facts';
import { pinKindOf, worldIdOf, worldName } from './tuning';
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
 * tree. Where each lives (save version 67; the same in 64):
 *
 * - current world: `worldInfo` > `world` (String), the world's file path;
 * - player: `universe` > `Player` > `position` (Vector, world metres,
 *   z up) and `rotation` (EulerAngles; the yaw is the facing in degrees);
 * - worlds with data: `universe` > `world` > `name`, and the map
 *   manager's `CachedWorldDataPath` values;
 * - facts: the `SS` stream in `facts`;
 * - map pins: somewhere in `CCommonMapManager`. Its layout is NOT KNOWN
 *   yet, so pins are found by shape: any block (or decoded structure) with
 *   a vector member is a pin, named and typed by its other members, in the
 *   world named by the nearest world path before it. Lists of names under
 *   a name with "discovered", "known" or "disabled" set those states.
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

export function readWorlds(tree: SaveTree, current: SaveWorld | null): SaveWorld[] {
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
  walk(topBlock(tree, 'CCommonMapManager')?.children ?? [], (node) => {
    if (node.kind === 'VL' && node.type === 'String') add(nodeValue(tree, node));
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
// Map pins

/** Names that say the opposite of a state: `undiscovered`, `unknownPins`, `notKnown`. */
const NEGATIVE = /undiscover|unknown|^not/;

const ID_FIELDS = ['entityname', 'name', 'id', 'tag', 'pintag', 'entity', 'tagname', 'mappintag'];

interface Candidate {
  fields: Map<string, SaveValue>;
  /** Where in the save, for a made-up id. */
  at: number;
  world: string | null;
}

export function readPins(tree: SaveTree, notes: string[]): SavePin[] {
  const manager = topBlock(tree, 'CCommonMapManager');
  if (!manager) {
    notes.push('The save has no map manager, so map pins cannot be read from it.');
    return [];
  }
  const candidates: Candidate[] = [];
  const states = {
    discovered: new Set<string>(),
    known: new Set<string>(),
    cleared: new Set<string>(),
  };
  const values = new Map<SaveNode, SaveValue | undefined>();
  const valueOf = (node: SaveNode) => {
    if (!values.has(node)) values.set(node, nodeValue(tree, node));
    return values.get(node);
  };
  /** The world named by the nearest world path before this branch. */
  const worldContext = (ancestors: readonly SaveNode[], node: SaveNode): string | null => {
    let child = node;
    for (let level = ancestors.length - 1; level >= 0; level--) {
      const parent = ancestors[level]!;
      for (let i = parent.children.indexOf(child) - 1; i >= 0; i--) {
        const sibling = parent.children[i]!;
        if (sibling.kind !== 'VL' && sibling.kind !== 'OP') continue;
        const value = valueOf(sibling);
        if (isWorldPath(value)) return worldIdOf(value);
      }
      child = parent;
    }
    return null;
  };

  walk(manager.children, (node, ancestors) => {
    if (node.kind === 'BS') {
      const fields = new Map<string, SaveValue>();
      for (const child of node.children) {
        if ((child.kind === 'VL' || child.kind === 'OP') && child.name !== null) {
          const value = valueOf(child);
          if (value !== undefined) fields.set(child.name.toLowerCase(), value);
        }
      }
      if ([...fields.values()].some((value) => vectorOf(value) !== null)) {
        const world = [...fields.values()].find(isWorldPath);
        candidates.push({
          fields,
          at: node.offset,
          world: world ? worldIdOf(world) : worldContext(ancestors, node),
        });
      }
      return;
    }
    if (node.kind !== 'VL' && node.kind !== 'OP') return;
    const value = valueOf(node);
    if (!Array.isArray(value)) return;
    const name = (node.name ?? '').toLowerCase();
    // Lists of pin names that are in a state.
    const state = NEGATIVE.test(name)
      ? null
      : name.includes('discover')
        ? states.discovered
        : name.includes('known')
          ? states.known
          : /disabled|cleared|completed/.test(name)
            ? states.cleared
            : null;
    if (state) {
      for (const item of value) if (typeof item === 'string' && item) state.add(item);
    }
    // Arrays of structures with a vector member.
    value.forEach((item, index) => {
      if (!isRecord(item) || !Object.values(item).some((v) => vectorOf(v) !== null)) return;
      const fields = new Map(Object.entries(item).map(([k, v]) => [k.toLowerCase(), v] as const));
      candidates.push({
        fields,
        at: node.offset * 1000 + index,
        world: worldContext(ancestors, node),
      });
    });
  });

  const pins = new Map<string, SavePin>();
  for (const candidate of candidates) {
    const pin = pinFrom(candidate);
    if (!pins.has(pin.id)) pins.set(pin.id, pin);
  }
  for (const [flag, names] of Object.entries(states) as [keyof typeof states, Set<string>][]) {
    for (const name of names) {
      let pin = pins.get(name);
      if (!pin) {
        pin = { id: name, world: null, type: null, kind: null, position: null };
        pins.set(name, pin);
      }
      pin[flag] = true;
    }
  }
  return [...pins.values()];
}

function pinFrom({ fields, at, world }: Candidate): SavePin {
  const text = (value: SaveValue | undefined) =>
    typeof value === 'string' && value ? value : null;
  const vectors = [...fields.entries()].filter(([, value]) => vectorOf(value) !== null);
  const position = vectorOf((vectors.find(([name]) => name.includes('pos')) ?? vectors[0])?.[1]);
  const type =
    text(
      [...fields.entries()].find(([name, value]) => name.includes('type') && text(value))?.[1],
    ) ?? null;
  const id =
    ID_FIELDS.map((name) => text(fields.get(name))).find((value) => value !== null) ?? `pin@${at}`;
  const tags = [...fields.entries()].find(
    ([name, value]) => name.includes('tags') && Array.isArray(value),
  )?.[1] as SaveValue[] | undefined;
  const flag = (pattern: RegExp) => {
    for (const [name, value] of fields) {
      if (pattern.test(name) && !NEGATIVE.test(name) && typeof value === 'boolean') return value;
    }
    return undefined;
  };
  const { kind, cleared: clearedType } = type ? pinKindOf(type) : { kind: null, cleared: false };
  const pin: SavePin = { id, world, type, kind, position };
  const discovered = flag(/discover/);
  const known = flag(/known/);
  const cleared = flag(/disabled|cleared|completed/);
  if (discovered !== undefined) pin.discovered = discovered;
  if (known !== undefined) pin.known = known;
  if (cleared !== undefined || clearedType) pin.cleared = clearedType || cleared === true;
  if (tags) pin.tags = tags.filter((tag): tag is string => typeof tag === 'string');
  return pin;
}
