import { describe, expect, it } from 'vitest';
import { readBlock, writeBlock } from './blocks';
import { moveBlock, readPage, replaceBlock, withModel, writePage, type EditPage } from './draft';
import {
  addForm,
  addSideBlock,
  depthAt,
  formPairs,
  formTree,
  moveForm,
  removeSideBlock,
  setFormMarker,
  takeApart,
  type FormNode,
} from './forms';
import { parseInline } from './inline';

const lines = (...parts: string[]) => parts.join('\n\n');

/** A page laid out as a wiki's home page, written as people write. */
const HOME = lines(
  '# Isle portal',
  '::: side 1:3',
  '::: card',
  '### Menu',
  '- [Bells](demo:guide:bells)\n- [Gates](demo:guide:gates)',
  '::: end',
  '::: next',
  '::: centred',
  'Welcome.',
  '::: end',
  '::: side',
  '::: card',
  '### News',
  '::: row',
  '- One\n- Two',
  '::: end',
  '::: end',
  '::: next',
  '::: card',
  '### Tips',
  '||Answer||',
  '::: end',
  '::: end',
  '::: columns 3',
  '- a\n- b\n- c',
  '::: end',
  '::: end',
  '```',
  '::: card',
  '```',
  '::: end',
  'Last.',
);

/** The tree as names: a block as its text, a form as its name and parts. */
function outline(nodes: readonly FormNode[]): unknown[] {
  return nodes.map((node) =>
    node.type === 'block'
      ? node.block.source.split('\n')[0]
      : { [node.pair.marker.form]: node.parts.map(outline) },
  );
}

const keyOf = (page: EditPage, source: string) =>
  page.blocks.find((block) => block.source === source)!.key;

describe('layout forms in the page editor', () => {
  it('reads every marker line as a block of its own, and writes the page back byte for byte', () => {
    for (const text of [HOME, HOME.replace(/\n/g, '\r\n'), `\n${HOME}\n\n`]) {
      const page = readPage(text);
      expect(writePage(page)).toBe(text);
    }
    const page = readPage(HOME);
    expect(page.blocks.filter((block) => block.model.kind === 'form')).toHaveLength(18);
  });

  it('shows each form around the blocks it holds, and a marker that is text as text', () => {
    const page = readPage(HOME);
    expect(outline(formTree(page.blocks))).toEqual([
      '# Isle portal',
      {
        side: [
          [{ card: [['### Menu', '- [Bells](demo:guide:bells)']] }],
          [
            { centred: [['Welcome.']] },
            {
              side: [
                [{ card: [['### News', { row: [['- One']] }]] }],
                [{ card: [['### Tips', '||Answer||']] }],
              ],
            },
            { columns: [['- a']] },
          ],
        ],
      },
      '```',
      '::: end',
      'Last.',
    ]);
    // The end without a partner is text, a paragraph, as the page shows it.
    expect(page.blocks.at(-2)!.model.kind).toBe('paragraph');
    expect(depthAt(page.blocks, keyOf(page, '- One\n- Two'))).toBe(4);
  });

  it('reads a marker line the page reads as text as a paragraph', () => {
    for (const text of ['::: card\n\nNever closed.', '::: aside\n\nx\n\n::: end', '::: next']) {
      const page = readPage(text);
      expect(page.blocks.every((block) => block.model.kind !== 'form')).toBe(true);
      expect(writePage(page)).toBe(text);
    }
    expect(readBlock('::: card').kind).toBe('form');
    expect(
      writeBlock({ kind: 'form', marker: { role: 'open', form: 'columns', columns: 4 } }),
    ).toBe('::: columns 4');
  });

  it('makes a form around a block, or an empty one, with blank lines around its markers', () => {
    const page = readPage('First.\nStill first.\n\nSecond.');
    const around = addForm(page, 'card', { around: keyOf(page, 'Second.') });
    expect(writePage(around.page)).toBe('First.\nStill first.\n\n::: card\n\nSecond.\n\n::: end');
    const side = addForm(page, 'side', { around: keyOf(page, 'First.\nStill first.') });
    expect(writePage(side.page)).toBe(
      '::: side\n\nFirst.\nStill first.\n\n::: next\n\n::: end\n\nSecond.',
    );
    expect(side.focus?.model.kind).toBe('paragraph');
    const empty = addForm(page, 'columns', { after: null });
    expect(writePage(empty.page)).toBe(
      'First.\nStill first.\n\nSecond.\n\n::: columns 2\n\n-\n\n::: end',
    );
    const row = addForm(page, 'row', { after: keyOf(page, 'First.\nStill first.') });
    expect(writePage(row.page)).toBe('First.\nStill first.\n\n::: row\n\n-\n\n::: end\n\nSecond.');
    // Typing into the empty card's title.
    const card = addForm(page, 'card', { after: null });
    const title = card.focus!;
    const typed = replaceBlock(
      card.page,
      title.key,
      withModel(card.page, title, {
        kind: 'heading',
        level: 3,
        setext: false,
        content: parseInline('News'),
      }),
    );
    expect(writePage(typed)).toBe(
      'First.\nStill first.\n\nSecond.\n\n::: card\n\n### News\n\n::: end',
    );
  });

  it('changes shares and columns, keeping the rest of the page as written', () => {
    const page = readPage(HOME);
    const [outer] = [...formPairs(page.blocks).values()];
    const changed = setFormMarker(page, outer!.open, {
      role: 'open',
      form: 'side',
      shares: [2, 1],
    });
    expect(writePage(changed)).toBe(HOME.replace('::: side 1:3', '::: side 2:1'));
    const columns = [...formPairs(page.blocks).values()].find(
      (pair) => pair.marker.form === 'columns',
    )!;
    expect(
      writePage(setFormMarker(page, columns.open, { role: 'open', form: 'columns', columns: 4 })),
    ).toBe(HOME.replace('::: columns 3', '::: columns 4'));
  });

  it('adds a block to a row side by side and takes one away, its text kept', () => {
    const page = readPage(lines('::: side 1:3', 'Menu', '::: next', 'Text', '::: end'));
    const open = page.blocks[0]!.key;
    const added = addSideBlock(page, open)!;
    expect(writePage(added.page)).toBe(
      lines('::: side 1:3:1', 'Menu', '::: next', 'Text', '::: next', '::: end'),
    );
    expect(addSideBlock(addSideBlock(added.page, open)!.page, open)).toBeNull();
    const three = readPage(lines('::: side', 'a', '::: next', 'b', '::: next', 'c', '::: end'));
    const first = three.blocks[0]!.key;
    expect(writePage(removeSideBlock(three, first, 1)!)).toBe(
      lines('::: side', 'a', 'b', '::: next', 'c', '::: end'),
    );
    expect(writePage(removeSideBlock(three, first, 0)!)).toBe(
      lines('::: side', 'a', 'b', '::: next', 'c', '::: end'),
    );
    const shared = readPage(
      lines('::: side 1:2:3', 'a', '::: next', 'b', '::: next', 'c', '::: end'),
    );
    expect(writePage(removeSideBlock(shared, shared.blocks[0]!.key, 2)!)).toBe(
      lines('::: side 1:2', 'a', '::: next', 'b', 'c', '::: end'),
    );
    // Two blocks at least.
    expect(removeSideBlock(page, open, 1)).toBeNull();
  });

  it('moves a form past a block or a whole form, and a block into and out of a form', () => {
    const page = readPage(
      lines('Before', '::: card', 'In', '::: end', '::: centred', 'Mid', '::: end'),
    );
    const card = page.blocks[1]!.key;
    expect(writePage(moveForm(page, card, -1))).toBe(
      lines('::: card', 'In', '::: end', 'Before', '::: centred', 'Mid', '::: end'),
    );
    expect(writePage(moveForm(page, card, 1))).toBe(
      lines('Before', '::: centred', 'Mid', '::: end', '::: card', 'In', '::: end'),
    );
    // A block moved down past an opening line goes into the form.
    expect(writePage(moveBlock(page, page.blocks[0]!.key, 1))).toBe(
      lines('::: card', 'Before', 'In', '::: end', '::: centred', 'Mid', '::: end'),
    );
  });

  it('takes a form apart, its blocks staying where they are', () => {
    const page = readPage(HOME);
    const outer = [...formPairs(page.blocks).values()][0]!;
    const apart = writePage(takeApart(page, outer.open));
    expect(apart).not.toContain('::: side 1:3');
    expect(apart.startsWith('# Isle portal\n\n::: card\n\n### Menu')).toBe(true);
    expect(apart).toContain('::: centred\n\nWelcome.\n\n::: end\n\n::: side\n\n');
    expect(
      apart.endsWith(
        '::: columns 3\n\n- a\n- b\n- c\n\n::: end\n\n```\n\n::: card\n\n```\n\n::: end\n\nLast.',
      ),
    ).toBe(true);
  });
});
