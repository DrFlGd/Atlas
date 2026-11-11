import { ChecklistIndex, ProgressCounter, SearchIndex, indexPack } from '@atlas/core';
import { makeFixturePack } from '@atlas/schema/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setFound, undo } from './actions';
import { appLinkKind, checklistScreenTitle, setItemDone } from './checklists';
import { openProgressStore, progressStore } from './services';
import { useAtlas, type LoadedGame } from './store';

function makeGame(): LoadedGame {
  const data = makeFixturePack();
  data.checklists.push({ id: 'demo:checklist:steps', name: 'Steps', order: 1, kind: 'guide' });
  data.checklistItems.push(
    {
      id: 'demo:checkitem:both',
      checklistId: 'demo:checklist:herbs',
      name: 'Both herbs',
      order: 1,
      locationIds: ['demo:loc:0001', 'demo:loc:0002'],
      entityIds: [],
    },
    {
      id: 'demo:checkitem:talk',
      checklistId: 'demo:checklist:steps',
      name: 'Talk to the ferryman',
      order: 0,
      locationIds: [],
      entityIds: [],
    },
  );
  data.manifest.idMigrations = { 'demo:loc:old-1': 'demo:loc:0001' };
  const pack = indexPack(data, new URL('https://packs.example.test/demo/'));
  const counter = new ProgressCounter(pack);
  return {
    entry: { id: 'demo', url: 'packs/demo/', title: 'Demo' },
    pack,
    counter,
    search: new SearchIndex(pack),
    checklists: new ChecklistIndex(pack, (id) => counter.isTrackable(id)),
  };
}

const found = () => [...useAtlas.getState().found.keys()].sort();

beforeAll(async () => {
  // Without IndexedDB (as here) the app keeps progress in memory.
  await openProgressStore();
});

beforeEach(() => {
  useAtlas.setState({
    game: makeGame(),
    profileId: 'p',
    rows: new Map(),
    found: new Map(),
    undo: [],
  });
});

describe('ticking checklist items', () => {
  it('marks every location of an item found, and one undo takes it all back', async () => {
    setFound('demo:loc:0002', true);
    setItemDone('demo:checkitem:both', true);
    expect(found()).toEqual(['demo:loc:0001', 'demo:loc:0002']);
    expect(useAtlas.getState().notice?.text).toContain('One place marked found');

    // Unticking unmarks all of its locations, also the one marked on the map.
    setItemDone('demo:checkitem:both', false);
    expect(found()).toEqual([]);
    undo();
    expect(found()).toEqual(['demo:loc:0001', 'demo:loc:0002']);
    undo();
    expect(found()).toEqual(['demo:loc:0002']);
    undo();
    expect(found()).toEqual([]);
    expect(useAtlas.getState().selectedId).toBe('demo:loc:0002');

    // Every change was saved.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = await progressStore().listProgress('p', { includeDeleted: true });
    expect(rows.filter((r) => !r.deleted)).toEqual([]);
  });

  it('gives a step its own done mark, saved and undone like a found mark', async () => {
    setItemDone('demo:checkitem:talk', true);
    expect(found()).toEqual(['demo:checkitem:talk']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await progressStore().listProgress('p')).map((r) => r.targetId)).toContain(
      'demo:checkitem:talk',
    );
    // Ticking again changes nothing and adds no undo step.
    setItemDone('demo:checkitem:talk', true);
    expect(useAtlas.getState().undo).toHaveLength(1);
    undo();
    expect(found()).toEqual([]);
    expect(useAtlas.getState().notice?.text).toBe('Undone: “Talk to the ferryman” is as it was.');
  });
});

describe('in-app links', () => {
  it('resolve to what the pack has, following id migrations', () => {
    const game = makeGame();
    expect(appLinkKind(game, 'demo:loc:0001')).toBe('location');
    expect(appLinkKind(game, 'demo:loc:old-1')).toBe('location');
    expect(appLinkKind(game, 'demo:region:north')).toBe('region');
    expect(appLinkKind(game, 'demo:map:world')).toBe('map');
    expect(appLinkKind(game, 'demo:checklist:herbs')).toBe('checklist');
    expect(appLinkKind(game, 'demo:checkitem:talk')).toBe('item');
    expect(appLinkKind(game, 'demo:guide:herbs')).toBe('guide');
    for (const missing of [
      'demo:loc:9999',
      'other:loc:0001',
      'demo:entity:moss',
      'demo:cat:herb',
      'https://example.test/',
      'not an id',
    ]) {
      expect(appLinkKind(game, missing)).toBeNull();
    }
  });

  it('name the screen after what the pack has', () => {
    const game = makeGame();
    // One checklist and one list that is a guide.
    expect(checklistScreenTitle(game)).toBe('Checklists and guides');
  });
});
