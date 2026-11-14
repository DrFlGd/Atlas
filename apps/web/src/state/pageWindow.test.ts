import { describe, expect, it } from 'vitest';
import type { PollResult } from '../desktop';
import { ImportRun, RUN_PAUSE_MS, WINDOW_PAGE_PAUSE_MS, type PageOutcome } from './importRun';
import {
  KEPT_POLL_MS,
  POLL_MS,
  PageWindows,
  type PageRead,
  type PageWaiting,
  type WindowShell,
} from './pageWindow';

const WIKI = 'https://wiki.example.org/wiki';
const page = (slug: string) => `${WIKI}/${slug}`;

/**
 * A stand-in for the shell's import window, on a made-up clock: the log of
 * what the app asked for and when, and per page how many polls it waits
 * before its data. A page in `check` shows the site's check (no data, and
 * attention asked) until taken out of it; a page in `closeOn` has its window
 * closed by the person.
 */
function fakeWindow() {
  let clock = 0;
  const log: string[] = [];
  let open: { url: string; keep: boolean; polls: number } | null = null;
  const state = {
    check: new Set<string>(),
    closeOn: new Set<string>(),
    /** After a move, the first poll hands over the page shown before, as a shell without its own check might. */
    lagging: false,
    previous: null as string | null,
    navigateFails: false,
  };
  const shell: WindowShell = {
    open(url, _reader, _importer, _purpose, measure, keep) {
      log.push(`${clock} open ${url}${keep ? ' keep' : ''}${measure ? ' measure' : ''}`);
      open = { url, keep: keep === true, polls: 0 };
      return Promise.resolve();
    },
    navigate(url) {
      if (state.navigateFails) return Promise.reject(new Error('The window could not move.'));
      if (!open) return Promise.resolve('closed' as const);
      log.push(`${clock} navigate ${url}`);
      state.previous = open.url;
      open = { ...open, url, polls: 0 };
      return Promise.resolve('navigated' as const);
    },
    poll(): Promise<PollResult> {
      if (!open) return Promise.resolve({ state: 'failed', message: 'No page is open.' });
      open.polls++;
      const { url } = open;
      if (state.closeOn.has(url)) {
        log.push(`${clock} closed by the person`);
        open = null;
        return Promise.resolve({ state: 'closed' });
      }
      if (state.lagging && open.polls === 1 && state.previous) {
        return Promise.resolve({
          state: 'ready',
          data: JSON.stringify({ page: state.previous }),
          address: state.previous,
        });
      }
      if (state.check.has(url)) {
        return Promise.resolve({
          state: 'waiting',
          loading: false,
          note: null,
          attention: open.polls > 3,
        });
      }
      if (open.polls < 2) return Promise.resolve({ state: 'waiting', loading: true, note: null });
      log.push(`${clock} read ${url}`);
      return Promise.resolve({
        state: 'ready',
        data: JSON.stringify({ page: url }),
        ...(open.keep ? { address: url } : {}),
      });
    },
    close() {
      if (open) log.push(`${clock} close`);
      open = null;
      return Promise.resolve();
    },
  };
  const sleeps: number[] = [];
  const sleep = (ms: number) => {
    sleeps.push(ms);
    clock += ms;
    return Promise.resolve();
  };
  return { shell, log, state, sleep, sleeps, now: () => clock };
}

/** A go of `urls` read as `importing.ts` reads one: each page in the window, kept for the go when `kept` says so. */
async function go(
  fake: ReturnType<typeof fakeWindow>,
  urls: string[],
  kept: (url: string) => boolean,
  goId = 1,
) {
  const windows = new PageWindows({ sleep: fake.sleep, now: fake.now, report: () => undefined });
  const reads: PageRead[] = [];
  const waiting: PageWaiting[] = [];
  const run = new ImportRun(
    urls,
    0,
    {
      sleep: fake.sleep,
      onChange: () => undefined,
      async importPage(_index, url): Promise<PageOutcome> {
        const read = await windows.read(
          fake.shell,
          {
            url,
            importer: { id: 'example-wiki' },
            pageReader: '() => null',
            waitSeconds: 60,
            reading: 'map',
            measure: null,
            keepFor: kept(url) ? goId : null,
            onWaiting: (state) => waiting.push(state),
          },
          () => true,
        );
        reads.push(read);
        if (read.state === 'ready') {
          const shown = (JSON.parse(read.data) as { page: string }).page;
          return {
            kind: 'added',
            game: 'Example Wiki',
            map: shown,
            packId: 'example-wiki',
            refreshed: false,
          };
        }
        if (read.state === 'closed') return { kind: 'closed', message: read.message };
        if (read.state === 'timed-out' || read.state === 'open-failed') {
          return { kind: 'no-data', message: read.message };
        }
        return { kind: 'failed', message: 'failed' };
      },
    },
    // As `importing.ts` pauses: shorter before a page read in the window kept from the page before.
    (index) =>
      kept(urls[index]!) ? windows.pauseBefore(goId, 'example-wiki', urls[index]!) : RUN_PAUSE_MS,
  );
  const final = await run.run();
  await windows.release(fake.shell, goId);
  return { final, reads, waiting, windows };
}

const opened = (log: string[]) => log.filter((line) => / (open|navigate|close)/.test(line));

describe('a go of pages read in a window kept for it', () => {
  it('opens the window once and moves it from page to page, then closes it', async () => {
    const fake = fakeWindow();
    const urls = [page('Welcome'), page('Bells'), page('Gates')];
    const { final } = await go(fake, urls, () => true);
    expect(final.status).toBe('finished');
    expect(opened(fake.log).map((line) => line.replace(/^\d+ /, ''))).toEqual([
      `open ${page('Welcome')} keep`,
      `navigate ${page('Bells')}`,
      `navigate ${page('Gates')}`,
      'close',
    ]);
    // Each page shows what was read from it.
    expect(final.pages.map((p) => (p.state.kind === 'added' ? p.state.map : null))).toEqual(urls);
  });

  it('asks the page every half second, and keeps the whole pause of a second between a page read and the next move', async () => {
    const fake = fakeWindow();
    await go(fake, [page('Welcome'), page('Bells'), page('Gates')], () => true);
    expect(WINDOW_PAGE_PAUSE_MS).toBe(1000);
    expect(fake.sleeps).toEqual([
      KEPT_POLL_MS,
      KEPT_POLL_MS,
      WINDOW_PAGE_PAUSE_MS,
      KEPT_POLL_MS,
      KEPT_POLL_MS,
      WINDOW_PAGE_PAUSE_MS,
      KEPT_POLL_MS,
      KEPT_POLL_MS,
    ]);
    const at = (what: string) =>
      Number(fake.log.find((line) => line.endsWith(what))!.split(' ')[0]);
    expect(at(`navigate ${page('Bells')}`) - at(`read ${page('Welcome')}`)).toBe(
      WINDOW_PAGE_PAUSE_MS,
    );
    expect(at(`navigate ${page('Gates')}`) - at(`read ${page('Bells')}`)).toBe(
      WINDOW_PAGE_PAUSE_MS,
    );
  });

  it('keeps the pause of any run before a page that gets a window of its own', async () => {
    const windows = new PageWindows({
      sleep: () => Promise.resolve(),
      now: () => 0,
      report: () => undefined,
    });
    // No window is kept yet: the first page of a go, a page of another go, site or importer.
    expect(windows.pauseBefore(1, 'example-wiki', page('Welcome'))).toBe(RUN_PAUSE_MS);
    const fake = fakeWindow();
    const urls = [page('Welcome'), 'https://maps.example.com/demo-maps/a/b', page('Bells')];
    await go(fake, urls, (url) => url.startsWith(WIKI));
    // The map page after a kept page, and the wiki page after it (its window was closed), wait the run's pause.
    expect(fake.sleeps.filter((ms) => ms === RUN_PAUSE_MS)).toHaveLength(2);
    expect(fake.sleeps).not.toContain(WINDOW_PAGE_PAUSE_MS);
  });

  it('never takes the page shown before for the page asked for', async () => {
    const fake = fakeWindow();
    fake.state.lagging = true;
    const urls = [page('Welcome'), page('Bells'), page('Gates')];
    const { final } = await go(fake, urls, () => true);
    // Each page got its own data, though the first poll after each move answered with the page before.
    expect(final.pages.map((p) => (p.state.kind === 'added' ? p.state.map : null))).toEqual(urls);
  });

  it('stops the go when the person closes the window, opening nothing more', async () => {
    const fake = fakeWindow();
    fake.state.closeOn.add(page('Bells'));
    const { final } = await go(fake, [page('Welcome'), page('Bells'), page('Gates')], () => true);
    expect(final.status).toBe('stopped');
    expect(final.stopReason).toBe('closed');
    expect(final.pages.map((p) => p.state.kind)).toEqual(['added', 'failed', 'not-started']);
    expect(fake.log.some((line) => line.includes(page('Gates')))).toBe(false);
    expect(fake.log.filter((line) => line.includes(' open '))).toHaveLength(1);
  });

  it('passes on that the window waits for the person, and goes on once the page shows', async () => {
    const fake = fakeWindow();
    fake.state.check.add(page('Bells'));
    const windows = new PageWindows({ sleep: fake.sleep, now: fake.now, report: () => undefined });
    const request = (url: string, onWaiting: (state: PageWaiting) => void) => ({
      url,
      importer: { id: 'example-wiki' },
      pageReader: '() => null',
      waitSeconds: 60,
      reading: 'map' as const,
      measure: null,
      keepFor: 7,
      onWaiting,
    });
    expect(
      (
        await windows.read(
          fake.shell,
          request(page('Welcome'), () => undefined),
          () => true,
        )
      ).state,
    ).toBe('ready');
    const waiting: PageWaiting[] = [];
    const reading = windows.read(
      fake.shell,
      request(page('Bells'), (state) => {
        waiting.push(state);
        // The person answers the check once the app says the window waits for them.
        if (state.attention) fake.state.check.delete(page('Bells'));
      }),
      () => true,
    );
    expect((await reading).state).toBe('ready');
    expect(waiting.some((state) => state.attention === true)).toBe(true);
    expect(fake.log.filter((line) => line.includes(' open '))).toHaveLength(1);
  });

  it('keeps the window after a page that gave no data in time, and moves it to the next', async () => {
    const fake = fakeWindow();
    fake.state.check.add(page('Bells'));
    const { final } = await go(fake, [page('Welcome'), page('Bells'), page('Gates')], () => true);
    expect(final.pages.map((p) => p.state.kind)).toEqual(['added', 'failed', 'added']);
    expect(opened(fake.log).map((line) => line.replace(/^\d+ /, ''))).toEqual([
      `open ${page('Welcome')} keep`,
      `navigate ${page('Bells')}`,
      `navigate ${page('Gates')}`,
      'close',
    ]);
  });

  it('opens a window of its own when the window cannot move, and for another site', async () => {
    const fake = fakeWindow();
    fake.state.navigateFails = true;
    const { final } = await go(fake, [page('Welcome'), page('Bells')], () => true);
    expect(final.pages.map((p) => p.state.kind)).toEqual(['added', 'failed']);
    expect(opened(fake.log).map((line) => line.replace(/^\d+ /, ''))).toEqual([
      `open ${page('Welcome')} keep`,
      'close',
    ]);

    const other = fakeWindow();
    const elsewhere = 'https://other.example.net/wiki/Welcome';
    await go(other, [page('Welcome'), elsewhere, page('Gates')], () => true);
    expect(opened(other.log).map((line) => line.replace(/^\d+ /, ''))).toEqual([
      `open ${page('Welcome')} keep`,
      `open ${elsewhere} keep`,
      `open ${page('Gates')} keep`,
      'close',
    ]);
  });
});

describe('pages read in a window of their own', () => {
  it('still opens and closes a window for each page, asking every two seconds', async () => {
    const fake = fakeWindow();
    const maps = ['https://maps.example.com/world/a', 'https://maps.example.com/world/b'];
    const { final } = await go(fake, maps, () => false);
    expect(final.status).toBe('finished');
    expect(opened(fake.log).map((line) => line.replace(/^\d+ /, ''))).toEqual([
      `open ${maps[0]}`,
      'close',
      `open ${maps[1]}`,
      'close',
    ]);
    expect(fake.sleeps).toEqual([POLL_MS, POLL_MS, RUN_PAUSE_MS, POLL_MS, POLL_MS]);
  });

  it('never keeps a window whose map picture is measured', async () => {
    const fake = fakeWindow();
    const windows = new PageWindows({ sleep: fake.sleep, now: fake.now, report: () => undefined });
    await windows.read(
      fake.shell,
      {
        url: 'https://maps.example.com/world/a',
        importer: { id: 'demo-maps' },
        pageReader: '() => null',
        waitSeconds: 60,
        reading: 'map',
        measure: '(state) => ({ done: true })',
        keepFor: 3,
        onWaiting: () => undefined,
      },
      () => true,
    );
    expect(opened(fake.log).map((line) => line.replace(/^\d+ /, ''))).toEqual([
      'open https://maps.example.com/world/a measure',
      'close',
    ]);
  });
});
