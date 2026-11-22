import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopInfo, UpdateCheck, UpdateProgress } from '../desktop';

/** The stand-in updater of the shell: what it answers, and what was asked of it. */
const shell = vi.hoisted(() => {
  const state: {
    check: unknown;
    checkFails: string | null;
    downloadFails: string | null;
    progress: unknown;
    calls: string[];
    settings: Map<string, unknown>;
  } = {
    check: null,
    checkFails: null,
    downloadFails: null,
    progress: null,
    calls: [],
    settings: new Map(),
  };
  return state;
});

vi.mock('../desktop', () => ({
  desktop: {
    updates: {
      check: () => {
        shell.calls.push('check');
        return shell.checkFails
          ? Promise.reject(new Error(shell.checkFails))
          : Promise.resolve(shell.check);
      },
      download: () => {
        shell.calls.push('download');
        return shell.downloadFails
          ? Promise.reject(new Error(shell.downloadFails))
          : Promise.resolve();
      },
      progress: () => Promise.resolve(shell.progress),
      install: () => {
        shell.calls.push('install');
        return Promise.resolve();
      },
    },
  },
}));

vi.mock('./saveAll', () => ({
  saveEverything: () => {
    shell.calls.push('save');
    return Promise.resolve();
  },
}));

vi.mock('./services', () => ({
  SETTINGS: { updateCheckAtStart: 'updateCheckAtStart', updateSkipped: 'updateSkipped' },
  progressStore: () => ({
    getSetting: (key: string) => Promise.resolve(shell.settings.get(key)),
    putSetting: (key: string, value: unknown) => {
      shell.settings.set(key, value);
      return Promise.resolve();
    },
  }),
}));

const updates = await import('./updates');
const { useAtlas } = await import('./store');

const AVAILABLE: UpdateCheck = {
  state: 'available',
  version: '0.27.0',
  current: '0.26.0',
  notes: '- **Routes.** A route is a path.\n- Fixed: a map.',
  date: '2026-11-20T10:00:00Z',
};

const app = (updatesWay: DesktopInfo['updates']): DesktopInfo => ({
  name: 'Atlas',
  version: '0.26.0',
  platform: 'windows',
  downloads: false,
  ...(updatesWay ? { updates: updatesWay } : {}),
});

beforeEach(() => {
  vi.useFakeTimers();
  updates.resetUpdatesForTests();
  shell.check = AVAILABLE;
  shell.checkFails = null;
  shell.downloadFails = null;
  shell.progress = { state: 'idle' } satisfies UpdateProgress;
  shell.calls = [];
  shell.settings.clear();
  useAtlas.setState({ app: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the setting "Check for updates when Atlas starts"', () => {
  it('is on unless the person turned it off', () => {
    expect(updates.checkAtStartSetting(undefined)).toBe(true);
    expect(updates.checkAtStartSetting(null)).toBe(true);
    expect(updates.checkAtStartSetting(true)).toBe(true);
    expect(updates.checkAtStartSetting(false)).toBe(false);
  });

  it('is read as on when nothing is kept, and kept when switched', async () => {
    await updates.loadUpdateSettings();
    expect(updates.useUpdates.getState().atStart).toBe(true);
    updates.setCheckAtStart(false);
    expect(shell.settings.get('updateCheckAtStart')).toBe(false);
    await updates.loadUpdateSettings();
    expect(updates.useUpdates.getState().atStart).toBe(false);
  });

  it('lets the start look only where the shell says it may', () => {
    expect(updates.looksAtStart({ way: 'itself', atStart: true }, true)).toBe(true);
    expect(updates.looksAtStart({ way: 'itself', atStart: true }, false)).toBe(false);
    expect(updates.looksAtStart({ way: 'itself', atStart: false }, true)).toBe(false);
    expect(updates.looksAtStart({ way: 'elsewhere', from: 'system' }, true)).toBe(false);
    expect(updates.looksAtStart(null, true)).toBe(false);
  });
});

describe('the look at the start', () => {
  it('waits a few seconds after the shell said it may, then opens the notice', async () => {
    updates.startUpdateCheck();
    await vi.advanceTimersByTimeAsync(updates.START_DELAY_MS * 2);
    // Nothing before the shell says what this copy is.
    expect(shell.calls).toEqual([]);
    useAtlas.setState({ app: app({ way: 'itself', atStart: true }) });
    await vi.advanceTimersByTimeAsync(updates.START_DELAY_MS - 100);
    expect(shell.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(shell.calls).toEqual(['check']);
    expect(updates.useUpdates.getState().notice).toBe(true);
  });

  it('says nothing when up to date or offline', async () => {
    shell.check = { state: 'upToDate', version: '0.26.0' } satisfies UpdateCheck;
    useAtlas.setState({ app: app({ way: 'itself', atStart: true }) });
    updates.startUpdateCheck();
    await vi.advanceTimersByTimeAsync(updates.START_DELAY_MS + 100);
    expect(updates.useUpdates.getState()).toMatchObject({ notice: false, problem: null });

    updates.resetUpdatesForTests();
    shell.checkFails = 'Atlas could not reach the update server.';
    updates.startUpdateCheck();
    await vi.advanceTimersByTimeAsync(updates.START_DELAY_MS + 100);
    expect(shell.calls).toEqual(['check', 'check']);
    expect(updates.useUpdates.getState()).toMatchObject({ notice: false, problem: null });
  });

  it('does not look when the setting is off, the start may not, or Atlas does not update itself', async () => {
    shell.settings.set('updateCheckAtStart', false);
    useAtlas.setState({ app: app({ way: 'itself', atStart: true }) });
    updates.startUpdateCheck();
    await vi.advanceTimersByTimeAsync(updates.START_DELAY_MS + 100);

    shell.settings.clear();
    for (const way of [
      { way: 'itself', atStart: false },
      { way: 'elsewhere', from: 'system' },
      undefined,
    ] as const) {
      updates.resetUpdatesForTests();
      useAtlas.setState({ app: app(way) });
      updates.startUpdateCheck();
      await vi.advanceTimersByTimeAsync(updates.START_DELAY_MS + 100);
    }
    expect(shell.calls).toEqual([]);
  });

  it('leaves out a version the person skipped, which Settings still finds', async () => {
    shell.settings.set('updateSkipped', '0.27.0');
    useAtlas.setState({ app: app({ way: 'itself', atStart: true }) });
    updates.startUpdateCheck();
    await vi.advanceTimersByTimeAsync(updates.START_DELAY_MS + 100);
    expect(updates.useUpdates.getState()).toMatchObject({ notice: false, found: AVAILABLE });

    await updates.checkForUpdates({ quiet: false });
    expect(updates.useUpdates.getState().notice).toBe(true);
  });
});

describe('the notice', () => {
  beforeEach(() => {
    useAtlas.setState({ app: app({ way: 'itself', atStart: false }) });
  });

  it('"Install now" downloads, saves the person’s changes, then installs', async () => {
    await updates.checkForUpdates({ quiet: false });
    shell.progress = { state: 'downloading', received: 5_000_000, total: 10_000_000 };
    const installing = updates.installUpdate();
    expect(updates.useUpdates.getState().phase).toBe('downloading');
    await vi.advanceTimersByTimeAsync(500);
    await installing;
    expect(shell.calls).toEqual(['check', 'download', 'save', 'install']);
    expect(updates.useUpdates.getState().phase).toBe('installing');
  });

  it('says why when the download does not work, and installs nothing', async () => {
    await updates.checkForUpdates({ quiet: false });
    shell.downloadFails = 'The update did not pass its check, so Atlas left it out.';
    await updates.installUpdate();
    expect(shell.calls).toEqual(['check', 'download']);
    expect(updates.useUpdates.getState()).toMatchObject({
      phase: 'failed',
      installProblem: 'The update did not pass its check, so Atlas left it out.',
    });
  });

  it('"Later" puts it away until the next start, "Skip this version" for good', async () => {
    await updates.checkForUpdates({ quiet: false });
    updates.updateLater();
    expect(updates.useUpdates.getState().notice).toBe(false);
    expect(shell.settings.has('updateSkipped')).toBe(false);
    updates.showUpdateNotice();
    expect(updates.useUpdates.getState().notice).toBe(true);
    updates.skipUpdate();
    expect(updates.useUpdates.getState().notice).toBe(false);
    expect(shell.settings.get('updateSkipped')).toBe('0.27.0');
    expect(shell.calls).toEqual(['check']);
  });

  it('Settings says what the look found, and why not', async () => {
    shell.check = { state: 'upToDate', version: '0.26.0' } satisfies UpdateCheck;
    await updates.checkForUpdates({ quiet: false });
    expect(updates.useUpdates.getState()).toMatchObject({
      found: { state: 'upToDate' },
      notice: false,
      problem: null,
    });
    shell.checkFails = 'Atlas could not reach the update server.';
    await updates.checkForUpdates({ quiet: false });
    expect(updates.useUpdates.getState().problem).toBe('Atlas could not reach the update server.');
  });
});

describe('words', () => {
  it('reads a release’s notes as paragraphs and list items without Markdown marks', () => {
    expect(
      updates.notesParts(
        '## New in 0.27.0\n\n- **Routes.** A path.\n* Uses `Atlas.AppImage`.\n\nTried by the automatic checks only.',
      ),
    ).toEqual([
      { kind: 'text', text: 'New in 0.27.0' },
      { kind: 'item', text: 'Routes. A path.' },
      { kind: 'item', text: 'Uses Atlas.AppImage.' },
      { kind: 'text', text: 'Tried by the automatic checks only.' },
    ]);
    expect(updates.notesParts('')).toEqual([]);
  });

  it('says how far a download is', () => {
    expect(updates.downloadText(0, null)).toBe('Downloading…');
    expect(updates.downloadText(2_500_000, null)).toBe('Downloading… 2.5 MB');
    expect(updates.downloadText(25_000_000, 100_000_000)).toBe(
      'Downloading… 25% (25.0 of 100.0 MB)',
    );
  });

  it('says where updates come from where Atlas does not update itself', () => {
    for (const from of ['otherApp', 'system', 'releases'] as const) {
      expect(updates.elsewhereText(from)).toMatch(/^Updates for this copy of Atlas come from /);
    }
  });

  it('uses the house words', () => {
    const texts = [
      updates.installText('windows'),
      updates.installText('linux'),
      ...(['otherApp', 'system', 'releases'] as const).map(updates.elsewhereText),
    ];
    for (const text of texts) expect(text).not.toMatch(/\b(click|tap|place|kind)\b/i);
  });
});
