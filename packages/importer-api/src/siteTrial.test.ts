import { describe, expect, it } from 'vitest';
import {
  MAX_TRIAL_ENTRIES,
  MAX_TRIAL_MAPS,
  MAX_TRIAL_PAGE,
  MAX_TRIAL_TYPES,
  siteTrialOf,
  trialPictureId,
} from './siteTrial';
import { cannotTryOf } from './index';
import { checkSiteRules, type SiteRules } from './siteRules';

describe('an importer’s answer to a trial', () => {
  it('keeps what it found in a map part’s data, in bounds', () => {
    const trial = siteTrialOf({
      part: 2,
      type: 'map',
      headings: 0,
      problems: ['“locations.fields.picture” (img) matched nothing in the data.'],
      map: {
        maps: {
          count: 3,
          listed: [
            {
              name: 'Harbour',
              width: 4096,
              height: 3072.4,
              locations: 12,
              described: 4,
              linked: 2,
              pictured: 0,
              outside: 1,
              image: 'https://maps.example.org/tiles/harbour/0/0/0.png?v=7',
            },
            {
              name: 'Old Tower, Ground floor',
              width: 1024,
              height: 1024,
              group: 'old-tower',
              floor: 'Ground floor',
              locations: 3,
              image: 'javascript:alert(1)',
            },
            { width: 5 },
            'not a map',
          ],
        },
        types: { count: 2, first: ['Key items', 7, 'Chests'] },
        locations: {
          count: 15,
          first: [
            { name: 'Rusty key', map: 'Harbour', type: 'Key items', x: 1200.04, y: 2210 },
            { name: 'No map', type: 'Chests', x: 1, y: 2 },
            { name: 'Odd', map: 'Harbour', type: 'Chests', x: 'far', y: Infinity },
          ],
        },
      },
    });
    expect(trial?.type).toBe('map');
    expect(trial?.problems).toHaveLength(1);
    expect(trial?.map).toEqual({
      maps: {
        count: 3,
        listed: [
          {
            name: 'Harbour',
            width: 4096,
            height: 3072,
            locations: 12,
            described: 4,
            linked: 2,
            pictured: 0,
            outside: 1,
            image: 'https://maps.example.org/tiles/harbour/0/0/0.png?v=7',
          },
          {
            name: 'Old Tower, Ground floor',
            width: 1024,
            height: 1024,
            group: 'old-tower',
            floor: 'Ground floor',
            locations: 3,
            described: 0,
            linked: 0,
            pictured: 0,
            outside: 0,
          },
        ],
      },
      types: { count: 2, first: ['Key items', 'Chests'] },
      locations: {
        count: 15,
        first: [
          { name: 'Rusty key', map: 'Harbour', type: 'Key items', x: 1200, y: 2210 },
          { name: 'Odd', map: 'Harbour', type: 'Chests', x: 0, y: 0 },
        ],
      },
    });
  });

  it('lists a limited number of maps, and leaves out a map block that is not one', () => {
    const many = Array.from({ length: MAX_TRIAL_MAPS + 5 }, (_, i) => ({ name: `Map ${i}` }));
    const trial = siteTrialOf({ part: 0, type: 'map', map: { maps: { count: 45, listed: many } } });
    expect(trial?.map?.maps.listed).toHaveLength(MAX_TRIAL_MAPS);
    expect(siteTrialOf({ part: 0, type: 'wiki', map: 'no' })?.map).toBeUndefined();
    expect(siteTrialOf({ part: 0, type: 'atlas' })?.type).toBeUndefined();
  });

  it('keeps which types can be ticked as found, by name and in bounds, when the answer says', () => {
    const typesOf = (found: unknown) =>
      siteTrialOf({ part: 0, type: 'map', map: { types: { count: 3, first: [], found } } })?.map
        ?.types;
    expect(typesOf({ can: ['Treasure', 4, ''], cannot: ['Enemies'], byName: false })).toEqual({
      count: 3,
      first: [],
      found: { can: ['Treasure'], cannot: ['Enemies'], byName: false },
    });
    expect(typesOf({ can: 'Treasure', byName: 'yes' })?.found).toEqual({
      can: [],
      cannot: [],
      byName: false,
    });
    expect(typesOf({ cannot: [], can: [], byName: true })?.found?.byName).toBe(true);
    const many = Array.from({ length: MAX_TRIAL_TYPES + 5 }, (_, n) => `Type ${n}`);
    expect(typesOf({ can: many, cannot: many })?.found?.can).toHaveLength(MAX_TRIAL_TYPES);
    expect(typesOf(undefined)).toEqual({ count: 3, first: [] });
    expect(typesOf(['Treasure'])).toEqual({ count: 3, first: [] });
  });

  it('keeps the page as the reader would keep it, its pictures by id and what matched nothing', () => {
    const trial = siteTrialOf({
      part: 0,
      type: 'guide',
      page: '## Getting there\n\nWalk on. ![The quay](trial:picture:1 "=200x100")',
      pictureList: [
        {
          id: trialPictureId(1),
          words: 'The quay',
          address: 'https://guide.example.org/img/quay-small.png',
          full: 'https://guide.example.org/img/quay.png',
          width: 200,
          height: 100,
        },
        { id: trialPictureId(2), words: '', address: 'javascript:alert(1)', width: 0, height: 5 },
        { id: 'https://guide.example.org/img/x.png', words: 'Not a trial picture' },
        'not a picture',
      ],
      chapterTitles: ['Arrival', '', 3, 'The Hills'],
      unmatched: [
        { field: 'parts[0].article.remove[1]', value: '.promo' },
        { field: 'parts[0].article title', value: 'h1' },
        { field: 'site.licence.stated', value: '' },
      ],
      contents: {
        count: 300,
        groups: [],
        first: Array.from({ length: MAX_TRIAL_ENTRIES + 5 }, (_, n) => ({ title: `Page ${n}` })),
      },
    });
    expect(trial?.page).toContain('![The quay](trial:picture:1 "=200x100")');
    expect(trial?.pictureList).toEqual([
      {
        id: 'trial:picture:1',
        words: 'The quay',
        address: 'https://guide.example.org/img/quay-small.png',
        full: 'https://guide.example.org/img/quay.png',
        width: 200,
        height: 100,
      },
      { id: 'trial:picture:2', words: '' },
    ]);
    expect(trial?.chapterTitles).toEqual(['Arrival', 'The Hills']);
    expect(trial?.unmatched).toEqual([{ field: 'parts[0].article.remove[1]', value: '.promo' }]);
    expect(trial?.contents?.first).toHaveLength(MAX_TRIAL_ENTRIES);
    expect(siteTrialOf({ part: 0, page: 'x'.repeat(MAX_TRIAL_PAGE + 10) })?.page).toHaveLength(
      MAX_TRIAL_PAGE,
    );
    const none = siteTrialOf({ part: 0, page: '  ', pictureList: 'no', unmatched: {} });
    expect(none).not.toHaveProperty('page');
    expect(none).not.toHaveProperty('pictureList');
    expect(none).not.toHaveProperty('unmatched');
  });

  it('takes the layout a reader found, in bounds', () => {
    const trial = siteTrialOf({
      part: 0,
      type: 'wiki',
      layout: {
        read: 'stated',
        notes: true,
        sideBySide: 2,
        cards: 3,
        cardTitles: ['Find your way', 7, ' ', 'x'.repeat(300)],
        rows: 1,
        columns: -2,
        centred: 1.5,
        headings: 4,
        hidden: 'many',
        leftOut: 5,
      },
    });
    expect(trial?.layout).toEqual({
      read: 'stated',
      notes: true,
      sideBySide: 2,
      cards: 3,
      cardTitles: ['Find your way', 'x'.repeat(200)],
      rows: 1,
      columns: 0,
      centred: 0,
      headings: 4,
      hidden: 0,
      leftOut: 5,
    });
    expect(siteTrialOf({ part: 0, layout: { read: 'never' } })?.layout).toMatchObject({
      read: 'seen',
      notes: false,
      cards: 0,
    });
    expect(siteTrialOf({ part: 0, layout: 'no' })?.layout).toBeUndefined();
  });
});

describe('a trial read by one of the importer’s own readers', () => {
  it('keeps the reader’s name, the notes and the width of the game’s pages, in bounds', () => {
    const trial = siteTrialOf({
      part: null,
      reader: 'lantern-pages',
      headings: 1,
      notes: [
        'The page was read under the name “Lanterns”, from its heading.',
        7,
        '',
        'y'.repeat(900),
      ],
      layout: { read: 'seen', notes: true, pageWidth: 'wide' },
    });
    expect(trial).toMatchObject({ part: null, reader: 'lantern-pages', headings: 1 });
    expect(trial?.notes).toEqual([
      'The page was read under the name “Lanterns”, from its heading.',
      'y'.repeat(500),
    ]);
    expect(trial?.layout?.pageWidth).toBe('wide');
    // A name that is no reader's, or a width the format does not have, is left out.
    const odd = siteTrialOf({
      part: 0,
      reader: 'Not a name!',
      layout: { read: 'seen', pageWidth: 'giant' },
    });
    expect(odd?.reader).toBeUndefined();
    expect(odd?.layout && 'pageWidth' in odd.layout).toBe(false);
    expect(siteTrialOf({ part: 0, reader: 'x'.repeat(61) })?.reader).toBeUndefined();
  });
});

describe('whether an importer can try a file', () => {
  const file = (reader: string): SiteRules => {
    const checked = checkSiteRules({
      format: 'atlas-site-rules',
      version: 1,
      site: { id: 'reed-wiki', name: 'Reed Wiki', game: 'Reeds', hosts: ['wiki.reed.example'] },
      parts: [
        reader === 'rules'
          ? {
              type: 'wiki',
              reader,
              start: '/',
              pages: { include: ['/**'] },
              contents: { from: 'sitemap' },
              article: { content: 'main article' },
              reading: { ways: ['fetch'] },
            }
          : { type: 'wiki', reader, start: '/' },
      ],
    });
    if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
    return checked.rules;
  };
  const tryPage = () => Promise.resolve({});

  it('is the importer’s to say, in its own sentence', () => {
    const own = file('lantern-pages');
    expect(
      cannotTryOf(
        { sites: { readers: [], files: [], tryPage, cannotTry: () => null } } as never,
        own,
      ),
    ).toBeNull();
    expect(
      cannotTryOf(
        {
          sites: { readers: [], files: [], tryPage, cannotTry: () => '  It reads no pages.  ' },
        } as never,
        own,
      ),
    ).toBe('It reads no pages.');
    for (const odd of [
      () => 7,
      () => '',
      () => {
        throw new Error('no');
      },
    ]) {
      expect(
        cannotTryOf({ sites: { readers: [], files: [], tryPage, cannotTry: odd } } as never, own),
      ).toBe('This importer could not say whether it can try this file.');
    }
    expect(cannotTryOf({ sites: { readers: [], files: [] } } as never, own)).toBe(
      'This importer cannot try a file on a saved page.',
    );
  });

  it('is a part read by rules only, for an importer that does not say', () => {
    const sites = { readers: ['rules', 'lantern-pages'], files: [], tryPage };
    expect(cannotTryOf({ sites } as never, file('rules'))).toBeNull();
    expect(cannotTryOf({ sites } as never, file('lantern-pages'))).toBe(
      'This importer can try only a part read by rules on a saved page.',
    );
  });
});
