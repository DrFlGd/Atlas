import type { PackEntry } from '@atlas/core';
import {
  desktop,
  type FolderChoice,
  type ListedPack,
  type Listing,
  type PackFileOpened,
  type RevealTarget,
} from '../desktop';
import { loadGame, notify } from './actions';
import { joinable, joinGuidebooks } from './guidebookData';
import { useAtlas } from './store';

/**
 * Where the desktop app finds packs: the packs that come with the app, the
 * maps folder, and pack folders or folders of packs the person added. The
 * shell looks at the folders and serves the packs; this module lists them,
 * keeps the game switcher current and runs the Maps dialog's commands. In a
 * browser it does nothing.
 */

const get = useAtlas.getState;
const set = useAtlas.setState;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The packs to offer: those that come with the app first, in their order
 * (a listed pack with the same id, such as one installed into the maps
 * folder, takes its place), then the others by title.
 */
export function catalogFrom(bundled: readonly PackEntry[], listing: Listing | null): PackEntry[] {
  if (!listing) return [...bundled];
  // A pack of guidebooks of a game here by its title is read with that game, not listed apart.
  const joined = joinGuidebooks(joinable(listing.packs, bundled), []);
  const packs = listing.packs.filter((pack) => !joined.has(pack.id));
  const listed = new Map(packs.map((pack) => [pack.id, pack]));
  const entry = (pack: { id: string; url: string; title: string }): PackEntry => ({
    id: pack.id,
    url: pack.url,
    title: pack.title,
  });
  const first = bundled.map((pack) => entry(listed.get(pack.id) ?? pack));
  const rest = packs
    .filter((pack) => !bundled.some((b) => b.id === pack.id))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
    .map(entry);
  return [...first, ...rest];
}

/** Looks at every pack folder again and updates the game switcher. */
export async function refreshLibrary(): Promise<Listing | null> {
  if (!desktop) return null;
  const listing = await desktop.library.list();
  applyListing(listing);
  return listing;
}

/**
 * Whether `listing` is older than `shown`: the shell numbers its listings
 * (`serial`), and one that arrives after a newer one is left out. A
 * listing without a number (an older shell) is never older.
 */
export function olderListing(listing: Listing, shown: Listing | null): boolean {
  return (
    listing.serial !== undefined && shown?.serial !== undefined && listing.serial < shown.serial
  );
}

/**
 * What to say when the game shown is not listed any more: for one read
 * from a pack file, that its file can no longer be read (with the reason
 * the listing gives) or cannot be found; for any other, that it is no
 * longer available. `other` is the game shown in its place. Exported for
 * tests.
 */
export function goneText(
  title: string,
  was: ListedPack | undefined,
  listing: Listing,
  other: string,
): string {
  if (!was?.packFile || !was.path) {
    return `${title} is no longer available, so ${other} is shown.`;
  }
  const unreadable = listing.unreadable?.find((file) => file.path === was.path);
  if (unreadable) {
    return `The pack file of ${title} can no longer be read, so it is not shown. ${unreadable.reason}`;
  }
  return `The pack file of ${title} cannot be found any more. It may have been moved, renamed or deleted, or be on a drive that is not connected, so ${title} is not shown.`;
}

/**
 * The game to show for what opening pack files from the file manager came
 * to, and what to say: the last one opened, and how many before it.
 */
export function openedOutcome(
  opened: readonly PackFileOpened[],
): { show: string | null; text: string; problem: boolean } | null {
  const last = opened.at(-1);
  if (!last) return null;
  const earlier = opened.length - 1;
  const more =
    earlier > 0
      ? ` ${earlier === 1 ? 'One more pack file was' : `${earlier} more pack files were`} opened before it.`
      : '';
  return { show: last.show, text: `${last.message}${more}`, problem: last.problem };
}

/**
 * Takes in a listing, unless a newer one was taken already (`older`); if
 * the shown game has gone, says so and shows the first one left (`gone`).
 */
export function applyListing(listing: Listing): 'taken' | 'older' | 'gone' {
  const previous = get().library;
  if (olderListing(listing, previous)) return 'older';
  const catalog = catalogFrom(get().bundledCatalog, listing);
  set({ library: listing, catalog });
  const current = get().game?.entry;
  // A pack of guidebooks shown alone that now joins a game: that game is shown.
  const host =
    current &&
    joinGuidebooks(joinable(listing.packs, get().bundledCatalog), []).get(current.id)?.[0];
  const hostEntry = host ? catalog.find((p) => p.id === host) : undefined;
  if (current && hostEntry && !catalog.some((p) => p.id === current.id)) {
    void loadGame(hostEntry);
    return 'gone';
  }
  if (current && !catalog.some((p) => p.id === current.id) && catalog[0]) {
    const was = previous?.packs.find((pack) => pack.id === current.id);
    notify(
      goneText(current.title, was, listing, catalog[0].title),
      was?.packFile ? 'error' : 'info',
    );
    void loadGame(catalog[0]);
    return 'gone';
  }
  return 'taken';
}

/** The Android app's Maps dialog. */
export function setMapsDialogOpen(open: boolean): void {
  set({ mapsDialogOpen: open });
  if (open) {
    refreshLibrary().catch((error: unknown) => {
      notify(errorText(error), 'error');
    });
  }
}

async function run<T>(task: () => Promise<T>): Promise<T | undefined> {
  try {
    return await task();
  } catch (error) {
    notify(errorText(error), 'error');
    return undefined;
  }
}

/** Asks for a pack folder, remembers it and shows its game. */
export async function openPackFolder(): Promise<void> {
  await run(async () => {
    const id = await desktop!.library.openPack();
    if (id === null) return;
    const listing = await refreshLibrary();
    const entry = get().catalog.find((p) => p.id === id);
    const hidden = listing?.hidden.find((h) => h.id === id);
    if (entry && !hidden) {
      await loadGame(entry);
      notify(`Added ${entry.title}.`);
    } else if (hidden) {
      notify(`Remembered the folder, but ${hidden.reason}`);
    }
  });
}

/** Asks for a folder of packs and remembers it. */
export async function addPacksFolder(): Promise<void> {
  await run(async () => {
    const count = await desktop!.library.addFolder();
    if (count === null) return;
    await refreshLibrary();
    notify(
      count === 0
        ? 'Remembered the folder. It has no map packs yet.'
        : `Remembered the folder with ${count} map pack${count === 1 ? '' : 's'}.`,
    );
  });
}

/** Takes a pack file off the list of pack files opened. The file is left alone. */
export async function forgetPackFile(path: string): Promise<void> {
  await run(async () => {
    await desktop!.library.forgetPackFile(path);
    await refreshLibrary();
    notify('Removed from the list. The pack file was not deleted.');
  });
}

/** Forgets a remembered location. Its files are left alone. */
export async function removeLocation(path: string): Promise<void> {
  await run(async () => {
    await desktop!.library.removeLocation(path);
    await refreshLibrary();
    notify('Removed from the list. No files were deleted.');
  });
}

export function chooseMapsFolder(): Promise<FolderChoice | null | undefined> {
  return run(() => desktop!.library.chooseMapsFolder());
}

/** Uses the chosen maps folder from now on, moving the maps there or not. */
export async function applyMapsFolder(movePacks: boolean): Promise<boolean> {
  const moved = await run(async () => {
    const ids = await desktop!.library.applyMapsFolder(movePacks);
    await refreshLibrary();
    return ids;
  });
  if (!moved) return false;
  notify(
    movePacks
      ? `Moved ${moved.length} map pack${moved.length === 1 ? '' : 's'} to the new maps folder.`
      : 'New maps are saved in the new folder from now on. The old folder is still listed.',
  );
  return true;
}

export function reveal(target: RevealTarget): void {
  void run(() => desktop!.library.reveal(target));
}
