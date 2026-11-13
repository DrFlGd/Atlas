import type { OverlayPoint } from '@atlas/core/mapview';
import { create } from 'zustand';

/**
 * What the list editor asks of the map (see `touch/editor/`): the points of
 * the list being edited, numbered, on every layer; and what a tap on a
 * marker does while it is open, in place of selecting the location.
 */
export interface MapOverlayState {
  /** The list's points, each on its layer; null when nothing is drawn. */
  points: readonly (OverlayPoint & { layerId: string })[] | null;
  /** The steps are joined in order by a line. */
  joined: boolean;
  /** Called with the location tapped, in place of selecting it; null selects as usual. */
  pick: ((locationId: string) => void) | null;
}

export const useMapOverlay = create<MapOverlayState>()(() => ({
  points: null,
  joined: false,
  pick: null,
}));
