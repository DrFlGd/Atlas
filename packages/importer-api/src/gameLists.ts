/**
 * A map site's list of games and the page of each game, for a map part of a
 * site rules file whose start holds `{game}` and `{map}` (`games` and
 * `gamePage`, see `siteRules.ts` and the guide): one fixed reader for each,
 * run in the app's window and driven by what the file declares, and the
 * plain functions that turn what they hand over into games and maps.
 * Nothing in a file is ever run.
 *
 * - The list of games is the JSON of one element of the list page, read by
 *   the reader of page values ({@link gamesListReader} of `pageValues.ts`),
 *   which copies only the fields the file's data paths name.
 * - A game's page is read by {@link PAGE_LINKS_READER}: the links its
 *   selector finds once the page has loaded, each with its address as the
 *   browser resolves it, its words, and the addresses of the pictures a
 *   selector finds inside it. It changes nothing in the page and makes no
 *   request.
 *
 * Which games and maps are kept is data too: `only` keeps the entries in
 * which a data path, or a link's pictures, give an address on one of the
 * listed hosts.
 */

import { GAMES_LIST_VALUE, PAGE_VALUES_EMPTY_WAIT_MS, pageValuesOf } from './pageValues';
import { piecesIn, readDataPath, selectorProblem } from './sitePatterns';
import type { RulesMapPart } from './siteRules';

/** The mark of what the reader of a game's page hands over (`PageLinks.atlasPageLinks`). */
export const PAGE_LINKS_FORMAT = 1;
/** Links the reader of a game's page takes at most. */
export const MAX_PAGE_LINKS = 1000;
/** Pictures it takes at most inside one link. */
export const MAX_LINK_PICTURES = 4;
/** The longest address it takes, of a link or a picture. */
export const MAX_LINK_ADDRESS_CHARS = 2048;
/** The most characters of a link's words it takes. */
export const MAX_LINK_WORDS = 200;

/** One link of a game's page, as the reader hands it over. */
export interface PageLink {
  /** Its address, as the browser resolves it. */
  href: string;
  /** Its words, or those of the element `name` finds inside it. */
  words: string;
  /** The addresses of the pictures `only.picture` finds inside it. */
  pictures: string[];
}

/** What the reader of a game's page hands over. */
export interface PageLinks {
  atlasPageLinks: typeof PAGE_LINKS_FORMAT;
  links: PageLink[];
}

/** What the reader of a game's page is given: the selectors of the part's `gamePage`. */
export interface PageLinksSpec {
  links: string;
  name?: string;
  picture?: string;
}

/**
 * The reader of a game's page, as the source of a function of one argument
 * (the spec): run in the page, it returns {@link PageLinks}, or null while
 * the page is loading, or has found no link and has not been open for
 * {@link PAGE_VALUES_EMPTY_WAIT_MS} since it loaded. Plain JavaScript,
 * exactly as the page receives it.
 */
export const PAGE_LINKS_READER = String.raw`(spec) => {
  const win = window;
  const doc = win.document;
  if (!doc || doc.readyState === 'loading') return null;
  const clock = win.performance;
  const settled =
    doc.readyState === 'complete' &&
    (!clock || typeof clock.now !== 'function' || clock.now() >= ${PAGE_VALUES_EMPTY_WAIT_MS});
  const words = (el) =>
    String((el && el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, ${MAX_LINK_WORDS});
  const address = (value) =>
    typeof value === 'string' && value.length > 0 && value.length <= ${MAX_LINK_ADDRESS_CHARS} ? value : null;
  const found = Array.from(doc.querySelectorAll(spec.links)).slice(0, ${MAX_PAGE_LINKS});
  const links = [];
  for (const link of found) {
    const href = address(link.href);
    if (!href) continue;
    const named = spec.name ? link.querySelector(spec.name) : null;
    const pictures = [];
    if (spec.picture) {
      for (const picture of Array.from(link.querySelectorAll(spec.picture)).slice(0, ${MAX_LINK_PICTURES})) {
        const src = address(picture.src);
        if (src) pictures.push(src);
      }
    }
    links.push({ href, words: words(named || link), pictures });
  }
  if (links.length === 0 && !settled) return null;
  return { atlasPageLinks: 1, links };
}`;

/** The spec of a part's game page, or null for a part without one, or one whose selectors do not pass the checker. */
export function pageLinksSpec(part: RulesMapPart): PageLinksSpec | null {
  const page = part.gamePage;
  if (!page) return null;
  const selectors = [page.links, page.name, page.only?.picture];
  if (selectors.some((one) => one !== undefined && selectorProblem(one) !== null)) return null;
  return {
    links: page.links,
    ...(page.name ? { name: page.name } : {}),
    ...(page.only?.picture ? { picture: page.only.picture } : {}),
  };
}

/** The window reader of a part's game page: {@link PAGE_LINKS_READER} with its spec, or null. */
export function gamePageReader(part: RulesMapPart): string | null {
  const spec = pageLinksSpec(part);
  if (!spec) return null;
  const text = JSON.stringify(spec).replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e');
  return `() => (${PAGE_LINKS_READER})(${text})`;
}

/** What the reader of a game's page handed over, checked; null when it is not that. */
export function pageLinksOf(value: unknown): PageLinks | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.atlasPageLinks !== PAGE_LINKS_FORMAT || !Array.isArray(record.links)) return null;
  const links: PageLink[] = [];
  for (const one of record.links.slice(0, MAX_PAGE_LINKS) as unknown[]) {
    if (typeof one !== 'object' || one === null) continue;
    const { href, words, pictures } = one as Record<string, unknown>;
    if (typeof href !== 'string' || href.length > MAX_LINK_ADDRESS_CHARS) continue;
    links.push({
      href,
      words:
        typeof words === 'string'
          ? words.replace(/\s+/gu, ' ').trim().slice(0, MAX_LINK_WORDS)
          : '',
      pictures: Array.isArray(pictures)
        ? pictures
            .filter((p): p is string => typeof p === 'string' && p.length <= MAX_LINK_ADDRESS_CHARS)
            .slice(0, MAX_LINK_PICTURES)
        : [],
    });
  }
  return { atlasPageLinks: PAGE_LINKS_FORMAT, links };
}

/** A host without `www.`, of an https address without a name, password or port; null for anything else. */
function hostOf(text: string): string | null {
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return url.hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return null;
  }
}

/** Whether a value is an https address on one of `hosts`. */
const onHosts = (value: unknown, hosts: readonly string[]): boolean => {
  if (typeof value !== 'string') return false;
  const host = hostOf(value);
  return host !== null && hosts.includes(host);
};

/** A value of a piece of an address: letters, digits and a few signs. */
const PIECE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.~%-]{0,99}$/u;

/** A value of the data as text: text, or a number; null for anything else or empty text. */
function textOf(value: unknown, max: number): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/gu, ' ').trim();
  return text ? text.slice(0, max) : null;
}

/** One game of a site's list of games, as read: the value of its `{game}`, and its name. */
export interface ListedGame {
  id: string;
  name: string;
}

/** What a list of games held: its games, and how many entries were left out, by why. */
export interface GamesListRead {
  games: ListedGame[];
  /** Entries `only` left out. */
  notOnly: number;
  /** Entries without an id that can stand for `{game}`, or listed twice. */
  unusable: number;
}

/**
 * The games of a part's list of games (`games`), from what the reader of
 * page values handed over for it: each entry of `games.path` with an id
 * that can stand for `{game}` in an address, kept by `only` when it is
 * given. A plain sentence when it holds no list.
 */
export function readGamesList(
  part: RulesMapPart,
  pageData: unknown,
): GamesListRead | { problem: string } {
  const games = part.games;
  if (!games) return { problem: 'The file describes no list of games.' };
  const values = pageValuesOf(pageData);
  const data = values?.values[GAMES_LIST_VALUE];
  if (data === undefined) {
    return { problem: `The page held no JSON in its element ${games.element}.` };
  }
  const entries = readDataPath(data, games.path);
  if (entries.length === 0) {
    return { problem: `The list of games (games.path, ${games.path}) found nothing in the page.` };
  }
  const read: GamesListRead = { games: [], notOnly: 0, unusable: 0 };
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = textOf(readDataPath(entry, games.id)[0], 100);
    if (!id || !PIECE_VALUE.test(id) || seen.has(id.toLowerCase())) {
      read.unusable++;
      continue;
    }
    const only = games.only;
    if (only?.path && !readDataPath(entry, only.path).some((v) => onHosts(v, only.hosts))) {
      read.notOnly++;
      continue;
    }
    seen.add(id.toLowerCase());
    read.games.push({ id, name: textOf(readDataPath(entry, games.name)[0], 200) ?? id });
  }
  return read;
}

/** One map of a game's page, as read: its map page's address, the value of its `{map}`, and its name. */
export interface ListedMap {
  url: string;
  map: string;
  name: string;
}

/** What a game's page held: its maps, and how many links were left out, by why. */
export interface GamePageRead {
  maps: ListedMap[];
  /** Links `only` left out. */
  notOnly: number;
  /** Links that are no map page of the game on the site's hosts, or listed twice. */
  other: number;
}

/**
 * The maps of a game's page (`gamePage`), from what {@link PAGE_LINKS_READER}
 * handed over: each link whose address is a map page of the part (its
 * start, `{game}` the game's own) on one of `hosts`, kept by `only` when
 * it is given, once each, without its query or fragment. A plain sentence
 * when the page held no links the reader could take.
 */
export function readGamePage(
  part: RulesMapPart,
  pageData: unknown,
  game: string,
  hosts: readonly string[],
): GamePageRead | { problem: string } {
  const page = part.gamePage;
  if (!page) return { problem: 'The file describes no page of a game.' };
  const given = pageLinksOf(pageData);
  if (!given) return { problem: 'What the game’s page gave is not its links.' };
  const read: GamePageRead = { maps: [], notOnly: 0, other: 0 };
  const seen = new Set<string>();
  const start = part.start.split(/[?#]/u)[0]!;
  for (const link of given.links) {
    let url: URL;
    try {
      url = new URL(link.href);
    } catch {
      read.other++;
      continue;
    }
    const host = hostOf(url.href);
    const pieces = host !== null && hosts.includes(host) ? piecesIn(start, url.pathname) : null;
    const map = pieces?.map;
    if (
      !pieces ||
      !map ||
      !PIECE_VALUE.test(map) ||
      pieces.game?.toLowerCase() !== game.toLowerCase()
    ) {
      read.other++;
      continue;
    }
    const address = `${url.origin}${url.pathname}`;
    if (seen.has(address)) continue;
    const only = page.only;
    if (only && !link.pictures.some((picture) => onHosts(picture, only.hosts))) {
      read.notOnly++;
      continue;
    }
    seen.add(address);
    read.maps.push({ url: address, map, name: link.words || map });
  }
  return read;
}
