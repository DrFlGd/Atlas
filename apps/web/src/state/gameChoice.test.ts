import { describe, expect, it } from 'vitest';
import { HOME_PAGE_KIND, type CatalogueGame, type ListedPage } from '@atlas/importer-api';
import {
  choiceGame,
  choicePageKey,
  choicePageKeys,
  chosenPages,
  filterGames,
  keptCatalogue,
  newChoice,
  newPick,
  overCap,
  planPick,
  tickGames,
  tickPages,
  titleFromAddress,
  toggleGame,
  togglePage,
  type ChoiceGame,
} from './gameChoice';
import { MAX_RUN_ADDRESSES } from './importRun';

const SITE = 'https://maps.example.com';
const importer = {
  id: 'example-maps',
  title: 'Example maps',
  // Map and checklist pages only; guides are not supported yet.
  matches: (url: string) =>
    /^https:\/\/maps\.example\.com\/[a-z-]+\/(maps|checklists)\//u.test(url),
};

const map = (game: string, slug: string, group?: string): ListedPage => ({
  url: `${SITE}/${game}/maps/${slug}`,
  kind: 'map',
  title: titleFromAddress(slug),
  ...(group ? { group } : {}),
});

const valley: ListedPage[] = [
  { url: `${SITE}/test-valley/guides/where-to-start`, kind: 'guides', title: 'Where to start' },
  map('test-valley', 'the-valley', 'Overworld'),
  { url: `${SITE}/test-valley/checklists/shrines`, kind: 'checklists', title: 'Shrines' },
  map('test-valley', 'the-caves', 'Underground'),
];

const game = (
  key: string,
  listed: ListedPage[] | null,
  recorded: { url: string; mapId: string | null }[] = [],
): ChoiceGame => choiceGame({ key, title: key, importer, packId: null, listed, recorded });

describe('titleFromAddress', () => {
  it('tidies the last part of an address', () => {
    expect(titleFromAddress(`${SITE}/test-valley/maps/the-lands_between`)).toBe(
      'The lands between',
    );
    expect(titleFromAddress(`${SITE}/test-valley/maps/the-caves/?x=1`)).toBe('The caves');
    expect(titleFromAddress('not an address')).toBe('Not an address');
  });
});

describe('choiceGame', () => {
  it('lists maps first, ticks what the importer can add, and marks what was added', () => {
    const chosen = game('test-valley', valley, [
      { url: `${SITE}/test-valley/maps/the-caves/`, mapId: 'test-valley:map:caves' },
      { url: `${SITE}/test-valley/maps/old-map`, mapId: 'test-valley:map:old' },
    ]);
    expect(chosen.source).toBe('site');
    expect(
      chosen.pages.map((page) => [page.title, page.kind, page.checked, page.added, page.supported]),
    ).toEqual([
      ['The valley', 'map', true, false, true],
      ['The caves', 'map', true, true, true],
      ['Old map', 'map', true, true, true],
      ['Where to start', 'guides', false, false, false],
      ['Shrines', 'checklists', true, false, true],
    ]);
    expect(chosen.pages.find((page) => page.title === 'Old map')?.unlisted).toBe(true);
    expect(chosen.pages[0]!.group).toBe('Overworld');
  });

  it('without a game page, lists the pages the game was made from', () => {
    const chosen = choiceGame({
      key: 'test-valley',
      title: 'Test valley',
      importer,
      packId: 'test-valley',
      listed: null,
      recorded: [{ url: `${SITE}/test-valley/maps/the-valley`, mapId: 'v' }],
      note: 'No game page.',
      tick: false,
    });
    expect(chosen.source).toBe('recorded');
    expect(chosen.note).toBe('No game page.');
    expect(chosen.pages).toEqual([
      {
        url: `${SITE}/test-valley/maps/the-valley`,
        title: 'The valley',
        kind: 'map',
        group: null,
        supported: true,
        added: true,
        checked: false,
        unlisted: false,
      },
    ]);
  });

  it('ticks a site’s home page even when it ticks nothing else, until it is added', () => {
    const home: ListedPage = {
      url: `${SITE}/test-valley/checklists/home`,
      kind: HOME_PAGE_KIND,
      title: 'Home',
      group: 'Home page',
    };
    const pages = [home, map('test-valley', 'the-valley')];
    const options = { key: 'test-valley', title: 'Test valley', importer, packId: null };
    const fresh = choiceGame({ ...options, listed: pages, recorded: [], tick: false });
    // Maps first, as always; the home page ticked though nothing else is.
    expect(fresh.pages.map((page) => [page.title, page.checked])).toEqual([
      ['The valley', false],
      ['Home', true],
    ]);
    const added = choiceGame({
      ...options,
      listed: pages,
      recorded: [{ url: home.url, mapId: null }],
      tick: false,
    });
    expect(added.pages.find((page) => page.title === 'Home')).toMatchObject({
      added: true,
      checked: false,
    });
  });
});

describe('the choice', () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) => map('test-hills', `hill-${i + 1}`));

  it('takes the ticks off pages beyond the cap, later games first', () => {
    const choice = newChoice('add', [game('test-valley', valley), game('test-hills', many(30))], 3);
    // 25 pages in one go, 3 opened to read the lists: 22 ticked.
    expect(chosenPages(choice)).toHaveLength(MAX_RUN_ADDRESSES - 3);
    expect(choice.capped).toBe(3 + 30 - 22);
    expect(
      chosenPages(choice)
        .slice(0, 3)
        .map((page) => page.game),
    ).toEqual(['test-valley', 'test-valley', 'test-valley']);
    expect(overCap(choice)).toBeNull();
  });

  it('opens the ticked pages game by game, maps first, and says when they are too many', () => {
    let choice = newChoice('update', [game('test-valley', valley)], 24);
    expect(chosenPages(choice).map((page) => page.url)).toEqual([valley[1]!.url]);
    choice = togglePage(choice, 'test-valley', valley[3]!.url);
    expect(overCap(choice)).toBe(
      'That is 2 pages, and this app opens at most 25 pages at a time, 24 of them already for reading the lists. Untick 1 and add them afterwards.',
    );
    // A page the importer cannot add cannot be ticked.
    const guide = togglePage(choice, 'test-valley', valley[0]!.url);
    expect(guide).toEqual(choice);
    choice = togglePage(choice, 'test-valley', valley[1]!.url);
    expect(overCap(choice)).toBeNull();
    expect(chosenPages(choice)).toEqual([
      { url: valley[3]!.url, importerId: 'example-maps', game: 'test-valley' },
    ]);
  });
});

describe('Tick all and Tick none among the pages to choose', () => {
  const choice = () =>
    newChoice(
      'add',
      [game('test-valley', valley), game('test-coast', [map('test-coast', 'coast')])],
      1,
    );

  it('act on every page of every game that this app can add, never on one it cannot', () => {
    const start = choice();
    const keys = choicePageKeys(start);
    // Where to start is a guide, which this importer cannot add: never listed to tick.
    expect(keys.shown).toEqual([
      choicePageKey('test-valley', valley[1]!.url),
      choicePageKey('test-valley', valley[3]!.url),
      choicePageKey('test-valley', valley[2]!.url),
      choicePageKey('test-coast', `${SITE}/test-coast/maps/coast`),
    ]);
    expect(keys.ticked).toEqual(keys.shown);

    const none = tickPages(start, keys.shown, false);
    expect(chosenPages(none)).toEqual([]);
    expect(choicePageKeys(none).ticked).toEqual([]);
    const all = tickPages(
      none,
      [...keys.shown, choicePageKey('test-valley', valley[0]!.url)],
      true,
    );
    expect(choicePageKeys(all).ticked).toEqual(keys.shown);
    expect(all.games[0]!.pages.find((page) => page.url === valley[0]!.url)?.checked).toBe(false);
  });

  it('change only the pages named, in the game named', () => {
    const start = tickPages(choice(), choicePageKeys(choice()).shown, false);
    const one = tickPages(
      start,
      [choicePageKey('test-coast', `${SITE}/test-coast/maps/coast`)],
      true,
    );
    expect(chosenPages(one).map((page) => page.game)).toEqual(['test-coast']);
    // The same address under another game's key is another page.
    const other = tickPages(start, [choicePageKey('test-coast', valley[1]!.url)], true);
    expect(chosenPages(other)).toEqual([]);
  });
});

describe('a list of games', () => {
  const games: CatalogueGame[] = [
    { id: 'test-valley', name: 'Test Valley', address: `${SITE}/test-valley` },
    {
      id: 'test-coast',
      name: 'Test Coast',
      address: `${SITE}/test-coast/maps/the-coast`,
      search: 'sea shore',
    },
    { id: 'test-hills', name: 'Test Hills', address: `${SITE}/test-hills` },
  ];

  it('marks games in the maps folder and games with one map, and ticks none', () => {
    const pick = newPick(importer, `${SITE}/`, games, new Set(['test-hills']));
    expect(pick.ticked).toEqual([]);
    expect(pick.games.map((game) => [game.id, game.added, game.direct])).toEqual([
      ['test-valley', false, false],
      ['test-coast', false, true],
      ['test-hills', true, false],
    ]);
  });

  it('finds games by every word of the search, ignoring case', () => {
    expect(filterGames(games, '').map((game) => game.id)).toHaveLength(3);
    expect(filterGames(games, 'SHORE test').map((game) => game.id)).toEqual(['test-coast']);
    expect(filterGames(games, 'hills valley')).toEqual([]);
  });

  it('plans the ticked games that fit, in the order of the list', () => {
    const lots: CatalogueGame[] = Array.from({ length: 14 }, (_, i) => ({
      id: `game-${i}`,
      name: `Game ${i}`,
      address: i === 0 ? `${SITE}/game-0/maps/only` : `${SITE}/game-${i}`,
    }));
    let pick = newPick(importer, `${SITE}/`, lots, new Set());
    for (const game of [...lots].reverse()) pick = toggleGame(pick, game.id);
    // One page for the list; the game with one map needs 1, the others 2 each.
    const plan = planPick(pick);
    expect(plan.games.map((game) => game.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `game-${i}`),
    );
    expect(plan.leftOut.map((game) => game.id)).toEqual(['game-12', 'game-13']);
    pick = toggleGame(pick, 'game-13');
    expect(pick.ticked).not.toContain('game-13');
  });

  it('ticks and unticks the games a search shows, keeping the others as they were', () => {
    let pick = toggleGame(newPick(importer, `${SITE}/`, games, new Set()), 'test-hills');
    const shown = filterGames(pick.games, 'test c').map((game) => game.id);
    expect(shown).toEqual(['test-coast']);
    pick = tickGames(pick, [...shown, 'test-gone'], true);
    expect(pick.ticked).toEqual(['test-hills', 'test-coast']);
    // Ticking again changes nothing; a game not in the list is never ticked.
    expect(tickGames(pick, shown, true).ticked).toEqual(['test-hills', 'test-coast']);
    pick = tickGames(
      pick,
      filterGames(pick.games, '').map((game) => game.id),
      true,
    );
    expect(pick.ticked).toEqual(['test-hills', 'test-coast', 'test-valley']);
    pick = tickGames(pick, shown, false);
    expect(pick.ticked).toEqual(['test-hills', 'test-valley']);
  });

  it('opens no page for a kept list, so one more ticked game fits', () => {
    const lots: CatalogueGame[] = Array.from({ length: 14 }, (_, i) => ({
      id: `game-${i}`,
      name: `Game ${i}`,
      address: `${SITE}/game-${i}`,
    }));
    const tickAll = (pick: ReturnType<typeof newPick>) =>
      lots.reduce((ticked, game) => toggleGame(ticked, game.id), pick);
    const fresh = tickAll(newPick(importer, `${SITE}/`, lots, new Set()));
    expect(fresh.keptFrom).toBeNull();
    expect(planPick(fresh).games).toHaveLength(Math.floor((MAX_RUN_ADDRESSES - 1) / 2));
    const kept = tickAll(
      newPick(importer, `${SITE}/`, lots, new Set(), { keptFrom: '2026-01-02T03:04:05.000Z' }),
    );
    expect(kept.keptFrom).toBe('2026-01-02T03:04:05.000Z');
    expect(planPick(kept).games).toHaveLength(Math.floor(MAX_RUN_ADDRESSES / 2));
  });

  it('keeps the ticks of games that are still listed when the list is read again', () => {
    const pick = newPick(importer, `${SITE}/`, games, new Set(), {
      ticked: ['test-hills', 'test-gone', 'test-valley'],
    });
    expect(pick.ticked).toEqual(['test-hills', 'test-valley']);
  });

  it('uses a kept list only when it is whole, timed and from the list as it is now', () => {
    /** A made-up list of games at `address`. */
    const list = (address: string) => ({
      address,
      label: 'All games',
      matches: (url: string) => url === address,
      pageReader: '() => null',
      convert: () => ({ ok: false, message: 'Not read in this test.' }),
    });
    const site = {
      ...importer,
      games: { matches: (url: string) => /^https:\/\/maps\.example\.com\/[a-z-]+$/u.test(url) },
      catalogue: list(`${SITE}/`),
      catalogues: () => [list(`${SITE}/harbours`)],
    } as unknown as Parameters<typeof keptCatalogue>[1];
    const kept = { url: `${SITE}/`, readAt: '2026-01-02T03:04:05.000Z', games };
    expect(keptCatalogue(kept, site)).toEqual(kept);
    // What the app stored comes back as it was checked when it was read.
    expect(keptCatalogue(JSON.parse(JSON.stringify(kept)), site)?.games).toEqual(games);
    for (const bad of [
      undefined,
      null,
      'a list',
      { ...kept, url: `${SITE}/games` },
      { ...kept, readAt: 'some day' },
      { ...kept, readAt: 5 },
      { ...kept, games: [] },
      { ...kept, games: 'many' },
      { ...kept, games: [{ id: 'other', name: 'Other', address: 'https://other.example.org/x' }] },
      { ...kept, games: [games[0], games[0]] },
    ]) {
      expect(keptCatalogue(bad, site)).toBeNull();
    }
    // An importer without a list of games has none kept.
    expect(keptCatalogue(kept, importer)).toBeNull();
    // A second list of the importer is kept under its own address, and only while the importer offers it.
    const second = { ...kept, url: `${SITE}/harbours` };
    expect(keptCatalogue(second, site, `${SITE}/harbours`)).toEqual(second);
    expect(keptCatalogue(second, site)).toBeNull();
    expect(keptCatalogue(second, { ...site, catalogues: () => [] }, `${SITE}/harbours`)).toBeNull();
  });
});
