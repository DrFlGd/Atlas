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
 * choice kept on the device. "Floor colours" paints each floor of the model
 * in its own colour (see `scene/floorColours.ts`), where the map has floors;
 * also a choice kept on the device, off at first.
 *
 * "Look" draws the model textured (its own textures and colours) or
 * shaded, in one colour the person picks (see `scene/looks.ts`). The look,
 * the colour and "Darker walls and slopes" are kept on the device, for
 * every 3D map; a model without textures of its own is shown shaded
 * whatever was chosen, so at first a textured model is shown textured and
 * one made from collision in teal, as it was made. "Floor colours", while
 * on, paints over either look.
 */
import { floorsOf, type Layer, type Scene } from '@atlas/schema';
import { create } from 'zustand';
import { DEFAULT_SHADE, isShade, lookShown, type SceneLook } from '../scene/looks';
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
  /**
   * The height above which the model is cut away, when no floor is picked;
   * null: none. It belongs to the map it was set on (`cutMapId`): another
   * map, with heights of its own, is shown uncut (see `cutOf`).
   */
  cut: number | null;
  cutMapId: string | null;
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
  /** Each floor of the model in its own colour, where the map has floors. */
  floorColours: boolean;
  /** The look asked for: textured, where the model can be (see `lookOf`), or shaded. */
  look: SceneLook;
  /** The colour shaded with: a preset's id or `#rrggbb` (see `scene/looks.ts`). */
  shade: string;
  /** "Darker walls and slopes" in the shaded look. */
  strongShade: boolean;
  /**
   * Whether the model shown has textures or colours of its own, as the
   * view found once its first part was in; null: not known yet.
   */
  ownLook: boolean | null;
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
  cutMapId: null,
  cutTowardCamera: false,
  request: null,
  focus: null,
  titles: true,
  floorColours: false,
  look: 'textured',
  shade: DEFAULT_SHADE,
  strongShade: false,
  ownLook: null,
}));

/** Reads the person's choice of 2D or 3D, once the store with the settings is open. */
export async function loadSceneSettings(): Promise<void> {
  try {
    const saved = await progressStore().getSetting(SETTINGS.sceneView);
    if (saved === '2d' || saved === '3d') useScene3d.setState({ mode: saved });
    const titles = await progressStore().getSetting(SETTINGS.sceneTitles);
    if (titles === true || titles === false) useScene3d.setState({ titles });
    const floorColours = await progressStore().getSetting(SETTINGS.sceneFloorColours);
    if (floorColours === true || floorColours === false) useScene3d.setState({ floorColours });
    useScene3d.setState(savedLook(await progressStore().getSetting(SETTINGS.sceneLook)));
  } catch {
    // The default stands.
  }
}

/** Shows the names of the areas over the 3D view, or not, and keeps the choice. */
export function setTitlesShown(on: boolean): void {
  useScene3d.setState({ titles: on });
  saveSetting(SETTINGS.sceneTitles, on);
}

/** Paints each floor of the 3D view in its own colour, or not, and keeps the choice. */
export function setFloorColoursShown(on: boolean): void {
  useScene3d.setState({ floorColours: on });
  saveSetting(SETTINGS.sceneFloorColours, on);
}

/** The look, the colour and "Darker walls and slopes" as kept on the device. */
export interface SavedLook {
  look: SceneLook;
  shade: string;
  strong: boolean;
}

/** What of a kept look can be read (anything else stays as it is). */
export function savedLook(saved: unknown): Partial<Scene3dState> {
  if (typeof saved !== 'object' || saved === null) return {};
  const { look, shade, strong } = saved as Partial<Record<keyof SavedLook, unknown>>;
  return {
    ...(look === 'textured' || look === 'shaded' ? { look } : {}),
    ...(isShade(shade) ? { shade } : {}),
    ...(strong === true || strong === false ? { strongShade: strong } : {}),
  };
}

function keepLook(): void {
  const { look, shade, strongShade } = useScene3d.getState();
  const saved: SavedLook = { look, shade, strong: strongShade };
  saveSetting(SETTINGS.sceneLook, saved);
}

/** The look the model shown is drawn with: textured only where it has textures or colours of its own. */
export function lookOf(state: Pick<Scene3dState, 'look' | 'ownLook'>): SceneLook {
  return lookShown(state.look, state.ownLook === true);
}

/** Draws 3D maps textured (where they can be) or shaded, and keeps the choice. */
export function setLook(look: SceneLook): void {
  useScene3d.setState({ look });
  keepLook();
}

/**
 * Shades with a colour (a preset's id or `#rrggbb`), and keeps it. A model
 * shown textured is shown shaded, to show the colour picked.
 */
export function setShade(shade: string): void {
  if (!isShade(shade)) return;
  const state = useScene3d.getState();
  useScene3d.setState({ shade, ...(lookOf(state) === 'textured' ? { look: 'shaded' } : {}) });
  keepLook();
}

/** "Darker walls and slopes" in the shaded look, on or off; as `setShade`, it shows the model shaded. */
export function setStrongShade(on: boolean): void {
  const state = useScene3d.getState();
  useScene3d.setState({
    strongShade: on,
    ...(lookOf(state) === 'textured' ? { look: 'shaded' } : {}),
  });
  keepLook();
}

/** The view found whether the model shown has textures or colours of its own (null: none shown). */
export function setOwnLook(own: boolean | null): void {
  if (useScene3d.getState().ownLook !== own) useScene3d.setState({ ownLook: own });
}

/** Why "Floor colours" cannot be used on a map: null when it can. */
export function floorColoursReason(floors: readonly Layer[]): string | null {
  return floors.length === 0 ? 'This map has no floors' : null;
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
 * open (the list editor, a route being edited), which works in 2D. Edit
 * locations works in 3D too: a location is put on the model's surface
 * (see `scene/sceneEditing.ts`).
 */
export function useSceneShown(): boolean {
  const hasScene = useAtlas((s) => sceneOf(s, s.mapId) !== null);
  const mode = useScene3d((s) => s.mode);
  const webgl = useScene3d((s) => s.webgl);
  // Each hook called every time, whatever the others say.
  const routing = useRoutes((s) => s.editing !== null);
  const listing = useMapOverlay((s) => s.points !== null || s.pick !== null);
  return hasScene && mode === '3d' && webgl !== 'no' && !routing && !listing;
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

/** Sets the height cut of a map (null: none). */
export function setCut(cut: number | null, mapId: string): void {
  useScene3d.setState({ cut, cutMapId: cut === null ? null : mapId, focus: null });
}

/** The height cut of a map: the free cut, when it was set on that map; else none. */
export function cutOf(
  state: Pick<Scene3dState, 'cut' | 'cutMapId'>,
  mapId: string | null,
): number | null {
  return mapId !== null && state.cutMapId === mapId ? state.cut : null;
}

export function setCutTowardCamera(on: boolean): void {
  useScene3d.setState({ cutTowardCamera: on });
}
