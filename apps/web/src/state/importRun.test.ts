import { describe, expect, it } from 'vitest';
import {
  ImportRun,
  MAX_RUN_ADDRESSES,
  RUN_PAUSE_MS,
  checkAddresses,
  endRun,
  newRun,
  parseAddresses,
  runCounts,
  runSummary,
  settlePage,
  tooManyMessage,
  type PageOutcome,
  type RunPageState,
  type RunState,
} from './importRun';

const page = (n: number) => `https://maps.example.com/world/map-${n}`;

describe('parseAddresses', () => {
  it('splits on lines, spaces and commas, trims, and drops exact repeats', () => {
    const text = `  ${page(1)}\n${page(2)} ${page(3)},${page(4)} ,\r\n\t${page(2)}\n\n${page(1)}/\n`;
    expect(parseAddresses(text)).toEqual({
      addresses: [page(1), page(2), page(3), page(4), `${page(1)}/`],
      duplicates: 1,
      tooMany: false,
    });
  });

  it('reads one address as one', () => {
    expect(parseAddresses(` ${page(1)} `).addresses).toEqual([page(1)]);
    expect(parseAddresses(' \n , ').addresses).toEqual([]);
  });

  it('takes at most 25 addresses, counting each once', () => {
    const exactly = Array.from({ length: MAX_RUN_ADDRESSES }, (_, i) => page(i)).join('\n');
    expect(parseAddresses(exactly).tooMany).toBe(false);
    expect(parseAddresses(`${exactly}\n${page(0)}`).tooMany).toBe(false);
    const more = parseAddresses(`${exactly}\n${page(99)}`);
    expect(more.tooMany).toBe(true);
    expect(more.addresses).toHaveLength(26);
    expect(tooManyMessage(26)).toBe(
      'That is 26 addresses. This app adds at most 25 maps at a time, so remove some and add them afterwards.',
    );
  });
});

describe('checkAddresses', () => {
  const importers = [
    { title: 'World maps', matches: (url: string) => url.includes('maps.example.com/world/') },
    {
      title: 'Throws',
      matches: (): boolean => {
        throw new Error('no');
      },
    },
  ];

  it('marks each address no importer recognises, keeping the order', () => {
    const checked = checkAddresses(
      [page(1), 'https://other.example.org/x', 'ftp://maps.example.com/world/a', page(2)],
      importers,
    );
    expect(checked.map((c) => c.importer?.title ?? null)).toEqual([
      'World maps',
      null,
      null,
      'World maps',
    ]);
    expect(checked.map((c) => c.problem)).toEqual([
      null,
      'No importer in this app recognises this address.',
      'This is not a web address this app can open.',
      null,
    ]);
  });
});

const added = (n: number, refreshed = false): PageOutcome => ({
  kind: 'added',
  game: 'Test Valley',
  map: `Map ${n}`,
  packId: 'test-valley',
  mapId: `test-valley:map:m${n}`,
  refreshed,
});
const noData: PageOutcome = { kind: 'no-data', message: 'No data in time.' };
const failed: PageOutcome = { kind: 'failed', message: 'The importer refused it.' };
const closed: PageOutcome = { kind: 'closed', message: 'The window was closed.' };

const states = (run: RunState) => run.pages.map((p) => p.state.kind);

describe('settlePage', () => {
  it('goes on after a page that failed, and finishes after the last', () => {
    let run = newRun([page(1), page(2), page(3)]);
    run = settlePage(run, 0, failed);
    expect(run.status).toBe('running');
    run = settlePage(run, 1, added(2));
    expect(run.status).toBe('running');
    run = settlePage(run, 2, noData);
    expect(run.status).toBe('finished');
    expect(run.stopReason).toBeNull();
    expect(states(run)).toEqual(['failed', 'added', 'failed']);
  });

  it('stops when the page window was closed, keeping what was done', () => {
    let run = newRun([page(1), page(2), page(3), page(4)]);
    run = settlePage(run, 0, added(1));
    run = settlePage(run, 1, closed);
    expect(run.status).toBe('stopped');
    expect(run.stopReason).toBe('closed');
    expect(states(run)).toEqual(['added', 'failed', 'not-started', 'not-started']);
  });

  it('stops after two pages in a row without data, but not after two apart', () => {
    let run = newRun([page(1), page(2), page(3), page(4), page(5)]);
    run = settlePage(run, 0, noData);
    run = settlePage(run, 1, added(2));
    run = settlePage(run, 2, noData);
    expect(run.status).toBe('running');
    run = settlePage(run, 3, noData);
    expect(run.status).toBe('stopped');
    expect(run.stopReason).toBe('no-data');
    expect(states(run)).toEqual(['failed', 'added', 'failed', 'failed', 'not-started']);
  });

  it('does not count a page whose data was refused as one without data', () => {
    let run = newRun([page(1), page(2), page(3)]);
    run = settlePage(run, 0, noData);
    run = settlePage(run, 1, failed);
    expect(run.status).toBe('running');
  });

  it('stops after the current page when Stop was pressed', () => {
    let run = newRun([page(1), page(2), page(3)]);
    run = { ...run, stopRequested: true };
    run = settlePage(run, 0, added(1));
    expect(run.status).toBe('stopped');
    expect(run.stopReason).toBe('stop');
    expect(states(run)).toEqual(['added', 'not-started', 'not-started']);
  });

  it('counts and sums up the run', () => {
    let run = newRun([page(1), page(2), page(3), page(4), page(5), page(6)]);
    run = settlePage(run, 0, added(1));
    run = settlePage(run, 1, added(2, true));
    run = settlePage(run, 2, failed);
    run = settlePage(run, 3, added(4));
    run = endRun(run, 'stop');
    expect(runCounts(run)).toEqual({ added: 2, refreshed: 1, notAdded: 1, notStarted: 2 });
    expect(runSummary(run)).toBe('2 maps added, 1 refreshed, 1 not added, 2 not started');
    let one = newRun([page(1), page(2)]);
    one = settlePage(one, 0, failed);
    one = settlePage(one, 1, added(2, true));
    expect(runSummary(one)).toBe('1 map refreshed, 1 not added');
  });
});

/** A run against made-up pages: what each returns, and a log of what happened when. */
function fakeRun(outcomes: PageOutcome[], hooks: { onPage?: (index: number) => void } = {}) {
  const log: string[] = [];
  let open = 0;
  let maxOpen = 0;
  const changes: RunState[] = [];
  const run = new ImportRun(
    outcomes.map((_, i) => page(i + 1)),
    0,
    {
      async importPage(index, url, update: (state: RunPageState) => void) {
        open++;
        maxOpen = Math.max(maxOpen, open);
        log.push(`open ${index} ${url}`);
        update({ kind: 'open', startedAt: 0, now: 0, waitSeconds: 30, loading: true });
        hooks.onPage?.(index);
        await Promise.resolve();
        open--;
        log.push(`end ${index}`);
        return outcomes[index]!;
      },
      sleep(ms) {
        log.push(`pause ${ms}`);
        return Promise.resolve();
      },
      onChange(state) {
        changes.push(state);
      },
    },
  );
  return { run, log, changes, maxOpen: () => maxOpen };
}

describe('ImportRun', () => {
  it('opens every page once, in order, one at a time, with a pause between them', async () => {
    const { run, log, maxOpen } = fakeRun([added(1), failed, noData, added(4)]);
    const final = await run.run();
    expect(log).toEqual([
      `open 0 ${page(1)}`,
      'end 0',
      `pause ${RUN_PAUSE_MS}`,
      `open 1 ${page(2)}`,
      'end 1',
      `pause ${RUN_PAUSE_MS}`,
      `open 2 ${page(3)}`,
      'end 2',
      `pause ${RUN_PAUSE_MS}`,
      `open 3 ${page(4)}`,
      'end 3',
    ]);
    expect(maxOpen()).toBe(1);
    expect(final.status).toBe('finished');
    expect(states(final)).toEqual(['added', 'failed', 'failed', 'added']);
  });

  it('stops when the window is closed', async () => {
    const { run, log } = fakeRun([added(1), closed, added(3)]);
    const final = await run.run();
    expect(final.stopReason).toBe('closed');
    expect(log.filter((line) => line.startsWith('open'))).toHaveLength(2);
    expect(states(final)).toEqual(['added', 'failed', 'not-started']);
  });

  it('stops after two pages in a row without data, opening none of the rest', async () => {
    const { run, log } = fakeRun([noData, noData, added(3), added(4)]);
    const final = await run.run();
    expect(final.stopReason).toBe('no-data');
    expect(log.filter((line) => line.startsWith('open'))).toHaveLength(2);
    expect(states(final)).toEqual(['failed', 'failed', 'not-started', 'not-started']);
  });

  it('Stop ends the run after the page that is open', async () => {
    const fake = fakeRun([added(1), added(2), added(3)], {
      onPage: (index) => {
        if (index === 1) fake.run.stop();
      },
    });
    const final = await fake.run.run();
    expect(final.status).toBe('stopped');
    expect(final.stopReason).toBe('stop');
    expect(states(final)).toEqual(['added', 'added', 'not-started']);
    expect(fake.log.filter((line) => line.startsWith('open'))).toHaveLength(2);
    expect(fake.changes.some((state) => state.stopRequested && state.status === 'running')).toBe(
      true,
    );
  });

  it('Stop during the pause ends the run without waiting it out', async () => {
    let wake: () => void = () => undefined;
    const log: string[] = [];
    const run = new ImportRun([page(1), page(2)], 0, {
      importPage: (index) => {
        log.push(`open ${index}`);
        return Promise.resolve(added(index + 1));
      },
      sleep: () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
      onChange: (state) => {
        if (state.pausing) {
          queueMicrotask(() => {
            run.stop();
          });
        }
      },
    });
    const final = await run.run();
    wake();
    expect(log).toEqual(['open 0']);
    expect(final.stopReason).toBe('stop');
    expect(states(final)).toEqual(['added', 'not-started']);
  });

  it('a cancelled run stops at once', async () => {
    const fake = fakeRun([added(1), added(2), added(3)], {
      onPage: (index) => {
        if (index === 0) fake.run.cancel();
      },
    });
    const final = await fake.run.run();
    expect(final.stopReason).toBe('cancelled');
    expect(states(final)).toEqual(['added', 'not-started', 'not-started']);
  });
});
