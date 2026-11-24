import { describe, expect, it, vi } from 'vitest';
import type { ShellBuildRequest, ShellSceneBuilt } from '../desktop';

vi.mock('../desktop', () => ({ desktop: null }));

const { NO_KEPT_MODEL, importContext, keptSceneModels } = await import('./importing');
const { useAtlas } = await import('./store');

const built: ShellSceneBuilt = {
  ok: true,
  scene: {
    heights: [0, 1],
    cells: [
      {
        id: 'c0-0',
        bounds: [0, 0, 10, 10],
        lods: [{ level: 0, file: 'scene/harbour/c0-0/lod0.glb', triangles: 2 }],
      },
    ],
  },
  rendered: {
    width: 256,
    height: 256,
    worldTransform: { a: 1, b: 0, c: 0, d: 0, e: -1, f: 0 },
    layers: [
      {
        id: 'all',
        url: 'tiles/harbour/all/{z}/{x}/{y}.png',
        minZoom: 0,
        maxZoom: 0,
        tileSize: 256,
      },
    ],
  },
  triangles: 2,
  warnings: [],
  problem: null,
  message: null,
};

const tilesWith = (kept: Record<string, string>) => ({
  reuseModel: vi.fn((_packId: string, folder: string) => Promise.resolve(kept[folder] ?? null)),
  buildScene: vi.fn((_build: string, _request: ShellBuildRequest) => Promise.resolve(built)),
});

describe('building a 3D map again from the model its game keeps', () => {
  it('builds the kept model as the importer asks, keeping it again, and fetches nothing', async () => {
    const tiles = tilesWith({ harbour: 'kept-1' });
    const builds: string[] = [];
    const sceneModel = keptSceneModels(tiles, 'example-3d-maps-map', () => true, builds);
    const answer = await sceneModel({
      folder: 'harbour',
      url: 'https://maps.example.net/worlds/harbour/model.glb',
      textures: 'average',
      sky: '#101820',
    });
    expect(answer).toMatchObject({ ok: true, build: 'kept-1', width: 256, triangles: 2 });
    expect(tiles.reuseModel).toHaveBeenCalledWith('example-3d-maps-map', 'harbour');
    // The address is never used: only how to build it.
    expect(tiles.buildScene).toHaveBeenCalledWith('kept-1', {
      folder: 'harbour',
      textures: 'average',
      sky: '#101820',
      keepModel: true,
      oneCell: true,
    });
    expect(builds).toEqual(['kept-1']);
  });

  it('says plainly when no model is kept, and when the build failed', async () => {
    const tiles = tilesWith({ harbour: 'kept-2' });
    const builds: string[] = [];
    const sceneModel = keptSceneModels(tiles, 'example-3d-maps-map', () => true, builds);
    const pieces = {
      urls: ['https://maps.example.net/worlds/old-mill/model-0.json'],
      field: 'data',
    };
    expect(await sceneModel({ folder: 'old-mill', pieces })).toEqual({
      ok: false,
      problem: 'missing',
      message: NO_KEPT_MODEL,
    });
    expect(tiles.buildScene).not.toHaveBeenCalled();
    tiles.buildScene.mockResolvedValueOnce({
      ...built,
      ok: false,
      rendered: null,
      problem: 'format',
      message: 'The model cannot be read.',
    });
    expect(await sceneModel({ folder: 'harbour', url: 'https://maps.example.net/h.glb' })).toEqual({
      ok: false,
      problem: 'format',
      message: 'The model cannot be read.',
    });
    // A build made is named, so it is thrown away when no saved game takes it.
    expect(builds).toEqual(['kept-2']);
    expect(
      await sceneModel({ folder: '../harbour', url: 'https://maps.example.net/h.glb' }),
    ).toMatchObject({
      ok: false,
      problem: 'failed',
    });
  });

  it('stops with the session', async () => {
    const tiles = tilesWith({ harbour: 'kept-3' });
    const builds: string[] = [];
    const sceneModel = keptSceneModels(tiles, 'example-3d-maps-map', () => false, builds);
    expect(
      await sceneModel({ folder: 'harbour', url: 'https://maps.example.net/h.glb' }),
    ).toMatchObject({ ok: false, problem: 'cancelled' });
    expect(tiles.buildScene).not.toHaveBeenCalled();
    expect(builds).toEqual(['kept-3']);
  });

  it('is handed to the importer in a game built again, with downloads', () => {
    const info = { name: 'Atlas', version: '0.4.0', platform: 'linux' };
    useAtlas.setState({ app: { ...info, downloads: true } });
    const sceneModel = keptSceneModels(tilesWith({}), 'example-3d-maps-map', () => true, []);
    const given = (downloads: boolean) => {
      useAtlas.setState({ app: { ...info, downloads } });
      return importContext(
        'https://maps.example.net/worlds/harbour/data.json',
        '',
        'demo',
        true,
        undefined,
        undefined,
        undefined,
        {
          sceneModel,
        },
      );
    };
    expect('sceneModel' in given(true) && given(true).rebuild).toBe(true);
    expect('sceneModel' in given(false)).toBe(false);
  });
});
