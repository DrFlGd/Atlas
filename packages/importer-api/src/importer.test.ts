import { describe, expect, it } from 'vitest';
import demo from '../demo/demo-importer.js';
import {
  asImporter,
  checkOutcome,
  findImporter,
  isAllowedPageUrl,
  type ImportContext,
  type SavedSource,
} from './index';

const page = (
  map: string,
  places: { id: number; kind: string }[] = [{ id: 1, kind: 'beacon' }],
) => ({
  world: { slug: 'test-valley', name: 'Test Valley' },
  map: {
    slug: map,
    name: `Map ${map}`,
    width: 1024,
    height: 768,
    maxZoom: 2,
    tiles: `http://127.0.0.1:4432/tiles/${map}/{z}/{x}/{y}.png`,
  },
  places: places.map((p) => ({ ...p, name: `Place ${p.id}`, x: 10 * p.id, y: 20 })),
});

function context(saved: SavedSource[] = [], bundled: string[] = []): ImportContext {
  return {
    url: 'http://127.0.0.1:4432/demo-maps/test-valley/east',
    importedAt: '2026-11-10T12:00:00Z',
    app: { name: 'Atlas', version: '0.3.0' },
    savedSources: () => Promise.resolve(saved),
    existingPack: () => Promise.resolve(null),
    isBundled: (id) => bundled.includes(id),
  };
}

describe('page URLs', () => {
  it('accepts https and loopback http only', () => {
    expect(isAllowedPageUrl('https://maps.example.com/a/b')).toBe(true);
    expect(isAllowedPageUrl(' http://127.0.0.1:4432/x ')).toBe(true);
    expect(isAllowedPageUrl('http://localhost/x')).toBe(true);
    for (const bad of [
      'http://example.com/',
      'http://127.0.0.2/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://example.com/',
      'https://user:secret@example.com/',
      'not a url',
      '',
    ]) {
      expect(isAllowedPageUrl(bad), bad).toBe(false);
    }
  });

  it('finds the importer that recognises a URL', () => {
    const throwing = {
      matches: () => {
        throw new Error('boom');
      },
    };
    expect(findImporter([throwing, demo], 'http://127.0.0.1:4432/demo-maps/w/m')).toBe(demo);
    expect(findImporter([demo], 'http://127.0.0.1:4432/elsewhere')).toBeNull();
    expect(findImporter([demo], 'http://example.com/demo-maps/w/m')).toBeNull();
  });
});

describe('importer modules', () => {
  it('accepts the demo importer', () => {
    expect(asImporter(demo).id).toBe('demo-maps');
  });

  it('rejects modules that do not follow the contract', () => {
    expect(() => asImporter({ ...demo, id: 'Bad Id' })).toThrow(/not an Atlas importer/);
    expect(() => asImporter({ ...demo, apiVersion: 2 })).toThrow();
    expect(() => asImporter({ ...demo, convert: 'nope' })).toThrow();
    expect(() => asImporter({ ...demo, pageReader: 'x'.repeat(70_000) })).toThrow();
    expect(() => asImporter(null)).toThrow();
  });
});

describe('the demo importer', () => {
  it('reads only what it needs from the page', () => {
    // Evaluates the reader's source text, as the app does in the page.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const reader = new Function(`return (${demo.pageReader})();`) as () => unknown;
    const site = { ...page('east'), loaded: true, account: { token: 'secret' } };
    (globalThis as Record<string, unknown>).demoMaps = undefined;
    expect(reader()).toBeNull();
    (globalThis as Record<string, unknown>).demoMaps = site;
    const data = reader();
    expect(JSON.stringify(data)).not.toContain('secret');
    expect(data).toEqual(page('east'));
    delete (globalThis as Record<string, unknown>).demoMaps;
  });

  it('builds a valid pack and merges maps of one world', async () => {
    const first = checkOutcome(await demo.convert(page('east'), context()));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.packId).toBe('test-valley');
    expect(first.summary).toMatchObject({ maps: 1, locations: 1, refreshed: false });

    const saved: SavedSource[] = [
      { key: 'east', url: 'u', importedAt: '2026-11-10T12:00:00Z', data: page('east') },
    ];
    const second = checkOutcome(
      await demo.convert(
        page('west', [
          { id: 1, kind: 'camp' },
          { id: 2, kind: 'cave' },
        ]),
        context(saved),
      ),
    );
    expect(second.ok && second.pack.maps.map((m) => m.id)).toEqual([
      'test-valley:map:east',
      'test-valley:map:west',
    ]);
    expect(second.ok && second.summary).toMatchObject({ maps: 2, locations: 3, mapLocations: 2 });

    // The same map again refreshes it in place and keeps its ids.
    saved.push({ key: 'west', url: 'u', importedAt: 't', data: page('west') });
    const again = checkOutcome(
      await demo.convert(
        page('east', [
          { id: 1, kind: 'beacon' },
          { id: 9, kind: 'beacon' },
        ]),
        context(saved),
      ),
    );
    expect(again.ok && again.pack.maps.map((m) => m.id)).toEqual([
      'test-valley:map:east',
      'test-valley:map:west',
    ]);
    expect(again.ok && again.summary.refreshed).toBe(true);
    expect(again.ok && again.pack.locations.map((l) => l.id)).toContain('test-valley:loc:east-1');
  });

  it('explains data in the wrong shape and bundled games', async () => {
    const wrong = await demo.convert({ world: 'x' }, context());
    expect(wrong).toEqual({
      ok: false,
      message: expect.stringMatching(/expected shape/) as string,
    });
    const bundled = await demo.convert(page('east'), context([], ['test-valley']));
    expect(bundled.ok).toBe(false);
  });
});

describe('outcome checks', () => {
  it('refuses packs that fail the schema or do not fit together', async () => {
    const good = await demo.convert(page('east'), context());
    if (!good.ok) throw new Error('expected a pack');
    expect(checkOutcome({ ...good, pack: { ...good.pack, maps: 'none' } })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/expected shape/) as string,
    });
    const broken = structuredClone(good.pack);
    broken.locations[0]!.categoryId = 'test-valley:cat:missing';
    expect(checkOutcome({ ...good, pack: broken })).toMatchObject({ ok: false });
    expect(checkOutcome({ ...good, packId: 'other' })).toMatchObject({ ok: false });
    expect(checkOutcome({ ...good, mapId: 'test-valley:map:nowhere' })).toMatchObject({
      ok: false,
    });
    expect(checkOutcome({ ...good, sourceKey: '../x' })).toMatchObject({ ok: false });
    expect(checkOutcome('text')).toMatchObject({ ok: false });
    expect(checkOutcome({ ok: false, message: 'Plain reason.' })).toEqual({
      ok: false,
      message: 'Plain reason.',
    });
  });

  it('refuses remote tile sources that are not https or loopback', async () => {
    const outcome = await demo.convert(
      {
        ...page('east'),
        map: { ...page('east').map, tiles: 'http://example.com/{z}/{x}/{y}.png' },
      },
      context(),
    );
    expect(checkOutcome(outcome).ok).toBe(false);
  });
});
