import type { ChecklistEntry, ChecklistItemEntry, SearchEntry, SearchHit } from '@atlas/core';
import { describe, expect, it } from 'vitest';
import { backStep, type BackState } from './backStack';
import { arrangementFor, panelWidthFor } from './layout';
import { nextOnList, orderHits, revealShift, type Placed } from './ordering';
import { parseRecent, withRecent } from './recent';
import { touchRequested, uiFromSearch } from './uiMode';

describe('arrangement', () => {
  it('is wide from 840 px, or on its side from 600 px', () => {
    expect(arrangementFor(390, 844)).toBe('compact');
    expect(arrangementFor(800, 1280)).toBe('compact');
    expect(arrangementFor(1280, 800)).toBe('wide');
    expect(arrangementFor(844, 390)).toBe('wide');
    expect(arrangementFor(640, 360)).toBe('wide');
    expect(arrangementFor(599, 360)).toBe('compact');
    expect(arrangementFor(840, 1000)).toBe('wide');
  });

  it('gives a phone on its side a narrower panel', () => {
    expect(panelWidthFor(1280, 800)).toBe(360);
    expect(panelWidthFor(844, 390)).toBe(320);
    expect(panelWidthFor(800, 1280)).toBe(360);
  });
});

describe('Back', () => {
  const nothing: BackState = {
    dialog: false,
    placeExpanded: false,
    mapsMenu: false,
    search: false,
    filters: false,
    place: false,
    section: 'map',
    listsPage: false,
  };

  it('leaves the app when nothing is open on the map', () => {
    expect(backStep(nothing)).toBeNull();
  });

  it('closes one thing at a time, the one on top first', () => {
    let state: BackState = {
      dialog: true,
      placeExpanded: true,
      mapsMenu: false,
      search: false,
      filters: true,
      place: true,
      section: 'lists',
      listsPage: true,
    };
    const steps = [];
    for (let step = backStep(state); step; step = backStep(state)) {
      steps.push(step);
      state = {
        ...state,
        ...{
          dialog: { dialog: false },
          'collapse-place': { placeExpanded: false },
          'maps-menu': { mapsMenu: false },
          search: { search: false },
          filters: { filters: false },
          place: { place: false },
          'lists-page': { listsPage: false },
          'to-map': { section: 'map' as const },
        }[step],
      };
    }
    expect(steps).toEqual(['dialog', 'collapse-place', 'filters', 'place', 'lists-page', 'to-map']);
  });

  it('closes search and the map chooser before the place', () => {
    expect(backStep({ ...nothing, search: true, place: true })).toBe('search');
    expect(backStep({ ...nothing, mapsMenu: true, search: true })).toBe('maps-menu');
    // A sheet pulled up is only collapsed while its place is shown.
    expect(backStep({ ...nothing, placeExpanded: true })).toBeNull();
    expect(backStep({ ...nothing, section: 'progress' })).toBe('to-map');
    expect(backStep({ ...nothing, section: 'games', listsPage: true })).toBe('to-map');
  });
});

const entry = (kind: SearchEntry['kind'], id: string): SearchEntry => ({
  kind,
  id,
  title: id,
  detail: '',
  mapId: null,
  locationIds: kind === 'location' ? [id] : [],
});
const hit = (kind: SearchEntry['kind'], id: string, score: number): SearchHit => ({
  entry: entry(kind, id),
  score,
});

describe('search order', () => {
  const places: Record<string, Placed> = {
    far: { mapId: 'm1', x: 900, y: 900 },
    near: { mapId: 'm1', x: 110, y: 100 },
    other: { mapId: 'm2', x: 100, y: 100 },
    mid: { mapId: 'm1', x: 300, y: 100 },
  };
  const placeOf = (id: string) => places[id];

  it('keeps the match ranking and puts the nearest places on this map first', () => {
    const hits = [
      hit('checklist', 'list', 1),
      hit('location', 'other', 2),
      hit('location', 'far', 2),
      hit('location', 'near', 2),
      hit('checkitem', 'item', 2),
      hit('location', 'mid', 3),
      hit('location', 'exact', 0),
    ];
    const ordered = orderHits(hits, 'm1', { x: 100, y: 100 }, placeOf).map((h) => h.entry.id);
    expect(ordered).toEqual(['exact', 'list', 'near', 'far', 'other', 'item', 'mid']);
    // The input is left as it was.
    expect(hits[0]!.entry.id).toBe('list');
  });

  it('keeps the order it was given without a centre', () => {
    const hits = [hit('location', 'far', 2), hit('location', 'near', 2)];
    expect(orderHits(hits, 'm1', null, placeOf).map((h) => h.entry.id)).toEqual(['far', 'near']);
  });
});

describe('next on a list', () => {
  const item = (id: string, places: string[], targets: string[] = places): ChecklistItemEntry => ({
    item: {
      id,
      checklistId: 'c',
      name: id,
      order: 0,
      locationIds: places,
      entityIds: [],
    },
    index: 0,
    places,
    targets,
    ownMark: targets.length === 0,
  });
  const list = {
    checklist: { id: 'c', name: 'C', order: 0 },
    items: [
      item('a', ['la']),
      item('b', ['lb']),
      item('step', []),
      item('c', ['lc1', 'lc2']),
      item('d', ['ld'], []),
    ],
  } as unknown as ChecklistEntry;

  it('goes to the next entry not done that has a place, round to the start', () => {
    const found = new Set(['lb', 'lc1']);
    const isDone = (id: string) => found.has(id);
    expect(nextOnList(list, 'a', isDone)).toEqual({ itemId: 'c', locationId: 'lc2' });
    expect(nextOnList(list, 'c', isDone)).toEqual({ itemId: 'd', locationId: 'ld' });
    found.add('d');
    expect(nextOnList(list, 'c', isDone)).toEqual({ itemId: 'a', locationId: 'la' });
    found.add('la');
    found.add('lc2');
    expect(nextOnList(list, 'a', isDone)).toBeNull();
  });
});

describe('keeping the selected marker in view', () => {
  const free = { left: 0, top: 120, right: 390, bottom: 844 };
  const sheet = { left: 0, top: 520, right: 390, bottom: 844 };

  it('leaves a marker that can be seen', () => {
    expect(revealShift({ x: 200, y: 300 }, free, [sheet], 24)).toBeNull();
  });

  it('moves a marker under the sheet or the top controls to the middle of the room left', () => {
    expect(revealShift({ x: 200, y: 600 }, free, [sheet], 24)).toEqual({ x: 5, y: 280 });
    expect(revealShift({ x: 195, y: 100 }, free, [sheet], 24)).toEqual({ x: 0, y: -220 });
    expect(revealShift({ x: 10, y: 300 }, free, [], 24)).toEqual({ x: -185, y: -182 });
  });
});

describe('recent results', () => {
  it('keeps the latest first, once each, a few at most', () => {
    let list = withRecent([], { kind: 'location', id: 'a' });
    list = withRecent(list, { kind: 'checklist', id: 'b' });
    list = withRecent(list, { kind: 'location', id: 'a' });
    expect(list).toEqual([
      { kind: 'location', id: 'a' },
      { kind: 'checklist', id: 'b' },
    ]);
    for (let i = 0; i < 10; i++) list = withRecent(list, { kind: 'location', id: `x${i}` });
    expect(list).toHaveLength(6);
    expect(list[0]).toEqual({ kind: 'location', id: 'x9' });
  });

  it('reads only what it wrote', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(
      parseRecent([{ kind: 'location', id: 'a', extra: 1 }, { kind: 'nope', id: 'b' }, 'c']),
    ).toEqual([{ kind: 'location', id: 'a' }]);
  });
});

describe('asking a browser for the touch layout', () => {
  const storage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
  };

  it('reads the address', () => {
    expect(uiFromSearch('?ui=touch')).toBe('touch');
    expect(uiFromSearch('?pack=demo&ui=desktop')).toBe('desktop');
    expect(uiFromSearch('?ui=other')).toBeNull();
    expect(uiFromSearch('')).toBeNull();
  });

  it('keeps the choice for the session until the address says otherwise', () => {
    const session = storage();
    expect(touchRequested('', session)).toBe(false);
    expect(touchRequested('?ui=touch', session)).toBe(true);
    expect(touchRequested('', session)).toBe(true);
    expect(touchRequested('?ui=desktop', session)).toBe(false);
    expect(touchRequested('', session)).toBe(false);
    expect(touchRequested('?ui=touch', null)).toBe(true);
    const refusing = {
      getItem: () => {
        throw new Error('no');
      },
      setItem: () => {
        throw new Error('no');
      },
      removeItem: () => undefined,
    };
    expect(touchRequested('?ui=touch', refusing)).toBe(true);
    expect(touchRequested('', refusing)).toBe(false);
  });
});
