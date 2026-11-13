import type { PackEntry } from '@atlas/core';
import { desktop, type FolderChoice, type Listing, type RevealTarget } from '../desktop';
import { loadGame, notify } from './actions';
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
  const listed = new Map(listing.packs.map((pack) => [pack.id, pack]));
  const entry = (pack: { id: string; url: string; title: string }): PackEntry => ({
    id: pack.id,
    url: pack.url,
    title: pack.title,
  });
  const first = bundled.map((pack) => entry(listed.get(pack.id) ?? pack));
  const rest = listing.packs
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

/** Takes in a listing; if the shown game has gone, shows the first one left. */
export function applyListing(listing: Listing): void {
  const catalog = catalogFrom(get().bundledCatalog, listing);
  set({ library: listing, catalog });
  const current = get().game?.entry;
  if (current && !catalog.some((p) => p.id === current.id) && catalog[0]) {
    notify(`${current.title} is no longer available, so ${catalog[0].title} is shown.`);
    void loadGame(catalog[0]);
  }
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
