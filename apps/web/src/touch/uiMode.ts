/**
 * Which layout the app shows, and for which kind of pointer.
 *
 * - The standard layout (`src/touch/`): a rail of sections, one panel and
 *   the map. It is the default everywhere. In the Android app, and in a
 *   browser on a touch screen, it is made for fingers; elsewhere for a
 *   mouse and keyboard (names on hover, zoom buttons, right-click to mark).
 * - The classic layout (`App.tsx`'s `Shell`): panes on both sides of the
 *   map under a bar. The desktop app and a browser can switch back to it in
 *   the settings (stored like the theme); the Android app always shows the
 *   standard layout.
 *
 * The address can ask for one layout for previews and tests, and that is
 * then kept for the rest of the session (until the setting is changed):
 * `?ui=touch` (the standard layout made for fingers, as on Android),
 * `?ui=standard` (the standard layout as on a computer), `?ui=classic` (the
 * classic layout; `?ui=desktop`, its older name, still works).
 */

/** The layouts a person can choose between. */
export type Layout = 'standard' | 'classic';

/** What the address can ask for. */
export type UiRequest = 'touch' | 'standard' | 'classic';

/** What is shown: the layout, and for the standard one, the kind of pointer it is made for. */
export type ShownUi =
  { layout: 'standard'; input: 'touch' | 'mouse' } | { layout: 'classic'; input: 'mouse' };

const KEY = 'atlas-ui';

const REQUESTS: ReadonlyMap<string, UiRequest> = new Map([
  ['touch', 'touch'],
  ['standard', 'standard'],
  ['classic', 'classic'],
  ['desktop', 'classic'],
]);

/** A request by its name in the address, or null for anything else. */
const requestNamed = (value: string | null): UiRequest | null =>
  value === null ? null : (REQUESTS.get(value) ?? null);

/** What the address asks for, or null when it says nothing (or something unknown). */
export function uiFromSearch(search: string): UiRequest | null {
  return requestNamed(new URLSearchParams(search).get('ui'));
}

type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * The layout asked for: in the address now, or earlier in this session.
 * Remembers what the address asks for.
 */
export function requestedUi(search: string, storage: SessionStore | null): UiRequest | null {
  const asked = uiFromSearch(search);
  try {
    if (asked) {
      storage?.setItem(KEY, asked);
      return asked;
    }
    return requestNamed(storage?.getItem(KEY) ?? null);
  } catch {
    // Storage can be refused; the address still counts.
    return asked;
  }
}

/** Forgets what the address asked for in this session, once the person chooses in the settings. */
export function forgetRequestedUi(storage: SessionStore | null): void {
  try {
    storage?.removeItem(KEY);
  } catch {
    // Nothing was kept, then.
  }
}

/**
 * What to show. The Android app always shows the standard layout for
 * fingers; otherwise the address wins over the setting, and the standard
 * layout is made for fingers where the screen has no mouse (`coarse`).
 */
export function shownUi(options: {
  android: boolean;
  requested: UiRequest | null;
  saved: Layout;
  coarse: boolean;
}): ShownUi {
  const { android, requested, saved, coarse } = options;
  if (android || requested === 'touch') return { layout: 'standard', input: 'touch' };
  const layout = requested ?? saved;
  if (layout === 'classic') return { layout: 'classic', input: 'mouse' };
  return { layout: 'standard', input: coarse ? 'touch' : 'mouse' };
}

/** A saved setting as a layout: the standard one unless it says classic. */
export function parseLayout(value: unknown): Layout {
  return value === 'classic' ? 'classic' : 'standard';
}

/** Whether the screen is a touch screen without a mouse, such as a phone's or a tablet's. */
export function coarsePointer(): boolean {
  try {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** The session's storage, where the browser allows it. */
export function sessionStore(): SessionStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
