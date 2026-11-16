import { describe, expect, it } from 'vitest';
import { MAX_TRIAL_MAPS, siteTrialOf } from './siteTrial';

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
});
