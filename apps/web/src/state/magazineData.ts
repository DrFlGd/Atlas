import type { GameGroup } from '@atlas/schema';
import { z } from 'zod';
import type { ListedPack } from '../desktop';
import {
  MAX_GUIDEBOOK_BYTES,
  MAX_GUIDEBOOK_PAGES,
  searchGuidebooks,
  titleKey,
  type Guidebook,
  type GuidebookHit,
  type GuidebookType,
} from './guidebookData';

/**
 * Magazines: the issues of a magazine title, each a PDF or a CBZ, in a
 * pack of their own that another app writes (version 10 of the pack file
 * format, see `crates/atlas-pack`). This module holds what needs no page:
 * reading a pack's list (`magazines.json`), which issues cover a game and
 * on which pages, searching those pages, and dates in words. Each issue is
 * a {@link Guidebook} with what is known of it as an issue, so the
 * guidebook reader reads it as it is. `magazines.ts` keeps the state.
 *
 * Everything read from a pack is untrusted: sizes, counts and names are
 * bounded, and an entry that does not fit is left out.
 */

/** The most issues one pack lists, as the pack format says. */
export const MAX_ISSUES = 1000;
/** The longest title of a magazine, an issue or a game, in characters. */
const MAX_TITLE = 200;
/** The longest name of a publisher or a system, in characters. */
const MAX_NAME = 100;
/** The most games one issue says it covers. */
const MAX_ISSUE_GAMES = 200;
/** The most runs of pages of one game in one issue. */
const MAX_RUNS = 50;
/** The largest list of issues (`magazines.json`) read. */
const MAX_LIST_BYTES = 8 * 1024 * 1024;

/** A game an issue covers, and its runs of pages, each `[first, last]`. */
export interface IssueGame {
  title: string;
  system: string | null;
  gameId: string | null;
  pages: readonly (readonly [number, number])[];
}

/** What is known of an issue as an issue of a magazine. */
export interface IssueFacts {
  /** The magazine's title. */
  magazine: string;
  publisher: string | null;
  /** `YYYY-MM` or `YYYY-MM-DD`, or null. */
  date: string | null;
  number: number | null;
  /** Where its cover picture is, when the pack has one. */
  coverUrl: string | null;
  games: readonly IssueGame[];
}

/** An issue: a guidebook to the reader, with what is known of it as an issue. */
export type Issue = Guidebook & { issue: IssueFacts };

/** One magazine title on this device: its pack's issues, newest first. */
export interface Magazine {
  packId: string;
  title: string;
  publisher: string | null;
  issues: readonly Issue[];
}

// ---------------------------------------------------------------------------
// The list of a pack's issues

const NAME = /^magazines\/([a-z0-9][a-z0-9_-]{0,79})\.(pdf|cbz)$/;
const DATE = /^(\d{4})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const text = (max: number) => z.string().trim().min(1).max(max);

const gameSchema = z.object({
  title: text(MAX_TITLE),
  system: text(MAX_NAME).nullish(),
  gameId: z.string().regex(ID).nullish(),
  pages: z
    .array(z.tuple([z.int().min(1), z.int().min(1)]))
    .min(1)
    .max(MAX_RUNS),
});

const issueSchema = z.object({
  file: z.string().regex(NAME),
  title: text(MAX_TITLE),
  date: z.string().regex(DATE).nullish(),
  number: z.int().min(0).nullish(),
  pages: z.int().min(1).max(MAX_GUIDEBOOK_PAGES),
  bytes: z.int().min(1).max(MAX_GUIDEBOOK_BYTES),
  text: z.string().nullish(),
  cover: z.string().nullish(),
  games: z.array(z.unknown()).max(MAX_ISSUE_GAMES).nullish(),
});

const listSchema = z.object({
  format: z.literal('atlas-magazines'),
  version: z.int().min(1),
  magazine: z.object({ title: text(MAX_TITLE), publisher: text(MAX_NAME).nullish() }),
  issues: z.array(z.unknown()).max(MAX_ISSUES),
});

/**
 * The magazine a pack's `magazines.json` holds the issues of, from its
 * text: an issue that does not fit (a name outside `magazines/`, a type
 * other than PDF and CBZ, a title, date, pages or size out of bounds, a
 * text or cover file of another name) is left out, one listed twice is
 * taken once, and so is a game an issue names whose pages are not in the
 * issue. Issues are newest first: by date, then number, then title.
 * Throws a sentence when the list itself cannot be read.
 */
export function parseMagazineList(
  textOfList: string,
  pack: Pick<ListedPack, 'id' | 'url'>,
): Magazine {
  const unreadable = 'The list of this magazine’s issues cannot be read.';
  if (textOfList.length > MAX_LIST_BYTES) throw new Error('The list of issues is too large.');
  let raw: unknown;
  try {
    raw = JSON.parse(textOfList);
  } catch {
    throw new Error(unreadable);
  }
  const list = listSchema.safeParse(raw);
  if (!list.success) throw new Error(unreadable);
  const base = pack.url.endsWith('/') ? pack.url : `${pack.url}/`;
  const magazine = list.data.magazine;
  const seen = new Set<string>();
  const issues: Issue[] = [];
  for (const item of list.data.issues) {
    const parsed = issueSchema.safeParse(item);
    if (!parsed.success) continue;
    const entry = parsed.data;
    const [, stem, type] = NAME.exec(entry.file) ?? [];
    if (!stem || seen.has(stem)) continue;
    if (entry.text && entry.text !== `magazines/${stem}.text.json`) continue;
    if (entry.cover && entry.cover !== `magazines/${stem}.cover.jpg`) continue;
    seen.add(stem);
    const games: IssueGame[] = [];
    for (const game of entry.games ?? []) {
      const read = gameSchema.safeParse(game);
      if (!read.success) continue;
      const runs = read.data.pages.filter(([first, last]) => first <= last && last <= entry.pages);
      if (runs.length === 0) continue;
      games.push({
        title: read.data.title,
        system: read.data.system ?? null,
        gameId: read.data.gameId ?? null,
        pages: runs,
      });
    }
    issues.push({
      key: `${pack.id}/${entry.file}`,
      packId: pack.id,
      file: entry.file,
      url: base + entry.file,
      title: entry.title,
      pages: entry.pages,
      bytes: entry.bytes,
      type: type as GuidebookType,
      textUrl: entry.text ? base + entry.text : null,
      // Atlas never changes a pack of magazines.
      byAtlas: false,
      issue: {
        magazine: magazine.title,
        publisher: magazine.publisher ?? null,
        date: entry.date ?? null,
        number: entry.number ?? null,
        coverUrl: entry.cover ? base + entry.cover : null,
        games,
      },
    });
  }
  issues.sort(newestFirst);
  return {
    packId: pack.id,
    title: magazine.title,
    publisher: magazine.publisher ?? null,
    issues,
  };
}

/** Issues newest first: by date (one without comes last), then number, then title. */
export function newestFirst(a: Issue, b: Issue): number {
  const dateA = a.issue.date ?? '';
  const dateB = b.issue.date ?? '';
  if (dateA !== dateB) return dateA < dateB ? 1 : -1;
  const numberA = a.issue.number ?? -1;
  const numberB = b.issue.number ?? -1;
  if (numberA !== numberB) return numberB - numberA;
  return a.title.localeCompare(b.title, undefined, { numeric: true });
}

/** Whether a guidebook is an issue of a magazine. */
export function isIssue(guidebook: Guidebook): guidebook is Issue {
  return (guidebook as Partial<Issue>).issue !== undefined;
}

// ---------------------------------------------------------------------------
// Which issues cover a game

/** A game as the magazines are matched to it. */
type GameOnDevice = Pick<ListedPack, 'id' | 'title'> &
  Partial<Pick<ListedPack, 'gameTitle' | 'system' | 'guidebooks' | 'magazines'>>;

/** An issue that covers a game, and the pages about it. */
export interface Coverage {
  issue: Issue;
  /** The runs of pages about the game, in order, joined where they meet. */
  pages: readonly (readonly [number, number])[];
}

/**
 * The games of this device an issue's game is, by their ids. With a game
 * id: the game of that id and every game the person put under one title
 * with it; when no game here has that id, as without one. Without: every
 * game one of whose titles (its own, the title its pack file shows it
 * under, the title the person put it under) is the issue's game's title
 * (see {@link titleKey}), leaving out a game for another system when both
 * name theirs.
 */
export function gamesOfIssueGame(
  game: IssueGame,
  games: readonly GameOnDevice[],
  groups: readonly GameGroup[],
): string[] {
  const groupOf = new Map<string, GameGroup>();
  for (const group of groups) {
    for (const member of group.members) groupOf.set(member.gameId, group);
  }
  const ids = new Set(games.map((g) => g.id));
  if (game.gameId && ids.has(game.gameId)) {
    const members = groupOf.get(game.gameId)?.members.map((member) => member.gameId) ?? [];
    return [game.gameId, ...members.filter((id) => id !== game.gameId && ids.has(id))];
  }
  const key = titleKey(game.title);
  if (!key) return [];
  const system = game.system ? titleKey(game.system) : '';
  return games
    .filter((g) => {
      const titles = [g.title, g.gameTitle, groupOf.get(g.id)?.title];
      if (!titles.some((title) => title && titleKey(title) === key)) return false;
      return !system || !g.system || titleKey(g.system) === system;
    })
    .map((g) => g.id);
}

/**
 * The issues that cover the game `gameId`, newest first, each with the
 * pages about it: every game of the issue that is this game (see
 * {@link gamesOfIssueGame}), its runs together. `games` are the games of
 * this device (packs of magazines among them are left out).
 */
export function coverageOf(
  gameId: string,
  magazines: readonly Magazine[],
  games: readonly GameOnDevice[],
  groups: readonly GameGroup[],
): Coverage[] {
  const candidates = games.filter((game) => !game.magazines);
  const out: Coverage[] = [];
  for (const magazine of magazines) {
    for (const issue of magazine.issues) {
      const runs = issue.issue.games
        .filter((game) => gamesOfIssueGame(game, candidates, groups).includes(gameId))
        .flatMap((game) => game.pages);
      if (runs.length > 0) out.push({ issue, pages: joinRuns(runs) });
    }
  }
  return out.sort((a, b) => newestFirst(a.issue, b.issue));
}

/** Runs of pages in order, those that overlap or meet joined. */
export function joinRuns(
  runs: readonly (readonly [number, number])[],
): (readonly [number, number])[] {
  const sorted = [...runs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [first, last] of sorted) {
    const before = out.at(-1);
    if (before && first <= before[1] + 1) before[1] = Math.max(before[1], last);
    else out.push([first, last]);
  }
  return out;
}

/** Whether a page is in one of the runs. */
export const inRuns = (page: number, runs: readonly (readonly [number, number])[]) =>
  runs.some(([first, last]) => page >= first && page <= last);

/**
 * The pages about a game in the issues that cover it whose text has every
 * word of `query`, newest issue first and then by page: at most `limit`.
 */
export function searchCoverage(
  coverage: readonly Coverage[],
  texts: ReadonlyMap<string, readonly string[]>,
  query: string,
  limit = 100,
): GuidebookHit[] {
  const hits: GuidebookHit[] = [];
  if (!query.trim()) return hits;
  for (const { issue, pages } of coverage) {
    for (const hit of searchGuidebooks([issue], texts, query, MAX_GUIDEBOOK_PAGES)) {
      if (!inRuns(hit.page, pages)) continue;
      if (hits.length >= limit) return hits;
      hits.push(hit);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Words for people

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** An issue's date in words: "May 2026", "15 May 2026"; null without one. */
export function dateWords(date: string | null): string | null {
  const match = date ? DATE.exec(date) : null;
  if (!match) return null;
  const [, year, month, day] = match;
  const monthName = MONTHS[Number(month) - 1];
  return day ? `${Number(day)} ${monthName} ${year}` : `${monthName} ${year}`;
}

/** Runs of pages in words: "page 12", "pages 12–15", "pages 12–15 and 40". */
export function pagesWords(runs: readonly (readonly [number, number])[]): string {
  const count = runs.reduce((sum, [first, last]) => sum + last - first + 1, 0);
  const parts = runs.map(([first, last]) => (first === last ? `${first}` : `${first}–${last}`));
  const joined =
    parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `${count === 1 ? 'page' : 'pages'} ${joined}`;
}

/** An issue's name with its magazine's: "Marsh Monthly, Issue 41". */
export function issueName(issue: Issue): string {
  return `${issue.issue.magazine}, ${issue.title}`;
}

/** What a magazine holds, in a few words: "12 issues, May 2024 to April 2026". */
export function magazineFacts(magazine: Magazine): string {
  const count = `${magazine.issues.length} ${magazine.issues.length === 1 ? 'issue' : 'issues'}`;
  const dated = magazine.issues.flatMap((issue) => (issue.issue.date ? [issue.issue.date] : []));
  if (dated.length === 0) return count;
  const newest = dateWords(dated[0]!.slice(0, 7));
  const oldest = dateWords(dated.at(-1)!.slice(0, 7));
  return newest === oldest ? `${count}, ${newest}` : `${count}, ${oldest} to ${newest}`;
}
