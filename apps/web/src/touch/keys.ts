/**
 * Helpers for the keys of the standard layout on a computer. What each key
 * and controller button does is one table, `input/bindings.ts`, which the
 * guide of keys and controller (`KeysDialog.tsx`) lists.
 */

/** Whether a key press is the person typing, or meant for a dialog that is open. */
export function typingOrDialog(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName))) {
    return true;
  }
  return document.querySelector('dialog[open], [role="dialog"]') !== null;
}

/** A button's tooltip with its key, where keys are shown: "Lists (C)". */
export function withKey(label: string, key: string, shown: boolean): string {
  return shown ? `${label} (${key})` : label;
}

/** What the mouse does on the map, listed with the keys. */
export const MOUSE_HELP: readonly { action: string; what: string }[] = [
  { action: 'Point at a location', what: 'Its name' },
  { action: 'Press a location', what: 'Show it' },
  { action: 'Right-click a location', what: 'Mark it found, or not found, at once' },
  { action: 'Scroll wheel', what: 'Zoom in and out' },
];
