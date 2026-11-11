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
 * Android. The shell writes and reads the files; this module opens the
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

export function closePackFileDialog(): void {
  set({ packFileDialog: null });
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
