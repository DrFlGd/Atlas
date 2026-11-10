import { isDownloadable } from '@atlas/core';
import {
  desktop,
  packFolderOf,
  type Detail,
  type DownloadSettings,
  type DownloadSnapshot,
} from '../desktop';
import { NO_DOWNLOADS, useAtlas, type DownloadState, type LoadedGame } from './store';

/**
 * Map image downloads in the desktop app. The shell does the work; this
 * module asks it for plans, starts and steers jobs, and polls a running job
 * so the panel and the map stay current. In a browser it does nothing.
 */

const get = useAtlas.getState;
const set = useAtlas.setState;

/** How often a running job is polled. */
const POLL_MS = 1000;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The folder the shell serves a game's pack from, if its map images can be downloaded. */
export function downloadFolder(game: LoadedGame | null): string | null {
  if (!desktop || !game) return null;
  if (!game.pack.data.layers.some(isDownloadable)) return null;
  return packFolderOf(game.entry.url);
}

function update(patch: Partial<DownloadState>): void {
  set({ downloads: { ...get().downloads, ...patch } });
}

const isActive = (job: DownloadSnapshot | null) =>
  job?.state === 'running' || job?.state === 'paused';

let pollTimer = 0;
let lastRevision = -1;

/** Takes in a job snapshot: tells the map about new levels and keeps polling while it runs. */
function receive(job: DownloadSnapshot | null): void {
  const folder = get().downloads.packFolder;
  if (job?.packId !== folder) return;
  const previous = get().downloads.job;
  update({ job });
  if (job.statusRevision !== lastRevision) {
    lastRevision = job.statusRevision;
    set({ tileRevision: get().tileRevision + 1 });
  }
  if (isActive(job)) {
    schedulePoll();
  } else if (isActive(previous)) {
    // Just finished: the sizes and what is installed have changed.
    void refreshPlan();
  }
}

function schedulePoll(): void {
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(() => {
    const folder = get().downloads.packFolder;
    if (!desktop || !folder) return;
    desktop.tiles.snapshot(folder).then(receive, (error: unknown) => {
      update({ error: errorText(error) });
      schedulePoll();
    });
  }, POLL_MS);
}

async function refreshPlan(): Promise<void> {
  const folder = get().downloads.packFolder;
  if (!desktop || !folder) return;
  try {
    const plan = await desktop.tiles.plan(folder);
    if (get().downloads.packFolder !== folder) return;
    update({ plan });
    if (plan.job) receive(plan.job);
  } catch (error) {
    if (get().downloads.packFolder === folder) update({ error: errorText(error) });
  }
}

/** Called when a game is loaded: finds out what can be downloaded for it. */
export async function loadDownloads(game: LoadedGame): Promise<void> {
  window.clearTimeout(pollTimer);
  lastRevision = -1;
  const packFolder = downloadFolder(game);
  set({ downloads: { ...NO_DOWNLOADS, packFolder } });
  if (packFolder) await refreshPlan();
}

export function setDownloadPanelOpen(panelOpen: boolean): void {
  update({ panelOpen, error: null });
  if (panelOpen) {
    void refreshPlan();
    void loadDownloadSettings();
  }
}

async function loadDownloadSettings(): Promise<void> {
  if (!desktop) return;
  try {
    update({ settings: await desktop.tiles.settings() });
  } catch (error) {
    update({ error: errorText(error) });
  }
}

/**
 * Saves how downloads are paced, for every Atlas app on this computer. A
 * running download follows at once, except that more parallel downloads
 * start from its next level. The estimates are worked out again.
 */
export async function saveDownloadSettings(settings: DownloadSettings): Promise<boolean> {
  if (!desktop) return false;
  update({ pending: true, error: null });
  try {
    update({ settings: await desktop.tiles.setSettings(settings), pending: false });
    await refreshPlan();
    return true;
  } catch (error) {
    update({ pending: false, error: errorText(error) });
    return false;
  }
}

async function command(
  run: (folder: string) => Promise<DownloadSnapshot | undefined>,
): Promise<void> {
  const folder = get().downloads.packFolder;
  if (!desktop || !folder) return;
  update({ pending: true, error: null });
  try {
    const job = await run(folder);
    update({ pending: false });
    if (job) receive(job);
  } catch (error) {
    update({ pending: false, error: errorText(error) });
  }
}

export function startDownload(detail: Detail): Promise<void> {
  return command((folder) => desktop!.tiles.start(folder, detail));
}

export function pauseDownload(): Promise<void> {
  return command((folder) => desktop!.tiles.pause(folder));
}

export function resumeDownload(): Promise<void> {
  return command((folder) => desktop!.tiles.resume(folder));
}

/** Stops the job, or forgets an interrupted one. Downloaded images are kept. */
export async function cancelDownload(): Promise<void> {
  await command(async (folder) => {
    await desktop!.tiles.cancel(folder);
    return undefined;
  });
  const folder = get().downloads.packFolder;
  if (desktop && folder) {
    const job = await desktop.tiles.snapshot(folder).catch(() => null);
    if (job) receive(job);
  }
  await refreshPlan();
}
