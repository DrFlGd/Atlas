import type {
  LoadedPack,
  PackEntry,
  Profile,
  ProgressCounter,
  ProgressRecord,
  SearchIndex,
  TargetProgress,
  UserPreset,
  VisibilityOverrides,
} from '@atlas/core';
import type { MapViewState, MarkerHover, TileStatus } from '@atlas/core/mapview';
import { create } from 'zustand';
import type { RuntimeConfig } from '../config';
import type { DownloadPlan, DownloadSnapshot } from '../desktop';

export type Theme = 'dark' | 'light';
export type PaneName = 'filters' | 'details';

export interface LoadedGame {
  entry: PackEntry;
  pack: LoadedPack;
  counter: ProgressCounter;
  search: SearchIndex;
}

/** One found/not-found change that `Z` can take back. */
export interface UndoEntry {
  profileId: string;
  targetId: string;
  /** Whether the target was found before the change. */
  wasFound: boolean;
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
}

export interface AtlasState {
  config: RuntimeConfig | null;
  catalog: PackEntry[];
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
  profileDialogOpen: boolean;
  /** Increments when the search box should take focus. */
  searchFocus: number;
  notice: Notice | null;
  /** Whether progress can be saved on this device. */
  persistent: boolean;
  downloads: DownloadState;
  /** Increases when downloaded map images change, so the map looks again. */
  tileRevision: number;
}

export const NO_DOWNLOADS: DownloadState = {
  packFolder: null,
  plan: null,
  job: null,
  panelOpen: false,
  pending: false,
  error: null,
};

export const useAtlas = create<AtlasState>()(() => ({
  config: null,
  catalog: [],
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
  profileDialogOpen: false,
  searchFocus: 0,
  notice: null,
  persistent: true,
  downloads: NO_DOWNLOADS,
  tileRevision: 0,
}));
