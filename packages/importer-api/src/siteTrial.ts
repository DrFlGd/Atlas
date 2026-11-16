/**
 * Trying a site rules file on one saved page ("Try on a saved page" under
 * Settings, "Sites"), and what a file widens against the files an importer
 * comes with. Both are answered by the importer that reads the file
 * (`ImporterSites.tryPage` and `ImporterSites.widens` of the contract) and
 * checked here before the app shows them: plain data in bounds, nothing
 * else. Nothing is kept and nothing is fetched.
 */

import type { SiteFile } from './siteRules';

/**
 * A page saved by the person and the file to try on it, or, for a file
 * with a map part read by `rules`, a data file the person saved: the map's
 * data as the site serves it (`data.from: "file"`).
 */
export interface SiteTrialRequest {
  /** The file, checked (a site file with a part read by `rules`). */
  rules: SiteFile;
  /**
   * The page's address: its canonical link, or the one the person gave.
   * For a saved data file, the start of the file's first map part that
   * reads its data from a file, on the site's first host.
   */
  url: string;
  /** The page's HTML, as saved; empty for a saved data file. */
  html: string;
  /**
   * Optional: the text of a data file the person saved (`.json`), to try
   * the file's map part on in place of a page. An importer that does not
   * know it answers as for an empty page.
   */
  data?: string;
}

/** One entry of the contents a page shows. */
export interface SiteTrialEntry {
  title: string;
  group?: string;
}

/** What the reader understood of one saved page. */
export interface SiteTrial {
  /** The part that read the page (its index in `parts`); null when none did. */
  part: number | null;
  /** That part's type. */
  type?: 'wiki' | 'guide' | 'map';
  /** The page's title. */
  title?: string;
  /** The game's name, as the file or the page gives it. */
  game?: string;
  /** The first words of the text. */
  text?: string;
  headings: number;
  pictures: number;
  /** Pictures that have an address of their full-size file. */
  fullPictures: number;
  tables: number;
  /** Chapters a one-page guide is split into; 0 when it is not split. */
  chapters: number;
  /** The contents the page shows: how many entries, its groups, and the first entries. */
  contents?: { count: number; groups: string[]; first: SiteTrialEntry[] };
  /** The address of the next page, for a guide. */
  next?: string;
  /** The licence that would be recorded, in words. */
  licence?: string;
  /** The credit line the page gives (its author and date). */
  credit?: string;
  /** For a map part: what the reader found in the data (see {@link SiteMapTrial}). */
  map?: SiteMapTrial;
  /**
   * What went wrong, in plain sentences: each selector or data path that
   * matched nothing, why nothing was read.
   */
  problems: string[];
}

/** One map of a map part's data, as the reader found it. */
export interface SiteMapTrialMap {
  name: string;
  /** Its picture's size in pixels at its highest zoom; 0 when not found. */
  width: number;
  height: number;
  /** The group it is a floor of, and its floor's name, for a map that is one floor of several. */
  group?: string;
  floor?: string;
  /** Its locations, and of those how many have a description, a link to a page, a picture. */
  locations: number;
  described: number;
  linked: number;
  pictured: number;
  /** Its locations whose position falls outside its picture. */
  outside: number;
  /** The address of one of its images, as the file's template makes it. */
  image?: string;
}

/** One location as the reader found it, with its position in pixels of its map's picture. */
export interface SiteMapTrialLocation {
  name: string;
  map: string;
  type: string;
  x: number;
  y: number;
}

/** What the reader found in a map part's data (see {@link SiteTrial.map}). */
export interface SiteMapTrial {
  /** Every map found, at most {@link MAX_TRIAL_MAPS} of them listed. */
  maps: { count: number; listed: SiteMapTrialMap[] };
  /** The types: how many, and the names of the first. */
  types: { count: number; first: string[] };
  /** The locations: how many, and the first few. */
  locations: { count: number; first: SiteMapTrialLocation[] };
}

/** Maps of a trial listed at most. */
export const MAX_TRIAL_MAPS = 40;

export const MAX_TRIAL_TEXT = 600;
const MAX_WORDS = 300;
const MAX_LIST = 20;
const MAX_PROBLEMS = 40;

const words = (value: unknown, max = MAX_WORDS): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? Math.min(value, 1_000_000)
    : 0;

/** An importer's answer to a trial, in bounds; null when it is not one. */
export function siteTrialOf(value: unknown): SiteTrial | null {
  if (typeof value !== 'object' || value === null) return null;
  const answer = value as Record<string, unknown>;
  const part =
    typeof answer.part === 'number' && Number.isInteger(answer.part) && answer.part >= 0
      ? answer.part
      : null;
  const type =
    answer.type === 'wiki' || answer.type === 'guide' || answer.type === 'map'
      ? answer.type
      : undefined;
  const list = (entries: unknown) => (Array.isArray(entries) ? (entries as unknown[]) : []);
  const given: unknown = answer.contents;
  const contentsValue =
    typeof given === 'object' && given !== null && !Array.isArray(given)
      ? (given as Record<string, unknown>)
      : null;
  const contents = contentsValue
    ? {
        count: count(contentsValue.count),
        groups: list(contentsValue.groups)
          .flatMap((group) => words(group, 200) ?? [])
          .slice(0, MAX_LIST),
        first: list(contentsValue.first)
          .flatMap((entry) => {
            const { title, group } = (entry ?? {}) as Record<string, unknown>;
            const name = words(title, 200);
            const under = words(group, 200);
            return name ? [{ title: name, ...(under ? { group: under } : {}) }] : [];
          })
          .slice(0, MAX_LIST),
      }
    : undefined;
  const optional = (key: string, max?: number) => {
    const text = words(answer[key], max);
    return text ? { [key]: text } : {};
  };
  const next =
    typeof answer.next === 'string' && /^https:\/\/\S+$/u.test(answer.next)
      ? { next: answer.next.slice(0, 2048) }
      : {};
  return {
    part,
    ...(type ? { type } : {}),
    ...optional('title', 200),
    ...optional('game', 200),
    ...optional('text', MAX_TRIAL_TEXT),
    headings: count(answer.headings),
    pictures: count(answer.pictures),
    fullPictures: count(answer.fullPictures),
    tables: count(answer.tables),
    chapters: count(answer.chapters),
    ...(contents ? { contents } : {}),
    ...next,
    ...optional('licence'),
    ...optional('credit'),
    ...mapTrialOf(answer.map),
    problems: list(answer.problems)
      .flatMap((problem) => words(problem, 500) ?? [])
      .slice(0, MAX_PROBLEMS),
  };
}

/** A whole number in bounds, else 0. */
const pixelCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), 100_000_000)
    : 0;

/** A position, rounded to tenths of a pixel; 0 for anything else. */
const position = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(-1e9, Math.min(1e9, value)) * 10) / 10
    : 0;

/** An importer's answer of what it found in a map part's data, in bounds; nothing for none. */
function mapTrialOf(value: unknown): { map?: SiteMapTrial } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const given = value as Record<string, unknown>;
  const block = (key: string) => {
    const inner = given[key];
    return typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? (inner as Record<string, unknown>)
      : {};
  };
  const list = (entries: unknown, max: number) =>
    (Array.isArray(entries) ? (entries as unknown[]) : []).slice(0, max);
  const maps = block('maps');
  const types = block('types');
  const locations = block('locations');
  const image = (text: unknown) =>
    typeof text === 'string' && /^https:\/\/\S+$/u.test(text) ? { image: text.slice(0, 2048) } : {};
  return {
    map: {
      maps: {
        count: count(maps.count),
        listed: list(maps.listed, MAX_TRIAL_MAPS).flatMap((entry): SiteMapTrialMap[] => {
          const map = (entry ?? {}) as Record<string, unknown>;
          const name = words(map.name, 200);
          if (!name) return [];
          const group = words(map.group, 200);
          const floor = words(map.floor, 200);
          return [
            {
              name,
              width: pixelCount(map.width),
              height: pixelCount(map.height),
              ...(group ? { group } : {}),
              ...(floor ? { floor } : {}),
              locations: count(map.locations),
              described: count(map.described),
              linked: count(map.linked),
              pictured: count(map.pictured),
              outside: count(map.outside),
              ...image(map.image),
            },
          ];
        }),
      },
      types: {
        count: count(types.count),
        first: list(types.first, MAX_LIST).flatMap((name) => words(name, 200) ?? []),
      },
      locations: {
        count: count(locations.count),
        first: list(locations.first, MAX_LIST).flatMap((entry): SiteMapTrialLocation[] => {
          const location = (entry ?? {}) as Record<string, unknown>;
          const name = words(location.name, 200);
          const map = words(location.map, 200);
          const type = words(location.type, 200);
          if (!name || !map || !type) return [];
          return [{ name, map, type, x: position(location.x), y: position(location.y) }];
        }),
      },
    },
  };
}

/**
 * What a file of the person's widens against the files an importer comes
 * with: a way it adds for a host, or a refusal it overrides. The person
 * sees each before they switch the file on.
 */
export interface SiteRulesWidening {
  /** The field of the file that widens, as `checkSiteRules` names fields. */
  field: string;
  /** What it widens, in plain words, such as "adds By itself for wiki.example.org". */
  message: string;
}
