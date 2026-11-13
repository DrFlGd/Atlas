import { CONFIRMABLE_LICENCES, type AtlasImporter } from '@atlas/importer-api';
import { beforeAll, describe, expect, it } from 'vitest';
import { importContext } from './importing';
import { asksHow, siteReading, wayFor } from './readingWays';
import { SETTINGS, openProgressStore, progressStore } from './services';
import { loadWikiNotes, setSiteLicence, setSiteWay, useWikiNotes } from './wikiNotes';

beforeAll(async () => {
  // No IndexedDB here: the store kept in memory, as in a browser that allows none.
  await openProgressStore();
});

const base = {
  apiVersion: 1 as const,
  title: 'Wikis',
  description: 'Reads made-up wikis.',
  version: '1.0.0',
  matches: () => true,
  pageReader: '() => null',
  fetch: { addresses: (url: string) => [url] },
  convert: () => ({ ok: false as const, message: 'no' }),
};

/** An importer that reads a site it does not know by itself or in a window, and says so. */
const wikis = (id: string): AtlasImporter => ({
  ...base,
  id,
  siteInfo: (url) => ({
    key: new URL(url).hostname,
    ways: ['fetch', 'window'],
    notice: 'This app does not know this site.',
  }),
});

const PAGE = 'https://wiki.example.net/wiki/Lanterns';
const licence = { ...CONFIRMABLE_LICENCES[1]!, confirmedAt: '2026-11-13T09:00:00.000Z' };

describe('how a site is read', () => {
  it('is the importer’s first way until the person chooses, and asks once', async () => {
    const importer = wikis('ways-first');
    const before = await siteReading(importer, PAGE);
    expect(before).toMatchObject({ way: 'fetch', chosen: false });
    expect(asksHow(before)).toBe(true);
    await setSiteWay(importer.id, 'wiki.example.net', 'window');
    const after = await siteReading(importer, PAGE);
    expect(after).toMatchObject({ way: 'window', chosen: true });
    expect(asksHow(after)).toBe(false);
    await expect(wayFor(importer, PAGE)).resolves.toBe('window');
    // Another site of the same importer keeps its own choice.
    await expect(wayFor(importer, 'https://other.example.net/wiki/A')).resolves.toBe('fetch');
    // Kept in the settings, by the site's key.
    expect(await progressStore().getSetting(SETTINGS.wikiSites(importer.id))).toEqual({
      'wiki.example.net': { way: 'window' },
    });
  });

  it('falls back to the importer’s first way when it no longer offers the one chosen', async () => {
    const importer = wikis('ways-gone');
    await setSiteWay(importer.id, 'wiki.example.net', 'window');
    const narrowed: AtlasImporter = {
      ...importer,
      siteInfo: () => ({ key: 'wiki.example.net', ways: ['fetch'] }),
    };
    await expect(siteReading(narrowed, PAGE)).resolves.toMatchObject({
      way: 'fetch',
      chosen: false,
    });
    // One way and nothing to say: nothing to ask.
    expect(asksHow(await siteReading(narrowed, PAGE))).toBe(false);
  });

  it('is left to the importer when it offers no ways (`fetch.inWindow` as before)', async () => {
    await expect(wayFor({ ...base, id: 'ways-none' }, PAGE)).resolves.toBeUndefined();
  });
});

describe('the licence the person confirmed', () => {
  it('is kept for the site, read back, and forgotten', async () => {
    const importer = wikis('licence-kept');
    await setSiteLicence(importer.id, 'wiki.example.net', licence);
    await expect(siteReading(importer, PAGE)).resolves.toMatchObject({ licence });
    await setSiteWay(importer.id, 'wiki.example.net', 'fetch');
    await setSiteLicence(importer.id, 'wiki.example.net', null);
    const reading = await siteReading(importer, PAGE);
    expect(reading.licence).toBeUndefined();
    expect(reading.way).toBe('fetch');
  });

  it('is read only when it is one of the licences offered, with a time', async () => {
    const id = 'licence-stored';
    await progressStore().putSetting(SETTINGS.wikiSites(id), {
      'a.example': { licence, way: 'window' },
      'b.example': { licence: { ...licence, name: 'All rights reserved' }, way: 'post' },
      'c.example': { licence: { ...licence, confirmedAt: 'yesterday' } },
      'd.example': 'window',
    });
    const notes = await loadWikiNotes(id);
    expect(notes.sites).toEqual({ 'a.example': { licence, way: 'window' } });
    expect(useWikiNotes.getState().byImporter[id]?.sites).toEqual(notes.sites);
  });

  it('and the way the page was read reach the importer in its context', () => {
    const context = importContext(
      PAGE,
      '',
      'licence-context',
      false,
      undefined,
      undefined,
      undefined,
      {
        reading: 'window',
        confirmedLicence: licence,
      },
    );
    expect(context.reading).toBe('window');
    expect(context.confirmedLicence).toEqual(licence);
    const plain = importContext(PAGE, '', 'licence-context');
    expect('reading' in plain || 'confirmedLicence' in plain).toBe(false);
  });
});
