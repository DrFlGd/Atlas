import { isOwnId, ownPicture, type OwnLocations } from '@atlas/schema';
import { makeFixturePack } from '@atlas/schema/testing';
import { describe, expect, it } from 'vitest';
import { ChecklistIndex } from '../checklists/checklists';
import { ProgressCounter } from '../progress/counters';
import { SearchIndex } from '../search/searchIndex';
import { indexPack } from './loadedPack';
import {
  addOwnLocation,
  addOwnLocationPhoto,
  changeOwnLocation,
  mergeOwnFiles,
  mergeOwnLocations,
  newOwnArea,
  newOwnType,
  newOwnTypeGroup,
  ownNoteId,
  putOwnArea,
  putOwnType,
  removeOwnArea,
  removeOwnLocation,
  removeOwnLocationPhoto,
  removeOwnOfMap,
  removeOwnType,
  setOwnLocationPhotoSpoiler,
} from './ownLocations';

const NOW = new Date('2026-11-13T10:00:00.000Z');

function sequence(...values: string[]) {
  let i = 0;
  return () => values[i++ % values.length]!;
}

function own(): OwnLocations {
  return {
    categoryGroups: [{ id: 'demo:catgroup:own.g1', name: 'My types', order: 100 }],
    categories: [
      {
        id: 'demo:cat:own.t1',
        groupId: 'demo:catgroup:own.g1',
        name: 'Campfire',
        icon: 'flame',
        color: '#e07a2f',
        trackable: true,
        defaultVisible: true,
      },
    ],
    regions: [
      { id: 'demo:region:own.a1', mapId: 'demo:map:world', parentId: null, name: 'Low fields' },
    ],
    locations: [
      {
        id: 'demo:loc:own.l1',
        mapId: 'demo:map:world',
        layerId: 'demo:layer:surface',
        x: 10,
        y: 20,
        categoryId: 'demo:cat:own.t1',
        regionId: 'demo:region:own.a1',
        name: 'Camp by the river',
        note: 'Rest **here**.',
      },
    ],
  };
}

describe('own locations in a game', () => {
  it('are added after the pack’s own, with their note, type, group and area', () => {
    const pack = makeFixturePack();
    const { data, skipped } = mergeOwnLocations(pack, own());
    expect(skipped).toBe(0);
    expect(data.locations).toHaveLength(pack.locations.length + 1);
    const location = data.locations.at(-1)!;
    expect(location).toMatchObject({
      id: 'demo:loc:own.l1',
      categoryId: 'demo:cat:own.t1',
      regionId: 'demo:region:own.a1',
      guideId: 'demo:guide:own.l1',
      entityIds: [],
    });
    expect(data.guides.at(-1)).toEqual({
      id: 'demo:guide:own.l1',
      title: 'Camp by the river',
      body: 'Rest **here**.',
      locationIds: ['demo:loc:own.l1'],
    });
    expect(data.categories.at(-1)!.id).toBe('demo:cat:own.t1');
    expect(data.categoryGroups.at(-1)!.id).toBe('demo:catgroup:own.g1');
    expect(data.regions.at(-1)!.id).toBe('demo:region:own.a1');
    // The pack's data is not changed.
    expect(pack.locations.some((l) => isOwnId(l.id))).toBe(false);
  });

  it('count, search, filter and list like any other location', () => {
    const { data } = mergeOwnLocations(makeFixturePack(), own());
    const pack = indexPack(data, new URL('https://packs.example.test/demo/'));
    const counter = new ProgressCounter(pack);
    expect(counter.isTrackable('demo:loc:own.l1')).toBe(true);
    const before = counter.summarize([]).pack.total;
    expect(counter.summarize(['demo:loc:own.l1']).pack.found).toBe(1);
    expect(before).toBeGreaterThan(0);
    const search = new SearchIndex(pack);
    expect(search.search('river camp').some((hit) => hit.entry.id === 'demo:loc:own.l1')).toBe(
      true,
    );
    const lists = new ChecklistIndex(pack, (id) => counter.isTrackable(id));
    // Its note is the location's, not a guide of its own.
    expect(lists.isListed(ownNoteId('demo:loc:own.l1'))).toBe(false);
    expect(lists.guide('demo:guide:own.l1')?.body).toBe('Rest **here**.');
  });

  it('may use the pack’s types and areas', () => {
    const pack = makeFixturePack();
    const mine = own();
    mine.locations[0] = {
      ...mine.locations[0]!,
      categoryId: pack.categories[0]!.id,
      regionId: 'demo:region:north',
    };
    const { data, skipped } = mergeOwnLocations(pack, mine);
    expect(skipped).toBe(0);
    expect(data.locations.at(-1)).toMatchObject({
      categoryId: pack.categories[0]!.id,
      regionId: 'demo:region:north',
    });
  });

  it('leave out what has no map, layer, type or group, and keep the rest', () => {
    const pack = makeFixturePack();
    const mine = own();
    const first = mine.locations[0]!;
    mine.locations.push(
      { ...first, id: 'demo:loc:own.l2', mapId: 'demo:map:gone', layerId: 'demo:layer:gone' },
      { ...first, id: 'demo:loc:own.l3', categoryId: 'demo:cat:gone' },
      { ...first, id: 'demo:loc:own.l4', regionId: 'demo:region:gone', x: -5, y: 1e9 },
    );
    mine.categories.push({
      ...mine.categories[0]!,
      id: 'demo:cat:own.t2',
      groupId: 'demo:catgroup:gone',
    });
    mine.regions.push({ ...mine.regions[0]!, id: 'demo:region:own.a2', mapId: 'demo:map:gone' });
    const { data, skipped } = mergeOwnLocations(pack, mine);
    expect(skipped).toBe(4);
    const kept = data.locations.filter((l) => isOwnId(l.id));
    expect(kept.map((l) => l.id)).toEqual(['demo:loc:own.l1', 'demo:loc:own.l4']);
    // An area that is not there is dropped; a point outside the map is moved in.
    expect(kept[1]).toMatchObject({ regionId: null, x: 0, y: pack.maps[0]!.height });
  });

  it('never take an id the pack uses', () => {
    const pack = makeFixturePack();
    const mine = own();
    mine.locations[0] = { ...mine.locations[0]!, id: pack.locations[0]!.id };
    const { data, skipped } = mergeOwnLocations(pack, mine);
    expect(skipped).toBe(1);
    expect(data.locations).toHaveLength(pack.locations.length);
  });

  it('leave the pack as it is when there are none', () => {
    const pack = makeFixturePack();
    const empty = { categoryGroups: [], categories: [], regions: [], locations: [] };
    expect(mergeOwnLocations(pack, empty).data).toBe(pack);
  });
});

describe('changing own locations, types and areas', () => {
  it('makes own ids that no pack or own record has', () => {
    const pack = makeFixturePack();
    const mine = own();
    const group = newOwnTypeGroup('demo', ' Camps ', pack, mine, sequence('g1', 'g2'));
    expect(group).toMatchObject({ id: 'demo:catgroup:own.g2', name: 'Camps', order: 101 });
    const type = newOwnType(
      'demo',
      { name: 'Tent', color: '#3F7FD9', icon: 'flag', groupId: group.id },
      pack,
      mine,
      sequence('t1', 't9'),
    );
    expect(type).toMatchObject({
      id: 'demo:cat:own.t9',
      color: '#3f7fd9',
      trackable: true,
      defaultVisible: true,
    });
    const area = newOwnArea('demo', 'demo:map:world', 'Hills', pack, mine, sequence('a1', 'a2'));
    expect(area.id).toBe('demo:region:own.a2');
    const next = putOwnArea(putOwnType(mine, type, group), area);
    expect(next.categories).toHaveLength(2);
    expect(next.categoryGroups).toHaveLength(2);
    expect(next.regions).toHaveLength(2);
    expect(mine.categories).toHaveLength(1);
  });

  it('changes, moves and removes a location, leaving the data it was given alone', () => {
    const mine = own();
    const moved = changeOwnLocation(mine, 'demo:loc:own.l1', { x: 50, y: 60 }, NOW);
    expect(moved.locations[0]).toMatchObject({ x: 50, y: 60, updatedAt: NOW.toISOString() });
    expect(mine.locations[0]!.x).toBe(10);
    expect(changeOwnLocation(moved, 'demo:loc:own.l1', { x: 50 }, NOW)).toBe(moved);
    const noNote = changeOwnLocation(moved, 'demo:loc:own.l1', { note: '' }, NOW);
    expect(noNote.locations[0]).not.toHaveProperty('note');
    const added = addOwnLocation(noNote, { ...noNote.locations[0]!, id: 'demo:loc:own.l9' });
    expect(removeOwnLocation(added, 'demo:loc:own.l9').locations).toHaveLength(1);
  });

  it('removes a type only when no location uses it, and its group when empty', () => {
    const mine = own();
    expect(removeOwnType(mine, 'demo:cat:own.t1')).toBe(mine);
    const unused = removeOwnLocation(mine, 'demo:loc:own.l1');
    const none = removeOwnType(unused, 'demo:cat:own.t1');
    expect(none.categories).toHaveLength(0);
    expect(none.categoryGroups).toHaveLength(0);
  });

  it('removes an area, leaving its locations in none, and everything of a map', () => {
    const mine = own();
    const without = removeOwnArea(mine, 'demo:region:own.a1', NOW);
    expect(without.regions).toHaveLength(0);
    expect(without.locations[0]!.regionId).toBeNull();
    const noMap = removeOwnOfMap(mine, 'demo:map:world');
    expect(noMap.locations).toHaveLength(0);
    expect(noMap.regions).toHaveLength(0);
    expect(noMap.categories).toHaveLength(1);
  });

  it('adds a file’s records to what is there, the file’s winning', () => {
    const here = own();
    const incoming = own();
    incoming.locations[0] = { ...incoming.locations[0]!, name: 'Renamed' };
    incoming.locations.push({ ...incoming.locations[0], id: 'demo:loc:own.l2' });
    here.locations.push({ ...here.locations[0]!, id: 'demo:loc:own.l3' });
    const merged = mergeOwnFiles(here, incoming);
    expect(merged.locations.map((l) => `${l.id} ${l.name}`)).toEqual([
      'demo:loc:own.l3 Camp by the river',
      'demo:loc:own.l1 Renamed',
      'demo:loc:own.l2 Renamed',
    ]);
  });
});

describe('photos of own locations', () => {
  const shot = ownPicture('demo:picture:own.p1', 'image/png', 800, 600);

  it('adds, marks and removes a photo, and shows it on the merged location', () => {
    let next = addOwnLocationPhoto(own(), 'demo:loc:own.l1', shot, NOW);
    expect(next.pictures).toEqual([shot]);
    next = setOwnLocationPhotoSpoiler(next, 'demo:loc:own.l1', shot.id, true, NOW);
    expect(next.locations[0]!.photos).toEqual([{ picture: shot.id, spoiler: true }]);
    const merged = mergeOwnLocations(makeFixturePack(), next).data;
    expect(merged.locations.find((l) => l.id === 'demo:loc:own.l1')?.photos).toEqual([
      { picture: shot.id, spoiler: true },
    ]);
    const removed = removeOwnLocationPhoto(next, 'demo:loc:own.l1', shot.id, NOW);
    expect(removed.locations[0]!.photos).toBeUndefined();
    expect(removed.pictures).toBeUndefined();
  });

  it('lets the pictures of a deleted location go, and merges pictures from a file', () => {
    const next = addOwnLocationPhoto(own(), 'demo:loc:own.l1', shot, NOW);
    expect(removeOwnLocation(next, 'demo:loc:own.l1').pictures).toBeUndefined();
    expect(mergeOwnFiles(own(), next).pictures).toEqual([shot]);
  });
});
