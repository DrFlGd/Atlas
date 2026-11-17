import { MAP_LINK_ID_MARK, isOwnId, parseId, type Location, type MapLink } from '@atlas/schema';

/**
 * Links in a game's pages that name a location of a map by the id its site
 * gives it (the manifest's `mapLinks`, see `mapLinks.ts` in the schema
 * package): which id a web link names, and which location has that id.
 *
 * **A location's site id.** A location's id is `<game>:loc:<local id>`,
 * and the local id, the part after the id's last `:`, is the id the site
 * gives the location: an importer that reads a map from a site keeps the
 * site's own id there whenever the site gives one that ids allow (letters,
 * digits, `_`, `.` and `-`, starting with a letter or a digit). A link's id
 * is therefore looked up as a local id. An id the site writes with other
 * signs, which an importer had to change to make an id, is not found, and
 * its link stays the web link. Locations a person made (`own.` ids) are
 * never found by a link.
 *
 * The lookup is one table per pack's locations, made the first time a link
 * is looked up in it, so a page with many links costs one pass over the
 * locations, and a game whose pages have no such entry costs nothing.
 */

/** The local id a link's id must be to name a location (see `LOCAL_ID_SOURCE` of the ids). */
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u;

/** The address pattern of an entry as a regular expression, `{id}` caught; one per pattern. */
const patterns = new Map<string, RegExp>();

function patternOf(address: string): RegExp {
  let pattern = patterns.get(address);
  if (!pattern) {
    const trimmed = address.length > 1 ? address.replace(/\/+$/u, '') : address;
    const source = trimmed
      .split(/(\*\*|\*|\{id\})/u)
      .map((part) => {
        if (part === '**') return '.*';
        if (part === '*') return '[^/]*';
        if (part === MAP_LINK_ID_MARK) return '([^/]+)';
        return part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      })
      .join('');
    pattern = new RegExp(`^${source}$`, 'u');
    patterns.set(address, pattern);
  }
  return pattern;
}

const decoded = (text: string): string | null => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/**
 * The ids of the locations a web link names, by the first entry of `links`
 * it fits: its host is one of the entry's (with or without `www.`, `http`
 * or `https`), its whole path matches the entry's address (a `/` at the
 * end ignored, case counting), and the ids are the part of the path at
 * `{id}`, or the value of the entry's `query`. A site may name several
 * locations in one link, with commas between their ids, or end the one id
 * with a comma: each part is an id, in the link's order, an empty part or
 * one that cannot be a location's left out. None when the link fits no
 * entry, or holds no id that can be a location's.
 */
export function mapLinkIds(links: readonly MapLink[], href: string): string[] {
  if (links.length === 0 || !/^https?:\/\//iu.test(href)) return [];
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return [];
  }
  if (url.username || url.password) return [];
  const host = url.hostname.toLowerCase().replace(/^www\./u, '');
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, '') : url.pathname;
  for (const link of links) {
    if (!link.hosts.includes(host)) continue;
    const match = patternOf(link.address).exec(path);
    if (!match) continue;
    const raw =
      link.query === undefined ? decoded(match[1] ?? '') : url.searchParams.get(link.query);
    const ids: string[] = [];
    for (const part of (raw ?? '').split(',')) {
      const id = part.trim();
      if (LOCAL_ID.test(id) && !ids.includes(id)) ids.push(id);
    }
    if (ids.length > 0) return ids;
  }
  return [];
}

/** The id of the first location a web link names (see {@link mapLinkIds}), or null. */
export function mapLinkId(links: readonly MapLink[], href: string): string | null {
  return mapLinkIds(links, href)[0] ?? null;
}

/** The site id of a location: the local id of its id, or null for one a person made. */
export function siteIdOfLocation(locationId: string): string | null {
  if (isOwnId(locationId)) return null;
  return parseId(locationId)?.localId ?? null;
}

const tables = new WeakMap<readonly Location[], ReadonlyMap<string, string>>();

/**
 * The locations of a pack by their site ids (see the top of this file):
 * the first location of each site id. Made once per list of locations.
 */
export function locationsBySiteId(locations: readonly Location[]): ReadonlyMap<string, string> {
  let table = tables.get(locations);
  if (!table) {
    const made = new Map<string, string>();
    for (const location of locations) {
      const siteId = siteIdOfLocation(location.id);
      if (siteId !== null && !made.has(siteId)) made.set(siteId, location.id);
    }
    table = made;
    tables.set(locations, table);
  }
  return table;
}

/** A location a link found: its id, and the game it is in. */
export interface MapLinkTarget {
  gameId: string;
  locationId: string;
}

/**
 * The location a web link of a page names, among the games given in order
 * (the game shown first, then the other games of its title): the first
 * game with a location of that site id; of a link that names several
 * locations, the first of them any game has. Null when the link fits no
 * entry of `links`, or no game has a location it names.
 */
export function mapLinkTarget(
  links: readonly MapLink[],
  href: string,
  games: readonly { gameId: string; locations: readonly Location[] }[],
): MapLinkTarget | null {
  for (const siteId of mapLinkIds(links, href)) {
    for (const game of games) {
      const locationId = locationsBySiteId(game.locations).get(siteId);
      if (locationId) return { gameId: game.gameId, locationId };
    }
  }
  return null;
}
