import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPageViewBridge,
  pageViewShell,
  type PageViewBridge,
  type ViewStatus,
} from '../pageViewBridge';
import {
  closeMapPage,
  countPhrases,
  dismissMapPage,
  headline,
  loadPages,
  openMapPage,
  pageLabel,
  problemNotes,
  receiveStatus,
  setPageViewShell,
  shouldShow,
  stopSaving,
  usePageView,
} from './pageView';
import { useAtlas } from './store';
import { useLibrary } from './libraryView';

const status = (patch: Partial<ViewStatus> = {}): ViewStatus => ({
  open: true,
  packId: 'my-game',
  url: 'https://maps.example.com/my-game/world',
  saving: true,
  savedSession: true,
  counts: {
    saved: 0,
    alreadyHad: 0,
    notOnServer: 0,
    notSaved: 0,
    fromElements: 0,
    otherProblems: 0,
    bytes: 0,
  },
  usesWorkers: false,
  revision: 0,
  message: null,
  ...patch,
});

/** A shell stand-in that answers with the statuses given, one per call. */
function fakeShell(answers: Partial<Record<keyof PageViewBridge, unknown[]>>) {
  const calls: string[] = [];
  const answer = (name: keyof PageViewBridge) => {
    calls.push(name);
    const list = answers[name] ?? [];
    const next = list.length > 1 ? list.shift() : list[0];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  const bridge = {
    pages: () => answer('pages'),
    open: () => answer('open'),
    status: () => answer('status'),
    stopSaving: () => answer('stopSaving'),
    close: () => answer('close'),
    openInBrowser: () => answer('openInBrowser'),
  } as PageViewBridge;
  return { bridge, calls };
}

afterEach(() => {
  vi.useRealTimers();
  setPageViewShell(null);
  usePageView.setState({ pages: {}, status: null, pending: false });
});

describe('map page bridge', () => {
  it('is absent in a browser', () => {
    expect(pageViewShell).toBeNull();
  });

  it('calls the shell commands with their arguments', async () => {
    const calls: [string, unknown][] = [];
    const bridge = createPageViewBridge((command, args) => {
      calls.push([command, args]);
      return Promise.resolve(null);
    });
    await bridge.pages('my-game');
    await bridge.open('my-game', 'https://maps.example.com/a', true);
    await bridge.status();
    await bridge.stopSaving();
    await bridge.close();
    await bridge.openInBrowser('my-game', 'https://maps.example.com/a');
    expect(calls).toEqual([
      ['view_pages', { packId: 'my-game' }],
      ['view_open', { packId: 'my-game', url: 'https://maps.example.com/a', save: true }],
      ['view_status', undefined],
      ['view_stop_saving', undefined],
      ['view_close', undefined],
      ['view_open_in_browser', { packId: 'my-game', url: 'https://maps.example.com/a' }],
    ]);
  });

  it('passes on refusals as plain errors', async () => {
    // Tauri rejects with the command's error value, here a string.
    const bridge = createPageViewBridge(() =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      Promise.reject('Only pages this map pack was made from can be opened.'),
    );
    await expect(bridge.open('my-game', 'https://other.example.com/', false)).rejects.toThrow(
      'Only pages this map pack was made from can be opened.',
    );
  });
});

describe('map page words', () => {
  it('names pages by their map, else by their address', () => {
    const page = {
      url: 'https://maps.example.com/my-game/world?x=1',
      mapId: null,
      importedAt: null,
    };
    expect(pageLabel({ ...page, mapName: 'World' })).toBe('World');
    expect(pageLabel({ ...page, mapName: null })).toBe('maps.example.com/my-game/world');
    expect(pageLabel({ ...page, url: 'https://maps.example.com/', mapName: null })).toBe(
      'maps.example.com',
    );
  });

  it('counts plainly', () => {
    const counts = {
      saved: 1234,
      alreadyHad: 1,
      notOnServer: 12,
      notSaved: 0,
      fromElements: 0,
      otherProblems: 0,
    };
    expect(countPhrases({ ...counts, bytes: 0 })).toEqual([
      '1,234 saved',
      '1 already had',
      '12 not on the server (the map’s edge)',
      '0 could not be saved',
    ]);
  });

  it('explains what could not be saved, and only then', () => {
    expect(problemNotes(status())).toEqual([]);
    const notes = problemNotes(
      status({
        counts: {
          saved: 3,
          alreadyHad: 0,
          notOnServer: 2,
          notSaved: 3,
          fromElements: 2,
          otherProblems: 1,
          bytes: 9,
        },
        usesWorkers: true,
      }),
    );
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatch(
      /^Some map images on this page could not be saved this way \(2 map images so far\)/,
    );
    expect(notes[0]).toMatch(/Download map images/);
    expect(notes[1]).toBe(
      '1 map image could not be saved for another reason: the page did not let Atlas read it, the server answered with an error, it was not a usable image, or too many came at once.',
    );
    expect(notes[2]).toMatch(/in the background/);
  });

  it('says what the window is doing', () => {
    expect(headline(status())).toBe('Saving map images as you browse');
    expect(headline(status({ saving: false }))).toBe('Map page open · saving stopped');
    expect(headline(status({ saving: false, savedSession: false }))).toBe('Map page open');
    expect(headline(status({ open: false, saving: false }))).toBe(
      'Map page closed · saving stopped',
    );
    expect(shouldShow(null)).toBe(false);
    expect(shouldShow(status({ open: false, saving: false, savedSession: false }))).toBe(false);
    expect(shouldShow(status({ open: false, saving: false }))).toBe(true);
  });
});

describe('map page state', () => {
  it('lists a pack’s pages, or says why not', async () => {
    const info = { pages: [], canSave: false, saveNote: 'No.' };
    const { bridge } = fakeShell({
      pages: [info, new Error('That map pack is not there any more.')],
    });
    setPageViewShell(bridge);
    await loadPages('my-game');
    expect(usePageView.getState().pages['my-game']).toEqual({ state: 'ready', info });
    await loadPages('gone');
    expect(usePageView.getState().pages.gone).toEqual({
      state: 'failed',
      message: 'That map pack is not there any more.',
    });
  });

  it('opens a page, polls while it is open and shows the counts after it closes', async () => {
    vi.useFakeTimers();
    useAtlas.setState({ tileRevision: 0 });
    useLibrary.setState({ windowOpen: true });
    const saved = status({
      revision: 1,
      counts: {
        saved: 4,
        alreadyHad: 1,
        notOnServer: 1,
        notSaved: 0,
        fromElements: 0,
        otherProblems: 0,
        bytes: 9,
      },
    });
    const closed = { ...saved, open: false, saving: false, revision: 2 };
    const { bridge, calls } = fakeShell({ open: [status()], status: [saved, closed] });
    setPageViewShell(bridge);

    expect(await openMapPage('my-game', 'https://maps.example.com/my-game/world', true)).toBe(true);
    expect(useLibrary.getState().windowOpen).toBe(false);
    expect(usePageView.getState().status?.saving).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(usePageView.getState().status?.counts.saved).toBe(4);
    expect(usePageView.getState().status?.counts.notOnServer).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(usePageView.getState().status?.open).toBe(false);
    expect(shouldShow(usePageView.getState().status)).toBe(true);
    // No more polling once the window is closed.
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.filter((c) => c === 'status')).toHaveLength(2);
    dismissMapPage();
    expect(usePageView.getState().status).toBeNull();
  });

  it('tells the map to look again when images were saved, of the shown game or another', () => {
    useAtlas.setState({
      game: { entry: { id: 'my-game', url: 'x', title: 'My Game' } } as never,
    });
    receiveStatus(status({ open: false, saving: false, revision: 10 }));
    const before = useAtlas.getState().tileRevision;
    receiveStatus(status({ open: false, saving: false, revision: 10 }));
    expect(useAtlas.getState().tileRevision).toBe(before);
    receiveStatus(status({ open: false, saving: false, revision: 11 }));
    expect(useAtlas.getState().tileRevision).toBe(before + 1);
    receiveStatus(status({ open: false, saving: false, packId: 'other', revision: 12 }));
    expect(useAtlas.getState().tileRevision).toBe(before + 2);
    useAtlas.setState({ game: null });
  });

  it('stops saving and closes, and reports refusals', async () => {
    const stopped = status({ saving: false });
    const gone = status({ open: false, saving: false, savedSession: false });
    const { bridge } = fakeShell({
      stopSaving: [stopped],
      close: [gone],
      open: [new Error('Map images of this game are downloading.')],
    });
    setPageViewShell(bridge);
    expect(await stopSaving()).toBe(true);
    expect(usePageView.getState().status?.saving).toBe(false);
    expect(await closeMapPage()).toBe(true);
    expect(usePageView.getState().status).toBeNull();
    expect(await openMapPage('my-game', 'https://maps.example.com/my-game/world', true)).toBe(
      false,
    );
    expect(useAtlas.getState().notice?.text).toBe('Map images of this game are downloading.');
    expect(useAtlas.getState().notice?.tone).toBe('error');
  });
});
