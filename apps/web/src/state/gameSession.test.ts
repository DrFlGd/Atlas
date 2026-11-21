import { MAP_KIND } from '@atlas/importer-api';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PackEntry } from '@atlas/core';
import { joinSameTitle, loadGameGroups, useGameGroups } from './gameGroups';
import {
  gamesLeft,
  goOutcome,
  isLeft,
  keptSession,
  pagesToAdd,
  roomFor,
  sessionTotals,
  unmatched,
  type GameSession,
  type SessionGame,
} from './gameSession';
import type { RunState } from './importRun';
import { openProgressStore } from './services';
import { useAtlas } from './store';

const SITE = 'https://maps.example.com';

const game = (id: string, more: Partial<SessionGame> = {}): SessionGame => ({
  id,
  name: id,
  address: `${SITE}/${id}`,
  direct: false,
  ...more,
});

const session = (more: Partial<GameSession> = {}): GameSession => ({
  importerId: 'demo',
  importerTitle: 'Demo',
  site: 'Demo map site',
  catalogue: `${SITE}/games`,
  system: '',
  games: [game('emberfall'), game('frostvale'), game('ashgrove')],
  results: {},
  stopped: null,
  startedAt: '2026-11-21T00:00:00.000Z',
  ...more,
});

describe('games added one after another', () => {
  it('adds up what the list says before anything is read', () => {
    const totals = sessionTotals([
      game('a', { maps: 3, bytes: 2_000_000 }),
      game('b', { maps: 1 }),
      game('c'),
    ]);
    expect(totals).toEqual({
      games: 3,
      maps: 4,
      mapsUnknown: 1,
      bytes: 2_000_000,
      bytesUnknown: 2,
    });
    expect(roomFor(totals, 1_000_000)).toBe(false);
    expect(roomFor(totals, 2_000_000)).toBe(true);
    // Not known: nothing is held back.
    expect(roomFor(totals, null)).toBe(true);
    expect(roomFor(totals, undefined)).toBe(true);
  });

  it('takes every page the importer can add that is not here yet, maps only for one that reads page by page', () => {
    const importer = { matches: (url: string) => url.startsWith(SITE) };
    const listed = [
      { url: `${SITE}/a/east`, kind: MAP_KIND, title: 'East' },
      { url: `${SITE}/a/west`, kind: MAP_KIND, title: 'West', group: 'Lands' },
      { url: `${SITE}/a/east#top`, kind: MAP_KIND, title: 'East again' },
      { url: `${SITE}/a/checklists/keys`, kind: 'checklist', title: 'Keys' },
      { url: 'https://elsewhere.example.com/a', kind: MAP_KIND, title: 'Elsewhere' },
    ];
    expect(pagesToAdd(importer, listed, new Set([`${SITE}/a/west`]))).toEqual([
      { url: `${SITE}/a/east`, title: 'East' },
      { url: `${SITE}/a/checklists/keys`, title: 'Keys' },
    ]);
    const reader = { ...importer, fetch: {} as never };
    expect(pagesToAdd(reader, listed, new Set()).map((page) => page.title)).toEqual([
      'East',
      'West',
    ]);
  });

  it('names the game most pages of a go went into', () => {
    const run = (states: RunState['pages'][number]['state'][]): RunState => ({
      pages: states.map((state, i) => ({ url: `${SITE}/${i}`, state })),
      leftOut: 0,
      status: 'finished',
      stopRequested: false,
      pausing: false,
      stopReason: null,
    });
    const added = (packId: string) =>
      ({ kind: 'added', game: packId, map: 'm', packId, refreshed: false }) as const;
    expect(
      goOutcome(
        run([
          added('a'),
          added('b'),
          added('b'),
          { kind: 'failed', message: 'No.', cause: 'other' },
        ]),
      ),
    ).toEqual({ packId: 'b', added: 3, failed: 1, noData: false });
    expect(
      goOutcome(run([{ kind: 'failed', message: 'Nothing came.', cause: 'no-data' }])),
    ).toEqual({ packId: null, added: 0, failed: 1, noData: true });
  });

  it('keeps what is left, and lists the games not matched by title', () => {
    const done = session({
      results: {
        emberfall: {
          kind: 'added',
          packId: 'emberfall',
          title: 'Emberfall',
          added: 2,
          failed: 0,
          match: { kind: 'joined', title: 'Emberfall' },
          system: null,
        },
        frostvale: {
          kind: 'added',
          packId: 'frostvale',
          title: 'Frostvale',
          added: 1,
          failed: 0,
          match: { kind: 'none' },
          system: 'Tern 16',
          partial: true,
        },
      },
    });
    expect(isLeft(done, 'emberfall')).toBe(false);
    // Stopped half-way: it is still to add.
    expect(isLeft(done, 'frostvale')).toBe(true);
    expect(gamesLeft(done).map((g) => g.id)).toEqual(['frostvale', 'ashgrove']);
    expect(unmatched(done).map(({ game: g }) => g.id)).toEqual(['frostvale']);
    expect(keptSession(JSON.parse(JSON.stringify(done)))).toEqual(done);
    expect(keptSession({ ...done, games: [{ id: 3 }] })).toBeNull();
    expect(keptSession('nonsense')).toBeNull();
  });
});

describe('matching a game added by its title', () => {
  beforeAll(async () => {
    // No IndexedDB here: the store kept in memory, as in a browser that allows none.
    await openProgressStore();
    await loadGameGroups();
  });

  const entry = (id: string, title: string) => ({ id, title }) as unknown as PackEntry;

  it('joins the one game here of the same title, and leaves it apart when unsure', async () => {
    useAtlas.setState({
      catalog: [
        entry('emberfall-other', 'Emberfall'),
        entry('emberfall', 'EMBERFALL!'),
        entry('frost-a', 'Frostvale'),
        entry('frost-b', 'Frostvale'),
        entry('frostvale', 'Frostvale'),
        entry('ashgrove', 'Ashgrove'),
        entry('twin-a', 'Twin'),
        entry('twin-b', 'Twin'),
      ],
    });
    expect(await joinSameTitle('emberfall', new Set())).toEqual({
      kind: 'joined',
      title: 'Emberfall',
    });
    expect(useGameGroups.getState().groups.map((g) => g.members.map((m) => m.gameId))).toEqual([
      ['emberfall-other', 'emberfall'],
    ]);
    expect(await joinSameTitle('frostvale', new Set())).toEqual({
      kind: 'unsure',
      others: ['frost-a', 'frost-b'],
    });
    expect(await joinSameTitle('ashgrove', new Set())).toEqual({ kind: 'none' });
    // Two games of the same session are never matched with each other.
    expect(await joinSameTitle('twin-b', new Set(['twin-a', 'twin-b']))).toEqual({ kind: 'none' });
    expect(useGameGroups.getState().groups).toHaveLength(1);
  });
});
