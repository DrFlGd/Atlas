import type { GameGroup } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import {
  addCarriedGroup,
  groupOf,
  joinGames,
  makeFirst,
  renameGroup,
  sameTitleGames,
  siteOf,
  sourceNames,
  sourceToOpen,
  takeOut,
  titleKey,
  titleRows,
  ungroup,
} from './gameGroups';

const ids = (group: GameGroup | undefined) => group?.members.map((m) => m.gameId);

describe('a title tidied', () => {
  it('compares without case, accents or punctuation', () => {
    expect(titleKey('The Isle: Remastered!')).toBe('the isle remastered');
    expect(titleKey('  the  ÎSLE — remastered ')).toBe('the isle remastered');
    expect(titleKey('Café 2')).not.toBe(titleKey('Cafe 3'));
    expect(titleKey('...')).toBe('');
  });

  it('finds the other games with the same title', () => {
    const catalog = [
      { id: 'a', title: 'Sundered Isles' },
      { id: 'b', title: 'sundered isles.' },
      { id: 'c', title: 'Sundered Isle' },
    ];
    expect(sameTitleGames(catalog, 'a').map((e) => e.id)).toEqual(['b']);
    expect(sameTitleGames(catalog, 'c')).toEqual([]);
    expect(sameTitleGames(catalog, 'x')).toEqual([]);
  });
});

describe('changing the groups', () => {
  it('joins two games, then a third, keeping the first group and the order', () => {
    let groups = joinGames([], 'maps', 'wiki', 'Isles', 'g1');
    expect(groups).toEqual([
      { id: 'g1', title: 'Isles', members: [{ gameId: 'maps' }, { gameId: 'wiki' }] },
    ]);
    groups = joinGames(groups, 'other', 'maps', 'Sundered Isles', 'g2');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe('g1');
    expect(groups[0]!.title).toBe('Sundered Isles');
    expect(ids(groups[0])).toEqual(['other', 'maps', 'wiki']);
    // Two groups become one, the first game's.
    const two = joinGames(groups, 'x', 'y', 'XY', 'g3');
    const one = joinGames(two, 'x', 'wiki', 'All', 'g4');
    expect(one.map((g) => g.id)).toEqual(['g3']);
    expect(ids(one[0])).toEqual(['x', 'y', 'other', 'maps', 'wiki']);
    expect(() => joinGames([], 'a', 'a', 'A', 'g')).toThrow();
    expect(() => joinGames([], 'a', 'b', '  ', 'g')).toThrow();
    const many = Array.from({ length: 20 }, (_, i) => `game-${i}`);
    const full: GameGroup[] = [
      { id: 'f', title: 'F', members: many.map((gameId) => ({ gameId })) },
    ];
    expect(() => joinGames(full, 'game-0', 'one-more', 'F', 'g')).toThrow(/20 games/);
  });

  it('takes one out, undoes a whole title, renames and leaves the given groups as they were', () => {
    const groups = joinGames(joinGames([], 'a', 'b', 'AB', 'g1'), 'a', 'c', 'ABC', 'g1');
    const frozen = structuredClone(groups);
    const without = takeOut(groups, 'b');
    expect(ids(groupOf(without, 'a'))).toEqual(['a', 'c']);
    // One game left: the title is no more.
    expect(takeOut(without, 'c')).toEqual([]);
    expect(takeOut(groups, 'zzz')).toEqual(groups);
    expect(ungroup(groups, 'g1')).toEqual([]);
    expect(renameGroup(groups, 'g1', ' New ')[0]!.title).toBe('New');
    expect(ids(makeFirst(groups, 'c')[0])).toEqual(['c', 'a', 'b']);
    expect(groups).toEqual(frozen);
  });

  it('adds a group a map pack file carried, or joins the one here', () => {
    const carried = { gameId: 'a', title: 'Isles', members: [{ gameId: 'a' }, { gameId: 'b' }] };
    // Nothing here: added as it is, the game not here yet included.
    const added = addCarriedGroup([], carried, 'g1');
    expect(added.groups).toEqual([{ id: 'g1', title: 'Isles', members: carried.members }]);
    // b is under a title here: a joins it, and the title here stays.
    const here: GameGroup[] = [
      { id: 'h', title: 'Here', members: [{ gameId: 'b' }, { gameId: 'c' }] },
    ];
    const joined = addCarriedGroup(here, carried, 'g1');
    expect(joined.groups).toEqual([
      { id: 'h', title: 'Here', members: [{ gameId: 'b' }, { gameId: 'c' }, { gameId: 'a' }] },
    ]);
    expect(joined.group?.id).toBe('h');
    // Already in: nothing changes.
    expect(addCarriedGroup(joined.groups, carried, 'g2').groups).toEqual(joined.groups);
    // A game under another title stays there.
    const elsewhere: GameGroup[] = [
      { id: 'h', title: 'Here', members: [{ gameId: 'a' }, { gameId: 'x' }] },
      { id: 'o', title: 'Other', members: [{ gameId: 'b' }, { gameId: 'y' }] },
    ];
    expect(addCarriedGroup(elsewhere, carried, 'g').groups).toEqual(elsewhere);
  });
});

describe('a list of games with titles', () => {
  const catalog = [
    { id: 'demo', title: 'Demo' },
    { id: 'isles-b', title: 'Isles B' },
    { id: 'hills', title: 'Hills' },
    { id: 'isles-a', title: 'Isles A' },
  ];

  it('shows one row per title where its first game here is, and a lone game as itself', () => {
    const groups: GameGroup[] = [
      {
        id: 'g',
        title: 'Isles',
        members: [{ gameId: 'isles-a' }, { gameId: 'gone' }, { gameId: 'isles-b' }],
      },
      { id: 'h', title: 'Hills', members: [{ gameId: 'hills' }, { gameId: 'not-here' }] },
    ];
    const rows = titleRows(catalog, groups);
    expect(
      rows.map((row) =>
        row.kind === 'title'
          ? `${row.group.title}: ${row.entries.map((e) => e.id).join(', ')}`
          : row.entry.id,
      ),
    ).toEqual(['demo', 'Isles: isles-a, isles-b', 'hills']);
  });

  it('names each source by its importer, "Your own", or its title, numbered when the same', () => {
    const names = sourceNames([
      { gameId: 'a', title: 'Isles', importerTitle: 'Demo map site' },
      { gameId: 'b', title: 'Isles', importerTitle: 'Example Wiki' },
      { gameId: 'c', title: 'Isles', madeInApp: true },
      { gameId: 'd', title: 'Isles', importerTitle: 'demo map site' },
      { gameId: 'e', title: 'Isles of old' },
    ]);
    expect([...names.values()]).toEqual([
      'Demo map site 1',
      'Example Wiki',
      'Your own',
      'demo map site 2',
      'Isles of old',
    ]);
  });

  it('tells sources of one importer apart by their sites, and numbers only those still alike', () => {
    const names = sourceNames([
      {
        gameId: 'a',
        title: 'Fenmoor',
        importerTitle: 'Example Wiki',
        site: 'wiki.fenmoor.example',
      },
      {
        gameId: 'b',
        title: 'Fenmoor',
        importerTitle: 'Demo map site',
        site: 'maps.fenmoor.example',
      },
      {
        gameId: 'c',
        title: 'Fenmoor',
        importerTitle: 'Example Wiki',
        site: 'fenmoor.pages.example',
      },
      { gameId: 'd', title: 'Fenmoor', importerTitle: 'Example Wiki' },
    ]);
    // The map site's name is no other's: it stays as it is, without its site.
    expect([...names.values()]).toEqual([
      'Example Wiki (wiki.fenmoor.example)',
      'Demo map site',
      'Example Wiki (fenmoor.pages.example)',
      'Example Wiki',
    ]);
  });

  it('numbers sources of one importer whose site is the same or not known, never with their site', () => {
    expect([
      ...sourceNames([
        {
          gameId: 'a',
          title: 'Fenmoor',
          importerTitle: 'Example Wiki',
          site: 'wiki.fenmoor.example',
        },
        {
          gameId: 'b',
          title: 'Fenmoor',
          importerTitle: 'Example Wiki',
          site: 'WIKI.fenmoor.example',
        },
        {
          gameId: 'c',
          title: 'Fenmoor',
          importerTitle: 'Example Wiki',
          site: 'fenmoor.pages.example',
        },
        { gameId: 'd', title: 'Fenmoor', importerTitle: 'Example Wiki', site: null },
      ]).values(),
    ]).toEqual([
      'Example Wiki 1',
      'Example Wiki 2',
      'Example Wiki (fenmoor.pages.example)',
      'Example Wiki 3',
    ]);
    // No site known for any: numbered, as before sites were known.
    expect([
      ...sourceNames([
        { gameId: 'a', title: 'Fenmoor', importerTitle: 'Example Wiki' },
        { gameId: 'b', title: 'Fenmoor', importerTitle: 'Example Wiki', site: '' },
      ]).values(),
    ]).toEqual(['Example Wiki 1', 'Example Wiki 2']);
    // Two games made in the app have no site.
    expect([
      ...sourceNames([
        { gameId: 'a', title: 'Fenmoor', madeInApp: true },
        { gameId: 'b', title: 'Fenmoor', madeInApp: true },
      ]).values(),
    ]).toEqual(['Your own 1', 'Your own 2']);
  });

  it('keeps every name different from the plain names of other sources', () => {
    const names = sourceNames([
      { gameId: 'a', title: 'Fenmoor', importerTitle: 'Example Wiki' },
      { gameId: 'b', title: 'Fenmoor', importerTitle: 'Example Wiki' },
      { gameId: 'c', title: 'Example Wiki 1' },
    ]);
    expect([...names.values()]).toEqual(['Example Wiki 1', 'Example Wiki 2', 'Example Wiki 1 2']);
    expect(new Set(names.values()).size).toBe(3);
  });

  it('opens the source last used, else the first here, a map before a wiki', () => {
    const group: GameGroup = {
      id: 'g',
      title: 'Isles',
      members: [{ gameId: 'wiki' }, { gameId: 'a' }, { gameId: 'b' }],
    };
    const present = new Set(['wiki', 'a', 'b']);
    const hasMap = (id: string) => id !== 'wiki';
    expect(sourceToOpen(group, present, null, hasMap)).toBe('a');
    expect(sourceToOpen(group, present, 'b', hasMap)).toBe('b');
    expect(sourceToOpen(group, new Set(['wiki', 'b']), 'a', hasMap)).toBe('b');
    // Wikis only: the first.
    expect(sourceToOpen(group, new Set(['wiki']), null, hasMap)).toBe('wiki');
    expect(sourceToOpen(group, new Set(), null, hasMap)).toBeNull();
  });
});

describe('the site a game was made from', () => {
  it('is the host of its first web page, in lower case and without www', () => {
    expect(siteOf([{ url: 'https://wiki.fenmoor.example/wiki/Stones' }])).toBe(
      'wiki.fenmoor.example',
    );
    expect(siteOf([{ url: 'http://WWW.Fenmoor.Example:8080/maps?x=1#top' }])).toBe(
      'fenmoor.example',
    );
    expect(siteOf([{ url: 'https://user:secret@wiki.fenmoor.example./a' }])).toBe(
      'wiki.fenmoor.example',
    );
    // Only a leading www goes.
    expect(siteOf([{ url: 'https://wiki.www.example/' }])).toBe('wiki.www.example');
    expect(siteOf([{ url: 'https://www/' }])).toBe('www');
  });

  it('is the host of the first page when pages are of several hosts', () => {
    expect(
      siteOf([
        { url: 'https://fenmoor.pages.example/a' },
        { url: 'https://wiki.fenmoor.example/b' },
      ]),
    ).toBe('fenmoor.pages.example');
  });

  it('counts only https and http addresses', () => {
    expect(siteOf([{ url: 'ftp://files.fenmoor.example/a' }])).toBeNull();
    expect(siteOf([{ url: 'file:///home/maps/a.html' }])).toBeNull();
    expect(siteOf([{ url: 'atlas-pack://localhost/demo/' }])).toBeNull();
    expect(siteOf([{ url: 'not an address' }])).toBeNull();
    expect(siteOf([{ url: 42 }, {}])).toBeNull();
    // A page that does not count is passed over for the next.
    expect(siteOf([{ url: 'file:///a.html' }, { url: 'https://maps.fenmoor.example/b' }])).toBe(
      'maps.fenmoor.example',
    );
  });

  it('is none for a game that records no page', () => {
    expect(siteOf([])).toBeNull();
    expect(siteOf(undefined)).toBeNull();
    expect(siteOf(null)).toBeNull();
  });
});
