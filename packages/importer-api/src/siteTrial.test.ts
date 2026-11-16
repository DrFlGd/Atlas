import { describe, expect, it } from 'vitest';
import {
  MAX_TRIAL_ENTRIES,
  MAX_TRIAL_MAPS,
  MAX_TRIAL_PAGE,
  MAX_TRIAL_TYPES,
  siteTrialOf,
  trialPictureId,
} from './siteTrial';

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
});
