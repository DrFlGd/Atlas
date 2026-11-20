/**
 * Moving around Atlas with the keys alone or with a game controller, as on
 * a Steam Deck in Game Mode, where Atlas gets either a gamepad or keys and
 * a mouse (from a controller layout that sends keys). A mouse and touch
 * work as they always did: nothing here acts on a pointer.
 *
 * Keys:
 *
 * - The arrow keys move the focus to the nearest control in that
 *   direction (see {@link chooseTarget}). They are left alone while the
 *   person types in a text field, on a radio button, a slider or a list of
 *   choices, in the map (where they move the map), on a part of the page
 *   that scrolls by itself and in widgets that use the arrow keys
 *   themselves (those stop the key). With nothing focused after a press of
 *   the mouse or a finger, they scroll as before; otherwise the first
 *   arrow key focuses the section shown, or the first control. When the
 *   nearest control in that direction is out of view and the part of the
 *   page that holds the focus can scroll that way, the page scrolls a step
 *   first, so a long guide can be read with them.
 * - Enter presses the focused control, also one that only a click opens
 *   (a check box, or an element that acts as a button).
 * - Esc goes back, as before (the Back button of Android): it closes what is
 *   on top. With nothing left to close while the map has the focus, the
 *   focus leaves the map (see {@link leaveMap}).
 * - Page Up, Page Down, `[` and `]` turn pages where they did already.
 * - While the focus is moved with keys or a controller, it has a wide ring
 *   (`data-moving` on the root, see `app.css`); a press of the mouse or a
 *   finger takes it off.
 *
 * A gamepad, where the web view offers the Gamepad API (it is detected,
 * never assumed; WebKitGTK may not offer it): the D-pad or the left stick
 * moves the focus as the arrow keys do, from anywhere; A presses; B goes
 * back as Esc does; the shoulder buttons turn the pages of a guidebook or
 * a guide read in order, or else switch to the section before or after;
 * while the map has the focus, the right stick moves it and the triggers
 * zoom out and in. The first time a run sees a gamepad, a notice says so,
 * so the person knows it reaches Atlas.
 */
import { isTypingTarget } from './keyboard';
import { moveMap, notify } from './state/actions';
import { useAtlas } from './state/store';

export type Direction = 'up' | 'down' | 'left' | 'right';

/** A box on the screen, as `getBoundingClientRect` gives it. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const ARROWS: Readonly<Record<string, Direction>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

const vertical = (direction: Direction) => direction === 'up' || direction === 'down';

/** Whether `to` lies in `direction` from `from` (as Android's focus finder decides). */
function ahead(from: Box, to: Box, direction: Direction): boolean {
  switch (direction) {
    case 'down':
      return (from.top < to.top || from.bottom <= to.top) && from.bottom < to.bottom;
    case 'up':
      return (from.bottom > to.bottom || from.top >= to.bottom) && from.top > to.top;
    case 'right':
      return (from.left < to.left || from.right <= to.left) && from.right < to.right;
    case 'left':
      return (from.right > to.right || from.left >= to.right) && from.left > to.left;
  }
}

/** Whether `to` overlaps `from` across the direction: it is in the beam of `from`. */
function inBeam(from: Box, to: Box, direction: Direction): boolean {
  return vertical(direction)
    ? to.right > from.left && to.left < from.right
    : to.bottom > from.top && to.top < from.bottom;
}

/** The gap from `from`'s edge to `to`'s near edge, in the direction (0 when they overlap). */
function nearGap(from: Box, to: Box, direction: Direction): number {
  switch (direction) {
    case 'down':
      return Math.max(0, to.top - from.bottom);
    case 'up':
      return Math.max(0, from.top - to.bottom);
    case 'right':
      return Math.max(0, to.left - from.right);
    case 'left':
      return Math.max(0, from.left - to.right);
  }
}

/** The gap from `from`'s edge to `to`'s far edge, in the direction. */
function farGap(from: Box, to: Box, direction: Direction): number {
  switch (direction) {
    case 'down':
      return Math.max(1, to.bottom - from.bottom);
    case 'up':
      return Math.max(1, from.top - to.top);
    case 'right':
      return Math.max(1, to.right - from.right);
    case 'left':
      return Math.max(1, from.left - to.left);
  }
}

/** How far the middles of the two boxes are apart across the direction. */
function across(from: Box, to: Box, direction: Direction): number {
  return vertical(direction)
    ? Math.abs((to.left + to.right) / 2 - (from.left + from.right) / 2)
    : Math.abs((to.top + to.bottom) / 2 - (from.top + from.bottom) / 2);
}

/** Near the direction counts much more than across it (Android's weights). */
function weighted(from: Box, to: Box, direction: Direction): number {
  const near = nearGap(from, to, direction);
  const side = across(from, to, direction);
  return 13 * near * near + side * side;
}

/** Whether `a` beats `b` because it is in the beam and `b` is not (Android's rule). */
function beamBeats(from: Box, a: Box, b: Box, direction: Direction): boolean {
  if (!inBeam(from, a, direction) || inBeam(from, b, direction)) return false;
  // Sideways, one in the beam always wins; up and down, unless the other
  // ends before it even starts.
  if (!vertical(direction)) return true;
  return nearGap(from, a, direction) < farGap(from, b, direction);
}

/**
 * The control to move to from the box `from` in `direction`, as the index
 * of its box in `candidates`, or -1 when none lies that way. The nearest in
 * that direction wins, one in line with `from` before one beside it; on a
 * tie, the first in the list (the page's order).
 */
export function chooseTarget(from: Box, direction: Direction, candidates: readonly Box[]): number {
  let best = -1;
  for (let index = 0; index < candidates.length; index += 1) {
    const box = candidates[index]!;
    if (box.right - box.left <= 0 || box.bottom - box.top <= 0) continue;
    if (!ahead(from, box, direction)) continue;
    if (best === -1) {
      best = index;
      continue;
    }
    const current = candidates[best]!;
    if (beamBeats(from, box, current, direction)) {
      best = index;
    } else if (beamBeats(from, current, box, direction)) {
      continue;
    } else if (weighted(from, box, direction) < weighted(from, current, direction)) {
      best = index;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The page

/** Everything a person can move the focus to. */
const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  'iframe',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',');

/** The map, whose arrow keys move it (Leaflet's). */
const MAP = '.leaflet-container';

/** Elements that use the arrow keys themselves without stopping them. */
function ownsArrows(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement) {
    return element.type === 'radio' || element.type === 'range';
  }
  if (element instanceof HTMLMediaElement) return element.controls;
  const role = element.getAttribute('role');
  return role === 'slider' || role === 'spinbutton';
}

/** Whether the element can be seen and focused now. */
function usable(element: HTMLElement): boolean {
  if (element.tabIndex < 0 && !element.matches('[contenteditable], summary, iframe')) return false;
  if (element.closest('[inert], [hidden]')) return false;
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return false;
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({ visibilityProperty: true });
  }
  return getComputedStyle(element).visibility !== 'hidden';
}

/** Where focus may move: the dialog on top while one is open, else the page. */
function scope(): ParentNode {
  const dialogs = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')];
  const modal = dialogs.filter((dialog) => {
    try {
      return dialog.matches(':modal');
    } catch {
      return true;
    }
  });
  return modal.at(-1) ?? document;
}

/** The controls focus may move to now, in the page's order. */
function candidates(within: ParentNode): HTMLElement[] {
  return [...within.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(usable);
}

/** The element that has the focus, or null when nothing has. */
function focused(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  if (active === document.body || active === document.documentElement) return null;
  return active;
}

/** The scroll room of an element in a direction: whether it can scroll that way. */
function canScroll(element: Element, direction: Direction): boolean {
  const style = getComputedStyle(element);
  const overflow = vertical(direction) ? style.overflowY : style.overflowX;
  const root = element === document.scrollingElement;
  if (!root && overflow !== 'auto' && overflow !== 'scroll') return false;
  switch (direction) {
    case 'down':
      return element.scrollTop + element.clientHeight < element.scrollHeight - 1;
    case 'up':
      return element.scrollTop > 0;
    case 'right':
      return element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    case 'left':
      return element.scrollLeft > 0;
  }
}

/** The nearest element around `element` (itself not counted) that can scroll in the direction. */
function scrollerAround(element: Element, direction: Direction): Element | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (canScroll(parent, direction)) return parent;
  }
  const root = document.scrollingElement;
  return root && canScroll(root, direction) ? root : null;
}

/** Whether most of the box can be seen inside the window and the scroll areas around it. */
function inView(element: HTMLElement): boolean {
  const box = element.getBoundingClientRect();
  let view: Box = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const clip = parent.getBoundingClientRect();
    view = {
      left: Math.max(view.left, clip.left),
      top: Math.max(view.top, clip.top),
      right: Math.min(view.right, clip.right),
      bottom: Math.min(view.bottom, clip.bottom),
    };
  }
  const width = Math.min(box.right, view.right) - Math.max(box.left, view.left);
  const height = Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top);
  if (width <= 0 || height <= 0) return false;
  return width * height >= 0.5 * Math.min(box.width * box.height, 1e9);
}

/** Shows that the focus is being moved with keys or a controller. */
function markMoving(): void {
  document.documentElement.dataset.moving = '';
}

/** Gives an element the focus, scrolling only as much as it takes to show it. */
function focusOn(element: HTMLElement): void {
  markMoving();
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Where moving starts when nothing has the focus: the section shown, or the first control. */
function start(): boolean {
  const within = scope();
  const all = candidates(within);
  const section = all.find((element) => element.getAttribute('aria-current') === 'page');
  const first = section ?? all[0];
  if (!first) return false;
  focusOn(first);
  return true;
}

/** How far one step scrolls: most of the scroll area, keeping a line of what was seen. */
function scrollStep(scroller: Element, direction: Direction): void {
  const root = scroller === document.scrollingElement;
  const height = root ? window.innerHeight : scroller.clientHeight;
  const width = root ? window.innerWidth : scroller.clientWidth;
  const by = vertical(direction) ? Math.max(40, height * 0.4) : Math.max(40, width * 0.4);
  const sign = direction === 'down' || direction === 'right' ? 1 : -1;
  markMoving();
  scroller.scrollBy(vertical(direction) ? { top: sign * by } : { left: sign * by });
}

/**
 * Moves the focus one step in a direction, or scrolls (see the module).
 * Whether anything happened.
 */
export function moveFocus(direction: Direction): boolean {
  const active = focused();
  if (!active) return start();
  const within = scope();
  if (within !== document && !(within as Element).contains(active)) return start();
  const all = candidates(within).filter(
    (element) => element !== active && !element.contains(active),
  );
  const from = active.getBoundingClientRect();
  const index = chooseTarget(
    from,
    direction,
    all.map((element) => element.getBoundingClientRect()),
  );
  const target = index >= 0 ? all[index]! : null;
  if (target && inView(target)) {
    focusOn(target);
    return true;
  }
  const scroller = scrollerAround(active, direction);
  if (scroller) {
    scrollStep(scroller, direction);
    return true;
  }
  if (target) {
    focusOn(target);
    return true;
  }
  return false;
}

/** Roles of elements that act on a click alone, which Enter does not press by itself. */
const PRESSED_BY_CLICK = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'checkbox',
  'radio',
  'switch',
  'treeitem',
]);

/** Whether Enter needs help to press this element (the browser does it for buttons and links). */
function needsPress(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement) {
    return element.type === 'checkbox' || element.type === 'radio';
  }
  if (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLAnchorElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement ||
    element.tagName === 'SUMMARY' ||
    element.isContentEditable
  ) {
    return false;
  }
  return PRESSED_BY_CLICK.has(element.getAttribute('role') ?? '');
}

/**
 * When nothing is left to close and the map has the focus, moves the focus
 * out of it, to the section shown or the first control. Whether it did.
 */
export function leaveMap(): boolean {
  const active = focused();
  if (!active?.closest(MAP)) return false;
  const all = candidates(scope()).filter((element) => !element.closest(MAP));
  const next = all.find((element) => element.getAttribute('aria-current') === 'page') ?? all[0];
  if (!next) return false;
  focusOn(next);
  return true;
}

// ---------------------------------------------------------------------------
// Keys

/** The last thing the person used: a pointer (mouse, finger, pen) or keys and controllers. */
let lastInput: 'pointer' | 'keys' = 'keys';

function onPointerDown(): void {
  lastInput = 'pointer';
  delete document.documentElement.dataset.moving;
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'Tab') {
    lastInput = 'keys';
    markMoving();
    return;
  }
  const active = focused();
  if (event.key === 'Enter') {
    if (!active || !needsPress(active) || active.closest(MAP)) return;
    event.preventDefault();
    lastInput = 'keys';
    markMoving();
    active.click();
    return;
  }
  const direction = ARROWS[event.key];
  if (!direction || event.shiftKey) return;
  if (active) {
    if (isTypingTarget(active) || ownsArrows(active) || active.closest(MAP)) return;
    // A part of the page that scrolls and has the focus itself scrolls.
    if (canScroll(active, direction)) return;
  } else if (lastInput === 'pointer') {
    // After a press of the mouse or a finger, the keys scroll as they did.
    return;
  }
  lastInput = 'keys';
  if (moveFocus(direction)) event.preventDefault();
}

// ---------------------------------------------------------------------------
// A gamepad

/** The buttons of the standard gamepad layout. */
const PAD = {
  a: 0,
  b: 1,
  left: 4,
  right: 5,
  leftTrigger: 6,
  rightTrigger: 7,
  up: 12,
  down: 13,
  dpadLeft: 14,
  dpadRight: 15,
} as const;

/** How far a stick has to lean, out of 1, to count. */
const STICK = 0.5;
/** Below this a stick counts as at rest. */
const DEAD = 0.2;
/** A held direction moves again after this, then every `REPEAT_MS`. */
const FIRST_REPEAT_MS = 380;
const REPEAT_MS = 120;
/** How fast the right stick moves the map, in screen pixels a second when fully leaned. */
const PAN_PX_PER_S = 900;
/** How fast a trigger pressed fully zooms, in zoom levels a second. */
const ZOOM_PER_S = 2;

/** The direction the D-pad or the left stick holds, if any. */
export function padDirection(
  axes: readonly number[],
  pressed: (button: number) => boolean,
): Direction | null {
  if (pressed(PAD.up)) return 'up';
  if (pressed(PAD.down)) return 'down';
  if (pressed(PAD.dpadLeft)) return 'left';
  if (pressed(PAD.dpadRight)) return 'right';
  const x = axes[0] ?? 0;
  const y = axes[1] ?? 0;
  if (Math.max(Math.abs(x), Math.abs(y)) < STICK) return null;
  if (Math.abs(x) > Math.abs(y)) return x > 0 ? 'right' : 'left';
  return y > 0 ? 'down' : 'up';
}

/**
 * Whether a held direction moves now: at once when it starts, then after
 * a wait, then often. `since` is when it started; `last` when it last moved.
 */
export function repeatDue(now: number, since: number, last: number): boolean {
  if (last < since) return true;
  if (now - since < FIRST_REPEAT_MS) return false;
  return now - last >= REPEAT_MS;
}

/** Presses the focused control, as the A button does. */
function press(): void {
  const active = focused();
  if (!active) {
    start();
    return;
  }
  markMoving();
  // The map itself and a text field: nothing to press.
  if (active.matches(MAP) || isTypingTarget(active)) return;
  active.click();
}

/** Goes back, as the B button does: as Esc, or Android's Back. */
function back(): void {
  markMoving();
  if (window.atlasBack) {
    if (!window.atlasBack()) leaveMap();
    return;
  }
  // The classic layout: a dialog closes, as Esc closes it; else Esc's own keys.
  const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1);
  if (dialog) {
    const cancel = new Event('cancel', { cancelable: true });
    if (dialog.dispatchEvent(cancel)) dialog.close();
    return;
  }
  const target = focused() ?? document.body;
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  if (target.dispatchEvent(escape)) leaveMap();
}

/** Sends a key to the page, as if pressed: for the keys that turn pages. */
function sendKey(key: string, target: Element): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

/**
 * A shoulder button: the page before or after in a guidebook or a guide
 * read in order, else the section before or after.
 */
function shoulder(by: -1 | 1): void {
  markMoving();
  const reader = document.querySelector('dialog[open][data-testid="guidebook-reader"]');
  if (reader) {
    const active = focused();
    sendKey(by < 0 ? 'PageUp' : 'PageDown', active && reader.contains(active) ? active : reader);
    return;
  }
  if (document.querySelector('dialog[open]')) return;
  if (document.querySelector('[data-testid="guides-sequence"]')) {
    sendKey(by < 0 ? '[' : ']', document.body);
    return;
  }
  const sections = [
    ...document.querySelectorAll<HTMLElement>(
      ':is(.touch-rail, .touch-bar) [data-testid^="section-"]',
    ),
  ].filter(usable);
  const at = sections.findIndex((element) => element.getAttribute('aria-current') === 'page');
  if (at < 0) return;
  const next = sections[at + by];
  if (!next) return;
  next.click();
  // The focus follows when it was on the sections.
  if (focused()?.closest('.touch-rail, .touch-bar')) next.focus({ preventScroll: true });
}

/** The map's move under way with the right stick: where it is going. */
interface MapMove {
  x: number;
  y: number;
  zoom: number;
  /** Image pixels per screen pixel at `zoom`. */
  scale: number;
}

let mapMove: MapMove | null = null;

/** Moves and zooms the map with the right stick and the triggers, while it has the focus. */
function moveTheMap(pad: Gamepad, seconds: number): void {
  const map = focused()?.closest<HTMLElement>(MAP);
  const x = Math.abs(pad.axes[2] ?? 0) > DEAD ? pad.axes[2]! : 0;
  const y = Math.abs(pad.axes[3] ?? 0) > DEAD ? pad.axes[3]! : 0;
  const zoomIn = pad.buttons[PAD.rightTrigger]?.value ?? 0;
  const zoomOut = pad.buttons[PAD.leftTrigger]?.value ?? 0;
  const zoomBy = (zoomIn > DEAD ? zoomIn : 0) - (zoomOut > DEAD ? zoomOut : 0);
  const view = useAtlas.getState().view;
  if (!map || !view || (x === 0 && y === 0 && zoomBy === 0)) {
    mapMove = null;
    return;
  }
  if (!mapMove) {
    const width = Math.max(1, map.getBoundingClientRect().width);
    mapMove = {
      x: view.center.x,
      y: view.center.y,
      zoom: view.zoom,
      scale: (view.bounds.maxX - view.bounds.minX) / width,
    };
  }
  const step = Math.min(seconds, 0.1);
  mapMove.x += x * PAN_PX_PER_S * step * mapMove.scale;
  mapMove.y += y * PAN_PX_PER_S * step * mapMove.scale;
  if (zoomBy !== 0) {
    const dz = zoomBy * ZOOM_PER_S * step;
    mapMove.zoom += dz;
    mapMove.scale /= 2 ** dz;
  }
  markMoving();
  moveMap(mapMove.x, mapMove.y, { zoom: mapMove.zoom, animate: false });
}

/** What was held at the last look, per gamepad. */
interface Held {
  direction: Direction | null;
  since: number;
  last: number;
  pressed: Set<number>;
}

const held = new Map<number, Held>();
let polling = 0;
let lastFrame = 0;

/** The Gamepad API, where the web view offers it (WebKitGTK may not). */
function gamepadApi(): (() => (Gamepad | null)[]) | null {
  const api = (navigator as { getGamepads?: unknown }).getGamepads;
  return typeof api === 'function' ? () => api.call(navigator) as (Gamepad | null)[] : null;
}

/** The gamepads connected now, or none where the web view does not offer them. */
function gamepads(): Gamepad[] {
  try {
    return (gamepadApi()?.() ?? []).filter((pad): pad is Gamepad => pad !== null);
  } catch {
    // Refused, as a page without the right to read gamepads is.
    return [];
  }
}

/** What the notice says when a controller is first seen in a run. */
export const CONNECTED_TEXT =
  'A controller is connected. The D-pad moves between buttons, A presses, B goes back, and the shoulder buttons switch sections or turn pages.';
let announced = false;

function poll(now: number): void {
  polling = 0;
  const pads = gamepads();
  if (pads.length === 0) {
    held.clear();
    mapMove = null;
    return;
  }
  // Once a run, so the person knows the controller reaches Atlas.
  if (!announced) {
    announced = true;
    notify(CONNECTED_TEXT);
  }
  const seconds = lastFrame ? (now - lastFrame) / 1000 : 0;
  lastFrame = now;
  for (const pad of pads) {
    const isPressed = (button: number) => pad.buttons[button]?.pressed ?? false;
    const before = held.get(pad.index) ?? {
      direction: null,
      since: now,
      last: -1,
      pressed: new Set<number>(),
    };
    const direction = padDirection(pad.axes, isPressed);
    const state: Held =
      direction === before.direction ? before : { ...before, direction, since: now, last: -1 };
    if (direction && repeatDue(now, state.since, state.last)) {
      state.last = now;
      lastInput = 'keys';
      moveFocus(direction);
    }
    const pressed = new Set<number>();
    for (const button of [PAD.a, PAD.b, PAD.left, PAD.right]) {
      if (!isPressed(button)) continue;
      pressed.add(button);
      if (before.pressed.has(button)) continue;
      lastInput = 'keys';
      if (button === PAD.a) press();
      else if (button === PAD.b) back();
      else shoulder(button === PAD.left ? -1 : 1);
    }
    state.pressed = pressed;
    held.set(pad.index, state);
    moveTheMap(pad, seconds);
  }
  polling = requestAnimationFrame(poll);
}

function startPolling(): void {
  if (polling) return;
  lastFrame = 0;
  polling = requestAnimationFrame(poll);
}

let installed = false;

/**
 * Turns on moving with the keys and a gamepad, once, for the whole app.
 * Returns a function that turns it off again (for tests).
 */
export function installController(): () => void {
  if (installed || typeof window === 'undefined') return () => undefined;
  installed = true;
  // Last on the way up: what a part of the app does with a key comes first.
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('pointerdown', onPointerDown, true);
  const gamepadOffered = gamepadApi() !== null;
  if (gamepadOffered) {
    window.addEventListener('gamepadconnected', startPolling);
    if (gamepads().length > 0) startPolling();
  }
  return () => {
    installed = false;
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('gamepadconnected', startPolling);
    if (polling) cancelAnimationFrame(polling);
    polling = 0;
    held.clear();
  };
}
