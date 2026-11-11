import { describe, expect, it } from 'vitest';
import { indexPack } from '../pack/loadedPack';
import { ProgressCounter } from '../progress/counters';
import { makeTestPackData } from '../testing/packs';
import { ChecklistIndex, checklistTally, itemState, tickChanges } from './checklists';
import { NONE, countFacets, filterChecklist, itemFacets } from './facets';

function makeSetup() {
  const data = makeTestPackData();
  data.checklists.push(
    { id: 'demo:checklist:steps', name: 'Story', order: -1, description: 'Main story.' },
    { id: 'demo:checklist:empty', name: 'Nothing yet', order: 5 },
  );
  const base = { checklistId: 'demo:checklist:herbs', entityIds: [] };
  data.checklistItems.push(
    // Two herbs on two maps.
    {
      ...base,
      id: 'demo:checkitem:all-herbs',
      name: 'Every herb',
      order: 2,
      locationIds: ['demo:loc:0002', 'demo:loc:0006', 'demo:loc:0002'],
    },
    // A camp cannot be marked found, so the item has a mark of its own.
    {
      ...base,
      id: 'demo:checkitem:camp',
      name: 'Rest at camp',
      order: 1,
      locationIds: ['demo:loc:0004'],
    },
    // A chest and a camp: only the chest counts.
    {
      ...base,
      id: 'demo:checkitem:mixed',
      name: 'Chest by the camp',
      order: 3,
      locationIds: ['demo:loc:0003', 'demo:loc:0004'],
    },
    {
      ...base,
      checklistId: 'demo:checklist:steps',
      id: 'demo:checkitem:step-b',
      name: 'B step',
      order: 0,
      locationIds: [],
      section: 'Chapter 1',
    },
    {
      ...base,
      checklistId: 'demo:checklist:steps',
      id: 'demo:checkitem:step-a',
      name: 'A step',
      order: 0,
      locationIds: [],
    },
  );
  data.guides.push(
    { id: 'demo:guide:walk', title: 'Walkthrough', body: 'Go.', locationIds: [], order: 2 },
    { id: 'demo:guide:intro', title: 'Introduction', body: 'Hi.', locationIds: [], order: 1 },
    {
      id: 'demo:guide:chests',
      title: 'All the chests',
      body: '',
      locationIds: ['demo:loc:0003', 'demo:loc:0005'],
    },
    { id: 'demo:guide:b', title: 'Bonus 10', body: '', locationIds: [] },
    { id: 'demo:guide:a', title: 'Bonus 9', body: '', locationIds: [] },
  );
  // A guide named by two locations is shared, so it is listed too.
  data.guides.push({ id: 'demo:guide:salt', title: 'Salt', body: '', locationIds: [] });
  data.locations[1]!.guideId = 'demo:guide:salt';
  data.locations[2]!.guideId = 'demo:guide:salt';
  const pack = indexPack(data, new URL('https://x.test/'));
  const counter = new ProgressCounter(pack);
  return { pack, index: new ChecklistIndex(pack, (id) => counter.isTrackable(id)) };
}

const makeIndex = () => makeSetup().index;

const doneSet = (ids: string[]) => {
  const set = new Set(ids);
  return (id: string) => set.has(id);
};

describe('ChecklistIndex', () => {
  const index = makeIndex();

  it('orders checklists and items by order, then name', () => {
    expect(index.checklists.map((c) => c.checklist.name)).toEqual([
      'Story',
      'Herbs',
      'Nothing yet',
    ]);
    expect(index.checklist('demo:checklist:herbs')!.items.map((i) => i.item.name)).toEqual([
      'Pick moss',
      'Rest at camp',
      'Every herb',
      'Chest by the camp',
    ]);
    expect(index.checklist('demo:checklist:steps')!.items.map((i) => i.item.name)).toEqual([
      'A step',
      'B step',
    ]);
    expect(index.item('demo:checkitem:camp')!.index).toBe(1);
    expect(index.checklistOf('demo:checkitem:step-b')?.checklist.id).toBe('demo:checklist:steps');
  });

  it('separates trackable locations from places to show only', () => {
    expect(index.item('demo:checkitem:all-herbs')).toMatchObject({
      targets: ['demo:loc:0002', 'demo:loc:0006'],
      places: ['demo:loc:0002', 'demo:loc:0006'],
      ownMark: false,
    });
    expect(index.item('demo:checkitem:camp')).toMatchObject({
      targets: [],
      places: ['demo:loc:0004'],
      ownMark: true,
    });
    expect(index.item('demo:checkitem:mixed')).toMatchObject({
      targets: ['demo:loc:0003'],
      places: ['demo:loc:0003', 'demo:loc:0004'],
      ownMark: false,
    });
    expect(index.item('demo:checkitem:step-a')).toMatchObject({ places: [], ownMark: true });
    expect(index.itemsAt('demo:loc:0004').map((i) => i.item.id)).toEqual([
      'demo:checkitem:camp',
      'demo:checkitem:mixed',
    ]);
  });

  it('lists guides that are not the note of one location, in order', () => {
    expect(index.guides.map((g) => g.title)).toEqual([
      'Introduction',
      'Walkthrough',
      'All the chests',
      'Bonus 9',
      'Bonus 10',
      'Salt',
    ]);
    // The fixture's herb guide belongs to one location only.
    expect(index.isListed('demo:guide:herbs')).toBe(false);
    expect(index.guide('demo:guide:herbs')?.title).toBe('Herbs');
    expect(index.isListed('demo:guide:salt')).toBe(true);
    expect(index.guidesAt('demo:loc:0005').map((g) => g.id)).toEqual(['demo:guide:chests']);
    expect(index.isEmpty).toBe(false);
  });

  it('is empty for a pack without checklists or listed guides', () => {
    const data = makeTestPackData();
    data.checklists = [];
    data.checklistItems = [];
    const pack = indexPack(data, new URL('https://x.test/'));
    expect(new ChecklistIndex(pack, () => true).isEmpty).toBe(true);
  });
});

describe('done rules', () => {
  const index = makeIndex();
  const herbs = index.item('demo:checkitem:all-herbs')!;
  const camp = index.item('demo:checkitem:camp')!;
  const mixed = index.item('demo:checkitem:mixed')!;

  it('derives an item with locations from its found marks', () => {
    expect(itemState(herbs, doneSet([]))).toEqual({ done: false, found: 0, total: 2 });
    expect(itemState(herbs, doneSet(['demo:loc:0006']))).toEqual({
      done: false,
      found: 1,
      total: 2,
    });
    expect(itemState(herbs, doneSet(['demo:loc:0002', 'demo:loc:0006'])).done).toBe(true);
    // Its own id means nothing for an item with locations.
    expect(itemState(herbs, doneSet([herbs.item.id])).done).toBe(false);
    // Locations that cannot be marked do not count.
    expect(itemState(mixed, doneSet(['demo:loc:0003']))).toEqual({
      done: true,
      found: 1,
      total: 1,
    });
  });

  it('uses the own mark of an item without trackable locations', () => {
    expect(itemState(camp, doneSet([]))).toEqual({ done: false, found: 0, total: 1 });
    expect(itemState(camp, doneSet([camp.item.id]))).toEqual({ done: true, found: 1, total: 1 });
  });

  it('ticking marks only the missing locations; unticking unmarks all of them', () => {
    const someFound = doneSet(['demo:loc:0006']);
    expect(tickChanges(herbs, true, someFound)).toEqual([
      { targetId: 'demo:loc:0002', found: true },
    ]);
    expect(tickChanges(herbs, false, someFound)).toEqual([
      { targetId: 'demo:loc:0006', found: false },
    ]);
    const allFound = doneSet(['demo:loc:0002', 'demo:loc:0006']);
    expect(tickChanges(herbs, true, allFound)).toEqual([]);
    expect(tickChanges(herbs, false, allFound)).toEqual([
      { targetId: 'demo:loc:0002', found: false },
      { targetId: 'demo:loc:0006', found: false },
    ]);
    // A camp is never marked found; the item's own mark is.
    expect(tickChanges(camp, true, doneSet([]))).toEqual([{ targetId: camp.item.id, found: true }]);
    expect(tickChanges(camp, true, doneSet([camp.item.id]))).toEqual([]);
    expect(tickChanges(camp, false, doneSet([camp.item.id]))).toEqual([
      { targetId: camp.item.id, found: false },
    ]);
    expect(tickChanges(mixed, true, doneSet([]))).toEqual([
      { targetId: 'demo:loc:0003', found: true },
    ]);
  });

  it('counts done items per checklist and in total', () => {
    const isDone = doneSet(['demo:loc:0001', 'demo:checkitem:step-a', 'demo:loc:0003']);
    expect(checklistTally(index.checklist('demo:checklist:herbs')!, isDone)).toEqual({
      done: 2,
      total: 4,
    });
    expect(checklistTally(index.checklist('demo:checklist:empty')!, isDone)).toEqual({
      done: 0,
      total: 0,
    });
    expect(index.tally(isDone)).toEqual({ done: 3, total: 6 });
  });
});

describe('checklist filters', () => {
  const { pack, index } = makeSetup();
  const herbs = index.checklist('demo:checklist:herbs')!;
  const facets = herbs.items.map((i) => itemFacets(i, pack));
  const isDone = doneSet(['demo:loc:0001', 'demo:checkitem:camp']);
  const states = herbs.items.map((i) => itemState(i, isDone));
  const names = (indices: number[]) => indices.map((i) => herbs.items[i]!.item.name);
  const all = {
    query: '',
    hideFound: false,
    hiddenRegions: new Set<string>(),
    hiddenCategories: new Set<string>(),
  };

  it('gives each item the regions and categories of its places', () => {
    // Pick moss, Rest at camp, Every herb, Chest by the camp.
    // Places without a region count under their map.
    expect(facets.map((f) => f.regions)).toEqual([
      ['demo:region:north'],
      ['demo:map:world'],
      ['demo:map:world', 'demo:map:caves'],
      ['demo:region:north-east', 'demo:map:world'],
    ]);
    expect(facets[3]!.categories).toEqual(['demo:cat:chest', 'demo:cat:camp']);
    expect(facets[0]!.text).toContain('herb');
    const steps = index.checklist('demo:checklist:steps')!;
    expect(itemFacets(steps.items[1]!, pack)).toMatchObject({
      regions: [NONE],
      categories: [NONE],
      text: 'b step chapter 1',
    });
  });

  it('counts found and total items per region and per category', () => {
    expect(countFacets(facets, states, 'categories')).toEqual([
      { key: 'demo:cat:herb', found: 1, total: 2 },
      { key: 'demo:cat:camp', found: 1, total: 2 },
      { key: 'demo:cat:chest', found: 0, total: 1 },
    ]);
    expect(countFacets(facets, states, 'regions')).toEqual([
      { key: 'demo:region:north', found: 1, total: 1 },
      { key: 'demo:map:world', found: 1, total: 3 },
      { key: 'demo:map:caves', found: 0, total: 1 },
      { key: 'demo:region:north-east', found: 0, total: 1 },
    ]);
  });

  it('filters by text, found state, region and category', () => {
    expect(names(filterChecklist(facets, states, all))).toHaveLength(4);
    expect(names(filterChecklist(facets, states, { ...all, query: 'CAMP' }))).toEqual([
      'Rest at camp',
      'Chest by the camp',
    ]);
    expect(names(filterChecklist(facets, states, { ...all, hideFound: true }))).toEqual([
      'Every herb',
      'Chest by the camp',
    ]);
    // An item stays while any of its regions is shown.
    expect(
      names(
        filterChecklist(facets, states, { ...all, hiddenRegions: new Set(['demo:map:world']) }),
      ),
    ).toEqual(['Pick moss', 'Every herb', 'Chest by the camp']);
    expect(
      names(
        filterChecklist(facets, states, {
          ...all,
          hiddenCategories: new Set(['demo:cat:herb', 'demo:cat:camp', 'demo:cat:chest']),
        }),
      ),
    ).toEqual([]);
    // Kept items show whatever the filter says.
    expect(
      names(filterChecklist(facets, states, { ...all, hideFound: true }, (i) => i === 0)),
    ).toEqual(['Pick moss', 'Every herb', 'Chest by the camp']);
  });

  it('filters 2,500 items in a few milliseconds', () => {
    const items = Array.from({ length: 2500 }, (_, i) => ({
      item: { ...herbs.items[0]!.item, id: `demo:checkitem:n${i}`, name: `Shard ${i}` },
      index: i,
      places: ['demo:loc:0001'],
      targets: ['demo:loc:0001'],
      ownMark: false,
    }));
    const started = performance.now();
    const many = items.map((i) => itemFacets(i, pack));
    const manyStates = items.map((i) => itemState(i, isDone));
    for (let n = 0; n < 10; n++) {
      filterChecklist(many, manyStates, { ...all, query: 'shard 12' });
      countFacets(many, manyStates, 'regions');
    }
    expect(performance.now() - started).toBeLessThan(500);
  });
});
