/**
 * What an importer says about the site of an address before anything is
 * read (see {@link AtlasImporter.siteInfo}), and the choices the person
 * makes for that site, which the app keeps per site:
 *
 * - how its pages are read, among the ways the importer offers for it
 *   ({@link ReadingWay}); the importer's first way until the person chooses;
 * - for a site whose pages may state no licence, the Creative Commons
 *   licence the person confirmed for it ({@link ConfirmedLicence}).
 *
 * Nothing here reads a page: an importer answers from the address alone,
 * and the app asks it only to show the choices, never to fetch.
 */

import { isReadingWay, readsInWindow, type ReadingWay } from './fetching';
import type { AtlasImporter } from './index';

/** What an importer says about the site of an address (see {@link AtlasImporter.siteInfo}). */
export interface SiteInfo {
  /**
   * The site's key, the same for every address of it: the app keeps the
   * person's choices for the site under it. Lowercase letters, digits and
   * `.`, `-`, `_`, `/`, `:`, at most {@link MAX_SITE_KEY_CHARS} characters,
   * such as `wiki.example.org` or `wiki.example.org/de`.
   */
  key: string;
  /**
   * The ways the site's pages can be read, each once, the importer's
   * default first. The app offers the others to choose from and never
   * switches by itself: a way the person chose stays until they choose
   * another.
   */
  ways: ReadingWay[];
  /**
   * Optional: one or two plain sentences about reading this site, which
   * the app shows where the person adds it and on its screen, such as what
   * the site's terms say. At most {@link MAX_NOTICE_CHARS} characters.
   */
  notice?: string;
}

export const MAX_SITE_KEY_CHARS = 200;
export const MAX_NOTICE_CHARS = 500;
const SITE_KEY = /^[a-z0-9][a-z0-9.:/_-]*$/;

/** A Creative Commons licence the person confirmed for a site whose pages state none. */
export interface ConfirmedLicence {
  /** As {@link CONFIRMABLE_LICENCES} names it, such as `CC BY-SA 4.0`. */
  name: string;
  /** The address of its deed. */
  url: string;
  /** When the person confirmed it (ISO time). */
  confirmedAt: string;
}

/**
 * The licences the app offers the person to confirm for a site, in the
 * order shown: the Creative Commons licences wikis are commonly under.
 */
export const CONFIRMABLE_LICENCES: readonly { name: string; url: string }[] = [
  { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  { name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/' },
  { name: 'CC BY-NC-SA 4.0', url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' },
  { name: 'CC BY-NC-SA 3.0', url: 'https://creativecommons.org/licenses/by-nc-sa/3.0/' },
  { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
  { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
  { name: 'CC BY-NC 4.0', url: 'https://creativecommons.org/licenses/by-nc/4.0/' },
  { name: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
];

/** Whether `value` is a licence the person may have confirmed: one of {@link CONFIRMABLE_LICENCES}, with a time. */
export function isConfirmedLicence(value: unknown): value is ConfirmedLicence {
  if (typeof value !== 'object' || value === null) return false;
  const { name, url, confirmedAt } = value as Record<string, unknown>;
  return (
    typeof confirmedAt === 'string' &&
    confirmedAt.length <= 40 &&
    !Number.isNaN(Date.parse(confirmedAt)) &&
    CONFIRMABLE_LICENCES.some((licence) => licence.name === name && licence.url === url)
  );
}

/** The site of an address as the app keys it when the importer says nothing: its host, without `www.`. */
function hostKey(url: string): string {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return (host.startsWith('www.') ? host.slice(4) : host) || 'site';
  } catch {
    return 'site';
  }
}

/** Whether the importer can read a page the way `way` says. */
function canRead(importer: Pick<AtlasImporter, 'fetch' | 'pageReader'>, way: ReadingWay): boolean {
  return way === 'fetch' ? importer.fetch !== undefined : importer.pageReader !== undefined;
}

/**
 * What the importer says about the site of `url`, checked: a usable key,
 * the ways it offers that it can read in (it has `fetch` for `fetch`, a
 * `pageReader` for `window`), each once, and its notice trimmed. Without
 * {@link AtlasImporter.siteInfo}, or when it gives nothing usable, the site
 * is its host and has one way, as before: `window` for a page that
 * `fetch.inWindow` opens in a window or an importer without `fetch`, else
 * `fetch`. Must not throw; an importer that throws counts as saying nothing.
 */
export function siteInfoOf(
  importer: Pick<AtlasImporter, 'siteInfo' | 'fetch' | 'pageReader'>,
  url: string,
): SiteInfo {
  const fallback: SiteInfo = {
    key: hostKey(url),
    ways: [importer.fetch && !readsInWindow(importer.fetch, url) ? 'fetch' : 'window'],
  };
  let given: unknown;
  try {
    given = importer.siteInfo ? importer.siteInfo(url.trim()) : null;
  } catch {
    given = null;
  }
  if (typeof given !== 'object' || given === null) return fallback;
  const { key, ways, notice } = given as Record<string, unknown>;
  if (typeof key !== 'string' || key.length > MAX_SITE_KEY_CHARS || !SITE_KEY.test(key)) {
    return fallback;
  }
  const offered: ReadingWay[] = [];
  for (const way of Array.isArray(ways) ? (ways as unknown[]) : []) {
    if (isReadingWay(way) && !offered.includes(way) && canRead(importer, way)) offered.push(way);
  }
  if (offered.length === 0) return fallback;
  const text = typeof notice === 'string' ? notice.trim() : '';
  return {
    key,
    ways: offered,
    ...(text ? { notice: text.slice(0, MAX_NOTICE_CHARS) } : {}),
  };
}

/** The way a site is read: the one the person chose when the importer still offers it, else the importer's first. */
export function readingWayOf(info: SiteInfo, chosen?: unknown): ReadingWay {
  return isReadingWay(chosen) && info.ways.includes(chosen) ? chosen : info.ways[0]!;
}
