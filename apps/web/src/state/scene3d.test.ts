import { ChecklistIndex, ProgressCounter, SearchIndex, indexPack } from '@atlas/core';
import { makeFixturePack } from '@atlas/schema/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  floorStep,
  floorsOfMap,
  pickFloor,
  sceneOf,
  setViewMode,
  useScene3d,
  webglFailed,
} from './scene3d';
import { openProgressStore } from './services';
import { useAtlas, type LoadedGame } from './store';

/** The fixture's map with a model and three floors (the surface is the ground floor). */
function makeGame(scene: boolean): LoadedGame {
  const data = makeFixturePack();
  const surface = data.layers[0]!;
  surface.heights = [0, 5];
  data.layers.push(
    { ...surface, id: 'demo:layer:cellar', name: 'Cellar', heights: [-6, 0] },
    { ...surface, id: 'demo:layer:attic', name: 'Attic', heights: [5, 12] },
  );
  if (scene) {
    data.maps[0]!.scene = {
      cells: [
        {
          id: 'c0',
          bounds: [-1000, -600, 0, 400],
          lods: [{ level: 0, file: 'scene/c0/lod0.glb' }],
        },
      ],
    };
  }
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

beforeAll(async () => {
  await openProgressStore();
});

beforeEach(() => {
  useAtlas.setState({
    game: makeGame(true),
    mapId: 'demo:map:world',
    layerId: 'demo:layer:surface',
  });
  useScene3d.setState({ mode: '3d', webgl: 'yes', allFloors: true });
});

describe('maps with a model', () => {
  it('knows a map with a model and a world transform, and its floors lowest first', () => {
    const state = useAtlas.getState();
    expect(sceneOf(state, 'demo:map:world')?.cells).toHaveLength(1);
    expect(sceneOf({ game: makeGame(false) }, 'demo:map:world')).toBeNull();
    expect(floorsOfMap(state, 'demo:map:world').map((layer) => layer.name)).toEqual([
      'Cellar',
      'Surface',
      'Attic',
    ]);
  });

  it('steps through the floors, with All above the top floor in 3D', () => {
    // From All, down shows the top floor.
    expect(floorStep(-1, true)).toBe('Attic');
    expect(useScene3d.getState().allFloors).toBe(false);
    expect(useAtlas.getState().layerId).toBe('demo:layer:attic');
    expect(floorStep(-1, true)).toBe('Surface');
    expect(floorStep(-1, true)).toBe('Cellar');
    expect(floorStep(-1, true)).toBeNull();
    expect(floorStep(1, true)).toBe('Surface');
    expect(floorStep(1, true)).toBe('Attic');
    expect(floorStep(1, true)).toBe('All floors');
    expect(useScene3d.getState().allFloors).toBe(true);
    expect(floorStep(1, true)).toBeNull();
  });

  it('has no All in 2D, where a floor is a level of the map', () => {
    useScene3d.setState({ allFloors: false });
    expect(floorStep(1, false)).toBe('Attic');
    expect(floorStep(1, false)).toBeNull();
  });

  it('picks one floor or all of them', () => {
    pickFloor('demo:layer:cellar');
    expect(useScene3d.getState().allFloors).toBe(false);
    expect(useAtlas.getState().layerId).toBe('demo:layer:cellar');
    pickFloor(null);
    expect(useScene3d.getState().allFloors).toBe(true);
  });

  it('stays in 2D on a device that cannot show the 3D view', () => {
    setViewMode('2d');
    expect(useScene3d.getState().mode).toBe('2d');
    webglFailed();
    setViewMode('3d');
    expect(useScene3d.getState().mode).toBe('2d');
    expect(useScene3d.getState().webgl).toBe('no');
  });
});
