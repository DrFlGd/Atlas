import { describe, expect, it } from 'vitest';
import { LocationNameIndex, type NamedLocation } from './locationNames';

/** Made-up locations of a made-up map. */
const LOCATIONS: NamedLocation[] = [
  { id: 'isle:loc:1', name: 'Frost wyrm 1' },
  { id: 'isle:loc:2', name: 'Frost wyrm 2' },
  { id: 'isle:loc:3', name: 'Frost wyrm 3' },
  { id: 'isle:loc:4', name: 'Sunken shrine 3' },
  { id: 'isle:loc:5', name: 'Sunken shrine 4' },
  { id: 'isle:loc:6', name: 'The Old Mill' },
  { id: 'isle:loc:7', name: 'Iron-bound chest 7' },
  { id: 'isle:loc:8', name: 'Moonpetal 1' },
  { id: 'isle:loc:9', name: 'Moonpetal 2' },
  { id: 'isle:loc:10', name: 'Hunters’ camp' },
];

const index = new LocationNameIndex(LOCATIONS);
const ids = (hits: readonly { ids: readonly string[] }[]) =>
  hits.flatMap((hit) => hit.ids.map((id) => id.split(':').at(-1)));

describe('finding locations by name', () => {
  it('finds the location of a name with its number, and every one of a name without', () => {
    expect(ids(index.find('Frost wyrm 2'))).toEqual(['2']);
    expect(ids(index.find('Frost wyrm'))).toEqual(['1', '2', '3']);
    expect(index.find('Frost wyrm')[0]).toMatchObject({ name: 'Frost wyrm', exact: true });
    // A number the map does not have: every location of the name.
    expect(ids(index.find('Frost wyrm 9'))).toEqual(['1', '2', '3']);
  });

  it('does not mind case, punctuation, a leading article or a plural', () => {
    expect(ids(index.find('frost WYRMS'))).toEqual(['1', '2', '3']);
    expect(ids(index.find('old mill'))).toEqual(['6']);
    expect(ids(index.find('Ironbound chest 7'))).toEqual(['7']);
    expect(ids(index.find("Hunters' camp"))).toEqual(['10']);
  });

  it('allows a letter wrong, and says it is not the same name', () => {
    const hit = index.find('Frost wirm')[0];
    expect(hit?.exact).toBe(false);
    expect(hit?.score).toBeGreaterThanOrEqual(0.8);
    expect(ids(index.find('Frost wirm'))).toEqual(['1', '2', '3']);
  });

  it('finds nothing for a name that only shares a word', () => {
    expect(index.find('Frost charm')).toEqual([]);
    expect(index.find('')).toEqual([]);
    expect(index.find('Copper kettle')).toEqual([]);
  });
});

describe('location names written in a text', () => {
  it('reads the longest name at each word, with its number when it has one', () => {
    const hits = index.namesIn(
      'It lies in Sunken shrine 3, past the old mill. Frost wyrms guard it.',
    );
    expect(hits.map((hit) => hit.name)).toEqual(['Sunken shrine 3', 'The Old Mill', 'Frost wyrm']);
    expect(ids(hits)).toEqual(['4', '6', '1', '2', '3']);
  });

  it('reads each name once, and never a small word or a number alone', () => {
    expect(ids(index.namesIn('Moonpetal, moonpetal and more moonpetals'))).toEqual(['8', '9']);
    expect(index.namesIn('Of the 3 of them')).toEqual([]);
    expect(index.namesIn('A merchant sells it at random.')).toEqual([]);
  });
});
