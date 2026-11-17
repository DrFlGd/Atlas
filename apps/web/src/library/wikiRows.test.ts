import { describe, expect, it } from 'vitest';
import { selectShown } from '../state/selectShown';
import { NO_WIKI_NOTES, type WikiNotes } from '../state/wikiNotes';
import {
  allRows,
  headingPages,
  headingTick,
  readLabel,
  readWhen,
  readingTime,
  selectText,
  shownGroup,
  shownPages,
  wikiGroups,
  type WikiFilter,
  type WikiGroup,
} from './wikiRows';

const WIKI = 'https://wiki.example.org/wiki';

const contents = {
  address: `${WIKI}/Contents`,
  game: 'Example Wiki',
  readAt: '2026-11-13T09:00:00Z',
  pages: [
    { url: `${WIKI}/Welcome`, title: 'Welcome', group: 'Basics' },
    { url: `${WIKI}/Bells`, title: 'Bells', group: 'Basics' },
    { url: `${WIKI}/Harbour`, title: 'Harbour', group: 'Places' },
    { url: `${WIKI}/Missing`, title: 'Missing', group: 'Places' },
  ],
};

describe('the rows of the wiki screen', () => {
  it('lists the contents by heading, each page with where it stands', () => {
    const notes: WikiNotes = {
      ...NO_WIKI_NOTES,
      failed: {
        [`https://wiki.example.org/wiki/Missing`]: {
          url: `${WIKI}/Missing`,
          message: 'The wiki has no such page.',
          at: '2026-11-13T09:05:00Z',
        },
      },
      links: { 'https://wiki.example.org/wiki/Welcome': [`${WIKI}/Bells`, `${WIKI}/Old_bell`] },
      leftOut: ['https://wiki.example.org/wiki/Harbour'],
    };
    const groups = wikiGroups({
      contents,
      read: [
        { url: `${WIKI}/Welcome/`, importedAt: '2026-11-13T09:01:00Z' },
        { url: `${WIKI}/Notes`, importedAt: '2026-11-13T09:02:00Z' },
      ],
      guides: [
        {
          id: 'example-wiki:guide:notes',
          title: 'Notes',
          url: `${WIKI}/Notes`,
          section: 'Extras',
          changedByYou: true,
        },
      ],
      notes,
    });
    expect(groups.map((group) => group.title)).toEqual(['Basics', 'Places', 'Extras']);
    const states = Object.fromEntries(allRows(groups).map((row) => [row.title, row.state]));
    expect(states).toEqual({
      Welcome: 'read',
      Bells: 'not-read',
      Harbour: 'left-out',
      Missing: 'failed',
      Notes: 'read',
      // Linked from Welcome, not in the contents: found there.
      'Old bell': 'not-read',
    });
    expect(groups[0]!.found).toHaveLength(1);
    expect(groups[0]!.found[0]!.from.title).toBe('Welcome');
    expect(groups[0]!.found[0]!.pages.map((page) => page.url)).toEqual([`${WIKI}/Old_bell`]);
    expect(allRows(groups).find((row) => row.title === 'Notes')!.changedByYou).toBe(true);
  });

  it('lists the pages read when the contents were never read', () => {
    const groups = wikiGroups({
      contents: null,
      read: [{ url: `${WIKI}/Welcome` }],
      guides: [],
      notes: NO_WIKI_NOTES,
    });
    expect(allRows(groups).map((row) => [row.title, row.group, row.state])).toEqual([
      ['Welcome', 'Other pages', 'read'],
    ]);
  });
});

describe('the box of a heading', () => {
  /** Basics: Welcome and Bells read, Gates left out; Welcome links to two pages the contents do not list. */
  const groups = () =>
    wikiGroups({
      contents: {
        ...contents,
        pages: [
          { url: `${WIKI}/Welcome`, title: 'Welcome', group: 'Basics' },
          { url: `${WIKI}/Bells`, title: 'Bells', group: 'Basics' },
          { url: `${WIKI}/Gates`, title: 'Gates', group: 'Basics' },
          { url: `${WIKI}/Harbour`, title: 'Harbour', group: 'Places' },
        ],
      },
      read: [{ url: `${WIKI}/Welcome` }, { url: `${WIKI}/Bells` }],
      guides: [],
      notes: {
        ...NO_WIKI_NOTES,
        links: {
          'https://wiki.example.org/wiki/Welcome': [
            `${WIKI}/Old_bell`,
            `${WIKI}/Rusty_gate`,
            `${WIKI}/Gates`,
          ],
        },
        leftOut: [
          'https://wiki.example.org/wiki/Gates',
          'https://wiki.example.org/wiki/Rusty_gate',
        ],
      },
    });
  /** The heading as the wiki screen shows it with `filter`. */
  const shown = (group: WikiGroup, filter: WikiFilter): WikiGroup => shownGroup(group, filter);

  it('ticks the pages listed and those found on them, read or not, never one left out', () => {
    const basics = groups()[0]!;
    expect(basics.title).toBe('Basics');
    // Every page listed under it that is not left out was read; the box still ticks, with the page found.
    expect(basics.rows.filter((row) => row.state !== 'read').map((row) => row.state)).toEqual([
      'left-out',
    ]);
    const pages = headingPages(shown(basics, 'all'));
    expect(pages.map((row) => row.title)).toEqual(['Welcome', 'Bells', 'Old bell']);
    expect(headingTick(pages, new Set()).disabled).toBe(false);
  });

  it('with a filter on, ticks only what the filter shows under it', () => {
    const basics = groups()[0]!;
    expect(headingPages(shown(basics, 'not-read')).map((row) => row.title)).toEqual(['Old bell']);
    expect(headingPages(shown(basics, 'read')).map((row) => row.title)).toEqual([
      'Welcome',
      'Bells',
    ]);
    expect(headingPages(shown(basics, 'left-out'))).toEqual([]);
    expect(headingTick([], new Set()).disabled).toBe(true);
  });

  it('is ticked when all its pages are, in between when some are', () => {
    const pages = headingPages(groups()[0]!);
    const keys = pages.map((row) => row.key);
    expect(headingTick(pages, new Set())).toEqual({
      checked: false,
      indeterminate: false,
      disabled: false,
    });
    expect(headingTick(pages, new Set(keys.slice(0, 1)))).toEqual({
      checked: false,
      indeterminate: true,
      disabled: false,
    });
    expect(headingTick(pages, new Set(keys))).toEqual({
      checked: true,
      indeterminate: false,
      disabled: false,
    });
  });
  it('Tick all and Tick none act on every page the filter shows, under every heading, never one left out', () => {
    const titles = (filter: WikiFilter) => shownPages(groups(), filter).map((row) => row.title);
    expect(titles('all')).toEqual(['Welcome', 'Bells', 'Old bell', 'Harbour']);
    expect(titles('not-read')).toEqual(['Old bell', 'Harbour']);
    expect(titles('read')).toEqual(['Welcome', 'Bells']);
    expect(titles('left-out')).toEqual([]);
    // The same as every heading's box, all together.
    expect(shownPages(groups(), 'all')).toEqual(
      groups().flatMap((group) => headingPages(shown(group, 'all'))),
    );
  });
});

describe('Tick all and Tick none on the wiki screen', () => {
  it('act on every page of a heading, not only the 200 it shows at first', () => {
    const pages = Array.from({ length: 450 }, (_, i) => ({
      url: `${WIKI}/Item_${i}`,
      title: `Item ${i}`,
      group: 'Items',
    }));
    const groups = wikiGroups({
      contents: { ...contents, pages },
      read: [],
      guides: [],
      notes: NO_WIKI_NOTES,
    });
    const keys = shownPages(groups, 'all').map((row) => row.key);
    expect(keys).toHaveLength(450);
    const some = new Set(keys.slice(0, 10));
    const selection = selectShown(keys, some);
    expect(selection).toMatchObject({ shown: 450, ticked: 10 });
    expect(selection.toTick).toHaveLength(440);
    expect(selection.toUntick).toHaveLength(10);
    expect(selectText(selection, 'all')).toBe('The list has 450 pages to tick, 10 of them ticked.');
    expect(selectText(selection, 'not-read')).toBe(
      'This filter shows 450 pages to tick, 10 of them ticked.',
    );
  });

  it('say what they act on, in words', () => {
    expect(selectText({ shown: 0, ticked: 0 }, 'left-out')).toBe(
      'This filter shows no page to tick: every page it shows is left out.',
    );
    expect(selectText({ shown: 0, ticked: 0 }, 'all')).toBe(
      'The list has no page to tick: every page in it is left out.',
    );
    expect(selectText({ shown: 1, ticked: 1 }, 'all')).toBe(
      'The list has 1 page to tick, and it is ticked.',
    );
    expect(selectText({ shown: 1, ticked: 0 }, 'read')).toBe(
      'This filter shows 1 page to tick, not ticked yet.',
    );
    expect(selectText({ shown: 1200, ticked: 1200 }, 'all')).toBe(
      'The list has 1,200 pages to tick, all of them ticked.',
    );
    expect(selectText({ shown: 3, ticked: 0 }, 'failed')).toBe(
      'This filter shows 3 pages to tick, none of them ticked.',
    );
  });
});

describe('words', () => {
  it('says how long reading takes', () => {
    expect(readingTime(3)).toBe('Less than a minute');
    expect(readingTime(112)).toBe('About 9 minutes');
    expect(readingTime(2000)).toBe('About 3 hours');
    // Pages read in the window kept for a go: about 2 seconds a page.
    expect(readingTime(900, true)).toBe('About 30 minutes');
    expect(readingTime(20, true)).toBe('Less than a minute');
  });

  it('says when a page was read', () => {
    const now = new Date('2026-11-13T18:00:00');
    expect(readWhen(new Date('2026-11-13T06:14:00').toISOString(), now)).toMatch(
      /^Read today at 6:14\sAM$/u,
    );
    expect(readWhen('2026-05-03T10:00:00Z', now)).toBe('Read on 3 May 2026');
    expect(readWhen(null, now)).toBe('Read');
  });
});

describe('a wiki with a thousand pages found by links', () => {
  it('lists them, found on the pages that link to them, quickly enough to work out after every page', () => {
    // One page that links to 932 others, each of which was read and links to 100 more.
    const list = Array.from({ length: 932 }, (_, i) => `${WIKI}/Item_${i}`);
    const links: Record<string, string[]> = { [`https://wiki.example.org/wiki/Items`]: list };
    const read = [{ url: `${WIKI}/Items`, importedAt: '2026-11-13T09:00:00Z' }];
    for (let i = 0; i < 932; i++) {
      read.push({ url: list[i]!, importedAt: '2026-11-13T09:00:00Z' });
      links[`https://wiki.example.org/wiki/Item_${i}`] = Array.from(
        { length: 100 },
        (_, j) => `${WIKI}/Detail_${(i * 7 + j) % 1200}`,
      );
    }
    const notes: WikiNotes = { ...NO_WIKI_NOTES, links };
    const work = () => wikiGroups({ contents, read, guides: [], notes });
    work();
    const started = performance.now();
    const groups = work();
    const took = performance.now() - started;
    const rows = allRows(groups);
    // The contents, the pages read, and every detail page found once.
    expect(rows).toHaveLength(4 + 933 + 1200);
    expect(rows.filter((row) => row.state === 'read')).toHaveLength(933);
    expect(took).toBeLessThan(1000);
  });
});

describe('the main button of the page list', () => {
  it('reads "Read pages" while nothing is ticked, and keeps its count once pages are', () => {
    expect(readLabel(0)).toBe('Read pages');
    expect(readLabel(1)).toBe('Read 1 page');
    expect(readLabel(3)).toBe('Read 3 pages');
    expect(readLabel(1200)).toBe('Read 1,200 pages');
  });
});
