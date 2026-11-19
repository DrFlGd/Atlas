import { create } from 'zustand';
import { desktop, type BackgroundSetting, type BackgroundState, type KeyPress } from '../desktop';
import { notify } from './actions';
import { showGame } from './libraryView';
import { started } from './packArrivals';
import { takeShown } from './showRequests';
import { useAtlas } from './store';

/**
 * "Atlas in the background", in the Settings of the desktop app without
 * downloads on Windows (see the shell's `background` module): keeping
 * Atlas running with an icon in the notification area, a hotkey, staying
 * above other windows and starting with Windows. The shell keeps the
 * settings and does each with the system; this module asks it and keeps
 * what it answered for the Settings group. A game another program asks
 * for is shown here too (see `showRequests.ts`).
 */

/** The help of each switch, one sentence each.  */
export const BACKGROUND_HELP = {
  keepRunning:
    'Closing the window hides it, and Atlas keeps running with its icon in the notification area, where a press on the icon shows or hides the window.',
  hotkey:
    'Press these keys in any program, a game too, to bring Atlas forward, and press them again while Atlas is in front to put it away.',
  onTop:
    'The window stays above other windows, such as a game in a borderless window, but a game in exclusive full screen covers every window, so set the game to borderless or windowed.',
  startWithSystem:
    'Atlas starts without coming to the front when you sign in to Windows, for your user only.',
} as const;

/** What the group says of the window as it comes back. */
export const BACKGROUND_BACK =
  'Hiding the window keeps everything as it was, so it comes back with the same game, map, location, zoom and panel, and while any of these is on, Atlas opens its window where you left it.';

export interface BackgroundView {
  state: BackgroundState | null;
  /** Why the settings could not be read. */
  error: string | null;
  /** Why the last change was refused, by what was changed (`keys`: the hotkey's keys). */
  refused: Partial<Record<BackgroundSetting | 'keys', string>>;
  /** A change is under way. */
  working: boolean;
}

export const useBackground = create<BackgroundView>()(() => ({
  state: null,
  error: null,
  refused: {},
  working: false,
}));

const set = useBackground.setState;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reads the settings, with what the system says. */
export async function loadBackground(): Promise<void> {
  if (!desktop) return;
  try {
    set({ state: await desktop.background.state(), error: null });
  } catch (error) {
    set({ error: errorText(error) });
  }
}

/** Runs one change; the settings after it, or why it was refused. */
async function change(
  what: BackgroundSetting | 'keys',
  run: () => Promise<BackgroundState>,
): Promise<boolean> {
  set({ working: true });
  try {
    const state = await run();
    set((view) => ({ state, refused: { ...view.refused, [what]: undefined }, working: false }));
    return true;
  } catch (error) {
    set((view) => ({ refused: { ...view.refused, [what]: errorText(error) }, working: false }));
    // What the system says may have changed meanwhile.
    void loadBackground();
    return false;
  }
}

/** Switches one setting on or off. */
export function switchBackground(setting: BackgroundSetting, on: boolean): Promise<boolean> {
  return change(setting, () => desktop!.background.set(setting, on));
}

/** Sets the hotkey's keys to those pressed. */
export function setHotkeyKeys(keys: KeyPress): Promise<boolean> {
  return change('keys', () => desktop!.background.setHotkey(keys));
}

/** The hotkey does nothing while the person presses new keys. */
export function pauseHotkey(paused: boolean): void {
  desktop?.background.pauseHotkey(paused).then(
    (state) => {
      set({ state });
    },
    () => undefined,
  );
}

/** Forgets why a change of the keys was refused, when the person stops pressing keys. */
export function clearRefusedKeys(): void {
  set((view) => ({ refused: { ...view.refused, keys: undefined } }));
}

/** The modifiers held, as the hotkey's text starts: "Ctrl+Alt+". Exported for tests. */
export function heldText(press: Pick<KeyPress, 'ctrl' | 'alt' | 'shift' | 'win'>): string {
  return [
    press.ctrl ? 'Ctrl+' : '',
    press.alt ? 'Alt+' : '',
    press.shift ? 'Shift+' : '',
    press.win ? 'Win+' : '',
  ].join('');
}

/** Whether a key is a modifier only, so the person is still pressing the combination. */
export function isModifierCode(code: string): boolean {
  return /^(Control|Alt|Shift|Meta|OS)(Left|Right)$/.test(code);
}

/** Shows the game another program asked for, once the app has started. */
async function showAsked(): Promise<void> {
  await started();
  const id = await takeShown(useAtlas.getState().game?.entry.id ?? null);
  if (id && useAtlas.getState().catalog.some((pack) => pack.id === id)) await showGame(id);
}

/**
 * Follows the shell's events: a game another program asked for, and the
 * settings changed from the tray. The function it returns stops.
 */
export function followBackground(): () => void {
  const bridge = desktop;
  if (!bridge) return () => undefined;
  const stops: (() => void)[] = [];
  let stopped = false;
  const keep = (stop: () => void) => {
    if (stopped) stop();
    else stops.push(stop);
  };
  void bridge.events
    .showRequested(() => {
      showAsked().catch((error: unknown) => {
        notify(errorText(error), 'error');
      });
    })
    .then(keep, () => undefined);
  void bridge.events
    .backgroundChanged((state) => {
      set({ state });
    })
    .then(keep, () => undefined);
  return () => {
    stopped = true;
    for (const stop of stops.splice(0)) stop();
  };
}
