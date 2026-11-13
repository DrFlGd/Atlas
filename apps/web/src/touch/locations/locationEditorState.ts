import { isOwnId } from '@atlas/schema';
import { create } from 'zustand';
import { notify } from '../../state/actions';
import {
  canChangeOwnLocations,
  changeOwn,
  deleteOwn,
  dropOwnLocation,
  flushOwnLocations,
  ownLocationById,
  undoOwnChange,
  useOwnLocations,
} from '../../state/ownLocations';
import { useAtlas } from '../../state/store';
import { stopEditing, useEditor } from '../editor/editorState';

/**
 * "Edit locations": a mode of the standard layout, entered on purpose and
 * left with Done, in which a click on the map puts a new location of the
 * person's own there, and one of theirs is changed, moved or deleted in the
 * panel beside the map. Locations that come with the game are not changed
 * here. Every change is kept at once, saved a moment later, and can be
 * undone.
 */

/** What the panel beside the map shows. */
export type EditorSidePanel =
  /** One of the person's own locations. */
  | { kind: 'location'; id: string }
  /** A location that came with the game: it is not changed here. */
  | { kind: 'game-location'; id: string }
  /** A type: a new one (`id` null) or one of the person's own; `forLocation` gets it when saved. */
  | { kind: 'type'; id: string | null; forLocation: string | null }
  /** An area of the map shown: a new one or one of the person's own. */
  | { kind: 'area'; id: string | null; forLocation: string | null };

export interface LocationEditorState {
  active: boolean;
  side: EditorSidePanel | null;
  /** The location the next click on the map moves, or null. */
  moving: string | null;
  /** Bumped when the name of a new location should take the focus. */
  focusName: number;
}

const INITIAL: LocationEditorState = { active: false, side: null, moving: null, focusName: 0 };

export const useLocationEditor = create<LocationEditorState>()(() => INITIAL);

const get = useLocationEditor.getState;
const set = useLocationEditor.setState;

/** Enters Edit locations. */
export function startLocationEditing(): void {
  if (!canChangeOwnLocations()) return;
  stopEditing();
  useAtlas.setState({ selectedId: null });
  set({ ...INITIAL, active: true });
}

/** Leaves Edit locations, saving at once. */
export function stopLocationEditing(): void {
  if (!get().active) return;
  set(INITIAL);
  useAtlas.setState({ selectedId: null });
  void flushOwnLocations();
}

export function openSide(side: EditorSidePanel | null): void {
  set({ side, moving: null });
  if (side?.kind === 'location' || side?.kind === 'game-location') {
    useAtlas.setState({ selectedId: side.id });
  } else if (side === null) {
    useAtlas.setState({ selectedId: null });
  }
}

export function setMoving(id: string | null): void {
  set({ moving: id });
}

/** A marker was clicked while editing. */
export function pickedOnMap(id: string): void {
  openSide(
    isOwnId(id) && ownLocationById(id) ? { kind: 'location', id } : { kind: 'game-location', id },
  );
}

/** The map was clicked off the markers while editing: a new location, or the one being moved goes there. */
export function clickedOnMap(point: { x: number; y: number }): void {
  const { mapId, layerId } = useAtlas.getState();
  if (!mapId || !layerId) return;
  const { moving } = get();
  if (moving) {
    changeOwn(moving, { x: Math.round(point.x), y: Math.round(point.y) }, 'Location moved');
    set({ moving: null });
    return;
  }
  const location = dropOwnLocation(mapId, layerId, point.x, point.y);
  if (!location) return;
  openSide({ kind: 'location', id: location.id });
  set({ focusName: get().focusName + 1 });
}

/** Deletes one of the person's own locations, with Undo on the notice. */
export function deleteOwnLocationNow(id: string): void {
  const location = deleteOwn(id);
  if (!location) return;
  openSide(null);
  notify(`Deleted “${location.name}”.`, 'info', {
    action: {
      label: 'Undo',
      run: () => {
        undoLocationChange();
      },
    },
  });
}

/** Takes the last change back, and says what it was. */
export function undoLocationChange(): void {
  const label = undoOwnChange();
  if (!label) return;
  // What was open may have gone, or come back.
  const { side } = get();
  if (side?.kind === 'location' && !ownLocationById(side.id)) openSide(null);
  notify(`Undone: ${label.charAt(0).toLowerCase()}${label.slice(1)}.`);
}

// Another game, or own locations that can no longer be changed, end the mode.
useAtlas.subscribe((state, previous) => {
  if (get().active && state.game?.entry !== previous.game?.entry) stopLocationEditing();
});
// Editing a list ends it too.
useEditor.subscribe((state, previous) => {
  if (get().active && state.listId !== null && previous.listId === null) stopLocationEditing();
});
useOwnLocations.subscribe((state) => {
  if (get().active && !canChangeOwnLocations(state)) stopLocationEditing();
});
