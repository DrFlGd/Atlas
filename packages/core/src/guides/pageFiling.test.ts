import { describe, expect, it } from 'vitest';
import {
  LIST_PAGE_MIN_LISTED,
  LISTING_WORDS_MAX,
  isListPage,
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

  it('are not links in sentences, headings, quotes or code', () => {
    const body = [
      `A sentence about ${to('a')}.`,
      `${to('b')} starts a sentence.`,
      `## ${to('c')}`,
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
      `| ${to('club')} | Club | Drops from ${to('ogre')} |`,
    ].join('\n');
    expect(listed(body)).toEqual(['blade', 'axe', 'bow', 'club']);
  });

  it('are the column of the most different pages, the one further left on a tie', () => {
    // A first column of the location, each row another weapon in the second.
    const byLocation = [
      '| Location | Weapon |',
      '| --- | --- |',
      `| ${to('vale')} | ${to('blade')} |`,
      `| ${to('vale')} | ${to('axe')} |`,
      `| ${to('peak')} | ${to('bow')} |`,
    ].join('\n');
    expect(listed(byLocation)).toEqual(['blade', 'axe', 'bow']);
    const tie = [
      '| A | B |',
      '| --- | --- |',
      `| ${to('a1')} | ${to('b1')} |`,
      `| ${to('a2')} | ${to('b2')} |`,
    ].join('\n');
    expect(listed(tie)).toEqual(['a1', 'a2']);
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
      `- ${to('club')}`,
    ].join('\n');
    const read = pageFilingIn(body);
    expect(read.listing).toHaveLength(3);
    expect(read.linked).toBe(6);
    expect(isListPage(read)).toBe(false);
  });
});
