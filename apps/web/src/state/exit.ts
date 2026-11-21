import { useEffect } from 'react';
import { desktop } from '../desktop';
import { backgroundOffered, touchUiOffered } from '../features';
import { notify } from './actions';
import { loadBackground, useBackground } from './background';
import { useAtlas, type AtlasState } from './store';

/**
 * "Exit Atlas": ends the desktop app from inside it, as the tray's "Quit
 * Atlas" does (the shell's `app_exit`). Offered where the window may give
 * no other way: on Linux always, since Game Mode on a Steam Deck shows the
 * window without a frame or a close button (`DesktopInfo.exit`), and on
 * Windows while "Keep Atlas running when its window is closed" is on, where
 * closing the window only hides it. Never in a browser or the Android app.
 */
export function exitOffered(
  state: Pick<AtlasState, 'app'>,
  keepRunning: boolean | undefined,
): boolean {
  if (state.app === null || touchUiOffered(state)) return false;
  if (state.app.exit === true) return true;
  return backgroundOffered(state) && keepRunning === true;
}

/** Whether "Exit Atlas" is offered now; reads the background settings where they decide it. */
export function useExitOffered(): boolean {
  const keepRunning = useBackground((s) => s.state?.keepRunning);
  const decides = useAtlas((s) => backgroundOffered(s) && s.app?.exit !== true);
  const unread = decides && keepRunning === undefined;
  // On Windows the settings decide it: read them, if Settings has not yet.
  useEffect(() => {
    if (unread) void loadBackground();
  }, [unread]);
  return useAtlas((s) => exitOffered(s, keepRunning));
}

/** Ends Atlas. Says why not, when the shell refuses, and answers false then. */
export async function exitAtlas(): Promise<boolean> {
  if (!desktop) return false;
  try {
    await desktop.background.exit();
    return true;
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'error');
    return false;
  }
}
