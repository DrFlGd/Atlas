import type * as Core from '@atlas/core';
import type { PackData } from '@atlas/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  loadPack: vi.fn<(url: string) => Promise<{ data: unknown }>>(),
}));
vi.mock('@atlas/core', async (original) => ({
  ...(await original<typeof Core>()),
  loadPack: core.loadPack,
}));

const {
  PACK_NOT_OPENED,
  PackNotOpenedError,
  importContext,
  importerStoppedMessage,
  openListedPack,
} = await import('./importing');
const { useAtlas } = await import('./store');
type Listing = NonNullable<ReturnType<typeof useAtlas.getState>['library']>;

const pack = { manifest: { title: 'Demo' } } as unknown as PackData;
const listing = (ids: string[]) =>
  ({
    mapsFolder: { path: 'maps', isDefault: true, exists: true },
    packs: ids.map((id) => ({ id, url: `atlas-pack://${id}/` })),
    hidden: [],
    locations: [],
    busy: [],
  }) as unknown as Listing;

describe('the game a read adds to', () => {
  beforeEach(() => {
    core.loadPack.mockReset();
    useAtlas.setState({ library: listing(['demo']), bundledCatalog: [] });
  });

  it('is opened when it is listed', async () => {
    core.loadPack.mockResolvedValue({ data: pack });
    const context = importContext('https://wiki.example/Start', '', 'demo-wiki');
    await expect(context.existingPack('demo')).resolves.toBe(pack);
    expect(core.loadPack).toHaveBeenCalledWith('atlas-pack://demo/');
  });

  it('is new when it is not listed yet, and nothing is loaded', async () => {
    const context = importContext('https://wiki.example/Start', '', 'demo-wiki');
    await expect(context.existingPack('another')).resolves.toBeNull();
    expect(core.loadPack).not.toHaveBeenCalled();
  });

  it('stops the read when it is listed but cannot be opened', async () => {
    core.loadPack.mockRejectedValue(new Error('manifest.json is not valid JSON'));
    const context = importContext('https://wiki.example/Start', '', 'demo-wiki');
    const opened = context.existingPack('demo');
    await expect(opened).rejects.toBeInstanceOf(PackNotOpenedError);
    await expect(opened).rejects.toThrow(PACK_NOT_OPENED);
  });
});

describe('openListedPack', () => {
  it('starts a game new only when none is listed', async () => {
    const load = vi.fn(() => Promise.resolve(pack));
    await expect(openListedPack(undefined, load)).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
    await expect(openListedPack('atlas-pack://demo/', load)).resolves.toBe(pack);
  });

  it('fails with a plain message, never null, when a listed game cannot be loaded', async () => {
    const load = () => Promise.reject(new Error('file is missing'));
    await expect(openListedPack('atlas-pack://demo/', load)).rejects.toThrow(PACK_NOT_OPENED);
  });

  it('says so in place of the importer error', () => {
    expect(importerStoppedMessage(new PackNotOpenedError())).toBe(PACK_NOT_OPENED);
    expect(PACK_NOT_OPENED).toBe(
      'This game could not be opened, so nothing was read. Press Look again in Settings, then try again.',
    );
    expect(importerStoppedMessage(new Error('broken'))).toBe(
      'The importer stopped with an error, so nothing was added: broken',
    );
  });
});
