import { create } from 'zustand';
import {
  pageViewShell,
  type CaptureCounts,
  type PagesInfo,
  type PageViewBridge,
  type SourcePage,
  type ViewStatus,
} from '../pageViewBridge';
import { notify } from './actions';
import { numberFormat } from './derived';
import { setMapsDialogOpen } from './library';
import { useAtlas } from './store';

/**
 * "View map page" and "Save map images as I browse", in the desktop app.
 *
 * A pack added from a web page remembers that page. The Maps dialog offers
 * to open it again, in a window of the app's own (just to look at it, or
 * while saving the map images the person's own panning and zooming loads),
 * or in the person's own browser. The shell does the work; this module asks
 * it, and while the page is open polls it for the counts shown over the map.
 */

export type PagesEntry =
  { state: 'loading' } | { state: 'ready'; info: PagesInfo } | { state: 'failed'; message: string };

export interface PageViewState {
  /** The recorded pages of each pack asked about, by pack id. */
  pages: Record<string, PagesEntry>;
  /** The map page window, as last reported; null when there is nothing to show. */
  status: ViewStatus | null;
  /** A command is on its way to the shell. */
  pending: boolean;
}

export const usePageView = create<PageViewState>()(() => ({
  pages: {},
  status: null,
  pending: false,
}));

const get = usePageView.getState;
const set = usePageView.setState;

/** How often the window is asked how it is doing while it is open. */
export const POLL_MS = 1000;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Words

/** "1 map image", "2,345 map images". */
const images = (count: number) =>
  `${numberFormat.format(count)} map image${count === 1 ? '' : 's'}`;

/** A short name for a recorded page: its map, else its address without the scheme. */
export function pageLabel(page: SourcePage): string {
  if (page.mapName) return page.mapName;
  try {
    const url = new URL(page.url);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return page.url;
  }
}

/** The figures shown while saving, as short phrases. */
export function countPhrases(counts: CaptureCounts): string[] {
  return [
    `${numberFormat.format(counts.saved)} saved`,
    `${numberFormat.format(counts.alreadyHad)} already had`,
    `${numberFormat.format(counts.notSaved)} could not be saved`,
  ];
}

/** Plain explanations of what could not be saved, if anything. */
export function problemNotes(status: ViewStatus): string[] {
  const notes: string[] = [];
  const { fromElements, otherProblems } = status.counts;
  if (fromElements > 0) {
    notes.push(
      `Some map images on this page could not be saved this way (${images(fromElements)}${status.saving ? ' so far' : ''}): the page shows them in a way that Atlas cannot copy without downloading them again, and it does not do that. “Download map images” can fetch them instead.`,
    );
  }
  if (otherProblems > 0) {
    notes.push(
      `${images(otherProblems)} could not be saved for another reason: the page did not let Atlas read ${otherProblems === 1 ? 'it' : 'them'}, ${otherProblems === 1 ? 'it was' : 'they were'} not a usable image, or too many came at once.`,
    );
  }
  if (status.usesWorkers) {
    notes.push(
      'This page also loads things in the background, where Atlas cannot see them. Map images loaded that way are not saved or counted.',
    );
  }
  return notes;
}

/** What the card over the map says first. */
export function headline(status: ViewStatus): string {
  if (status.open && status.saving) return 'Saving map images as you browse';
  if (status.open && status.savedSession) return 'Map page open · saving stopped';
  if (status.open) return 'Map page open';
  return status.savedSession ? 'Map page closed · saving stopped' : 'Map page closed';
}

/** Whether there is anything to show over the map. */
export function shouldShow(status: ViewStatus | null): status is ViewStatus {
  return !!status && (status.open || status.savedSession);
}

// ---------------------------------------------------------------------------
// Commands

let shell: PageViewBridge | null = pageViewShell;

/** Uses another shell bridge. For tests. */
export function setPageViewShell(bridge: PageViewBridge | null): void {
  shell = bridge;
}

let pollTimer: ReturnType<typeof setTimeout> | undefined;
let lastRevision = -1;

/** Takes in a status: tells the map about newly saved images and keeps polling while the page is open. */
export function receiveStatus(status: ViewStatus): void {
  set({ status: shouldShow(status) ? status : null });
  if (status.revision !== lastRevision) {
    const first = lastRevision === -1;
    lastRevision = status.revision;
    // Whichever game the images are of: the map also forgets which layers
    // had none, so that game shows them when it is opened next.
    if (!first) useAtlas.setState({ tileRevision: useAtlas.getState().tileRevision + 1 });
  }
  clearTimeout(pollTimer);
  if (status.open) pollTimer = setTimeout(poll, POLL_MS);
}

function poll(): void {
  if (!shell) return;
  shell.status().then(receiveStatus, () => {
    pollTimer = setTimeout(poll, POLL_MS * 2);
  });
}

/** Asks the shell for a pack's recorded pages (once per opening of the list). */
export async function loadPages(packId: string): Promise<void> {
  if (!shell) return;
  set({ pages: { ...get().pages, [packId]: { state: 'loading' } } });
  try {
    const info = await shell.pages(packId);
    set({ pages: { ...get().pages, [packId]: { state: 'ready', info } } });
  } catch (error) {
    set({ pages: { ...get().pages, [packId]: { state: 'failed', message: errorText(error) } } });
  }
}

async function run(task: (bridge: PageViewBridge) => Promise<void>): Promise<boolean> {
  if (!shell) return false;
  set({ pending: true });
  try {
    await task(shell);
    return true;
  } catch (error) {
    notify(errorText(error), 'error');
    return false;
  } finally {
    set({ pending: false });
  }
}

/** Opens a recorded page in the app's own window, to look at it or while saving map images. */
export async function openMapPage(packId: string, url: string, save: boolean): Promise<boolean> {
  const opened = await run(async (bridge) => {
    receiveStatus(await bridge.open(packId, url, save));
  });
  if (opened) {
    setMapsDialogOpen(false);
    notify(
      save
        ? 'The map page is open in its own window. Pan and zoom it as you like; the map images it shows are saved.'
        : 'The map page is open in its own window.',
    );
  }
  return opened;
}

/** Stops saving; the page stays open to look at. */
export function stopSaving(): Promise<boolean> {
  return run(async (bridge) => {
    receiveStatus(await bridge.stopSaving());
  });
}

/** Closes the map page window. */
export function closeMapPage(): Promise<boolean> {
  return run(async (bridge) => {
    receiveStatus(await bridge.close());
  });
}

/** Hides the summary left after the window closed. */
export function dismissMapPage(): void {
  set({ status: null });
}

/** Opens a recorded page in the person's own browser. */
export async function openPageInBrowser(packId: string, url: string): Promise<void> {
  const opened = await run((bridge) => bridge.openInBrowser(packId, url));
  if (opened) notify('Opened the map page in your browser.');
}
