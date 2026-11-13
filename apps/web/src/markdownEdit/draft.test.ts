import { describe, expect, it } from 'vitest';
import { newTable, type ListModel } from './blocks';
import {
  insertBlockAfter,
  moveBlock,
  newBlock,
  readPage,
  removeBlock,
  replaceBlock,
  withModel,
  withSource,
  writePage,
} from './draft';
import { parseInline } from './inline';

const PAGE = '# Title\nIntro line.\n\n* one\n* two\n\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';

describe('a page edited block by block', () => {
  it('is written back byte for byte when nothing changed', () => {
    for (const text of [PAGE, PAGE.replace(/\n/g, '\r\n'), '', '\n\n', 'One line', '\n\nx\n\n']) {
      expect(writePage(readPage(text))).toBe(text);
    }
  });

  it('writes only the block that changed, and keeps what is around it', () => {
    const page = readPage(PAGE);
    const list = page.blocks[2]!;
    const model = { ...(list.model as ListModel) };
    model.items = [...model.items, { content: parseInline('three'), children: null }];
    const changed = replaceBlock(page, list.key, withModel(page, list, model));
    expect(writePage(changed)).toBe(
      '# Title\nIntro line.\n\n* one\n* two\n* three\n\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
    );
  });

  it('puts a blank line around a block moved or added, in the page’s line ends', () => {
    const page = readPage(PAGE.replace(/\n/g, '\r\n'));
    const moved = moveBlock(page, page.blocks[0]!.key, 1);
    expect(writePage(moved)).toBe(
      'Intro line.\r\n\r\n# Title\r\n\r\n* one\r\n* two\r\n\r\n\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n',
    );
    const added = insertBlockAfter(page, null, newBlock(page, newTable(1, 1)));
    expect(writePage(added)).toBe(
      `${PAGE.replace(/\n/g, '\r\n').trimEnd()}\r\n\r\n| Column 1 |\r\n| --- |\r\n| |\r\n`,
    );
  });

  it('leaves out empty paragraphs and blocks taken away', () => {
    const page = readPage(PAGE);
    const empty = insertBlockAfter(page, page.blocks[0]!.key, newBlock(page));
    expect(writePage(empty)).toBe(PAGE);
    expect(writePage(removeBlock(page, page.blocks[3]!.key))).toBe(
      '# Title\nIntro line.\n\n* one\n* two\n',
    );
  });

  it('reads a block typed as Markdown for its tools', () => {
    const page = readPage('Text');
    const typed = withSource(page.blocks[0]!, '## Now a heading');
    expect(typed.model.kind).toBe('heading');
    expect(writePage(replaceBlock(page, typed.key, typed))).toBe('## Now a heading');
  });
});
