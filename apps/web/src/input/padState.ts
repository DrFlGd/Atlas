/**
 * What the controller needs to know and to show, apart from the page:
 * the person's settings for it (stored on the device as the theme is),
 * the controller connected now, the last thing the person used, what the
 * controller is doing now (see `padContext`), and the map it moves with
 * the locations drawn on it, from which the crosshair finds the location
 * it holds.
 */
import type { MapMarker, MapView } from '@atlas/core/mapview';
import { create } from 'zustand';
import { saveSetting } from '../state/actions';
import { SETTINGS, progressStore } from '../state/services';
import type { PadContext } from './bindings';
import { glyphStyleFor, SNAP_RADIUS, type GlyphStyle, type PanSpeed } from './padMath';

/** When the hint bar shows: after the controller is used (Automatic), whenever one is connected, or never. */
export type HintsSetting = 'auto' | 'always' | 'never';
/** Which glyphs the buttons get: from the controller's name, letters, or shapes. */
export type GlyphSetting = 'auto' | GlyphStyle;

export interface PadSettings {
  hints: HintsSetting;
  glyphs: GlyphSetting;
  speed: PanSpeed;
  invertY: boolean;
}

/** The last thing the person used: a mouse, a finger or a pen; keys; or a controller. */
export type InputSource = 'pointer' | 'keys' | 'pad';

export interface PadState extends PadSettings {
  /**
   * The controller connected now, by the name its web view gives it; null
   * when none is. `offered` says whether the web view offers controllers
   * at all (WebKitGTK may not).
   */
  padId: string | null;
  offered: boolean;
  source: InputSource;
  /** What the controller does now. */
  context: PadContext;
  /** The map was moved with its keys since the last press of the mouse: the crosshair shows. */
  mapKeys: boolean;
}

export const DEFAULT_PAD_SETTINGS: PadSettings = {
  hints: 'auto',
  glyphs: 'auto',
  speed: 'normal',
  invertY: false,
};

export const usePad = create<PadState>()(() => ({
  ...DEFAULT_PAD_SETTINGS,
  padId: null,
  offered: false,
  source: 'keys',
  context: 'menus',
  mapKeys: false,
}));

/** The settings as stored, each one checked; what is missing or wrong is the default. */
export function parsePadSettings(value: unknown): PadSettings {
  const saved = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const pick = <T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(raw as T) ? (raw as T) : fallback;
  return {
    hints: pick(saved.hints, ['auto', 'always', 'never'], DEFAULT_PAD_SETTINGS.hints),
    glyphs: pick(saved.glyphs, ['auto', 'letters', 'shapes'], DEFAULT_PAD_SETTINGS.glyphs),
    speed: pick(saved.speed, ['slow', 'normal', 'fast'], DEFAULT_PAD_SETTINGS.speed),
    invertY: saved.invertY === true,
  };
}

/** Reads the settings, once the store is open. */
export async function loadPadSettings(): Promise<void> {
  try {
    usePad.setState(parsePadSettings(await progressStore().getSetting(SETTINGS.controller)));
  } catch {
    // The defaults stand.
  }
}

/** Changes one setting and stores them. */
export function setPadSetting<K extends keyof PadSettings>(key: K, value: PadSettings[K]): void {
  usePad.setState({ [key]: value } as Pick<PadSettings, K>);
  const { hints, glyphs, speed, invertY } = usePad.getState();
  saveSetting(SETTINGS.controller, { hints, glyphs, speed, invertY });
}

/** The glyphs the buttons get now. */
export function glyphStyle(state: Pick<PadState, 'glyphs' | 'padId'>): GlyphStyle {
  return state.glyphs === 'auto' ? glyphStyleFor(state.padId) : state.glyphs;
}

/** Whether the hint bar shows now. */
export function hintsShown(state: Pick<PadState, 'hints' | 'padId' | 'source'>): boolean {
  if (state.padId === null || state.hints === 'never') return false;
  return state.hints === 'always' || state.source === 'pad';
}

/** Whether the crosshair shows on the map now. */
export function reticleShown(state: Pick<PadState, 'padId' | 'source' | 'context' | 'mapKeys'>) {
  if (state.context !== 'map' && state.context !== 'card') return false;
  return (state.source === 'pad' && state.padId !== null) || state.mapKeys;
}

// ---------------------------------------------------------------------------
// The map

let shownMap: { view: MapView; container: HTMLElement } | null = null;
let shownMarkers: readonly MapMarker[] = [];

/** The map the controller moves, while one is shown (`MapPane` says). */
export function setPadMap(map: { view: MapView; container: HTMLElement } | null): void {
  shownMap = map;
}

export function padMap(): { view: MapView; container: HTMLElement } | null {
  return shownMap;
}

/** The locations drawn on the map now (`MapPane` says). */
export function setShownMarkers(markers: readonly MapMarker[]): void {
  shownMarkers = markers;
}

/** The locations drawn on the map, with where each is in the map's box, in screen pixels. */
export function markersOnScreen(): {
  markers: readonly MapMarker[];
  points: { x: number; y: number }[];
  center: { x: number; y: number };
  /** Screen pixels per image pixel. */
  scale: number;
} | null {
  const map = shownMap;
  const view = map?.view.getView();
  if (!map || !view) return null;
  const box = map.container.getBoundingClientRect();
  const span = view.bounds.maxX - view.bounds.minX;
  if (box.width <= 0 || span <= 0) return null;
  const scale = box.width / span;
  return {
    markers: shownMarkers,
    points: shownMarkers.map((marker) => ({
      x: (marker.x - view.bounds.minX) * scale,
      y: (marker.y - view.bounds.minY) * scale,
    })),
    center: { x: box.width / 2, y: box.height / 2 },
    scale,
  };
}

/** The location the crosshair holds now, while it shows: its marker and where it is on the screen. */
export function reticleTarget(): { marker: MapMarker; x: number; y: number } | null {
  if (!reticleShown(usePad.getState())) return null;
  const map = shownMap;
  const view = map?.view.getView();
  if (!map || !view) return null;
  const box = map.container.getBoundingClientRect();
  const span = view.bounds.maxX - view.bounds.minX;
  if (box.width <= 0 || span <= 0) return null;
  const scale = box.width / span;
  // As `snapTarget`, without a point made for each of thousands of locations at every frame.
  const center = { x: view.center.x, y: view.center.y };
  const reach = SNAP_RADIUS / scale;
  let best: MapMarker | null = null;
  let bestDistance = reach * reach;
  for (const marker of shownMarkers) {
    const dx = marker.x - center.x;
    if (dx > reach || dx < -reach) continue;
    const dy = marker.y - center.y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance || (best === null && distance === bestDistance)) {
      best = marker;
      bestDistance = distance;
    }
  }
  if (!best) return null;
  return {
    marker: best,
    x: (best.x - view.bounds.minX) * scale,
    y: (best.y - view.bounds.minY) * scale,
  };
}
