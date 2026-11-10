import type { Location } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { indexPack } from '../pack/loadedPack';
import { makeTestPack, makeTestPackData } from '../testing/packs';
import { SearchIndex, normalizeText } from './searchIndex';

describe('SearchIndex', () => {
  const index = new SearchIndex(makeTestPack());
  const titles = (query: string) => index.search(query).map((hit) => hit.entry.title);

  it('indexes locations, entities and guides', () => {
    // 6 locations, 1 entity, 1 guide.
    expect(index.size).toBe(8);
  });

  it('finds by word prefix, ignoring case and accents', () => {
    expect(titles('moss')).toEqual(['Moss', 'Moss herb', 'Glow moss']);
    expect(titles('GILD')).toEqual(['Gilded chest']);
    expect(normalizeText('Crème Brûlée')).toBe('creme brulee');
    expect(titles('hunters camp')).toEqual(['Hunters’ camp']);
  });

  it('ranks whole-title, then title-prefix, then word-prefix, then substring matches', () => {
    const hits = index.search('chest');
    expect(hits.map((h) => [h.entry.title, h.score])).toEqual([
      ['Damp chest', 2],
      ['Gilded chest', 2],
    ]);
    expect(index.search('moss herb')[0]).toMatchObject({ score: 0 });
    expect(index.search('herb').map((h) => h.entry.title)).toEqual([
      'Herbs',
      'Moss herb',
      'Salt herb',
    ]);
    expect(index.search('erb')[0]?.score).toBe(3);
  });

  it('describes hits and lists the locations they lead to', () => {
    const [entity] = index.search('moss').filter((h) => h.entry.kind === 'entity');
    expect(entity?.entry).toMatchObject({
      detail: 'Item · 2 locations',
      locationIds: ['demo:loc:0001', 'demo:loc:0006'],
    });
    const [guide] = index.search('herbs').filter((h) => h.entry.kind === 'guide');
    expect(guide?.entry.locationIds).toEqual(['demo:loc:0001']);
    const [location] = index.search('glow');
    expect(location?.entry).toMatchObject({
      kind: 'location',
      mapId: 'demo:map:caves',
      detail: 'Herb · Caves',
    });
  });

  it('returns nothing for empty queries and respects the limit', () => {
    expect(index.search('   ')).toEqual([]);
    expect(index.search('e', 2)).toHaveLength(2);
    expect(index.count('chest')).toBe(2);
  });

  it('stays fast with eight thousand locations', () => {
    const data = makeTestPackData();
    const template = data.locations[0]!;
    const words = ['Ember', 'Frost', 'Gale', 'Stone', 'Tide', 'Ash', 'Dawn', 'Mire'];
    const many: Location[] = Array.from({ length: 8000 }, (_, i) => ({
      ...template,
      id: `demo:loc:n${i}`,
      name: `${words[i % words.length]} relic ${i}`,
      guideId: null,
      entityIds: [],
    }));
    data.locations = many;
    data.guides = [];
    data.links = [];
    data.checklistItems = [];

    const started = performance.now();
    const big = new SearchIndex(indexPack(data, new URL('https://x.test/')));
    const buildMs = performance.now() - started;

    const queries = ['e', 'relic', 'frost rel', 'stone relic 79', 'zzz', 'a'];
    const queryStarted = performance.now();
    for (let round = 0; round < 10; round++) for (const q of queries) big.search(q);
    const perQueryMs = (performance.now() - queryStarted) / (10 * queries.length);

    expect(big.search('frost relic 1')[0]?.entry.title).toBe('Frost relic 1');
    expect(big.search('relic')).toHaveLength(50);
    // Generous bounds for slow CI machines; typical values are far lower.
    expect(buildMs).toBeLessThan(1000);
    expect(perQueryMs).toBeLessThan(25);
  });
});
