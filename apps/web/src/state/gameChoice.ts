import {
  MAP_KIND,
  canAddPage,
  checkCatalogue,
  pageKey,
  type AtlasImporter,
  type CatalogueGame,
  type ListedPage,
} from '@atlas/importer-api';
import { MAX_RUN_ADDRESSES } from './importRun';

/**
 * The lists the person chooses from before pages are opened: the pages of
 * games (read from their game pages, or the pages a game was made from),
 * and the games of a site's list of games. Nothing here talks to the shell;
 * `importing.ts` reads the pages and starts the run.
 *
 * Every page counts against the cap of {@link MAX_RUN_ADDRESSES} pages
 * opened in one go, the pages that list others (a game page, the list of
 * games) as well: those are counted in `opened`.
 */

/** One page of a game in the list to choose from. */
export interface ChoicePage {
  url: string;
  title: string;
  kind: string;
  group: string | null;
  /** The importer can add it (it recognises the address). Others are listed as not supported yet. */
  supported: boolean;
  /** The game has it already: adding it again refreshes it. */
  added: boolean;
  checked: boolean;
  /** Recorded with the game, but its game page did not list it (or was not read). */
  unlisted: boolean;
}

export interface ChoiceGame {
  /** Unique within the choice. */
  key: string;
  title: string;
  importerId: string;
  /** The pack of the game, when it is already in the maps folder. */
  packId: string | null;
  /** Read from the game page, or only the pages the game was made from. */
  source: 'site' | 'recorded';
  /** Why the game page was not read or not used, in words. */
  note: string | null;
  /** Maps first, then the other pages, each in the site's order. */
  pages: ChoicePage[];
  /**
   * The importer reads pages by fetching them: more pages may be ticked
   * than one go opens, and those left are kept to continue later.
   */
  queues: boolean;
}

export interface Choice {
  mode: 'add' | 'update';
  games: ChoiceGame[];
  /** Pages opened already in this go: game pages and the list of games. */
  opened: number;
  /** Pages that would have been ticked but were left unticked because of the cap. */
  capped: number;
  /** Games of a list of games that did not fit in this go. */
  leftOut: string[];
}

/** A page a game was made from, as its manifest records it. */
export interface RecordedPage {
  url: string;
  mapId: string | null;
}

/** "the-lands-between" → "The lands between", for a page known only by its address. */
export function titleFromAddress(url: string): string {
  let segment: string;
  try {
    segment = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    segment = url;
  }
  const words = segment.replaceAll(/[-_]+/gu, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : url;
}

const mapsFirst = (pages: ChoicePage[]) => [
  ...pages.filter((page) => page.kind === MAP_KIND),
  ...pages.filter((page) => page.kind !== MAP_KIND),
];

/**
 * A game in the list: its listed pages (all pages the importer can add
 * ticked), marked as added when the game was made from them, followed by
 * pages it was made from that the listing did not name. Without a listing,
 * the pages it was made from only.
 */
export function choiceGame(options: {
  key: string;
  title: string;
  importer: Pick<AtlasImporter, 'id' | 'matches'>;
  packId: string | null;
  listed: readonly ListedPage[] | null;
  recorded: readonly RecordedPage[];
  note?: string | null;
  /** Tick the pages the importer can add (default, unless it queues), or leave all unticked. */
  tick?: boolean;
  /** See {@link ChoiceGame.queues}. */
  queues?: boolean;
}): ChoiceGame {
  const queues = options.queues ?? false;
  // A game read page by page (a wiki, say) has many pages: the person picks.
  const tick = options.tick ?? !queues;
  const recorded = new Set(options.recorded.map((page) => pageKey(page.url)));
  const seen = new Set<string>();
  const pages: ChoicePage[] = [];
  for (const page of options.listed ?? []) {
    const supported = canAddPage(options.importer, page.url);
    seen.add(pageKey(page.url));
    pages.push({
      url: page.url,
      title: page.title,
      kind: page.kind,
      group: page.group ?? null,
      supported,
      added: recorded.has(pageKey(page.url)),
      checked: supported && tick,
      unlisted: false,
    });
  }
  for (const page of options.recorded) {
    if (seen.has(pageKey(page.url))) continue;
    seen.add(pageKey(page.url));
    const supported = canAddPage(options.importer, page.url);
    pages.push({
      url: page.url,
      title: titleFromAddress(page.url),
      kind: page.mapId ? MAP_KIND : 'page',
      group: null,
      supported,
      added: true,
      checked: supported && tick,
      unlisted: options.listed !== null,
    });
  }
  return {
    key: options.key,
    title: options.title,
    importerId: options.importer.id,
    packId: options.packId,
    source: options.listed ? 'site' : 'recorded',
    note: options.note ?? null,
    pages: mapsFirst(pages),
    queues,
  };
}

/** Pages one go may still open after the ones opened already. */
export const pagesLeft = (opened: number) => Math.max(0, MAX_RUN_ADDRESSES - opened);

/**
 * The choice, with ticks beyond the cap taken off (in order: the first
 * games' pages keep theirs), and how many were taken off.
 */
export function newChoice(
  mode: Choice['mode'],
  games: ChoiceGame[],
  opened: number,
  leftOut: string[] = [],
): Choice {
  let room = pagesLeft(opened);
  let capped = 0;
  const capGame = (game: ChoiceGame): ChoiceGame => (game.queues ? game : capPages(game));
  const capPages = (game: ChoiceGame): ChoiceGame => ({
    ...game,
    pages: game.pages.map((page) => {
      if (!page.checked) return page;
      if (room > 0) {
        room--;
        return page;
      }
      capped++;
      return { ...page, checked: false };
    }),
  });
  const cappedGames = games.map(capGame);
  return { mode, games: cappedGames, opened, capped, leftOut };
}

/** Ticks or unticks one page; pages the importer cannot add stay unticked. */
export function togglePage(choice: Choice, gameKey: string, url: string): Choice {
  return {
    ...choice,
    games: choice.games.map((game) =>
      game.key !== gameKey
        ? game
        : {
            ...game,
            pages: game.pages.map((page) =>
              page.url === url && page.supported ? { ...page, checked: !page.checked } : page,
            ),
          },
    ),
  };
}

/** Ticks every page of one heading, or unticks them all when all are ticked. */
export function toggleGroup(choice: Choice, gameKey: string, group: string | null): Choice {
  return {
    ...choice,
    games: choice.games.map((game) => {
      if (game.key !== gameKey) return game;
      const inGroup = (page: ChoicePage) => page.supported && page.group === group;
      const all = game.pages.filter(inGroup).every((page) => page.checked);
      return {
        ...game,
        pages: game.pages.map((page) => (inGroup(page) ? { ...page, checked: !all } : page)),
      };
    }),
  };
}

/** Ticks a page and every page after it in the list, and unticks those before. */
export function tickFrom(choice: Choice, gameKey: string, url: string): Choice {
  return {
    ...choice,
    games: choice.games.map((game) => {
      if (game.key !== gameKey) return game;
      const from = game.pages.findIndex((page) => page.url === url);
      if (from < 0) return game;
      return {
        ...game,
        pages: game.pages.map((page, i) => ({ ...page, checked: page.supported && i >= from })),
      };
    }),
  };
}

/** A ticked page, as it is opened. */
export interface ChosenPage {
  url: string;
  importerId: string;
  game: string;
  /** The key of its game in the choice. */
  gameKey: string;
  title: string;
  group?: string;
  /** Its game keeps pages beyond one go for later. */
  queues: boolean;
}

/** The ticked pages in the order they are opened: game by game, maps first. */
export function chosenPages(choice: Choice): { url: string; importerId: string; game: string }[] {
  return choice.games.flatMap((game) =>
    game.pages
      .filter((page) => page.checked && page.supported)
      .map((page) => ({ url: page.url, importerId: game.importerId, game: game.title })),
  );
}

/** {@link chosenPages}, each with how it was listed and whether its game keeps pages for later. */
export function chosenToRead(choice: Choice): ChosenPage[] {
  return choice.games.flatMap((game) =>
    game.pages
      .filter((page) => page.checked && page.supported)
      .map((page) => ({
        url: page.url,
        importerId: game.importerId,
        game: game.title,
        gameKey: game.key,
        title: page.title,
        ...(page.group ? { group: page.group } : {}),
        queues: game.queues,
      })),
  );
}

/**
 * The ticked pages split into those this go opens and those kept for
 * later: only pages of games that queue are kept, so a choice that
 * {@link overCap} lets through always fits.
 */
export function splitChosen(choice: Choice): { now: ChosenPage[]; later: ChosenPage[] } {
  const chosen = chosenToRead(choice);
  const left = pagesLeft(choice.opened);
  return { now: chosen.slice(0, left), later: chosen.slice(left) };
}

/** Why the ticked pages cannot be opened in one go, or null when they can. */
export function overCap(choice: Choice): string | null {
  const pages = chosenToRead(choice);
  // Pages beyond one go are kept for later when every game ticked keeps them.
  if (pages.length > 0 && pages.every((page) => page.queues)) return null;
  const chosen = pages.length;
  const left = pagesLeft(choice.opened);
  if (chosen <= left) return null;
  return `That is ${chosen} pages, and this app opens at most ${MAX_RUN_ADDRESSES} pages at a time${
    choice.opened > 0 ? `, ${choice.opened} of them already for reading the lists` : ''
  }. Untick ${chosen - left} and add them afterwards.`;
}

// ---------------------------------------------------------------------------
// A site's list of games

export interface PickGame extends CatalogueGame {
  /** The game's pack is in the maps folder already. */
  added: boolean;
  /** The address is a map page (a game with one map): no game page to read. */
  direct: boolean;
}

export interface GamePick {
  importerId: string;
  importerTitle: string;
  /** The list of games' address. */
  url: string;
  games: PickGame[];
  /** Ids of the ticked games. Nothing is ticked at first. */
  ticked: string[];
  query: string;
  /**
   * When the list was read from the site, if this is the copy the app kept
   * from then; null when it was read just now.
   */
  keptFrom: string | null;
}

/** A site's list of games as the app keeps it between readings. */
export interface KeptCatalogue {
  /** The list of games' address. */
  url: string;
  /** When it was read, as an ISO time. */
  readAt: string;
  games: CatalogueGame[];
}

/**
 * The kept list of games, if `value` (what the app stored) is one this
 * importer can still use: read from its list's address as it is now, with
 * a time, and with games that pass the same check as a list read from the
 * site. Anything else is null, and the list is read again.
 */
export function keptCatalogue(
  value: unknown,
  importer: Pick<AtlasImporter, 'matches' | 'games' | 'catalogue'>,
): KeptCatalogue | null {
  if (!value || typeof value !== 'object') return null;
  const { url, readAt, games } = value as Record<string, unknown>;
  if (typeof url !== 'string' || url !== importer.catalogue?.address) return null;
  if (typeof readAt !== 'string' || Number.isNaN(Date.parse(readAt))) return null;
  const checked = checkCatalogue({ ok: true, games }, url, importer);
  if (!checked.ok || checked.games.length === 0) return null;
  return { url, readAt, games: checked.games };
}

export function newPick(
  importer: Pick<AtlasImporter, 'id' | 'title' | 'matches'>,
  url: string,
  games: readonly CatalogueGame[],
  addedIds: ReadonlySet<string>,
  options: { keptFrom?: string | null; ticked?: readonly string[] } = {},
): GamePick {
  const listed = new Set(games.map((game) => game.id));
  return {
    importerId: importer.id,
    importerTitle: importer.title,
    url,
    games: games.map((game) => ({
      ...game,
      added: addedIds.has(game.id),
      direct: canAddPage(importer, game.address),
    })),
    // Ticks carried over from the list shown before, for games still listed.
    ticked: (options.ticked ?? []).filter((id) => listed.has(id)),
    query: '',
    keptFrom: options.keptFrom ?? null,
  };
}

/** The games whose name, id or other words hold every word of `query`, ignoring case. */
export function filterGames<T extends Pick<PickGame, 'id' | 'name' | 'search'>>(
  games: readonly T[],
  query: string,
): T[] {
  const words = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [...games];
  return games.filter((game) => {
    const text = `${game.name} ${game.id} ${game.search ?? ''}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function toggleGame(pick: GamePick, id: string): GamePick {
  return {
    ...pick,
    ticked: pick.ticked.includes(id)
      ? pick.ticked.filter((ticked) => ticked !== id)
      : [...pick.ticked, id],
  };
}

/** Pages opened for the list of games in this go: one, or none for a kept list. */
export const pickOpened = (pick: Pick<GamePick, 'keptFrom'>) => (pick.keptFrom === null ? 1 : 0);

/**
 * Which ticked games fit in one go, in the list's order: the list of games
 * was one page when it was read just now, and each game needs at least its
 * game page and one more (a game with one map, just that map). The rest
 * are left for later.
 */
export function planPick(pick: GamePick): { games: PickGame[]; leftOut: PickGame[] } {
  let room = pagesLeft(pickOpened(pick));
  const games: PickGame[] = [];
  const leftOut: PickGame[] = [];
  for (const game of pick.games) {
    if (!pick.ticked.includes(game.id)) continue;
    const needs = game.direct ? 1 : 2;
    if (needs <= room) {
      games.push(game);
      room -= needs;
    } else {
      leftOut.push(game);
    }
  }
  return { games, leftOut };
}
