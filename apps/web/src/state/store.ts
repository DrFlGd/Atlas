import type {
  ChecklistIndex,
  LoadedPack,
  PackEntry,
  Profile,
  ProgressCounter,
  ProgressRecord,
  ProgressSource,
  SearchIndex,
  TargetProgress,
  UserPreset,
  VisibilityOverrides,
} from '@atlas/core';
import type { MapViewState, MarkerHover, TileStatus } from '@atlas/core/mapview';
import { create } from 'zustand';
import type { LogArea } from '../activityLog';
import type { RuntimeConfig } from '../config';
import type { GameTableState, SaveState } from './saves';
import type {
  DesktopInfo,
  DownloadPlan,
  DownloadSettingsInfo,
  DownloadSnapshot,
  Listing,
} from '../desktop';

export type Theme = 'dark' | 'light';
export type PaneName = 'filters' | 'details';
/** What the left pane shows: the filters, or the checklists and guides. */
export type LeftTab = 'filters' | 'checklists';

/** A page of the checklists and guides screen. */
export type ChecklistPage =
  { kind: 'index' } | { kind: 'checklist'; id: string } | { kind: 'guide'; id: string };

export interface LoadedGame {
  entry: PackEntry;
  pack: LoadedPack;
  counter: ProgressCounter;
  search: SearchIndex;
  checklists: ChecklistIndex;
}

/**
 * One change that `Z` can take back: a location marked found or not, or a
 * checklist item ticked or unticked, which can change several marks at once.
 */
export interface UndoEntry {
  profileId: string;
  /** Each target the change touched, and whether it was found (or done) before. */
  changes: { targetId: string; wasFound: boolean }[];
  /** The notice shown once the change is undone. */
  undone: string;
  /** The location to select once the change is undone, if any. */
  selectId: string | null;
  /** Where the change came from; undoing it writes the same source. Default `manual`. */
  source?: ProgressSource;
}

/** A request for the map to move, consumed by the map pane. */
export interface FlyRequest {
  x: number;
  y: number;
  zoom?: number;
  animate: boolean;
  /** Increments with every request, so the same target can be requested twice. */
  seq: number;
}

export interface Notice {
  text: string;
  tone: 'info' | 'error';
  seq: number;
}

/** Map image downloads of the current pack, in the desktop app. */
export interface DownloadState {
  /** The folder the desktop shell serves the pack from; null when it cannot download it. */
  packFolder: string | null;
  plan: DownloadPlan | null;
  job: DownloadSnapshot | null;
  panelOpen: boolean;
  /** A command is on its way to the shell. */
  pending: boolean;
  /** The last command's error, in plain language. */
  error: string | null;
  /** How downloads are paced, shared by every Atlas app on this computer. */
  settings: DownloadSettingsInfo | null;
}

export interface AtlasState {
  config: RuntimeConfig | null;
  catalog: PackEntry[];
  /** The packs this build comes with (from `config.json` or the pack index). */
  bundledCatalog: PackEntry[];
  /** Boot and pack loading status. */
  status:
    | { kind: 'booting' }
    | { kind: 'loading' }
    | { kind: 'ready' }
    | { kind: 'error'; message: string };
  game: LoadedGame | null;

  mapId: string | null;
  layerId: string | null;
  selectedId: string | null;
  hover: MarkerHover | null;
  view: MapViewState | null;
  tileStatus: TileStatus | null;
  fly: FlyRequest | null;

  overrides: VisibilityOverrides;
  hideFound: boolean;
  userPresets: UserPreset[];

  profiles: Profile[];
  profileId: string | null;
  /** Stored rows of the active profile by target id, tombstones included. */
  rows: ReadonlyMap<string, ProgressRecord>;
  /** Resolved progress of the active profile, by current target id. */
  found: ReadonlyMap<string, TargetProgress>;
  undo: UndoEntry[];

  theme: Theme;
  /** Whether each side pane is open. */
  panes: Record<PaneName, boolean>;
  leftTab: LeftTab;
  /** The checklists screen's pages, the one shown last; the index when empty. */
  checklistPages: ChecklistPage[];
  /** Hide done items on the checklists screen. */
  hideDone: boolean;
  /** A checklist item to bring into view, with a sequence number so it can be asked for again. */
  itemFocus: { itemId: string; seq: number } | null;
  profileDialogOpen: boolean;
  /** Increments when the search box should take focus. */
  searchFocus: number;
  notice: Notice | null;
  /** Whether progress can be saved on this device. */
  persistent: boolean;
  downloads: DownloadState;
  /** Increases when downloaded map images change, so the map looks again. */
  tileRevision: number;

  /** The desktop app's name and version; null in a browser. */
  app: DesktopInfo | null;
  /** Where the desktop app finds packs; null in a browser. */
  library: Listing | null;
  mapsDialogOpen: boolean;
  addMapOpen: boolean;
  /** The activity log dialog, with the area it opened on; null when closed. */
  logViewer: { area: LogArea | 'all' } | null;
  saveDialogOpen: boolean;
  /** The game save linked to the active profile, and what it says. */
  save: SaveState;
}

export const NO_GAME_TABLE: GameTableState = {
  folder: null,
  table: null,
  busy: null,
  error: null,
  last: null,
};

export const NO_SAVE: SaveState = {
  link: null,
  busy: false,
  error: null,
  summary: null,
  match: null,
  folder: null,
  placing: null,
  worldMaps: {},
  calibrations: {},
  points: {},
  gameTable: NO_GAME_TABLE,
};

export const NO_DOWNLOADS: DownloadState = {
  packFolder: null,
  plan: null,
  job: null,
  panelOpen: false,
  pending: false,
  error: null,
  settings: null,
};

export const useAtlas = create<AtlasState>()(() => ({
  config: null,
  catalog: [],
  bundledCatalog: [],
  status: { kind: 'booting' },
  game: null,

  mapId: null,
  layerId: null,
  selectedId: null,
  hover: null,
  view: null,
  tileStatus: null,
  fly: null,

  overrides: {},
  hideFound: false,
  userPresets: [],

  profiles: [],
  profileId: null,
  rows: new Map(),
  found: new Map(),
  undo: [],

  theme: 'dark',
  panes: { filters: true, details: true },
  leftTab: 'filters',
  checklistPages: [],
  hideDone: false,
  itemFocus: null,
  profileDialogOpen: false,
  searchFocus: 0,
  notice: null,
  persistent: true,
  downloads: NO_DOWNLOADS,
  tileRevision: 0,

  app: null,
  library: null,
  mapsDialogOpen: false,
  addMapOpen: false,
  logViewer: null,
  saveDialogOpen: false,
  save: NO_SAVE,
}));
