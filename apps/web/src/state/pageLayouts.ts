import { pageLayoutRequestOf, type PageLayoutRequest } from '@atlas/importer-api';
import type { KeptSheetText } from '../layoutFrame/frameText';

/**
 * Laying pages out as a browser shows them, for an importer that asks
 * (`ImportContext.layOut` in the importer contract): one closed frame for a
 * convert call, opened at the first page that has style sheets to be laid
 * out with and removed at the end, its pages one at a time. Only in a build
 * with downloads, which reads pages and builds games again from them; the
 * frame's code (`src/layoutFrame/`) is loaded the first time it is needed.
 */

/** What was done to the pages a convert call asked to lay out. */
export interface LayoutTally {
  /** Pages laid out, with their notes. */
  laidOut: number;
  /** Pages not laid out: the game keeps none of the sheets they use. */
  noSheets: number;
  /** Pages not laid out otherwise: the time ran out, nothing to note, or an error. */
  missed: number;
}

/** Laying out the pages of one convert call. */
export interface PageLayouts {
  /** The importer's `layOut`: the page's HTML with the notes, or null. Never rejects. */
  layOut(page: PageLayoutRequest): Promise<string | null>;
  tally(): LayoutTally;
  /** Removes the frame, once the convert call is over. */
  close(): void;
}

/** The frame, as `src/layoutFrame/frame.ts` opens it. */
interface Frame {
  layOut(
    request: PageLayoutRequest,
    kept: readonly KeptSheetText[],
  ): Promise<{ kind: 'noted'; html: string } | { kind: 'skipped'; reason: string }>;
  close(): void;
}

export interface PageLayoutsOptions {
  /** The sheets kept for the game the pages go into; none when it keeps none, or is not known yet. */
  sheets: () => Promise<readonly KeptSheetText[]>;
  /** Opens the frame (`openLayoutFrame`); null when it cannot be opened. */
  open: () => Promise<Frame | null>;
  /** Called as each page is about to be laid out. */
  onPage?: () => void;
}

/**
 * The layouts of one convert call. The sheets are read once, at the first
 * page; a page whose game keeps none goes back as it came (null) without a
 * frame. Pages asked at once wait for each other.
 */
export function pageLayouts({ sheets, open, onPage }: PageLayoutsOptions): PageLayouts {
  const tally: LayoutTally = { laidOut: 0, noSheets: 0, missed: 0 };
  let kept: Promise<readonly KeptSheetText[]> | null = null;
  let frame: Promise<Frame | null> | null = null;
  let closed = false;
  // Set by `close`, which may come while a page waits for the frame.
  const isClosed = (): boolean => closed;
  let queue: Promise<unknown> = Promise.resolve();

  const one = async (value: unknown): Promise<string | null> => {
    const request = pageLayoutRequestOf(value);
    if (!request || isClosed()) return null;
    kept ??= sheets().catch(() => []);
    const texts = await kept;
    if (texts.length === 0) {
      tally.noSheets++;
      return null;
    }
    onPage?.();
    frame ??= open().catch(() => null);
    const opened = await frame;
    if (!opened || isClosed()) {
      tally.missed++;
      return null;
    }
    const laid = await opened.layOut(request, texts).catch(() => null);
    if (laid?.kind === 'noted') {
      tally.laidOut++;
      return laid.html;
    }
    if (laid?.reason === 'no-sheets') tally.noSheets++;
    else tally.missed++;
    return null;
  };

  return {
    layOut(page) {
      const done = queue.then(() => one(page));
      queue = done.catch(() => undefined);
      return done.catch(() => null);
    },
    tally: () => ({ ...tally }),
    close() {
      closed = true;
      // After the page being laid out, if any.
      void queue.then(() => frame?.then((opened) => opened?.close()));
    },
  };
}

const numberFormat = new Intl.NumberFormat('en');

/** What Build again says of laying its pages out. */
export type LayoutReport =
  /** The wiki keeps no style sheets: its pages were written from their HTML alone. */
  | { kind: 'no-sheets' }
  /** So many pages laid out, and so many that could not be. */
  | { kind: 'laid-out'; pages: number; missed: number };

/**
 * What Build again says of laying its pages out: nothing when the importer
 * asked for no page to be laid out; that the wiki keeps no style sheets
 * when it asked for some and there were none; else how many were laid out.
 */
export function layoutReport(tally: LayoutTally | null, hasSheets: boolean): LayoutReport | null {
  if (!tally || tally.laidOut + tally.noSheets + tally.missed === 0) return null;
  if (!hasSheets) return { kind: 'no-sheets' };
  return { kind: 'laid-out', pages: tally.laidOut, missed: tally.noSheets + tally.missed };
}

/** The words for a {@link LayoutReport}, in full sentences. */
export function layoutText(report: LayoutReport | null): string | null {
  if (!report) return null;
  if (report.kind === 'no-sheets') {
    return 'This wiki keeps no style sheets, so its pages were written from their HTML alone, not laid out as a browser shows them. Its sheets are kept as its pages are read again.';
  }
  const pages = numberFormat.format(report.pages);
  const laid =
    report.pages === 1
      ? '1 page was laid out as a browser shows it, with the wiki’s style sheets kept on this computer.'
      : `${pages} pages were laid out as a browser shows them, with the wiki’s style sheets kept on this computer.`;
  if (report.missed === 0) return laid;
  const missed = numberFormat.format(report.missed);
  return report.missed === 1
    ? `${laid} 1 page was written from its HTML alone, as the sheets it uses are not kept or it could not be laid out in time.`
    : `${laid} ${missed} pages were written from their HTML alone, as the sheets they use are not kept or they could not be laid out in time.`;
}
