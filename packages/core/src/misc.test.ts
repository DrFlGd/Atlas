import { ICON_NAMES } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import {
  nearestUnfound,
  overridesShowingOnly,
  passesFilter,
  visibleCategoryIds,
} from './filters/visibility';
import { allGlyphs, glyphColorOn, glyphFor } from './icons/glyphs';
import { resolvePackEntries } from './pack/packIndex';
import { probeTiles } from './pack/tileProbe';
import { makeTestPack } from './testing/packs';

describe('glyphs', () => {
  it('has a glyph for every icon name, with path data only', () => {
    const glyphs = allGlyphs();
    expect(glyphs.map((g) => g.name)).toEqual([...ICON_NAMES]);
    for (const { glyph } of glyphs) {
      expect(glyph.shape).toMatch(/^M[0-9MmLlHhVvCcSsAaZz .,-]+$/);
      if (glyph.holes) expect(glyph.holes).toMatch(/^M[0-9MmLlHhVvCcSsAaZz .,-]+$/);
    }
    expect(new Set(glyphs.map((g) => g.glyph.shape)).size).toBe(ICON_NAMES.length);
  });

  it('falls back to pin for unknown names', () => {
    expect(glyphFor('campfire')).toBe(glyphFor('pin'));
    expect(glyphFor('skull')).not.toBe(glyphFor('pin'));
  });

  it('picks a readable glyph colour for the badge', () => {
    expect(glyphColorOn('#ffffff')).toBe('#101318');
    expect(glyphColorOn('#e6b450')).toBe('#101318');
    expect(glyphColorOn('#1a237e')).toBe('#f6f7f9');
  });
});

describe('visibility', () => {
  const pack = makeTestPack();
  const categories = pack.data.categories;

  it('applies user overrides on top of pack defaults', () => {
    expect([...visibleCategoryIds(categories, {})].sort()).toEqual([
      'demo:cat:camp',
      'demo:cat:herb',
    ]);
    expect(
      [
        ...visibleCategoryIds(categories, { 'demo:cat:chest': true, 'demo:cat:camp': false }),
      ].sort(),
    ).toEqual(['demo:cat:chest', 'demo:cat:herb']);
    expect(overridesShowingOnly(categories, ['demo:cat:chest'])).toEqual({
      'demo:cat:herb': false,
      'demo:cat:camp': false,
      'demo:cat:chest': true,
    });
  });

  it('hides found locations only when asked', () => {
    const location = pack.locations.get('demo:loc:0001')!;
    const filter = {
      visibleCategories: new Set(['demo:cat:herb']),
      hideFound: false,
      isFound: () => true,
    };
    expect(passesFilter(location, filter)).toBe(true);
    expect(passesFilter(location, { ...filter, hideFound: true })).toBe(false);
    expect(passesFilter(location, { ...filter, visibleCategories: new Set() })).toBe(false);
  });

  it('shows only the places of one list, whatever kinds are shown, when asked', () => {
    const location = pack.locations.get('demo:loc:0001')!;
    const filter = { visibleCategories: new Set<string>(), hideFound: false, isFound: () => true };
    expect(passesFilter(location, { ...filter, only: new Set(['demo:loc:0001']) })).toBe(true);
    expect(passesFilter(location, { ...filter, only: new Set(['demo:loc:0002']) })).toBe(false);
    // "Hide found" still applies.
    const only = new Set(['demo:loc:0001']);
    expect(passesFilter(location, { ...filter, only, hideFound: true })).toBe(false);
    expect(passesFilter(location, { ...filter, only: null })).toBe(false);
  });

  it('finds the nearest visible, trackable, unfound location on a layer', () => {
    const all = new Set(categories.map((c) => c.id));
    const filter = {
      visibleCategories: all,
      hideFound: false,
      isFound: (id: string) => id === 'demo:loc:0003',
    };
    // 0004 (a camp at 300,400) is closer but not trackable; 0003 is found.
    expect(nearestUnfound(pack, 'demo:layer:surface', { x: 300, y: 350 }, filter)?.id).toBe(
      'demo:loc:0001',
    );
    expect(
      nearestUnfound(pack, 'demo:layer:surface', { x: 300, y: 350 }, filter, 'demo:loc:0001')?.id,
    ).toBe('demo:loc:0002');
    const none = { ...filter, visibleCategories: new Set<string>() };
    expect(nearestUnfound(pack, 'demo:layer:surface', { x: 0, y: 0 }, none)).toBeNull();
  });
});

describe('resolvePackEntries', () => {
  it('resolves URLs against the index and adds a trailing slash', () => {
    const entries = resolvePackEntries(
      {
        packs: [
          { id: 'demo', url: 'demo', title: 'Demo' },
          { id: 'b', url: 'https://cdn.test/b/', title: 'B' },
        ],
      },
      'https://example.test/app/packs/index.json',
    );
    expect(entries.map((e) => e.url)).toEqual([
      'https://example.test/app/packs/demo/',
      'https://cdn.test/b/',
    ]);
  });

  it('rejects malformed indexes and duplicate ids', () => {
    expect(() =>
      resolvePackEntries({ packs: [{ id: 'Bad Id', url: 'x', title: 't' }] }, 'https://e.test/'),
    ).toThrow(/Invalid pack index/);
    const twice = {
      packs: [
        { id: 'a', url: 'a/', title: 'A' },
        { id: 'a', url: 'b/', title: 'B' },
      ],
    };
    expect(() => resolvePackEntries(twice, 'https://e.test/')).toThrow(/listed twice/);
  });
});

describe('probeTiles', () => {
  const respond = (status: number, body: BodyInit | null = null) =>
    (() => Promise.resolve(new Response(body, { status }))) as typeof fetch;

  it('accepts a PMTiles archive with the right magic number', async () => {
    const header = new Uint8Array([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73, 3]);
    expect(
      await probeTiles({ type: 'pmtiles', url: 'https://t/a.pmtiles' }, 0, respond(206, header)),
    ).toBe(true);
    expect(
      await probeTiles({ type: 'pmtiles', url: 'https://t/a.pmtiles' }, 0, respond(200, '<html>')),
    ).toBe(false);
    expect(await probeTiles({ type: 'pmtiles', url: 'https://t/a.pmtiles' }, 0, respond(404))).toBe(
      false,
    );
  });

  it('requests the first tile of a tile folder', async () => {
    const requested: string[] = [];
    const fetchFn = ((url: string) => {
      requested.push(url);
      return Promise.resolve(new Response('x', { status: 200 }));
    }) as typeof fetch;
    expect(await probeTiles({ type: 'xyz', url: 'https://t/{z}/{x}/{y}.webp' }, 2, fetchFn)).toBe(
      true,
    );
    expect(requested).toEqual(['https://t/2/0/0.webp']);
    expect(
      await probeTiles({ type: 'xyz', url: 'https://t/{z}/{x}/{y}.webp' }, 0, respond(404)),
    ).toBe(false);
    const offline = (() => Promise.reject(new TypeError('offline'))) as typeof fetch;
    expect(await probeTiles({ type: 'xyz', url: 'https://t/{z}/{x}/{y}.webp' }, 0, offline)).toBe(
      false,
    );
  });
});
