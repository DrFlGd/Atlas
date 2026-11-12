/**
 * The keys of the standard layout on a computer, as its list of keys shows
 * them. They are the classic layout's keys (`keyboard.ts`), with Esc
 * closing what is on top and `?` showing this list.
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
    { keys: ['N'], what: 'Nearest place not yet found' },
    { keys: ['F'], what: 'Mark the selected place found, or not found' },
    { keys: ['Z'], what: 'Undo' },
    ...(lists ? [{ keys: ['C'], what: `${lists}, or back to the map` }] : []),
    { keys: ['Esc'], what: 'Close what is on top: a menu, search, the place, a list' },
    { keys: ['?'], what: 'This list of keys' },
  ];
}

/** A button's tooltip with its key, where keys are shown: "Lists (C)". */
export function withKey(label: string, key: string, shown: boolean): string {
  return shown ? `${label} (${key})` : label;
}

/** What the mouse does on the map, listed with the keys. */
export const MOUSE_HELP: readonly { action: string; what: string }[] = [
  { action: 'Point at a place', what: 'Its name' },
  { action: 'Click a place', what: 'Show it' },
  { action: 'Right-click a place', what: 'Mark it found, or not found, at once' },
  { action: 'Scroll wheel', what: 'Zoom in and out' },
];
