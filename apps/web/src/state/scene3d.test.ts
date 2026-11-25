import { ChecklistIndex, ProgressCounter, SearchIndex, indexPack } from '@atlas/core';
import { makeFixturePack } from '@atlas/schema/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cutOf,
  floorColoursReason,
  floorStep,
  floorsOfMap,
  focusLocation,
  leaveFocus,
  loadSceneSettings,
  lookOf,
  pickFloor,
  requestSceneView,
  setCut,
  savedLook,
  setFloorColoursShown,
  setLook,
  setOwnLook,
  setShade,
  setStrongShade,
  sceneOf,
  setViewMode,
  useScene3d,
  webglFailed,
} from './scene3d';
import { openProgressStore, progressStore, SETTINGS } from './services';
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
  useScene3d.setState({ mode: '3d', webgl: 'yes', allFloors: true, focus: null, cut: null });
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

  it('goes to a location: its floor, the cut above it, and back to every floor', () => {
    const id = useAtlas.getState().game!.pack.data.locations[0]!.id;
    useAtlas.setState({ selectedId: id });
    focusLocation(id, 'demo:layer:cellar', -2);
    expect(useScene3d.getState()).toMatchObject({ allFloors: false, focus: { id, cut: -2 } });
    expect(useAtlas.getState().layerId).toBe('demo:layer:cellar');
    // The location stays selected, though it is on another layer.
    expect(useAtlas.getState().selectedId).toBe(id);
    leaveFocus();
    expect(useScene3d.getState()).toMatchObject({ allFloors: true, focus: null });

    // All floors, a floor picked, Back to the start and the free cut each go back too.
    for (const back of [
      () => {
        pickFloor(null);
      },
      () => {
        pickFloor('demo:layer:attic');
      },
      () => {
        requestSceneView('recenter');
      },
      () => {
        setCut(3, 'demo:map:world');
      },
    ]) {
      focusLocation(id, 'demo:layer:cellar', -2);
      back();
      expect(useScene3d.getState().focus).toBeNull();
    }

    // Without a floor: only the cut.
    useScene3d.setState({ allFloors: true });
    focusLocation(id, null, 4);
    expect(useScene3d.getState()).toMatchObject({ allFloors: true, focus: { id, cut: 4 } });
  });

  it('keeps a free cut to the map it was set on', () => {
    setCut(1477, 'demo:map:world');
    expect(cutOf(useScene3d.getState(), 'demo:map:world')).toBe(1477);
    // Another map, at heights of its own, is not cut away by it.
    expect(cutOf(useScene3d.getState(), 'demo:map:other')).toBeNull();
    expect(cutOf(useScene3d.getState(), null)).toBeNull();
    setCut(null, 'demo:map:world');
    expect(cutOf(useScene3d.getState(), 'demo:map:world')).toBeNull();
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

describe('Floor colours', () => {
  it('is off at first, and turned on or off is kept on the device', async () => {
    expect(useScene3d.getState().floorColours).toBe(false);
    setFloorColoursShown(true);
    expect(useScene3d.getState().floorColours).toBe(true);
    await expect.poll(() => progressStore().getSetting(SETTINGS.sceneFloorColours)).toBe(true);
    useScene3d.setState({ floorColours: false });
    await loadSceneSettings();
    expect(useScene3d.getState().floorColours).toBe(true);
    setFloorColoursShown(false);
    await expect.poll(() => progressStore().getSetting(SETTINGS.sceneFloorColours)).toBe(false);
  });

  it('needs floors, and says so on a map without them', () => {
    const state = useAtlas.getState();
    expect(floorColoursReason(floorsOfMap(state, 'demo:map:world'))).toBeNull();
    expect(floorColoursReason([])).toBe('This map has no floors');
  });
});

describe('Look', () => {
  beforeEach(() => {
    useScene3d.setState({ look: 'textured', shade: 'teal', strongShade: false, ownLook: null });
  });

  it('is textured where the model has its own textures, else shaded in teal, at first', () => {
    expect(useScene3d.getState()).toMatchObject({
      look: 'textured',
      shade: 'teal',
      strongShade: false,
    });
    // Nothing of the model in yet, then a model made from collision, then a textured one.
    expect(lookOf(useScene3d.getState())).toBe('shaded');
    setOwnLook(false);
    expect(lookOf(useScene3d.getState())).toBe('shaded');
    setOwnLook(true);
    expect(lookOf(useScene3d.getState())).toBe('textured');
    setLook('shaded');
    expect(lookOf(useScene3d.getState())).toBe('shaded');
  });

  it('shows a textured model shaded when a colour is picked, and keeps the choice of a model without textures', () => {
    setOwnLook(true);
    setShade('sand');
    expect(useScene3d.getState()).toMatchObject({ look: 'shaded', shade: 'sand' });
    // On a model without textures, shaded already: textured stays asked for, for the next textured map.
    useScene3d.setState({ look: 'textured' });
    setOwnLook(false);
    setShade('#336699');
    setStrongShade(true);
    expect(useScene3d.getState()).toMatchObject({
      look: 'textured',
      shade: '#336699',
      strongShade: true,
    });
    setOwnLook(true);
    setStrongShade(false);
    expect(useScene3d.getState()).toMatchObject({ look: 'shaded', strongShade: false });
  });

  it('takes only colours it can shade with', () => {
    setShade('not a colour');
    setShade('#12345');
    expect(useScene3d.getState().shade).toBe('teal');
  });

  it('is kept on the device: the look, the colour and darker walls', async () => {
    setOwnLook(true);
    setShade('slate');
    setStrongShade(true);
    await expect
      .poll(() => progressStore().getSetting(SETTINGS.sceneLook))
      .toEqual({ look: 'shaded', shade: 'slate', strong: true });
    useScene3d.setState({ look: 'textured', shade: 'teal', strongShade: false });
    await loadSceneSettings();
    expect(useScene3d.getState()).toMatchObject({
      look: 'shaded',
      shade: 'slate',
      strongShade: true,
    });
    setLook('textured');
    await expect
      .poll(() => progressStore().getSetting(SETTINGS.sceneLook))
      .toEqual({ look: 'textured', shade: 'slate', strong: true });
  });

  it('reads back only what it can of a kept look', () => {
    expect(savedLook(null)).toEqual({});
    expect(savedLook('shaded')).toEqual({});
    expect(savedLook({ look: 'wireframe', shade: 'plum', strong: 1 })).toEqual({});
    expect(savedLook({ look: 'shaded', shade: '#a0b0c0', strong: false })).toEqual({
      look: 'shaded',
      shade: '#a0b0c0',
      strongShade: false,
    });
  });
});
