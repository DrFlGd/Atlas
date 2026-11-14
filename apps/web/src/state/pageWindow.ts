import { checkPageObservations, type PageObservations } from '@atlas/importer-api';
import type { DesktopBridge, ImportReport, PollResult } from '../desktop';
import { RUN_PAUSE_MS, WINDOW_PAGE_PAUSE_MS } from './importRun';

/**
 * Reading one page in the import window: open it (or, in a go of pages an
 * importer opens in a window through `fetch.inWindow`, move the window kept
 * for the go to it), ask it for its data until it appears, the window is
 * closed or the wait runs out, and let it go. Nothing here knows about the
 * rest of the app, so it is tested on its own (`pageWindow.test.ts`).
 *
 * A window kept for a go is opened in front for its first page only; each
 * later page of the go on the same site is loaded in that window, which the
 * shell does not focus or bring to the front. It is closed when the go ends,
 * is stopped or fails ({@link PageWindows.release}), and when the person
 * closes it the go stops, as before. Map pages, and pages whose map picture
 * is measured, always get a window of their own, closed once read.
 */

/** How often the open page is asked for its data. */
export const POLL_MS = 2000;
/**
 * How often a page of a go read in the window kept for it is asked for its
 * data: it is read as soon as it has loaded. The shell reads it only once
 * the page asked for has finished loading.
 */
export const KEPT_POLL_MS = 500;
/** After this long, the dialog explains what may be holding the page up. */
export const STILL_WAITING_SECONDS = 20;

/** A wait in words: "45 seconds", "5 minutes". */
export const waitText = (seconds: number) =>
  seconds < 120 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;

/** What a page is read for. */
export type Reading = 'map' | 'game' | 'catalogue';

export const READING_NOUN: Record<Reading, string> = {
  map: 'the map data',
  game: 'the list of its pages',
  catalogue: 'the list of games',
};

/** How reading one page ended. */
export type PageRead =
  /** The data, and what the page loaded when it was measured. */
  | { state: 'ready'; data: string; page?: PageObservations }
  /** The person closed the page window. */
  | { state: 'closed'; message: string }
  /** The page's data could not be used (not JSON, too large). */
  | { state: 'failed'; message: string }
  /** The data did not appear within the wait (reported to the log). */
  | { state: 'timed-out'; message: string }
  /** The window did not open. */
  | { state: 'open-failed'; message: string }
  /** The site refused, asked to slow down, or robots.txt does not allow the page: stop. */
  | { state: 'refused'; message: string }
  /** Another import or a cancel took over. */
  | { state: 'cancelled' };

export const closedMessage = (reading: Reading) =>
  `The page window was closed before the page provided ${READING_NOUN[reading]}. Nothing was added.`;

/** How the page is doing while the app waits for its data. */
export interface PageWaiting {
  startedAt: number;
  now: number;
  waitSeconds: number;
  loading: boolean;
  note: string | null;
  /** The data has been read and the map picture is being measured from the page. */
  measuring?: boolean;
  /** The kept window has loaded the page and asked for the person's attention: it waits for them. */
  attention?: boolean;
}

/** The import window's commands. */
export type WindowShell = Pick<
  DesktopBridge['importWindow'],
  'open' | 'navigate' | 'poll' | 'close'
>;

/** One page to read in the window. */
export interface WindowRequest {
  url: string;
  importer: { id: string };
  pageReader: string;
  waitSeconds: number;
  reading: Reading;
  /** The importer's page measuring step, when the map picture is to be measured from the page. */
  measure: string | null;
  /**
   * The go the page is read in, when its window is kept for the go's next
   * pages on the same site; null for a window of its own. Ignored with
   * `measure`.
   */
  keepFor: number | null;
  onWaiting: (waiting: PageWaiting) => void;
}

/** What reading in the window needs from the app. */
export interface WindowDeps {
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Records how an import ended in the activity log. */
  report(entry: ImportReport): void;
}

/** The window kept for a go: which go, for which importer, on which site, and the page it was last asked for. */
interface Kept {
  go: number;
  importerId: string;
  origin: string;
  /** The addresses of the page read before the one asked for now: never taken for it. */
  before: string[];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** An address without its fragment, to compare pages. */
const pageOf = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
};

/**
 * The import window as the app uses it: at most one window, kept or not,
 * and when it last let go of a page, for the pause before the next one.
 */
export class PageWindows {
  private kept: Kept | null = null;
  /** When the window last let go of a page: closed, or a kept window's page read. */
  releasedAt = 0;

  constructor(private readonly deps: WindowDeps) {}

  /** Whether `url` of go `go` would be read in the window kept from the page before. */
  continues(go: number, importerId: string, url: string): boolean {
    const kept = this.kept;
    return (
      kept !== null &&
      kept.go === go &&
      kept.importerId === importerId &&
      originOf(url) !== null &&
      kept.origin === originOf(url)
    );
  }

  /**
   * The pause before `url` of go `go`: {@link WINDOW_PAGE_PAUSE_MS} when it
   * is read in the window kept from the page before, else {@link RUN_PAUSE_MS}.
   */
  pauseBefore(go: number, importerId: string, url: string): number {
    return this.continues(go, importerId, url) ? WINDOW_PAGE_PAUSE_MS : RUN_PAUSE_MS;
  }

  /** Closes the window, kept or not. */
  async close(shell: WindowShell): Promise<void> {
    this.kept = null;
    await shell.close().catch(() => undefined);
    this.releasedAt = this.deps.now();
  }

  /** At the end of go `go`, however it ended: closes the window kept for it, if it is still open. */
  async release(shell: WindowShell, go: number): Promise<void> {
    if (this.kept?.go === go) await this.close(shell);
  }

  /**
   * Reads one page: opens it, or moves the window kept for the go to it,
   * and asks it for its data until it appears, the window is closed or the
   * wait runs out. A window of its own is closed then; a kept one stays for
   * the next page. `current` is false once another import or a cancel took
   * over.
   */
  async read(
    shell: WindowShell,
    request: WindowRequest,
    current: () => boolean,
  ): Promise<PageRead> {
    const { deps } = this;
    const { url, pageReader, waitSeconds, reading, measure, onWaiting } = request;
    const importer = { id: request.importer.id, waitSeconds };
    const keepFor = measure === null ? request.keepFor : null;
    const keep = keepFor !== null;
    const startedAt = deps.now();
    onWaiting({ startedAt, now: startedAt, waitSeconds, loading: true, note: null });
    const continuing = keepFor !== null && this.continues(keepFor, importer.id, url);
    try {
      if (continuing) {
        const moved = await shell.navigate(url, pageReader, importer);
        if (moved === 'closed') {
          this.kept = null;
          this.releasedAt = deps.now();
          return current()
            ? { state: 'closed', message: closedMessage(reading) }
            : { state: 'cancelled' };
        }
      } else {
        // The shell closes any window open before.
        this.kept = null;
        await shell.open(
          url,
          pageReader,
          importer,
          reading,
          measure ?? undefined,
          keep || undefined,
        );
      }
    } catch (error) {
      // A kept window that could not move is closed: the next page opens a window of its own.
      if (continuing) await this.close(shell);
      this.kept = null;
      this.releasedAt = deps.now();
      return current()
        ? { state: 'open-failed', message: errorText(error) }
        : { state: 'cancelled' };
    }
    const before = continuing ? (this.kept?.before ?? []) : [];
    if (keepFor !== null) {
      this.kept = { go: keepFor, importerId: importer.id, origin: originOf(url) ?? '', before };
    }

    /** Lets go of the page: a window of its own is closed, a kept one stays for the next page. */
    const letGo = async () => {
      if (keep && this.kept) this.releasedAt = deps.now();
      else await this.close(shell);
    };
    /** Notes the page read as the one before the next page. */
    const readFrom = (address: string | undefined) => {
      if (this.kept) {
        this.kept.before = [pageOf(url), ...(address ? [pageOf(address)] : [])];
      }
    };
    // In a kept window, data from the page shown before is never taken for this one.
    const stale = (address: string | undefined) =>
      keep &&
      address !== undefined &&
      pageOf(address) !== pageOf(url) &&
      before.includes(pageOf(address));

    // Once the data is read, measuring the page has bounds of its own in the shell.
    let measuring = false;
    for (;;) {
      await deps.sleep(keep ? KEPT_POLL_MS : POLL_MS);
      if (!current()) return { state: 'cancelled' };
      const now = deps.now();
      if (!measuring && now - startedAt > waitSeconds * 1000) {
        readFrom(undefined);
        await letGo();
        const message = `The page did not provide ${READING_NOUN[reading]} within ${waitText(waitSeconds)}. If it asked you to sign in, to confirm you are a person or to wait, it may not have let the ${reading === 'map' ? 'map' : 'page'} load; you can try again later. Nothing was added.`;
        deps.report({ importerId: importer.id, outcome: 'timed-out', message });
        return { state: 'timed-out', message };
      }
      let result: PollResult;
      try {
        result = await shell.poll();
      } catch (error) {
        result = { state: 'failed', message: errorText(error) };
      }
      if (!current()) return { state: 'cancelled' };
      if (result.state === 'ready' && stale(result.address)) {
        result = { state: 'waiting', loading: true, note: null };
      }
      if (result.state === 'waiting') {
        onWaiting({
          startedAt,
          now,
          waitSeconds,
          loading: result.loading,
          note: result.note,
          ...(keep && result.attention === true ? { attention: true } : {}),
        });
        continue;
      }
      if (result.state === 'measuring') {
        measuring = true;
        onWaiting({ startedAt, now, waitSeconds, loading: false, note: null, measuring: true });
        continue;
      }
      if (result.state === 'closed') {
        await this.close(shell);
        return { state: 'closed', message: closedMessage(reading) };
      }
      readFrom(result.state === 'ready' ? result.address : undefined);
      await letGo();
      if (result.state === 'failed') return { state: 'failed', message: result.message };
      // What the page loaded is handed on only when it was asked for and has the expected shape.
      const page = measure && result.page !== undefined ? checkPageObservations(result.page) : null;
      return { state: 'ready', data: result.data, ...(page ? { page } : {}) };
    }
  }
}
