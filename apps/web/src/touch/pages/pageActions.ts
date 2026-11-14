import { parseId } from '@atlas/schema';
import type { BlockModel, ListModel } from '../../markdownEdit/blocks';
import {
  insertBlockAfter,
  newBlock,
  replaceBlock,
  withModel,
  type EditBlock,
  type EditPage,
} from '../../markdownEdit/draft';
import { inlineLength, toggleMark, type Inline, type ToggleMark } from '../../markdownEdit/inline';
import { indentItem, outdentItem, type ItemPath } from '../../markdownEdit/structure';
import { guidesOf } from '../../state/guides';
import { layoutOf, useOwnPages } from '../../state/ownPages';
import type { LoadedGame } from '../../state/store';
import {
  changePage,
  fields,
  focusedField,
  focusField,
  usePageEditor,
  type FieldApi,
} from './pageEditorState';

/**
 * What the page editor's tools do to the page: a block changed, the
 * names of the fields of a list's items, a table's cells and a quote's
 * paragraphs, the text tools on the selection, a block put in.
 */

/** Changes one block of the page. */
export function changeBlock(
  key: number,
  change: (block: EditBlock, page: EditPage) => EditBlock[] | EditBlock | null,
  typing?: boolean,
): void {
  changePage(
    (page) => {
      const block = page.blocks.find((b) => b.key === key);
      if (!block) return page;
      const next = change(block, page);
      if (next === null) return page;
      return replaceBlock(page, key, ...(Array.isArray(next) ? next : [next]));
    },
    typing ? `type:${key}` : undefined,
  );
}

export function setModel(key: number, model: BlockModel, typing?: boolean): void {
  changeBlock(key, (block, page) => withModel(page, block, model), typing);
}

export const fieldOfList = (key: number, path: ItemPath) => `${key}:i${path.join('.')}`;
export const fieldOfCell = (key: number, row: number, column: number) => `${key}:c${row}.${column}`;
export const fieldOfQuote = (key: number, index: number) => `${key}:q${index}`;

/** Which item or cell a field is, from its name. */
export function partOfField(
  field: string,
):
  | { kind: 'item'; path: number[] }
  | { kind: 'cell'; row: number; column: number }
  | { kind: 'quote'; index: number }
  | { kind: 'whole' } {
  const part = field.split(':')[1];
  if (!part) return { kind: 'whole' };
  if (part.startsWith('i')) return { kind: 'item', path: part.slice(1).split('.').map(Number) };
  if (part.startsWith('c')) {
    const [row, column] = part.slice(1).split('.').map(Number);
    return { kind: 'cell', row: row!, column: column! };
  }
  return { kind: 'quote', index: Number(part.slice(1)) };
}

export function currentList(blockKey: number): ListModel | null {
  const block = usePageEditor.getState().page.blocks.find((b) => b.key === blockKey);
  return block?.model.kind === 'list' ? block.model : null;
}

/** The list tools that act on an item: from the keyboard or the list bar. */
export function listAction(blockKey: number, path: number[], action: 'indent' | 'outdent'): void {
  const list = currentList(blockKey);
  if (!list) return;
  const moved = action === 'indent' ? indentItem(list, path) : outdentItem(list, path);
  if (!moved) return;
  const at = fields.get(fieldOfList(blockKey, path))?.selection()[0] ?? 0;
  setModel(blockKey, moved.list);
  focusField(fieldOfList(blockKey, moved.path), at);
}

/** Acts on the selection of the field being edited. */
export function withField(
  act: (field: FieldApi, start: number, end: number, pieces: Inline[]) => void,
) {
  const field = focusedField();
  if (!field) return;
  const [start, end] = field.selection();
  act(field, start, end, field.pieces());
}

export function toggle(mark: ToggleMark): void {
  withField((field, start, end, pieces) => {
    if (start === end) return;
    field.apply(toggleMark(pieces, start, end, mark), [start, end]);
  });
}

/** The block the tools act on, and its model. */
export function focusedBlock() {
  const { focused, page } = usePageEditor.getState();
  const block = focused ? page.blocks.find((b) => b.key === focused.block) : undefined;
  return block && !block.asText ? block : undefined;
}

/** Puts a new block after the one being edited (or in place of an empty paragraph), or at the end. */
export function insertBlock(model: BlockModel, focus?: (key: number) => string): void {
  const block = focusedBlock();
  changePage((page) => {
    const added = newBlock(page, model);
    if (focus) focusField(focus(added.key), 0);
    if (block?.model.kind === 'paragraph' && inlineLength(block.model.content) === 0) {
      return {
        ...page,
        blocks: page.blocks.map((b) => (b.key === block.key ? added : b)),
      };
    }
    return insertBlockAfter(page, block?.key ?? null, added);
  });
}

/** Every section of the contents, with the sections it is in, for a choice of where a page goes. */
export function sectionChoices(game: LoadedGame): { id: string; title: string; depth: number }[] {
  const layout = layoutOf(game);
  const { contents } = guidesOf(game);
  const titles = new Map<string, string>();
  for (const section of game.pack.data.sections ?? []) titles.set(section.id, section.title);
  for (const section of useOwnPages.getState().own.sections) titles.set(section.id, section.title);
  const out: { id: string; title: string; depth: number }[] = [];
  const walk = (items: readonly string[], depth: number) => {
    for (const id of items) {
      // Sections only: a layout also holds the pages put under a page, by its id.
      if (!(id in layout.sections) || parseId(id)?.kind !== 'section') continue;
      out.push({ id, title: contents.section(id)?.title ?? titles.get(id) ?? id, depth });
      walk(layout.sections[id] ?? [], depth + 1);
    }
  };
  walk(layout.top, 0);
  return out;
}
