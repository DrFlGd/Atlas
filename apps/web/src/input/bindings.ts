/**
 * Every action a person can take with the keys or a controller, in one
 * table: its keys, its controller buttons, where it applies and how it is
 * worded. The handlers (`controller.ts`, `keyboard.ts`, the guides' own
 * keys), the hint bar at the foot of the screen (`HintBar.tsx`) and the
 * guide of keys and controller (`touch/KeysDialog.tsx`) all read it, so
 * they never say different things.
 */

/** Where an action applies, as the guide groups them. */
export type Context = 'map' | 'reading' | 'lists' | 'menus' | 'everywhere';

/**
 * What the controller is doing now (see `padContext`): moving the map, in
 * the card of a location, reading a guide, in a list, or moving between
 * buttons of a menu, a dialog or any other screen.
 */
export type PadContext = 'map' | 'card' | 'reading' | 'lists' | 'menus';

/**
 * A control of the controller, in the standard layout every web view
 * gives: the four face buttons, the bumpers and triggers, the two small
 * buttons in the middle (View on the left, Menu on the right), the sticks
 * and their presses, and the D-pad.
 */
export type PadButton =
  | 'a'
  | 'b'
  | 'x'
  | 'y'
  | 'lb'
  | 'rb'
  | 'lt'
  | 'rt'
  | 'view'
  | 'menu'
  | 'ls'
  | 'rs'
  | 'l3'
  | 'r3'
  | 'dpad';

export type ActionId =
  | 'pan'
  | 'pan-fine'
  | 'zoom'
  | 'jump'
  | 'open-location'
  | 'mark-found'
  | 'nearest'
  | 'filters'
  | 'reset-view'
  | 'level'
  | 'turn-page'
  | 'guides-home'
  | 'guides-bar'
  | 'next-step'
  | 'step-done'
  | 'move-focus'
  | 'press'
  | 'scroll'
  | 'scroll-page'
  | 'back'
  | 'sections'
  | 'keys-guide'
  | 'menu'
  | 'search'
  | 'undo'
  | 'lists';

/** What the wording of some actions depends on: the name of the game's lists, or null without them. */
export interface Words {
  lists: string | null;
}

export interface Binding {
  id: ActionId;
  /** Where it applies, and where the guide lists it. */
  context: Context;
  /** Other controller contexts it applies in too (the card of a location for "mark found"). */
  alsoIn?: readonly PadContext[];
  /**
   * The keys, as `KeyboardEvent.key` gives them (letters in lower case).
   * Two keys of a pair come in the order of the pad's pair: back, then on.
   */
  keys: readonly string[];
  /** The controller's buttons; a pair is back or out first, then on or in. */
  pad: readonly PadButton[];
  /** The buttons the hint bar shows, where fewer than `pad`. */
  hintPad?: readonly PadButton[];
  /** What it does, as the guide says it. */
  what: string | ((words: Words) => string);
  /** Its name in the hint bar: one or two words. */
  hint?: string;
  /** Only where the game has lists. */
  needsLists?: boolean;
}

export const BINDINGS: readonly Binding[] = [
  // The map, while it has the controller.
  {
    id: 'pan',
    context: 'map',
    keys: ['w', 'a', 's', 'd'],
    pad: ['ls'],
    what: 'Move the map (the arrow keys too, while the map has the focus)',
    hint: 'Move',
  },
  {
    id: 'pan-fine',
    context: 'map',
    keys: [],
    pad: ['rs'],
    what: 'Move the map at a third of the speed, for finer aim at a location',
    hint: 'Fine move',
  },
  {
    id: 'zoom',
    context: 'map',
    keys: ['-', '+'],
    pad: ['lt', 'rt'],
    what: 'Zoom out or in, at the crosshair',
    hint: 'Zoom',
  },
  {
    id: 'jump',
    context: 'map',
    keys: [],
    pad: ['dpad'],
    what: 'Go to the next location that way',
    hint: 'Next location',
  },
  {
    id: 'open-location',
    context: 'map',
    keys: ['Enter'],
    pad: ['a'],
    what: 'Open the location under the crosshair. Again: move into its card',
    hint: 'Open',
  },
  {
    id: 'mark-found',
    context: 'map',
    alsoIn: ['card'],
    keys: ['f'],
    pad: ['x'],
    what: 'Mark the location under the crosshair, or the one open, found or not found',
    hint: 'Found',
  },
  {
    id: 'nearest',
    context: 'map',
    keys: ['n'],
    pad: [],
    what: 'Nearest location not yet found',
  },
  {
    id: 'filters',
    context: 'map',
    keys: [],
    pad: ['y'],
    what: 'Types and filters. B goes back to the map',
    hint: 'Filters',
  },
  {
    id: 'reset-view',
    context: 'map',
    keys: ['0'],
    pad: ['r3'],
    what: 'Show the whole map',
    hint: 'Whole map',
  },
  {
    id: 'level',
    context: 'map',
    keys: ['l'],
    pad: ['l3'],
    what: 'The next level of the map, where it has levels',
    hint: 'Level',
  },
  // Guides and guidebooks.
  {
    id: 'turn-page',
    context: 'reading',
    keys: ['[', ']'],
    pad: ['lt', 'rt'],
    what: 'In a guide read in order or a guidebook, the previous or the next page (in a guidebook, Page Up and Page Down too)',
    hint: 'Page',
  },
  { id: 'guides-home', context: 'reading', keys: ['h'], pad: [], what: 'In Guides, the home page' },
  {
    id: 'guides-bar',
    context: 'reading',
    keys: ['b'],
    pad: [],
    what: 'In Guides, hide or show the contents beside the page',
  },
  // Lists.
  {
    id: 'next-step',
    context: 'lists',
    keys: ['n'],
    pad: [],
    what: 'In a list shown in order, the next step',
    needsLists: true,
  },
  {
    id: 'step-done',
    context: 'lists',
    keys: ['f'],
    pad: ['x'],
    what: 'In a list shown in order, the next step done',
    hint: 'Step done',
    needsLists: true,
  },
  // Menus, dialogs and any screen of buttons.
  {
    id: 'move-focus',
    context: 'menus',
    keys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
    pad: ['dpad', 'ls'],
    hintPad: ['dpad'],
    what: 'Move to the nearest button or link that way',
    hint: 'Move',
  },
  {
    id: 'press',
    context: 'menus',
    keys: ['Enter'],
    pad: ['a'],
    what: 'Press the button or link you moved to',
    hint: 'Press',
  },
  {
    id: 'scroll',
    context: 'menus',
    keys: [],
    pad: ['rs'],
    what: 'Scroll the page or the list',
    hint: 'Scroll',
  },
  {
    id: 'scroll-page',
    context: 'menus',
    keys: ['PageUp', 'PageDown'],
    pad: ['lt', 'rt'],
    what: 'Scroll up or down by a page',
    hint: 'Page',
  },
  // Everywhere.
  {
    id: 'back',
    context: 'everywhere',
    keys: ['Escape'],
    pad: ['b'],
    what: 'Close what is on top: a menu, search, the location, a list. With nothing left to close, leave the map, or go back to it',
    hint: 'Back',
  },
  {
    id: 'sections',
    context: 'everywhere',
    keys: ['q', 'e'],
    pad: ['lb', 'rb'],
    what: 'The section before or after: Map, Guides, Lists and the others, in their order',
    hint: 'Sections',
  },
  { id: 'search', context: 'everywhere', keys: ['/'], pad: [], what: 'Search' },
  { id: 'undo', context: 'everywhere', keys: ['z'], pad: [], what: 'Undo' },
  {
    id: 'lists',
    context: 'everywhere',
    keys: ['c'],
    pad: [],
    what: (words) => `${words.lists ?? 'Lists'}, or back to the map`,
    needsLists: true,
  },
  {
    id: 'menu',
    context: 'everywhere',
    keys: [],
    pad: ['menu'],
    what: 'Settings, or back from them',
    hint: 'Settings',
  },
  {
    id: 'keys-guide',
    context: 'everywhere',
    keys: ['?'],
    pad: ['view'],
    what: 'This guide of keys and controller',
    hint: 'All controls',
  },
];

const BY_ID = new Map(BINDINGS.map((binding) => [binding.id, binding]));

/** The binding of an action. */
export function binding(id: ActionId): Binding {
  return BY_ID.get(id)!;
}

/** The keys of an action, as `KeyboardEvent.key` gives them. */
export function keysOf(id: ActionId): readonly string[] {
  return binding(id).keys;
}

/** What an action does, as the guide says it. */
export function wordsOf(item: Binding, words: Words): string {
  return typeof item.what === 'function' ? item.what(words) : item.what;
}

/** The order the guide shows the contexts in, with their headings. */
export const CONTEXTS: readonly { id: Context; title: string }[] = [
  { id: 'map', title: 'Map' },
  { id: 'reading', title: 'Guides and guidebooks' },
  { id: 'lists', title: 'Lists' },
  { id: 'menus', title: 'Menus, dialogs and other screens' },
  { id: 'everywhere', title: 'Everywhere' },
];

/** The actions the guide lists under a context, for a game with or without lists. */
export function guideRows(context: Context, words: Words): Binding[] {
  return BINDINGS.filter(
    (item) => item.context === context && (!item.needsLists || words.lists !== null),
  );
}

/** Where the controller looks for a button's action, most particular first. */
const LOOKUP: Readonly<Record<PadContext, readonly Context[]>> = {
  map: ['map', 'everywhere'],
  card: ['menus', 'everywhere'],
  reading: ['reading', 'menus', 'everywhere'],
  lists: ['lists', 'menus', 'everywhere'],
  menus: ['menus', 'everywhere'],
};

/** The action a controller button does in a context, or null when it does nothing there. */
export function padAction(context: PadContext, button: PadButton): ActionId | null {
  const own = BINDINGS.find((item) => item.alsoIn?.includes(context) && item.pad.includes(button));
  if (own) return own.id;
  for (const where of LOOKUP[context]) {
    const found = BINDINGS.find((item) => item.context === where && item.pad.includes(button));
    if (found) return found.id;
  }
  return null;
}

/**
 * The action a key does in a context, or null. Only the keys of the
 * controller's contexts: the guides' own keys stay with their screens.
 */
export function keyAction(context: PadContext, key: string): ActionId | null {
  const name = keyName(key);
  const own = BINDINGS.find((item) => item.alsoIn?.includes(context) && item.keys.includes(name));
  if (own) return own.id;
  for (const where of LOOKUP[context]) {
    const found = BINDINGS.find((item) => item.context === where && item.keys.includes(name));
    if (found) return found.id;
  }
  return null;
}

/** What the hint bar shows in each context, most needed first. */
export const HINTS: Readonly<Record<PadContext, readonly ActionId[]>> = {
  map: ['pan', 'zoom', 'open-location', 'mark-found', 'filters', 'sections'],
  card: ['move-focus', 'press', 'mark-found', 'back', 'sections'],
  reading: ['move-focus', 'scroll', 'turn-page', 'press', 'back', 'sections'],
  lists: ['move-focus', 'scroll', 'press', 'back', 'sections', 'keys-guide'],
  menus: ['move-focus', 'press', 'back', 'scroll', 'keys-guide'],
};

/** One item of the hint bar: the buttons and their name. */
export interface Hint {
  id: ActionId;
  pad: readonly PadButton[];
  label: string;
}

/** The hint bar's items in a context, for a game with or without lists. */
export function hintsFor(context: PadContext, words: Words): Hint[] {
  return HINTS[context]
    .map((id) => binding(id))
    .filter((item) => !item.needsLists || words.lists !== null)
    .map((item) => ({ id: item.id, pad: item.hintPad ?? item.pad, label: item.hint ?? '' }));
}

/** How a key is printed on the keyboard, for the guide. */
export function keyLabel(key: string): string {
  switch (key) {
    case 'ArrowUp':
      return '↑';
    case 'ArrowDown':
      return '↓';
    case 'ArrowLeft':
      return '←';
    case 'ArrowRight':
      return '→';
    case 'Escape':
      return 'Esc';
    case 'PageUp':
      return 'Page Up';
    case 'PageDown':
      return 'Page Down';
    case 'Enter':
      return 'Enter';
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

/**
 * A key as the table names it: letters in lower case, and `=` as `+`,
 * which shares its key on most keyboards.
 */
export function keyName(key: string): string {
  if (key === '=') return '+';
  return key.length === 1 ? key.toLowerCase() : key;
}

/** Whether a key event's key is one of an action's keys. */
export function isKeyOf(id: ActionId, key: string): boolean {
  return keysOf(id).includes(keyName(key));
}
