import { isOwnId, ownPicture, readListFile, writeListFile, type OwnList } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { makeTestPack } from '../testing/packs';
import { checklistTally, itemState, tallyStates, type ChecklistEntry } from './checklists';
import { listShape } from './listTypes';
import {
  addStepPhoto,
  changeStep,
  changeTemplate,
  copyList,
  duplicateStep,
  idsOf,
  importList,
  insertRows,
  locationsToAdd,
  moveRow,
  moveRowBy,
  nearestNext,
  newHeading,
  newOwnId,
  newOwnList,
  newStep,
  outlineOf,
  ownListEntry,
  removeRow,
  removeStepPhoto,
  renameHeading,
  rowId,
  setStepPhotoSpoiler,
  suggestOrder,
  withOutline,
} from './ownLists';
import { listStages, nextStep, orderRows } from './views';

const NOW = new Date('2026-11-13T10:00:00.000Z');
const pack = makeTestPack();
const trackable = (id: string) => pack.locations.get(id)?.categoryId !== 'demo:cat:camp';

/** Random parts that count up: a, b, c… */
function counter() {
  let n = 0;
  return () => `t${(n++).toString(36)}`;
}

/** A build guide with the steps given: a name and its location, if any. */
function build(steps: [name: string, location?: string][], random = counter()): OwnList {
  let list = newOwnList('demo', 'Flame build', 'build', NOW, [], random);
  for (const [name, location] of steps) {
    list = insertRows(list, null, [
      newStep(list, newOwnId('demo', 'checkitem', new Set(idsOf(list)), random), {
        name,
        locationIds: location ? [location] : [],
      }),
    ]);
  }
  return list;
}

const names = (list: OwnList) =>
  outlineOf(list).map((row) => (row.kind === 'heading' ? `# ${row.heading.title}` : row.item.name));

describe('own ids', () => {
  it('are valid ids of the game that packs may not use', () => {
    const id = newOwnId('demo', 'checklist', new Set(), () => 'abc12345');
    expect(id).toBe('demo:checklist:own.abc12345');
    expect(isOwnId(id)).toBe(true);
  });

  it('are never one already taken', () => {
    const parts = ['same', 'same', 'other'];
    const taken = new Set(['demo:checkitem:own.same']);
    expect(newOwnId('demo', 'checkitem', taken, () => parts.shift()!)).toBe(
      'demo:checkitem:own.other',
    );
  });

  it('are random enough by default', () => {
    const ids = new Set(
      Array.from({ length: 200 }, () => newOwnId('demo', 'checklist', new Set())),
    );
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^demo:checklist:own\.[a-z0-9]{8}$/);
  });
});

describe('the outline', () => {
  it('keeps headings, and sets each step’s section from the heading above it', () => {
    const random = counter();
    let list = build([['Start'], ['Staff', 'demo:loc:0001']], random);
    list = insertRows(list, null, [newHeading('demo:checkitem:own.h1', 'Before the tower')]);
    list = insertRows(list, null, [newHeading('demo:checkitem:own.h2', 'Late game')]);
    list = insertRows(list, 'demo:checkitem:own.h1', [
      newStep(list, 'demo:checkitem:own.ring', { name: 'Flame ring' }),
    ]);
    expect(names(list)).toEqual([
      'Start',
      'Staff',
      '# Before the tower',
      'Flame ring',
      '# Late game',
    ]);
    expect(list.items.map((i) => i.section)).toEqual([undefined, undefined, 'Before the tower']);
    // The empty heading at the end is kept.
    expect(list.headings.map((h) => h.title)).toEqual(['Before the tower', 'Late game']);
    // A heading moved to the top takes every step under it.
    list = moveRow(list, 'demo:checkitem:own.h1', 0);
    expect(list.items.map((i) => i.section)).toEqual([
      'Before the tower',
      'Before the tower',
      'Before the tower',
    ]);
    list = renameHeading(list, 'demo:checkitem:own.h1', '  Early game ');
    expect(new Set(list.items.map((i) => i.section))).toEqual(new Set(['Early game']));
    // The views show the headings as stages.
    const stages = listStages(ownListEntry(list, pack, trackable));
    expect(stages.map((s) => s.title)).toEqual(['Early game']);
  });

  it('moves rows up and down, and not past either end', () => {
    const list = build([['A'], ['B'], ['C']]);
    const [a, b] = list.items;
    expect(names(moveRowBy(list, b!.id, -1))).toEqual(['B', 'A', 'C']);
    expect(names(moveRowBy(list, b!.id, 1))).toEqual(['A', 'C', 'B']);
    expect(moveRowBy(list, a!.id, -1)).toBe(list);
    expect(names(moveRow(list, a!.id, 2))).toEqual(['B', 'C', 'A']);
  });

  it('removes and duplicates steps, and changes them', () => {
    let list = build([['A', 'demo:loc:0001'], ['B']]);
    const [a, b] = list.items;
    list = duplicateStep(list, a!.id, 'demo:checkitem:own.copy');
    expect(names(list)).toEqual(['A', 'A', 'B']);
    expect(list.items[1]).toMatchObject({
      id: 'demo:checkitem:own.copy',
      locationIds: ['demo:loc:0001'],
    });
    list = removeRow(list, b!.id);
    expect(names(list)).toEqual(['A', 'A']);
    list = changeStep(list, a!.id, { name: ' Ember staff ', note: 'Hot.', optional: true });
    expect(list.items[0]).toMatchObject({ name: 'Ember staff', note: 'Hot.', optional: true });
    list = changeStep(list, a!.id, { note: '', optional: false, locationIds: [] });
    expect(list.items[0]).not.toHaveProperty('note');
    expect(list.items[0]).not.toHaveProperty('optional');
    expect(list.items[0]!.locationIds).toEqual([]);
    // An empty name keeps the old one.
    expect(changeStep(list, a!.id, { name: ' ' }).items[0]!.name).toBe('Ember staff');
  });

  it('changes template without losing anything', () => {
    const list = build([['A', 'demo:loc:0001'], ['B']]);
    const optional = changeStep(list, list.items[1]!.id, { optional: true });
    const collection = changeTemplate(optional, 'collection');
    expect(collection.items).toEqual(optional.items);
    expect(listShape(ownListEntry(collection, pack, trackable)).views).toEqual(['area', 'kind']);
    expect(changeTemplate(collection, 'build')).toEqual(optional);
  });

  it('keeps the outline when numbered again', () => {
    const list = build([['A'], ['B']]);
    expect(withOutline(list, outlineOf(list))).toEqual(list);
    expect(outlineOf(list).map(rowId)).toEqual(list.items.map((i) => i.id));
  });
});

describe('copying a game’s list', () => {
  const entry: ChecklistEntry = {
    checklist: { id: 'demo:checklist:story', name: 'Story', order: 2, kind: 'guide' },
    items: ['Wake', 'Walk', 'Talk'].map((name, index) => ({
      item: {
        id: `demo:checkitem:story-${index}`,
        checklistId: 'demo:checklist:story',
        name,
        order: index,
        locationIds: index === 1 ? ['demo:loc:0002'] : [],
        entityIds: [],
        section: index < 2 ? 'Prologue' : 'Act one',
        ...(index === 2 ? { note: 'Ask ||twice||.' } : {}),
      },
      index,
      targets: [],
      places: [],
      ownMark: true,
    })),
  };

  it('makes an own list of the same type, with new ids and the sections as headings', () => {
    const copy = copyList(entry, 'demo', NOW, [], counter());
    expect(copy.copiedFrom).toBe('demo:checklist:story');
    // The pack did not say; a list of kind "guide" is a route.
    expect(copy.checklist).toMatchObject({ name: 'Story', type: 'route' });
    expect(idsOf(copy).every(isOwnId)).toBe(true);
    expect(new Set(idsOf(copy)).size).toBe(idsOf(copy).length);
    expect(names(copy)).toEqual(['# Prologue', 'Wake', 'Walk', '# Act one', 'Talk']);
    expect(copy.items[2]).toMatchObject({ note: 'Ask ||twice||.', section: 'Act one' });
    expect(copy.items[1]!.locationIds).toEqual(['demo:loc:0002']);
    // The game's list is as it was.
    expect(entry.items[0]!.item.id).toBe('demo:checkitem:story-0');
  });

  it('writes and reads back as a list file', () => {
    const copy = copyList(entry, 'demo', NOW, [], counter());
    const read = readListFile(writeListFile('demo', 'Demo', copy, NOW));
    expect(read.ok && read.list).toEqual(copy);
  });
});

describe('optional steps and Next up', () => {
  it('are passed over, and do not count against done', () => {
    let list = build([['A'], ['B'], ['C']]);
    list = changeStep(list, list.items[1]!.id, { optional: true });
    const entry = ownListEntry(list, pack, trackable);
    const done = new Set([list.items[0]!.id]);
    const states = entry.items.map((item) => itemState(item, (id) => done.has(id)));
    expect(states.map((s) => s.optional === true)).toEqual([false, true, false]);
    // Next up goes past the optional step to C.
    expect(nextStep(states)).toBe(2);
    expect(nextStep(states, 1)).toBe(2);
    expect(checklistTally(entry, (id) => done.has(id))).toEqual({ done: 1, total: 2 });
    done.add(list.items[2]!.id);
    const after = entry.items.map((item) => itemState(item, (id) => done.has(id)));
    // Only the optional step is left: nothing is next, and the list is done.
    expect(nextStep(after)).toBeNull();
    expect(tallyStates(after)).toEqual({ done: 2, total: 2 });
    const rows = orderRows(after, listStages(entry), { highlight: null });
    expect(rows.filter((r) => r.kind === 'item')).toHaveLength(3);
  });
});

describe('Suggest an order', () => {
  it('puts steps nearest next, map by map, keeping steps with no location after theirs', () => {
    const list = build([
      ['Intro'],
      ['Far', 'demo:loc:0002'],
      ['Cave', 'demo:loc:0006'],
      ['Read the sign'],
      ['Start', 'demo:loc:0001'],
      ['Cave two', 'demo:loc:0005'],
      ['Middle', 'demo:loc:0004'],
    ]);
    // From Far (900,500) the nearest is Middle (300,400), then Start (120,80);
    // then the cave map from Cave, with "Read the sign" still after it.
    expect(names(suggestOrder(list, pack))).toEqual([
      'Intro',
      'Far',
      'Middle',
      'Start',
      'Cave',
      'Read the sign',
      'Cave two',
    ]);
  });

  it('orders within each heading, and keeps the headings where they are', () => {
    let list = build([
      ['Far', 'demo:loc:0002'],
      ['Start', 'demo:loc:0001'],
      ['Near', 'demo:loc:0003'],
    ]);
    list = insertRows(list, list.items[0]!.id, [newHeading('demo:checkitem:own.h', 'Later')]);
    expect(names(list)).toEqual(['Far', '# Later', 'Start', 'Near']);
    expect(names(suggestOrder(list, pack))).toEqual(['Far', '# Later', 'Start', 'Near']);
    const ordered = suggestOrder(moveRow(list, 'demo:checkitem:own.h', 0), pack);
    // Far (900,500): Near (700,100) is nearer than Start (120,80).
    expect(names(ordered)).toEqual(['# Later', 'Far', 'Near', 'Start']);
  });

  it('can be undone: the list before is unchanged', () => {
    const list = build([
      ['Far', 'demo:loc:0002'],
      ['Start', 'demo:loc:0001'],
    ]);
    const copy = structuredClone(list);
    suggestOrder(list, pack);
    expect(list).toEqual(copy);
  });

  it('chains to the nearest point', () => {
    const points = [
      { x: 10, y: 0 },
      { x: 1, y: 0 },
      { x: 5, y: 0 },
    ];
    expect(nearestNext(points)).toEqual([points[0], points[2], points[1]]);
    expect(nearestNext(points, { x: 0, y: 0 })).toEqual([points[1], points[2], points[0]]);
  });
});

describe('adding locations', () => {
  it('nearest first from the open step, leaving out what the list has', () => {
    const list = build([
      ['Start', 'demo:loc:0001'],
      ['Far', 'demo:loc:0002'],
    ]);
    const start = list.items[0]!.id;
    expect(
      locationsToAdd(
        list,
        pack,
        ['demo:loc:0005', 'demo:loc:0003', 'demo:loc:0004', 'demo:loc:0002', 'demo:loc:0004'],
        start,
      ),
    ).toEqual(['demo:loc:0004', 'demo:loc:0003', 'demo:loc:0005']);
    // From no step: from the first given.
    expect(locationsToAdd(list, pack, ['demo:loc:0003', 'demo:loc:0004'], null)).toEqual([
      'demo:loc:0003',
      'demo:loc:0004',
    ]);
  });
});

describe('importing a list', () => {
  const game = { gameId: 'demo', title: 'Demo' };

  it('refuses a list made for another game, saying which', () => {
    const list = build([['A']]);
    const result = importList(list, 'other', game, new Set(), NOW, counter(), 'Other Game');
    expect(result).toEqual({
      ok: false,
      error: 'This list was made for Other Game, not for Demo, so it was not imported.',
    });
  });

  it('keeps the ids when they are free, and gives new ones when any is taken', () => {
    const list = build([['A'], ['B']]);
    const kept = importList(list, 'demo', game, new Set(), NOW, counter());
    expect(kept.ok && kept.renamed).toBe(false);
    expect(kept.ok && kept.list.checklist.id).toBe(list.checklist.id);
    const again = importList(list, 'demo', game, new Set(idsOf(list)), NOW, counter());
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.renamed).toBe(true);
    const ids = idsOf(again.list);
    expect(ids.some((id) => idsOf(list).includes(id))).toBe(false);
    expect(ids.every(isOwnId)).toBe(true);
    expect(again.list.items.every((i) => i.checklistId === again.list.checklist.id)).toBe(true);
    expect(names(again.list)).toEqual(names(list));
  });
});

describe('photos of steps', () => {
  const shot = ownPicture('demo:picture:own.shot', 'image/jpeg', 1280, 720);
  const packPicture = { id: 'demo:picture:gate', file: 'pictures/gate.png', shareable: true };

  it('adds, marks and removes a photo, keeping only the own pictures shown', () => {
    const list = build([['A', 'demo:loc:0001'], ['B']]);
    const [a, b] = list.items;
    let next = addStepPhoto(list, a!.id, shot);
    next = addStepPhoto(next, b!.id, packPicture, true);
    expect(next.items[0]!.photos).toEqual([{ picture: shot.id }]);
    expect(next.items[1]!.photos).toEqual([{ picture: packPicture.id, spoiler: true }]);
    // Only the person's own picture is kept with the list.
    expect(next.pictures).toEqual([shot]);
    next = setStepPhotoSpoiler(next, a!.id, shot.id, true);
    expect(next.items[0]!.photos).toEqual([{ picture: shot.id, spoiler: true }]);
    // A duplicated step shows the same picture: it stays while one step shows it.
    next = duplicateStep(next, a!.id, 'demo:checkitem:own.copy');
    next = removeStepPhoto(next, a!.id, shot.id);
    expect(next.items[0]!.photos).toBeUndefined();
    expect(next.pictures).toEqual([shot]);
    next = removeStepPhoto(next, 'demo:checkitem:own.copy', shot.id);
    expect(next.pictures).toBeUndefined();
    expect(idsOf(addStepPhoto(list, a!.id, shot))).toContain(shot.id);
  });

  it('gives a list’s own photos new ids and files with the list when its ids are taken', () => {
    const game = { gameId: 'demo', title: 'Demo' };
    const list = addStepPhoto(build([['A']]), build([['A']]).items[0]!.id, shot);
    const again = importList(list, 'demo', game, new Set(idsOf(list)), NOW, counter());
    if (!again.ok) throw new Error(again.error);
    const [picture] = again.list.pictures!;
    expect(picture!.id).not.toBe(shot.id);
    expect(again.list.items[0]!.photos).toEqual([{ picture: picture!.id }]);
    expect([...again.renamedFiles]).toEqual([[shot.file, picture!.file]]);
    expect(picture!.file).toBe(`pictures/${picture!.id.split(':')[2]!}.jpg`);
    const kept = importList(list, 'demo', game, new Set(), NOW, counter());
    expect(kept.ok && kept.renamedFiles.size).toBe(0);
  });
});
