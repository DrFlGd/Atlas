/**
 * The commands of the Map Maker's desktop shell (`src-tauri`). Like the Atlas viewer, the page has no dependency on
 * Tauri: inside the shell, Tauri injects an `invoke` function. In a plain browser `shell` is null.
 */
import type {
  AnyReport,
  FloorMethod,
  HeightProfile,
  MapStyleId,
  PassageChoice,
  PassagePlace,
  PassagesReport,
} from './report';
import type { Inspected, ModelSetup } from './model';

export interface AppInfo {
  version: string;
  helperFound: boolean;
  /** The 3D builder (atlas-scene) that comes with the Map Maker is there. */
  sceneBuilderFound: boolean;
  /** "Also make 3D maps", as last chosen (on by default). */
  make3d: boolean;
  /** "Map style", as last chosen. */
  mapStyle: MapStyleId;
  /** "Floors", as last chosen; null: as suits the game. */
  floorMethod: FloorMethod | null;
  lastFolder: string | null;
  /** Where Steam usually installs Dark Souls Remastered, when that folder exists on this computer. */
  typicalFolder: string | null;
  /** Where Make map installs the pack: the Atlas viewer's maps folder. */
  mapsFolder: string | null;
}

export type CheckState = 'idle' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';

export interface CheckLine {
  kind: 'warning' | 'area' | 'game' | 'info' | 'pack';
  text: string;
}

export interface MadePack {
  folder: string;
  id: string;
  installed: boolean;
  counts?: Record<string, number>;
}

export interface CheckStatus {
  state: CheckState;
  /** A check, a make (Make map), or the making of one area again (Make this area again). */
  kind: 'check' | 'make' | 'remake';
  /** A make (or making again) of a map from a 3D model: `folder` is the model file. */
  fromModel?: boolean;
  runId: number;
  folder: string | null;
  fraction: number;
  message: string;
  lines: CheckLine[];
  report: AnyReport | null;
  /** The map pack a make installed. */
  pack: MadePack | null;
  error: string | null;
  /** Why making an area again could not start (`pack-missing`, `pack-other-version`, `report-missing`,
   * `area-missing`): the page offers Make map. */
  errorCode?: string | null;
  /** The last lines the helper wrote to standard error, for a failed check. */
  helperOutput: string[];
  elapsedSeconds: number;
}

/** A model file chosen with "Make a map from a 3D model…". */
export interface ModelChoice {
  path: string;
  name: string;
}

export interface SavedReport {
  path: string;
  name: string;
}

/** One area's floor cuts in the player's file: every cut height (metres) and the floor names, lowest first; how its
 * floors are found, and with automatic passages, the storey shown in each overlapping place the player chose. */
export interface FloorEntry {
  cuts?: number[];
  names?: string[];
  splitAt?: number[];
  mergeAt?: number[];
  method?: FloorMethod;
  passages?: PassageChoice[];
}

/** The player's floor cuts: per game, per area (mAA_BB; `model` for a map made from a 3D model, under its pack
 * id). */
export type FloorOverrides = Record<string, Record<string, FloorEntry>>;

export interface FloorCutsFile {
  name: string;
  areas: number;
  /** After a load: the player's floor cuts with those of the file. */
  overrides: FloorOverrides | null;
}

/** The floor views helper is ready for an area. */
export interface FloorViewsReady {
  area: string;
  profile: HeightProfile;
  automatic: number[];
  shipped: FloorEntry;
  /** The area's cuts without the player's own. */
  shippedCuts: number[];
  /** The heights the panel shows, bottom and top. */
  heights: { low: number; high: number };
  model: AreaModel;
  /** The area seen from the south (`x`) and from the east (`z`). */
  section: { x: Section; z: Section };
  markers: AreaMarker[];
  /** How the area was made. */
  method?: FloorMethod;
  /** Navmesh triangles kept for automatic passages (0: none). */
  navmeshTriangles?: number;
}

/** The area's triangles: each corner's x, height and z as 16-bit steps from `min` to `max`, base64; for a 3D
 * model's preview, each triangle's own colour too (three sRGB bytes, base64). */
export interface AreaModel {
  triangles: number;
  min: [number, number, number];
  max: [number, number, number];
  positions: string;
  colours?: string;
}

/** The whole area from one side, a byte a pixel (see floorviews.py), rows from the top height down. */
export interface Section {
  columns: number;
  rows: number;
  /** What it spans across, in metres: west to east from the south, south to north from the east. */
  from: number;
  to: number;
  pixels: string;
}

/** A marker of the area: where it is (x east, y height, z north) and its type. */
export interface AreaMarker {
  x: number;
  y: number;
  z: number;
  type: string;
  colour: string;
}

export interface ViewedFloor {
  index: number;
  name: string;
  heights: [number, number];
  areaSquareMetres: number;
  markers: number;
  colour: string;
  /** The floor from above, as a `data:` URL. */
  top: string | null;
}

/** The views for some cuts: the floors they give, and where each marker is put. */
export interface FloorViews {
  id: number;
  cuts: number[];
  dropped: number[];
  mainFloor: number;
  profile: HeightProfile;
  floors: ViewedFloor[];
  /** Per marker of `FloorViewsReady.markers`: its floor, and the height of the surface under it (null: none). */
  markers: { floor: number; surface: number | null }[];
  seconds: number;
  method?: FloorMethod;
  /** Automatic passages: the overlapping places. */
  places?: PassagePlace[];
  passages?: Omit<PassagesReport, 'places'>;
  /** Automatic passages: each triangle's floor (a byte each, 255 for walls and slopes), base64. */
  triangleFloors?: string;
  /** Automatic passages: per side view, each pixel's floor (255 for none), base64. */
  sectionFloors?: { x: string; z: string };
}

/** How a picture to compare with lies over an area's map: its middle (`x`, `y`, as fractions of the map picture's
 * width and height), its width as a fraction of the map's (`scale`), its turn in degrees (clockwise), how opaque it
 * is over the map, and the view (over the map, or side by side). */
export interface CompareAlignment {
  picture: string;
  x: number;
  y: number;
  scale: number;
  turn: number;
  opacity: number;
  view: 'overlay' | 'side';
}

/** A picture chosen to compare with: shown only, never put in a map pack. */
export interface ComparePicture {
  name: string;
  path: string;
  /** The picture as a `data:` URL. */
  url: string;
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface Shell {
  appInfo(): Promise<AppInfo>;
  chooseFolder(): Promise<string | null>;
  checkStart(folder: string): Promise<CheckStatus>;
  checkStatus(): Promise<CheckStatus>;
  checkCancel(): Promise<void>;
  makeStart(
    folder: string,
    make3d: boolean,
    mapStyle: MapStyleId,
    floorMethod: FloorMethod | null,
  ): Promise<CheckStatus>;
  remakeStart(area: string, make3d: boolean, mapStyle: MapStyleId): Promise<CheckStatus>;
  /** Asks for a 3D model file (null: the dialog was closed). */
  chooseModel(): Promise<ModelChoice | null>;
  /** Reads the chosen model: what it holds and a preview of its shape. */
  modelInspect(allowLarge: boolean): Promise<Inspected>;
  /** Makes a map pack from the chosen model. */
  modelMakeStart(setup: ModelSetup): Promise<CheckStatus>;
  restoreLastMake(): Promise<CheckStatus>;
  floorOverridesRead(): Promise<FloorOverrides>;
  floorOverridesSet(game: string, area: string, entry: FloorEntry | null): Promise<FloorOverrides>;
  floorOverridesSaveFile(game: string): Promise<FloorCutsFile | null>;
  floorOverridesLoadFile(): Promise<FloorCutsFile | null>;
  floorViewsOpen(area: string): Promise<FloorViewsReady>;
  floorViewsRequest(
    area: string,
    cuts: number[],
    names: string[],
    outlines: boolean,
    method: FloorMethod,
    passages: PassageChoice[],
  ): Promise<FloorViews>;
  floorViewsClose(): Promise<void>;
  /** The pictures to compare with, per `game:mAA_BB`. */
  compareRead(): Promise<Record<string, CompareAlignment>>;
  compareSet(
    key: string,
    alignment: CompareAlignment | null,
  ): Promise<Record<string, CompareAlignment>>;
  comparePickPicture(): Promise<ComparePicture | null>;
  compareOpenPicture(path: string): Promise<ComparePicture>;
  revealPack(): Promise<void>;
  previewImage(file: string): Promise<string>;
  saveReport(suggestedName: string): Promise<SavedReport | null>;
  revealSavedReport(): Promise<void>;
}

export function createShell(invoke: Invoke): Shell {
  return {
    appInfo: () => invoke('app_info') as Promise<AppInfo>,
    chooseFolder: () => invoke('choose_folder') as Promise<string | null>,
    checkStart: (folder) => invoke('check_start', { folder }) as Promise<CheckStatus>,
    checkStatus: () => invoke('check_status') as Promise<CheckStatus>,
    checkCancel: async () => {
      await invoke('check_cancel');
    },
    makeStart: (folder, make3d, mapStyle, floorMethod) =>
      invoke('make_start', { folder, make3d, mapStyle, floorMethod }) as Promise<CheckStatus>,
    remakeStart: (area, make3d, mapStyle) =>
      invoke('remake_start', { area, make3d, mapStyle }) as Promise<CheckStatus>,
    restoreLastMake: () => invoke('restore_last_make') as Promise<CheckStatus>,
    chooseModel: () => invoke('choose_model') as Promise<ModelChoice | null>,
    modelInspect: (allowLarge) => invoke('model_inspect', { allowLarge }) as Promise<Inspected>,
    modelMakeStart: (setup) => invoke('model_make_start', { setup }) as Promise<CheckStatus>,
    floorOverridesRead: () => invoke('floor_overrides_read') as Promise<FloorOverrides>,
    floorOverridesSet: (game, area, entry) =>
      invoke('floor_overrides_set', { game, area, entry }) as Promise<FloorOverrides>,
    floorOverridesSaveFile: (game) =>
      invoke('floor_overrides_save_file', { game }) as Promise<FloorCutsFile | null>,
    floorOverridesLoadFile: () =>
      invoke('floor_overrides_load_file') as Promise<FloorCutsFile | null>,
    floorViewsOpen: (area) => invoke('floor_views_open', { area }) as Promise<FloorViewsReady>,
    floorViewsRequest: (area, cuts, names, outlines, method, passages) =>
      invoke('floor_views_request', {
        area,
        cuts,
        names,
        outlines,
        method,
        passages,
      }) as Promise<FloorViews>,
    floorViewsClose: async () => {
      await invoke('floor_views_close');
    },
    compareRead: () => invoke('compare_read') as Promise<Record<string, CompareAlignment>>,
    compareSet: (key, alignment) =>
      invoke('compare_set', { key, alignment }) as Promise<Record<string, CompareAlignment>>,
    comparePickPicture: () => invoke('compare_pick_picture') as Promise<ComparePicture | null>,
    compareOpenPicture: (path) =>
      invoke('compare_open_picture', { path }) as Promise<ComparePicture>,
    revealPack: async () => {
      await invoke('reveal_pack');
    },
    previewImage: (file) => invoke('preview_image', { file }) as Promise<string>,
    saveReport: (suggestedName) =>
      invoke('save_report', { suggestedName }) as Promise<SavedReport | null>,
    revealSavedReport: async () => {
      await invoke('reveal_saved_report');
    },
  };
}

function findShell(): Shell | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: unknown } })
    .__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== 'function') return null;
  return createShell(internals.invoke.bind(internals) as Invoke);
}

export const shell = findShell();

export function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
