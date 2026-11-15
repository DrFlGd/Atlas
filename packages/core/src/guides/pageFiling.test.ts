import { describe, expect, it } from 'vitest';
import {
  LIST_PAGE_MIN_LISTED,
  LISTING_WORDS_MAX,
  isListPage,
  mayBeListPage,
  pageFilingIn,
  type PageFiling,
} from './pageFiling';

/** Which links of a page list pages, on made-up pages. */

const g = (local: string) => `wiki:guide:${local}`;
const to = (local: string, words = local) => `[${words}](${g(local)})`;
const listed = (body: string) => pageFilingIn(body, g('self')).listing.map((id) => id.slice(11));

describe('listing links', () => {
  it('are the main links of short list items, of any list, in order, each once', () => {
    const body = [
      `- ${to('a')}`,
      `* **${to('b')}**: a short sword.`,
      `1. ${to('c')} – sold in ${to('d')}.`,
      `2) ${to('a')} again`,
      `- ${to('self')}`,
    ].join('\n');
    expect(listed(body)).toEqual(['a', 'b', 'c']);
  });

  it('are not links in sentences, headings with words, quotes or code', () => {
    const body = [
      `A sentence about ${to('a')}.`,
      `${to('b')} starts a sentence.`,
      `## About ${to('c')}`,
      `> - ${to('d')}`,
      '```',
      `- ${to('e')}`,
      '```',
    ].join('\n');
    expect(listed(body)).toEqual([]);
    expect(pageFilingIn(body).linked).toBe(5);
  });

  it('are not links after words, nor in an item that reads as prose', () => {
    const long = 'word '.repeat(Math.ceil(LISTING_WORDS_MAX / 5));
    const body = [
      `- Drops from ${to('a')}`,
      `- **Location:** ${to('b')}`,
      `- ${to('c')} ${long}`,
      `- ${to('d')} is short`,
    ].join('\n');
    expect(listed(body)).toEqual(['d']);
  });

  it('count a long address as no words', () => {
    const name = `[![Blade](wiki:picture:${'x'.repeat(120)} "=24x24")](${g('a')}) ${to('a', 'Blade')}`;
    expect(name.length).toBeGreaterThan(LISTING_WORDS_MAX);
    expect(listed(`- ${name}`)).toEqual(['a']);
  });

  it('read an item with the lines that continue it, and lists apart with blank lines', () => {
    const body = [
      `- ${to('a')}`,
      `  and ${'more words '.repeat(12)}`,
      '',
      `- ${to('b')}`,
      '',
      'A paragraph.',
      '',
      `- ${to('c')}`,
      `  - ${to('d')}`,
    ].join('\n');
    expect(listed(body)).toEqual(['b', 'c', 'd']);
  });

  it('are the tiles of a list of tiles: a linked picture and a name', () => {
    const body = [
      `- [![Gear](wiki:picture:gear "=100x100")](${g('gear')})${to('gear', 'Gear')}`,
      `- [![Biomes](wiki:picture:biomes "=100x100")](${g('biomes')})${to('biomes', 'Biomes')}`,
    ].join('\n');
    expect(listed(body)).toEqual(['gear', 'biomes']);
  });

  it('are never in hidden text, over lines or within one', () => {
    const body = [
      '||',
      '',
      `- ${to('a')}`,
      '',
      '||',
      '',
      `- ||${to('b')}||`,
      `- ${to('c')} ||${to('d')}||`,
      `- ${to('e')}`,
    ].join('\n');
    expect(listed(body)).toEqual(['c', 'e']);
  });

  it('are the names of a table, not the location a later column names', () => {
    const body = [
      'Every weapon.',
      '',
      '| Name | Type | Location |',
      '| --- | --- | --- |',
      `| ![icon](wiki:picture:i) ${to('blade')} | Sword | ${to('vale')} |`,
      `| ${to('axe')} | Axe | ${to('vale')} |`,
      `| ${to('bow')} | Bow | ${to('peak')} |`,
      `| ${to('cudgel')} | Cudgel | Drops from ${to('ogre')} |`,
    ].join('\n');
    expect(listed(body)).toEqual(['blade', 'axe', 'bow', 'cudgel']);
  });

  it('are the first column with more than pictures, whatever later columns name', () => {
    // A row is about its first cell: a table by location lists the locations.
    const byLocation = [
      '| Location | Weapon |',
      '| --- | --- |',
      `| ${to('vale')} | ${to('blade')} |`,
      `| ${to('vale')} | ${to('axe')} |`,
      `| ${to('peak')} | ${to('bow')} |`,
    ].join('\n');
    expect(listed(byLocation)).toEqual(['vale', 'peak']);
    // A column of pictures, then the names: the names.
    const pictures = [
      '| Icon | Name | Found |',
      '| --- | --- | --- |',
      `| ![a](wiki:picture:a) | ${to('blade')} | ${to('vale')} |`,
      `| [![b](wiki:picture:b)](${g('axe')}) | ${to('axe')} | ${to('peak')} |`,
      `|  | ${to('bow')} | ${to('vale')} |`,
    ].join('\n');
    expect(listed(pictures)).toEqual(['blade', 'axe', 'bow']);
  });

  it('are none when the first column holds no links: words, numbers, levels', () => {
    const upgrades = [
      '| Level | Cost | Where |',
      '| --- | --- | --- |',
      `| 1 | 10 | ${to('vale')} |`,
      `| 2 | 20 | ${to('smith')} |`,
      `| +1 | 40 | ${to('peak')} |`,
    ].join('\n');
    expect(listed(upgrades)).toEqual([]);
    const ranked = ['| # | Name |', '| --- | --- |', `| 1 | ${to('a')} |`, `| 2 | ${to('b')} |`];
    expect(listed(ranked.join('\n'))).toEqual([]);
    const words = [
      '| Image | Name | Found |',
      '| --- | --- | --- |',
      `| [![Blade](wiki:picture:blade)](${g('blade')}) | Blade | ${to('vale')} |`,
      `| [![Axe](wiki:picture:axe)](${g('axe')}) | Axe | ${to('peak')} |`,
    ].join('\n');
    // The names are words, though the pictures before them lead to the pages: flat, to be safe.
    expect(listed(words)).toEqual([]);
    // A heading row and nothing under it.
    expect(listed(`| ${to('a')} | ${to('b')} |\n| --- | --- |`)).toEqual([]);
  });

  it('are never in a box of facts, nor in hidden text of a cell', () => {
    const box = [
      `| Blade | {box} |`,
      '| --- | --- |',
      `| ${to('vale')} |  |`,
      `| Sold by | ${to('smith')} |`,
    ].join('\n');
    expect(listed(box)).toEqual([]);
    const hiddenCells = [
      '| Name | Note |',
      '| --- | --- |',
      `| \\|\\|${to('a')}\\|\\| | 1 |`,
      `| ${to('b')} | 2 |`,
    ].join('\n');
    expect(listed(hiddenCells)).toEqual(['b']);
  });

  it('read coloured words and marks after a name', () => {
    const body = [
      '| Biome | Scrolls |',
      '| --- | --- |',
      `| ${to('a')}^[new]{color=#82c936}^ | 1 |`,
      `| [${to('b')}]{color=#c33} | 2 |`,
    ].join('\n');
    expect(listed(body)).toEqual(['a', 'b']);
  });
});

describe('listing links of an index written without lists', () => {
  it('are lines of a paragraph that are one link each, split at hard line breaks or <br>', () => {
    const body = [
      'Every weapon, by type.',
      '',
      '### Short',
      '',
      `${to('gauntlet')}  \n${to('talon')}\\\n${to('grey-hand')}`,
      '',
      `${to('cudgel')}<br>**${to('flail')}**<br>${to('maul')} – a heavy hammer`,
      '',
      `![Bow](wiki:picture:bow) ${to('bow')} (rare)`,
      '',
      `${to('axe')} Great Axe`,
    ].join('\n');
    expect(listed(body)).toEqual([
      'gauntlet',
      'talon',
      'grey-hand',
      'cudgel',
      'flail',
      'maul',
      'bow',
      'axe',
    ]);
    expect(isListPage(pageFilingIn(body))).toBe(true);
  });

  it('are headings that are one link and nothing else', () => {
    const body = [
      `### ${to('short')}`,
      `## **${to('heavy')}** ##`,
      `### ${to('rare')} weapons`,
    ].join('\n\n');
    expect(listed(body)).toEqual(['short', 'heavy']);
  });

  it('are runs of links with only separators between them', () => {
    for (const separator of [' · ', ' • ', ' | ', ' / ', ', ', '; ', ' – ', ' - ', '  ']) {
      const body = ['a', 'b', 'c', 'd'].map((local) => to(local)).join(separator);
      expect(listed(body), separator).toEqual(['a', 'b', 'c', 'd']);
    }
    // In a list item too, and over soft line breaks.
    expect(listed(`- ${to('a')} · ${to('b')}\n${to('c')} ·\n${to('d')}`)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('are not links of a line that starts with words, has words between links, or is a trail', () => {
    const body = [
      `Needed for ${to('a')} / ${to('b')}`,
      `See also: ${to('c')}, ${to('d')}`,
      `Sold by ${to('e')}`,
      `${to('f')}, ${to('g')} and ${to('h')}`,
      `${to('home')} › ${to('weapons')} › Sword`,
      `${to('home')} › ${to('weapons')}`,
      `${to('i')} is a short sword.`,
      `${to('j')} is found far away in the north`,
      `||${to('k')}||`,
    ].join('\n\n');
    expect(listed(body)).toEqual([]);
  });

  it('are not the caption under a picture', () => {
    const body = [
      '![Gauntlet](wiki:picture:gauntlet)',
      '',
      to('gauntlet'),
      '',
      `![Talon](wiki:picture:talon)  \n${to('talon')}`,
    ].join('\n');
    expect(listed(body)).toEqual([]);
  });

  it('are each line of a cell of the name column', () => {
    const body = [
      '| Weapons | Type | Where |',
      '| --- | --- | --- |',
      `| ${to('gauntlet')}<br>${to('talon')} | ${to('short')} | ${to('vale')}<br>${to('peak')} |`,
      `| ${to('cudgel')}<br>${to('flail')} · ${to('maul')} | ${to('heavy')} | ${to('vale')} |`,
      `| ${to('bow')} | ${to('bows')} | Sold by ${to('smith')}<br>${to('peak')} |`,
    ].join('\n');
    expect(listed(body)).toEqual(['gauntlet', 'talon', 'cudgel', 'flail', 'maul', 'bow']);
  });
});

describe('a list page', () => {
  const filing = (listing: number, linked: number): PageFiling => ({
    listing: Array.from({ length: listing }, (_, i) => g(`p${i}`)),
    linked,
  });

  it('lists enough pages, and most of the pages it links to', () => {
    expect(isListPage(filing(LIST_PAGE_MIN_LISTED, LIST_PAGE_MIN_LISTED))).toBe(true);
    expect(isListPage(filing(LIST_PAGE_MIN_LISTED - 1, LIST_PAGE_MIN_LISTED - 1))).toBe(false);
    expect(isListPage(filing(60, 80))).toBe(true);
    // An article with a table of things of a type: half of what it links to.
    expect(isListPage(filing(35, 70))).toBe(false);
  });

  it('is not an item page with a box, sentences and a short "See also" list', () => {
    const body = [
      '| Blade | {box} |',
      '| --- | --- |',
      `| Location | ${to('vale')} |`,
      `| Sold by | ${to('smith')} |`,
      `| Made from | ${to('iron')} |`,
      '',
      `Found in ${to('vale')}, sold by ${to('smith')}.`,
      '',
      '## See also',
      '',
      `- ${to('axe')}`,
      `- ${to('bow')}`,
      `- ${to('cudgel')}`,
    ].join('\n');
    const read = pageFilingIn(body);
    expect(read.listing).toHaveLength(3);
    expect(read.linked).toBe(6);
    expect(isListPage(read)).toBe(false);
  });

  it('is not an item page with a table of upgrades and where to get them', () => {
    const body = [
      '| Blade | {box} |',
      '| --- | --- |',
      `| Location | ${to('vale')} |`,
      '',
      `Found in ${to('vale')}.`,
      '',
      '| Level | Cost | Where |',
      '| --- | --- | --- |',
      `| 1 | 10 | ${to('vale')} |`,
      `| 2 | 20 | ${to('smith')} |`,
      '',
      '## See also',
      '',
      `- ${to('axe')}`,
      `- ${to('bow')}`,
    ].join('\n');
    const read = pageFilingIn(body);
    expect(read.listing).toEqual([g('axe'), g('bow')]);
    expect(isListPage(read)).toBe(false);
  });

  it('is not an item page whose "See also" is a paragraph of bare links', () => {
    const body = [
      '| Blade | {box} |',
      '| --- | --- |',
      `| Location | ${to('vale')} |`,
      `| Sold by | ${to('smith')} |`,
      '',
      `Found in ${to('vale')}, made from ${to('iron')} and ${to('coal')}, sold by ${to('smith')}.`,
      '',
      '## See also',
      '',
      `${to('axe')}  \n${to('bow')}  \n${to('cudgel')}`,
      '',
      `${to('dagger')} · ${to('spear')}`,
    ].join('\n');
    const read = pageFilingIn(body);
    expect(read.listing).toHaveLength(5);
    expect(read.linked).toBe(9);
    expect(isListPage(read)).toBe(false);
  });

  it('may be one at a quick look whenever it is one', () => {
    const bodies = [
      [`### ${to('a')}`, `### ${to('b')}`, `### ${to('c')}`].join('\n\n'),
      `${to('a')} · ${to('b')} · ${to('c')}`,
      `| x | y |\n| --- | --- |\n| ${to('a')}<br>${to('b')}<br>${to('c')} | 1 |`,
      `**${to('a')}**  \n_${to('b')}_  \n![p](wiki:picture:p) ${to('c')}`,
    ];
    for (const body of bodies) {
      const read = pageFilingIn(body);
      expect(isListPage(read), body).toBe(true);
      expect(mayBeListPage(body, read.linked), body).toBe(true);
    }
  });
});
