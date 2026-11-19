import { formatBytes } from '../components/downloadFormat';
import {
  desktop,
  type FolderSize,
  type OldFolder,
  type OldFolders,
  type OldFoldersRemoved,
} from '../desktop';
import { loadGame } from './actions';
import { applyListing } from './library';
import { notePackSaved } from './packTurns';
import { useAtlas } from './store';

/**
 * Old folders, in the desktop app without downloads: the folder maps, wikis
 * and guides in the maps folder that the app no longer uses now that it
 * reads every map, wiki and guide from its pack file. The shell lists them
 * and measures each, and removes those the person confirmed (see the
 * shell's `oldfolders.rs`); this module runs those commands, lists the
 * games again after a removal and says in plain words what a removal does.
 */

const get = useAtlas.getState;
const set = useAtlas.setState;

/** The old folders of the maps folder, without their sizes. */
export function loadOldFolders(): Promise<OldFolders> {
  return desktop!.library.oldFolders();
}

/** How much room one old folder takes. */
export function measureOldFolder(folder: string): Promise<FolderSize> {
  return desktop!.library.oldFolderSize(folder);
}

/**
 * Removes the folders, lists the games again and, when the game shown had
 * its folder removed and is shown from its pack file now, opens it again
 * from there.
 */
export async function removeOldFolders(folders: readonly OldFolder[]): Promise<OldFoldersRemoved> {
  const result = await desktop!.library.removeOldFolders(
    folders.map(({ folder, id }) => ({ folder, id })),
  );
  const removed = result.removed.filter((done) => done.removed);
  for (const done of removed) notePackSaved(done.id);
  const shown = get().game?.entry.id;
  if (applyListing(result.listing) === 'taken' && shown) {
    const entry = removed.some((done) => done.id === shown)
      ? get().catalog.find((pack) => pack.id === shown)
      : undefined;
    if (entry) {
      set({ tileRevision: get().tileRevision + 1 });
      await loadGame(entry);
    }
  }
  return result;
}

/** "A, B and C", or "A, B, C, D, E and 3 more" for a long list. */
export function namesText(names: readonly string[], most = 5): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length > most + 1) {
    return `${names.slice(0, most).join(', ')} and ${names.length - most} more`;
  }
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
}

/** A folder's size as far as it is known: "measuring…", "1.2 GB" or "at least 1.2 GB". */
export function sizeText(size: FolderSize | undefined): string {
  if (!size) return 'measuring…';
  return size.complete ? formatBytes(size.bytes) : `at least ${formatBytes(size.bytes)}`;
}

/**
 * The question asked before removing folders: which, how many and how
 * much room they take, as far as that is measured.
 */
export function confirmText(
  folders: readonly OldFolder[],
  sizes: Readonly<Record<string, FolderSize | undefined>>,
): string {
  let bytes = 0;
  let measuring = 0;
  let partly = false;
  for (const folder of folders) {
    const size = sizes[folder.folder];
    if (!size) measuring += 1;
    else {
      bytes += size.bytes;
      if (!size.complete) partly = true;
    }
  }
  const one = folders.length === 1;
  const amount = `${partly || measuring > 0 ? 'at least ' : ''}${formatBytes(bytes)}`;
  const question = one
    ? `Remove the folder of ${folders[0]!.title} from the maps folder?`
    : `Remove ${folders.length} folders from the maps folder: ${namesText(folders.map((folder) => folder.title))}?`;
  const room =
    measuring === folders.length
      ? one
        ? 'Its size is still being measured.'
        : 'Their size is still being measured.'
      : one
        ? `It takes ${amount}.`
        : `Together they take ${amount}${measuring > 0 ? `; the size of ${measuring} of them is still being measured` : ''}.`;
  return `${question} ${room}`;
}

/**
 * What happens to the games once their folders are gone: shown from their
 * pack files, or no longer in the Library.
 */
export function afterText(folders: readonly OldFolder[]): string {
  const withFile = folders.filter((folder) => folder.packFile !== null).length;
  const without = folders.length - withFile;
  if (folders.length === 1) {
    return withFile === 1
      ? 'The game is then shown from its pack file.'
      : 'No pack file of this game is there, so it is then no longer in the Library.';
  }
  if (without === 0) return 'Each game is then shown from its pack file.';
  if (withFile === 0) {
    return 'No pack file of these games is there, so they are then no longer in the Library.';
  }
  const shown =
    withFile === 1
      ? '1 of them is then shown from its pack file'
      : `${withFile} of them are then shown from their pack files`;
  return `${shown}; the other ${without === 1 ? 'one is' : `${without} are`} no longer in the Library.`;
}

/** What a removal came to, in one or two sentences. */
export function removedText(result: OldFoldersRemoved): string {
  const done = result.removed.filter((one) => one.removed);
  const failed = result.removed.filter((one) => !one.removed);
  const later = done.filter((one) => !one.complete).length;
  const parts: string[] = [];
  if (done.length > 0) {
    parts.push(
      done.length === 1 ? 'Removed 1 folder.' : `Removed ${done.length} folders.`,
      ...(later > 0
        ? [
            `Some files of ${later === 1 ? 'one of them were' : `${later} of them were`} in use; they are removed when Atlas next starts.`,
          ]
        : []),
    );
  }
  if (failed.length > 0) {
    const reasons = [...new Set(failed.map((one) => one.problem).filter((p) => p !== null))];
    parts.push(
      `${failed.length === 1 ? '1 folder was' : `${failed.length} folders were`} not removed.`,
      ...reasons,
    );
  }
  return parts.join(' ');
}
