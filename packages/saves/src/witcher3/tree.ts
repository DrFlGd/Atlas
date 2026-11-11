import { FormatError, hasTag } from '../binary';
import { nameAt, type Payload } from './payload';

/**
 * The variables of a save form a tree. Each entry of the variable table
 * spans some bytes, and an entry whose span lies inside another's is its
 * child. Top-level entries are the save's blocks (`facts`, `questSystem`,
 * `universe`, ...).
 *
 * | Tag    | Bytes                                                   |
 * | ------ | ------------------------------------------------------- |
 * | `BS`   | `"BS"` u16 name, then its children                      |
 * | `VL`   | `"VL"` u16 name, u16 type, the value                    |
 * | `OP`   | the same as `VL`                                        |
 * | `SS`   | `"SS"` u32 length, a stream of its own (facts, ...)     |
 * | `MANU` | the name table                                          |
 *
 * Children of a `VL`, `OP` or untagged entry point into the parent's value
 * (parts of a vector, a string in an array) and carry no tag: they are
 * `raw` here, and the value is read from the parent.
 */

export type NodeKind = 'BS' | 'VL' | 'OP' | 'SS' | 'MANU' | 'raw';

export interface SaveNode {
  kind: NodeKind;
  offset: number;
  size: number;
  /** Block or property name (`BS`, `VL`, `OP`). */
  name: string | null;
  /** Value type (`VL`, `OP`), such as `Uint32`, `CName` or `array:2,0,CName`. */
  type: string | null;
  children: SaveNode[];
}

export interface SaveTree {
  payload: Payload;
  /** Top-level nodes in file order. */
  top: SaveNode[];
  /** Number of variable table entries. */
  entries: number;
}

export function buildTree(payload: Payload): SaveTree {
  const { data, table, names } = payload;
  const count = table.length / 2;
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  // By offset, and the larger span first, so a parent comes before its children.
  order.sort((a, b) => table[2 * a]! - table[2 * b]! || table[2 * b + 1]! - table[2 * a + 1]!);

  const lowest = payload.start + 16;
  const highest = payload.tableOffset;
  const top: SaveNode[] = [];
  const stack: SaveNode[] = [];
  for (let i = 0; i < count; i++) {
    const index = order[i]!;
    const offset = table[2 * index]!;
    const size = table[2 * index + 1]!;
    if (offset < lowest || offset + size > highest) {
      throw new FormatError(`variable ${index} (${offset}+${size}) is outside the save data`);
    }
    while (stack.length > 0) {
      const parent = stack[stack.length - 1]!;
      if (offset >= parent.offset + parent.size) {
        stack.pop();
      } else if (offset + size > parent.offset + parent.size) {
        throw new FormatError(`variable ${index} overlaps another one`);
      } else {
        break;
      }
    }
    const parent = stack[stack.length - 1];
    const tagged = !parent || parent.kind === 'BS';
    const node = makeNode(data, names, offset, size, tagged);
    (parent ? parent.children : top).push(node);
    stack.push(node);
  }
  return { payload, top, entries: count };
}

function makeNode(
  data: Uint8Array,
  names: readonly string[],
  offset: number,
  size: number,
  tagged: boolean,
): SaveNode {
  const node: SaveNode = { kind: 'raw', offset, size, name: null, type: null, children: [] };
  if (!tagged) return node;
  const u16 = (at: number) => data[at]! | (data[at + 1]! << 8);
  if (size >= 4 && hasTag(data, offset, 'MANU')) {
    node.kind = 'MANU';
  } else if (size >= 4 && hasTag(data, offset, 'BS')) {
    node.kind = 'BS';
    node.name = nameAt(names, u16(offset + 2));
  } else if (size >= 6 && (hasTag(data, offset, 'VL') || hasTag(data, offset, 'OP'))) {
    node.kind = hasTag(data, offset, 'VL') ? 'VL' : 'OP';
    node.name = nameAt(names, u16(offset + 2));
    node.type = nameAt(names, u16(offset + 4));
  } else if (size >= 6 && hasTag(data, offset, 'SS')) {
    node.kind = 'SS';
  }
  return node;
}

/** The bytes of a `VL` or `OP` node's value. */
export function valueBytes(data: Uint8Array, node: SaveNode): Uint8Array {
  return data.subarray(node.offset + 6, node.offset + node.size);
}

/** The body of an `SS` node (after its tag and length). */
export function streamBytes(data: Uint8Array, node: SaveNode): Uint8Array {
  return data.subarray(node.offset + 6, node.offset + node.size);
}

const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

/** The first child with a name, compared without case. */
export function childNamed(node: SaveNode | undefined, name: string): SaveNode | undefined {
  return node?.children.find((child) => same(child.name, name));
}

/** Every child with a name, compared without case. */
export function childrenNamed(node: SaveNode | undefined, name: string): SaveNode[] {
  return node ? node.children.filter((child) => same(child.name, name)) : [];
}

/** The first top-level block with a name. */
export function topBlock(tree: SaveTree, name: string): SaveNode | undefined {
  return tree.top.find((node) => node.kind === 'BS' && same(node.name, name));
}

/** Visits every node below `nodes`, depth first, with its path of ancestors. */
export function walk(
  nodes: readonly SaveNode[],
  visit: (node: SaveNode, ancestors: readonly SaveNode[]) => void,
  ancestors: SaveNode[] = [],
): void {
  for (const node of nodes) {
    visit(node, ancestors);
    if (node.children.length > 0) {
      ancestors.push(node);
      walk(node.children, visit, ancestors);
      ancestors.pop();
    }
  }
}
