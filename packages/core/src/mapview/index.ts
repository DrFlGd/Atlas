/**
 * The map view module. It is the only part of Atlas that knows which map
 * library draws the map; everything else talks to the {@link MapView}
 * interface in image-pixel coordinates.
 */

import 'leaflet/dist/leaflet.css';
import './mapview.css';
import { createLeafletMapView } from './leaflet/leafletMapView';
import type { MapView, MapViewOptions } from './types';

export type * from './types';

/** Creates a map view filling `container`. Call `destroy()` before removing the container. */
export function createMapView(container: HTMLElement, options: MapViewOptions = {}): MapView {
  container.classList.add('atlas-map');
  return createLeafletMapView(container, options);
}
