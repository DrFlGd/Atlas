import { describe, expect, it } from 'vitest';
import { indexPack } from '../pack/loadedPack';
import { ProgressCounter } from '../progress/counters';
import { makeTestPackData } from '../testing/packs';
import { ChecklistIndex, checklistTally, itemState, type ChecklistEntry } from './checklists';
import {
  EVERYTHING_ID,
  NO_AREA,
  NO_KIND,
  areaAt,
  areaTallies,
  doneRunBefore,
  everythingList,
  hiddenParts,
  kindGroups,
  listAreas,
  listStages,
  nearestFirst,
  nextArea,
  nextStep,
  orderAreas,
  orderRows,
  plainNote,
  topRegionOf,
  withoutHiddenText,
} from './views';

/**
 * The test pack has North (with North East inside it) on the world map,
 * places without a region on both maps, and a camp that is not tracked.
 * This adds South, a second top-level region, with a place in it.
 */
function makeSetup() {
  const data = makeTestPackData();
  data.regions.push({
    id: 'demo:region:south',
    mapId: 'demo:map:world',
    parentId: null,
    name: 'South',
    polygon: [
      [0, 300],
      [1000, 300],
      [1000, 600],
      [0, 600],
    ],
  });
  data.locations.push({
    id: 'demo:loc:0007',
    mapId: 'demo:map:world',
    layerId: 'demo:layer:surface',
    x: 200,
    y: 450,
    categoryId: 'demo:cat:chest',
    regionId: 'demo:region:south',
    name: 'Southern chest',
    entityIds: [],
    guideId: null,
    since: '1.0.0',
  });
  const base = { checklistId: 'demo:checklist:herbs', entityIds: [] };
  data.checklistItems.push(
    // Places in North (0001), North East (0003, inside North) and South (0007).
    {
      ...base,
      id: 'demo:checkitem:north-and-south',
      name: 'North and south',
      order: 1,
      locationIds: ['demo:loc:0003', 'demo:loc:0007'],
    },
    // A place with no region.
    {
      ...base,
      id: 'demo:checkitem:salt',
      name: 'Salt herb',
      order: 2,
      locationIds: ['demo:loc:0002'],
    },
    // No place at all.
    { ...base, id: 'demo:checkitem:step', name: 'A step', order: 3, locationIds: [] },
  );
  const pack = indexPack(data, new URL('https://x.test/'));
  const counter = new ProgressCounter(pack);
  const isTrackable = (id: string) => counter.isTrackable(id);
  const index = new ChecklistIndex(pack, isTrackable);
  return { pack, isTrackable, list: index.checklist('demo:checklist:herbs')! };
}

const statesOf = (entry: ChecklistEntry, found: Iterable<string>) => {
  const set = new Set(found);
  return entry.items.map((item) => itemState(item, (id) => set.has(id)));
};

describe('areas', () => {
  it('groups by the top-level region, with an item in each area it has places in', () => {
    const { pack, list } = makeSetup();
    expect(topRegionOf(pack, 'demo:region:north-east')).toBe('demo:region:north');
    const areas = listAreas(list, pack);
    // Pack order of regions, then the places without an area.
    expect(areas.keys).toEqual(['demo:region:north', 'demo:region:south', NO_AREA]);
    const names = (key: string) => areas.items.get(key)!.map((i) => list.items[i]!.item.name);
    expect(names('demo:region:north')).toEqual(['Pick moss', 'North and south']);
    expect(names('demo:region:south')).toEqual(['North and south']);
    // A place without a region, and an item without a place.
    expect(names(NO_AREA)).toEqual(['Salt herb', 'A step']);
  });

  it('counts each area with the items’ own state, the list’s figure staying the tally', () => {
    const { pack, list } = makeSetup();
    const areas = listAreas(list, pack);
    // The chest in the north is found, the one in the south is not: the item is not done.
    const states = statesOf(list, ['demo:loc:0001', 'demo:loc:0003']);
    expect(areaTallies(areas, states)).toEqual([
      { key: 'demo:region:north', found: 1, total: 2 },
      { key: 'demo:region:south', found: 0, total: 1 },
      { key: NO_AREA, found: 0, total: 2 },
    ]);
    const isDone = (id: string) => ['demo:loc:0001', 'demo:loc:0003'].includes(id);
    expect(checklistTally(list, isDone)).toEqual({ done: 1, total: 4 });
  });

  it('puts the area of the map first, finished areas last, and finds the next one', () => {
    const tallies = [
      { key: 'a', found: 1, total: 2 },
      { key: 'b', found: 2, total: 2 },
      { key: NO_AREA, found: 0, total: 1 },
      { key: 'c', found: 0, total: 3 },
    ];
    const ordered = orderAreas(tallies, 'c').map((t) => t.key);
    expect(ordered).toEqual(['c', 'a', NO_AREA, 'b']);
    // A finished area is not put first.
    expect(orderAreas(tallies, 'b').map((t) => t.key)).toEqual(['a', 'c', NO_AREA, 'b']);
    const inOrder = orderAreas(tallies, 'c');
    expect(nextArea(inOrder, 'c')?.key).toBe('a');
    expect(nextArea(inOrder, NO_AREA)?.key).toBe('c');
    expect(nextArea(inOrder, 'b')?.key).toBe('c');
    expect(nextArea([{ key: 'a', found: 0, total: 1 }], 'a')).toBeNull();
  });

  it('finds the area a point is in from the outlines, the smallest first', () => {
    const { pack } = makeSetup();
    // Inside North East, which is inside North: the area is North.
    expect(areaAt(pack, 'demo:map:world', { x: 700, y: 100 })).toBe('demo:region:north');
    expect(areaAt(pack, 'demo:map:world', { x: 100, y: 500 })).toBe('demo:region:south');
    expect(areaAt(pack, 'demo:map:caves', { x: 100, y: 100 })).toBeNull();
  });
});

describe('kinds', () => {
  it('groups by the kinds of the places, in an area only its places, steps last', () => {
    const { pack, list } = makeSetup();
    const all = list.items.map((i) => i.index);
    const groups = kindGroups(list, pack, all);
    expect(groups.map((g) => g.key)).toEqual(['demo:cat:herb', 'demo:cat:chest', NO_KIND]);
    expect(groups[0]!.indices).toEqual([0, 2]);
    expect(groups[1]!.indices).toEqual([1]);
    expect(groups[2]!.indices).toEqual([3]);
    // In the south, the item with places in two areas is a chest only.
    const south = kindGroups(list, pack, [1], 'demo:region:south');
    expect(south).toEqual([{ key: 'demo:cat:chest', indices: [1] }]);
  });

  it('orders by distance to the map centre, places on other maps after', () => {
    const { pack, list } = makeSetup();
    const all = list.items.map((i) => i.index);
    // Near the south chest: that item first; the item with no place keeps its place last.
    const near = nearestFirst(list, pack, all, 'demo:map:world', { x: 210, y: 440 });
    expect(near).toEqual([1, 0, 2, 3]);
    // Measured only from places in the area given.
    const north = nearestFirst(
      list,
      pack,
      [1, 0],
      'demo:map:world',
      { x: 210, y: 440 },
      'demo:region:north',
    );
    expect(north).toEqual([0, 1]);
    expect(nearestFirst(list, pack, all, null, null)).toEqual(all);
  });
});

describe('the Everything list', () => {
  it('is every trackable place, map by map, one item per place', () => {
    const { pack, isTrackable } = makeSetup();
    const everything = everythingList(pack, isTrackable);
    expect(everything.checklist.id).toBe(EVERYTHING_ID);
    expect(everything.checklist.name).toBe('Everything');
    const ids = everything.items.map((i) => i.item.id);
    // The camp is not tracked; the caves map comes after the world map.
    expect(ids).toEqual([
      'demo:loc:0001',
      'demo:loc:0002',
      'demo:loc:0003',
      'demo:loc:0007',
      'demo:loc:0005',
      'demo:loc:0006',
    ]);
    expect(everything.items.every((i) => !i.ownMark && i.targets.length === 1)).toBe(true);
    const states = statesOf(everything, ['demo:loc:0002', 'demo:loc:0005']);
    expect(
      checklistTally(everything, (id) => ['demo:loc:0002', 'demo:loc:0005'].includes(id)),
    ).toEqual({
      done: 2,
      total: 6,
    });
    const areas = listAreas(everything, pack);
    expect(areaTallies(areas, states)).toEqual([
      { key: 'demo:region:north', found: 0, total: 2 },
      { key: 'demo:region:south', found: 0, total: 1 },
      { key: NO_AREA, found: 2, total: 3 },
    ]);
  });
});

describe('in order', () => {
  const done = (...flags: number[]) => flags.map((f) => ({ done: f === 1 }));

  it('finds the next step from where the highlight is, going round', () => {
    expect(nextStep(done(1, 1, 0, 0))).toBe(2);
    // Skipped past step 2: the next one is 3.
    expect(nextStep(done(1, 1, 0, 0), 3)).toBe(3);
    // Past the end: back to the first not done.
    expect(nextStep(done(1, 1, 0, 1), 3)).toBe(2);
    expect(nextStep(done(1, 1))).toBeNull();
    expect(nextStep([])).toBeNull();
  });

  it('folds the done steps right before the next one, within its stage', () => {
    const { list } = makeSetup();
    const sections = ['One', 'One', 'Two', 'Two'];
    const entry: ChecklistEntry = {
      ...list,
      items: [...list.items, list.items[0]!, list.items[0]!].slice(0, 6).map((item, index) => ({
        ...item,
        index,
        item: { ...item.item, section: sections[index] ?? 'Two' },
      })),
    };
    const stages = listStages(entry);
    expect(stages.map((s) => [s.title, s.start, s.end, s.number])).toEqual([
      ['One', 0, 2, 1],
      ['Two', 2, 6, 2],
    ]);
    const states = done(1, 1, 1, 1, 1, 0);
    expect(doneRunBefore(states, stages, 5)).toEqual({ from: 2, to: 4 });
    // One done step is not folded; nor are those of the stage before.
    expect(doneRunBefore(done(1, 1, 1, 0, 0, 0), stages, 3)).toBeNull();

    const rows = orderRows(states, stages, { highlight: 5 });
    expect(rows).toEqual([
      // The finished first stage is closed.
      { kind: 'stage', stage: 0, open: false, done: 2, total: 2 },
      { kind: 'stage', stage: 1, open: true, done: 3, total: 4 },
      { kind: 'here' },
      { kind: 'run', from: 2, to: 4 },
      { kind: 'item', index: 5 },
    ]);
    // Shown by hand: the folded steps, and the first stage.
    const opened = orderRows(states, stages, {
      highlight: 5,
      runShown: true,
      stageOpen: new Map([[0, true]]),
    });
    expect(opened.flatMap((r) => (r.kind === 'item' ? [r.index] : []))).toEqual([0, 1, 2, 3, 4, 5]);
    // A search shows what matches under open stages, with nothing folded.
    expect(orderRows(states, stages, { highlight: 5, only: [1, 4] })).toEqual([
      { kind: 'stage', stage: 0, open: true, done: 2, total: 2 },
      { kind: 'item', index: 1 },
      { kind: 'stage', stage: 1, open: true, done: 3, total: 4 },
      { kind: 'item', index: 4 },
    ]);
  });

  it('puts the link first in a list without stages', () => {
    const { list } = makeSetup();
    const stages = listStages(list);
    expect(stages).toEqual([{ title: null, start: 0, end: 4, number: 0 }]);
    const rows = orderRows(done(1, 1, 1, 0), stages, { highlight: 3 });
    expect(rows).toEqual([
      { kind: 'here' },
      { kind: 'run', from: 0, to: 2 },
      { kind: 'item', index: 3 },
    ]);
    // Everything done: no highlight, no link, nothing folded.
    expect(orderRows(done(1, 1, 1, 1), stages, { highlight: null })).toHaveLength(4);
  });
});

it('makes a note plain text', () => {
  expect(plainNote('Start near [the first waystone](demo:loc:1).\n\nMore **later**.')).toBe(
    'Start near the first waystone.',
  );
  expect(plainNote('## Heading\n**Bold** and `code` _here_')).toBe('Heading Bold and code here');
  expect(
    plainNote(
      'A [red]{color=#c33} key, [[a page]{color=#c33}](demo:loc:1) and [[b](demo:loc:2)]{color=#f80}',
    ),
  ).toBe('A red key, a page and b');
});

describe('hidden text in notes', () => {
  it('finds hidden parts, pairing bars left to right', () => {
    expect(hiddenParts('Pull the ||left|| lever')).toEqual([[9, 17]]);
    expect(hiddenParts('||a|| and ||b||')).toEqual([
      [0, 5],
      [10, 15],
    ]);
    // A bar without a partner is plain text.
    expect(hiddenParts('a || b || c || d')).toEqual([[2, 9]]);
    expect(hiddenParts('no bars | here')).toEqual([]);
  });

  it('does not count bars in code or escaped bars', () => {
    expect(hiddenParts('`a || b` and ||c||')).toEqual([[13, 18]]);
    expect(hiddenParts('``x `||` y`` ||c||')).toEqual([[13, 18]]);
    expect(hiddenParts('\\|\\| not hidden \\|\\|')).toEqual([]);
  });

  it('puts each hidden part as (Hidden)', () => {
    expect(withoutHiddenText('Turn the ||third|| valve, then the ||first||.')).toBe(
      'Turn the (Hidden) valve, then the (Hidden).',
    );
    expect(withoutHiddenText('Odd || bar')).toBe('Odd || bar');
  });

  it('keeps hidden words out of a note as one line, over several paragraphs too', () => {
    expect(plainNote('Behind the falls. ||The key is [under the bridge](demo:loc:7).||')).toBe(
      'Behind the falls. (Hidden)',
    );
    const solution = [
      'Solution: ||Turn the valves in this order:',
      '',
      '1. Left valve',
      '2. Right valve',
      '',
      'Then pull the lever.||',
      '',
      'Comes back after a rest.',
    ].join('\n');
    expect(plainNote(solution)).toBe('Solution: (Hidden)');
    expect(plainNote(solution)).not.toMatch(/valve|lever/);
  });
});
