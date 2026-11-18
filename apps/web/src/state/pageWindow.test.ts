import { describe, expect, it } from 'vitest';
import type { PollResult } from '../desktop';
import {
  ImportRun,
  RUN_PAUSE_MS,
  WINDOW_PAGE_PAUSE_MS,
  type PageOutcome,
  type RunState,
} from './importRun';
import {
  KEPT_POLL_MS,
  MAX_NOTE_CHARS,
  POLL_MS,
  PageWindows,
  STALE_NOTE,
  STILL_WAITING_SECONDS,
  noteText,
  runWhyItWaits,
  whyItWaits,
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
    /** What the reader says of a page in `check`, as its note. */
    notes: new Map<string, string>(),
    closeOn: new Set<string>(),
    /** After a move, the first poll hands over the page shown before, as a shell without its own check might. */
    lagging: false,
    previous: null as string | null,
    /** Where the document of the page read before was, when not at its own address. */
    previousAt: null as string | null,
    navigateFails: false,
    /**
     * Names the site shows at another page's address: the name's address,
     * then the address its document has. The shell says `forwarded` when
     * that is a page shown before, unless `vouches` is off.
     */
    forwards: new Map<string, string>(),
    vouches: true,
  };
  const pageOf = (address: string) => address.split('#')[0]!;
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
      state.previousAt = state.forwards.get(open.url) ?? null;
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
          note: state.notes.get(url) ?? null,
          attention: open.polls > 3,
        });
      }
      if (open.polls < 2) return Promise.resolve({ state: 'waiting', loading: true, note: null });
      log.push(`${clock} read ${url}`);
      const address = state.forwards.get(url) ?? url;
      const before = [state.previous, state.previousAt].filter((at) => at !== null).map(pageOf);
      const forwarded =
        state.vouches && pageOf(address) !== pageOf(url) && before.includes(pageOf(address));
      return Promise.resolve({
        state: 'ready',
        data: JSON.stringify({ page: url }),
        ...(open.keep ? { address } : {}),
        ...(open.keep && forwarded ? { forwarded: true } : {}),
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
  keepOff: readonly string[] = [],
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
            keepOff,
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
        if (read.state === 'failed') return { kind: 'failed', message: read.message };
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
  it('never opens or moves the window to an address the site’s rules file keeps it off', async () => {
    const fake = fakeWindow();
    const kept = `${page('Bells')}?part=2`;
    const urls = [page('Welcome'), kept, page('Gates')];
    const { final, reads } = await go(fake, urls, () => true, 1, ['/wiki/Bells?part=']);
    expect(opened(fake.log).map((line) => line.replace(/^\d+ /, ''))).toEqual([
      `open ${page('Welcome')} keep`,
      `navigate ${page('Gates')}`,
      'close',
    ]);
    expect(reads[1]).toEqual({
      state: 'failed',
      message: `The site's rules file keeps this app off ${kept}, so it did not open that address and did not read the page.`,
    });
    expect(final.pages.map((p) => p.state.kind)).toEqual(['added', 'failed', 'added']);
  });

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
    const { final, waiting } = await go(fake, urls, () => true);
    // Each page got its own data, though the first poll after each move answered with the page before.
    expect(final.pages.map((p) => (p.state.kind === 'added' ? p.state.map : null))).toEqual(urls);
    // Meanwhile, the page waits, saying why.
    expect(waiting.filter((state) => state.note === STALE_NOTE)).toHaveLength(2);
  });

  it('reads a name the site shows at the address of the page before', async () => {
    const fake = fakeWindow();
    // Bells and Gates are other names of parts of Welcome; Rooms is a page of its own.
    fake.state.forwards.set(page('Bells'), `${page('Welcome')}#Bells`);
    fake.state.forwards.set(page('Gates'), `${page('Welcome')}#Gates`);
    const urls = [page('Welcome'), page('Bells'), page('Gates'), page('Rooms'), page('Welcome')];
    const { final, reads } = await go(fake, urls, () => true);
    expect(final.pages.map((p) => (p.state.kind === 'added' ? p.state.map : null))).toEqual(urls);
    expect(reads.map((read) => read.state)).toEqual(urls.map(() => 'ready'));
    // One window for all of them, each read once, none waited out.
    expect(fake.log.filter((line) => line.includes(' open '))).toHaveLength(1);
    expect(fake.log.filter((line) => line.includes(' read '))).toHaveLength(urls.length);
  });

  it('still refuses the address of the page before when the shell does not vouch for it', async () => {
    const fake = fakeWindow();
    fake.state.forwards.set(page('Bells'), `${page('Welcome')}#Bells`);
    fake.state.vouches = false;
    const { final, reads } = await go(fake, [page('Welcome'), page('Bells')], () => true);
    expect(reads.map((read) => read.state)).toEqual(['ready', 'timed-out']);
    expect(final.pages.map((p) => p.state.kind)).toEqual(['added', 'failed']);
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
      keepOff: [],
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
        keepOff: [],
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

describe('reading more from a page once its data is read', () => {
  it('does it while the window still shows the page, before it is closed or moved, and never fails the read for it', async () => {
    const fake = fakeWindow();
    const windows = new PageWindows({ sleep: fake.sleep, now: fake.now, report: () => undefined });
    const read = (url: string, keepFor: number | null, afterRead: () => Promise<void>) =>
      windows.read(
        fake.shell,
        {
          url,
          importer: { id: 'example-wiki' },
          pageReader: '() => null',
          waitSeconds: 60,
          reading: 'map',
          measure: null,
          keepFor,
          keepOff: [],
          onWaiting: () => undefined,
          afterRead,
        },
        () => true,
      );
    const after = (url: string) => () => {
      fake.log.push(`after ${url}`);
      return Promise.resolve();
    };
    expect((await read(page('Welcome'), 1, after(page('Welcome')))).state).toBe('ready');
    // It fails: the page is read all the same.
    const failed = await read(page('Bells'), 1, () => Promise.reject(new Error('busy')));
    expect(failed.state).toBe('ready');
    expect((await read(page('Gates'), null, after(page('Gates')))).state).toBe('ready');
    const steps = fake.log
      .map((line) => line.replace(/^\d+ /, ''))
      .filter((line) => /^(open|navigate|read|after) /.test(line) || line === 'close');
    expect(steps).toEqual([
      `open ${page('Welcome')} keep`,
      `read ${page('Welcome')}`,
      `after ${page('Welcome')}`,
      `navigate ${page('Bells')}`,
      `read ${page('Bells')}`,
      // A window of its own, which the shell opens in place of the kept one.
      `open ${page('Gates')}`,
      `read ${page('Gates')}`,
      `after ${page('Gates')}`,
      'close',
    ]);
  });
});

describe('why the page window waits', () => {
  const REASON =
    'The page names /wiki/Saltmarsh_Bells as its own address, but the window shows /wiki/Bells.';

  it('carries the reader’s reason into the run, and shows it once the window waits for the person', async () => {
    const fake = fakeWindow();
    fake.state.check.add(page('Bells'));
    fake.state.notes.set(page('Bells'), REASON);
    const windows = new PageWindows({ sleep: fake.sleep, now: fake.now, report: () => undefined });
    const states: RunState[] = [];
    const run = new ImportRun(
      [page('Bells')],
      0,
      {
        sleep: fake.sleep,
        onChange: (state) => states.push(state),
        async importPage(_index, url, update): Promise<PageOutcome> {
          const read = await windows.read(
            fake.shell,
            {
              url,
              importer: { id: 'example-wiki' },
              pageReader: '() => null',
              waitSeconds: 60,
              reading: 'map',
              measure: null,
              keepFor: 1,
              keepOff: [],
              onWaiting: (waiting) => {
                update({ kind: 'open', ...waiting });
              },
            },
            () => true,
          );
          return read.state === 'timed-out'
            ? { kind: 'no-data', message: read.message }
            : { kind: 'failed', message: read.state };
        },
      },
      0,
    );
    const final = await run.run();
    const open = states.flatMap((state) =>
      state.pages[0]!.state.kind === 'open' ? [state.pages[0]!.state] : [],
    );
    // The note of the last poll is in the run's state.
    expect(open.some((state) => state.note === REASON)).toBe(true);
    // Not shown for a page that has just loaded and asked for nobody.
    const early = states.find((state) => {
      const shown = state.pages[0]!.state;
      return shown.kind === 'open' && shown.note === REASON && shown.attention !== true;
    })!;
    expect(runWhyItWaits(early)).toBeNull();
    // Shown once the window waits for the person.
    const asked = states.find((state) => {
      const shown = state.pages[0]!.state;
      return shown.kind === 'open' && shown.attention === true;
    })!;
    expect(runWhyItWaits(asked)).toBe(`Why it waits: ${REASON}`);
    // The failed page's row keeps it.
    const failed = final.pages[0]!.state;
    expect(failed.kind).toBe('failed');
    expect(failed.kind === 'failed' && failed.message).toContain(
      `Nothing was added. The last thing the reader said: ${REASON}`,
    );
    expect(runWhyItWaits(final)).toBeNull();
  });

  it('adds the last note to the message of a page that runs out of time, and reports it', async () => {
    const fake = fakeWindow();
    fake.state.check.add(page('Bells'));
    fake.state.notes.set(page('Bells'), 'the page did not answer the reader within 10 seconds');
    const reports: string[] = [];
    const windows = new PageWindows({
      sleep: fake.sleep,
      now: fake.now,
      report: (entry) => reports.push(entry.message ?? ''),
    });
    const read = await windows.read(
      fake.shell,
      {
        url: page('Bells'),
        importer: { id: 'example-wiki' },
        pageReader: '() => null',
        waitSeconds: 30,
        reading: 'game',
        measure: null,
        keepFor: null,
        keepOff: [],
        onWaiting: () => undefined,
      },
      () => true,
    );
    const message =
      'The page did not provide the list of its pages within 30 seconds. If it asked you to sign in, to confirm you are a person or to wait, it may not have let the page load; you can try again later. Nothing was added. The last thing the reader said: The page did not answer the reader within 10 seconds.';
    expect(read).toEqual({ state: 'timed-out', message });
    expect(reports).toEqual([message]);
    // Without a note, the message stays as it was.
    const quiet = fakeWindow();
    quiet.state.check.add(page('Gates'));
    const plain = await new PageWindows({
      sleep: quiet.sleep,
      now: quiet.now,
      report: () => undefined,
    }).read(
      quiet.shell,
      {
        url: page('Gates'),
        importer: { id: 'example-wiki' },
        pageReader: '() => null',
        waitSeconds: 30,
        reading: 'map',
        measure: null,
        keepFor: null,
        keepOff: [],
        onWaiting: () => undefined,
      },
      () => true,
    );
    expect(plain.state === 'timed-out' && plain.message).toMatch(/Nothing was added\.$/u);
  });

  it('shows a note as plain words on one line, at most 200 characters', () => {
    expect(noteText(null)).toBeNull();
    expect(noteText('  .  ')).toBeNull();
    expect(noteText('the window does not show the page asked for yet')).toBe(
      'The window does not show the page asked for yet',
    );
    expect(noteText('A frame is visible.\n<b>Bold</b>\u202e\u0007 here..')).toBe(
      'A frame is visible. <b>Bold</b> here',
    );
    const long = noteText('Saltmarsh '.repeat(40))!;
    expect(Array.from(long).length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    expect(long.startsWith('Saltmarsh Saltmarsh')).toBe(true);
  });

  it('says why only after the still-waiting time or once the person is asked for', () => {
    const at = 1_000_000;
    const base = { startedAt: at, note: REASON };
    expect(whyItWaits({ ...base, now: at + 5000 })).toBeNull();
    expect(whyItWaits({ ...base, now: at + 5000, attention: true })).toBe(
      `Why it waits: ${REASON}`,
    );
    expect(whyItWaits({ ...base, now: at + STILL_WAITING_SECONDS * 1000 })).toBe(
      `Why it waits: ${REASON}`,
    );
    expect(
      whyItWaits({ ...base, now: at + STILL_WAITING_SECONDS * 1000, measuring: true }),
    ).toBeNull();
    expect(whyItWaits({ startedAt: at, now: at + 60_000, note: null, attention: true })).toBeNull();
  });
});
