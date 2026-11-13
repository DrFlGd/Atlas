import { create } from 'zustand';
import { desktop, type JobEntry } from '../desktop';
import { downloadsOffered } from '../features';
import { notify } from './actions';
import { followJobs, jobGoing, loadGameFacts } from './gameFacts';
import { stopRun, useImport } from './importing';
import { useAtlas } from './store';

/**
 * The Downloads panel and the strip at the bottom of the Library: one view
 * over the map image and photo jobs of the shell's single queue (see
 * `tiles/manager.rs`) and the run of pages being read (see `importing.ts`).
 * It keeps no queue of its own: it asks the shell for its jobs, once a
 * second while one of them moves, and steers them with the shell's
 * commands. Nothing here asks a site for anything.
 */

export interface DownloadsViewState {
  /** The shell's jobs, in its order; empty until read. */
  jobs: JobEntry[];
  /** A step is being taken. */
  pending: boolean;
}

export const useDownloadsView = create<DownloadsViewState>()(() => ({
  jobs: [],
  pending: false,
}));

const set = useDownloadsView.setState;
const FOLLOW_MS = 1000;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A job that moves by itself: downloading, or waiting its turn (not paused). */
const moving = (entry: JobEntry) =>
  entry.job.state === 'running' || entry.job.state === 'queued' || entry.job.state === 'waiting';

let timer = 0;
/** How many screens follow the jobs now (the Library, the panel). */
let followers = 0;

/** Reads the shell's jobs; a job that just ended has its game's facts read again. */
export async function loadJobs(): Promise<void> {
  const shell = desktop;
  if (!shell || !__ATLAS_DOWNLOADS__ || !downloadsOffered(useAtlas.getState())) return;
  let jobs: JobEntry[];
  try {
    jobs = await shell.tiles.jobs();
  } catch {
    return;
  }
  const before = new Map(useDownloadsView.getState().jobs.map((entry) => [entry.key, entry]));
  set({ jobs });
  for (const entry of jobs) {
    const was = before.get(entry.key);
    if (was && jobGoing(was.job) && !jobGoing(entry.job)) void loadGameFacts(entry.packId, true);
  }
  window.clearTimeout(timer);
  if (followers > 0 && jobs.some(moving)) {
    timer = window.setTimeout(() => void loadJobs(), FOLLOW_MS);
  }
}

/** Follows the jobs while a screen that shows them is open; returns the way to stop. */
export function followDownloads(): () => void {
  followers++;
  void loadJobs();
  return () => {
    followers = Math.max(0, followers - 1);
    if (followers === 0) window.clearTimeout(timer);
  };
}

/** Takes one step on the shell's jobs, then reads them again. */
async function step(run: () => Promise<unknown>, packId?: string): Promise<void> {
  set({ pending: true });
  try {
    await run();
  } catch (error) {
    notify(errorText(error), 'error');
  } finally {
    set({ pending: false });
  }
  if (packId) {
    void loadGameFacts(packId, true);
    followJobs(packId);
  }
  await loadJobs();
}

const shell = () => {
  if (!desktop) throw new Error('This app does not download.');
  return desktop.tiles;
};

export function pauseJob(entry: JobEntry): Promise<void> {
  return step(
    () =>
      entry.kind === 'photos' ? shell().photosPause(entry.packId) : shell().pause(entry.packId),
    entry.packId,
  );
}

export function resumeJob(entry: JobEntry): Promise<void> {
  return step(
    () =>
      entry.kind === 'photos' ? shell().photosResume(entry.packId) : shell().resume(entry.packId),
    entry.packId,
  );
}

/** Ends a job; what it downloaded is kept. */
export function cancelJob(entry: JobEntry): Promise<void> {
  return step(
    () =>
      entry.kind === 'photos' ? shell().photosCancel(entry.packId) : shell().cancel(entry.packId),
    entry.packId,
  );
}

/** "Try again": the same download again; only what is missing is fetched. */
export function retryJob(entry: JobEntry): Promise<void> {
  return step(
    () =>
      entry.kind === 'photos'
        ? shell().photosStart(entry.packId)
        : shell().start(entry.packId, entry.job.detail),
    entry.packId,
  );
}

/** Moves a job waiting its turn one place earlier or later. */
export function moveJob(entry: JobEntry, earlier: boolean): Promise<void> {
  return step(() => shell().moveJob(entry.key, earlier));
}

/**
 * "Pause everything": pauses every job that downloads or waits its turn,
 * and stops the run of pages after the page open now. Nothing starts again
 * until the person resumes it.
 */
export async function pauseEverything(): Promise<void> {
  const { phase } = useImport.getState();
  if ((phase.kind === 'run' || phase.kind === 'listing') && phase.run.status === 'running') {
    stopRun();
  }
  const going = useDownloadsView.getState().jobs.filter(moving);
  set({ pending: true });
  for (const entry of going) {
    try {
      await (entry.kind === 'photos'
        ? shell().photosPause(entry.packId)
        : shell().pause(entry.packId));
    } catch (error) {
      notify(errorText(error), 'error');
    }
  }
  set({ pending: false });
  for (const entry of going) void loadGameFacts(entry.packId, true);
  await loadJobs();
}

/** Whether a job ended today, by this computer's clock. */
export function endedToday(entry: JobEntry, now = new Date()): boolean {
  if (!entry.job.finishedAt) return false;
  return new Date(entry.job.finishedAt).toDateString() === now.toDateString();
}
