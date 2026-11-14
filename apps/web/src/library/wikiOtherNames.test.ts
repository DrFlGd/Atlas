import { pageKey } from '@atlas/importer-api';
import { beforeAll, describe, expect, it } from 'vitest';
import { pagesToFollow } from '../state/followLinks';
import { openProgressStore } from '../state/services';
import {
  NO_WIKI_NOTES,
  flushWikiNotes,
  loadWikiNotes,
  noteWikiFailed,
  noteWikiLinks,
  noteWikiRead,
  useWikiNotes,
  type WikiNotes,
} from '../state/wikiNotes';
import { allRows, wikiGroups } from './wikiRows';

/**
 * A page of a made-up wiki asked for under one name (Old_lamp) and read
 * from another address of the wiki (Lamp): one page, one row, never
 * fetched again under the other name.
 */

const WIKI = 'https://wiki.example.org/wiki';
const at = (slug: string) => `${WIKI}/${slug}`;
const wiki = {
  matches: (url: string) => url.startsWith(`${WIKI}/`),
  refuses: () => null,
};

beforeAll(async () => {
  await openProgressStore();
});

describe('a page read under another name', () => {
  it('is noted once: its links under the address it was read from, and its other name', async () => {
    const importer = 'other-names';
    await loadWikiNotes(importer);
    await noteWikiFailed(importer, at('Old_lamp'), 'It was tried before and did not work.');
    await noteWikiRead(importer, at('Old_lamp'), [at('Oil')], at('Lamp'));
    await flushWikiNotes();
    const notes = useWikiNotes.getState().byImporter[importer]!;
    expect(notes.otherNames).toEqual({ [pageKey(at('Old_lamp'))]: at('Lamp') });
    expect(notes.links[pageKey(at('Lamp'))]).toEqual([at('Oil')]);
    expect(notes.links[pageKey(at('Old_lamp'))]).toBeUndefined();
    expect(notes.failed).toEqual({});

    // Learnt again from the pages kept, when the game is built again: nothing changes twice.
    await noteWikiLinks(importer, [
      { url: at('Old_lamp'), links: [at('Oil')], pageAddress: at('Lamp') },
    ]);
    expect(useWikiNotes.getState().byImporter[importer]!.otherNames).toEqual(notes.otherNames);

    // The name read later as a page of its own is a page of its own again.
    await noteWikiRead(importer, at('Lamp'), []);
    await noteWikiRead(importer, at('Lamp_old'), [], at('Old_lamp'));
    const after = useWikiNotes.getState().byImporter[importer]!;
    expect(after.otherNames[pageKey(at('Old_lamp'))]).toBeUndefined();
    expect(after.otherNames[pageKey(at('Lamp_old'))]).toBe(at('Old_lamp'));
  });

  it('is one row with its own title, read, and a link to its other name is not a page found', () => {
    const notes: WikiNotes = {
      ...NO_WIKI_NOTES,
      otherNames: { [pageKey(at('Old_lamp'))]: at('Lamp') },
      links: { [pageKey(at('Keeper'))]: [at('Old_lamp'), at('Stairs')] },
    };
    const groups = wikiGroups({
      contents: {
        address: at('Contents'),
        game: 'Example Wiki',
        readAt: '2026-11-14T09:00:00Z',
        pages: [
          { url: at('Old_lamp'), title: 'Old lamp', group: 'Sights' },
          { url: at('Keeper'), title: 'Keeper', group: 'Sights' },
        ],
      },
      // The pack records the address asked; its guide, the address it was read from.
      read: [
        { url: at('Old_lamp'), importedAt: '2026-11-14T09:01:00Z' },
        { url: at('Keeper'), importedAt: '2026-11-14T09:02:00Z' },
      ],
      guides: [
        {
          id: 'example-wiki:guide:lamp',
          title: 'Lamp',
          url: at('Lamp'),
          section: 'Sights',
          changedByYou: false,
        },
        {
          id: 'example-wiki:guide:keeper',
          title: 'Keeper',
          url: at('Keeper'),
          section: 'Sights',
          changedByYou: false,
        },
      ],
      notes,
    });
    const rows = allRows(groups);
    expect(rows.map((row) => [row.title, row.state])).toEqual([
      ['Lamp', 'read'],
      ['Keeper', 'read'],
      ['Stairs', 'not-read'],
    ]);
    expect(rows[0]!.url).toBe(at('Lamp'));
    expect(rows[0]!.guideId).toBe('example-wiki:guide:lamp');
    expect(groups[0]!.found[0]!.pages.map((row) => row.title)).toEqual(['Stairs']);
  });

  it('is never added to a go again, under either name', () => {
    const { add } = pagesToFollow({
      follow: 'linked',
      depth: 0,
      links: [at('Old_lamp'), at('Lamp'), at('Stairs')],
      importer: wiki,
      inGo: new Set(),
      // Only the address asked is recorded with the pack.
      read: new Set([pageKey(at('Old_lamp'))]),
      leftOut: new Set(),
      otherNames: { [pageKey(at('Old_lamp'))]: at('Lamp') },
    });
    expect(add).toEqual([at('Stairs')]);
  });
});
