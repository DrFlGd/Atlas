import type { LoadedPack, SceneFrame } from '@atlas/core';
import { floorsOf, type MapDef } from '@atlas/schema';
import { useEffect, useMemo } from 'react';
import { notify } from '../state/actions';
import { changeOwn, useOwnLocations } from '../state/ownLocations';
import { useAtlas } from '../state/store';
import {
  clickedOnMap,
  openSide,
  pickedOnMap,
  useLocationEditor,
} from '../touch/locations/locationEditorState';
import type { SceneEngine } from './engine';
import { placementAt, type Placement, type ViewPoint } from './placing';

/**
 * Edit locations in the 3D view (see `locationEditorState.ts` and
 * `placing.ts`): a press on the model puts a new location where the
 * surface was pressed, or the location being moved goes there; a press on
 * a dot opens it, as on the 2D map; the person's own dots are dragged over
 * the model; and the controller's A does the same at the crosshair. Every
 * change goes through the 2D editor's own, so it is saved and undone the
 * same way.
 */

/** What a point of the model needs to become a location of a map. */
export interface SceneWhere {
  frame: SceneFrame;
  map: Pick<MapDef, 'id' | 'width' | 'height'>;
  pack: LoadedPack;
}

/** Whether Edit locations is on now. */
export function editingNow(): boolean {
  return useLocationEditor.getState().active;
}

/** A dot pressed: in Edit locations it is opened there. Whether Edit locations took it. */
export function editingPick(id: string | null): boolean {
  if (!editingNow()) return false;
  if (id) pickedOnMap(id);
  return true;
}

/** Where a point of the model puts a location of the map, or null (and why, said). */
function placementOf(point: ViewPoint | null, where: SceneWhere): Placement | null {
  if (!point) {
    notify('There is nothing to put a location on there. A part cut away cannot be used.');
    return null;
  }
  const { layerId } = useAtlas.getState();
  const layers = where.pack.layersOf(where.map.id);
  const shown = layers.some((layer) => layer.id === layerId) ? layerId : layers[0]?.id;
  if (!shown) return null;
  const placement = placementAt(
    where.frame,
    point,
    where.map,
    floorsOf(layers, where.map.id),
    shown,
  );
  if (!placement) notify('That is off the map. Press the model inside it.');
  return placement;
}

/** The model was pressed in Edit locations (or A at the crosshair): a new location, or one moved there. */
export function placeOnSurface(point: ViewPoint | null, where: SceneWhere): void {
  if (!editingNow()) return;
  const placement = placementOf(point, where);
  if (!placement) return;
  clickedOnMap(placement, placement);
}

/** One of the person's own dots was dragged to a point of the model. */
export function dropOnSurface(id: string, point: ViewPoint | null, where: SceneWhere): void {
  if (!editingNow()) return;
  const placement = placementOf(point, where);
  if (!placement) return;
  const { x, y, height, layerId } = placement;
  changeOwn(id, { x, y, height, layerId }, 'Location moved');
  openSide({ kind: 'location', id });
}

/** Tells the view whether Edit locations is on, and which of its dots are the person's own, to drag. */
export function useSceneEditing(engine: SceneEngine | null, mapId: string | null): void {
  const active = useLocationEditor((s) => s.active);
  const own = useOwnLocations((s) => s.own.locations);
  const ids = useMemo(
    () =>
      active
        ? new Set(own.filter((location) => location.mapId === mapId).map((location) => location.id))
        : null,
    [active, own, mapId],
  );
  useEffect(() => {
    engine?.setEditing(ids);
  }, [engine, ids]);
}
