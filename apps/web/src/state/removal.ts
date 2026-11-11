import { deletedProfile } from '@atlas/core';
import { deleteImagesResult, deletePackResult, plainError } from '../components/removalText';
import { desktop, type ImagesInfo } from '../desktop';
import { notify } from './actions';
import { loadDownloads } from './downloads';
import { applyListing } from './library';
import { clock, progressStore } from './services';
import { useAtlas } from './store';

/**
 * Deleting a pack, or only the map images downloaded for it, in the desktop
 * app. The shell stops a download of the pack first and does the deleting;
 * this module asks how much there is, runs the command, and brings the list,
 * the map and the download panel up to date. In a browser it does nothing.
 */

const get = useAtlas.getState;
const set = useAtlas.setState;

/** The outcome of a delete, for the confirmation that asked. */
export type RemovalOutcome = { ok: true } | { ok: false; error: string };

/** How many map images were downloaded for a pack; null if that cannot be told. */
export async function loadImagesInfo(id: string): Promise<ImagesInfo | null> {
  if (!desktop) return null;
  try {
    return await desktop.library.imagesInfo(id);
  } catch {
    return null;
  }
}

function titleOf(id: string): string {
  return (
    get().library?.packs.find((p) => p.id === id)?.title ??
    get().catalog.find((p) => p.id === id)?.title ??
    id
  );
}

/** Takes the pack out of the list at once, before the folders are looked at again. */
function dropFromList(id: string): void {
  const library = get().library;
  if (library) applyListing({ ...library, packs: library.packs.filter((p) => p.id !== id) });
}

/**
 * Deletes a pack, with its map images, from the maps folder, stopping its
 * download first. Progress kept in this app is deleted too only when asked.
 */
export async function deletePack(id: string, deleteProgress: boolean): Promise<RemovalOutcome> {
  if (!desktop) return { ok: false, error: 'Maps can only be deleted in the desktop app.' };
  const title = titleOf(id);
  let outcome;
  try {
    outcome = await desktop.library.deletePack(id);
  } catch (error) {
    return { ok: false, error: plainError(error, `delete ${title}`) };
  }
  dropFromList(id);
  if (deleteProgress) {
    try {
      const store = progressStore();
      for (const profile of await store.listProfiles(id)) {
        const rows = await store.listProgress(profile.id);
        await store.write(deletedProfile(profile, rows, clock()));
      }
    } catch {
      notify(`Deleted ${title}, but your progress for it could not be deleted.`, 'error');
      await refresh();
      return { ok: true };
    }
  }
  notify(deletePackResult(title, outcome, deleteProgress));
  await refresh();
  return { ok: true };
}

/**
 * Deletes the map images downloaded for a pack, stopping its download
 * first. The pack, its places and progress stay. When it is the game shown,
 * the map and the download panel start again from no images.
 */
export async function deleteImages(id: string): Promise<RemovalOutcome> {
  if (!desktop) return { ok: false, error: 'Map images can only be deleted in the desktop app.' };
  const title = titleOf(id);
  let outcome;
  try {
    outcome = await desktop.library.deleteImages(id);
  } catch (error) {
    return { ok: false, error: plainError(error, `delete the map images of ${title}`) };
  }
  notify(deleteImagesResult(title, outcome));
  const game = get().game;
  if (game && (game.entry.id === id || get().downloads.packFolder === id)) {
    set({ tileRevision: get().tileRevision + 1 });
    await loadDownloads(game);
  }
  return { ok: true };
}

async function refresh(): Promise<void> {
  if (!desktop) return;
  try {
    applyListing(await desktop.library.list());
  } catch {
    // The pack is out of the list already; the next refresh shows the rest.
  }
}
