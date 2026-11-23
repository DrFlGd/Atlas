import { describe, expect, it } from 'vitest';
import type { ListedPack } from '../desktop';
import {
  coverageOf,
  dateWords,
  gamesOfIssueGame,
  isIssue,
  issueName,
  joinRuns,
  magazineFacts,
  pagesWords,
  parseMagazineList,
  searchCoverage,
  type IssueGame,
} from './magazineData';

const PACK = {
  id: 'magazines-marsh-monthly',
  url: 'http://atlas-pack.localhost/magazines-marsh-monthly',
};

const issue = (more: Record<string, unknown> = {}) => ({
  file: 'magazines/2026-04-issue-41.pdf',
  title: 'Issue 41',
  date: '2026-04',
  number: 41,
  pages: 20,
  bytes: 1000,
  ...more,
});

const list = (issues: unknown[], magazine: unknown = { title: 'Marsh Monthly' }) =>
  JSON.stringify({ format: 'atlas-magazines', version: 1, magazine, issues });

const pack = (id: string, title: string, more: Partial<ListedPack> = {}) => ({
  id,
  title,
  ...more,
});

const group = (id: string, title: string, members: string[]) => ({
  id,
  title,
  members: members.map((gameId) => ({ gameId })),
});

const game = (title: string, more: Partial<IssueGame> = {}): IssueGame => ({
  title,
  system: null,
  gameId: null,
  pages: [[1, 1]],
  ...more,
});

describe('parseMagazineList', () => {
  it('reads the issues, newest first, with their files, text and covers', () => {
    const magazine = parseMagazineList(
      list(
        [
          issue({
            text: 'magazines/2026-04-issue-41.text.json',
            cover: 'magazines/2026-04-issue-41.cover.jpg',
            games: [
              { title: 'Hollow Marsh', system: 'Desk', gameId: 'hollow-marsh', pages: [[3, 5]] },
            ],
          }),
          issue({
            file: 'magazines/2026-05-issue-42.cbz',
            title: 'Issue 42',
            date: '2026-05-15',
            number: 42,
          }),
          issue({ file: 'magazines/special.pdf', title: 'Special', date: null, number: null }),
        ],
        { title: 'Marsh Monthly', publisher: 'Reed Press' },
      ),
      PACK,
    );
    expect(magazine.title).toBe('Marsh Monthly');
    expect(magazine.publisher).toBe('Reed Press');
    expect(magazine.issues.map((i) => i.title)).toEqual(['Issue 42', 'Issue 41', 'Special']);
    const [newest, older] = magazine.issues;
    expect(newest!.type).toBe('cbz');
    expect(newest!.issue.coverUrl).toBeNull();
    expect(older!.key).toBe('magazines-marsh-monthly/magazines/2026-04-issue-41.pdf');
    expect(older!.url).toBe(`${PACK.url}/magazines/2026-04-issue-41.pdf`);
    expect(older!.textUrl).toBe(`${PACK.url}/magazines/2026-04-issue-41.text.json`);
    expect(older!.issue.coverUrl).toBe(`${PACK.url}/magazines/2026-04-issue-41.cover.jpg`);
    expect(older!.issue.games).toEqual([
      { title: 'Hollow Marsh', system: 'Desk', gameId: 'hollow-marsh', pages: [[3, 5]] },
    ]);
    expect(older!.byAtlas).toBe(false);
    expect(isIssue(older!)).toBe(true);
    expect(issueName(older!)).toBe('Marsh Monthly, Issue 41');
  });

  it('leaves out what does not fit, and games whose pages are not in the issue', () => {
    const magazine = parseMagazineList(
      list([
        issue({
          games: [
            { title: 'Inside', pages: [[19, 20]] },
            { title: 'Outside', pages: [[19, 21]] },
            { title: 'Backwards', pages: [[5, 4]] },
            { title: 'Bad id', gameId: 'Not An Id', pages: [[1, 1]] },
            { title: '', pages: [[1, 1]] },
          ],
        }),
        issue(),
        issue({ file: 'magazines/../escape.pdf' }),
        issue({ file: 'magazines/comic.cbr' }),
        issue({ file: 'magazines/b.pdf', date: 'April 2026' }),
        issue({ file: 'magazines/c.pdf', text: 'magazines/other.text.json' }),
        issue({ file: 'magazines/d.pdf', cover: 'preview/d.jpg' }),
        issue({ file: 'magazines/e.pdf', pages: 0 }),
      ]),
      PACK,
    );
    expect(magazine.issues).toHaveLength(1);
    expect(magazine.issues[0]!.issue.games.map((g) => g.title)).toEqual(['Inside']);
  });

  it('refuses a list that is not one', () => {
    expect(() => parseMagazineList('{', PACK)).toThrow('cannot be read');
    expect(() => parseMagazineList(list([], { title: '' }), PACK)).toThrow('cannot be read');
    expect(() =>
      parseMagazineList(JSON.stringify({ format: 'atlas-guidebooks', version: 1 }), PACK),
    ).toThrow('cannot be read');
  });
});

describe('which issues cover a game', () => {
  const games = [
    pack('hollow-marsh', 'Hollow Marsh', { system: 'Desk' }),
    pack('hollow-marsh-wiki', 'Hollow Marsh Wiki', { gameTitle: 'hollow marsh' }),
    pack('reed-runner', 'Reed Runner'),
    pack('reed-maps', 'Reed Maps'),
    pack('magazines-x', 'Hollow Marsh', { magazines: true }),
  ];
  const onDevice = games.filter((g) => !g.magazines);

  it('matches by game id, with the games under one title with it', () => {
    const groups = [group('g', 'Reed Runner', ['reed-runner', 'reed-maps'])];
    expect(gamesOfIssueGame(game('Anything', { gameId: 'reed-runner' }), onDevice, groups)).toEqual(
      ['reed-runner', 'reed-maps'],
    );
    // An id no game here has: by title, as without one.
    expect(gamesOfIssueGame(game('Reed Runner', { gameId: 'elsewhere' }), onDevice, [])).toEqual([
      'reed-runner',
    ]);
  });

  it('matches by title, leaving out a game of another system', () => {
    expect(gamesOfIssueGame(game(' hollow-marsh! '), onDevice, [])).toEqual([
      'hollow-marsh',
      'hollow-marsh-wiki',
    ]);
    expect(gamesOfIssueGame(game('Hollow Marsh', { system: 'desk' }), onDevice, [])).toEqual([
      'hollow-marsh',
      'hollow-marsh-wiki',
    ]);
    expect(gamesOfIssueGame(game('Hollow Marsh', { system: 'Pocket' }), onDevice, [])).toEqual([
      'hollow-marsh-wiki',
    ]);
    // The title the person put a game under.
    expect(
      gamesOfIssueGame(game('The Reeds'), onDevice, [group('g', 'The Reeds', ['reed-maps'])]),
    ).toEqual(['reed-maps']);
  });

  it('lists the issues of a game newest first, with its pages joined', () => {
    const magazine = parseMagazineList(
      list([
        issue({
          games: [
            { title: 'Hollow Marsh', pages: [[12, 13]] },
            {
              title: 'Hollow Marsh',
              system: 'Desk',
              pages: [
                [14, 15],
                [3, 3],
              ],
            },
            { title: 'Reed Runner', pages: [[5, 6]] },
          ],
        }),
        issue({
          file: 'magazines/2026-05-issue-42.pdf',
          title: 'Issue 42',
          date: '2026-05',
          games: [{ title: 'Hollow Marsh', gameId: 'hollow-marsh', pages: [[2, 2]] }],
        }),
      ]),
      PACK,
    );
    const coverage = coverageOf('hollow-marsh', [magazine], games, []);
    expect(coverage.map((c) => [c.issue.title, c.pages])).toEqual([
      ['Issue 42', [[2, 2]]],
      [
        'Issue 41',
        [
          [3, 3],
          [12, 15],
        ],
      ],
    ]);
    // A pack of magazines is no game.
    expect(coverageOf('magazines-x', [magazine], games, [])).toEqual([]);
    expect(coverageOf('reed-maps', [magazine], games, [])).toEqual([]);

    // Search finds the pages about the game only.
    const texts = new Map([
      [
        magazine.issues[1]!.key,
        Array.from({ length: 20 }, (_, i) =>
          i + 1 === 13 || i + 1 === 5 ? 'The heron returns' : '',
        ),
      ],
    ]);
    const hits = searchCoverage(coverage, texts, 'heron');
    expect(hits.map((hit) => [hit.guidebook.title, hit.page])).toEqual([['Issue 41', 13]]);
    expect(searchCoverage(coverage, texts, '  ')).toEqual([]);
  });
});

describe('words', () => {
  it('says dates, pages and what a magazine holds', () => {
    expect(dateWords('2026-05')).toBe('May 2026');
    expect(dateWords('2026-05-03')).toBe('3 May 2026');
    expect(dateWords(null)).toBeNull();
    expect(dateWords('2026-13')).toBeNull();
    expect(pagesWords([[12, 12]])).toBe('page 12');
    expect(pagesWords([[12, 15]])).toBe('pages 12–15');
    expect(
      pagesWords([
        [3, 3],
        [12, 15],
        [40, 40],
      ]),
    ).toBe('pages 3, 12–15 and 40');
    expect(
      joinRuns([
        [12, 15],
        [3, 4],
        [5, 5],
        [14, 20],
      ]),
    ).toEqual([
      [3, 5],
      [12, 20],
    ]);
    const magazine = parseMagazineList(
      list([
        issue(),
        issue({ file: 'magazines/b.pdf', date: '2024-11-02' }),
        issue({ file: 'magazines/c.pdf', date: null }),
      ]),
      PACK,
    );
    expect(magazineFacts(magazine)).toBe('3 issues, November 2024 to April 2026');
    expect(magazineFacts({ ...magazine, issues: magazine.issues.slice(0, 1) })).toBe(
      '1 issue, April 2026',
    );
  });
});
