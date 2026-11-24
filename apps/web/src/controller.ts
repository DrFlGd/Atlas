/**
 * Moving around Atlas with the keys alone or with a game controller, as on
 * a Steam Deck in Game Mode, where Atlas gets either a gamepad or keys and
 * a mouse (from a controller layout that sends keys). A mouse and touch
 * work as they always did: nothing here acts on a pointer. What each key
 * and button does, and in which context, is one table (`input/bindings.ts`),
 * which the hint bar and the guide of keys and controller read too.
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
 *   first, so a long guide can be read with them. Inside a dialog, a menu
 *   or a sheet over the screen, the focus stays in it.
 * - Enter presses the focused control, also one that only a click opens
 *   (a check box, or an element that acts as a button).
 * - Esc goes back, as before (the Back button of Android): it closes what is
 *   on top. With nothing left to close while the map has the focus, the
 *   focus leaves the map (see {@link leaveMap}).
 * - Page Up, Page Down, `[` and `]` turn pages where they did already.
 * - On the map, with nothing else focused: W, A, S and D move the map, `+`
 *   and `-` zoom, Enter opens the location under the crosshair, `0` shows
 *   the whole map and L the next level. Q and E switch to the section
 *   before or after, anywhere. Moving the map with its keys shows the
 *   crosshair, as a controller does.
 * - While the focus is moved with keys or a controller, it has a wide ring
 *   (`data-moving` on the root, see `app.css`); a press of the mouse or a
 *   finger takes it off.
 *
 * A gamepad, where the web view offers the Gamepad API (it is detected,
 * never assumed; WebKitGTK may not offer it). What it does depends on the
 * context (see `padContext`):
 *
 * - The map, while it is shown and nothing else has the focus: the left
 *   stick moves it (faster the further it leans), the right stick moves it
 *   slowly, the triggers zoom out and in at the crosshair in the middle,
 *   which holds the nearest location within a small distance. A opens that
 *   location (again: into its card), X marks it found, the D-pad goes to
 *   the next location that way, Y opens the types and filters, R3 shows
 *   the whole map and L3 the next level.
 * - Anywhere else: the D-pad or the left stick moves the focus, A presses,
 *   the right stick scrolls, and the triggers turn the pages of a
 *   guidebook or a guide read in order, or else scroll a page.
 * - Everywhere: B goes back as Esc does (and with nothing left to close,
 *   back to the map), the bumpers switch to the section before or after,
 *   Menu opens Settings and View the guide of keys and controller.
 *
 * The first time a run sees a gamepad, a notice says so and points at the
 * hint bar, so the person knows it reaches Atlas.
 */
import { isTypingTarget } from './keyboard';
import {
  keyAction,
  padAction,
  type ActionId,
  type PadButton,
  type PadContext,
} from './input/bindings';
import {
  jumpTarget,
  padContext,
  panStep,
  scrollStep as stickScroll,
  snapTarget,
  stickVector,
  triggerValue,
  TRIGGER_PRESS,
  zoomStep,
  type ContextFacts,
  type Point,
} from './input/padMath';
import {
  markersOnScreen,
  padMap,
  padScene,
  reticleShown,
  reticleTarget,
  usePad,
  type InputSource,
} from './input/padState';
import { notify, select, setPane, showMap, toggleFound } from './state/actions';
import { floorsOfMap, floorStep, pickFloor, requestSceneView } from './state/scene3d';
import { useAtlas } from './state/store';
import {
  clickedOnMap,
  pickedOnMap,
  useLocationEditor,
} from './touch/locations/locationEditorState';

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
const MAP = '.leaflet-container, .scene-view';

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

/** Menus and sheets over the screen that are not `<dialog>`s: search, the filters, the maps menu. */
const SHEET = '[role="dialog"]:not([aria-modal="false"]):not(dialog)';

/** The menu or sheet on top that is open over the screen, if any (not a `<dialog>`). */
function openSheet(): HTMLElement | null {
  const sheets = [...document.querySelectorAll<HTMLElement>(SHEET)].filter((sheet) => {
    const box = sheet.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
  return sheets.at(-1) ?? null;
}

/** Where focus may move: the dialog on top while one is open, a menu or sheet over the screen, else the page. */
function scope(): ParentNode {
  const dialogs = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')];
  const modal = dialogs.filter((dialog) => {
    try {
      return dialog.matches(':modal');
    } catch {
      return true;
    }
  });
  return modal.at(-1) ?? openSheet() ?? document;
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
 * With `moving`, the controller moves the map with nothing focused, which
 * counts as the map's focus.
 */
export function leaveMap(moving = false): boolean {
  const active = focused();
  if (!active?.closest(MAP) && !(moving && !active)) return false;
  const all = candidates(scope()).filter((element) => !element.closest(MAP));
  const next = all.find((element) => element.getAttribute('aria-current') === 'page') ?? all[0];
  if (!next) return false;
  focusOn(next);
  return true;
}

// ---------------------------------------------------------------------------
// What the layout does its own way

/** What a layout does for the controller in its own way (the standard layout sets it). */
export interface PadHost {
  /** Opens a location: its card. */
  open: (locationId: string) => void;
  /** Moves the focus into the card of the location open. */
  focusCard: () => void;
  /** Opens the types and filters and moves the focus into them. */
  filters: () => void;
  /** Settings, or back from them. */
  menu: () => void;
  /** Opens or closes the guide of keys and controller. */
  keysGuide: () => void;
}

/** The classic layout's: a location opens in the details pane; the filters pane opens. */
const CLASSIC_HOST: PadHost = {
  open: (locationId) => {
    select(locationId);
  },
  focusCard: () => {
    setPane('details', true);
    afterDraw(() => focusFirstIn('#details-pane'));
  },
  filters: () => {
    setPane('filters', true);
    afterDraw(() => focusFirstIn('#filters-pane'));
  },
  menu: () => undefined,
  keysGuide: () => undefined,
};

let host: PadHost = CLASSIC_HOST;

/** Lets a layout do some things its own way (see {@link PadHost}); null gives them back. */
export function setPadHost(next: PadHost | null): void {
  host = next ?? CLASSIC_HOST;
}

/**
 * Focuses the first control in an element (not a text field, where the
 * on-screen keyboard would rise), once it is drawn. Whether it was there.
 */
export function focusFirstIn(selector: string, prefer?: string): boolean {
  const root = document.querySelector(selector);
  if (!root) return false;
  const all = candidates(root).filter((element) => !isTypingTarget(element));
  const first = (prefer ? all.find((element) => element.matches(prefer)) : undefined) ?? all[0];
  if (!first) return false;
  focusOn(first);
  return true;
}

/** Runs once the page has drawn what was just changed. */
export function afterDraw(run: () => void): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(run);
  });
}

// ---------------------------------------------------------------------------
// The context

/** The map, the card of the location open, and the layout's root. */
const CARD = '.place-sheet';

/** What is on the screen and where the focus is. */
function contextFacts(): ContextFacts {
  const active = focused();
  const shell = document.querySelector<HTMLElement>('.touch');
  const map = document.querySelector<HTMLElement>(MAP);
  const box = map?.getBoundingClientRect();
  return {
    reader: document.querySelector('dialog[open][data-testid="guidebook-reader"]') !== null,
    overlay: document.querySelector('dialog[open]') !== null || openSheet() !== null,
    section: shell ? (shell.dataset.section ?? null) : null,
    mapShown: box !== undefined && box.width > 0 && box.height > 0,
    focus: !active ? 'none' : active.closest(MAP) ? 'map' : active.closest(CARD) ? 'card' : 'other',
    scene: document.querySelector('.scene-view') !== null,
  };
}

/** Works out what the controller does now, and keeps it for the hint bar and the crosshair. */
function refreshContext(): PadContext {
  const context = padContext(contextFacts());
  if (usePad.getState().context !== context) usePad.setState({ context });
  return context;
}

let contextQueued = false;

/** Works the context out again once the focus has settled. */
function queueContext(): void {
  if (contextQueued) return;
  contextQueued = true;
  queueMicrotask(() => {
    contextQueued = false;
    refreshContext();
  });
}

/**
 * The last thing the person used, for the arrow keys: after a press of the
 * mouse or a finger with nothing focused, they scroll as before.
 */
let lastInput: 'pointer' | 'keys' = 'keys';

/**
 * Notes what the person used last: the hint bar shows after a controller
 * and hides after the rest; the crosshair the keys showed hides after the
 * mouse or a finger.
 */
function used(source: InputSource): void {
  const state = usePad.getState();
  if (source === 'pad') lastInput = 'keys';
  if (state.source === source && (source !== 'pointer' || !state.mapKeys)) return;
  usePad.setState({ source, ...(source === 'pointer' ? { mapKeys: false } : {}) });
}

// ---------------------------------------------------------------------------
// Actions of the map

/** Moves the map by screen pixels and zooms it by levels, at once. */
function nudgeMap(dx: number, dy: number, dz: number): void {
  const scene = padScene();
  if (scene) {
    scene.nudge(dx, dy, dz);
    return;
  }
  const map = padMap();
  const view = map?.view.getView();
  if (!map || !view) return;
  const width = map.container.getBoundingClientRect().width;
  const imagePerScreen = (view.bounds.maxX - view.bounds.minX) / Math.max(1, width);
  map.view.flyTo(
    {
      x: view.center.x + dx * imagePerScreen,
      y: view.center.y + dy * imagePerScreen,
      zoom: view.zoom + dz,
    },
    { animate: false, exact: true },
  );
}

/** Opens the location under the crosshair, or moves into its card when it is open already. */
function openUnderReticle(): void {
  if (useLocationEditor.getState().active) {
    placeAtReticle();
    return;
  }
  const target = reticleTarget();
  if (!target) return;
  if (useAtlas.getState().selectedId === target.marker.id) host.focusCard();
  else host.open(target.marker.id);
}

/**
 * In Edit locations, A (or Enter) at the crosshair does what a press there
 * does: opens the location it holds, or puts a new location (or the one
 * being moved) where it points: on the 3D view's model, or on the map.
 */
function placeAtReticle(): void {
  // The location being moved goes where the crosshair points, even onto another one.
  const target = useLocationEditor.getState().moving ? null : reticleTarget();
  if (target) {
    pickedOnMap(target.marker.id);
    return;
  }
  const scene = padScene();
  if (scene) {
    scene.place?.();
    return;
  }
  const center = padMap()?.view.getView()?.center;
  if (center) clickedOnMap(center);
}

/** Marks the location under the crosshair found or not found, or else the one open. */
function markUnderReticle(): void {
  const target = reticleTarget();
  toggleFound(target?.marker.id ?? useAtlas.getState().selectedId);
}

/** Moves the crosshair to the next location in a direction, and the map with it. */
function jump(direction: Direction): void {
  const seen = markersOnScreen();
  const scene = padScene();
  const map = padMap();
  if (!seen || (!map && !scene)) return;
  const held = snapTarget(seen.center, seen.points);
  const from: Point = held >= 0 ? seen.points[held]! : seen.center;
  const index = jumpTarget(from, direction, seen.points, held);
  if (index < 0) return;
  const id = seen.markers[index]!.id;
  if (scene) {
    scene.lookAt(id);
    return;
  }
  const marker = useAtlas.getState().game?.pack.locations.get(id);
  if (map && marker) map.view.panTo({ x: marker.x, y: marker.y });
}

/** The floor below or above, where the map shown has floors, in 2D or in 3D. */
function stepFloor(by: -1 | 1): boolean {
  const name = floorStep(by, padScene() !== null);
  if (name) notify(`Floor: ${name}`);
  return name !== null;
}

/** Shows the next level of the map shown, where it has levels. */
function nextLevel(): void {
  const { game, mapId, layerId } = useAtlas.getState();
  if (!game || !mapId) return;
  // In 3D, the floors in turn, then all of them.
  const floors = floorsOfMap(useAtlas.getState(), mapId);
  if (padScene() && floors.length > 0) {
    if (!stepFloor(1)) {
      pickFloor(floors[0]!.id);
      notify(`Floor: ${floors[0]!.name}`);
    }
    return;
  }
  const layers = game.pack.layersOf(mapId);
  if (layers.length < 2) return;
  const at = layers.findIndex((layer) => layer.id === layerId);
  const next = layers[(at + 1) % layers.length]!;
  showMap(mapId, next.id);
  notify(`Level: ${next.name}`);
}

/** Shows the whole map. */
function wholeMap(): void {
  if (padScene()) {
    requestSceneView('recenter');
    return;
  }
  padMap()?.view.fitLayer();
}

// ---------------------------------------------------------------------------
// Actions anywhere

/**
 * The section before or after, in the order of the rail or the bar. The
 * focus follows when it was on the sections; else it goes into the
 * section's content (on the map: to the map itself, for the controller).
 */
function switchSection(by: -1 | 1): void {
  if (document.querySelector('dialog[open]')) return;
  const sections = [
    ...document.querySelectorAll<HTMLElement>(
      ':is(.touch-rail, .touch-bar) [data-testid^="section-"]',
    ),
  ].filter(usable);
  const at = sections.findIndex((element) => element.getAttribute('aria-current') === 'page');
  if (at < 0) return;
  const next = sections[at + by];
  if (!next) return;
  const onSections = focused()?.closest('.touch-rail, .touch-bar') != null;
  next.click();
  if (onSections) {
    next.focus({ preventScroll: true });
    return;
  }
  focused()?.blur();
  if (next.dataset.testid !== 'section-map') {
    afterDraw(() => {
      // Unless the person moved on meanwhile.
      if (!focused() && next.getAttribute('aria-current') === 'page') focusFirstIn(CONTENT);
    });
  }
}

/** Where the content of a section is, beside the rail or above the bar. */
const CONTENT = ':is(.touch-screen, .touch-panel, .library-section, .guides)';

/** Sends a key to the page, as if pressed: for the keys that turn pages. */
function sendKey(key: string, target: Element): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

/** The part of the page the controller scrolls: around the focus, or the largest shown. */
function scroller(direction: Direction): Element | null {
  const active = focused();
  const within = scope();
  if (active) {
    if (canScroll(active, direction)) return active;
    const around = scrollerAround(active, direction);
    if (around && around !== document.scrollingElement) return around;
  }
  let best: Element | null = null;
  let area = 0;
  for (const element of (within === document ? document : (within as Element)).querySelectorAll(
    '[data-scroll-root], .touch-scroll, .gb-pages, .guides-page',
  )) {
    if (!canScroll(element, direction)) continue;
    const box = element.getBoundingClientRect();
    if (box.width * box.height > area) {
      best = element;
      area = box.width * box.height;
    }
  }
  if (best) return best;
  const root = document.scrollingElement;
  return root && canScroll(root, direction) ? root : null;
}

/** Scrolls the part of the page the controller scrolls by pixels (down when positive). */
function scrollPixels(pixels: number): void {
  if (pixels === 0) return;
  const target = scroller(pixels > 0 ? 'down' : 'up');
  target?.scrollBy({ top: pixels, behavior: 'instant' });
}

/** Scrolls a page up or down. */
function scrollPage(by: -1 | 1): void {
  const target = scroller(by > 0 ? 'down' : 'up');
  if (!target) return;
  markMoving();
  const root = target === document.scrollingElement;
  const height = root ? window.innerHeight : target.clientHeight;
  target.scrollBy({ top: by * Math.max(40, height * 0.85), behavior: 'smooth' });
}

/** The page before or after in a guidebook or a guide read in order, else a page of scrolling. */
function turnPage(by: -1 | 1): void {
  markMoving();
  const reader = document.querySelector('dialog[open][data-testid="guidebook-reader"]');
  if (reader) {
    const active = focused();
    sendKey(by < 0 ? 'PageUp' : 'PageDown', active && reader.contains(active) ? active : reader);
    return;
  }
  if (
    !document.querySelector('dialog[open]') &&
    document.querySelector('[data-testid="guides-sequence"]')
  ) {
    sendKey(by < 0 ? '[' : ']', document.body);
    return;
  }
  scrollPage(by);
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
  if (active.closest(MAP) || isTypingTarget(active)) return;
  active.click();
}

/** Moves the focus to the map, for the controller to move it: when it is shown and the map's section. */
function backToMap(): boolean {
  const facts = contextFacts();
  if (!facts.mapShown || (facts.section !== null && facts.section !== 'map')) return false;
  if (facts.focus === 'map' || facts.focus === 'none') return false;
  focused()?.blur();
  return true;
}

/**
 * Goes back, as the B button does: as Esc, or Android's Back. With
 * nothing left to close, the focus leaves the map, or goes back to it.
 */
function back(): void {
  markMoving();
  const now = refreshContext();
  const moving = now === 'map' || now === 'scene';
  if (window.atlasBack) {
    if (!window.atlasBack() && !leaveMap(moving)) backToMap();
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
  if (target.dispatchEvent(escape) && !leaveMap(moving)) backToMap();
}

/** Does what a button does in a context, once, as it is pressed. `by` is -1 for the first of a pair. */
function run(action: ActionId, by: -1 | 1): void {
  switch (action) {
    case 'open-location':
      openUnderReticle();
      return;
    case 'mark-found':
      markUnderReticle();
      return;
    case 'step-done':
      // As the F key, which a list shown in order takes for its next step.
      sendKey('f', document.body);
      return;
    case 'filters':
      host.filters();
      return;
    case 'reset-view':
      wholeMap();
      return;
    case 'level':
      nextLevel();
      return;
    case 'from-above':
      padScene()?.fromAbove();
      return;
    case 'floor':
      stepFloor(by === 1 ? 1 : -1);
      return;
    case 'turn-page':
      turnPage(by);
      return;
    case 'scroll-page':
      scrollPage(by);
      return;
    case 'press':
      press();
      return;
    case 'back':
      back();
      return;
    case 'sections':
      switchSection(by);
      return;
    case 'menu':
      host.menu();
      return;
    case 'keys-guide':
      host.keysGuide();
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Keys

/** The map's keys held down now, which move or zoom it while they are held. */
const heldKeys = new Set<string>();
let keyFrame = 0;
let keyFrameAt = 0;

/** How fast the map's keys move it: as a controller's stick leaned most of the way. */
const KEY_LEAN = 0.8;
/** How fast the 3D view turns at full lean of a stick, or with its keys held, in radians a second. */
const TURN_RATE = 2.2;

function keyLoop(now: number): void {
  keyFrame = 0;
  if (heldKeys.size === 0) return;
  const seconds = keyFrameAt ? (now - keyFrameAt) / 1000 : 0;
  keyFrameAt = now;
  const x = (heldKeys.has('d') ? 1 : 0) - (heldKeys.has('a') ? 1 : 0);
  const y = (heldKeys.has('s') ? 1 : 0) - (heldKeys.has('w') ? 1 : 0);
  const zoomIn = heldKeys.has('+') ? 1 : 0;
  const zoomOut = heldKeys.has('-') ? 1 : 0;
  const { speed, invertY } = usePad.getState();
  const step = panStep(
    { x: x * KEY_LEAN, y: y * KEY_LEAN },
    { x: 0, y: 0 },
    seconds,
    speed,
    invertY,
  );
  nudgeMap(step.x, step.y, zoomStep(zoomOut, zoomIn, seconds));
  // The 3D view turns with its keys held.
  const turn = (heldKeys.has('.') ? 1 : 0) - (heldKeys.has(',') ? 1 : 0);
  if (turn !== 0) padScene()?.turn(turn * TURN_RATE * Math.min(seconds, 0.1), 0);
  keyFrame = requestAnimationFrame(keyLoop);
}

/** Starts or keeps moving the map with a key held. */
function holdKey(key: string): void {
  heldKeys.add(key);
  if (!keyFrame) {
    keyFrameAt = 0;
    keyFrame = requestAnimationFrame(keyLoop);
  }
}

function onKeyUp(event: KeyboardEvent): void {
  heldKeys.delete(keyName(event.key));
}

/** A key's name in the table: lower case, `=` as `+`. */
function keyName(key: string): string {
  if (key === '=') return '+';
  return key.length === 1 ? key.toLowerCase() : key;
}

/**
 * The keys of the map and of the sections (see the module). Whether the
 * key was used.
 */
function mapKeys(event: KeyboardEvent, active: HTMLElement | null): boolean {
  if (active && (isTypingTarget(active) || ownsArrows(active))) return false;
  const context = refreshContext();
  const action = keyAction(context, event.key);
  if (action === 'sections') {
    if (event.repeat || document.querySelector('dialog[open]') || openSheet()) return false;
    switchSection(keyName(event.key) === 'q' ? -1 : 1);
    return true;
  }
  const name = keyName(event.key);
  // The floors of a map shown in 2D go up and down with the keys of the 3D view.
  if (context === 'map' && (name === 'PageUp' || name === 'PageDown')) {
    return floorsOfMap(useAtlas.getState(), useAtlas.getState().mapId).length > 0
      ? stepFloor(name === 'PageUp' ? 1 : -1) || true
      : false;
  }
  if (context !== 'map' && context !== 'scene') return false;
  switch (action) {
    case 'pan':
      holdKey(name);
      usePad.setState({ mapKeys: true });
      return true;
    case 'zoom':
      // Leaflet zooms with these itself while the map has the focus.
      if (active && context === 'map') return false;
      if (!event.repeat) nudgeMap(0, 0, name === '+' ? 0.25 : -0.25);
      holdKey(name);
      usePad.setState({ mapKeys: true });
      return true;
    case 'open-location':
      // In Edit locations, Enter puts a location at the crosshair while it shows.
      if (
        !reticleTarget() &&
        !(useLocationEditor.getState().active && reticleShown(usePad.getState()))
      )
        return false;
      openUnderReticle();
      return true;
    case 'reset-view':
      wholeMap();
      return true;
    case 'level':
      nextLevel();
      return true;
    case 'turn':
      holdKey(name);
      return true;
    case 'floor':
      if (!event.repeat) stepFloor(name === 'PageUp' ? 1 : -1);
      return true;
    case 'from-above':
      padScene()?.fromAbove();
      return true;
    default:
      return false;
  }
}

function onPointerDown(): void {
  lastInput = 'pointer';
  used('pointer');
  delete document.documentElement.dataset.moving;
}

/** Where the mouse was last, so a move of a pixel or two (or none) is not counted. */
let mouseAt: Point | null = null;

function onPointerMove(event: PointerEvent): void {
  if (event.pointerType !== 'mouse') return;
  const at = { x: event.clientX, y: event.clientY };
  const before = mouseAt;
  mouseAt = at;
  if (!before || Math.hypot(at.x - before.x, at.y - before.y) < 4) return;
  used('pointer');
}

function onWheel(): void {
  used('pointer');
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  // Keys sent by the controller's own buttons (turning pages) are not the person's.
  if (event.isTrusted) used('keys');
  if (event.key === 'Tab') {
    lastInput = 'keys';
    markMoving();
    return;
  }
  const active = focused();
  if (!event.shiftKey || event.key === '+') {
    if (mapKeys(event, active)) {
      event.preventDefault();
      return;
    }
  }
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
  x: 2,
  y: 3,
  lb: 4,
  rb: 5,
  lt: 6,
  rt: 7,
  view: 8,
  menu: 9,
  l3: 10,
  r3: 11,
  up: 12,
  down: 13,
  dpadLeft: 14,
  dpadRight: 15,
} as const;

/** The buttons pressed once (not held down), with their part in the table and their side of a pair. */
const PRESSES: readonly { index: number; button: PadButton; by: -1 | 1 }[] = [
  { index: PAD.a, button: 'a', by: 1 },
  { index: PAD.b, button: 'b', by: 1 },
  { index: PAD.x, button: 'x', by: 1 },
  { index: PAD.y, button: 'y', by: 1 },
  { index: PAD.lb, button: 'lb', by: -1 },
  { index: PAD.rb, button: 'rb', by: 1 },
  { index: PAD.view, button: 'view', by: 1 },
  { index: PAD.menu, button: 'menu', by: 1 },
  { index: PAD.l3, button: 'l3', by: 1 },
  { index: PAD.r3, button: 'r3', by: 1 },
];

/** How far a stick has to lean, out of 1, to count as a direction for moving between buttons. */
const STICK = 0.5;
/** A held direction moves again after this, then every `REPEAT_MS`. */
const FIRST_REPEAT_MS = 380;
const REPEAT_MS = 120;
/** The D-pad goes from location to location a little slower than from button to button. */
const JUMP_REPEAT_MS = 220;

/**
 * The direction the D-pad holds, or else the left stick (unless `dpadOnly`), if any.
 */
export function padDirection(
  axes: readonly number[],
  pressed: (button: number) => boolean,
  dpadOnly = false,
): Direction | null {
  if (pressed(PAD.up)) return 'up';
  if (pressed(PAD.down)) return 'down';
  if (pressed(PAD.dpadLeft)) return 'left';
  if (pressed(PAD.dpadRight)) return 'right';
  if (dpadOnly) return null;
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
export function repeatDue(now: number, since: number, last: number, every = REPEAT_MS): boolean {
  if (last < since) return true;
  if (now - since < FIRST_REPEAT_MS) return false;
  return now - last >= every;
}

/** What was held at the last look, per gamepad. */
interface Held {
  direction: Direction | null;
  since: number;
  last: number;
  pressed: Set<number>;
  /** The triggers past half way, as presses (to turn pages). */
  triggers: { lt: boolean; rt: boolean };
}

const held = new Map<number, Held>();
let polling = 0;
let lastFrame = 0;
/** When the controller last worked out what it does (see `refreshContext`). */
let contextAt = 0;
const CONTEXT_MS = 150;

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
  'A controller is connected. The bar at the bottom shows what its buttons do here. Press View to see them all.';
let announced = false;

/** Whether the person is using the pad: a button down, or a stick or trigger past its dead zone. */
function inUse(pad: Gamepad): boolean {
  if (pad.buttons.some((button) => button.pressed || button.value > 0.3)) return true;
  return pad.axes.some((axis) => Math.abs(axis) > 0.3);
}

/**
 * When the controller is picked up after the mouse or a finger on the map,
 * a button pressed there (a section, Nearest unfound) gives the focus back
 * to the map, so the sticks move it.
 */
function pickedUp(): void {
  const active = focused();
  if (!active) return;
  const facts = contextFacts();
  if (facts.overlay || !facts.mapShown || (facts.section !== null && facts.section !== 'map'))
    return;
  if (active.closest('.touch-rail, .touch-bar, .touch-map')) active.blur();
}

function poll(now: number): void {
  polling = 0;
  const pads = gamepads();
  if (pads.length === 0) {
    held.clear();
    if (usePad.getState().padId !== null) usePad.setState({ padId: null });
    return;
  }
  const id = pads[0]!.id;
  if (usePad.getState().padId !== id) usePad.setState({ padId: id });
  // Once a run, so the person knows the controller reaches Atlas.
  if (!announced) {
    announced = true;
    notify(CONNECTED_TEXT);
  }
  const seconds = lastFrame ? (now - lastFrame) / 1000 : 0;
  lastFrame = now;
  for (const pad of pads) {
    if (inUse(pad) && usePad.getState().source !== 'pad') {
      if (usePad.getState().source === 'pointer') pickedUp();
      used('pad');
      contextAt = 0;
    }
    const isPressed = (button: number) => pad.buttons[button]?.pressed ?? false;
    const before = held.get(pad.index) ?? {
      direction: null,
      since: now,
      last: -1,
      pressed: new Set<number>(),
      triggers: { lt: false, rt: false },
    };
    // Looked at again a few times a second (the focus moving does it at once,
    // see `queueContext`), and as a button goes down.
    const edge = PRESSES.some(({ index }) => isPressed(index) && !before.pressed.has(index));
    if (edge || now - contextAt > CONTEXT_MS) {
      contextAt = now;
      refreshContext();
    }
    const context = usePad.getState().context;
    const inScene = context === 'scene';
    const onMap = context === 'map' || inScene;

    // The D-pad, and the left stick off the map: moving between buttons, or locations.
    const direction = padDirection(pad.axes, isPressed, onMap);
    const state: Held =
      direction === before.direction ? before : { ...before, direction, since: now, last: -1 };
    if (direction && repeatDue(now, state.since, state.last, onMap ? JUMP_REPEAT_MS : REPEAT_MS)) {
      state.last = now;
      if (inScene && (direction === 'up' || direction === 'down')) {
        stepFloor(direction === 'up' ? 1 : -1);
      } else if (onMap) jump(direction);
      else moveFocus(direction);
    }

    // The buttons, once each as they go down.
    const pressed = new Set<number>();
    for (const { index, button, by } of PRESSES) {
      if (!isPressed(index)) continue;
      pressed.add(index);
      if (before.pressed.has(index)) continue;
      const action = padAction(context, button);
      if (action) run(action, by);
    }
    state.pressed = pressed;

    // The sticks and the triggers.
    const left = stickVector(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
    const right = stickVector(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
    const lt = pad.buttons[PAD.lt]?.value ?? 0;
    const rt = pad.buttons[PAD.rt]?.value ?? 0;
    const triggerAction = padAction(context, 'rt');
    if (triggerAction === 'zoom' || padAction(context, 'ls') === 'pan') {
      const { speed, invertY } = usePad.getState();
      // In the 3D view the right stick turns the camera rather than panning finely.
      const step = panStep(left, inScene ? { x: 0, y: 0 } : right, seconds, speed, invertY);
      if (inScene && (right.x !== 0 || right.y !== 0)) {
        const dt = Math.min(seconds, 0.1) * TURN_RATE;
        padScene()?.turn(right.x * dt, (invertY ? -right.y : right.y) * dt);
      }
      const dz = triggerAction === 'zoom' ? zoomStep(lt, rt, seconds) : 0;
      if (step.x !== 0 || step.y !== 0 || dz !== 0) nudgeMap(step.x, step.y, dz);
    } else if (padAction(context, 'rs') === 'scroll') {
      scrollPixels(stickScroll(right.y, seconds));
    }
    // The triggers as presses, past half way and let go below a quarter.
    const ltDown = before.triggers.lt ? triggerValue(lt) > 0.25 : triggerValue(lt) > TRIGGER_PRESS;
    const rtDown = before.triggers.rt ? triggerValue(rt) > 0.25 : triggerValue(rt) > TRIGGER_PRESS;
    if (triggerAction && triggerAction !== 'zoom') {
      if (ltDown && !before.triggers.lt) run(triggerAction, -1);
      if (rtDown && !before.triggers.rt) run(triggerAction, 1);
    }
    state.triggers = { lt: ltDown, rt: rtDown };
    held.set(pad.index, state);
  }
  polling = requestAnimationFrame(poll);
}

function startPolling(): void {
  if (polling) return;
  lastFrame = 0;
  polling = requestAnimationFrame(poll);
}

function onFocusChange(): void {
  queueContext();
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
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', clearKeys);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('wheel', onWheel, { capture: true, passive: true });
  document.addEventListener('focusin', onFocusChange);
  document.addEventListener('focusout', onFocusChange);
  const gamepadOffered = gamepadApi() !== null;
  usePad.setState({ offered: gamepadOffered });
  if (gamepadOffered) {
    window.addEventListener('gamepadconnected', startPolling);
    if (gamepads().length > 0) startPolling();
  }
  return () => {
    installed = false;
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', clearKeys);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('wheel', onWheel, true);
    document.removeEventListener('focusin', onFocusChange);
    document.removeEventListener('focusout', onFocusChange);
    window.removeEventListener('gamepadconnected', startPolling);
    if (polling) cancelAnimationFrame(polling);
    polling = 0;
    held.clear();
    clearKeys();
  };
}

/** Lets go of the map's keys, as when the window loses the focus. */
function clearKeys(): void {
  heldKeys.clear();
  if (keyFrame) cancelAnimationFrame(keyFrame);
  keyFrame = 0;
}
