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

  it('keeps the sections other names of pages lead to', () => {
    const pack = makeFixturePack();
    pack.manifest.idMigrations = { 'demo:guide:herb-lore': 'demo:guide:herbs' };
    pack.manifest.idSections = { 'demo:guide:herb-lore': 'where-to-find' };
    const manifest = describePack(pack, { updated: '2026-11-10T12:00:00Z', writtenBy });
    expect(manifest.idSections).toEqual({ 'demo:guide:herb-lore': 'where-to-find' });
    expect(packDataSchema.safeParse({ ...pack, manifest }).success).toBe(true);
    // None is left out, as before.
    expect(
      'idSections' in
        describePack(makeFixturePack(), { updated: '2026-11-10T12:00:00Z', writtenBy }),
    ).toBe(false);
  });

  it('keeps the home page', () => {
    const pack = makeFixturePack();
    pack.manifest.homePage = 'demo:guide:herbs';
    const manifest = describePack(pack, { updated: '2026-11-10T12:00:00Z', writtenBy });
    expect(manifest.homePage).toBe('demo:guide:herbs');
    expect(packDataSchema.safeParse({ ...pack, manifest }).success).toBe(true);
    expect(
      'homePage' in describePack(makeFixturePack(), { updated: '2026-11-10T12:00:00Z', writtenBy }),
    ).toBe(false);
  });

  it('keeps the flag that the pages are read in order', () => {
    const pack = makeFixturePack();
    pack.manifest.pagesInOrder = true;
    const manifest = describePack(pack, { updated: '2026-11-10T12:00:00Z', writtenBy });
    expect(manifest.pagesInOrder).toBe(true);
    expect(packDataSchema.safeParse({ ...pack, manifest }).success).toBe(true);
    expect(
      'pagesInOrder' in
        describePack(makeFixturePack(), { updated: '2026-11-10T12:00:00Z', writtenBy }),
    ).toBe(false);
  });

  it('keeps the width of the pages', () => {
    const pack = makeFixturePack();
    pack.manifest.pageWidth = 'wide';
    const manifest = describePack(pack, { updated: '2026-11-10T12:00:00Z', writtenBy });
    expect(manifest.pageWidth).toBe('wide');
    expect(packDataSchema.safeParse({ ...pack, manifest }).success).toBe(true);
    expect(
      'pageWidth' in
        describePack(makeFixturePack(), { updated: '2026-11-10T12:00:00Z', writtenBy }),
    ).toBe(false);
  });

  it('keeps the system the game is for, and drops one that cannot be read', () => {
    const pack = makeFixturePack();
    const first = describePack(pack, { updated: '2026-11-10T12:00:00Z', writtenBy });
    expect('system' in first).toBe(false);
    const named = { ...pack, manifest: { ...first, system: 'Saltbox 64' } };
    const manifest = describePack(named, { updated: '2026-11-11T12:00:00Z', writtenBy });
    expect(manifest.system).toBe('Saltbox 64');
    expect(packDataSchema.safeParse({ ...pack, manifest }).success).toBe(true);
    const odd = manifestSchema.parse({ ...manifest, system: 64 });
    expect(odd.schemaVersion === 2 && odd.system).toBeUndefined();
  });

  it('keeps the name of the site the pages were read from, and drops one that cannot be read', () => {
    const pack = makeFixturePack();
    const importer = { id: 'example', title: 'Example importer' };
    const page = (url: string) => ({ url, importedAt: '2026-11-10T00:00:00Z' });
    const first = describePack(pack, {
      updated: '2026-11-10T12:00:00Z',
      writtenBy,
      source: { importer, pages: [page('https://maps.example.org/a')], site: 'Example Maps' },
    });
    expect(first.source).toEqual({
      importer,
      pages: [page('https://maps.example.org/a')],
      site: 'Example Maps',
    });
    expect(Object.keys(first.source!)).toEqual(['importer', 'pages', 'site']);
    expect(packDataSchema.safeParse({ ...pack, manifest: first }).success).toBe(true);
    // A later page with no site's name keeps the one recorded.
    const pages = [page('https://maps.example.org/a'), page('https://maps.example.org/b')];
    const kept = describePack(
      { ...pack, manifest: first },
      { updated: '2026-11-11T12:00:00Z', writtenBy, source: { importer, pages } },
    );
    expect(kept.source).toEqual({ importer, pages, site: 'Example Maps' });
    // A new name replaces it.
    const renamed = describePack(
      { ...pack, manifest: kept },
      { updated: '2026-11-12T12:00:00Z', writtenBy, source: { importer, pages, site: 'Maps Two' } },
    );
    expect(renamed.source?.site).toBe('Maps Two');
    // None recorded, none given: none made up.
    const none = describePack(pack, {
      updated: '2026-11-10T12:00:00Z',
      writtenBy,
      source: { importer, pages },
    });
    expect(none.source && 'site' in none.source).toBe(false);
    // A name that is not one is dropped when read, and the rest is kept.
    for (const odd of [64, '   ', 'x'.repeat(201)]) {
      const read = manifestSchema.parse({ ...first, source: { ...first.source, site: odd } });
      expect(read.schemaVersion === 2 && read.source).toEqual({
        importer,
        pages: [page('https://maps.example.org/a')],
      });
    }
    // Trimmed when read.
    const spaced = manifestSchema.parse({
      ...first,
      source: { ...first.source, site: ' Example ' },
    });
    expect(spaced.schemaVersion === 2 && spaced.source?.site).toBe('Example');
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
