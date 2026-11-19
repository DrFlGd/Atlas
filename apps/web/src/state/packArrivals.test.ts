import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListedPack, Listing, PackFileOpened } from '../desktop';

const reloadShownGame = vi.fn((_id: string) => Promise.resolve(true));
const notify = vi.fn();
const loadGame = vi.fn(() => Promise.resolve());
vi.mock('./actions', () => ({ reloadShownGame, notify, loadGame }));

const openLibrary = vi.fn();
const showGame = vi.fn(() => Promise.resolve());
vi.mock('./libraryView', () => ({ libraryOffered: () => true, openLibrary, showGame }));

/** The shell, as far as these steps use it: its two events and the Library. */
const shell = {
  libraryChanged: null as ((listing: Listing) => void) | null,
  packFileOpened: null as (() => void) | null,
  opened: [] as PackFileOpened[],
  listing: null as Listing | null,
};
vi.mock('../desktop', () => ({
  desktop: {
    events: {
      libraryChanged: (handler: (listing: Listing) => void) => {
        shell.libraryChanged = handler;
        return Promise.resolve(() => {
          shell.libraryChanged = null;
        });
      },
      packFileOpened: (handler: () => void) => {
        shell.packFileOpened = handler;
        return Promise.resolve(() => {
          shell.packFileOpened = null;
        });
      },
    },
    library: {
      takeOpened: () => Promise.resolve(shell.opened.splice(0)),
      list: () => Promise.resolve(shell.listing),
    },
  },
}));

const { useAtlas } = await import('./store');
const {
  arrivalText,
  followArrivals,
  loadArrived,
  otherVersion,
  useArrival,
  dismissArrival,
  ARRIVAL_KEEPS,
} = await import('./packArrivals');

const packFile = (
  id: string,
  title: string,
  path: string,
  changed: number | null,
  made: number | null = 1,
): ListedPack => ({
  id,
  title,
  url: `atlas-pack://localhost/${id}/`,
  origin: 'opened-file',
  path,
  packVersion: '1.0.0',
  bundled: false,
  imported: null,
  packFile: true,
  fileVersion: { changed, made },
});

const listing = (serial: number, packs: ListedPack[], extra: Partial<Listing> = {}): Listing => ({
  mapsFolder: { path: '/maps', isDefault: true, exists: true },
  packs,
  hidden: [],
  locations: [],
  busy: [],
  serial,
  ...extra,
});

type Game = NonNullable<ReturnType<typeof useAtlas.getState>['game']>;

/** Shows a game, as loading it does. */
const show = (pack: ListedPack) => {
  useAtlas.setState({
    game: { entry: { id: pack.id, title: pack.title, url: pack.url } } as unknown as Game,
  });
};

const valley = packFile('example-game', 'Example Game', '/files/example.atlaspack', 100);

let stop: () => void = () => undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  shell.opened = [];
  useArrival.setState({ note: null });
  useAtlas.setState({ game: null, library: listing(1, [valley]), bundledCatalog: [] });
  stop = followArrivals();
  // The events are listened to once their promises resolve.
  await Promise.resolve();
  show(valley);
});

afterEach(() => {
  stop();
});

describe('which version of a pack file arrived', () => {
  const seen = (path: string, changed: number | null, made: number | null, file = true) => ({
    path,
    packFile: file,
    changed,
    made,
  });

  it('is none when the same file and version is listed', () => {
    expect(otherVersion(seen('/a', 1, 1), seen('/a', 1, 1))).toBeNull();
    expect(otherVersion(seen('/a', 1, 1, false), seen('/b', 2, 2, false))).toBeNull();
    expect(otherVersion(null, seen('/a', 1, 1))).toBeNull();
  });

  it('is newer by when its pack was changed, then by when the file was made', () => {
    expect(otherVersion(seen('/a', 1, 1), seen('/a', 2, 1))).toEqual({ newer: true });
    expect(otherVersion(seen('/a', 2, 1), seen('/b', 1, 9))).toEqual({ newer: false });
    expect(otherVersion(seen('/a', 1, 1), seen('/a', 1, 2))).toEqual({ newer: true });
    expect(otherVersion(seen('/a', null, 1), seen('/a', 1, null))).toEqual({ newer: true });
  });

  it('is another, not a newer one, between a folder and a pack file', () => {
    expect(otherVersion(seen('/a', 1, 1, false), seen('/b', 5, 5))).toEqual({ newer: false });
  });
});

describe('the note when the pack file of the game shown is replaced', () => {
  it('appears when the shell lists a newer version, and says what loading it keeps', () => {
    expect(shell.libraryChanged).not.toBeNull();
    shell.libraryChanged!(listing(2, [{ ...valley, fileVersion: { changed: 200, made: 1 } }]));
    const note = useArrival.getState().note;
    expect(note).toEqual({ id: 'example-game', title: 'Example Game', newer: true });
    expect(arrivalText(note!)).toBe('A newer version of Example Game has arrived.');
    expect(ARRIVAL_KEEPS).toBe(
      'Loading it keeps the map and location you are on, the page you are reading and your found marks.',
    );
    // Nothing was loaded, and the person was not taken anywhere.
    expect(reloadShownGame).not.toHaveBeenCalled();
    expect(loadGame).not.toHaveBeenCalled();
    expect(openLibrary).not.toHaveBeenCalled();
  });

  it('says another version when the one listed now is not newer', () => {
    shell.libraryChanged!(
      listing(2, [
        { ...valley, path: '/files/older.atlaspack', fileVersion: { changed: 50, made: 1 } },
      ]),
    );
    const note = useArrival.getState().note;
    expect(note?.newer).toBe(false);
    expect(arrivalText(note!)).toBe('Another version of Example Game has arrived.');
  });

  it('stays away when the listing changed for another game only', () => {
    const other = packFile('example-other', 'Example Other', '/files/other.atlaspack', 5);
    shell.libraryChanged!(listing(2, [valley, other]));
    expect(useArrival.getState().note).toBeNull();
  });

  it('leaves out a listing that arrives after a newer one', () => {
    shell.libraryChanged!(listing(3, [valley]));
    shell.libraryChanged!(listing(2, [{ ...valley, fileVersion: { changed: 200, made: 1 } }]));
    expect(useArrival.getState().note).toBeNull();
    expect(useAtlas.getState().library?.serial).toBe(3);
  });

  it('Load it loads the game shown again and says so; loading it puts the note away', async () => {
    const newer = { ...valley, fileVersion: { changed: 200, made: 1 } };
    shell.libraryChanged!(listing(2, [newer]));
    reloadShownGame.mockImplementationOnce(() => {
      // Loading it shows the game again, now from the file that arrived.
      show(newer);
      return Promise.resolve(true);
    });
    await loadArrived();
    expect(reloadShownGame).toHaveBeenCalledWith('example-game');
    expect(notify).toHaveBeenCalledWith('Loaded the version of Example Game that arrived.');
    expect(useArrival.getState().note).toBeNull();
    // The version now shown is the one the note compares with.
    shell.libraryChanged!(listing(3, [newer]));
    expect(useArrival.getState().note).toBeNull();
  });

  it('says so when the version that arrived could not be loaded', async () => {
    shell.libraryChanged!(listing(2, [{ ...valley, fileVersion: { changed: 200, made: 1 } }]));
    reloadShownGame.mockResolvedValueOnce(false);
    await loadArrived();
    expect(notify).toHaveBeenCalledWith(
      'The version of Example Game that arrived could not be loaded. The one you were reading is still shown.',
      'error',
    );
  });

  it('Not now puts it away', () => {
    shell.libraryChanged!(listing(2, [{ ...valley, fileVersion: { changed: 200, made: 1 } }]));
    dismissArrival();
    expect(useArrival.getState().note).toBeNull();
  });
});

describe('when the pack file of the game shown goes', () => {
  const other = packFile('example-other', 'Example Other', '/files/other.atlaspack', 5);

  it('says so plainly, shows another game and opens the Library', () => {
    shell.libraryChanged!(listing(2, [{ ...valley, fileVersion: { changed: 200, made: 1 } }]));
    shell.libraryChanged!(listing(3, [other]));
    expect(notify).toHaveBeenCalledWith(
      'The pack file of Example Game cannot be found any more. It may have been moved, renamed or deleted, or be on a drive that is not connected, so Example Game is not shown.',
      'error',
    );
    expect(loadGame).toHaveBeenCalledWith({
      id: 'example-other',
      title: 'Example Other',
      url: other.url,
    });
    expect(openLibrary).toHaveBeenCalledTimes(1);
    expect(useArrival.getState().note).toBeNull();
  });

  it('gives the reason when it can no longer be read', () => {
    shell.libraryChanged!(
      listing(2, [other], {
        unreadable: [
          { path: '/files/example.atlaspack', reason: 'This file is not an Atlas pack file.' },
        ],
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      'The pack file of Example Game can no longer be read, so it is not shown. This file is not an Atlas pack file.',
      'error',
    );
    expect(openLibrary).toHaveBeenCalledTimes(1);
  });
});

describe('a pack file opened from the file manager while Atlas runs', () => {
  const opened = (show: string | null, message: string, problem = false): PackFileOpened => ({
    path: '/files/example.atlaspack',
    show,
    remembered: true,
    problem,
    message,
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('loads the game shown again when it is the one opened', async () => {
    shell.listing = listing(2, [valley]);
    shell.opened = [opened('example-game', 'Showing Example Game from example.atlaspack.')];
    shell.packFileOpened!();
    await settle();
    expect(reloadShownGame).toHaveBeenCalledWith('example-game');
    expect(showGame).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('Showing Example Game from example.atlaspack.', 'info');
  });

  it('shows another game, and says how many were opened before it', async () => {
    const other = packFile('example-other', 'Example Other', '/files/other.atlaspack', 5);
    shell.listing = listing(2, [valley, other]);
    shell.opened = [
      opened('example-game', 'first'),
      opened('example-other', 'Showing Example Other from other.atlaspack.'),
    ];
    shell.packFileOpened!();
    await settle();
    expect(showGame).toHaveBeenCalledWith('example-other');
    expect(notify).toHaveBeenCalledWith(
      'Showing Example Other from other.atlaspack. One more pack file was opened before it.',
      'info',
    );
  });

  it('says what went wrong and shows nothing else', async () => {
    shell.listing = listing(2, [valley]);
    shell.opened = [
      opened(
        null,
        'Atlas could not open broken.atlaspack. This file is not an Atlas pack file.',
        true,
      ),
    ];
    shell.packFileOpened!();
    await settle();
    expect(showGame).not.toHaveBeenCalled();
    expect(reloadShownGame).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      'Atlas could not open broken.atlaspack. This file is not an Atlas pack file.',
      'error',
    );
  });
});

describe('stopping', () => {
  it('stops listening to the shell', () => {
    stop();
    expect(shell.libraryChanged).toBeNull();
    expect(shell.packFileOpened).toBeNull();
  });
});
