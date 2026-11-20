/**
 * The keys of the standard layout on a computer, as its list of keys shows
 * them. They are the classic layout's keys (`keyboard.ts`), with Esc
 * closing what is on top and `?` showing this list, and the arrow keys and
 * Enter of `controller.ts`.
 */

export interface KeyHelp {
  /** The keys, each as printed on the keyboard. */
  keys: string[];
  what: string;
}

/** The list of keys; `lists` is what the game calls its checklists and guides, or null without them. */
export function keyList(lists: string | null): KeyHelp[] {
  return [
    { keys: ['/'], what: 'Search' },
    {
      keys: ['N'],
      what: lists
        ? 'Nearest location not yet found; in a list shown in order, the next step'
        : 'Nearest location not yet found',
    },
    {
      keys: ['F'],
      what: lists
        ? 'Mark the selected location found, or not found; in a list shown in order, the next step done'
        : 'Mark the selected location found, or not found',
    },
    { keys: ['Z'], what: 'Undo' },
    ...(lists ? [{ keys: ['C'], what: `${lists}, or back to the map` }] : []),
    { keys: ['H'], what: 'In Guides, the home page' },
    { keys: ['B'], what: 'In Guides, hide or show the contents beside the page' },
    { keys: ['[', ']'], what: 'In a guide read in order, the previous or the next page' },
    {
      keys: ['\u2191', '\u2193', '\u2190', '\u2192'],
      what: 'Move to the nearest button or link that way; on the map, move the map',
    },
    { keys: ['Enter'], what: 'Press the button or link you moved to' },
    {
      keys: ['Esc'],
      what: 'Close what is on top: a menu, search, the location, a list. With nothing left to close, leave the map',
    },
    { keys: ['?'], what: 'This list of keys' },
  ];
}

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
