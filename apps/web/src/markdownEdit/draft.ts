import {
  emptyParagraph,
  lineEndOf,
  readBlock,
  splitBlocks,
  writeBlock,
  type BlockModel,
} from './blocks';
import { inlineLength } from './inline';

/**
 * A page being edited block by block: each block with the text it was read
 * from, so one not changed is written back as it was, and what was between
 * it and the next block, kept while that next block is still the one after
 * it. A block that was moved, or is new, is set apart from its neighbours
 * by a blank line, in the page's own line ends.
 */

export interface EditBlock {
  /** Names the block while the page is edited (not saved). */
  key: number;
  model: BlockModel;
  /** Its text now. */
  source: string;
  /** Its text as read, or null for a new block. */
  original: string | null;
  /** What followed it as read, and the key of the block that followed it then. */
  after: string;
  next: number | null;
  /** Edited as Markdown text in place of its tools. */
  asText: boolean;
}

export interface EditPage {
  lead: string;
  blocks: EditBlock[];
  /** What followed the last block as read: the page's end. */
  end: string;
  lineEnd: '\n' | '\r\n';
}

let lastKey = 0;
export const nextKey = () => ++lastKey;

/** A page read into blocks. */
export function readPage(text: string): EditPage {
  const split = splitBlocks(text);
  const keys = split.blocks.map(() => nextKey());
  const blocks = split.blocks.map((block, i): EditBlock => ({
    key: keys[i]!,
    model: readBlock(block.source),
    source: block.source,
    original: block.source,
    after: block.after,
    next: keys[i + 1] ?? null,
    asText: false,
  }));
  return {
    lead: split.lead,
    blocks,
    end: split.blocks.at(-1)?.after ?? '',
    lineEnd: lineEndOf(text),
  };
}

/** A block that says nothing: a paragraph with no text. Left out of the page. */
function isEmpty(block: EditBlock): boolean {
  return (
    block.source.trim() === '' ||
    (block.model.kind === 'paragraph' && inlineLength(block.model.content) === 0 && !block.asText)
  );
}

/** The page's text from its blocks. */
export function writePage(page: EditPage): string {
  const blocks = page.blocks.filter((block) => !isEmpty(block));
  const blank = page.lineEnd + page.lineEnd;
  let text = page.lead;
  blocks.forEach((block, i) => {
    text += block.source;
    const following = blocks[i + 1];
    if (following) {
      text += following.key === block.next && block.original !== null ? block.after : blank;
    } else {
      // The page ends as it did.
      text += block.next === null && block.original !== null ? block.after : page.end;
    }
  });
  if (blocks.length === 0) return page.lead === '' ? '' : page.lead;
  return text;
}

/** A block's text in the page's line ends. */
function inLineEnds(text: string, lineEnd: '\n' | '\r\n'): string {
  return lineEnd === '\n' ? text : text.replace(/\r?\n/g, '\r\n');
}

/** A block with a new model: its text written anew, as far as it changed. */
export function withModel(page: EditPage, block: EditBlock, model: BlockModel): EditBlock {
  const written = writeBlock(model, block.original ?? undefined);
  const source = written === block.original ? written : inLineEnds(written, page.lineEnd);
  return { ...block, model, source };
}

/** A new block. */
export function newBlock(page: EditPage, model: BlockModel = emptyParagraph()): EditBlock {
  return {
    key: nextKey(),
    model,
    source: inLineEnds(writeBlock(model), page.lineEnd),
    original: null,
    after: '',
    next: null,
    asText: false,
  };
}

/** A block's Markdown text set as typed: read again for its tools. */
export function withSource(block: EditBlock, source: string): EditBlock {
  return { ...block, source, model: readBlock(source) };
}

/** The page with a block's place changed: `by` places up (-1) or down (1). */
export function moveBlock(page: EditPage, key: number, by: -1 | 1): EditPage {
  const at = page.blocks.findIndex((block) => block.key === key);
  const to = at + by;
  if (at < 0 || to < 0 || to >= page.blocks.length) return page;
  const blocks = [...page.blocks];
  const [moved] = blocks.splice(at, 1);
  blocks.splice(to, 0, moved!);
  return { ...page, blocks };
}

export function replaceBlock(page: EditPage, key: number, ...replacement: EditBlock[]): EditPage {
  return {
    ...page,
    blocks: page.blocks.flatMap((block) => (block.key === key ? replacement : [block])),
  };
}

export function insertBlockAfter(page: EditPage, key: number | null, block: EditBlock): EditPage {
  const at = key === null ? page.blocks.length - 1 : page.blocks.findIndex((b) => b.key === key);
  const blocks = [...page.blocks];
  blocks.splice(at + 1, 0, block);
  return { ...page, blocks };
}

export function removeBlock(page: EditPage, key: number): EditPage {
  return { ...page, blocks: page.blocks.filter((block) => block.key !== key) };
}
