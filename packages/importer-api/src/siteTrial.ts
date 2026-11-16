/**
 * Trying a site rules file on one saved page ("Try on a saved page" under
 * Settings, "Sites"), and what a file widens against the files an importer
 * comes with. Both are answered by the importer that reads the file
 * (`ImporterSites.tryPage` and `ImporterSites.widens` of the contract) and
 * checked here before the app shows them: plain data in bounds, nothing
 * else. Nothing is kept and nothing is fetched.
 */

import type { SiteFile } from './siteRules';

/** A page saved by the person and the file to try on it. */
export interface SiteTrialRequest {
  /** The file, checked (a site file with a part read by `rules`). */
  rules: SiteFile;
  /** The page's address: its canonical link, or the one the person gave. */
  url: string;
  /** The page's HTML, as saved. */
  html: string;
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
  type?: 'wiki' | 'guide';
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
  /** What went wrong, in plain sentences: each selector that matched nothing, why nothing was read. */
  problems: string[];
}

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
  const type = answer.type === 'wiki' || answer.type === 'guide' ? answer.type : undefined;
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
    problems: list(answer.problems)
      .flatMap((problem) => words(problem, 500) ?? [])
      .slice(0, MAX_PROBLEMS),
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
