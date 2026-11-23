/**
 * The commands of the Map Maker's desktop shell (`src-tauri`). Like the Atlas viewer, the page has no dependency on
 * Tauri: inside the shell, Tauri injects an `invoke` function. In a plain browser `shell` is null.
 */
import type { AnyReport, HeightProfile } from './report';

export interface AppInfo {
  version: string;
  helperFound: boolean;
  /** The 3D builder (atlas-scene) that comes with the Map Maker is there. */
  sceneBuilderFound: boolean;
  /** "Also make 3D maps", as last chosen (on by default). */
  make3d: boolean;
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

export interface SavedReport {
  path: string;
  name: string;
}

/** One area's floor cuts in the player's file: every cut height (metres) and the floor names, lowest first. */
export interface FloorEntry {
  cuts?: number[];
  names?: string[];
  splitAt?: number[];
  mergeAt?: number[];
}

/** The player's floor cuts: per game, per area (mAA_BB). */
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
}

export interface SideView {
  /** A `data:` URL, or null without walkable floor. */
  image: string | null;
  /** Its heights, bottom and top, and what it spans across (metres). */
  low: number;
  high: number;
  from: number;
  to: number;
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

/** The views for some cuts: the floors they give, and the side views. */
export interface FloorViews {
  id: number;
  cuts: number[];
  dropped: number[];
  mainFloor: number;
  profile: HeightProfile;
  floors: ViewedFloor[];
  side: { x: SideView; z: SideView };
  seconds: number;
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface Shell {
  appInfo(): Promise<AppInfo>;
  chooseFolder(): Promise<string | null>;
  checkStart(folder: string): Promise<CheckStatus>;
  checkStatus(): Promise<CheckStatus>;
  checkCancel(): Promise<void>;
  makeStart(folder: string, make3d: boolean): Promise<CheckStatus>;
  remakeStart(area: string, make3d: boolean): Promise<CheckStatus>;
  restoreLastMake(): Promise<CheckStatus>;
  floorOverridesRead(): Promise<FloorOverrides>;
  floorOverridesSet(game: string, area: string, entry: FloorEntry | null): Promise<FloorOverrides>;
  floorOverridesSaveFile(game: string): Promise<FloorCutsFile | null>;
  floorOverridesLoadFile(): Promise<FloorCutsFile | null>;
  floorViewsOpen(area: string): Promise<FloorViewsReady>;
  floorViewsRequest(area: string, cuts: number[], names: string[]): Promise<FloorViews>;
  floorViewsClose(): Promise<void>;
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
    makeStart: (folder, make3d) => invoke('make_start', { folder, make3d }) as Promise<CheckStatus>,
    remakeStart: (area, make3d) => invoke('remake_start', { area, make3d }) as Promise<CheckStatus>,
    restoreLastMake: () => invoke('restore_last_make') as Promise<CheckStatus>,
    floorOverridesRead: () => invoke('floor_overrides_read') as Promise<FloorOverrides>,
    floorOverridesSet: (game, area, entry) =>
      invoke('floor_overrides_set', { game, area, entry }) as Promise<FloorOverrides>,
    floorOverridesSaveFile: (game) =>
      invoke('floor_overrides_save_file', { game }) as Promise<FloorCutsFile | null>,
    floorOverridesLoadFile: () =>
      invoke('floor_overrides_load_file') as Promise<FloorCutsFile | null>,
    floorViewsOpen: (area) => invoke('floor_views_open', { area }) as Promise<FloorViewsReady>,
    floorViewsRequest: (area, cuts, names) =>
      invoke('floor_views_request', { area, cuts, names }) as Promise<FloorViews>,
    floorViewsClose: async () => {
      await invoke('floor_views_close');
    },
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
