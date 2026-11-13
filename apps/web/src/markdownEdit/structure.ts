import type { Align, ListItemModel, ListModel, TableModel } from './blocks';
import type { Inline } from './inline';

/**
 * What the list and table tools do to a block's model: an item's place in
 * a list is the indexes of the items down to it (`[1, 0]`: the first item
 * inside the second); a cell's is its row (0 the header) and column.
 */

export type ItemPath = readonly number[];

function copyList(list: ListModel): ListModel {
  return { ...list, items: list.items.map((item) => ({ ...item })) };
}

/** The list an item is in, and its index there, in a copy of the list made to change. */
function within(root: ListModel, path: ItemPath): { list: ListModel; index: number } | null {
  let list = root;
  for (let depth = 0; depth < path.length - 1; depth++) {
    const item = list.items[path[depth]!];
    if (!item?.children) return null;
    item.children = copyList(item.children);
    list = item.children;
  }
  const index = path.at(-1)!;
  return index < list.items.length ? { list, index } : null;
}

export function itemAt(list: ListModel, path: ItemPath): ListItemModel | null {
  let items = list.items;
  let item: ListItemModel | undefined;
  for (const index of path) {
    item = items[index];
    if (!item) return null;
    items = item.children?.items ?? [];
  }
  return item ?? null;
}

export function setItemContent(list: ListModel, path: ItemPath, content: Inline[]): ListModel {
  const root = copyList(list);
  const found = within(root, path);
  if (!found) return list;
  found.list.items[found.index] = { ...found.list.items[found.index]!, content };
  return root;
}

/** An item split at Enter: the text after the place goes to a new item after it. */
export function splitItem(
  list: ListModel,
  path: ItemPath,
  before: Inline[],
  after: Inline[],
): { list: ListModel; path: number[] } {
  const root = copyList(list);
  const found = within(root, path);
  if (!found) return { list, path: [...path] };
  const item = found.list.items[found.index]!;
  found.list.items.splice(
    found.index,
    1,
    { content: before, children: null },
    { content: after, children: item.children },
  );
  return { list: root, path: [...path.slice(0, -1), found.index + 1] };
}

export function removeItem(list: ListModel, path: ItemPath): ListModel {
  const root = copyList(list);
  const found = within(root, path);
  if (!found) return list;
  const [removed] = found.list.items.splice(found.index, 1);
  // What was inside it stays, where it was.
  if (removed?.children) found.list.items.splice(found.index, 0, ...removed.children.items);
  return root;
}

/** Puts an item inside the one before it. Null when it is the first. */
export function indentItem(
  list: ListModel,
  path: ItemPath,
): { list: ListModel; path: number[] } | null {
  const index = path.at(-1)!;
  if (index === 0) return null;
  const root = copyList(list);
  const found = within(root, path);
  if (!found) return null;
  const [item] = found.list.items.splice(index, 1);
  const previous = { ...found.list.items[index - 1]! };
  const children: ListModel = previous.children
    ? copyList(previous.children)
    : { ...found.list, items: [] };
  children.items.push(item!);
  previous.children = children;
  found.list.items[index - 1] = previous;
  return { list: root, path: [...path.slice(0, -1), index - 1, children.items.length - 1] };
}

/** Takes an item out of the list it is in, to after the item holding it. Null at the top. */
export function outdentItem(
  list: ListModel,
  path: ItemPath,
): { list: ListModel; path: number[] } | null {
  if (path.length < 2) return null;
  const root = copyList(list);
  const parentPath = path.slice(0, -1);
  const outer = within(root, parentPath);
  if (!outer) return null;
  const parent = { ...outer.list.items[outer.index]! };
  if (!parent.children) return null;
  const inner = copyList(parent.children);
  const index = path.at(-1)!;
  const [item] = inner.items.splice(index, 1);
  // The items after it go inside it, so the order stays.
  const rest = inner.items.splice(index);
  const moved: ListItemModel = { ...item! };
  if (rest.length > 0) {
    moved.children = moved.children
      ? { ...moved.children, items: [...moved.children.items, ...rest] }
      : { ...inner, items: rest };
  }
  parent.children = inner.items.length > 0 ? inner : null;
  outer.list.items[outer.index] = parent;
  outer.list.items.splice(outer.index + 1, 0, moved);
  return { list: root, path: [...parentPath.slice(0, -1), outer.index + 1] };
}

/** The list with bullets, or numbers. */
export function setOrdered(list: ListModel, ordered: boolean): ListModel {
  if (list.ordered === ordered) return list;
  return { ...list, ordered, marker: ordered ? '.' : '-', start: list.start || 1 };
}

/** Every item's text, nested ones after the item they are in. */
export function listTexts(list: ListModel): Inline[][] {
  return list.items.flatMap((item) => [
    item.content,
    ...(item.children ? listTexts(item.children) : []),
  ]);
}

// ---------------------------------------------------------------------------
// Tables

export function cellAt(table: TableModel, row: number, column: number): Inline[] {
  return (row === 0 ? table.header : table.rows[row - 1])?.[column] ?? [];
}

export function setCell(
  table: TableModel,
  row: number,
  column: number,
  content: Inline[],
): TableModel {
  if (row === 0) {
    const header = [...table.header];
    header[column] = content;
    return { ...table, header };
  }
  const rows = [...table.rows];
  const cells = [...(rows[row - 1] ?? [])];
  while (cells.length < table.header.length) cells.push([]);
  cells[column] = content;
  rows[row - 1] = cells;
  return { ...table, rows };
}

/** A row added after row `after` (0: the header, so as the first row). */
export function addRow(table: TableModel, after: number): TableModel {
  const rows = [...table.rows];
  rows.splice(
    after,
    0,
    table.header.map((): Inline[] => []),
  );
  return { ...table, rows };
}

/** A row taken away; the header row stays. */
export function removeRow(table: TableModel, row: number): TableModel {
  if (row === 0) return table;
  return { ...table, rows: table.rows.filter((_, i) => i !== row - 1) };
}

export function addColumn(table: TableModel, after: number): TableModel {
  const at = after + 1;
  const insert = <T>(list: readonly T[], value: T) => [
    ...list.slice(0, at),
    value,
    ...list.slice(at),
  ];
  return {
    align: insert(table.align, null),
    header: insert(table.header, [
      { kind: 'text', text: `Column ${table.header.length + 1}`, marks: {} },
    ]),
    rows: table.rows.map((row) => insert(row, [])),
    kind: 'table',
  };
}

/** A column taken away; a table keeps one at least. */
export function removeColumn(table: TableModel, column: number): TableModel {
  if (table.header.length <= 1) return table;
  const without = <T>(list: readonly T[]) => list.filter((_, i) => i !== column);
  return {
    kind: 'table',
    align: without(table.align),
    header: without(table.header),
    rows: table.rows.map(without),
  };
}

export function alignColumn(table: TableModel, column: number, align: Align): TableModel {
  const aligns = [...table.align];
  aligns[column] = align;
  return { ...table, align: aligns };
}
