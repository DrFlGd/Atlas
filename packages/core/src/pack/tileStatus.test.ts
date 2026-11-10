import type { Layer } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { makeTestPack } from '../testing/packs';
import {
  isDownloadable,
  nativeZoomOf,
  readTileStatus,
  tileStatusPath,
  type TileStatusFile,
} from './tileStatus';

const remoteLayer = (): Layer => {
  const pack = makeTestPack();
  const layer = pack.layers.get('demo:layer:surface')!;
  return {
    ...layer,
    tiles: {
      type: 'xyz',
      url: 'tiles/surface/{z}/{x}/{y}.jpg',
      remote: {
        urlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.jpg',
        levels: [{ z: 2, sourceZ: 9, offsetX: 4, offsetY: 8 }],
      },
    },
  };
};

const status = (layerId: string, levels: number[], max: number | null): TileStatusFile => ({
  format: 'atlas-tile-status',
  version: 1,
  layerId,
  levels,
  nativeMinZoom: max === null ? null : 0,
  nativeMaxZoom: max,
  complete: max === 2,
  updatedAt: 1,
});

describe('tile status files', () => {
  it('belong to downloadable layers only', () => {
    const pack = makeTestPack();
    expect(isDownloadable(pack.layers.get('demo:layer:surface')!)).toBe(false);
    expect(tileStatusPath(pack.layers.get('demo:layer:lower')!)).toBeNull();
    expect(isDownloadable(remoteLayer())).toBe(true);
    expect(tileStatusPath(remoteLayer())).toBe('offline-tiles/surface.json');
  });

  it('are read from the pack and checked', async () => {
    const pack = makeTestPack();
    const layer = remoteLayer();
    const requested: string[] = [];
    const serve = (body: unknown, ok = true) =>
      ((url: string) => {
        requested.push(url);
        return Promise.resolve(
          ok ? Response.json(body) : new Response('not found', { status: 404 }),
        );
      }) as typeof fetch;

    const read = await readTileStatus(pack, layer, serve(status(layer.id, [0, 1], 1)));
    expect(requested[0]).toBe(pack.resolveUrl('offline-tiles/surface.json'));
    expect(read?.nativeMaxZoom).toBe(1);
    expect(nativeZoomOf(layer, read)).toEqual({ min: 0, max: 1 });

    expect(await readTileStatus(pack, layer, serve(null, false))).toBeNull();
    expect(await readTileStatus(pack, layer, serve(status('demo:layer:other', [0], 0)))).toBeNull();
    expect(await readTileStatus(pack, layer, serve({ format: 'something else' }))).toBeNull();
    const offline = (() => Promise.reject(new TypeError('offline'))) as typeof fetch;
    expect(await readTileStatus(pack, layer, offline)).toBeNull();
    // A layer that cannot be downloaded has no status file to ask for.
    requested.length = 0;
    expect(
      await readTileStatus(pack, pack.layers.get('demo:layer:surface')!, serve({})),
    ).toBeNull();
    expect(requested).toEqual([]);
  });

  it('give no native range until the lowest level is there', () => {
    const layer = remoteLayer();
    expect(nativeZoomOf(layer, null)).toBeNull();
    expect(nativeZoomOf(layer, status(layer.id, [2], null))).toBeNull();
    // Clamped to the layer's own range.
    expect(nativeZoomOf(layer, { ...status(layer.id, [0, 1, 2], 2), nativeMaxZoom: 9 })).toEqual({
      min: 0,
      max: 2,
    });
  });
});
