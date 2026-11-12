import type { PageObservations, PictureTilesRequest } from '@atlas/importer-api';
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

describe('what the page loaded when the picture was measured from it', () => {
  const observations: PageObservations = {
    answers: [
      { url: 'https://tiles.example/maps/3/4/5.png', answer: 'image', status: 200 },
      { url: 'https://tiles.example/maps/3/5/5.png', answer: 'missing', status: 404 },
      { url: 'https://tiles.example/maps/3/4/6.png', answer: 'denied', status: 403 },
      { url: 'https://tiles.example/maps/3/3/5.png', answer: 'error', status: 500 },
    ],
    overflow: false,
    steps: 4,
    presses: 3,
    ended: 'done',
  };
  const fromPage: PictureTilesRequest = {
    ...request,
    cachedOnly: true,
    page: {
      present: [[4, 5]],
      absent: [
        [5, 5],
        [4, 6],
      ],
    },
  };

  beforeEach(() => {
    shell.tiles.pictureTiles.mockReset();
    useAtlas.setState({ app: { ...info, downloads: true } });
  });

  it('is given to the importer only with downloads and never in a rebuild', () => {
    const page = (rebuilt: boolean) =>
      importContext('https://site.example/map', '', 'demo', rebuilt, undefined, observations)
        .pageObservations;
    expect(page(false)).toEqual(observations);
    expect(page(true)).toBeUndefined();
    expect(importContext('https://site.example/map', '', 'demo').pageObservations).toBeUndefined();
    useAtlas.setState({ app: { ...info, downloads: false } });
    expect(page(false)).toBeUndefined();
  });

  it('passes on tiles the page showed when they fit what it loaded', async () => {
    const context = importContext(
      'https://site.example/map',
      '',
      'demo',
      false,
      undefined,
      observations,
    );
    const known = {
      ...answer,
      absent: [
        [5, 5],
        [4, 6],
      ],
      fromPage: 1,
    };
    shell.tiles.pictureTiles.mockResolvedValueOnce(known);
    await expect(context.pictureTiles!(fromPage)).resolves.toEqual(known);
    expect(shell.tiles.pictureTiles).toHaveBeenLastCalledWith(fromPage);
  });

  it('refuses tiles the page did not show as said', async () => {
    const context = importContext(
      'https://site.example/map',
      '',
      'demo',
      false,
      undefined,
      observations,
    );
    for (const page of [
      // Not an image, an error, or not loaded at all.
      { present: [[5, 5]], absent: [] },
      { present: [[4, 5]], absent: [[3, 5]] },
      {
        present: [
          [4, 5],
          [1, 1],
        ],
        absent: [],
      },
    ]) {
      await expect(
        context.pictureTiles!({ ...fromPage, page } as PictureTilesRequest),
      ).resolves.toBeNull();
    }
    // Without the page's observations (a rebuild, or no box ticked): none.
    const rebuilt = importContext(
      'https://site.example/map',
      '',
      'demo',
      true,
      undefined,
      observations,
    );
    await expect(rebuilt.pictureTiles!(fromPage)).resolves.toBeNull();
    const plain = importContext('https://site.example/map', '', 'demo');
    await expect(plain.pictureTiles!(fromPage)).resolves.toBeNull();
    expect(shell.tiles.pictureTiles).not.toHaveBeenCalled();
  });

  it('says the picture was measured from the page', () => {
    const page = { zoom: 2, images: 12, missing: 3, unseen: 0, complete: true, used: true };
    expect(pictureText({ measured: true, tiles: 40, page })).toBe(
      'The map picture was measured from the page: it showed 12 map images of it.',
    );
    expect(
      pictureText({
        measured: true,
        tiles: 40,
        page: { ...page, images: 1, complete: false, unseen: 4 },
        note: 'The page did not show all of it, so the places and the last size were added',
      }),
    ).toBe(
      'The map picture was measured from the page: it showed 1 map image of it. The page did not show all of it, so the places and the last size were added.',
    );
    expect(pictureText({ measured: true, tiles: 40, page: { ...page, used: false } })).toBe(
      'The map picture was measured: 40 map images of it were found on the image server.',
    );
  });
});
