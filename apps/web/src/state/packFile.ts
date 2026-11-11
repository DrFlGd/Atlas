import {
  desktop,
  type Detail,
  type PackDetails,
  type PackFileExported,
  type PackFileImported,
  type PackFileInfo,
  type PackFileOptions,
  type PackFileProgress,
} from '../desktop';
import { exportProgress, loadGame, notify } from './actions';
import { applyListing } from './library';
import { useAtlas } from './store';

/**
 * Map pack files (`.atlaspack`), in the desktop app: one game with the map
 * images chosen, in one file, to take to another computer or to Atlas for
 * Android. The Android app imports them too, after copying the file the
 * system's picker gave into the app. The shell writes and reads the files; this module opens the
 * dialog, runs its commands and shows the imported game. Personal data
 * never goes into a pack file: progress is saved beside it, in a file of
 * its own, only when asked for.
 */

const get = useAtlas.getState;
const set = useAtlas.setState;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function openExport(packId: string, title: string): void {
  set({ packFileDialog: { kind: 'export', packId, title } });
}

/**
 * The copy of a picked file the Android app made for the import dialog
 * shown now, if any. It is deleted once the import has finished, or when
 * the dialog closes (after a failed or cancelled import, or none), so a
 * failed import can be tried again without copying the file again.
 */
let pickedCopy: string | null = null;

function discardPickedCopy(): void {
  const path = pickedCopy;
  if (path === null) return;
  pickedCopy = null;
  desktop!.packFiles.discardCopy(path).catch((error: unknown) => {
    console.error(error);
  });
}

export function closePackFileDialog(): void {
  set({ packFileDialog: null });
  discardPickedCopy();
}

/** Asks for a map pack file and shows what importing it would do. */
export async function pickPackFile(): Promise<void> {
  try {
    const file = await desktop!.packFiles.pick();
    if (file) set({ packFileDialog: { kind: 'import', file } });
  } catch (error) {
    notify(errorText(error), 'error');
  }
}

/**
 * Shows what importing the map pack file at `path` would do: for a file the
 * app has a path for without asking, such as one the Android app copied
 * from the system's picker.
 */
export async function openPackFileAt(path: string): Promise<void> {
  try {
    set({ packFileDialog: { kind: 'import', file: await desktop!.packFiles.inspect(path) } });
  } catch (error) {
    notify(errorText(error), 'error');
  }
}

/**
 * "Import map pack file…" in the Android app: asks for a file with the
 * system's picker, copies it into the app (the picker gives no path; the
 * dialog shows how far the copy is, with Cancel), then shows what
 * importing it would do. The copy is deleted when the import is over.
 */
export async function importPickedPackFile(): Promise<void> {
  let path: string;
  try {
    const picked = await desktop!.packFiles.pickCopy();
    if (!picked) return;
    discardPickedCopy();
    set({ packFileDialog: { kind: 'copy', picked } });
    path = await desktop!.packFiles.copyPicked();
    pickedCopy = path;
  } catch (error) {
    if (get().packFileDialog?.kind === 'copy') closePackFileDialog();
    notify(errorText(error), 'error');
    return;
  }
  // Still copying when the dialog closed: the copy is not wanted.
  if (get().packFileDialog?.kind !== 'copy') {
    discardPickedCopy();
    return;
  }
  await openPackFileAt(path);
  // The copy could not be read (openPackFileAt said why).
  if (get().packFileDialog?.kind !== 'import') closePackFileDialog();
}

export function loadExportOptions(packId: string): Promise<PackFileOptions> {
  return desktop!.packFiles.options(packId);
}

export function loadPackDetails(packId: string): Promise<PackDetails> {
  return desktop!.packFiles.details(packId);
}

/**
 * Asks where to save and writes the map pack file. With `withProgress`, the
 * progress of every game and profile is saved beside it, exactly as
 * "Export all profiles" saves it: that export cannot be limited to one
 * game. Null when the person closed the save dialog; throws the shell's
 * plain-words error.
 */
export async function exportPackFile(
  packId: string,
  detail: Detail,
  withProgress: boolean,
): Promise<PackFileExported | null> {
  const progress = withProgress
    ? `${JSON.stringify(await exportProgress({ scope: 'all' }), null, 2)}\n`
    : undefined;
  return desktop!.packFiles.export(packId, detail, progress);
}

/**
 * Imports a map pack file, then lists the packs again and shows the game:
 * from its new files, when it replaced the game shown.
 */
export async function importPackFile(
  file: PackFileInfo,
  replace: boolean,
): Promise<PackFileImported> {
  const imported = await desktop!.packFiles.import(file.path, replace);
  // The game is in the maps folder: Android's copy of the file is not needed.
  if (pickedCopy === file.path) discardPickedCopy();
  applyListing(imported.listing);
  const entry = get().catalog.find((pack) => pack.id === imported.packId);
  if (entry) {
    set({ tileRevision: get().tileRevision + 1 });
    await loadGame(entry);
  }
  return imported;
}

export function packFileProgress(): Promise<PackFileProgress | null> {
  return desktop!.packFiles.progress();
}

export function cancelPackFile(): Promise<void> {
  return desktop!.packFiles.cancel();
}
