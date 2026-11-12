/**
 * The Android system bars. The Android app draws edge to edge, under the
 * status bar, the navigation bar and any display cutout, and pads its page
 * by their sizes (`--atlas-inset-*` in `app.css`). Those come from
 * `env(safe-area-inset-*)` where the WebView reports them, and from the
 * app's own activity (`apps/desktop/android/MainActivity.kt`), which
 * reads the window insets and hands them to the page, since WebView
 * versions differ in what they report. The page takes the larger of the
 * two. The activity also colours the bar icons to suit the app's theme.
 *
 * Outside the Android app there is no such activity and nothing changes.
 */

/** What the Android activity adds to the page as `window.AtlasAndroid`. */
export interface AndroidBarsBridge {
  /** The insets in CSS pixels, as "top,right,bottom,left". */
  insets(): string;
  /** Dark bar icons (for the light theme), or light ones. */
  darkIcons(dark: boolean): void;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The event the activity sends when the insets change, with the same text as `insets()`. */
export const INSETS_EVENT = 'atlas-insets';

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
/** Larger than any system bar: such a value is not one. */
const MAX_INSET = 400;

/** Reads "top,right,bottom,left" in CSS pixels; null when it is not that. */
export function parseInsets(text: unknown): Insets | null {
  if (typeof text !== 'string') return null;
  const values = text.split(',').map((part) => Number(part.trim()));
  if (values.length !== 4 || values.some((v) => !Number.isFinite(v) || v < 0 || v > MAX_INSET)) {
    return null;
  }
  const [top, right, bottom, left] = values as [number, number, number, number];
  return { top, right, bottom, left };
}

/** Sets `--atlas-android-inset-*` on the page, which `app.css` pads it by. */
export function applyInsets(root: HTMLElement, insets: Insets): void {
  for (const side of SIDES) {
    root.style.setProperty(`--atlas-android-inset-${side}`, `${insets[side]}px`);
  }
}

/**
 * Takes the insets from the Android activity, now and whenever they
 * change (rotation, a different navigation mode), and keeps the bar icons
 * readable on the app's theme. Does nothing without the activity's bridge.
 * Returns a function that stops it.
 */
export function installAndroidBars(win: Window = window): () => void {
  const bridge = (win as unknown as { AtlasAndroid?: AndroidBarsBridge }).AtlasAndroid;
  if (!bridge) return () => undefined;
  const root = win.document.documentElement;
  const take = (text: unknown) => {
    const insets = parseInsets(text);
    if (insets) applyInsets(root, insets);
  };
  try {
    take(bridge.insets());
  } catch (error) {
    console.error(error);
  }
  const onInsets = (event: Event) => {
    take((event as CustomEvent<unknown>).detail);
  };
  win.addEventListener(INSETS_EVENT, onInsets);

  const icons = () => {
    try {
      bridge.darkIcons(root.dataset.theme === 'light');
    } catch (error) {
      console.error(error);
    }
  };
  icons();
  const observer = new MutationObserver(icons);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    win.removeEventListener(INSETS_EVENT, onInsets);
    observer.disconnect();
  };
}

/** The Android activity's bridge, where the page runs in the Android app. */
function bridgeOf(win: Window): Partial<AndroidBridge> | null {
  return (win as unknown as { AtlasAndroid?: Partial<AndroidBridge> }).AtlasAndroid ?? null;
}

/** What the Android activity offers the page besides the system bars. */
export interface AndroidBridge extends AndroidBarsBridge {
  /** Keeps the screen on while the app is shown, or lets it turn off as usual. */
  keepScreenOn(on: boolean): void;
}

let wakeLock: { release(): Promise<void> } | null = null;
let wantAwake = false;
let watchingVisibility = false;

/**
 * Keeps the screen on while the app is shown, or stops doing so. The
 * Android app does it through its activity; a browser that has the screen
 * wake lock uses that, taking it again when the page is shown again.
 * Returns whether this device can do it at all.
 */
export function keepScreenOn(on: boolean, win: Window = window): boolean {
  const bridge = bridgeOf(win);
  if (bridge?.keepScreenOn) {
    try {
      bridge.keepScreenOn(on);
    } catch (error) {
      console.error(error);
    }
    return true;
  }
  const api = 'wakeLock' in win.navigator ? win.navigator.wakeLock : undefined;
  if (!api) return false;
  wantAwake = on;
  const take = () => {
    if (!wantAwake || wakeLock || win.document.visibilityState !== 'visible') return;
    api.request('screen').then(
      (lock) => {
        wakeLock = lock;
        if (!wantAwake) void release();
      },
      () => undefined,
    );
  };
  const release = async () => {
    const lock = wakeLock;
    wakeLock = null;
    await lock?.release().catch(() => undefined);
  };
  if (!watchingVisibility) {
    watchingVisibility = true;
    win.document.addEventListener('visibilitychange', () => {
      // The browser lets go of the lock when the page is hidden.
      wakeLock = null;
      take();
    });
  }
  if (on) take();
  else void release();
  return true;
}

/** Whether this device can keep the screen on for the app (see {@link keepScreenOn}). */
export function canKeepScreenOn(win: Window = window): boolean {
  return Boolean(bridgeOf(win)?.keepScreenOn) || 'wakeLock' in win.navigator;
}
