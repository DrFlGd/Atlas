/**
 * Which layout a browser shows. The Android app always shows the touch
 * layout (see `touchUiOffered` in `features.ts`). A browser shows the
 * desktop layout unless the address asks for the touch one with
 * `?ui=touch`, which is then kept for the rest of the session, so a person
 * without a phone, and the tests, can see it. `?ui=desktop` goes back.
 */

export type UiChoice = 'touch' | 'desktop';

const KEY = 'atlas-ui';

/** What the address asks for, or null when it says nothing. */
export function uiFromSearch(search: string): UiChoice | null {
  const value = new URLSearchParams(search).get('ui');
  return value === 'touch' || value === 'desktop' ? value : null;
}

type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Whether the touch layout was asked for: in the address now, or earlier
 * in this session. Remembers what the address asks for.
 */
export function touchRequested(search: string, storage: SessionStore | null): boolean {
  const asked = uiFromSearch(search);
  try {
    if (asked === 'touch') storage?.setItem(KEY, 'touch');
    if (asked === 'desktop') storage?.removeItem(KEY);
    return asked === 'touch' || (asked === null && storage?.getItem(KEY) === 'touch');
  } catch {
    // Storage can be refused; the address still counts.
    return asked === 'touch';
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
