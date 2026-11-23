import { create } from 'zustand';
import { keyLabel, keysOf } from '../input/bindings';
import { saveSetting } from '../state/actions';
import { SETTINGS, progressStore } from '../state/services';

/**
 * Whether the contents beside a page in Guides (the bar, on a computer or
 * a tablet) is open or folded away, as the person last chose: one choice
 * for every game, kept on this device. Open until they fold it. A phone
 * shows the contents as a screen of its own, and has no bar to fold.
 */
export interface GuidesBarState {
  open: boolean;
  /** The person chose since the app started: what is kept, read later, is older. */
  chosen: boolean;
}

export const useGuidesBar = create<GuidesBarState>()(() => ({ open: true, chosen: false }));

/** The key that folds the bar and brings it back, as its buttons do (see `input/bindings.ts`). */
export const BAR_KEY = keyLabel(keysOf('guides-bar')[0]!);

/** What is kept, as whether the bar is open: open unless it was folded. */
export function parseBarOpen(value: unknown): boolean {
  return value !== false;
}

/** Reads whether the bar was folded when the app was last used on this device. */
export async function loadGuidesBar(): Promise<void> {
  let saved: unknown;
  try {
    saved = await progressStore().getSetting(SETTINGS.guidesBar);
  } catch {
    // Open, as at first.
    return;
  }
  if (!useGuidesBar.getState().chosen) useGuidesBar.setState({ open: parseBarOpen(saved) });
}

/** Folds the bar away (`false`) or brings it back, and keeps that for the next time. */
export function setGuidesBarOpen(open: boolean): void {
  useGuidesBar.setState({ open, chosen: true });
  saveSetting(SETTINGS.guidesBar, open);
}
