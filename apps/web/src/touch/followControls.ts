import { isTypingTarget } from '../keyboard';
import { useAtlas } from '../state/store';
import { afterPress, startingControls, type AutoControls, type ScreenFacts } from './controls';
import { coarsePointer } from './uiMode';

/**
 * Follows the pointers of the page for Automatic (the setting "Controls",
 * see `controls.ts` for the rule) and puts what it shows in the store
 * (`autoInput`). A change from one version to the other waits until it
 * cannot surprise: no finger is down, no pointer was pressed or let go in
 * the last {@link SETTLE_MS} (so the press that caused it ends where it
 * began), no dialog or sheet is open and no text field has the focus (the
 * on-screen keyboard may be up). Until then it looks again every
 * {@link SETTLE_MS}. Only the "Now:" sentence's reason changes at once.
 */

/** How long after the last press or release a change waits, in milliseconds. */
export const SETTLE_MS = 400;

let state: AutoControls | null = null;
/** Whether a pointer was pressed since the start, after which the start is not decided again. */
let pressed = false;
const fingersDown = new Set<number>();
let lastPointerAt = 0;
let lastPointerType = '';
let timer: number | null = null;

/** What the screen and the system say now. `platform` is the desktop shell's, null in a browser. */
export function screenFacts(platform: string | null): ScreenFacts {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const linux =
    platform === null
      ? /\bLinux\b/.test(agent) && !/\bAndroid\b/.test(agent)
      : platform === 'linux';
  let width = 0;
  let height = 0;
  let touchPoints = 0;
  try {
    width = window.screen.width;
    height = window.screen.height;
    touchPoints = navigator.maxTouchPoints;
  } catch {
    // Unknown: not a Steam Deck's screen, then.
  }
  return { coarse: coarsePointer(), linux, width, height, touchPoints };
}

/**
 * Decides what Automatic shows at the start, from what the screen and the
 * system say. Called again when the shell says which system it runs on,
 * until the first press of a pointer.
 */
export function startControls(facts: ScreenFacts): void {
  if (pressed) return;
  state = startingControls(facts, performance.now());
  useAtlas.setState({ autoInput: { input: state.input, reason: state.reason } });
}

/** Whether a dialog or a sheet over the page is open. */
function dialogOpen(): boolean {
  return document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]') !== null;
}

/** Whether the version can change now, as above. */
function settled(): boolean {
  return (
    fingersDown.size === 0 &&
    performance.now() - lastPointerAt >= SETTLE_MS &&
    !dialogOpen() &&
    !isTypingTarget(document.activeElement)
  );
}

/** Puts what Automatic decided in the store, now or once the page is settled. */
function apply(): void {
  if (!state) return;
  const shown = useAtlas.getState().autoInput;
  if (shown.input === state.input && shown.reason === state.reason) return;
  if (shown.input === state.input || settled()) {
    useAtlas.setState({ autoInput: { input: state.input, reason: state.reason } });
    return;
  }
  timer ??= window.setTimeout(() => {
    timer = null;
    apply();
  }, SETTLE_MS);
}

const onPointerDown = (event: PointerEvent) => {
  pressed = true;
  lastPointerAt = performance.now();
  lastPointerType = event.pointerType;
  if (event.pointerType === 'touch') fingersDown.add(event.pointerId);
  if (state) state = afterPress(state, event.pointerType, lastPointerAt);
  apply();
};

const onPointerUp = (event: PointerEvent) => {
  lastPointerAt = performance.now();
  fingersDown.delete(event.pointerId);
  apply();
};

/**
 * A finger held on the page of the version for fingers on a computer opens
 * no menu of the web view (as a right click would): a press and hold is
 * the layout's own, as on the map. Text fields keep theirs.
 */
const onContextMenu = (event: MouseEvent) => {
  if (lastPointerType !== 'touch' || !document.querySelector('.touch[data-handheld]')) return;
  if (isTypingTarget(event.target)) return;
  event.preventDefault();
};

/** Starts following the page's pointers; returns what stops it. */
export function followControls(): () => void {
  const options = { capture: true, passive: true } as const;
  window.addEventListener('pointerdown', onPointerDown, options);
  window.addEventListener('pointerup', onPointerUp, options);
  window.addEventListener('pointercancel', onPointerUp, options);
  window.addEventListener('contextmenu', onContextMenu, { capture: true });
  return () => {
    window.removeEventListener('pointerdown', onPointerDown, options);
    window.removeEventListener('pointerup', onPointerUp, options);
    window.removeEventListener('pointercancel', onPointerUp, options);
    window.removeEventListener('contextmenu', onContextMenu, { capture: true });
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
}
