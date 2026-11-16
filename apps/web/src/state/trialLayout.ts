import { pageLayoutRequestOf, type PageLayoutRequest } from '@atlas/importer-api';
import type { FrameSheets, LaidOut } from '../layoutFrame/frame';

/**
 * Laying a saved page out for a trial of a site rules file
 * (`SiteTrialRequest.layOut` in the importer contract): the closed frame of
 * `src/layoutFrame/` (no script runs, nothing is fetched, every address in
 * a sheet made empty, pictures boxes of their size), with the style sheets
 * the saved page holds in its own `<style>` blocks only. A page that links
 * to sheets it does not hold ("Webpage, complete", whose sheets are files
 * beside it), or that holds none, is not laid out: the importer then reads
 * the layout its HTML states, and the person is told which of the two was
 * done, and why ({@link trialLayoutSentence}).
 */

/** What became of the page the importer asked to lay out. */
export type TrialLayoutOutcome =
  /** Laid out with the sheets saved inside it: read by position. */
  | 'laid-out'
  /** It holds no style sheets. */
  | 'no-sheets'
  /** It links to style sheets it does not hold. */
  | 'linked-sheets'
  /** It could not be laid out in time, or at all. */
  | 'missed';

/** The frame, as `openLayoutFrame` opens it. */
interface Frame {
  layOut(request: PageLayoutRequest, kept: FrameSheets): Promise<LaidOut>;
  close(): void;
}

/** Laying out the page of one trial. */
export interface TrialLayouts {
  /** The importer's `layOut`: the page's HTML with the notes, or null. Never rejects. */
  layOut(page: PageLayoutRequest): Promise<string | null>;
  /** What became of the last page asked; null when none was. */
  outcome(): TrialLayoutOutcome | null;
  /** Removes the frame, if one was opened. */
  close(): void;
}

/** The layouts of one trial, in a frame `open` opens the first time a page is asked. */
export function trialLayouts(open: () => Promise<Frame | null>): TrialLayouts {
  let outcome: TrialLayoutOutcome | null = null;
  let frame: Promise<Frame | null> | null = null;
  let closed = false;
  /** Read afresh after each wait: the trial may have closed the frame meanwhile. */
  const isClosed = () => closed;
  return {
    async layOut(value) {
      try {
        const request = pageLayoutRequestOf(value);
        if (!request || closed) {
          outcome = 'missed';
          return null;
        }
        frame ??= open().catch(() => null);
        const opened = await frame;
        if (!opened || isClosed()) {
          outcome = 'missed';
          return null;
        }
        const laid = await opened.layOut(request, 'own');
        if (laid.kind === 'noted') {
          outcome = 'laid-out';
          return laid.html;
        }
        outcome =
          laid.reason === 'no-sheets'
            ? 'no-sheets'
            : laid.reason === 'linked-sheets'
              ? 'linked-sheets'
              : 'missed';
        return null;
      } catch {
        outcome = 'missed';
        return null;
      }
    },
    outcome: () => outcome,
    close() {
      closed = true;
      void frame?.then((opened) => opened?.close()).catch(() => undefined);
    },
  };
}

/**
 * Which of the two ways the trial read the page's layout, and why, in one
 * plain sentence (with what the person can do where there is something):
 * null when the importer asked for no layout.
 */
export function trialLayoutSentence(outcome: TrialLayoutOutcome | null): string | null {
  switch (outcome) {
    case 'laid-out':
      return 'The app laid the page out with the style sheets saved inside it, so it was read by position, as a page read in the app’s window is.';
    case 'no-sheets':
      return 'The saved page holds no style sheets, so it was read by the layout its HTML states, not by position. To try it by position, save the page as one file with its style sheets inside it.';
    case 'linked-sheets':
      return 'The saved page links to style sheets it does not hold, so it was read by the layout its HTML states, not by position. To try it by position, save the page as one file with its style sheets inside it.';
    case 'missed':
      return 'The page could not be laid out in time, so it was read by the layout its HTML states, not by position.';
    default:
      return null;
  }
}
