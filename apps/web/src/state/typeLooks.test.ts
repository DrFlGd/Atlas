import {
  ChecklistIndex,
  indexPack,
  layerMarkers,
  ProgressCounter,
  SearchIndex,
  type PackEntry,
} from '@atlas/core';
import { NO_OWN_LOCATIONS, type OwnLocations } from '@atlas/schema';
import { makeFixturePack } from '@atlas/schema/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { packWithOwn, undoOwnChange, useOwnLocations } from './ownLocations';
import { useAtlas } from './store';
import { chooseTypeLook } from './typeLooks';

const HERB = 'demo:cat:herb';
const OWN_TYPE = 'demo:cat:own.t1';

const withOwnType: OwnLocations = {
  ...NO_OWN_LOCATIONS,
  categoryGroups: [{ id: 'demo:catgroup:own.g1', name: 'My types', order: 100 }],
  categories: [
    {
      id: OWN_TYPE,
      groupId: 'demo:catgroup:own.g1',
      name: 'Campfire',
      icon: 'flame',
      color: '#e07a2f',
      trackable: true,
      defaultVisible: true,
    },
  ],
};

/** Shows the fixture game with the person's own records, as opening it does. */
function showGame(own: OwnLocations = NO_OWN_LOCATIONS): void {
  const read = indexPack(makeFixturePack(), new URL('https://example.test/demo/'));
  useOwnLocations.setState({
    gameId: 'demo',
    status: 'ready',
    error: null,
    readOnly: null,
    own,
    undo: [],
  });
  const { pack } = packWithOwn(read, own);
  const counter = new ProgressCounter(pack);
  useAtlas.setState({
    game: {
      entry: { id: 'demo' } as unknown as PackEntry,
      pack,
      counter,
      search: new SearchIndex(pack),
      checklists: new ChecklistIndex(pack, (id) => counter.isTrackable(id)),
    },
    selectedId: null,
  });
}

const shownType = (id: string) => useAtlas.getState().game!.pack.categories.get(id)!;
/** The markers of the map (and the 3D view) of the herbs, as they are drawn. */
const herbMarkers = () =>
  layerMarkers(useAtlas.getState().game!.pack, 'demo:layer:surface').filter((m) =>
    m.id.startsWith('demo:loc:0'),
  );

beforeEach(() => {
  // Saving waits on the page's timers; they never run here.
  vi.stubGlobal('window', globalThis);
  vi.useFakeTimers();
  showGame();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the colour and icon of a type of the game shown', () => {
  it('draw the markers and badges anew, and Back to the pack’s own restores them', () => {
    expect(herbMarkers().map((m) => m.color)).toEqual(['#4caf50', '#4caf50']);
    expect(chooseTypeLook(HERB, { color: '#FF00FF', icon: 'star' })).toBeNull();
    // The one type every view reads: the filters, cards, search, lists, the map and 3D.
    expect(shownType(HERB)).toMatchObject({ color: '#ff00ff', icon: 'star', name: 'Herb' });
    expect(herbMarkers().every((m) => m.color === '#ff00ff' && m.icon === 'star')).toBe(true);
    expect(useOwnLocations.getState().own.typeLooks).toEqual([
      { id: HERB, color: '#ff00ff', icon: 'star' },
    ]);
    expect(useAtlas.getState().notice).toMatchObject({
      text: '“Herb” has the colour and icon you chose.',
      action: { label: 'Back to the pack’s own' },
    });

    expect(chooseTypeLook(HERB, null)).toBeNull();
    expect(shownType(HERB)).toMatchObject({ color: '#4caf50', icon: 'leaf' });
    expect(herbMarkers().every((m) => m.color === '#4caf50' && m.icon === 'leaf')).toBe(true);
    expect(useOwnLocations.getState().own.typeLooks).toBeUndefined();
    expect(useAtlas.getState().notice?.text).toBe('“Herb” has the pack’s colour and icon again.');

    // Undo in Edit locations takes the change back.
    expect(undoOwnChange()).toBe('“Herb” has the pack’s colour and icon again');
    expect(shownType(HERB).color).toBe('#ff00ff');
  });

  it('the notice’s Back to the pack’s own restores the pack’s', () => {
    chooseTypeLook(HERB, { color: '#123456', icon: 'leaf' });
    expect(herbMarkers()[0]!.color).toBe('#123456');
    useAtlas.getState().notice!.action!.run();
    expect(herbMarkers()[0]!.color).toBe('#4caf50');
    // The pack's own colour and icon chosen by hand: the pack's own again, nothing kept.
    chooseTypeLook(HERB, { color: '#123456', icon: 'leaf' });
    chooseTypeLook(HERB, { color: '#4CAF50', icon: 'leaf' });
    expect(useOwnLocations.getState().own.typeLooks).toBeUndefined();
    expect(useAtlas.getState().notice?.text).toBe('“Herb” has the pack’s colour and icon again.');
  });

  it('change a type of the person’s own in place', () => {
    showGame(withOwnType);
    expect(chooseTypeLook(OWN_TYPE, { color: '#00ff00', icon: 'eye' })).toBeNull();
    expect(useOwnLocations.getState().own.categories[0]).toMatchObject({
      color: '#00ff00',
      icon: 'eye',
    });
    expect(useOwnLocations.getState().own.typeLooks).toBeUndefined();
    expect(shownType(OWN_TYPE)).toMatchObject({ color: '#00ff00', icon: 'eye' });
  });

  it('are not changed when the person’s own data cannot be, and say why', () => {
    useOwnLocations.setState({ readOnly: 'Saved by a newer version of Atlas.' });
    expect(chooseTypeLook(HERB, { color: '#ff00ff', icon: 'star' })).toBe(
      'Saved by a newer version of Atlas.',
    );
    expect(shownType(HERB).color).toBe('#4caf50');
  });
});
