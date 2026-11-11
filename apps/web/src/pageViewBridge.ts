/**
 * The desktop shell's commands for "View map page" and "Save map images as
 * I browse" (`apps/desktop/src-tauri/src/pageview`). Kept apart from
 * `desktop.ts` so the feature stays in its own files; it finds the shell the
 * same way, and is null in a browser.
 */

/** A page a pack was made from, as recorded in its manifest. */
export interface SourcePage {
  url: string;
  mapId: string | null;
  mapName: string | null;
  importedAt: string | null;
}

export interface PagesInfo {
  pages: SourcePage[];
  /** Map images of this pack can be saved while browsing its pages. */
  canSave: boolean;
  /** Why not, in plain words. */
  saveNote: string | null;
}

/** Map images seen while saving; each counts once. */
export interface CaptureCounts {
  saved: number;
  alreadyHad: number;
  /**
   * Found not to be on the server by the page's own requests (the map's
   * edge), and recorded as missing as "Download map images" records them.
   */
  notOnServer: number;
  notSaved: number;
  /** Of `notSaved`: shown by the page in a way that cannot be copied. */
  fromElements: number;
  /** Of `notSaved`: unreadable, an error answer, not an image, too large, too many at once. */
  otherProblems: number;
  bytes: number;
}

/** What the map page window is doing. */
export interface ViewStatus {
  open: boolean;
  packId: string | null;
  url: string | null;
  /** Saving map images is on. */
  saving: boolean;
  /** Saving was on at some point while this page was open. */
  savedSession: boolean;
  counts: CaptureCounts;
  /** The page loads things in background workers, which cannot be seen. */
  usesWorkers: boolean;
  /** Increases when map images were saved or found not to be on the server, so the map looks again. */
  revision: number;
  message: string | null;
}

export interface PageViewBridge {
  pages(packId: string): Promise<PagesInfo>;
  open(packId: string, url: string, save: boolean): Promise<ViewStatus>;
  status(): Promise<ViewStatus>;
  stopSaving(): Promise<ViewStatus>;
  close(): Promise<ViewStatus>;
  /** Opens a recorded page in the system browser. */
  openInBrowser(packId: string, url: string): Promise<void>;
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Builds the bridge over an `invoke` function. Exported for tests. */
export function createPageViewBridge(invoke: Invoke): PageViewBridge {
  const call = <T>(command: string, args?: Record<string, unknown>) =>
    invoke(command, args).catch((error: unknown) => {
      throw new Error(typeof error === 'string' ? error : String(error));
    }) as Promise<T>;
  return {
    pages: (packId) => call('view_pages', { packId }),
    open: (packId, url, save) => call('view_open', { packId, url, save }),
    status: () => call('view_status'),
    stopSaving: () => call('view_stop_saving'),
    close: () => call('view_close'),
    openInBrowser: (packId, url) => call('view_open_in_browser', { packId, url }),
  };
}

function detect(): PageViewBridge | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: unknown } })
    .__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== 'function') return null;
  return createPageViewBridge(internals.invoke.bind(internals) as Invoke);
}

/**
 * The shell's map page commands, or null in a browser and in a build without
 * downloads, whose shell has none.
 */
export const pageViewShell: PageViewBridge | null = __ATLAS_DOWNLOADS__ ? detect() : null;
