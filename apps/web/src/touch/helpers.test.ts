import type { ChecklistEntry, ChecklistItemEntry, SearchEntry, SearchHit } from '@atlas/core';
import { describe, expect, it } from 'vitest';
import { backStep, type BackState } from './backStack';
import { arrangementFor, editorFits, panelWidthFor } from './layout';
import { nextOnList, orderHits, revealShift, type Placed } from './ordering';
import { parseRecent, withRecent } from './recent';
import { keyList, withKey } from './keys';
import { forgetRequestedUi, parseLayout, requestedUi, shownUi, uiFromSearch } from './uiMode';

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

  it('is wide from 840 px in a window on a computer, whatever its height', () => {
    expect(arrangementFor(1920, 1080, 'mouse')).toBe('wide');
    expect(arrangementFor(1024, 700, 'mouse')).toBe('wide');
    expect(arrangementFor(840, 400, 'mouse')).toBe('wide');
    expect(arrangementFor(839, 1000, 'mouse')).toBe('compact');
    // Not a phone on its side: a short window stays compact.
    expect(arrangementFor(700, 500, 'mouse')).toBe('compact');
    expect(arrangementFor(700, 500, 'touch')).toBe('wide');
  });

  it('gives a phone on its side a narrower panel', () => {
    expect(panelWidthFor(1280, 800)).toBe(360);
    expect(panelWidthFor(844, 390)).toBe(320);
    expect(panelWidthFor(800, 1280)).toBe(360);
  });

  it('offers the list editor on a tablet on its side and a computer, not on a phone', () => {
    expect(editorFits(1280, 800, 'mouse')).toBe(true);
    expect(editorFits(960, 600)).toBe(true);
    // A phone on its side is wide, but too short for the editor.
    expect(editorFits(844, 390)).toBe(false);
    expect(editorFits(390, 844)).toBe(false);
    // A tablet held upright is compact.
    expect(editorFits(800, 1280)).toBe(false);
    expect(editorFits(839, 800, 'mouse')).toBe(false);
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
          'guides-back': { guidesBack: false },
          'to-map': { section: 'map' as const },
          'editor-picking': { editor: 'panel' as const },
          'editor-panel': { editor: 'open' as const },
          'editor-preview': { editor: 'open' as const },
          'editor-leave': { editor: null },
          'page-editor-leave': { pageEditor: false },
        }[step],
      };
    }
    expect(steps).toEqual(['dialog', 'collapse-place', 'filters', 'place', 'lists-page', 'to-map']);
  });

  it('closes the page editor before going back in Guides', () => {
    const state: BackState = { ...nothing, section: 'guides', guidesBack: true, pageEditor: true };
    expect(backStep(state)).toBe('page-editor-leave');
    expect(backStep({ ...state, dialog: true })).toBe('dialog');
    expect(backStep({ ...state, pageEditor: false })).toBe('guides-back');
  });

  it('closes what is open in the list editor, then the editor, before the list', () => {
    let state: BackState = {
      ...nothing,
      section: 'lists',
      listsPage: true,
      editor: 'picking',
    };
    const steps = [];
    for (let step = backStep(state); step; step = backStep(state)) {
      steps.push(step);
      const next: Partial<BackState> =
        step === 'editor-picking'
          ? { editor: 'panel' }
          : step === 'editor-panel'
            ? { editor: 'open' }
            : step === 'editor-leave'
              ? { editor: null }
              : step === 'lists-page'
                ? { listsPage: false }
                : { section: 'map' };
      state = { ...state, ...next };
    }
    expect(steps).toEqual([
      'editor-picking',
      'editor-panel',
      'editor-leave',
      'lists-page',
      'to-map',
    ]);
    expect(backStep({ ...nothing, section: 'lists', listsPage: true, editor: 'preview' })).toBe(
      'editor-preview',
    );
    // A dialog over the editor closes first.
    expect(backStep({ ...nothing, dialog: true, editor: 'panel' })).toBe('dialog');
  });

  it('closes search and the map chooser before the place', () => {
    expect(backStep({ ...nothing, search: true, place: true })).toBe('search');
    expect(backStep({ ...nothing, mapsMenu: true, search: true })).toBe('maps-menu');
    // A sheet pulled up is only collapsed while its place is shown.
    expect(backStep({ ...nothing, placeExpanded: true })).toBeNull();
    expect(backStep({ ...nothing, section: 'progress' })).toBe('to-map');
    expect(backStep({ ...nothing, section: 'games', listsPage: true })).toBe('to-map');
  });

  it('goes back through the pages read in Guides, then to the first section', () => {
    expect(backStep({ ...nothing, section: 'guides', guidesBack: true })).toBe('guides-back');
    expect(backStep({ ...nothing, section: 'guides' })).toBe('to-map');
    expect(backStep({ ...nothing, section: 'lists', guidesBack: true })).toBe('to-map');
    // A game with no map: Back ends on Guides.
    expect(backStep({ ...nothing, section: 'guides', home: 'guides' })).toBeNull();
    expect(backStep({ ...nothing, section: 'progress', home: 'guides' })).toBe('to-map');
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

describe('choosing the layout', () => {
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
    expect(uiFromSearch('?ui=standard')).toBe('standard');
    expect(uiFromSearch('?ui=classic')).toBe('classic');
    // The older name of the classic layout.
    expect(uiFromSearch('?pack=demo&ui=desktop')).toBe('classic');
    expect(uiFromSearch('?ui=other')).toBeNull();
    expect(uiFromSearch('?ui=constructor')).toBeNull();
    expect(uiFromSearch('')).toBeNull();
  });

  it('keeps the choice for the session until the address says otherwise', () => {
    const session = storage();
    expect(requestedUi('', session)).toBeNull();
    expect(requestedUi('?ui=touch', session)).toBe('touch');
    expect(requestedUi('', session)).toBe('touch');
    expect(requestedUi('?ui=desktop', session)).toBe('classic');
    expect(requestedUi('', session)).toBe('classic');
    expect(requestedUi('?ui=standard', session)).toBe('standard');
    expect(requestedUi('', session)).toBe('standard');
    forgetRequestedUi(session);
    expect(requestedUi('', session)).toBeNull();
    expect(requestedUi('?ui=touch', null)).toBe('touch');
    session.setItem('atlas-ui', 'something else');
    expect(requestedUi('', session)).toBeNull();
    const refusing = {
      getItem: () => {
        throw new Error('no');
      },
      setItem: () => {
        throw new Error('no');
      },
      removeItem: () => {
        throw new Error('no');
      },
    };
    expect(requestedUi('?ui=touch', refusing)).toBe('touch');
    expect(requestedUi('', refusing)).toBeNull();
    expect(() => {
      forgetRequestedUi(refusing);
    }).not.toThrow();
  });

  it('shows the standard layout unless the classic one is chosen or asked for', () => {
    const base = { android: false, requested: null, saved: 'standard', coarse: false } as const;
    expect(shownUi(base)).toEqual({ layout: 'standard', input: 'mouse' });
    expect(shownUi({ ...base, coarse: true })).toEqual({ layout: 'standard', input: 'touch' });
    expect(shownUi({ ...base, saved: 'classic' })).toEqual({ layout: 'classic', input: 'mouse' });
    // The address wins over the setting, both ways.
    expect(shownUi({ ...base, requested: 'classic' }).layout).toBe('classic');
    expect(shownUi({ ...base, saved: 'classic', requested: 'standard' })).toEqual({
      layout: 'standard',
      input: 'mouse',
    });
    expect(shownUi({ ...base, saved: 'classic', requested: 'touch' })).toEqual({
      layout: 'standard',
      input: 'touch',
    });
  });

  it('always shows the standard layout for fingers in the Android app', () => {
    const android = { android: true, requested: null, saved: 'standard', coarse: false } as const;
    expect(shownUi(android)).toEqual({ layout: 'standard', input: 'touch' });
    expect(shownUi({ ...android, saved: 'classic', requested: 'classic' })).toEqual({
      layout: 'standard',
      input: 'touch',
    });
  });

  it('reads the saved setting', () => {
    expect(parseLayout('classic')).toBe('classic');
    expect(parseLayout('standard')).toBe('standard');
    expect(parseLayout(undefined)).toBe('standard');
    expect(parseLayout(42)).toBe('standard');
  });
});

describe('keys', () => {
  it('lists the classic keys, with C only where there are lists', () => {
    const keys = keyList('Checklists and guides').flatMap((k) => k.keys);
    expect(keys).toEqual(['/', 'N', 'F', 'Z', 'C', 'Esc', '?']);
    expect(keyList(null).flatMap((k) => k.keys)).not.toContain('C');
    expect(keyList('Lists').find((k) => k.keys[0] === 'C')?.what).toBe('Lists, or back to the map');
  });

  it('adds the key to a tooltip where keys are shown', () => {
    expect(withKey('Lists', 'C', true)).toBe('Lists (C)');
    expect(withKey('Lists', 'C', false)).toBe('Lists');
  });
});
