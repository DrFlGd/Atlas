/**
 * The bridge to the desktop shell (`apps/desktop`). The web app has no
 * dependency on Tauri: inside the shell, Tauri injects an `invoke` function,
 * and this module calls the shell's commands through it. In a browser
 * `desktop` is null and the app works as a plain web page.
 */

/** How much of a pack's map images to download; see the shell's `Detail`. */
export type Detail = 'overview' | 'standard' | 'full';

export interface DetailOption {
  detail: Detail;
  /** Remote tiles up to this detail. */
  tiles: number;
  /** Of those, not on disk yet. */
  remaining: number;
  estimatedSeconds: number;
  estimatedBytes: number;
  /** Every level up to this detail is ready. */
  installed: boolean;
}

export type JobState = 'running' | 'paused' | 'stopped' | 'cancelled' | 'done';

export interface MapProgress {
  mapId: string;
  name: string;
  done: number;
  total: number;
}

/** The state of a download job. */
export interface DownloadSnapshot {
  packId: string;
  detail: Detail;
  state: JobState;
  /** Why the job stopped, or a note on a finished one. */
  reason: string | null;
  maps: MapProgress[];
  done: number;
  total: number;
  saved: number;
  missing: number;
  failed: number;
  bytes: number;
  tilesPerSecond: number;
  bytesPerSecond: number;
  secondsLeft: number | null;
  /** Increases whenever a layer's status file changes. */
  statusRevision: number;
}

export interface DownloadPlan {
  packId: string;
  options: DetailOption[];
  recommended: Detail;
  /** A job left unfinished, for example when the app was closed. */
  unfinished: { detail: Detail; reason: string | null } | null;
  job: DownloadSnapshot | null;
  /** Another pack's job that is running. */
  busyWith: string | null;
}

export interface DesktopBridge {
  info(): Promise<{ version: string; platform: string }>;
  /** Opens an http or https link in the system browser. */
  openExternal(url: string): Promise<void>;
  /** Asks where to save, then saves. Null when the dialog was closed. */
  saveTextFile(suggestedName: string, contents: string): Promise<{ name: string } | null>;
  /** Asks for a file and reads it. Null when the dialog was closed. */
  openTextFile(): Promise<{ name: string; contents: string } | null>;
  tiles: {
    plan(packId: string): Promise<DownloadPlan>;
    start(packId: string, detail: Detail): Promise<DownloadSnapshot>;
    pause(packId: string): Promise<DownloadSnapshot>;
    resume(packId: string): Promise<DownloadSnapshot>;
    cancel(packId: string): Promise<void>;
    snapshot(packId: string): Promise<DownloadSnapshot | null>;
  };
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Builds the bridge over an `invoke` function. Exported for tests. */
export function createBridge(invoke: Invoke): DesktopBridge {
  const call = <T>(command: string, args?: Record<string, unknown>) =>
    invoke(command, args).catch((error: unknown) => {
      // Commands reject with a plain sentence.
      throw new Error(typeof error === 'string' ? error : String(error));
    }) as Promise<T>;
  return {
    info: () => call('desktop_info'),
    openExternal: (url) => call('open_external', { url }),
    saveTextFile: (suggestedName, contents) => call('save_text_file', { suggestedName, contents }),
    openTextFile: () => call('open_text_file'),
    tiles: {
      plan: (packId) => call('tiles_plan', { packId }),
      start: (packId, detail) => call('tiles_start', { packId, detail }),
      pause: (packId) => call('tiles_pause', { packId }),
      resume: (packId) => call('tiles_resume', { packId }),
      cancel: (packId) => call('tiles_cancel', { packId }),
      snapshot: (packId) => call('tiles_snapshot', { packId }),
    },
  };
}

function detect(): DesktopBridge | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: unknown } })
    .__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== 'function') return null;
  const invoke = internals.invoke.bind(internals) as Invoke;
  return createBridge(invoke);
}

/** The desktop shell's commands, or null in a browser. */
export const desktop: DesktopBridge | null = detect();

/**
 * The folder name the shell serves a pack under, from the pack's URL on the
 * shell's `atlas-pack` protocol (`atlas-pack://localhost/<id>/` on Linux
 * and macOS, `http://atlas-pack.localhost/<id>/` on Windows). Null for
 * packs served any other way, which the shell cannot download for.
 */
export function packFolderOf(url: string): string | null {
  const match =
    /^(?:atlas-pack:\/\/localhost|http:\/\/atlas-pack\.localhost)\/([a-z0-9][a-z0-9_-]*)\/$/.exec(
      url,
    );
  return match?.[1] ?? null;
}
