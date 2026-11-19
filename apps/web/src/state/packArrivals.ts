import { create } from 'zustand';
import { desktop, type ListedPack, type Listing } from '../desktop';
import { notify, reloadShownGame } from './actions';
import { applyListing, openedOutcome, refreshLibrary } from './library';
import { libraryOffered, openLibrary, showGame } from './libraryView';
import { useAtlas } from './store';

/**
 * Pack files that arrive while the desktop app runs. The shell follows the
 * folders it reads pack files from and sends the Library's listing when it
 * changed by itself, and tells when a pack file was opened from the file
 * manager (see the shell's `receive` module). This module takes both in:
 *
 * - A listing that changed is taken in, so the Library updates by itself.
 * - When the pack file of the game shown was replaced by another version
 *   (the same file written again, or another file of the same game that
 *   is now the one shown), the person is not thrown out of what they read:
 *   a quiet note says so, with a button that loads it (see
 *   {@link loadArrived}).
 * - When the game shown went (its pack file was moved or deleted, or can
 *   no longer be read), a plain sentence says so (see `goneText`) and the
 *   Library opens, rather than the map showing errors.
 * - A pack file opened from the file manager is shown, with a sentence on
 *   what came of it.
 *
 * In a browser and on Android nothing arrives.
 */

const get = useAtlas.getState;

/** The note on the game shown when another version of its pack file arrived. */
export interface ArrivalNote {
  id: string;
  title: string;
  /** The version that arrived is newer than the one shown, by its description. */
  newer: boolean;
}

export const useArrival = create<{ note: ArrivalNote | null }>(() => ({ note: null }));

/** Where a game was read from: its folder or pack file, and for a pack file which version. */
export interface FileSeen {
  path: string | null;
  packFile: boolean;
  changed: number | null;
  made: number | null;
}

/** Where a listed game is read from; null when it is not listed. */
export function fileOf(pack: ListedPack | undefined): FileSeen | null {
  if (!pack) return null;
  return {
    path: pack.path,
    packFile: pack.packFile === true,
    changed: pack.fileVersion?.changed ?? null,
    made: pack.fileVersion?.made ?? null,
  };
}

/**
 * Whether a game is listed now from another pack file, or another version
 * of one, than it was loaded from; if so, whether it is newer: by when its
 * pack was changed, then by when the file was made, as the shell's rule
 * for two pack files of one game. Null when it is the same, or neither is
 * a pack file. Exported for tests.
 */
export function otherVersion(
  loaded: FileSeen | null,
  now: FileSeen | null,
): { newer: boolean } | null {
  if (!loaded || !now || (!loaded.packFile && !now.packFile)) return null;
  if (
    loaded.path === now.path &&
    loaded.packFile === now.packFile &&
    loaded.changed === now.changed &&
    loaded.made === now.made
  ) {
    return null;
  }
  if (!loaded.packFile || !now.packFile) return { newer: false };
  const key = (file: FileSeen): [number, number] => [file.changed ?? -1, file.made ?? -1];
  const [a, b] = [key(now), key(loaded)];
  return { newer: a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]) };
}

/** The note's words. Exported for tests. */
export function arrivalText(note: ArrivalNote): string {
  return note.newer
    ? `A newer version of ${note.title} has arrived.`
    : `Another version of ${note.title} has arrived.`;
}

/** What loading the version that arrived keeps, in the note's words. */
export const ARRIVAL_KEEPS =
  'Loading it keeps the map and location you are on, the page you are reading and your found marks.';

/** The pack file version the game shown was loaded from. */
let loadedFrom: { id: string; file: FileSeen | null } | null = null;

/** Remembers what the game shown was read from, whenever another is shown or it is loaded again. */
function noteLoaded(): void {
  const { game, library } = get();
  const id = game?.entry.id ?? null;
  loadedFrom = id ? { id, file: fileOf(library?.packs.find((pack) => pack.id === id)) } : null;
  useArrival.setState({ note: null });
}

/**
 * Whenever the Library's listing changes (sent by the shell, or after Look
 * again): the game shown gets the note when another version of its pack
 * file is listed now, and loses it when the one it was loaded from is
 * listed again.
 */
function checkShown(): void {
  const { game, library } = get();
  const shown = game?.entry;
  if (!shown || !library || loadedFrom?.id !== shown.id) return;
  const listed = library.packs.find((pack) => pack.id === shown.id);
  const change = otherVersion(loadedFrom.file, fileOf(listed));
  useArrival.setState({
    note: change && listed ? { id: shown.id, title: listed.title, newer: change.newer } : null,
  });
}

/**
 * Takes in a listing the shell sent by itself: the Library updates (and
 * with it the note, see {@link followArrivals}), and the Library opens
 * when the game shown went.
 */
export function takeListing(listing: Listing): void {
  if (applyListing(listing) !== 'gone') return;
  useArrival.setState({ note: null });
  if (libraryOffered(get())) openLibrary();
}

/**
 * "Load it" on the note: loads the game shown again from the pack file now
 * listed for it, keeping where the person is as far as it is still in the
 * game (see `reloadShownGame`).
 */
export async function loadArrived(): Promise<void> {
  const note = useArrival.getState().note;
  if (!note) return;
  const loaded = await reloadShownGame(note.id);
  if (loaded) {
    notify(`Loaded the version of ${note.title} that arrived.`);
  } else {
    notify(
      `The version of ${note.title} that arrived could not be loaded. The one you were reading is still shown.`,
      'error',
    );
  }
}

/** "Not now" on the note. */
export function dismissArrival(): void {
  useArrival.setState({ note: null });
}

/**
 * Shows what opening pack files from the file manager came to: the game
 * it shows (loaded again when it is the one shown already, since its file
 * may be another one now) and the sentence.
 */
export async function receiveOpened(): Promise<void> {
  if (!desktop) return;
  const outcome = openedOutcome(await desktop.library.takeOpened());
  if (!outcome) return;
  await refreshLibrary().catch(() => null);
  if (outcome.show) {
    if (get().game?.entry.id === outcome.show) await reloadShownGame(outcome.show);
    else await showGame(outcome.show);
  }
  notify(outcome.text, outcome.problem ? 'error' : 'info');
}

/** Resolves once the first game is shown (the app has started). */
function started(): Promise<void> {
  if (get().game) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = useAtlas.subscribe((state) => {
      if (!state.game) return;
      stop();
      resolve();
    });
  });
}

/**
 * Follows the shell's events, the game shown and the Library's listing,
 * from the app's start;
 * the function it returns stops. A pack file opened before the app has
 * started is taken at its start (see `boot`), and one opened meanwhile
 * once it has.
 */
export function followArrivals(): () => void {
  const bridge = desktop;
  if (!bridge) return () => undefined;
  const stopGame = useAtlas.subscribe((state, previous) => {
    if (state.game !== previous.game) noteLoaded();
    else if (state.library !== previous.library) checkShown();
  });
  const stops: (() => void)[] = [stopGame];
  let stopped = false;
  const keep = (stop: () => void) => {
    if (stopped) stop();
    else stops.push(stop);
  };
  void bridge.events
    .libraryChanged((listing) => {
      takeListing(listing);
    })
    .then(keep, () => undefined);
  void bridge.events
    .packFileOpened(() => {
      void started()
        .then(receiveOpened)
        .catch((error: unknown) => {
          notify(error instanceof Error ? error.message : String(error), 'error');
        });
    })
    .then(keep, () => undefined);
  return () => {
    stopped = true;
    for (const stop of stops.splice(0)) stop();
  };
}
