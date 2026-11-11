import { describe, expect, it } from 'vitest';
import type { CatalogueGame, ListedPage } from '@atlas/importer-api';
import {
  choiceGame,
  chosenPages,
  filterGames,
  newChoice,
  newPick,
  overCap,
  planPick,
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
});
