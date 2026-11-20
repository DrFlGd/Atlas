/**
 * Which version of the standard layout Automatic shows: the one made for
 * fingers or the one made for a mouse (the setting "Controls", see
 * `uiMode.ts`). This file decides; `followControls.ts` listens to the
 * page and applies what is decided.
 *
 * The rule:
 *
 * - At the start, for fingers on a touch screen without a mouse (a phone
 *   or a tablet: `(hover: none) and (pointer: coarse)`, the rule before
 *   this setting existed) and on what looks like a Steam Deck: Linux, a
 *   screen of 1280 by 800 (either way round) and a touch screen
 *   (`navigator.maxTouchPoints > 0`). Its trackpads make the system report
 *   a mouse, so the first rule alone would show the version for a mouse.
 *   Everywhere else, for a mouse.
 * - A press of a finger on the screen (a pointer event whose
 *   `pointerType` is `touch`) gives the version for fingers, which then
 *   stays for the rest of the run.
 * - Only a mouse used for a while gives the version for a mouse again: at
 *   least {@link MOUSE_PRESSES} presses of a mouse button since the last
 *   touch, the last of them at least {@link MOUSE_WHILE_MS} after that
 *   touch (or after the start). Moving the mouse alone does not count, nor
 *   does a pen. On a phone, a tablet or a Steam Deck, where the version for
 *   fingers was there from the start, it stays for fingers: there a mouse
 *   (or the Deck's trackpads, or a touch screen that Steam passes on as a
 *   mouse) is not taken as a reason to leave it.
 *
 * So one stray press of the mouse never changes the layout under a finger,
 * and a mouse and a finger used in turn keep the version for fingers.
 * `followControls.ts` also never changes it while a finger is down, a
 * dialog is open or a text field has the focus.
 */

/** What the standard layout is made for. */
export type Input = 'touch' | 'mouse';

/** The setting "Controls": decided as below, or always the one chosen. */
export type Controls = 'auto' | 'touch' | 'mouse';

/** Why Automatic shows what it shows, for the setting's "Now:" sentence. */
export type AutoReason =
  /** A touch screen without a mouse (a phone or a tablet). */
  | 'touch-screen'
  /** Linux with a touch screen of 1280 by 800, as a Steam Deck's. */
  | 'steam-deck'
  /** A finger pressed the screen. */
  | 'touched'
  /** A computer with a mouse whose screen has not been touched. */
  | 'mouse'
  /** The mouse was used for a while without a touch. */
  | 'mouse-used';

/** What Automatic shows, and why. */
export interface AutoInput {
  input: Input;
  reason: AutoReason;
}

/** Automatic's state: what it shows, and what it counts towards the mouse rule. */
export interface AutoControls extends AutoInput {
  /** The version for fingers stays: it was there from the start (a phone, a tablet, a Steam Deck). */
  stays: boolean;
  /** The start, or the last touch, in milliseconds. */
  since: number;
  /** Presses of a mouse button since then. */
  mousePresses: number;
}

/** Presses of a mouse button that give the version for a mouse again. */
export const MOUSE_PRESSES = 5;

/** How long after the last touch the mouse must have been used: two minutes. */
export const MOUSE_WHILE_MS = 2 * 60_000;

/** What the screen and the system say at the start. */
export interface ScreenFacts {
  /** A touch screen without a mouse: `(hover: none) and (pointer: coarse)`. */
  coarse: boolean;
  /** The system is Linux (not Android). */
  linux: boolean;
  /** The screen's size in CSS pixels (`screen.width`, `screen.height`). */
  width: number;
  height: number;
  /** `navigator.maxTouchPoints`: more than 0 where there is a touch screen. */
  touchPoints: number;
}

/** Whether the screen looks like a Steam Deck's: Linux, 1280 by 800 either way round, a touch screen. */
export function deckScreen(screen: ScreenFacts): boolean {
  const size = [screen.width, screen.height].sort((a, b) => a - b);
  return screen.linux && screen.touchPoints > 0 && size[0] === 800 && size[1] === 1280;
}

/** What Automatic shows at the start. */
export function startingControls(screen: ScreenFacts, now: number): AutoControls {
  const reason: AutoReason = screen.coarse
    ? 'touch-screen'
    : deckScreen(screen)
      ? 'steam-deck'
      : 'mouse';
  return {
    input: reason === 'mouse' ? 'mouse' : 'touch',
    reason,
    stays: reason !== 'mouse',
    since: now,
    mousePresses: 0,
  };
}

/**
 * Automatic after a press of a pointer (`pointerdown`) of the type given
 * (`PointerEvent.pointerType`) at `now`. The same object when nothing
 * changes.
 */
export function afterPress(state: AutoControls, pointerType: string, now: number): AutoControls {
  if (pointerType === 'touch') {
    return { ...state, input: 'touch', reason: 'touched', since: now, mousePresses: 0 };
  }
  if (pointerType !== 'mouse' || state.input === 'mouse' || state.stays) return state;
  const mousePresses = state.mousePresses + 1;
  if (mousePresses >= MOUSE_PRESSES && now - state.since >= MOUSE_WHILE_MS) {
    return { ...state, input: 'mouse', reason: 'mouse-used', since: now, mousePresses: 0 };
  }
  return { ...state, mousePresses };
}

/** The version shown, given the setting and what Automatic shows. */
export function inputFor(controls: Controls, auto: Input): Input {
  return controls === 'auto' ? auto : controls;
}

/** A saved setting as Controls: Automatic unless it names one of the others. */
export function parseControls(value: unknown): Controls {
  return value === 'touch' || value === 'mouse' ? value : 'auto';
}

/** The setting's "Now:" sentence for Automatic. */
export function nowSentence(auto: AutoInput): string {
  switch (auto.reason) {
    case 'touch-screen':
      return 'Now: for fingers, because this screen is a touch screen without a mouse.';
    case 'steam-deck':
      return 'Now: for fingers, because this looks like a Steam Deck, with a touch screen of 1280 by 800 on Linux.';
    case 'touched':
      return 'Now: for fingers, because the screen was touched.';
    case 'mouse':
      return 'Now: for a mouse, because the screen has not been touched.';
    case 'mouse-used':
      return 'Now: for a mouse, because the mouse was used for a while without a touch.';
  }
}
