import { isOwnId } from '@atlas/schema';
import { create } from 'zustand';
import { notify } from '../../state/actions';
import { cancelEntry, linkNewLocation, useMapEntries } from '../../state/mapEntries';
import {
  canChangeOwnLocations,
  changeOwn,
  deleteOwn,
  dropOwnLocation,
  flushOwnLocations,
  newLocationAsksType,
  newLocationType,
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

/** A new location not made yet, while the person chooses its type. */
export interface NewLocationDraft {
  mapId: string;
  layerId: string;
  x: number;
  y: number;
  name: string;
  /** The type chosen; null shows "Choose a type", and the location cannot be added yet. */
  typeId: string | null;
}

/** What the panel beside the map shows. */
export type EditorSidePanel =
  /** One of the person's own locations. */
  | { kind: 'location'; id: string }
  /** A new location whose type is to be chosen before it is added. */
  | { kind: 'new-location'; draft: NewLocationDraft }
  /** A location that came with the game: it is not changed here. */
  | { kind: 'game-location'; id: string }
  /**
   * A type: a new one (`id` null) or one of the person's own; `forLocation`
   * gets it when saved, or the new location `draft` does.
   */
  | { kind: 'type'; id: string | null; forLocation: string | null; draft?: NewLocationDraft }
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
  cancelEntry();
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
  const { moving, side } = get();
  if (moving) {
    changeOwn(moving, { x: Math.round(point.x), y: Math.round(point.y) }, 'Location moved');
    set({ moving: null });
    return;
  }
  const at = { mapId, layerId, x: Math.round(point.x), y: Math.round(point.y) };
  // A new location waiting for its type goes where the map was pressed now.
  if (side?.kind === 'new-location') {
    set({ side: { kind: 'new-location', draft: { ...side.draft, ...at } } });
    return;
  }
  // An entry of a wiki page put on the map: named after it, its type chosen (the last one first).
  const entry = useMapEntries.getState().pending;
  if (entry) {
    openSide({
      kind: 'new-location',
      draft: { ...at, name: entry.name.slice(0, 200), typeId: newLocationType() },
    });
    return;
  }
  // No type chosen for a new location of this game yet: the person chooses one first.
  if (newLocationAsksType()) {
    openSide({ kind: 'new-location', draft: { ...at, name: 'New location', typeId: null } });
    set({ focusName: get().focusName + 1 });
    return;
  }
  const location = dropOwnLocation(mapId, layerId, point.x, point.y);
  if (!location) return;
  openSide({ kind: 'location', id: location.id });
  set({ focusName: get().focusName + 1 });
}

/** Adds the new location once its type is chosen, and shows it. */
export function addDraftLocation(draft: NewLocationDraft): boolean {
  if (draft.typeId === null) return false;
  const location = dropOwnLocation(
    draft.mapId,
    draft.layerId,
    draft.x,
    draft.y,
    draft.name.trim() || 'New location',
    draft.typeId,
  );
  if (!location) return false;
  // An entry of a wiki page waited for it: the location is linked to its page.
  if (useMapEntries.getState().pending) linkNewLocation(location.id);
  openSide({ kind: 'location', id: location.id });
  return true;
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
