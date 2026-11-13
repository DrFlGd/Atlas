import type { GuideEntry, PackData } from '@atlas/schema';
import { makeFixturePack, makeGuidesFixturePack } from '@atlas/schema/testing';
import { describe, expect, it } from 'vitest';
import { renderGuideMarkdown } from '../markdown';
import {
  joinBlocks,
  newTable,
  readBlock,
  sameBlock,
  splitBlocks,
  writeBlock,
  type BlockModel,
  type ListModel,
  type TableModel,
} from './blocks';
import { parseInline, writeInline, type Inline } from './inline';

const options = {
  isAppTarget: (id: string) => /^(demo|pages):/.test(id),
  picture: (id: string) =>
    id.includes(':picture:') ? { url: `pictures/${id}.png`, caption: 'A picture' } : null,
};
const render = (markdown: string) => renderGuideMarkdown(markdown, options);

/** A page with every feature the Markdown view shows, written in many ways. */
const EVERYTHING = `# A page with everything

Setext heading
==============

Second level
------------

### Third ###

A paragraph with **bold**, __bold__, *italic*, _italic_, ~~struck~~, \`code\`,
[a link](https://example.org "Title"), [a page](demo:guide:walk), <demo:loc:0412>,
a bare https://example.org/path and ||hidden text|| in it.\\
A hard break above, and two spaces
before this line. Entities: &amp; &copy; and escapes \\* \\_ \\|.

![A picture](demo:picture:gate "Its caption")

[![A linked picture](demo:picture:gate)](https://example.org)

- One
- Two with **bold**
  - Nested one
  - Nested two
    1. Deeper
    2. Deeper still
- Three
  that goes on

1) First
2) Second

7. Seven
8. Eight

* Loose one

* Loose two

| Left | Centre | Right | None |
| :--- | :----: | ----: | ---- |
| a | **b** | [c](demo:loc:1) | \\| bar |
| short row |

Without | pipes at the ends
--- | ---
x | y

> A quote with *italic*
> on two lines.
>
> And a second paragraph.

> A quote holding a list:
> - item

\`\`\`js
const code = 'kept as it is';
||not hidden in code||
\`\`\`

~~~~
Tildes, with \`\`\` inside
~~~~

    indented code
    second line

---
***
___

||A hidden part

that spans paragraphs||

[ref]: https://example.org/ref "A reference"

A [reference link][ref] and a [collapsed][] one.

[collapsed]: demo:guide:walk

<div>Raw HTML shows as text</div>

- A list item

  with a second paragraph

Text after.
`;

/** A page as the wiki importer writes one: raised text, notes, cells with line breaks, a hidden table. */
const FROM_A_WIKI = `The Vale^\\[a\\]^ is reached by boat.

| Area | Level | Damage |
| --- | --- | --- |
| Old Vale^DLC^ | 2 | 82 DPS<br>16.4 a hit |
| \\|\\|Hidden Hall^DLC^\\|\\| | \\|\\|7\\|\\| | 1<br>2<br>3 |

> A quote with a break  
> on its second line.

||

| History |
| --- |
| 1.2: changed |

||

## Footnotes

- \\[a\\] Only by boat, and only at night^\\[1\\]^.
`;

const fixtures = (): [string, string][] => {
  const pages: [string, string][] = [
    ['everything', EVERYTHING],
    ['everything with Windows line ends', EVERYTHING.replace(/\n/g, '\r\n')],
    ['no line end at the end', EVERYTHING.trimEnd()],
    ['blank lines around', `\n\n\n${EVERYTHING}\n\n\n`],
    ['tabs and spaces', '\tTabbed\n\n  - spaced list\n  - again\n\n   Paragraph  \n'],
    ['empty', ''],
    ['only blank lines', '\n\n  \n'],
    ['hidden across a list', 'Before ||the answer\n\n- one\n- two||\n\nafter'],
    ['hidden across list items', '- one ||two\n- three|| four\n'],
    ['a last bar alone', 'Open || never closed\n\nNext paragraph'],
    ['a page from a wiki', FROM_A_WIKI],
  ];
  const guides: GuideEntry[] = [...makeGuidesFixturePack().guides, ...makeFixturePack().guides];
  for (const guide of guides) pages.push([guide.id, guide.body]);
  return pages;
};

/** What the demo pack's code gives, as far as this test uses it. */
interface DemoCode {
  content: {
    generateDemoContent(terrain: unknown, layout: unknown, options: object): PackData;
    layoutRegions(seed: number, terrain: unknown): unknown;
  };
  terrain: { createTerrain(seed: number, size: number): unknown };
  checklists: { addChecklists(data: PackData): PackData };
  wiki: { addWiki(data: PackData): PackData };
}

/** The demo pack's pages, made by its own code (a small pack, for speed). */
async function demoGuides(): Promise<GuideEntry[]> {
  const load = <K extends keyof DemoCode>(name: K) =>
    import(
      /* @vite-ignore */ new URL(
        `../../../../packages/pipeline/src/demo/${name}.ts`,
        import.meta.url,
      ).href
    ) as Promise<DemoCode[K]>;
  const [content, terrainCode, checklists, wiki] = await Promise.all([
    load('content'),
    load('terrain'),
    load('checklists'),
    load('wiki'),
  ]);
  const terrain = terrainCode.createTerrain(7, 1024);
  const data = content.generateDemoContent(terrain, content.layoutRegions(7, terrain), {
    seed: 7,
    size: 1024,
    tileSize: 256,
    locationCount: 300,
    tiles: { type: 'pmtiles', url: 'tiles/surface.pmtiles' },
  });
  return wiki.addWiki(checklists.addChecklists(data)).guides;
}

function checkPage(text: string): void {
  const page = splitBlocks(text);
  // Joined again, the blocks are the page, byte for byte.
  expect(joinBlocks(page)).toBe(text);
  for (const block of page.blocks) {
    const model = readBlock(block.source);
    // Not changed, a block keeps its own text.
    expect(writeBlock(model, block.source)).toBe(block.source);
    if (model.kind === 'raw') continue;
    // Written anew from what it holds, it shows the same and holds the same.
    const fresh = writeBlock(model);
    expect(render(fresh)).toBe(render(block.source));
    expect(sameBlock(readBlock(fresh), model)).toBe(true);
  }
}

describe('a page split into blocks', () => {
  it.each(fixtures())('%s: the same page, and the same blocks written anew', (_, text) => {
    checkPage(text);
  });

  it('the demo pack: every page stays the same, and every block written anew shows the same', async () => {
    const guides = await demoGuides();
    expect(guides.length).toBeGreaterThan(20);
    expect(guides.some((guide) => guide.body.includes('| Region |'))).toBe(true);
    for (const guide of guides) checkPage(guide.body);
  });

  it('finds the blocks of the page with everything', () => {
    const kinds = splitBlocks(EVERYTHING).blocks.map((block) => readBlock(block.source).kind);
    expect(kinds).toEqual([
      'heading',
      'heading',
      'heading',
      'heading',
      'paragraph',
      'paragraph',
      'paragraph',
      'list',
      'list',
      'list',
      'list',
      'table',
      'table',
      'quote',
      'raw',
      'code',
      'code',
      'code',
      'rule',
      'rule',
      'rule',
      'raw',
      'raw',
      'paragraph',
      'raw',
      'paragraph',
      'raw',
      'paragraph',
    ]);
  });

  it('keeps hidden text that spans blocks as one block, edited as Markdown', () => {
    const page = splitBlocks('Before ||the answer\n\n- one\n- two||\n\nafter');
    expect(page.blocks.map((block) => block.source)).toEqual([
      'Before ||the answer\n\n- one\n- two||',
      'after',
    ]);
    expect(readBlock(page.blocks[0]!.source)).toEqual({ kind: 'raw', why: 'other' });
    expect(readBlock('- one ||two\n- three|| four')).toEqual({ kind: 'raw', why: 'hidden' });
  });
});

describe('a page from a wiki', () => {
  it('edits its parts with the text tools, the hidden table as Markdown', () => {
    const blocks = splitBlocks(FROM_A_WIKI).blocks;
    expect(blocks.map((block) => readBlock(block.source).kind)).toEqual([
      'paragraph',
      'table',
      'quote',
      'raw',
      'heading',
      'list',
    ]);
    expect(blocks[3]!.source).toBe('||\n\n| History |\n| --- |\n| 1.2: changed |\n\n||');
  });

  it('keeps raised text and line breaks of a table row it writes anew', () => {
    const source = splitBlocks(FROM_A_WIKI).blocks[1]!.source;
    const table = readBlock(source) as TableModel;
    table.rows[0]![1] = [{ kind: 'text', text: '3', marks: {} }];
    const written = writeBlock(table, source);
    expect(written.split('\n')[2]).toBe('| Old Vale^DLC^ | 3 | 82 DPS<br>16.4 a hit |');
    expect(render(written)).toContain('<td>Old Vale<sup>DLC</sup></td>');
    expect(render(written)).toContain('<td>82 DPS<br>\n16.4 a hit</td>');
  });
});

describe('a changed block', () => {
  const text = (t: string): Inline => ({ kind: 'text', text: t, marks: {} });

  it('writes only the changed cell row of a table, and keeps the others as they were', () => {
    const source = '| A  |  B |\n|:-- | --:|\n|  1 | 2  |\n|  3 | 4  |';
    const table = readBlock(source) as TableModel;
    table.rows[1]![0] = [text('three')];
    expect(writeBlock(table, source)).toBe('| A  |  B |\n|:-- | --:|\n|  1 | 2  |\n| three | 4 |');
    // A row added, a column aligned.
    const added = readBlock(source) as TableModel;
    added.rows.push([[text('5')], []]);
    expect(writeBlock(added, source)).toBe(
      '| A  |  B |\n|:-- | --:|\n|  1 | 2  |\n|  3 | 4  |\n| 5 | |',
    );
    const centred = readBlock(source) as TableModel;
    centred.align[1] = 'center';
    expect(writeBlock(centred, source)).toBe(
      '| A  |  B |\n| :--- | :---: |\n|  1 | 2  |\n|  3 | 4  |',
    );
    // A column added: every row is written anew.
    const wider = readBlock(source) as TableModel;
    wider.align.push(null);
    wider.header.push([text('C')]);
    for (const row of wider.rows) row.push([]);
    expect(render(writeBlock(wider, source))).toContain('<th>C</th>');
  });

  it('a new table has a header and empty rows', () => {
    const written = writeBlock(newTable(2, 1));
    expect(written).toBe('| Column 1 | Column 2 |\n| --- | --- |\n| | |');
    expect(render(written)).toContain('<th>Column 1</th>');
  });

  it('writes only the changed item of a list', () => {
    const source = '* one\n* two\n    * nested\n* three';
    const list = readBlock(source) as ListModel;
    list.items[2]!.content = parseInline('three **changed**');
    expect(writeBlock(list, source)).toBe('* one\n* two\n    * nested\n* three **changed**');
    list.items.push({ content: [text('four')], children: null });
    expect(writeBlock(list, source)).toBe(
      '* one\n* two\n    * nested\n* three **changed**\n* four',
    );
    // Nested anew.
    list.items[0]!.children = { ...(readBlock('1. a\n2. b') as ListModel) };
    const written = writeBlock(list, source);
    expect(written).toBe('* one\n  1. a\n  2. b\n* two\n    * nested\n* three **changed**\n* four');
    expect(render(written)).toContain('<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
  });

  it('switches a list between bullets and numbers', () => {
    const list = readBlock('- one\n- two') as ListModel;
    const numbered: ListModel = { ...list, ordered: true, marker: '.' };
    expect(writeBlock(numbered, '- one\n- two')).toBe('1. one\n2. two');
  });

  it('writes headings, quotes, code and paragraphs anew', () => {
    const heading: BlockModel = {
      kind: 'heading',
      level: 2,
      setext: false,
      content: [text('C #')],
    };
    expect(writeBlock(heading)).toBe('## C \\#');
    expect(render(writeBlock(heading))).toBe('<h2>C #</h2>\n');
    const quote: BlockModel = { kind: 'quote', paragraphs: [parseInline('a\nb'), [text('c')]] };
    expect(writeBlock(quote)).toBe('> a\n> b\n>\n> c');
    const code: BlockModel = { kind: 'code', fence: '```', info: 'js', text: 'a\n```\nb\n' };
    expect(writeBlock(code)).toBe('````js\na\n```\nb\n````');
    const indented: BlockModel = { kind: 'code', fence: null, info: '', text: 'a\n\nb\n' };
    expect(writeBlock(indented)).toBe('    a\n\n    b');
    expect(writeInline(parseInline('a *b*'))).toBe('a *b*');
  });
});
