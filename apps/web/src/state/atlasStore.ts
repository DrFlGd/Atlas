import type { LoadedPack } from '@atlas/core';
import type { MapViewState } from '@atlas/core/mapview';
import { create } from 'zustand';

export type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; pack: LoadedPack; layerId: string };

export interface AtlasState {
  load: LoadState;
  /** The map's current view, updated as the user pans and zooms. */
  view: MapViewState | null;
  selectedId: string | null;
  setLoaded: (pack: LoadedPack, layerId: string) => void;
  setError: (message: string) => void;
  setView: (view: MapViewState) => void;
  select: (locationId: string | null) => void;
}

/** View state shared by the map and the panels around it. */
export const useAtlasStore = create<AtlasState>()((set) => ({
  load: { status: 'loading' },
  view: null,
  selectedId: null,
  setLoaded: (pack, layerId) => {
    set({ load: { status: 'ready', pack, layerId }, selectedId: null });
  },
  setError: (message) => {
    set({ load: { status: 'error', message } });
  },
  setView: (view) => {
    set({ view });
  },
  select: (selectedId) => {
    set({ selectedId });
  },
}));
