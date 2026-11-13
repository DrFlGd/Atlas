import {
  findImporter,
  isAllowedPageUrl,
  refusalFor,
  type AtlasImporter,
  type PictureSummary,
} from '@atlas/importer-api';

/**
 * "Add a map" with several addresses at once: reading the pasted text, and
 * the run that works through the pages one at a time. Nothing here talks to
 * the shell; `importing.ts` opens, reads and saves each page the same way
 * as a single import, and hands the outcome to the run.
 *
 * The run opens only the pages the person listed, in their order, one at a
 * time in the same import window, with a pause between them. It never
 * retries a page. It stops when the person closes the page window or
 * presses Stop, and when two pages in a row end without their map data (a
 * site that asks a person to step in on every page, or refuses), rather than
 * opening the rest.
 */

/** Addresses one run takes at most. */
export const MAX_RUN_ADDRESSES = 25;
/** The pause after one page's window closes and before the next page opens. */
export const RUN_PAUSE_MS = 3000;
/** Pages in a row that end without their map data before the run stops. */
export const NO_DATA_IN_A_ROW = 2;

// ---------------------------------------------------------------------------
// The pasted text

export interface PastedAddresses {
  /** Each address once, in the order pasted. */
  addresses: string[];
  /** Exact repeats that were left out. */
  duplicates: number;
  /** More than {@link MAX_RUN_ADDRESSES} addresses. */
  tooMany: boolean;
}

/**
 * Splits pasted text into addresses: one per line, also split on spaces and
 * commas, trimmed, with exact repeats removed.
 */
export function parseAddresses(text: string): PastedAddresses {
  const seen = new Set<string>();
  const addresses: string[] = [];
  let duplicates = 0;
  for (const piece of text.split(/[\s,]+/u)) {
    const address = piece.trim();
    if (!address) continue;
    if (seen.has(address)) {
      duplicates++;
      continue;
    }
    seen.add(address);
    addresses.push(address);
  }
  return { addresses, duplicates, tooMany: addresses.length > MAX_RUN_ADDRESSES };
}

/** The message when more addresses are pasted than one run takes. */
export const tooManyMessage = (count: number) =>
  `That is ${count} addresses. This app adds at most ${MAX_RUN_ADDRESSES} maps at a time, so remove some and add them afterwards.`;

export interface CheckedAddress<T> {
  url: string;
  /** How the page was listed, when it was chosen from a game's list of pages. */
  listed?: { title: string; group?: string };
  /** The importer that recognises the address, or null. */
  importer: T | null;
  /** Why the address is left out, when no importer recognises it. */
  problem: string | null;
}

/** Why an address in a list is left out. */
export function leftOutReason(url: string): string {
  return isAllowedPageUrl(url)
    ? 'No importer in this app recognises this address.'
    : 'This is not a web address this app can open.';
}

/** Checks each address against the importers, as a single address is checked. */
export function checkAddresses<T extends Pick<AtlasImporter, 'matches' | 'refuses'>>(
  addresses: readonly string[],
  importers: readonly T[],
): CheckedAddress<T>[] {
  return addresses.map((url) => {
    // An address an importer refuses is never opened, whoever recognises it.
    const refusal = refusalFor(importers, url);
    if (refusal) return { url, importer: null, problem: refusal };
    const importer = findImporter(importers, url);
    return { url, importer, problem: importer ? null : leftOutReason(url) };
  });
}

// ---------------------------------------------------------------------------
// The run

/** Why a page was not added. */
export type FailureCause =
  /** The page did not hand over its map data in time, or its window did not open. */
  | 'no-data'
  /** The person closed the page window. */
  | 'closed'
  /** The run was cancelled while the page was open. */
  | 'cancelled'
  /** The data could not be used or saved: the importer refused it, a bundled game, … */
  | 'other'
  /** The site refused, asked to slow down or to confirm the reader is a person. */
  | 'refused';

export type RunPageState =
  /** Not reached yet. */
  | { kind: 'waiting' }
  /** The page is open in the import window; `measuring` once its map picture is measured from the page. */
  | {
      kind: 'open';
      startedAt: number;
      now: number;
      waitSeconds: number;
      loading: boolean;
      measuring?: boolean;
    }
  /** The page data is being turned into a map; `measuring` while its picture is measured. */
  | { kind: 'converting'; measuring?: boolean }
  | {
      kind: 'added';
      game: string;
      map: string;
      packId: string;
      mapId?: string;
      refreshed: boolean;
      /** The page became a checklist: its items, and rows left out. */
      checklist?: { items: number; leftOut: number };
      /** How the map's picture was sized, when the importer measured it or tried to. */
      picture?: PictureSummary;
      /** The page became a guide, read as a page. */
      guide?: boolean;
      /** Its pictures are fetched when the run is over (see `pagePictures.ts`). */
      pictures?: boolean;
    }
  /** A page that lists pages (a game page) or games was read. */
  | { kind: 'listed'; game: string; count: number; other: number }
  | { kind: 'failed'; message: string; cause: FailureCause }
  /** The run stopped before this page. */
  | { kind: 'not-started' };

export interface RunPage {
  url: string;
  state: RunPageState;
}

export type StopReason =
  /** The person closed the page window. */
  | 'closed'
  /** The person pressed Stop. */
  | 'stop'
  /** Two pages in a row ended without their map data. */
  | 'no-data'
  /** The dialog was closed, or another import took over. */
  | 'cancelled'
  /** A site refused, asked to slow down or to confirm the reader is a person. */
  | 'refused';

export interface RunState {
  pages: RunPage[];
  /** Addresses left out before the run, because no importer recognises them. */
  leftOut: number;
  status: 'running' | 'finished' | 'stopped';
  /** Stop was pressed: the run ends after the current page. */
  stopRequested: boolean;
  /** Between two pages. */
  pausing: boolean;
  stopReason: StopReason | null;
}

/** How one page ended, as `importing.ts` reports it. */
export type PageOutcome =
  | {
      kind: 'added';
      game: string;
      map: string;
      packId: string;
      mapId?: string;
      refreshed: boolean;
      /** The page became a checklist: its items, and rows left out. */
      checklist?: { items: number; leftOut: number };
      /** How the map's picture was sized, when the importer measured it or tried to. */
      picture?: PictureSummary;
      /** The page became a guide, read as a page. */
      guide?: boolean;
      /** Its pictures are fetched when the run is over (see `pagePictures.ts`). */
      pictures?: boolean;
    }
  /** A list was read: `count` pages (or games) the app can add, `other` it cannot yet. */
  | { kind: 'listed'; game: string; count: number; other: number }
  /** The data could not be used or saved; the run goes on. */
  | { kind: 'failed'; message: string }
  /** No data within the wait, or the window did not open; the run goes on, unless twice in a row. */
  | { kind: 'no-data'; message: string }
  /** The person closed the page window; the run stops. */
  | { kind: 'closed'; message: string }
  /** The site refused or asked to slow down, or to confirm the reader is a person; the run stops at once. */
  | { kind: 'refused'; message: string }
  /** The run was cancelled; it stops. */
  | { kind: 'cancelled'; message: string };

export function newRun(urls: readonly string[], leftOut = 0): RunState {
  return {
    pages: urls.map((url) => ({ url, state: { kind: 'waiting' } })),
    leftOut,
    status: 'running',
    stopRequested: false,
    pausing: false,
    stopReason: null,
  };
}

/** Sets the state of one page. */
export function updatePage(run: RunState, index: number, state: RunPageState): RunState {
  return {
    ...run,
    pages: run.pages.map((page, i) => (i === index ? { ...page, state } : page)),
  };
}

/** Ends the run: pages not reached are marked as not started. */
export function endRun(run: RunState, reason: StopReason | null): RunState {
  return {
    ...run,
    pausing: false,
    status: reason ? 'stopped' : 'finished',
    stopReason: reason,
    pages: run.pages.map((page) =>
      page.state.kind === 'waiting' ? { ...page, state: { kind: 'not-started' } } : page,
    ),
  };
}

const pageState = (outcome: PageOutcome): RunPageState => {
  switch (outcome.kind) {
    case 'added': {
      const { kind: _, ...added } = outcome;
      return { kind: 'added', ...added };
    }
    case 'listed':
      return { ...outcome };
    case 'failed':
      return { kind: 'failed', message: outcome.message, cause: 'other' };
    case 'no-data':
      return { kind: 'failed', message: outcome.message, cause: 'no-data' };
    case 'closed':
      return { kind: 'failed', message: outcome.message, cause: 'closed' };
    case 'refused':
      return { kind: 'failed', message: outcome.message, cause: 'refused' };
    case 'cancelled':
      return { kind: 'failed', message: outcome.message, cause: 'cancelled' };
  }
};

const isNoData = (page: RunPage | undefined) =>
  page?.state.kind === 'failed' && page.state.cause === 'no-data';

/**
 * Records how page `index` ended and decides what happens next: the run
 * stops when the window was closed or the run cancelled; when this page and
 * the one before it both ended without data and pages remain; and when Stop
 * was pressed and pages remain. Otherwise it goes on, or finishes after the
 * last page.
 */
export function settlePage(run: RunState, index: number, outcome: PageOutcome): RunState {
  const next = updatePage(run, index, pageState(outcome));
  if (outcome.kind === 'closed') return endRun(next, 'closed');
  if (outcome.kind === 'cancelled') return endRun(next, 'cancelled');
  if (outcome.kind === 'refused') return endRun(next, 'refused');
  const last = index === next.pages.length - 1;
  if (last) return endRun(next, null);
  let inARow = 0;
  for (let i = index; i >= 0 && isNoData(next.pages[i]); i--) inARow++;
  if (inARow >= NO_DATA_IN_A_ROW) return endRun(next, 'no-data');
  if (next.stopRequested) return endRun(next, 'stop');
  return next;
}

export interface RunCounts {
  added: number;
  refreshed: number;
  notAdded: number;
  notStarted: number;
}

export function runCounts(run: RunState): RunCounts {
  const counts: RunCounts = { added: 0, refreshed: 0, notAdded: 0, notStarted: 0 };
  for (const { state } of run.pages) {
    if (state.kind === 'added') {
      if (state.refreshed) counts.refreshed++;
      else counts.added++;
    } else if (state.kind === 'failed') counts.notAdded++;
    else if (state.kind === 'not-started' || state.kind === 'waiting') counts.notStarted++;
  }
  return counts;
}

/**
 * "4 maps added, 1 refreshed, 1 not added": the run in one line, without the
 * full stop ("pages" when checklists were added too).
 */
export function runSummary(run: RunState): string {
  const counts = runCounts(run);
  const parts: [number, string][] = [
    [counts.added, 'added'],
    [counts.refreshed, 'refreshed'],
    [counts.notAdded, 'not added'],
    [counts.notStarted, 'not started'],
  ];
  const shown = parts.filter(([count]) => count > 0);
  // A run that added checklists or guides counts pages.
  const noun = run.pages.some(
    ({ state }) =>
      state.kind === 'added' && (state.checklist !== undefined || state.guide === true),
  )
    ? ['page', 'pages']
    : ['map', 'maps'];
  return shown
    .map(([count, what], i) =>
      i === 0 ? `${count} ${count === 1 ? noun[0] : noun[1]} ${what}` : `${count} ${what}`,
    )
    .join(', ');
}

/** Why the run stopped early, in words. */
export function stopReasonText(reason: StopReason): string {
  switch (reason) {
    case 'closed':
      return 'The page window was closed, so this app stopped and opened no more pages.';
    case 'stop':
      return 'You stopped adding maps, so the pages after that were not opened.';
    case 'no-data':
      return 'Two pages in a row did not provide their map data, so this app stopped rather than open the rest. The site may be asking you to sign in or to confirm you are a person, or it may not be letting maps load just now. You can try the rest later.';
    case 'cancelled':
      return 'Adding maps was cancelled.';
    case 'refused':
      return 'The site refused a page, asked to slow down or asked to confirm you are a person, so this app stopped at once and read no more pages. Nothing is tried again or around it; you can try the rest another day.';
  }
}

/** What the run needs from the app: open and read one page, and wait. */
export interface RunDriver {
  /** Opens, reads and saves one page, reporting its state as it goes. */
  importPage(
    index: number,
    url: string,
    update: (state: RunPageState) => void,
  ): Promise<PageOutcome>;
  /** Waits `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
  /** Called with every new state of the run. */
  onChange(run: RunState): void;
}

/**
 * Works through the pages one at a time, in order, with a pause between
 * them. Never two pages at once, and no page twice.
 */
export class ImportRun {
  state: RunState;
  private cancelled = false;
  private wake: (() => void) | null = null;

  constructor(
    urls: readonly string[],
    leftOut: number,
    private readonly driver: RunDriver,
    private readonly pauseMs = RUN_PAUSE_MS,
    /** A pause before the first page too, when a page closed just before the run. */
    private readonly firstPauseMs = 0,
  ) {
    this.state = newRun(urls, leftOut);
  }

  private set(state: RunState) {
    this.state = state;
    this.driver.onChange(state);
  }

  /** Stop after the current page; during the pause, stop now. */
  stop(): void {
    if (this.state.status !== 'running' || this.state.stopRequested) return;
    this.set({ ...this.state, stopRequested: true });
    this.wake?.();
  }

  /** Stop as soon as the current page lets go (the app has closed its window). */
  cancel(): void {
    this.cancelled = true;
    this.wake?.();
  }

  async run(): Promise<RunState> {
    for (let index = 0; index < this.state.pages.length; index++) {
      const pause = index > 0 ? this.pauseMs : this.firstPauseMs;
      if (index > 0 || pause > 0) {
        this.set({ ...this.state, pausing: true });
        if (!this.cancelled && !this.state.stopRequested) {
          await new Promise<void>((resolve) => {
            this.wake = resolve;
            void this.driver.sleep(pause).then(() => {
              resolve();
            });
          });
          this.wake = null;
        }
        this.set({ ...this.state, pausing: false });
        if (this.cancelled) {
          this.set(endRun(this.state, 'cancelled'));
          break;
        }
        if (this.state.stopRequested) {
          this.set(endRun(this.state, 'stop'));
          break;
        }
      }
      const url = this.state.pages[index]!.url;
      const outcome = await this.driver.importPage(index, url, (state) => {
        this.set(updatePage(this.state, index, state));
      });
      let next = settlePage(this.state, index, outcome);
      if (this.cancelled && next.status === 'running') next = endRun(next, 'cancelled');
      this.set(next);
      if (next.status !== 'running') break;
    }
    return this.state;
  }
}
