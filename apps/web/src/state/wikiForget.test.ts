import { CONFIRMABLE_LICENCES, pageKey, type AtlasImporter } from '@atlas/importer-api';
import { beforeAll, describe, expect, it } from 'vitest';
import { forgetSite } from './importing';
import { SETTINGS, openProgressStore, progressStore } from './services';
import {
  flushWikiNotes,
  holdsAny,
  loadWikiNotes,
  noteWikiContents,
  noteWikiFailed,
  noteWikiRead,
  setSiteLicence,
  setSiteWay,
  setWikiFollow,
  setWikiLeftOut,
  siteNotesHeld,
  useWikiNotes,
  withoutSite,
  type WikiNotes,
} from './wikiNotes';

/**
 * Forgetting what the app keeps of one wiki's site (a wiki deleted, or
 * started again from the beginning), when one importer reads two made-up
 * wikis: the notes of the other one must stay as they were.
 */

beforeAll(async () => {
  // No IndexedDB here: the store kept in memory, as in a browser that allows none.
  await openProgressStore();
});

const MARSH = 'https://wiki.marsh.example/wiki';
const DUNES = 'https://wiki.dunes.example/wiki';
const licence = { ...CONFIRMABLE_LICENCES[0]!, confirmedAt: '2026-11-13T09:00:00.000Z' };

/** An importer of made-up wikis, each its own site by its host. */
const wikis = (id: string): AtlasImporter => ({
  apiVersion: 1,
  id,
  title: 'Other wikis',
  description: 'Reads made-up wikis.',
  version: '1.0.0',
  matches: () => true,
  pageReader: '() => null',
  fetch: { addresses: (url: string) => [url] },
  convert: () => ({ ok: false, message: 'no' }),
  siteInfo: (url) => ({ key: new URL(url).hostname, ways: ['fetch', 'window'] }),
});

const ofHost = (host: string) => (address: string) => {
  try {
    return new URL(address).hostname === host;
  } catch {
    return false;
  }
};

/** Notes on both wikis: each with every part the app keeps. */
function bothWikis(): WikiNotes {
  const of = (wiki: string, game: string) => ({
    contents: {
      [pageKey(`${wiki}/Contents`)]: {
        address: `${wiki}/Contents`,
        game,
        readAt: '2026-11-13T09:00:00Z',
        pages: [{ url: `${wiki}/Lanterns`, title: 'Lanterns' }],
      },
    },
    failed: {
      [pageKey(`${wiki}/Fog`)]: { url: `${wiki}/Fog`, message: 'Busy', at: '' },
    },
    links: { [pageKey(`${wiki}/Lanterns`)]: [`${wiki}/Wicks`] },
    otherNames: { [pageKey(`${wiki}/Lamp`)]: `${wiki}/Lanterns` },
    leftOut: [pageKey(`${wiki}/Glass`)],
  });
  const marsh = of(MARSH, 'Marsh');
  const dunes = of(DUNES, 'Dunes');
  return {
    contents: { ...marsh.contents, ...dunes.contents },
    failed: { ...marsh.failed, ...dunes.failed },
    links: { ...marsh.links, ...dunes.links },
    otherNames: { ...marsh.otherNames, ...dunes.otherNames },
    leftOut: [...marsh.leftOut, ...dunes.leftOut],
    follow: 'ticked',
    sites: {
      'wiki.marsh.example': { way: 'window', licence },
      'wiki.dunes.example': { way: 'fetch', licence },
    },
  };
}

describe('the notes of a wiki’s site, without another wiki of the same importer', () => {
  it('drops every part of one site and keeps the other’s as it was', () => {
    const notes = bothWikis();
    const gone = withoutSite(notes, 'wiki.marsh.example', ofHost('wiki.marsh.example'));
    expect(Object.keys(gone.contents)).toEqual([pageKey(`${DUNES}/Contents`)]);
    expect(Object.keys(gone.failed)).toEqual([pageKey(`${DUNES}/Fog`)]);
    expect(gone.links).toEqual({ [pageKey(`${DUNES}/Lanterns`)]: [`${DUNES}/Wicks`] });
    expect(gone.otherNames).toEqual({ [pageKey(`${DUNES}/Lamp`)]: `${DUNES}/Lanterns` });
    expect(gone.leftOut).toEqual([pageKey(`${DUNES}/Glass`)]);
    expect(gone.sites).toEqual({ 'wiki.dunes.example': { way: 'fetch', licence } });
    // How far a session follows links is the importer's, not a site's.
    expect(gone.follow).toBe(notes.follow);
    // The other wiki's entries are the very same.
    expect(gone.contents[pageKey(`${DUNES}/Contents`)]).toBe(
      notes.contents[pageKey(`${DUNES}/Contents`)],
    );
  });

  it('counts what is held of a site, for the person', () => {
    const notes = bothWikis();
    const held = siteNotesHeld(notes, 'wiki.marsh.example', ofHost('wiki.marsh.example'));
    expect(held).toEqual({
      contents: true,
      failed: 1,
      leftOut: 1,
      links: 2,
      way: true,
      licence: true,
    });
    expect(holdsAny(held)).toBe(true);
    const none = siteNotesHeld(notes, 'wiki.reeds.example', ofHost('wiki.reeds.example'));
    expect(holdsAny(none)).toBe(false);
  });
});

describe('forgetting a wiki’s site', () => {
  it('forgets its notes, its records and its pages kept for later; the other wiki keeps all of its own', async () => {
    const importer = wikis('forget-two-wikis');
    const id = importer.id;
    await loadWikiNotes(id);
    for (const [wiki, game] of [
      [MARSH, 'Marsh'],
      [DUNES, 'Dunes'],
    ] as const) {
      await noteWikiContents(id, `${wiki}/Contents`, game, [
        { url: `${wiki}/Lanterns`, title: 'Lanterns' },
        { url: `${wiki}/Fog`, title: 'Fog' },
      ]);
      await noteWikiRead(id, `${wiki}/Lamp`, [`${wiki}/Wicks`], `${wiki}/Lanterns`);
      await noteWikiFailed(id, `${wiki}/Fog`, 'The site is busy.');
      await setWikiLeftOut(id, [`${wiki}/Glass`], true);
      await setSiteLicence(id, new URL(wiki).hostname, licence);
    }
    await setSiteWay(id, 'wiki.marsh.example', 'window');
    await setSiteWay(id, 'wiki.dunes.example', 'fetch');
    await setWikiFollow(id, 'ticked');
    await flushWikiNotes();
    // Pages kept for later: one list of each wiki, and a list with pages of both.
    await progressStore().putSetting(SETTINGS.pageQueue(id), [
      { key: `${MARSH}/Contents`, game: 'Marsh', importerId: id, pages: [page(MARSH, 'Reeds')] },
      { key: `${DUNES}/Contents`, game: 'Dunes', importerId: id, pages: [page(DUNES, 'Reeds')] },
      {
        key: 'https://lists.example/both',
        game: 'Both',
        importerId: id,
        pages: [page(MARSH, 'Oars'), page(DUNES, 'Oars')],
      },
    ]);
    const before = useWikiNotes.getState().byImporter[id]!;

    await forgetSite(importer, 'wiki.marsh.example');
    await flushWikiNotes();

    const after = useWikiNotes.getState().byImporter[id]!;
    expect(after).toEqual(withoutSite(before, 'wiki.marsh.example', ofHost('wiki.marsh.example')));
    expect(holdsAny(siteNotesHeld(after, 'wiki.marsh.example', ofHost('wiki.marsh.example')))).toBe(
      false,
    );
    // The other wiki: every part as it was.
    const dunes = (notes: WikiNotes) =>
      withoutSite(notes, 'wiki.marsh.example', ofHost('wiki.marsh.example'));
    expect(after.contents).toEqual(dunes(before).contents);
    expect(Object.keys(after.contents)).toEqual([pageKey(`${DUNES}/Contents`)]);
    expect(after.failed[pageKey(`${DUNES}/Fog`)]?.message).toBe('The site is busy.');
    expect(after.links).toEqual({ [pageKey(`${DUNES}/Lanterns`)]: [`${DUNES}/Wicks`] });
    expect(after.otherNames).toEqual({ [pageKey(`${DUNES}/Lamp`)]: `${DUNES}/Lanterns` });
    expect(after.leftOut).toEqual([pageKey(`${DUNES}/Glass`)]);
    expect(after.sites).toEqual({ 'wiki.dunes.example': { way: 'fetch', licence } });
    expect(after.follow).toEqual(before.follow);

    // Kept so in the settings: read back from them as the app starts, the same.
    const store = progressStore();
    expect(await store.getSetting(SETTINGS.wikiSites(id))).toEqual(after.sites);
    expect(await store.getSetting(SETTINGS.wikiLeftOut(id))).toEqual(after.leftOut);
    expect(Object.keys((await store.getSetting(SETTINGS.wikiFailed(id))) as object)).toEqual([
      pageKey(`${DUNES}/Fog`),
    ]);
    expect(Object.keys((await store.getSetting(SETTINGS.wikiContents(id))) as object)).toEqual([
      pageKey(`${DUNES}/Contents`),
    ]);
    expect(await store.getSetting(SETTINGS.wikiOtherNames(id))).toEqual(after.otherNames);
    const links = await store.listSettings(SETTINGS.wikiPageLinksOf(id));
    expect(links.filter((entry) => entry.value !== null).map((entry) => entry.value)).toEqual([
      [`${DUNES}/Wicks`],
    ]);
    // The pages kept for later: the marsh list gone, the mixed list without its marsh page.
    expect(await store.getSetting(SETTINGS.pageQueue(id))).toEqual([
      { key: `${DUNES}/Contents`, game: 'Dunes', importerId: id, pages: [page(DUNES, 'Reeds')] },
      {
        key: 'https://lists.example/both',
        game: 'Both',
        importerId: id,
        pages: [page(DUNES, 'Oars')],
      },
    ]);
  });

  it('changes nothing of an importer that kept nothing of the site', async () => {
    const importer = wikis('forget-nothing');
    await setSiteWay(importer.id, 'wiki.dunes.example', 'window');
    const before = useWikiNotes.getState().byImporter[importer.id]!;
    await forgetSite(importer, 'wiki.marsh.example');
    expect(useWikiNotes.getState().byImporter[importer.id]).toEqual(before);
    expect(await progressStore().getSetting(SETTINGS.pageQueue(importer.id))).toBeUndefined();
  });
});

function page(wiki: string, slug: string) {
  return { url: `${wiki}/${slug}`, title: slug };
}
