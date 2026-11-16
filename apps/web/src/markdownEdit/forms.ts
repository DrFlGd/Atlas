import {
  MAX_COLUMNS,
  MAX_DEPTH,
  MAX_FORMS,
  MAX_SHARE,
  MAX_SIDE_BLOCKS,
  type LayoutFormName,
  type LayoutMarker,
} from '@atlas/schema';
import { emptyParagraph, newList, type BlockModel } from './blocks';
import {
  insertBlockAfter,
  newBlock,
  removeBlock,
  withModel,
  type EditBlock,
  type EditPage,
} from './draft';

/**
 * The layout forms of a page being edited: its marker blocks (see
 * `blocks.ts`) paired as the page pairs their lines (see `layoutForms.ts`
 * in `@atlas/schema`), the forms around the blocks they hold for the
 * formatted view, and what the layout tools do: a form made around a
 * block or added empty, its shares or columns changed, a block of a row
 * side by side added or taken away, a form moved, and a form taken apart,
 * its blocks kept. Each is a change of the page's list of blocks, so a
 * block a tool does not touch keeps its text.
 */

export type OpenMarker = Extract<LayoutMarker, { role: 'open' }>;

/** One form of the page: the keys of its marker blocks. */
export interface FormPair {
  open: number;
  /** Between its blocks side by side. */
  next: number[];
  end: number;
  marker: OpenMarker;
  depth: number;
}

const markerOf = (block: EditBlock): LayoutMarker | null =>
  block.model.kind === 'form' && !block.asText ? block.model.marker : null;

/** The forms of the blocks, paired as the page pairs its marker lines, by the key that opens each. */
export function formPairs(blocks: readonly EditBlock[]): Map<number, FormPair> {
  const open: { open: number; marker: OpenMarker; next: number[] }[] = [];
  const paired: (FormPair & { at: number })[] = [];
  const index = new Map(blocks.map((block, i) => [block.key, i]));
  for (const block of blocks) {
    const marker = markerOf(block);
    if (!marker) continue;
    if (marker.role === 'open') open.push({ open: block.key, marker, next: [] });
    else if (marker.role === 'next') {
      const innermost = open.at(-1);
      if (innermost?.marker.form === 'side' && innermost.next.length < MAX_SIDE_BLOCKS - 1) {
        innermost.next.push(block.key);
      }
    } else {
      const form = open.pop();
      if (form) paired.push({ ...form, end: block.key, depth: 0, at: index.get(form.open)! });
    }
  }
  paired.sort((a, b) => a.at - b.at);
  const kept = new Map<number, FormPair>();
  const around: { end: number }[] = [];
  for (const form of paired) {
    while (around.length > 0 && around.at(-1)!.end < form.at) around.pop();
    if (around.length >= MAX_DEPTH || kept.size >= MAX_FORMS) continue;
    kept.set(form.open, {
      open: form.open,
      next: form.next,
      end: form.end,
      marker: form.marker,
      depth: around.length + 1,
    });
    around.push({ end: index.get(form.end)! });
  }
  return kept;
}

/** A part of the formatted view: a block, or a form holding parts. */
export type FormNode =
  | { type: 'block'; block: EditBlock }
  | { type: 'form'; pair: FormPair; open: EditBlock; parts: FormNode[][] };

/**
 * The blocks as the formatted view shows them: each form around the blocks
 * it holds, its blocks side by side as parts. A marker block no form has
 * (one without a partner, say) is a block, shown as the text it is.
 */
export function formTree(blocks: readonly EditBlock[]): FormNode[] {
  const pairs = formPairs(blocks);
  const roles = new Map<number, 'next' | 'end'>();
  for (const pair of pairs.values()) {
    for (const key of pair.next) roles.set(key, 'next');
    roles.set(pair.end, 'end');
  }
  const root: FormNode[] = [];
  const stack: { node: Extract<FormNode, { type: 'form' }> }[] = [];
  const here = () => stack.at(-1)?.node.parts.at(-1) ?? root;
  for (const block of blocks) {
    const pair = pairs.get(block.key);
    if (pair) {
      const node: FormNode = { type: 'form', pair, open: block, parts: [[]] };
      here().push(node);
      stack.push({ node });
      continue;
    }
    const role = roles.get(block.key);
    if (role === 'next') stack.at(-1)?.node.parts.push([]);
    else if (role === 'end') stack.pop();
    else here().push({ type: 'block', block });
  }
  return root;
}

/** How many forms a block stands in. */
export function depthAt(blocks: readonly EditBlock[], key: number): number {
  const index = new Map(blocks.map((block, i) => [block.key, i]));
  const at = index.get(key);
  if (at === undefined) return 0;
  let depth = 0;
  for (const pair of formPairs(blocks).values()) {
    if (index.get(pair.open)! < at && at < index.get(pair.end)!) depth++;
  }
  return depth;
}

/** Whether a block is a marker of one of the page's forms (not text). */
export function isFormMarker(blocks: readonly EditBlock[], key: number): boolean {
  for (const pair of formPairs(blocks).values()) {
    if (pair.open === key || pair.end === key || pair.next.includes(key)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Making and changing forms

/** A form's opening marker with its first values. */
export function openMarker(form: LayoutFormName): OpenMarker {
  if (form === 'side') return { role: 'open', form, shares: null };
  if (form === 'columns') return { role: 'open', form, columns: 2 };
  return { role: 'open', form };
}

const marker = (page: EditPage, value: LayoutMarker) =>
  newBlock(page, { kind: 'form', marker: value });

/** What a new empty form holds first: a title, an item, a line. */
function firstBlocks(page: EditPage, form: LayoutFormName): EditBlock[] {
  switch (form) {
    case 'card':
      return [newBlock(page, { kind: 'heading', level: 3, setext: false, content: [] })];
    case 'row':
    case 'columns':
      return [newBlock(page, newList(false))];
    case 'side':
      return [newBlock(page), marker(page, { role: 'next' }), newBlock(page, emptyParagraph())];
    default:
      return [newBlock(page)];
  }
}

/**
 * A form made around the block `around`, or added empty after the block
 * `after` (at the end with null). Returns the page and the block to put
 * the cursor in.
 */
export function addForm(
  page: EditPage,
  form: LayoutFormName,
  where: { around: number } | { after: number | null },
): { page: EditPage; focus: EditBlock | null } {
  const open = marker(page, openMarker(form));
  const end = marker(page, { role: 'end' });
  if ('around' in where) {
    const at = page.blocks.findIndex((block) => block.key === where.around);
    if (at < 0) return { page, focus: null };
    const held = page.blocks[at]!;
    const extra = form === 'side' ? [marker(page, { role: 'next' }), newBlock(page)] : [];
    const blocks = [...page.blocks];
    blocks.splice(at, 1, open, held, ...extra, end);
    return { page: { ...page, blocks }, focus: extra[1] ?? held };
  }
  const inner = firstBlocks(page, form);
  let next = page;
  let last = where.after;
  for (const block of [open, ...inner, end]) {
    next = insertBlockAfter(next, last, block);
    last = block.key;
  }
  return { page: next, focus: inner[0] ?? null };
}

/** The form opened by `open`, as the page pairs it now. */
export const formAt = (page: EditPage, open: number): FormPair | null =>
  formPairs(page.blocks).get(open) ?? null;

/** A form's opening marker changed: its shares, its columns. */
export function setFormMarker(page: EditPage, open: number, value: OpenMarker): EditPage {
  const block = page.blocks.find((b) => b.key === open);
  if (block?.model.kind !== 'form') return page;
  const model: BlockModel = { kind: 'form', marker: value };
  return { ...page, blocks: page.blocks.map((b) => (b === block ? withModel(page, b, model) : b)) };
}

/** Shares a person can choose for blocks side by side, by how many blocks there are. */
export const SHARE_PRESETS: Record<number, number[][]> = {
  2: [
    [1, 1],
    [1, 2],
    [2, 1],
    [1, 3],
    [3, 1],
  ],
  3: [
    [1, 1, 1],
    [1, 2, 1],
    [2, 1, 1],
    [1, 1, 2],
  ],
  4: [
    [1, 1, 1, 1],
    [1, 2, 2, 1],
  ],
};

/** The shares a form side by side has: one per block, each 1 to the most. */
export function sharesOfForm(pair: FormPair): number[] {
  const marker = pair.marker;
  const shares = marker.form === 'side' ? marker.shares : null;
  return Array.from({ length: pair.next.length + 1 }, (_, i) =>
    Math.min(MAX_SHARE, Math.max(1, shares?.[i] ?? 1)),
  );
}

/** Shares for a new number of blocks: those kept, a new block a share of 1, equal ones as equal. */
function sharesFor(pair: FormPair, blocks: number, without?: number): number[] | null {
  const old = sharesOfForm(pair);
  if (old.every((share) => share === old[0])) return null;
  const kept = old.filter((_, i) => i !== without);
  while (kept.length < blocks) kept.push(1);
  return kept.slice(0, blocks);
}

/** A block added at the end of a form side by side, empty; null when it has the most. */
export function addSideBlock(
  page: EditPage,
  open: number,
): { page: EditPage; focus: EditBlock } | null {
  const pair = formAt(page, open);
  if (pair?.marker.form !== 'side' || pair.next.length >= MAX_SIDE_BLOCKS - 1) return null;
  const endAt = page.blocks.findIndex((block) => block.key === pair.end);
  const before = page.blocks[endAt - 1]!;
  const separator = marker(page, { role: 'next' });
  const text = newBlock(page);
  let next = insertBlockAfter(page, before.key, separator);
  next = insertBlockAfter(next, separator.key, text);
  const shares = sharesFor(pair, pair.next.length + 2);
  next = setFormMarker(next, open, { role: 'open', form: 'side', shares });
  return { page: next, focus: text };
}

/**
 * Block `index` of a form side by side taken away; its blocks stay, in the
 * block before it (the first block's in the one after it). A form keeps two
 * blocks at least: null then.
 */
export function removeSideBlock(page: EditPage, open: number, index: number): EditPage | null {
  const pair = formAt(page, open);
  if (pair?.marker.form !== 'side' || pair.next.length < 2) return null;
  const separator = index === 0 ? pair.next[0] : pair.next[index - 1];
  if (separator === undefined) return null;
  const shares = sharesFor(pair, pair.next.length, index);
  return setFormMarker(removeBlock(page, separator), open, {
    role: 'open',
    form: 'side',
    shares,
  });
}

/** The columns a list is flowed in, as many as the form allows. */
export const clampColumns = (columns: number) => Math.min(MAX_COLUMNS, Math.max(2, columns));

/** The indexes of the blocks from a form's opening marker to its end. */
function rangeOf(page: EditPage, pair: FormPair): [number, number] {
  return [
    page.blocks.findIndex((block) => block.key === pair.open),
    page.blocks.findIndex((block) => block.key === pair.end),
  ];
}

/**
 * A form moved up (-1) or down (1) past what stands next to it: a block,
 * or a whole form. At the start or the end of the block it is in, it
 * leaves that block, as a block moved there does.
 */
export function moveForm(page: EditPage, open: number, by: -1 | 1): EditPage {
  const pairs = formPairs(page.blocks);
  const pair = pairs.get(open);
  if (!pair) return page;
  const [start, end] = rangeOf(page, pair);
  const blocks = [...page.blocks];
  const moved = blocks.slice(start, end + 1);
  if (by === -1) {
    if (start === 0) return page;
    const before = blocks[start - 1]!;
    // A whole form before it is passed over whole.
    const formBefore = [...pairs.values()].find((p) => p.end === before.key);
    const to = formBefore ? rangeOf(page, formBefore)[0] : start - 1;
    blocks.splice(start, moved.length);
    blocks.splice(to, 0, ...moved);
  } else {
    if (end === blocks.length - 1) return page;
    const after = blocks[end + 1]!;
    const formAfter = pairs.get(after.key);
    const last = formAfter ? rangeOf(page, formAfter)[1] : end + 1;
    blocks.splice(start, moved.length);
    blocks.splice(last - moved.length + 1, 0, ...moved);
  }
  return { ...page, blocks };
}

/** A form taken apart: its marker blocks go, the blocks it held stay where they are. */
export function takeApart(page: EditPage, open: number): EditPage {
  const pair = formAt(page, open);
  if (!pair) return page;
  const gone = new Set([pair.open, ...pair.next, pair.end]);
  return { ...page, blocks: page.blocks.filter((block) => !gone.has(block.key)) };
}

/** What each form is called on screen. */
export const FORM_NAMES: Record<LayoutFormName, string> = {
  side: 'Side by side',
  card: 'Card',
  row: 'Row',
  columns: 'Columns',
  centred: 'Centred',
};

export const FORM_ORDER: LayoutFormName[] = ['side', 'card', 'row', 'columns', 'centred'];
