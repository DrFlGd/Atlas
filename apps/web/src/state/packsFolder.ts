import { formatBytes } from '../components/downloadFormat';
import { desktop, type PacksFolderChanged, type PacksFolderChoice } from '../desktop';
import { notify } from './actions';
import { refreshLibrary } from './library';
import type { AtlasState } from './store';

/**
 * Changing the packs folder, the folder of pack files Atlas reads where
 * they lie, in the desktop apps (Windows, Linux, macOS; never Android,
 * which keeps its packs in its own storage). The shell keeps the choice in
 * the settings file every Atlas app on the computer shares (`packsFolder`),
 * checks the folder and moves the pack files (see the shell's
 * `library/packsfolder.rs`); this module runs its commands and says in
 * plain words what a change does and what it came to.
 */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Whether Settings offers to change the packs folder: in a desktop app
 * whose shell says which packs folder is the default (an older shell does
 * not, and cannot change it).
 */
export function packsFolderChangeable(state: Pick<AtlasState, 'app' | 'library'>): boolean {
  const app = state.app;
  return (
    app !== null &&
    app.platform !== 'android' &&
    app.folders !== false &&
    state.library?.packsFolder?.isDefault !== undefined
  );
}

const files = (count: number) => `${count} pack file${count === 1 ? '' : 's'}`;

/** The question before a change, in one sentence. */
export function packsFolderQuestion(choice: PacksFolderChoice): string {
  return choice.isDefault
    ? `Use the default packs folder, ${choice.path}, from now on?`
    : `Use ${choice.path} as the packs folder from now on?`;
}

/** What a change would do, in plain sentences, for the question. */
export function packsFolderFacts(choice: PacksFolderChoice): string[] {
  if (choice.files === 0) {
    return [
      `The packs folder now is ${choice.current}. It holds no pack files, so there is nothing to move.`,
    ];
  }
  return [
    `The packs folder now is ${choice.current}. It holds ${files(choice.files)} (${formatBytes(choice.bytes)}).`,
    choice.sameDrive
      ? 'Moving them is quick, as the new folder is on the same drive. Sub-folders are kept, and only pack files are moved.'
      : 'The new folder is on another drive, so moving copies each pack file there, checks the copy and only then deletes the original. This can take a while. Sub-folders are kept, and only pack files are moved.',
    'A pack file that is in use or cannot be copied stays where it is, and Atlas says which. When the new folder has a file of the same name already, both are kept: the one moved gets a number, as in “name (2).atlaspack”.',
    'If you leave them where they are, Atlas no longer shows the pack files in the old folder, unless you add that folder under Games in other folders.',
  ];
}

/** What a change came to, in a sentence for a notice. */
export function packsFolderOutcome(changed: PacksFolderChanged, moved: boolean): string {
  const now = `The packs folder is now ${changed.folder}.`;
  if (!moved) return `${now} The pack files in the old folder were left where they are.`;
  const parts = [now, `Moved ${files(changed.moved)} there.`];
  if (changed.renamed.length > 0) {
    parts.push(
      changed.renamed.length === 1
        ? 'One of them has a new name, because a file of the same name was there already.'
        : `${changed.renamed.length} of them have a new name, because files of the same name were there already.`,
    );
  }
  if (changed.left.length > 0) {
    parts.push(
      changed.left.length === 1
        ? 'One pack file could not be moved and stays in the old folder.'
        : `${changed.left.length} pack files could not be moved and stay in the old folder.`,
    );
  }
  return parts.join(' ');
}

async function run<T>(task: () => Promise<T>): Promise<T | undefined> {
  try {
    return await task();
  } catch (error) {
    notify(errorText(error), 'error');
    return undefined;
  }
}

/** "Change packs folder…": the folder dialog, then what a change would do. */
export function choosePacksFolder(): Promise<PacksFolderChoice | null | undefined> {
  return run(() => desktop!.library.choosePacksFolder());
}

/** "Use the default folder": what going back to it would do. */
export function defaultPacksFolder(): Promise<PacksFolderChoice | undefined> {
  return run(() => desktop!.library.defaultPacksFolder());
}

/**
 * Uses the chosen packs folder from now on, moving the pack files there or
 * leaving them, then lists the games again; what it came to, or undefined
 * when it was refused (a notice says why).
 */
export async function applyPacksFolder(
  moveFiles: boolean,
): Promise<PacksFolderChanged | undefined> {
  const changed = await run(() => desktop!.library.applyPacksFolder(moveFiles));
  if (!changed) return undefined;
  try {
    await refreshLibrary();
  } catch (error) {
    notify(errorText(error), 'error');
  }
  notify(packsFolderOutcome(changed, moveFiles), changed.left.length > 0 ? 'error' : 'info');
  return changed;
}
