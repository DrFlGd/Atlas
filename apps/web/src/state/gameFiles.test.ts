import { describe, expect, it, vi } from 'vitest';
import type { ShellBuildRequest, ShellSceneBuilt } from '../desktop';
import { MODEL_PART_BYTES, gameFolderOf, localSceneModels } from './gameFiles';

/** A made-up model: `size` bytes starting with glTF's magic. */
const model = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x67, 0x6c, 0x54, 0x46]);
  return bytes;
};

const built: ShellSceneBuilt = {
  ok: true,
  scene: {
    offset: [0, 0, 0],
    heights: [0, 1],
    cells: [
      {
        id: 'c0-0',
        bounds: [0, 0, 10, 10],
        heights: [0, 1],
        lods: [{ level: 0, file: 'scene/level-1/c0-0/lod0.glb', triangles: 2 }],
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
        url: 'tiles/level-1/all/{z}/{x}/{y}.png',
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

describe('making 3D maps from game files', () => {
  it('sends the model in parts and builds it with its textures kept', async () => {
    const parts: number[] = [];
    const keepModel = vi.fn((part: Uint8Array, build: string | null) => {
      parts.push(part.byteLength);
      return Promise.resolve(build ?? 'local-1');
    });
    const buildScene = vi.fn((_build: string, _request: ShellBuildRequest) =>
      Promise.resolve(built),
    );
    const builds: string[] = [];
    const sceneModel = localSceneModels({ keepModel, buildScene }, builds);
    const size = MODEL_PART_BYTES + 100;
    const answer = await sceneModel({ folder: 'level-1', model: model(size), scale: 0.0254 });
    expect(answer.ok).toBe(true);
    expect(parts).toEqual([MODEL_PART_BYTES, 100]);
    expect(keepModel.mock.calls[1]![1]).toBe('local-1');
    expect(builds).toEqual(['local-1']);
    expect(buildScene).toHaveBeenCalledWith('local-1', {
      folder: 'level-1',
      scale: 0.0254,
      textures: 'keep',
    });
  });

  it('never reads a model from a site, and says why a build failed', async () => {
    const keepModel = vi.fn(() => Promise.resolve('local-2'));
    const buildScene = vi.fn(() =>
      Promise.resolve({
        ...built,
        ok: false,
        rendered: null,
        problem: 'format',
        message: 'Not a model.',
      }),
    );
    const sceneModel = localSceneModels({ keepModel, buildScene }, []);
    expect(await sceneModel({ folder: 'a', url: 'https://maps.example.net/m.glb' })).toMatchObject({
      ok: false,
    });
    expect(keepModel).not.toHaveBeenCalled();
    expect(await sceneModel({ folder: 'a', model: model(64) })).toEqual({
      ok: false,
      problem: 'format',
      message: 'Not a model.',
    });
  });

  it('reads the folder picked through the shell, whole files within the limit', async () => {
    const readGameFile = vi.fn(() => Promise.resolve(new Uint8Array(4)));
    const listGameFolder = vi.fn(() => Promise.resolve([{ name: 'maps', folder: true, size: 0 }]));
    const downloadGameFile = vi.fn(() => Promise.resolve(new Uint8Array(2)));
    const folder = gameFolderOf(
      { readGameFile, listGameFolder, downloadGameFile },
      { token: 't1', name: 'Made Up' },
    );
    expect(folder.name).toBe('Made Up');
    // A folder picked never downloads.
    expect('download' in folder).toBe(false);
    await folder.list('');
    expect(listGameFolder).toHaveBeenCalledWith('t1', '');
    await folder.read('maps/a.bsp');
    expect(readGameFile).toHaveBeenLastCalledWith('t1', 'maps/a.bsp', 0, 512 * 1024 * 1024);
    await folder.read('maps/a.bsp', 16.7, 8);
    expect(readGameFile).toHaveBeenLastCalledWith('t1', 'maps/a.bsp', 16, 8);
  });

  it('downloads only into the app’s own folder for a game’s files, through the shell', async () => {
    const readGameFile = vi.fn(() => Promise.resolve(new Uint8Array(4)));
    const listGameFolder = vi.fn(() => Promise.resolve([]));
    const downloadGameFile = vi.fn(() => Promise.resolve(new Uint8Array([1, 2])));
    const folder = gameFolderOf(
      { readGameFile, listGameFolder, downloadGameFile },
      { token: 'k1', name: 'made-up-game', downloads: true },
    );
    const bytes = await folder.download!('https://example.org/Game/01.bin?v=1', 'Game/01.bin');
    expect([...bytes]).toEqual([1, 2]);
    expect(downloadGameFile).toHaveBeenCalledWith(
      'k1',
      'https://example.org/Game/01.bin?v=1',
      'Game/01.bin',
    );
  });
});
