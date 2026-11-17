import { describe, expect, it } from 'vitest';
import { LISTING_WORDS_MAX, guideFiling, pageFilingIn } from './pageFiling';

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

describe('the headings of a listing', () => {
  it('say what each listed page is first listed under, with the section each opens', () => {
    const body = [
      '# Self',
      `- ${to('a')}`,
      '## Weapons',
      `### ${to('blades', 'Short Blades')}`,
      '#### List of short blades',
      `- ${to('b')}`,
      `- ${to('c')}`,
      '### Bows',
      `- ${to('d')}`,
      '## Weapons',
      `- ${to('e')}`,
      `- ${to('b')}`,
      `## ${to('self', 'Self again')}`,
      `- ${to('f')}`,
    ].join('\n');
    const filing = pageFilingIn(body, g('self'));
    // A heading ends the list item above it, blank line or not.
    expect(filing.listing.map((id) => id.slice(11))).toEqual([
      'a',
      'blades',
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
    expect(filing.headings).toEqual([
      { level: 1, words: 'Self', section: 'self', guide: null },
      { level: 2, words: 'Weapons', section: 'weapons', guide: null },
      { level: 3, words: 'Short Blades', section: 'short-blades', guide: g('blades') },
      { level: 4, words: 'List of short blades', section: 'list-of-short-blades', guide: null },
      { level: 3, words: 'Bows', section: 'bows', guide: null },
      // A second heading of the same words opens its own section.
      { level: 2, words: 'Weapons', section: 'weapons-2', guide: null },
      // A heading that links to the page itself links to no other page.
      { level: 2, words: 'Self again', section: 'self-again', guide: null },
    ]);
    // The heading that is a link lists its page under the heading above it;
    // a page listed twice is under the heading it is first listed under.
    expect(filing.listedUnder).toEqual([0, 1, 3, 3, 4, 5, 6]);
  });

  it('are none on a page with no headings', () => {
    const filing = pageFilingIn(`- ${to('a')}\n- ${to('b')}`, g('self'));
    expect(filing.headings).toEqual([]);
    expect(filing.listedUnder).toEqual([-1, -1]);
  });
});

describe('what a page lists among what it mentions', () => {
  it('is the "See also" list of an item page, not its box or its sentences', () => {
    const body = [
      '| Blade | {box} |',
      '| --- | --- |',
      `| Location | ${to('vale')} |`,
      `| Sold by | ${to('smith')} |`,
      '',
      `Found in ${to('vale')}, sold by ${to('smith')}.`,
      '',
      '| Level | Cost | Where |',
      '| --- | --- | --- |',
      `| 1 | 10 | ${to('vale')} |`,
      `| 2 | 20 | ${to('peak')} |`,
      '',
      '## See also',
      '',
      `- ${to('axe')}`,
      `- ${to('bow')}`,
    ].join('\n');
    const read = pageFilingIn(body);
    expect(read.listing).toEqual([g('axe'), g('bow')]);
    expect(read.linked).toBe(5);
  });

  it('is the names of an index whose rows name where each thing is found and who drops it', () => {
    const things = ['dirk', 'kris', 'stiletto', 'shiv', 'cutter'];
    const body = [
      `All the short blades. Most are sold by ${to('smith')}.`,
      '',
      '| Icon | Name | Found at | Dropped by |',
      '| --- | --- | --- | --- |',
      ...things.map(
        (thing, i) =>
          `| [![${thing}](wiki:picture:${thing})](${g(thing)}) | ${to(thing)} | Near the gate of ${to(`vale-${i}`)} | ${to(`ghoul-${i}`)} |`,
      ),
    ].join('\n');
    const read = pageFilingIn(body, g('self'));
    expect(read.listing.map((id) => id.slice(11))).toEqual(things);
    expect(read.linked).toBe(16);
  });

  it('is the three things a boss page drops, not the pages its prose names', () => {
    const body = [
      `The Mire Tyrant rules the bog below ${to('bog')}, guarded by ${to('ghoul')} and ${to('wisp')}.`,
      '',
      '## Drops',
      '',
      '| Item | Chance | Also from |',
      '| --- | --- | --- |',
      `| ${to('dirk')} | 10% | ${to('ghoul')} |`,
      `| ${to('kris')} | 5% | ${to('wisp')} |`,
      `| ${to('longbow')} | 1% | ${to('crow')} |`,
    ].join('\n');
    expect(listed(body)).toEqual(['dirk', 'kris', 'longbow']);
  });

  it('is read once per page, and is nothing for a page that links to none', () => {
    const guide = {
      id: g('index'),
      title: 'Index',
      body: `- ${to('a')}\n- ${to('b')}`,
      locationIds: [],
    };
    const read = guideFiling(guide);
    expect(read.listing).toEqual([g('a'), g('b')]);
    expect(guideFiling(guide)).toBe(read);
    expect(pageFilingIn('No links at all.')).toEqual({ listing: [], linked: 0 });
  });
});
