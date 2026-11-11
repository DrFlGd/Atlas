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

/**
 * `queued`: waiting for another download of this app; `waiting`: for
 * another Atlas app on this computer to finish downloading.
 */
export type JobState =
  'queued' | 'waiting' | 'running' | 'paused' | 'stopped' | 'cancelled' | 'done';

/** Where a map image sits in its level. Columns and rows count from 0. */
export interface TilePlace {
  z: number;
  sourceZ: number;
  x: number;
  y: number;
  columns: number;
  rows: number;
}

/** The answer that stopped a download (a refusal or a web page), in full. */
export interface StopDetail {
  kind: 'refused' | 'web-page';
  url: string;
  status: number;
  /** The layer and map: "Surface (Island)". */
  layer: string | null;
  place: TilePlace | null;
  attempt: number;
  /** Images this download had saved before it. */
  savedBefore: number;
  savedFromHost: number;
  host: string;
  headers: [string, string][];
  /** The start of a text body. */
  body: string | null;
  at: string;
}

export interface MapProgress {
  mapId: string;
  name: string;
  done: number;
  total: number;
}

/** The state of a download job. */
export interface DownloadSnapshot {
  packId: string;
  /** The pack's title. */
  title: string;
  detail: Detail;
  state: JobState;
  /** Why the job stopped, or a note on a finished one. */
  reason: string | null;
  stopDetail: StopDetail | null;
  /** Queued: its place in line, from 1. */
  queuePosition: number | null;
  /** Queued or waiting: what it waits for, in words. */
  waitingFor: string | null;
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
  unfinished: { detail: Detail; reason: string | null; stopDetail: StopDetail | null } | null;
  job: DownloadSnapshot | null;
  /** The title of another pack that is downloading now; a new download waits for it. */
  busyWith: string | null;
  /** Downloads of this app that are not over, in queue order. */
  queue: { packId: string; title: string; state: JobState }[];
}

/** The most recent lines of the activity log, newest last. */
export interface RecentLog {
  folder: string;
  file: string;
  lines: string[];
  /** Older lines exist that were not loaded. */
  truncated: boolean;
}

/** How an import ended, for the activity log. Never page data. */
export interface ImportReport {
  importerId: string | null;
  outcome: 'added' | 'updated' | 'rebuilt' | 'failed' | 'cancelled' | 'timed-out';
  packId?: string;
  mapId?: string;
  message?: string;
  counts?: { mapLocations: number; maps: number; locations: number; categories: number };
}

export interface DesktopInfo {
  /** The app's name: "Atlas", or the name a build gave it. */
  name: string;
  version: string;
  platform: string;
}

/** Where a listed pack comes from. */
export type PackOrigin = 'bundled' | 'maps-folder' | 'location';

export interface ListedPack {
  id: string;
  title: string;
  url: string;
  origin: PackOrigin;
  /** The pack folder; null for packs that come with the app. */
  path: string | null;
  packVersion: string;
  /** A pack with this id comes with the app. */
  bundled: boolean;
  /** The importer that made the pack, if it was added from a web page. */
  imported: { importerId: string; importerTitle: string } | null;
}

/** A pack that is not shown because another with the same id is. */
export interface HiddenPack {
  id: string;
  title: string;
  path: string;
  reason: string;
}

export type LocationState = 'ok' | 'missing' | 'not-a-pack' | 'no-packs';

/** A pack folder or folder of packs the person added. */
export interface LocationInfo {
  path: string;
  kind: 'pack' | 'folder';
  state: LocationState;
  packs: string[];
  message: string | null;
}

/** Every pack the app can show, and where they come from. */
export interface Listing {
  mapsFolder: { path: string; isDefault: boolean; exists: boolean };
  packs: ListedPack[];
  hidden: HiddenPack[];
  locations: LocationInfo[];
  /** Packs whose files are being moved, for example from an older version. */
  busy: string[];
}

/** A maps folder the person picked, before it is used. */
export interface FolderChoice {
  path: string;
  /** Packs in the current maps folder. */
  packs: number;
  /** They can be moved quickly and safely (same drive). */
  canMove: boolean;
}

/** Page data kept with an imported pack. */
export interface StoredSource {
  key: string;
  url: string;
  importedAt: string;
  mapId: string | null;
  /** The page data as JSON text. */
  data: string;
}

export interface SaveImportRequest {
  packId: string;
  importer: { id: string; title: string };
  sourceKey: string;
  pageUrl: string;
  importedAt: string;
  mapId: string;
  /** The page data as JSON text. */
  pageData: string;
  /** Pack files by name, as JSON text. */
  files: Record<string, string>;
}

/** What the shell found when it looked at the import window. */
export type PollResult =
  | { state: 'waiting'; loading: boolean; note: string | null }
  | { state: 'ready'; data: string }
  | { state: 'closed' }
  | { state: 'failed'; message: string };

export interface DownloadSettings {
  /** Requests in flight at once. */
  parallel: number;
  /** Pause after each request, per parallel download, in milliseconds. */
  pauseMs: number;
  requestsPerMinute: number | null;
  /** In kilobytes (1000 bytes) per second. */
  kilobytesPerSecond: number | null;
}

export interface DownloadSettingsInfo {
  settings: DownloadSettings;
  /** Lowest and highest allowed value of each setting. */
  bounds: Record<keyof DownloadSettings, [number, number]>;
}

export type RevealTarget =
  | { kind: 'maps-folder' }
  | { kind: 'pack'; id: string }
  | { kind: 'location'; path: string }
  | { kind: 'log-folder' };

export interface DesktopBridge {
  info(): Promise<DesktopInfo>;
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
    settings(): Promise<DownloadSettingsInfo>;
    setSettings(settings: DownloadSettings): Promise<DownloadSettingsInfo>;
  };
  library: {
    list(): Promise<Listing>;
    /** Asks for a pack folder and remembers it; its pack id, or null when the dialog was closed. */
    openPack(): Promise<string | null>;
    /** Asks for a folder of packs and remembers it; how many packs it has, or null. */
    addFolder(): Promise<number | null>;
    removeLocation(path: string): Promise<void>;
    /** Asks for a new maps folder; it is used only after {@link applyMapsFolder}. */
    chooseMapsFolder(): Promise<FolderChoice | null>;
    /** Uses the chosen maps folder; returns the ids of the packs moved there. */
    applyMapsFolder(movePacks: boolean): Promise<string[]>;
    reveal(target: RevealTarget): Promise<void>;
    deletePack(id: string): Promise<void>;
    importSources(packId: string, importerId: string): Promise<StoredSource[]>;
    saveImport(request: SaveImportRequest): Promise<Listing>;
  };
  importWindow: {
    open(
      url: string,
      reader: string,
      importer?: { id: string; waitSeconds: number },
    ): Promise<void>;
    poll(): Promise<PollResult>;
    close(): Promise<void>;
    /** Records how an import ended in the activity log. */
    report(report: ImportReport): Promise<void>;
  };
  activityLog: {
    read(): Promise<RecentLog>;
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
      settings: () => call('download_settings_get'),
      setSettings: (settings) => call('download_settings_set', { settings }),
    },
    library: {
      list: () => call('library_list'),
      openPack: () => call('library_open_pack'),
      addFolder: () => call('library_add_folder'),
      removeLocation: (path) => call('library_remove_location', { path }),
      chooseMapsFolder: () => call('library_choose_maps_folder'),
      applyMapsFolder: (movePacks) => call('library_apply_maps_folder', { movePacks }),
      reveal: (target) => call('library_reveal', { target }),
      deletePack: (id) => call('library_delete_pack', { id }),
      importSources: (packId, importerId) => call('library_import_sources', { packId, importerId }),
      saveImport: (request) => call('library_save_import', { request }),
    },
    importWindow: {
      open: (url, reader, importer) =>
        call(
          'import_open',
          importer
            ? { url, reader, importerId: importer.id, waitSeconds: importer.waitSeconds }
            : { url, reader },
        ),
      poll: () => call('import_poll'),
      close: () => call('import_close'),
      report: (report) => call('import_report', { report }),
    },
    activityLog: {
      read: () => call('activity_log_read'),
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

/**
 * The URL to open in the system browser for a link, or null for links that
 * stay in the app: anything but `http` and `https`, and the app's own pages
 * (the bundled frontend is `http://tauri.localhost` on Windows).
 */
export function externalLink(href: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin === new URL(base).origin) return null;
  return url.href;
}

/**
 * Sends clicks on links to other sites to the system browser instead of the
 * app's window, which has no browser around it. Only `http` and `https`
 * links are sent; the shell checks that again.
 */
export function openLinksOutside(bridge: DesktopBridge, root: Document = document): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button > 1) return;
    const target = event.target as Element | null;
    const link = target?.closest('a[href]') as HTMLAnchorElement | null;
    const url = link ? externalLink(link.href, root.baseURI) : null;
    if (!url) return;
    event.preventDefault();
    bridge.openExternal(url).catch((error: unknown) => {
      console.error(error);
    });
  };
  root.addEventListener('click', onClick);
  root.addEventListener('auxclick', onClick);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('auxclick', onClick);
  };
}
