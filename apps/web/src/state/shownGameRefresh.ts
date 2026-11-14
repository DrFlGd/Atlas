import { usePageEditor } from '../touch/pages/pageEditorState';
import { reloadShownGame, switchGame } from './actions';
import { useAtlas } from './store';

/**
 * The game shown, loaded again after a step wrote its pack without showing
 * it: a go (at its end, and during a long one; Read again and Try again
 * of one page are a go too), browse and keep. Pictures of pages are files
 * beside the pack and show without it. Without this the game shown keeps the
 * pack as it was loaded, so pages read since have no text in it and links
 * to them stay dotted until the game is shown again.
 *
 * - Never while the person edits a page: the game is loaded again once
 *   the page editor closes.
 * - During a go, at most once a minute ({@link REFRESH_DURING_GO_MS}), so a
 *   go of a thousand pages does not load a large wiki over and over; at
 *   the end of the go, always.
 * - Another game shown: left alone; showing the wiki later reads it anyway.
 */

/** During a go, the game shown is loaded again at most this often. */
export const REFRESH_DURING_GO_MS = 60_000;

const lastLoaded = new Map<string, number>();
let waitingForEditor: Set<string> | null = null;

function reloadNow(packId: string): void {
  lastLoaded.set(packId, Date.now());
  void reloadShownGame(packId);
}

/**
 * The pack `packId` was written without showing it. `duringGo`: a page of a
 * go that goes on; the game is loaded again only if it was not in the last
 * minute.
 */
export function packWritten(packId: string, { duringGo = false } = {}): void {
  if (useAtlas.getState().game?.entry.id !== packId) return;
  if (duringGo && Date.now() - (lastLoaded.get(packId) ?? 0) < REFRESH_DURING_GO_MS) return;
  if (!usePageEditor.getState().open) {
    reloadNow(packId);
    return;
  }
  // The person is editing a page: once the editor closes.
  if (waitingForEditor) {
    waitingForEditor.add(packId);
    return;
  }
  const waiting = new Set([packId]);
  waitingForEditor = waiting;
  const stop = usePageEditor.subscribe((state) => {
    if (state.open) return;
    stop();
    waitingForEditor = null;
    for (const id of waiting) {
      if (useAtlas.getState().game?.entry.id === id) reloadNow(id);
    }
  });
}

/**
 * "Show this wiki" on the wiki's screen: shows the game, or, when it is the
 * game shown already, loads it again, so pages read since it was loaded
 * show their text. Never a button that does nothing.
 */
export async function showWiki(gameId: string): Promise<void> {
  if (useAtlas.getState().game?.entry.id === gameId) {
    lastLoaded.set(gameId, Date.now());
    await reloadShownGame(gameId);
  } else {
    await switchGame(gameId);
  }
}
