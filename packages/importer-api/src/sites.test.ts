import { describe, expect, it } from 'vitest';
import {
  CONFIRMABLE_LICENCES,
  asImporter,
  checkOutcome,
  findGameImporter,
  findImporter,
  findReader,
  isConfirmedLicence,
  readingWayOf,
  siteInfoOf,
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
    expect(asImporter(wikis).general).toBeTypeOf('function');
    expect(asImporter(wikis).siteInfo).toBeTypeOf('function');
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
