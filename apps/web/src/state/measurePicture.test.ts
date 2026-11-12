import type { PictureTilesRequest } from '@atlas/importer-api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const shell = vi.hoisted(() => ({
  tiles: {
    pictureTiles: vi.fn<(request: unknown) => Promise<unknown>>(),
    cancelPicture: vi.fn<() => Promise<void>>(),
  },
}));
vi.mock('../desktop', () => ({ desktop: shell }));

const { importContext, pictureText } = await import('./importing');
const { useAtlas } = await import('./store');

const info = { name: 'Atlas', version: '0.4.0', platform: 'linux' };
const request: PictureTilesRequest = {
  urlTemplate: 'https://tiles.example/maps/{z}/{x}/{y}.png',
  zoom: 3,
  start: [4, 5],
};
const answer = { zoom: 3, present: [[4, 5]], absent: [[3, 4]], complete: true };

describe('measuring the picture of an imported map', () => {
  beforeEach(() => {
    shell.tiles.pictureTiles.mockReset();
    useAtlas.setState({ app: { ...info, downloads: true } });
  });

  it('is offered only when the shell downloads map images', () => {
    const offered = () => 'pictureTiles' in importContext('https://site.example/map', '', 'demo');
    expect(offered()).toBe(true);
    useAtlas.setState({ app: { ...info, downloads: false } });
    expect(offered()).toBe(false);
    useAtlas.setState({ app: null });
    expect(offered()).toBe(false);
  });

  it('asks the shell and checks what it answers', async () => {
    const measuring = vi.fn();
    const context = importContext('https://site.example/map', '', 'demo', false, measuring);
    shell.tiles.pictureTiles.mockResolvedValueOnce(answer);
    await expect(context.pictureTiles!(request)).resolves.toEqual(answer);
    expect(shell.tiles.pictureTiles).toHaveBeenLastCalledWith({ ...request, cachedOnly: false });
    expect(measuring).toHaveBeenCalledTimes(1);

    // An answer about another zoom, without the start tile, or a failure: none.
    shell.tiles.pictureTiles.mockResolvedValueOnce({ ...answer, zoom: 4 });
    await expect(context.pictureTiles!(request)).resolves.toBeNull();
    shell.tiles.pictureTiles.mockResolvedValueOnce({ ...answer, present: [[1, 1]] });
    await expect(context.pictureTiles!(request)).resolves.toBeNull();
    shell.tiles.pictureTiles.mockResolvedValueOnce(null);
    await expect(context.pictureTiles!(request)).resolves.toBeNull();
    shell.tiles.pictureTiles.mockRejectedValueOnce(new Error('The command is not allowed.'));
    await expect(context.pictureTiles!(request)).resolves.toBeNull();

    // Only what was learnt before: nothing is said about measuring.
    shell.tiles.pictureTiles.mockResolvedValueOnce(answer);
    await context.pictureTiles!({ ...request, cachedOnly: true });
    expect(shell.tiles.pictureTiles).toHaveBeenLastCalledWith({ ...request, cachedOnly: true });
    expect(measuring).toHaveBeenCalledTimes(5);
  });

  it('never asks the image server when a pack is rebuilt', async () => {
    const context = importContext('https://site.example/map', '', 'demo', true);
    shell.tiles.pictureTiles.mockResolvedValueOnce(answer);
    await expect(context.pictureTiles!(request)).resolves.toEqual(answer);
    expect(shell.tiles.pictureTiles).toHaveBeenLastCalledWith({ ...request, cachedOnly: true });
  });

  it('does not pass on a request it cannot use', async () => {
    const context = importContext('https://site.example/map', '', 'demo');
    for (const bad of [
      { ...request, urlTemplate: 'http://tiles.example/{z}/{x}/{y}.png' },
      { ...request, urlTemplate: 'https://tiles.example/{z}/{x}.png' },
      { ...request, start: [8, 0] },
      { ...request, zoom: 31 },
      { ...request, extra: 'field', start: 'nope' },
    ]) {
      await expect(context.pictureTiles!(bad as PictureTilesRequest)).resolves.toBeNull();
    }
    expect(shell.tiles.pictureTiles).not.toHaveBeenCalled();
  });

  it('says how the picture was sized in plain words', () => {
    expect(pictureText({ measured: true, tiles: 40 })).toBe(
      'The map picture was measured: 40 map images of it were found on the image server.',
    );
    expect(pictureText({ measured: true, tiles: 1 })).toMatch(/: 1 map image of it was found/);
    expect(pictureText({ measured: false, note: 'The image server could not be asked' })).toBe(
      'The map picture could not be measured, so its size was estimated from where the places are. The image server could not be asked.',
    );
  });
});
