/**
 * What an importer says about the site of an address before anything is
 * read (see {@link AtlasImporter.siteInfo}), and the choices the person
 * makes for that site, which the app keeps per site:
 *
 * - how its pages are read, among the ways the importer offers for it
 *   ({@link ReadingWay}); the importer's first way until the person chooses;
 * - for a site whose pages may state no licence, what the person answered
 *   for it ({@link SiteLicence}): a known licence they confirmed, what they
 *   filled in (such as permission from the site's owner), or no licence.
 *
 * Nothing here reads a page: an importer answers from the address alone,
 * and the app asks it only to show the choices, never to fetch.
 */

import { NO_LICENCE_RECORDED } from '@atlas/schema';
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
  /**
   * Optional: the hosts besides the site's own that its pages load their
   * files from (its engine's file host, say), each a lowercase host name,
   * at most {@link MAX_FILE_HOSTS}. A style sheet that a page read in a
   * window loaded from one of them, which the page cannot hand over, may be
   * fetched by an app that downloads and keeps the site's style sheets
   * (see `styles.ts`), with the rules of pages it fetches; one on any other
   * host is not. An app that does not know it leaves it out.
   */
  fileHosts?: string[];
  /**
   * Optional: the pause between two pages of the site, in seconds, as the
   * site rules file it is read by sets it (`reading.pause`, see
   * `siteRules.ts`), from {@link MIN_SITE_PAUSE} to {@link MAX_SITE_PAUSE}.
   * The app waits at least this long between two pages of a session of the
   * site, and never less than its own pause: a file can make it slower,
   * never faster. An app that does not know it leaves it out.
   */
  pause?: number;
  /**
   * Optional: the name of the site rules file the importer reads the site
   * by (`<site id>.atlas-site.json`, or a reader's defaults), for the
   * person to see where its ways, notice and licence come from.
   */
  rulesFile?: string;
  /**
   * Optional: the answer for the site's licence that its site rules file
   * gives (a known licence, words filled in, or none). The importer uses
   * it for a page that states no licence while the person has not answered
   * for the site themselves, and the app shows it on the site's screen as
   * coming from that file. An answer the person gives wins over it.
   */
  rulesLicence?: RulesLicence;
}

/** A licence answer as a site rules file gives it: a {@link SiteLicence} without a time. */
export type RulesLicence =
  | Omit<ConfirmedLicence, 'confirmedAt'>
  | Omit<FilledInLicence, 'confirmedAt'>
  | Omit<NoLicence, 'confirmedAt'>;

export const MIN_SITE_PAUSE = 1;
export const MAX_SITE_PAUSE = 60;

export const MAX_SITE_KEY_CHARS = 200;
export const MAX_NOTICE_CHARS = 500;
export const MAX_FILE_HOSTS = 20;
const SITE_KEY = /^[a-z0-9][a-z0-9.:/_-]*$/;
/** A host name: lowercase labels of letters, digits and inner hyphens, with at least one dot. */
const HOST_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * A licence the person confirmed for a site whose pages state none: one of
 * {@link CONFIRMABLE_LICENCES}. Apps 0.12.0 and 0.13.0 kept it without
 * `basis`, and an answer without one is still this.
 */
export interface ConfirmedLicence {
  basis?: 'confirmed';
  /** As {@link CONFIRMABLE_LICENCES} names it, such as `CC BY-SA 4.0`. */
  name: string;
  /** The address of its deed. */
  url: string;
  /** When the person confirmed it (ISO time). */
  confirmedAt: string;
}

/**
 * What the person filled in for a site whose pages state no licence, such
 * as permission they were given by the site's owner. Pages read under it
 * are kept for the person's own use.
 */
export interface FilledInLicence {
  basis: 'permission';
  /**
   * The words to show under each page: a licence's name or a sentence, such
   * as "Permission from the site's owner for personal use". 1 to
   * {@link MAX_LICENCE_WORDS} characters.
   */
  name: string;
  /** Optional: the address where its terms can be read, `https` only. */
  url?: string;
  /** Optional: who gave it, at most {@link MAX_GIVEN_BY} characters. */
  givenBy?: string;
  /** Optional: when it was given, a date such as `2026-11-16`. */
  givenOn?: string;
  /** Optional: the person's own note, at most {@link MAX_LICENCE_NOTE} characters. */
  note?: string;
  /** When the person answered (ISO time). */
  confirmedAt: string;
}

/**
 * No licence recorded for a site whose pages state none: nothing is said
 * about permission, and its pages are kept for the person's own use. Its
 * name is always {@link NO_LICENCE_RECORDED}.
 */
export interface NoLicence {
  basis: 'none';
  name: string;
  /** When the person answered (ISO time). */
  confirmedAt: string;
}

/**
 * What the person answered for a site whose pages state no licence, kept
 * per site (see `ImportFailure.askLicence` of the contract). A page that states a
 * licence is read under it whatever the answer.
 */
export type SiteLicence = ConfirmedLicence | FilledInLicence | NoLicence;

export { NO_LICENCE_RECORDED };

export const MAX_LICENCE_WORDS = 200;
export const MAX_GIVEN_BY = 200;
export const MAX_LICENCE_NOTE = 1000;
const MAX_TERMS_ADDRESS = 2048;

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

const isTime = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));

/** Whether `value` is a licence the person may have confirmed: one of {@link CONFIRMABLE_LICENCES}, with a time. */
export function isConfirmedLicence(value: unknown): value is ConfirmedLicence {
  if (typeof value !== 'object' || value === null) return false;
  const { basis, name, url, confirmedAt } = value as Record<string, unknown>;
  return (
    (basis === undefined || basis === 'confirmed') &&
    isTime(confirmedAt) &&
    CONFIRMABLE_LICENCES.some((licence) => licence.name === name && licence.url === url)
  );
}

/** Whether `text` is an `https` address with no spaces and no name or password in it. */
export function isTermsAddress(text: string): boolean {
  if (text.length > MAX_TERMS_ADDRESS || !/^https:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i.test(text)) {
    return false;
  }
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Whether `text` is a date such as `2026-11-16` that is in the calendar. */
function isDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const time = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(text);
}

/** Text trimmed, when it is text of 1 to `max` characters; null for none; undefined when it is not usable. */
function trimmed(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '') return null;
  return text.length <= max ? text : undefined;
}

/**
 * What the person answered for a site, checked, with only its own fields:
 * a confirmed licence of {@link CONFIRMABLE_LICENCES} (with or without
 * `basis`, as older apps kept it), a filled in licence with its words and
 * the optional parts that are usable (an optional part that is not, such
 * as an address that is not `https`, makes the whole answer unusable), or
 * no licence. Null for anything else.
 */
export function siteLicenceOf(value: unknown): SiteLicence | null {
  if (isConfirmedLicence(value)) {
    return { name: value.name, url: value.url, confirmedAt: value.confirmedAt };
  }
  if (typeof value !== 'object' || value === null) return null;
  const answer = value as Record<string, unknown>;
  if (!isTime(answer.confirmedAt)) return null;
  const confirmedAt = answer.confirmedAt;
  if (answer.basis === 'none') return { basis: 'none', name: NO_LICENCE_RECORDED, confirmedAt };
  if (answer.basis !== 'permission') return null;
  const name = trimmed(answer.name, MAX_LICENCE_WORDS);
  const url = trimmed(answer.url, MAX_TERMS_ADDRESS);
  const givenBy = trimmed(answer.givenBy, MAX_GIVEN_BY);
  const givenOn = trimmed(answer.givenOn, 10);
  const note = trimmed(answer.note, MAX_LICENCE_NOTE);
  if (!name || url === undefined || givenBy === undefined || note === undefined) return null;
  if (givenOn === undefined || (givenOn !== null && !isDate(givenOn))) return null;
  if (url !== null && !isTermsAddress(url)) return null;
  return {
    basis: 'permission',
    name,
    ...(url ? { url } : {}),
    ...(givenBy ? { givenBy } : {}),
    ...(givenOn ? { givenOn } : {}),
    ...(note ? { note } : {}),
    confirmedAt,
  };
}

/** Whether pages read under an answer are kept for the person's own use: filled in, or none. */
export const forPersonalUse = (licence: SiteLicence): boolean =>
  licence.basis === 'permission' || licence.basis === 'none';

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
function canRead(
  importer: Pick<AtlasImporter, 'fetch' | 'pageReader' | 'browseReader'>,
  way: ReadingWay,
): boolean {
  switch (way) {
    case 'fetch':
      return importer.fetch !== undefined;
    case 'window':
      return importer.pageReader !== undefined;
    case 'browse':
      return importer.browseReader !== undefined;
  }
}

/**
 * What the importer says about the site of `url`, checked: a usable key,
 * the ways it offers that it can read in (it has `fetch` for `fetch`, a
 * `pageReader` for `window`, a `browseReader` for `browse`), each once, its notice trimmed,
 * its file hosts that are host names, each once, and what its site rules
 * file gives (a pause in its bounds, the file's name, a usable licence
 * answer); anything of those that is not usable is left out. Without
 * {@link AtlasImporter.siteInfo}, or when it gives nothing usable, the site
 * is its host and has one way, as before: `window` for a page that
 * `fetch.inWindow` opens in a window or an importer without `fetch`, else
 * `fetch`. Must not throw; an importer that throws counts as saying nothing.
 */
export function siteInfoOf(
  importer: Pick<AtlasImporter, 'siteInfo' | 'fetch' | 'pageReader' | 'browseReader'>,
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
  const { key, ways, notice, fileHosts, pause, rulesFile, rulesLicence } = given as Record<
    string,
    unknown
  >;
  if (typeof key !== 'string' || key.length > MAX_SITE_KEY_CHARS || !SITE_KEY.test(key)) {
    return fallback;
  }
  const offered: ReadingWay[] = [];
  for (const way of Array.isArray(ways) ? (ways as unknown[]) : []) {
    if (isReadingWay(way) && !offered.includes(way) && canRead(importer, way)) offered.push(way);
  }
  if (offered.length === 0) return fallback;
  const text = typeof notice === 'string' ? notice.trim() : '';
  const hosts: string[] = [];
  for (const host of Array.isArray(fileHosts) ? (fileHosts as unknown[]) : []) {
    if (hosts.length >= MAX_FILE_HOSTS) break;
    if (typeof host === 'string' && HOST_NAME.test(host) && !hosts.includes(host)) hosts.push(host);
  }
  const file =
    typeof rulesFile === 'string' && /^[a-z0-9][a-z0-9.-]{0,79}$/u.test(rulesFile)
      ? rulesFile
      : null;
  const answer = rulesLicenceOf(rulesLicence);
  return {
    key,
    ways: offered,
    ...(text ? { notice: text.slice(0, MAX_NOTICE_CHARS) } : {}),
    ...(hosts.length > 0 ? { fileHosts: hosts } : {}),
    ...(typeof pause === 'number' && pause >= MIN_SITE_PAUSE && pause <= MAX_SITE_PAUSE
      ? { pause }
      : {}),
    ...(file ? { rulesFile: file } : {}),
    ...(answer ? { rulesLicence: answer } : {}),
  };
}

/**
 * A licence answer a site rules file gives, checked as the person's answer
 * is ({@link siteLicenceOf}), without a time; null for anything else.
 */
export function rulesLicenceOf(value: unknown): RulesLicence | null {
  if (typeof value !== 'object' || value === null) return null;
  const answer = siteLicenceOf({ ...value, confirmedAt: '2000-01-01T00:00:00.000Z' });
  if (!answer) return null;
  const { confirmedAt: _, ...rest } = answer;
  return rest;
}

/** The way a site is read: the one the person chose when the importer still offers it, else the importer's first. */
export function readingWayOf(info: SiteInfo, chosen?: unknown): ReadingWay {
  return isReadingWay(chosen) && info.ways.includes(chosen) ? chosen : info.ways[0]!;
}
