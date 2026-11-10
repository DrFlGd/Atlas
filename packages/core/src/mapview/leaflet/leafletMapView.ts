import L from 'leaflet';
import { pixelToSimpleLatLng, simpleLatLngToPixel } from '../../geometry/coords';
import type {
  FlyToTarget,
  MapLayerSpec,
  MapMarker,
  MapView,
  MapViewOptions,
  MapViewState,
  Unsubscribe,
} from '../types';
import { CanvasMarkerLayer } from './canvasMarkerLayer';
import { createTileLayer, imageBounds } from './tileLayer';

const MARKER_PANE = 'atlasMarkers';

/** A {@link MapView} drawn with Leaflet under `CRS.Simple`. */
export function createLeafletMapView(
  container: HTMLElement,
  options: MapViewOptions = {},
): MapView {
  const clustering = options.clustering ?? true;
  const overZoom = options.overZoom ?? 2;

  const map = L.map(container, {
    crs: L.CRS.Simple,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 100,
    maxBoundsViscosity: 0.9,
    attributionControl: true,
    zoomControl: true,
  });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  const pane = map.createPane(MARKER_PANE);
  pane.style.zIndex = '450';

  let layer: MapLayerSpec | null = null;
  let tileLayer: L.GridLayer | null = null;
  let markerLayer: CanvasMarkerLayer | null = null;
  let markers: readonly MapMarker[] = [];
  let selectedId: string | null = null;
  const selectListeners = new Set<(id: string | null) => void>();
  const viewListeners = new Set<(state: MapViewState) => void>();

  const toLatLng = (x: number, y: number) =>
    L.latLng(pixelToSimpleLatLng({ x, y }, layer?.maxZoom ?? 0));
  const toPixel = (latLng: L.LatLng) =>
    simpleLatLngToPixel(latLng.lat, latLng.lng, layer?.maxZoom ?? 0);

  const getView = (): MapViewState | null => {
    if (!layer) return null;
    const bounds = map.getBounds();
    const topLeft = toPixel(bounds.getNorthWest());
    const bottomRight = toPixel(bounds.getSouthEast());
    return {
      zoom: map.getZoom(),
      center: toPixel(map.getCenter()),
      bounds: { minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y },
    };
  };

  let viewFrame = 0;
  const emitView = () => {
    if (viewFrame) return;
    viewFrame = requestAnimationFrame(() => {
      viewFrame = 0;
      const state = getView();
      if (state)
        viewListeners.forEach((listener) => {
          listener(state);
        });
    });
  };
  map.on('move zoom resize', emitView);

  const select = (id: string | null) => {
    selectedId = id;
    markerLayer?.setSelected(id);
    selectListeners.forEach((listener) => {
      listener(id);
    });
  };

  return {
    setLayer(spec) {
      if (
        layer?.id === spec.id &&
        layer.tiles.url === spec.tiles.url &&
        layer.width === spec.width &&
        layer.height === spec.height
      ) {
        return;
      }
      tileLayer?.remove();
      markerLayer?.remove();
      layer = spec;
      markers = [];
      selectedId = null;

      const bounds = imageBounds(spec);
      const maxMapZoom = spec.maxZoom + overZoom;
      map.setMinZoom(spec.minZoom);
      map.setMaxZoom(maxMapZoom);
      map.setMaxBounds(bounds.pad(0.25));
      map.fitBounds(bounds, { animate: false });

      tileLayer = createTileLayer(spec, maxMapZoom).addTo(map);
      markerLayer = new CanvasMarkerLayer({
        pane: MARKER_PANE,
        maxZoom: spec.maxZoom,
        tileSize: spec.tileSize,
        clustering,
        onPick: (hit) => {
          if (!hit) {
            if (selectedId !== null) select(null);
          } else if (hit.kind === 'point') {
            select(hit.point.id);
          } else if (markerLayer) {
            const zoom = Math.min(markerLayer.expansionZoom(hit.clusterId), map.getMaxZoom());
            map.flyTo(toLatLng(hit.x, hit.y), Math.max(zoom, map.getZoom() + 1));
          }
        },
      }).addTo(map);
      emitView();
    },

    setMarkers(next) {
      markers = next;
      markerLayer?.setMarkers(markers);
      if (selectedId !== null && !markers.some((m) => m.id === selectedId)) {
        selectedId = null;
        markerLayer?.setSelected(null);
      }
    },

    setSelected(id) {
      selectedId = id;
      markerLayer?.setSelected(id);
    },

    flyTo(target: FlyToTarget, flyOptions = {}) {
      if (!layer) return;
      const center = toLatLng(target.x, target.y);
      const zoom = target.zoom ?? map.getZoom();
      if (flyOptions.animate === false) map.setView(center, zoom, { animate: false });
      else map.flyTo(center, zoom);
    },

    onSelect(listener): Unsubscribe {
      selectListeners.add(listener);
      return () => selectListeners.delete(listener);
    },

    onViewChange(listener): Unsubscribe {
      viewListeners.add(listener);
      return () => viewListeners.delete(listener);
    },

    getView,

    destroy() {
      cancelAnimationFrame(viewFrame);
      selectListeners.clear();
      viewListeners.clear();
      map.remove();
    },
  };
}
