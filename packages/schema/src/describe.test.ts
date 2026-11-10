import { describe, expect, it } from 'vitest';
import { describePack, manifestSchema, packDataSchema, recordedImages } from './index';
import { makeFixturePack } from './testing/fixture';

const writtenBy = { name: 'Atlas test', version: '0.0.1' };

describe('pack descriptions (manifest version 2)', () => {
  it('describes a pack from its data, deterministically', () => {
    const pack = makeFixturePack();
    const manifest = describePack(pack, { updated: '2026-11-10T12:00:00Z', writtenBy });
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.created).toBe('2026-11-10T12:00:00Z');
    expect(manifest.contents?.counts).toEqual({
      maps: pack.maps.length,
      layers: pack.layers.length,
      locations: pack.locations.length,
      categories: pack.categories.length,
      regions: pack.regions.length,
      guides: pack.guides.length,
    });
    const map = manifest.contents!.maps[0]!;
    expect(map).toMatchObject({ id: pack.maps[0]!.id, width: 1000, height: 600 });
    expect(map.layers[0]).toMatchObject({ tiles: 'xyz', downloadable: false, minZoom: 0 });
    expect(manifestSchema.parse(manifest)).toEqual(manifest);
    expect(packDataSchema.safeParse({ ...pack, manifest }).success).toBe(true);
    expect(JSON.stringify(describePack(pack, { updated: '2026-11-10T12:00:00Z', writtenBy }))).toBe(
      JSON.stringify(manifest),
    );
  });

  it('keeps the creation time and recorded images of an earlier description', () => {
    const pack = makeFixturePack();
    const images = {
      levels: [0, 1],
      complete: false,
      files: 5,
      bytes: 1234,
      updatedAt: '2026-11-11T00:00:00Z',
    };
    const first = describePack(pack, {
      updated: '2026-11-10T00:00:00Z',
      writtenBy,
      images: new Map([[pack.layers[0]!.id, images]]),
      source: {
        importer: { id: 'example', title: 'Example' },
        pages: [{ url: 'https://example.com/map', importedAt: '2026-11-10T00:00:00Z' }],
      },
    });
    const again = describePack(
      { ...pack, manifest: first },
      { updated: '2026-12-01T00:00:00Z', writtenBy },
    );
    expect(again.created).toBe('2026-11-10T00:00:00Z');
    expect(again.updated).toBe('2026-12-01T00:00:00Z');
    expect(recordedImages(again).get(pack.layers[0]!.id)).toEqual(images);
    expect(again.source).toBeUndefined();
  });

  it('still reads version 1 manifests, without descriptive fields', () => {
    const { manifest } = makeFixturePack();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifestSchema.safeParse({ ...manifest, updated: '2026-11-10T00:00:00Z' }).success).toBe(
      false,
    );
    expect(recordedImages(manifest).size).toBe(0);
  });

  it('drops a descriptive field that does not have the expected shape', () => {
    const pack = makeFixturePack();
    const manifest = describePack(pack, { updated: '2026-11-10T00:00:00Z', writtenBy });
    const parsed = manifestSchema.parse({
      ...manifest,
      contents: { counts: 'many' },
      updated: 'yesterday',
    });
    expect(parsed.schemaVersion === 2 && parsed.contents).toBeUndefined();
    expect(parsed.schemaVersion === 2 && parsed.updated).toBeUndefined();
    expect(parsed.gameId).toBe('demo');
    expect(manifestSchema.safeParse({ ...manifest, surprise: 1 }).success).toBe(false);
  });
});
