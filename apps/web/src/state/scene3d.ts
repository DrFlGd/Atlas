/**
 * What the app knows of 3D maps outside the 3D view itself, which is a
 * chunk of its own (`src/scene/`), loaded only when a 3D map is shown:
 * whether a map has a model (`scene`, see the schema's `scene.ts`), whether
 * it is shown in 2D or in 3D, its floors, and the cuts the person chose.
 *
 * A map with a model opens in 3D: the model is what such a map is made
 * for, and 2D is always one press away, on the same switch. The choice is
 * kept on the device, for every 3D map. The 3D view needs WebGL 2; where
 * the device or the web view has none, it says so and the map stays in 2D.
 * It is shown in the standard layout; the classic layout shows such a map
 * in 2D, with a note.
 *
 * Pressing a location in 3D goes to it (`focusLocation`): its floor is
 * shown and the model is cut at head height above it. Closing its card
 * keeps them; going back (All floors, Back to the start, and Escape, B or
 * Back once the card is closed) shows every floor again without that cut
 * (`leaveFocus`). The names of
 * the areas float over the view unless the person turned them off, a
 * choice kept on the device.
 */
import { floorsOf, type Layer, type Scene } from '@atlas/schema';
import { create } from 'zustand';
import { useLocationEditor } from '../touch/locations/locationEditorState';
import { saveSetting, showMap } from './actions';
import { useMapOverlay } from './mapOverlay';
import { useRoutes } from './routes';
import { progressStore, SETTINGS } from './services';
import { useAtlas, type AtlasState } from './store';

export type ViewMode = '2d' | '3d';
/** Whether the device can show the 3D view: not looked at yet, yes or no. */
export type WebglSupport = 'unknown' | 'yes' | 'no';

/** A request to the 3D view, with a sequence number so it can be asked for again. */
export interface SceneRequest {
  kind: 'above' | 'recenter';
  seq: number;
}

export interface Scene3dState {
  /** 3D maps in 3D or in 2D, as the person chose (see the module). */
  mode: ViewMode;
  webgl: WebglSupport;
  /** With floors: every floor shown at once, rather than the one of `layerId`. */
  allFloors: boolean;
  /** The height above which the model is cut away, when no floor is picked; null: none. */
  cut: number | null;
  /** Cut away what lies between the camera and the point looked at. */
  cutTowardCamera: boolean;
  request: SceneRequest | null;
  /**
   * The location the view went to, and the height the model is cut at
   * above it, in place of the floor's top and the free cut; null: none.
   */
  focus: SceneFocus | null;
  /** The names of the areas over the view. */
  titles: boolean;
}

export interface SceneFocus {
  id: string;
  cut: number;
}

export const useScene3d = create<Scene3dState>()(() => ({
  mode: '3d',
  webgl: 'unknown',
  allFloors: true,
  cut: null,
  cutTowardCamera: false,
  request: null,
  focus: null,
  titles: true,
}));

/** Reads the person's choice of 2D or 3D, once the store with the settings is open. */
export async function loadSceneSettings(): Promise<void> {
  try {
    const saved = await progressStore().getSetting(SETTINGS.sceneView);
    if (saved === '2d' || saved === '3d') useScene3d.setState({ mode: saved });
    const titles = await progressStore().getSetting(SETTINGS.sceneTitles);
    if (titles === true || titles === false) useScene3d.setState({ titles });
  } catch {
    // The default stands.
  }
}

/** Shows the names of the areas over the 3D view, or not, and keeps the choice. */
export function setTitlesShown(on: boolean): void {
  useScene3d.setState({ titles: on });
  saveSetting(SETTINGS.sceneTitles, on);
}

/** Shows 3D maps in 3D or in 2D, and keeps the choice. */
export function setViewMode(mode: ViewMode): void {
  if (mode === '3d' && webglSupport() === 'no') return;
  useScene3d.setState({ mode });
  saveSetting(SETTINGS.sceneView, mode);
}

let probed: WebglSupport = 'unknown';

/**
 * Whether the device can show the 3D view: a WebGL 2 context can be made.
 * Looked at once, the first time a map with a model is shown.
 */
export function webglSupport(): WebglSupport {
  if (probed !== 'unknown') return probed;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    probed = gl ? 'yes' : 'no';
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    probed = 'no';
  }
  useScene3d.setState({ webgl: probed });
  return probed;
}

/** Tells that the 3D view could not start (a context refused or lost for good): stay in 2D. */
export function webglFailed(): void {
  probed = 'no';
  useScene3d.setState({ webgl: 'no' });
}

/** The model of a map, or null when it has none. */
export function sceneOf(state: Pick<AtlasState, 'game'>, mapId: string | null): Scene | null {
  if (!state.game || !mapId) return null;
  const map = state.game.pack.maps.get(mapId);
  return map?.scene && map.worldTransform ? map.scene : null;
}

/** The floors of a map, lowest first; empty when it has fewer than two. */
export function floorsOfMap(state: Pick<AtlasState, 'game'>, mapId: string | null): Layer[] {
  if (!state.game || !mapId) return [];
  return floorsOf(state.game.pack.layersOf(mapId), mapId);
}

/**
 * Whether the map shown is shown in 3D now: it has a model, 3D is chosen
 * and the device can, and nothing that places points on the map image is
 * open (Edit locations, the list editor, a route being edited), which
 * works in 2D.
 */
export function useSceneShown(): boolean {
  const hasScene = useAtlas((s) => sceneOf(s, s.mapId) !== null);
  const mode = useScene3d((s) => s.mode);
  const webgl = useScene3d((s) => s.webgl);
  // Each hook called every time, whatever the others say.
  const locating = useLocationEditor((s) => s.active);
  const routing = useRoutes((s) => s.editing !== null);
  const listing = useMapOverlay((s) => s.points !== null || s.pick !== null);
  return hasScene && mode === '3d' && webgl !== 'no' && !locating && !routing && !listing;
}

/**
 * Goes a floor up (`by` 1) or down (-1) on the map shown, where it has
 * floors. In 3D, "All" (every floor shown) is above the top floor: up from
 * the top floor shows all of them, down from all shows the top floor.
 */
export function floorStep(by: -1 | 1, in3d: boolean): string | null {
  const state = useAtlas.getState();
  const floors = floorsOfMap(state, state.mapId);
  if (floors.length === 0 || !state.mapId) return null;
  const all = in3d && useScene3d.getState().allFloors;
  const at = all ? floors.length : floors.findIndex((layer) => layer.id === state.layerId);
  const next = Math.min(Math.max(at + by, 0), in3d ? floors.length : floors.length - 1);
  if (next === at) return null;
  if (next === floors.length) {
    useScene3d.setState({ allFloors: true, focus: null });
    return 'All floors';
  }
  const layer = floors[next]!;
  useScene3d.setState({ allFloors: false, focus: null });
  showMap(state.mapId, layer.id);
  return layer.name;
}

/** Picks a floor of the map shown, or every floor (null). */
export function pickFloor(layerId: string | null): void {
  const state = useAtlas.getState();
  if (layerId === null) {
    useScene3d.setState({ allFloors: true, focus: null });
    return;
  }
  if (!state.mapId) return;
  useScene3d.setState({ focus: null });
  // A level of a map without floors is only shown.
  if (floorsOfMap(state, state.mapId).length > 0) useScene3d.setState({ allFloors: false });
  showMap(state.mapId, layerId);
}

/**
 * The view went to a location (see the module): shows its floor (a layer
 * of its map; null on a map without floors) and cuts the model at `cut`.
 */
export function focusLocation(id: string, floorId: string | null, cut: number): void {
  const state = useAtlas.getState();
  // Not back from the location before (the selection may be let go of for a moment below).
  useScene3d.setState({ focus: null });
  if (floorId !== null && state.mapId) {
    useScene3d.setState({ allFloors: false });
    showMap(state.mapId, floorId);
    // A floor other than the location's own layer lets go of the selection: it is kept.
    if (state.selectedId === id && useAtlas.getState().selectedId !== id) {
      useAtlas.setState({ selectedId: id });
    }
  }
  useScene3d.setState({ focus: { id, cut } });
}

/** Back from a location the view went to: every floor, and no cut above it. */
export function leaveFocus(): void {
  if (useScene3d.getState().focus === null) return;
  useScene3d.setState({ allFloors: true, focus: null });
}

let requestSeq = 1;

/** Asks the 3D view to look straight down, or to go back to where it started. */
export function requestSceneView(kind: SceneRequest['kind']): void {
  // Back to the start is back from a location too.
  if (kind === 'recenter') leaveFocus();
  useScene3d.setState({ request: { kind, seq: requestSeq++ } });
}

/** Sets the height cut (null: none) and the cut toward the camera. */
export function setCut(cut: number | null): void {
  useScene3d.setState({ cut, focus: null });
}

export function setCutTowardCamera(on: boolean): void {
  useScene3d.setState({ cutTowardCamera: on });
}
