import { packDataSchema, MANIFEST_FILE, PACK_COLLECTIONS, COLLECTION_NAMES } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { makeFixturePack } from '@atlas/schema/testing';
import { packFiles, packSource, pagesFiling, unrecognisedMessage } from './importing';

describe('import messages', () => {
  it('explains addresses that cannot be imported', () => {
    expect(unrecognisedMessage('ftp://example.com/map', ['Demo'])).toMatch(/starting with https/);
    expect(unrecognisedMessage('https://example.com/map', [])).toMatch(/has no importers/);
    expect(unrecognisedMessage('https://example.com/map', ['Demo', 'Other'])).toBe(
      'None of the importers in this app recognises that address. It can add maps from: Demo, Other.',
    );
  });
});

describe('packFiles', () => {
  it('writes every pack file as JSON that reads back as the same pack', () => {
    const pack = packDataSchema.parse({
      manifest: {
        schemaVersion: 1,
        gameId: 'tiny',
        title: 'Tiny',
        packVersion: '1.0.0',
        gamePatch: '1',
        attribution: [],
        idMigrations: {},
      },
      maps: [],
      layers: [],
      regions: [],
      categoryGroups: [],
      categories: [],
      locations: [],
      entities: [],
      checklists: [],
      checklistItems: [],
      guides: [],
      links: [],
      presets: [],
    });
    const files = packFiles(pack);
    expect(Object.keys(files).sort()).toEqual(
      [MANIFEST_FILE, ...COLLECTION_NAMES.map((name) => PACK_COLLECTIONS[name].file)].sort(),
    );
    const back = Object.fromEntries([
      ['manifest', JSON.parse(files[MANIFEST_FILE]!) as unknown],
      ...COLLECTION_NAMES.map((name) => [
        name,
        JSON.parse(files[PACK_COLLECTIONS[name].file]!) as unknown,
      ]),
    ]) as unknown;
    expect(packDataSchema.parse(back)).toEqual(pack);
  });
});

describe('pagesFiling', () => {
  const g = (local: string) => `wiki:guide:${local}`;
  const guide = (local: string, body = '') => ({
    id: g(local),
    title: local,
    body,
    locationIds: [],
  });
  const pack = (placeByLinks: boolean, filed = false) =>
    packDataSchema.parse({
      manifest: {
        schemaVersion: 1,
        gameId: 'wiki',
        title: 'Wiki',
        packVersion: '1.0.0',
        gamePatch: 'wiki',
        attribution: [],
        idMigrations: {},
        homePage: g('home'),
      },
      maps: [],
      layers: [],
      regions: [],
      categoryGroups: [],
      categories: [],
      locations: [],
      entities: [],
      checklists: [],
      checklistItems: [],
      guides: [
        guide('home', `- [Weapons](${g('weapons')})`),
        guide('weapons', ['a', 'b', 'c'].map((x) => `- [${x}](${g(x)})`).join('\n')),
        guide('a', `Found in [the vale](${g('vale')}).`),
        guide('b'),
        guide('c'),
        { ...guide('vale'), ...(filed ? { filedUnder: [g('rules')] } : {}) },
        guide('rules'),
      ],
      links: [],
      presets: [],
      sections: [
        { id: 'wiki:section:menu', title: 'Menu', items: [g('rules')] },
        {
          id: 'wiki:section:pages',
          title: 'Pages',
          items: ['weapons', 'a', 'b', 'c', 'vale'].map(g),
          ...(placeByLinks ? { placeByLinks: true } : {}),
        },
      ],
    });

  it('counts the pages in the site’s menu and outside it, each once', () => {
    // Only the rules are in the menu: nothing is put under the list page Weapons.
    expect(pagesFiling(pack(true))).toEqual({
      pages: 6,
      inMenu: 1,
      byHand: 0,
      outsideMenu: 5,
    });
    expect(pagesFiling(pack(false))).toBeNull();
  });

  it('never files a page under the page the site files it under', () => {
    // The site files the vale under the rules, a page of the menu: it stays outside the menu.
    expect(pagesFiling(pack(true, true))).toEqual(pagesFiling(pack(true)));
  });
});

describe('packSource', () => {
  const importer = { id: 'example-maps', title: 'Example importer' };
  const current = {
    key: 'east',
    url: 'https://maps.example.org/east',
    mapId: 'test-valley:map:east',
    importedAt: '2026-11-12T10:00:00Z',
  };
  const stored = [
    {
      key: 'west',
      url: 'https://maps.example.org/west',
      importedAt: '2026-11-11T10:00:00Z',
      mapId: null,
    },
  ];
  const before = (site?: string) => ({
    ...makeFixturePack().manifest,
    schemaVersion: 2 as const,
    source: { importer, pages: [], ...(site ? { site } : {}) },
  });

  it('records every page, and the site the importer names', () => {
    const source = packSource(importer, stored, current, { given: 'Example Maps' });
    expect(source).toEqual({
      importer,
      pages: [
        { url: 'https://maps.example.org/west', importedAt: '2026-11-11T10:00:00Z' },
        {
          url: 'https://maps.example.org/east',
          mapId: 'test-valley:map:east',
          importedAt: '2026-11-12T10:00:00Z',
        },
      ],
      site: 'Example Maps',
    });
    // The importer's name wins over the one recorded before.
    expect(
      packSource(importer, stored, current, { given: 'Maps Two', before: before('Example Maps') })
        .site,
    ).toBe('Maps Two');
  });

  it('keeps the site recorded before, and never takes the importer for it', () => {
    expect(packSource(importer, stored, current, { before: before('Example Maps') }).site).toBe(
      'Example Maps',
    );
    expect('site' in packSource(importer, stored, current, { before: before() })).toBe(false);
    expect('site' in packSource(importer, stored, current)).toBe(false);
  });
});
