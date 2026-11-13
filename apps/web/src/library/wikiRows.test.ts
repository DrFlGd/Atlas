import { describe, expect, it } from 'vitest';
import { NO_WIKI_NOTES, type WikiNotes } from '../state/wikiNotes';
import { allRows, readWhen, readingTime, wikiGroups } from './wikiRows';

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

describe('words', () => {
  it('says how long reading takes', () => {
    expect(readingTime(3)).toBe('Less than a minute');
    expect(readingTime(112)).toBe('About 9 minutes');
    expect(readingTime(2000)).toBe('About 3 hours');
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
