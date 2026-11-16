import { NO_OWN_PAGES, withoutLayoutMarkers, type GuideEntry } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { locationParts } from '../checklists/planBuild';
import { plainNote } from '../checklists/views';
import { guidePlainText } from './guideText';
import { firstPictureIn } from './landing';
import { savePage } from './ownPages';
import { pageFilingIn } from './pageFiling';
import { guideLinksIn } from './pageTree';

/**
 * Every reader of page text in this package reads a page with layout
 * forms (see `layoutForms.ts` in `@atlas/schema`) as its blocks in reading
 * order, and never takes a marker line for words of the page.
 */

const page = (id: string) => `demo:guide:${id}`;
const blocks = (...parts: string[]) => parts.join('\n\n');

/** A home page laid out as a wiki's: a menu beside the text, cards, a row, columns. */
const HOME = blocks(
  '::: side 1:3',
  '::: card',
  '### Menu',
  `- [Bells](${page('bells')})\n- [Gates](${page('gates')})\n- [Wells](${page('wells')})`,
  '::: end',
  '::: next',
  '::: centred',
  'Welcome to the made-up isle.',
  '::: end',
  '::: side',
  '::: card',
  '### Weapons',
  '::: row',
  `- [Dirk](${page('dirk')})\n- [Maul](${page('maul')})\n- [Bow](${page('bow')})`,
  '::: end',
  '::: end',
  '::: next',
  '::: card',
  '### Where to find',
  'Under the old mill.',
  '![a stone](demo:picture:stone)',
  '::: end',
  '::: end',
  '::: columns 3',
  `- [Moss](${page('moss')})\n- [Reed](${page('reed')})\n- [Fern](${page('fern')})`,
  '::: end',
  '::: end',
);

describe('readers of page text with layout forms', () => {
  it('searches and quotes the words, never a marker line', () => {
    const text = guidePlainText(HOME);
    expect(text).not.toContain(':::');
    expect(text).not.toMatch(/\b(side|next|end|centred|columns)\b/u);
    expect(
      text.startsWith('Menu Bells Gates Wells Welcome to the made-up isle. Weapons Dirk'),
    ).toBe(true);
    // A marker that is no marker is text, as the page shows it.
    expect(guidePlainText('::: card\n\nNever closed.')).toBe('::: card Never closed.');
  });

  it('takes the first paragraph of a note after the marker lines', () => {
    expect(plainNote(blocks('::: centred', 'In the **middle**.', '::: end'))).toBe(
      'In the middle.',
    );
    expect(plainNote(HOME)).toBe('Menu');
  });

  it('lists the pages of a list page laid out in forms, under their card titles', () => {
    const filing = pageFilingIn(HOME, page('home'));
    expect(filing.listing).toEqual([
      page('bells'),
      page('gates'),
      page('wells'),
      page('dirk'),
      page('maul'),
      page('bow'),
      page('moss'),
      page('reed'),
      page('fern'),
    ]);
    expect(filing.headings?.map((heading) => heading.words)).toEqual([
      'Menu',
      'Weapons',
      'Where to find',
    ]);
    // Each under the title of its card; a card's title holds its card only.
    expect(filing.listedUnder).toEqual([0, 0, 0, 1, 1, 1, -1, -1, -1]);
    expect(pageFilingIn(withoutLayoutMarkers(HOME), page('home')).listing).toEqual(filing.listing);
  });

  it('finds the links between pages and the first picture inside forms', () => {
    expect(guideLinksIn(HOME, page('home'))).toHaveLength(9);
    expect(firstPictureIn(HOME)).toBe('demo:picture:stone');
  });

  it('reads where a thing is in a card, for the build planner', () => {
    // The part under the card's title ends with the card.
    expect(locationParts(HOME).texts).toEqual(['Under the old mill.']);
    expect(locationParts(withoutLayoutMarkers(HOME)).texts).toEqual([
      'Under the old mill.',
      'Moss',
      'Reed',
      'Fern',
    ]);
  });

  it('keeps a page saved as it was as no change', () => {
    const pack: GuideEntry = { id: page('home'), title: 'Home', body: HOME, locationIds: [] };
    const own = savePage(NO_OWN_PAGES, pack, pack.id, 'Home', HOME, new Date(0));
    expect(own.pages).toEqual([]);
  });
});
