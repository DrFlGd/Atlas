import { pageKey } from '@atlas/importer-api';
import { beforeAll, describe, expect, it } from 'vitest';
import { allRows, wikiGroups } from '../library/wikiRows';
import { SETTINGS, openProgressStore, progressStore } from './services';
import {
  flushWikiNotes,
  loadWikiNotes,
  noteWikiFailed,
  noteWikiLinks,
  noteWikiRead,
  setWikiLeftOut,
  useWikiNotes,
} from './wikiNotes';

const WIKI = 'https://wiki.example.org/wiki';
const at = (n: number) => `${WIKI}/Page_${n}`;

beforeAll(async () => {
  // No IndexedDB here: the store kept in memory, as in a browser that allows none.
  await openProgressStore();
});

/** Times `work` and prints it, for the record of how a large wiki holds up. */
async function timed<T>(what: string, work: () => Promise<T> | T): Promise<T> {
  const start = performance.now();
  const result = await work();
  console.info(`${what}: ${(performance.now() - start).toFixed(0)} ms`);
  return result;
}

describe('the notes of a large wiki', () => {
  it('keeps every page of a wiki of thousands of pages, a record per page, and its rows stay right', async () => {
    const importer = 'large-wiki';
    const PAGES = 6000;
    const LINKS = 150;
    // Each page links to the next LINKS pages.
    const linksOf = (n: number) => Array.from({ length: LINKS }, (_, i) => at(n + 1 + i));
    await loadWikiNotes(importer);
    await timed(`noting ${PAGES} pages read, ${LINKS} links each`, async () => {
      for (let n = 0; n < PAGES; n++) await noteWikiRead(importer, at(n), linksOf(n));
    });
    for (let n = 0; n < 50; n++) {
      await noteWikiFailed(importer, at(PAGES + n), 'The wiki has no such page.');
    }
    await setWikiLeftOut(importer, [at(PAGES + 60), at(PAGES + 61)], true);
    await timed('writing the links (one record per page)', flushWikiNotes);

    const notes = useWikiNotes.getState().byImporter[importer]!;
    // Nothing was cut: 2,000 was the bound before.
    expect(Object.keys(notes.links)).toHaveLength(PAGES);
    expect(Object.keys(notes.failed)).toHaveLength(50);
    const stored = await progressStore().listSettings(SETTINGS.wikiPageLinksOf(importer));
    expect(stored).toHaveLength(PAGES);
    expect(stored.find((entry) => entry.key.endsWith(pageKey(at(17))))?.value).toEqual(linksOf(17));
    // The old single record is not written at all.
    expect(await progressStore().getSetting(SETTINGS.wikiLinks(importer))).toBeUndefined();

    // A page read again writes only its own record.
    let written = 0;
    const store = progressStore();
    const putSettings = store.putSettings.bind(store);
    store.putSettings = (entries) => {
      written += entries.length;
      return putSettings(entries);
    };
    try {
      await noteWikiRead(importer, at(5), [at(1)]);
      await flushWikiNotes();
    } finally {
      store.putSettings = putSettings;
    }
    expect(written).toBe(1);

    // The rows of the wiki screen, over every page and its links.
    const read = Array.from({ length: PAGES }, (_, n) => ({ url: at(n) }));
    const contents = {
      address: `${WIKI}/Contents`,
      game: 'Large wiki',
      readAt: '2026-11-13T09:00:00Z',
      pages: Array.from({ length: PAGES + 100 }, (_, n) => ({
        url: at(n),
        title: `Page ${n}`,
        group: `Part ${Math.floor(n / 1000)}`,
      })),
    };
    const groups = await timed(`working out the rows of ${PAGES} pages read`, () =>
      wikiGroups({
        contents,
        read,
        guides: [],
        notes: useWikiNotes.getState().byImporter[importer]!,
      }),
    );
    // Again, as after every page of a go (the page keys are known by now).
    await timed('working them out again', () =>
      wikiGroups({
        contents,
        read,
        guides: [],
        notes: useWikiNotes.getState().byImporter[importer]!,
      }),
    );
    const rows = allRows(groups);
    const states = new Map<string, number>();
    for (const row of rows) states.set(row.state, (states.get(row.state) ?? 0) + 1);
    expect(states.get('read')).toBe(PAGES);
    expect(states.get('failed')).toBe(50);
    expect(states.get('left-out')).toBe(2);
    // Listed and not read: 100 less the failed and left out; and the 50 pages found by links beyond the contents.
    expect(states.get('not-read')).toBe(48 + 50);
    expect(groups.flatMap((group) => group.found.flatMap((found) => found.pages))).toHaveLength(50);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  }, 60_000);

  it('reads the links kept by version 0.6.1 in one record, and moves them to a record per page', async () => {
    const importer = 'old-wiki';
    const old = Object.fromEntries(
      Array.from({ length: 2500 }, (_, n) => [pageKey(at(n)), [at(n + 1), at(n + 2)]]),
    );
    await progressStore().putSetting(SETTINGS.wikiLinks(importer), old);
    // A page whose own record is newer than the old one keeps its own.
    await progressStore().putSetting(SETTINGS.wikiPageLinks(importer, pageKey(at(3))), [at(9)]);
    const notes = await loadWikiNotes(importer);
    expect(Object.keys(notes.links)).toHaveLength(2500);
    expect(notes.links[pageKey(at(3))]).toEqual([at(9)]);
    expect(notes.links[pageKey(at(4))]).toEqual([at(5), at(6)]);
    await flushWikiNotes();
    const stored = await progressStore().listSettings(SETTINGS.wikiPageLinksOf(importer));
    expect(stored).toHaveLength(2500);
    expect(await progressStore().getSetting(SETTINGS.wikiLinks(importer))).toBeNull();

    // Read again as a later start of the app would: the same notes, from the records per page.
    useWikiNotes.setState({ byImporter: {} });
    const again = await loadWikiNotes(importer);
    expect(again.links).toEqual(notes.links);

    // Links written again for pages read before replace theirs, and none removes a page's.
    await noteWikiLinks(importer, [
      { url: at(4), links: [at(7)] },
      { url: at(5), links: [] },
    ]);
    await flushWikiNotes();
    useWikiNotes.setState({ byImporter: {} });
    const last = await loadWikiNotes(importer);
    expect(last.links[pageKey(at(4))]).toEqual([at(7)]);
    expect(last.links[pageKey(at(5))]).toBeUndefined();
    expect(Object.keys(last.links)).toHaveLength(2499);
  });
});
