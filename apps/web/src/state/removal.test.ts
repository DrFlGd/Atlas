import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListedPack, Listing } from '../desktop';

/**
 * The delete commands against a stand-in for the desktop shell: the page's
 * `__TAURI_INTERNALS__.invoke` is faked before the modules are loaded.
 */

const listed = (id: string, title: string): ListedPack => ({
  id,
  title,
  url: `atlas-pack://localhost/${id}/`,
  origin: 'maps-folder',
  path: `/maps/${id}`,
  packVersion: '1.0.0',
  bundled: false,
  imported: null,
});

const listing = (packs: ListedPack[]): Listing => ({
  mapsFolder: { path: '/maps', isDefault: true, exists: true },
  packs,
  hidden: [],
  locations: [],
  busy: [],
});

type Reply = (args: Record<string, unknown> | undefined) => unknown;

/** A reply that makes the command fail with a message, as the shell does. */
class Refusal {
  constructor(readonly message: string) {}
}

let replies: Record<string, Reply> = {};
let calls: [string, Record<string, unknown> | undefined][] = [];

async function load() {
  vi.resetModules();
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      const reply = replies[command];
      if (!reply) return Promise.reject(new Error(`unexpected ${command}`));
      const value = reply(args);
      // The shell rejects with a plain string.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return value instanceof Refusal ? Promise.reject(value.message) : Promise.resolve(value);
    },
  };
  const removal = await import('./removal');
  const { useAtlas } = await import('./store');
  useAtlas.setState({ library: listing([listed('my-game', 'My Game'), listed('other', 'Other')]) });
  return { removal, useAtlas };
}

beforeEach(() => {
  replies = {};
  calls = [];
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('deleting a pack', () => {
  it('takes it out of the list and says when files are left for the next start', async () => {
    replies.library_delete_pack = () => ({ complete: false });
    replies.library_list = () => listing([listed('other', 'Other')]);
    const { removal, useAtlas } = await load();
    const outcome = await removal.deletePack('my-game', false);
    expect(outcome).toEqual({ ok: true });
    expect(calls.map(([command]) => command)).toEqual(['library_delete_pack', 'library_list']);
    expect(calls[0]?.[1]).toEqual({ id: 'my-game' });
    expect(useAtlas.getState().library?.packs.map((p) => p.id)).toEqual(['other']);
    expect(useAtlas.getState().catalog.some((p) => p.id === 'my-game')).toBe(false);
    expect(useAtlas.getState().notice?.text).toMatch(
      /^Deleted My Game\. .*the next time it starts\.$/,
    );
  });

  it('takes it out of the list even when the folders cannot be listed again', async () => {
    replies.library_delete_pack = () => ({ complete: true });
    replies.library_list = () => new Refusal('The maps folder cannot be read.');
    const { removal, useAtlas } = await load();
    expect(await removal.deletePack('my-game', false)).toEqual({ ok: true });
    expect(useAtlas.getState().library?.packs.map((p) => p.id)).toEqual(['other']);
    expect(useAtlas.getState().notice?.text).toBe(
      'Deleted My Game. Your progress is kept in case you add it again.',
    );
  });

  it('keeps it listed and returns the plain reason when the shell refuses', async () => {
    const reason =
      'Another Atlas window or app is working on this map’s files right now. Try again when it has finished.';
    replies.library_delete_pack = () => new Refusal(reason);
    const { removal, useAtlas } = await load();
    expect(await removal.deletePack('my-game', false)).toEqual({ ok: false, error: reason });
    expect(useAtlas.getState().library?.packs.map((p) => p.id)).toEqual(['my-game', 'other']);
  });

  it('turns a raw system error into plain words', async () => {
    replies.library_delete_pack = () =>
      new Refusal('Cannot lock the pack folder: Access is denied. (os error 5)');
    const { removal } = await load();
    const outcome = await removal.deletePack('my-game', false);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toMatch(/^Atlas could not delete My Game\./);
  });
});

describe('deleting downloaded images', () => {
  it('reports what was deleted and keeps the pack', async () => {
    replies.library_delete_images = () => ({ files: 12, bytes: 840_000, left: 0 });
    const { removal, useAtlas } = await load();
    expect(await removal.deleteImages('my-game')).toEqual({ ok: true });
    expect(calls).toEqual([['library_delete_images', { id: 'my-game' }]]);
    expect(useAtlas.getState().notice?.text).toBe(
      'Deleted 12 map images (about 840 KB) of My Game.',
    );
    expect(useAtlas.getState().library?.packs.map((p) => p.id)).toEqual(['my-game', 'other']);
  });

  it('asks how many images there are, and copes when it cannot', async () => {
    replies.library_images_info = () => ({ files: 3, bytes: 300, downloading: true });
    const { removal } = await load();
    expect(await removal.loadImagesInfo('my-game')).toEqual({
      files: 3,
      bytes: 300,
      downloading: true,
    });
    replies.library_images_info = () => new Refusal('That map is not in the list any more.');
    expect(await removal.loadImagesInfo('my-game')).toBeNull();
  });
});
