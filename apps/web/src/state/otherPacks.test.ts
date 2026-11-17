import type * as Core from '@atlas/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadPack = vi.hoisted(() => vi.fn());
vi.mock('@atlas/core', async (original) => ({
  ...(await original<typeof Core>()),
  loadPack: (url: string) => loadPack(url) as unknown,
}));

import { OTHERS_EVERY_MS, OTHERS_SETTLE_MS, packAt, useGuideLinks } from './guideLinks';
import { notePackSaved } from './packTurns';
import { useAtlas } from './store';

/** A pack as far as these tests look at it: whose it is, and which read made it. */
const packOf = (gameId: string, read: number) => ({ manifest: { gameId, title: 'Wiki' }, read });

let reads = 0;

beforeEach(() => {
  reads = 0;
  loadPack.mockReset();
  loadPack.mockImplementation((url: string) =>
    Promise.resolve(packOf(url.replace(/^packs\/|\/$/gu, ''), ++reads)),
  );
});

describe('the packs of other games kept in memory', () => {
  it('reads a pack once while its files stay as they are', async () => {
    const entry = { id: 'kept-once', url: 'packs/kept-once/', title: 'Wiki' };
    const first = await packAt(entry);
    const second = await packAt(entry);
    expect(second).toBe(first);
    expect(loadPack).toHaveBeenCalledTimes(1);
  });

  it('reads a pack again after it was saved, and never gives the copy from before', async () => {
    const entry = { id: 'built-again', url: 'packs/built-again/', title: 'Wiki' };
    const before = await packAt(entry);
    notePackSaved('built-again');
    const after = await packAt(entry);
    expect(after).not.toBe(before);
    expect(after).toMatchObject({ read: 2 });
    expect(await packAt(entry)).toBe(after);
    expect(loadPack).toHaveBeenCalledTimes(2);
  });

  it('keeps the copy of a pack when another pack was saved', async () => {
    const entry = { id: 'left-alone', url: 'packs/left-alone/', title: 'Wiki' };
    const before = await packAt(entry);
    notePackSaved('some-other-game');
    expect(await packAt(entry)).toBe(before);
  });

  it('does not keep a read that failed', async () => {
    const entry = { id: 'not-there', url: 'packs/not-there/', title: 'Wiki' };
    loadPack.mockImplementationOnce(() => Promise.reject(new Error('gone')));
    await expect(packAt(entry)).rejects.toThrow('gone');
    await expect(packAt(entry)).resolves.toMatchObject({ manifest: { gameId: 'not-there' } });
  });
});

describe('the pages of another game shown with the game shown', () => {
  const entry = { id: 'title-wiki', url: 'packs/title-wiki/', title: 'Wiki' };

  let day = 0;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Each test a day after the one before, so that none starts inside the other's wait.
    vi.setSystemTime(new Date(2030, 0, (day += 1)));
    useAtlas.setState({ catalog: [entry] });
    useGuideLinks.setState({
      gameId: 'shown-map',
      status: 'ready',
      links: { guidesFrom: ['title-wiki'], choices: {} },
      others: [{ gameId: 'title-wiki', title: 'Wiki', pack: await packAt(entry) }],
      othersMissing: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    useGuideLinks.setState({ gameId: null, status: 'idle', others: [] });
    useAtlas.setState({ catalog: [] });
  });

  const shownRead = () =>
    (useGuideLinks.getState().others[0]?.pack as unknown as { read: number }).read;

  it('are read again once the saving of that game settles', async () => {
    const before = shownRead();
    notePackSaved('title-wiki');
    await vi.advanceTimersByTimeAsync(OTHERS_SETTLE_MS - 1);
    expect(shownRead()).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(shownRead()).toBe(before + 1);
  });

  it('are read again at most once in a while as the game is saved over and over', async () => {
    notePackSaved('title-wiki');
    await vi.advanceTimersByTimeAsync(OTHERS_SETTLE_MS);
    const first = shownRead();
    // A session goes on: a page every few seconds.
    for (let page = 0; page < 5; page += 1) {
      notePackSaved('title-wiki');
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect(shownRead()).toBe(first);
    await vi.advanceTimersByTimeAsync(OTHERS_EVERY_MS);
    expect(shownRead()).toBe(first + 1);
  });

  it('stay as they are when a game that is not among them was saved', async () => {
    const before = shownRead();
    notePackSaved('some-other-game');
    await vi.advanceTimersByTimeAsync(OTHERS_EVERY_MS);
    expect(shownRead()).toBe(before);
  });
});
