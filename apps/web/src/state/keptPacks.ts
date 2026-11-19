import { create } from 'zustand';
import { formatBytes } from '../components/downloadFormat';
import {
  desktop,
  type KeptPackRow,
  type KeptPacksSchedule,
  type KeptPacksStatus,
} from '../desktop';
import { notify } from './actions';

/**
 * Keeping pack files up to date in one folder, in the desktop app with
 * downloads (see the shell's `keep` module): the shell chooses, writes and
 * keeps its record by itself; this module asks it for its state, follows
 * the state it sends as it changes, runs the setting's commands and says
 * the state in plain words. The page never names a folder: the folder is
 * chosen in the system's folder dialog.
 *
 * Nothing here asks the person anything by itself. A run that failed as a
 * whole (the folder cannot be found, the drive is full) gives one notice,
 * once (by its serial); everything else is in the setting's list.
 */

export const useKeptPacks = create<{
  status: KeptPacksStatus | null;
  /** Why the state could not be read, or the last command failed. */
  error: string | null;
  /** A command is under way. */
  pending: boolean;
}>(() => ({ status: null, error: null, pending: false }));

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The notice last shown, so each is shown once. */
let noticeShown: number | null = null;

/**
 * Takes a state in: a newer one than the one held (by its serial), and
 * shows its notice when it is new. An answer that is not a state (a shell
 * without this setting) is left out.
 */
export function takeKeptPacks(status: KeptPacksStatus | null | undefined): void {
  if (!status || typeof status !== 'object' || !Array.isArray(status.games)) return;
  const held = useKeptPacks.getState().status;
  if (held && held.serial > status.serial) return;
  useKeptPacks.setState({ status, error: null });
  const notice = status.notice;
  if (notice && notice.serial !== noticeShown) {
    noticeShown = notice.serial;
    notify(notice.text, 'error');
  }
}

/** Forgets the state and the notices shown. For tests. */
export function resetKeptPacks(): void {
  noticeShown = null;
  useKeptPacks.setState({ status: null, error: null, pending: false });
}

/** Asks the shell for the state. Does nothing outside a build with downloads. */
export async function loadKeptPacks(): Promise<void> {
  if (!__ATLAS_DOWNLOADS__ || !desktop) return;
  try {
    takeKeptPacks(await desktop.keptPacks.status());
  } catch (error) {
    useKeptPacks.setState({ error: errorText(error) });
  }
}

/**
 * Follows the state the shell sends as it changes, from the start of the
 * app, so the notice of a run that failed comes wherever the person is.
 * Returns a function that stops.
 */
export function followKeptPacks(): () => void {
  if (!__ATLAS_DOWNLOADS__ || !desktop) return () => undefined;
  let stop: (() => void) | null = null;
  let stopped = false;
  desktop.events
    .keptPacksChanged((status) => {
      takeKeptPacks(status);
    })
    .then((unlisten) => {
      if (stopped) unlisten();
      else stop = unlisten;
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    stop?.();
  };
}

/** Runs one of the setting's commands, and takes the state it answers. */
async function run(command: () => Promise<KeptPacksStatus | null>): Promise<void> {
  useKeptPacks.setState({ pending: true });
  try {
    takeKeptPacks(await command());
    useKeptPacks.setState({ error: null });
  } catch (error) {
    useKeptPacks.setState({ error: errorText(error) });
  } finally {
    useKeptPacks.setState({ pending: false });
  }
}

const shell = () => desktop!.keptPacks;

/** Asks for the folder in the system's dialog; choosing one turns the setting on. */
export const chooseKeptPacksFolder = () => run(() => shell().chooseFolder());

/** Turns the setting on or off, or changes how often it checks. */
export const setKeptPacks = (on: boolean, schedule: KeptPacksSchedule) =>
  run(() => shell().set(on, schedule));

/** "Write all packs now". */
export const writeAllKeptPacks = () => run(() => shell().writeAll());

/** "Write again", for a pack removed from the folder. */
export const writeKeptPackAgain = (id: string) => run(() => shell().writeAgain(id));

/** Stops the run under way. */
export const stopKeptPacks = () => run(() => shell().cancel());

/** Opens the folder in the file manager. */
export async function revealKeptPacksFolder(): Promise<void> {
  try {
    await shell().reveal();
  } catch (error) {
    useKeptPacks.setState({ error: errorText(error) });
  }
}

// ---------------------------------------------------------------------------
// In plain words

export const SCHEDULE_NAMES: Record<KeptPacksSchedule, string> = {
  start: 'At each start',
  daily: 'At each start and daily',
  weekly: 'At each start and weekly',
};

/** A time as the person reads it. */
export function whenText(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** The pack being written, in one line; null when none is. */
export function writingText(status: KeptPacksStatus | null): string | null {
  const writing = status?.writing;
  if (!writing) return null;
  const share =
    writing.bytesTotal > 0 ? Math.floor((writing.bytesDone / writing.bytesTotal) * 100) : 0;
  const of = writing.count > 1 ? ` (${writing.number} of ${writing.count})` : '';
  return writing.phase === 'checking'
    ? `Checking the pack file of ${writing.title}${of}, ${share}%.`
    : `Writing the pack file of ${writing.title}${of}, ${share}% of ${formatBytes(writing.bytesTotal)}.`;
}

/** The setting's one status line. */
export function statusLine(status: KeptPacksStatus): string {
  if (!status.on) return 'Off. No pack files are written.';
  const writing = writingText(status);
  if (writing) return writing;
  if (status.running) return 'Looking through the folder…';
  if (status.problem) return status.problem;
  const count = (state: KeptPackRow['state']) =>
    status.games.filter((row) => row.state === state).length;
  const counts: [number, string][] = [
    [count('up-to-date'), 'up to date'],
    [count('waiting'), 'waiting'],
    [count('newer-in-folder'), 'newer in the folder'],
    [count('not-in-folder'), 'not in the folder'],
    [count('failed'), 'failed'],
  ];
  const parts = counts.filter(([n]) => n > 0).map(([n, words]) => `${n} ${words}`);
  const checked = status.lastCheckAt ? ` Last checked ${whenText(status.lastCheckAt)}.` : '';
  if (parts.length === 0) {
    return status.lastCheckAt
      ? `No map or wiki read from a site on this computer has a pack to keep.${checked}`
      : 'The folder is checked in a moment.';
  }
  return `${parts.join(', ')}.${checked}`;
}

export const STATE_NAMES: Record<KeptPackRow['state'], string> = {
  'up-to-date': 'Up to date',
  waiting: 'Waiting',
  writing: 'Being written',
  'newer-in-folder': 'Newer in the folder',
  'not-in-folder': 'Not in the folder',
  'left-out': 'Left out',
  failed: 'Failed',
};

/** What to say under a game's state: when and where, or why. */
export function rowDetails(row: KeptPackRow): string[] {
  const lines: string[] = [];
  if (row.state === 'up-to-date' && row.path) {
    lines.push(
      row.writtenAt ? `Written ${whenText(row.writtenAt)} to ${row.path}.` : `In ${row.path}.`,
    );
  } else if (row.state === 'not-in-folder' && row.path) {
    lines.push(`It was in ${row.path}.`);
  } else if ((row.state === 'newer-in-folder' || row.state === 'writing') && row.path) {
    lines.push(`In ${row.path}.`);
  }
  if (row.reason) lines.push(row.reason);
  if (row.extraCopies.length > 0) {
    lines.push(
      `${row.extraCopies.length === 1 ? 'Another copy is' : `${row.extraCopies.length} other copies are`} in the folder and left as ${row.extraCopies.length === 1 ? 'it is' : 'they are'}: ${row.extraCopies.join(', ')}.`,
    );
  }
  return lines;
}
