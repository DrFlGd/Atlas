/**
 * The arithmetic of a controller, apart from the page so it can be tested:
 * what a stick or a trigger gives after its dead zone, how far the map
 * moves and zooms in a frame, which location the crosshair holds, which
 * one the D-pad goes to, which glyphs a controller's buttons have, and
 * what the controller is doing now.
 */
import type { PadButton, PadContext } from './bindings';

/** Below this a stick counts as at rest (out of 1). */
export const STICK_DEAD = 0.18;
/** Below this a trigger counts as let go. */
export const TRIGGER_DEAD = 0.08;
/** A trigger pressed past this counts as a press of a button (to turn a page). */
export const TRIGGER_PRESS = 0.5;
/**
 * How the push of a stick turns into speed: a power above 1 gives fine
 * control near the middle and full speed at the edge.
 */
const STICK_CURVE = 1.7;

/** A stick's lean after its dead zone, each axis from -1 to 1, curved. Zero inside the dead zone. */
export function stickVector(x: number, y: number, dead = STICK_DEAD): { x: number; y: number } {
  const length = Math.hypot(x, y);
  if (!Number.isFinite(length) || length <= dead) return { x: 0, y: 0 };
  const reach = (Math.min(length, 1) - dead) / (1 - dead);
  const strength = reach ** STICK_CURVE;
  return { x: (x / length) * strength, y: (y / length) * strength };
}

/** A trigger's pull after its dead zone, from 0 to 1. */
export function triggerValue(value: number, dead = TRIGGER_DEAD): number {
  if (!Number.isFinite(value) || value <= dead) return 0;
  return Math.min(1, (value - dead) / (1 - dead));
}

/** The map's speed at full lean, in screen pixels a second, by the setting. */
export const PAN_SPEED = { slow: 550, normal: 950, fast: 1600 } as const;
export type PanSpeed = keyof typeof PAN_SPEED;
/** The right stick moves the map this much slower, for finer aim at a location. */
export const FINE_PAN = 0.3;
/** How fast a trigger pulled fully zooms, in zoom levels a second. */
export const ZOOM_RATE = 2.4;
/** The longest frame counted, so a stall does not throw the map across the screen. */
const MAX_FRAME_S = 0.1;

/**
 * How far the map moves in a frame, in screen pixels, from the two sticks
 * (each already through {@link stickVector}). `invertY` turns the up and
 * down of panning round.
 */
export function panStep(
  left: { x: number; y: number },
  right: { x: number; y: number },
  seconds: number,
  speed: PanSpeed,
  invertY: boolean,
): { x: number; y: number } {
  const step = Math.min(Math.max(seconds, 0), MAX_FRAME_S) * PAN_SPEED[speed];
  const x = (left.x + right.x * FINE_PAN) * step;
  const y = (left.y + right.y * FINE_PAN) * step * (invertY ? -1 : 1);
  return { x, y };
}

/** How many zoom levels the map zooms in a frame: in with the right trigger, out with the left. */
export function zoomStep(leftTrigger: number, rightTrigger: number, seconds: number): number {
  const pull = triggerValue(rightTrigger) - triggerValue(leftTrigger);
  return pull * ZOOM_RATE * Math.min(Math.max(seconds, 0), MAX_FRAME_S);
}

/** How fast the right stick scrolls a page or a list, in pixels a second at full lean. */
export const SCROLL_PX_PER_S = 1400;

/** How far a page scrolls in a frame from the right stick's up and down (through {@link stickVector}). */
export function scrollStep(y: number, seconds: number): number {
  return y * SCROLL_PX_PER_S * Math.min(Math.max(seconds, 0), MAX_FRAME_S);
}

/** A point on the screen. */
export interface Point {
  x: number;
  y: number;
}

/** How near the crosshair a location has to be, in screen pixels, to be held by it. */
export const SNAP_RADIUS = 36;

/**
 * The location the crosshair holds: the nearest of `points` to `center`
 * within `radius`, as its index, or -1. On a tie, the first.
 */
export function snapTarget(center: Point, points: readonly Point[], radius = SNAP_RADIUS): number {
  let best = -1;
  let bestDistance = radius * radius;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const distance = dx * dx + dy * dy;
    if (distance <= bestDistance && (best === -1 || distance < bestDistance)) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

export type Way = 'up' | 'down' | 'left' | 'right';

/**
 * The location the D-pad goes to from `from`, as the index of its point,
 * or -1: the nearest one that way, within a wide cone (more than twice as
 * far sideways as ahead does not count), a point straight ahead counting
 * nearer than one beside it. `skip` is the index of the location at `from`.
 */
export function jumpTarget(from: Point, way: Way, points: readonly Point[], skip = -1): number {
  let best = -1;
  let bestScore = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    if (index === skip) continue;
    const point = points[index]!;
    const dx = point.x - from.x;
    const dy = point.y - from.y;
    const ahead = way === 'right' ? dx : way === 'left' ? -dx : way === 'down' ? dy : -dy;
    const side = Math.abs(way === 'left' || way === 'right' ? dy : dx);
    if (ahead < 1 || side > ahead * 2) continue;
    const score = ahead + side * 2;
    if (score < bestScore) {
      best = index;
      bestScore = score;
    }
  }
  return best;
}

/** How the controller's face buttons are marked: letters (A, B, X, Y) or shapes. */
export type GlyphStyle = 'letters' | 'shapes';

/**
 * The glyphs of a controller, from the name its web view gives it. Sony's
 * controllers are marked with shapes (their vendor id 054c, or their name);
 * every other one, with letters.
 */
export function glyphStyleFor(id: string | null): GlyphStyle {
  if (!id) return 'letters';
  const name = id.toLowerCase();
  if (/vendor:\s*054c\b/u.test(name) || /\b054c-/u.test(name) || name.startsWith('054c')) {
    return 'shapes';
  }
  return /dualshock|dualsense|playstation|\bps[345]\b/u.test(name) ? 'shapes' : 'letters';
}

/** A button's name, as a screen reader says it and the guide's text gives it. */
export function padButtonName(button: PadButton, style: GlyphStyle): string {
  const shapes = style === 'shapes';
  switch (button) {
    case 'a':
      return shapes ? 'Cross' : 'A';
    case 'b':
      return shapes ? 'Circle' : 'B';
    case 'x':
      return shapes ? 'Square' : 'X';
    case 'y':
      return shapes ? 'Triangle' : 'Y';
    case 'lb':
      return shapes ? 'L1' : 'LB';
    case 'rb':
      return shapes ? 'R1' : 'RB';
    case 'lt':
      return shapes ? 'L2' : 'LT';
    case 'rt':
      return shapes ? 'R2' : 'RT';
    case 'view':
      return 'View';
    case 'menu':
      return 'Menu';
    case 'ls':
      return 'Left stick';
    case 'rs':
      return 'Right stick';
    case 'l3':
      return 'Left stick press (L3)';
    case 'r3':
      return 'Right stick press (R3)';
    case 'dpad':
      return 'D-pad';
  }
}

/** What is on the screen and where the focus is, as `padContext` needs it. */
export interface ContextFacts {
  /** A guidebook is open in its reader. */
  reader: boolean;
  /** A dialog, a menu or a sheet is open over the screen. */
  overlay: boolean;
  /** The section shown in the standard layout; null in the classic layout. */
  section: string | null;
  /** The map is on the screen. */
  mapShown: boolean;
  /** Where the focus is. */
  focus: 'none' | 'map' | 'card' | 'other';
}

/**
 * What the controller does now: move the map while the map is shown and
 * nothing else has the focus; the card of a location while the focus is
 * in it; reading in Guides and in a guidebook; a list in Lists; and
 * otherwise moving between buttons.
 */
export function padContext(facts: ContextFacts): PadContext {
  if (facts.reader) return 'reading';
  if (facts.overlay) return 'menus';
  if (facts.focus === 'card') return 'card';
  const onMap = facts.section === null || facts.section === 'map';
  if (onMap && facts.mapShown && (facts.focus === 'none' || facts.focus === 'map')) return 'map';
  if (facts.section === 'guides') return 'reading';
  if (facts.section === 'lists') return 'lists';
  return 'menus';
}
