import { flushGuideLinks } from './guideLinks';
import { flushOwnLists } from './ownLists';
import { flushOwnLocations } from './ownLocations';
import { flushOwnNotes } from './ownNotes';
import { flushOwnPages } from './ownPages';
import { flushOwnRoutes } from './ownRoutes';
import { flushWikiNotes } from './wikiNotes';

/** The longest wait for the files to be written. */
const SAVE_WAIT_MS = 10_000;

/**
 * Saves now what the person changed and Atlas keeps to save a moment
 * later, before the desktop app ends by itself ("Exit Atlas", installing an
 * update): the same as when the page goes away (`pagehide`, which also
 * keeps the page being edited as a draft), then waits until the files are
 * written. A save that fails says so where it always does; ending goes on.
 */
export async function saveEverything(): Promise<void> {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('pagehide'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A write that never answers does not keep Atlas from ending.
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SAVE_WAIT_MS);
  });
  await Promise.race([
    Promise.allSettled([
      flushOwnLists(),
      flushOwnLocations(),
      flushGuideLinks(),
      flushOwnPages(),
      flushOwnNotes(),
      flushOwnRoutes(),
      flushWikiNotes(),
    ]),
    late,
  ]);
  clearTimeout(timer);
}
