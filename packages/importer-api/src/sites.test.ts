import { describe, expect, it } from 'vitest';
import {
  CONFIRMABLE_LICENCES,
  MAX_PICTURE_FILES,
  MAX_PICTURE_FILE_BYTES,
  asImporter,
  checkOutcome,
  findGameImporter,
  findImporter,
  findReader,
  NO_LICENCE_RECORDED,
  forPersonalUse,
  isConfirmedLicence,
  isTermsAddress,
  pictureFilesOf,
  readingWayOf,
  siteInfoOf,
  siteLicenceOf,
  type AtlasImporter,
} from './index';

const base = {
  apiVersion: 1 as const,
  title: 'Test',
  description: 'A test importer.',
  version: '1.0.0',
  convert: () => ({ ok: false as const, message: 'no' }),
};

/** A map importer that knows one made-up site and its game pages. */
const maps: AtlasImporter = {
  ...base,
  id: 'maps',
  matches: (url) => url.startsWith('https://maps.example.com/game/'),
  pageReader: '() => null',
  games: {
    matches: (url) => url === 'https://maps.example.com/',
    pageReader: '() => null',
    convert: () => ({ ok: false, message: 'no' }),
  },
};

/** A wiki importer that knows one wiki, and reads any other `/wiki/` page as a general reader. */
const wikis: AtlasImporter = {
  ...base,
  id: 'wikis',
  matches: (url) => /^https:\/\/[^/]+\/wiki\/.+/.test(url),
  general: (url) => !url.startsWith('https://wiki.example.org/'),
  fetch: { addresses: (url) => [url] },
  pageReader: '() => null',
  games: {
    matches: (url) => /^https:\/\/[^/]+\/$/.test(url),
    fetch: { addresses: (url) => [url] },
    convert: () => ({ ok: false, message: 'no' }),
  },
  siteInfo(url) {
    const host = new URL(url).hostname;
    if (host === 'wiki.example.org') return { key: host, ways: ['fetch'] };
    return {
      key: host,
      ways: ['fetch', 'window'],
      notice: '  This app does not know this site.  ',
    };
  },
};

describe('general readers', () => {
  it('give an address to an importer that knows it first, whatever the order', () => {
    for (const order of [
      [wikis, maps],
      [maps, wikis],
    ]) {
      expect(findImporter(order, 'https://maps.example.com/game/one')).toBe(maps);
      expect(findGameImporter(order, 'https://maps.example.com/')).toBe(maps);
      expect(findReader(order, 'https://maps.example.com/')).toEqual({
        importer: maps,
        kind: 'game',
      });
      // Known to the wiki importer: no general reading.
      expect(findReader(order, 'https://wiki.example.org/wiki/Bells')).toEqual({
        importer: wikis,
        kind: 'page',
      });
      // Only the general reader recognises it.
      expect(findImporter(order, 'https://other.example.net/wiki/Bells')).toBe(wikis);
      expect(findReader(order, 'https://other.example.net/')).toEqual({
        importer: wikis,
        kind: 'game',
      });
    }
  });

  it('never let a general reader take an address another importer knows as something else', () => {
    // The map importer knows this address as a page; the wiki importer would read it only as a general reader.
    const greedy: AtlasImporter = {
      ...wikis,
      id: 'greedy',
      matches: () => true,
      general: () => true,
    };
    expect(findReader([greedy, maps], 'https://maps.example.com/')).toEqual({
      importer: maps,
      kind: 'game',
    });
    expect(findImporter([greedy, maps], 'https://maps.example.com/game/one')).toBe(maps);
    // An importer that throws in `general` counts as knowing the address.
    const throwing: AtlasImporter = {
      ...wikis,
      id: 'throwing',
      general: () => {
        throw new Error('no');
      },
    };
    expect(findImporter([greedy, throwing], 'https://other.example.net/wiki/A')).toBe(throwing);
    expect(findReader([maps], 'not a url')).toBeNull();
    expect(findReader([maps], 'https://nothing.example.com/x')).toBeNull();
  });

  it('pass the app’s check of an importer', () => {
    expect(typeof asImporter(wikis).general).toBe('function');
    expect(typeof asImporter(wikis).siteInfo).toBe('function');
    expect(() => asImporter({ ...wikis, general: 'yes' })).toThrow(/general/);
  });
});

describe('what an importer says about a site', () => {
  it('is checked: a usable key, ways it can read in, each once, and a trimmed notice', () => {
    expect(siteInfoOf(wikis, 'https://other.example.net/wiki/A')).toEqual({
      key: 'other.example.net',
      ways: ['fetch', 'window'],
      notice: 'This app does not know this site.',
    });
    expect(siteInfoOf(wikis, 'https://wiki.example.org/wiki/A')).toEqual({
      key: 'wiki.example.org',
      ways: ['fetch'],
    });
    const odd: AtlasImporter = {
      ...wikis,
      pageReader: undefined,
      siteInfo: () => ({ key: 'a.example', ways: ['window', 'fetch', 'fetch', 'post' as 'fetch'] }),
    };
    // No page reader: it cannot read in a window.
    expect(siteInfoOf(odd, 'https://a.example/wiki/A').ways).toEqual(['fetch']);
    // Browsing needs the importer's browse reader.
    const browsing: AtlasImporter = {
      ...wikis,
      siteInfo: () => ({ key: 'a.example', ways: ['browse', 'fetch'] }),
    };
    expect(siteInfoOf(browsing, 'https://a.example/wiki/A').ways).toEqual(['fetch']);
    expect(
      siteInfoOf({ ...browsing, browseReader: '() => null' }, 'https://a.example/wiki/A').ways,
    ).toEqual(['browse', 'fetch']);
    expect(() => asImporter({ ...wikis, browseReader: '' })).toThrow(/browseReader/);
  });

  it('may say how the layout of its pages is kept, and their width, as its rules file says', () => {
    const info = (layoutRead: unknown, pageWidth: unknown) =>
      siteInfoOf(
        {
          ...wikis,
          siteInfo: () => ({ key: 'a.example', ways: ['fetch'], layoutRead, pageWidth }) as never,
        },
        'https://a.example/wiki/A',
      );
    expect(info('off', 'wide')).toEqual({
      key: 'a.example',
      ways: ['fetch'],
      layoutRead: 'off',
      pageWidth: 'wide',
    });
    expect(info('stated', 'full')).toMatchObject({ layoutRead: 'stated', pageWidth: 'full' });
    expect(info('sometimes', 1000)).toEqual({ key: 'a.example', ways: ['fetch'] });
  });

  it('may name the hosts its pages load their files from: host names only, each once', () => {
    const hosts = (fileHosts: unknown) =>
      siteInfoOf(
        { ...wikis, siteInfo: () => ({ key: 'a.example', ways: ['fetch'], fileHosts }) as never },
        'https://a.example/wiki/A',
      ).fileHosts;
    expect(hosts(['files.a.example', 'cdn.example.net', 'files.a.example'])).toEqual([
      'files.a.example',
      'cdn.example.net',
    ]);
    expect(
      hosts(['Files.A.Example', 'localhost', 'https://x.example', 'a b.example', '', 7]),
    ).toBeUndefined();
    expect(hosts('files.a.example')).toBeUndefined();
    expect(hosts(Array.from({ length: 30 }, (_, n) => `f${n}.example`))).toHaveLength(20);
    expect(siteInfoOf(wikis, 'https://wiki.example.org/wiki/A').fileHosts).toBeUndefined();
  });

  it('falls back to the host and the one way the importer reads in, as before', () => {
    expect(siteInfoOf(maps, 'https://www.maps.example.com/game/one')).toEqual({
      key: 'maps.example.com',
      ways: ['window'],
    });
    const windowed: AtlasImporter = {
      ...wikis,
      siteInfo: undefined,
      fetch: { addresses: (url) => [url], inWindow: () => true },
    };
    expect(siteInfoOf(windowed, 'https://a.example/wiki/A').ways).toEqual(['window']);
    for (const given of [
      null,
      { key: 'Upper.Case', ways: ['fetch'] },
      { key: 'a'.repeat(201), ways: ['fetch'] },
      { key: 'a.example', ways: [] },
      { key: 'a.example', ways: 'fetch' },
    ]) {
      const info = siteInfoOf(
        { ...wikis, siteInfo: () => given as never },
        'https://a.example/wiki/A',
      );
      expect(info, JSON.stringify(given)).toEqual({ key: 'a.example', ways: ['fetch'] });
    }
    const throwing = {
      ...wikis,
      siteInfo: () => {
        throw new Error('no');
      },
    };
    expect(siteInfoOf(throwing, 'https://a.example/wiki/A').key).toBe('a.example');
  });

  it('keeps the way the person chose only while the importer offers it', () => {
    const info = siteInfoOf(wikis, 'https://other.example.net/wiki/A');
    expect(readingWayOf(info)).toBe('fetch');
    expect(readingWayOf(info, 'window')).toBe('window');
    expect(readingWayOf(siteInfoOf(wikis, 'https://wiki.example.org/wiki/A'), 'window')).toBe(
      'fetch',
    );
    expect(readingWayOf(info, 'nonsense')).toBe('fetch');
  });
});

describe('licences the person confirms', () => {
  it('are one of the Creative Commons licences offered, with a time', () => {
    expect(CONFIRMABLE_LICENCES.map((l) => l.name)).toContain('CC BY-SA 4.0');
    for (const licence of CONFIRMABLE_LICENCES) {
      expect(licence.url).toMatch(/^https:\/\/creativecommons\.org\/(licenses|publicdomain)\//);
      expect(isConfirmedLicence({ ...licence, confirmedAt: '2026-11-13T09:00:00.000Z' })).toBe(
        true,
      );
    }
    const one = CONFIRMABLE_LICENCES[0]!;
    for (const bad of [
      null,
      { ...one },
      { ...one, confirmedAt: 'yesterday' },
      { name: 'All rights reserved', url: one.url, confirmedAt: '2026-11-13' },
      { name: one.name, url: 'https://example.com/licence', confirmedAt: '2026-11-13' },
    ]) {
      expect(isConfirmedLicence(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('are asked for by a failure the app passes on', () => {
    expect(checkOutcome({ ok: false, message: 'No licence stated.', askLicence: true })).toEqual({
      ok: false,
      message: 'No licence stated.',
      askLicence: true,
    });
    expect(checkOutcome({ ok: false, message: 'x', askLicence: 'yes' }).ok).toBe(false);
    expect(
      (checkOutcome({ ok: false, message: 'x', askLicence: 'yes' }) as { message: string }).message,
    ).toMatch(/unexpected/);
  });
});

describe('what the person answers for a site that states no licence', () => {
  const at = '2026-11-16T09:00:00.000Z';
  const known = { ...CONFIRMABLE_LICENCES[0]!, confirmedAt: at };

  it('keeps a licence confirmed by 0.12.0 or 0.13.0, without a type, as it was', () => {
    expect(siteLicenceOf(known)).toEqual(known);
    expect(siteLicenceOf({ ...known, basis: 'confirmed' })).toEqual(known);
    expect(forPersonalUse(siteLicenceOf(known)!)).toBe(false);
    // A known licence is only one of those offered.
    expect(siteLicenceOf({ ...known, name: 'All rights reserved' })).toBeNull();
  });

  it('keeps what was filled in: the words, and the optional parts given, trimmed', () => {
    const filled = {
      basis: 'permission',
      name: '  Permission from the site’s owner for personal use ',
      url: 'https://wiki.example.org/wiki/Terms',
      givenBy: 'The owner',
      givenOn: '2026-11-16',
      note: 'Asked by mail.',
      confirmedAt: at,
      extra: 'dropped',
    };
    const kept = siteLicenceOf(filled);
    expect(kept).toEqual({
      basis: 'permission',
      name: 'Permission from the site’s owner for personal use',
      url: 'https://wiki.example.org/wiki/Terms',
      givenBy: 'The owner',
      givenOn: '2026-11-16',
      note: 'Asked by mail.',
      confirmedAt: at,
    });
    expect(forPersonalUse(kept!)).toBe(true);
    expect(
      siteLicenceOf({ basis: 'permission', name: 'Mine', givenBy: ' ', confirmedAt: at }),
    ).toEqual({ basis: 'permission', name: 'Mine', confirmedAt: at });
    for (const bad of [
      { ...filled, name: '' },
      { ...filled, name: '   ' },
      { ...filled, name: 'x'.repeat(201) },
      { ...filled, url: 'http://wiki.example.org/wiki/Terms' },
      { ...filled, url: 'javascript:alert(1)' },
      { ...filled, url: 'https://user@wiki.example.org/' },
      { ...filled, givenOn: '2026-02-30' },
      { ...filled, givenOn: '16 November' },
      { ...filled, givenBy: 'x'.repeat(201) },
      { ...filled, note: 'x'.repeat(1001) },
      { ...filled, confirmedAt: 'yesterday' },
    ]) {
      expect(siteLicenceOf(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('keeps no licence with its fixed words, whatever else it holds', () => {
    const none = siteLicenceOf({
      basis: 'none',
      name: 'Anything',
      url: 'https://x.example/',
      confirmedAt: at,
    });
    expect(none).toEqual({ basis: 'none', name: NO_LICENCE_RECORDED, confirmedAt: at });
    expect(forPersonalUse(none!)).toBe(true);
    expect(siteLicenceOf({ basis: 'none' })).toBeNull();
    expect(siteLicenceOf({ basis: 'shared', name: 'x', confirmedAt: at })).toBeNull();
    expect(siteLicenceOf(null)).toBeNull();
  });

  it('takes terms only at an https address', () => {
    expect(isTermsAddress('https://wiki.example.org/wiki/Terms')).toBe(true);
    expect(isTermsAddress('http://wiki.example.org/')).toBe(false);
    expect(isTermsAddress('https://wiki.example.org/a b')).toBe(false);
    expect(isTermsAddress(`https://wiki.example.org/${'a'.repeat(2048)}`)).toBe(false);
  });
});

describe('pictures a page showed, as the person browsed', () => {
  const pack = {
    pictures: [
      { id: 'w:picture:a', file: 'pictures/a.png', shareable: true },
      { id: 'w:picture:b', file: 'pictures/b.jpg', shareable: true },
      { id: 'w:picture:c', file: 'pictures/c.gif', shareable: true },
    ],
  } as unknown as Parameters<typeof pictureFilesOf>[1];
  const png = btoa('\x89PNG\r\n\x1a\nmade up');

  it('are the files of the pack’s pictures, in base64, each once, within the limits', () => {
    expect(
      pictureFilesOf(
        [
          { file: 'pictures/a.png', data: png },
          { file: 'pictures/a.png', data: png },
          { file: 'pictures/b.jpg', data: 'not base64!' },
          { file: 'pictures/c.gif', data: png },
          { file: 'pictures/other.png', data: png },
          { file: '../a.png', data: png },
          { file: 'pictures/b.jpg', data: btoa('x'.repeat(MAX_PICTURE_FILE_BYTES + 1)) },
          'pictures/b.jpg',
        ],
        pack,
      ),
    ).toEqual([{ file: 'pictures/a.png', data: png }]);
    expect(pictureFilesOf('pictures/a.png', pack)).toEqual([]);
    const many = Array.from({ length: MAX_PICTURE_FILES + 5 }, (_, i) => ({
      id: `w:picture:p${i}`,
      file: `pictures/p${i}.png`,
      shareable: true,
    }));
    expect(
      pictureFilesOf(
        many.map((p) => ({ file: p.file, data: png })),
        { pictures: many } as unknown as Parameters<typeof pictureFilesOf>[1],
      ),
    ).toHaveLength(MAX_PICTURE_FILES);
  });
});
