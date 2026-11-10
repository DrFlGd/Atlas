import L from 'leaflet';
import { pixelToSimpleLatLng, simpleLatLngToPixel } from '../../geometry/coords';
import { probeTiles } from '../../pack/tileProbe';
import type {
  FlyToTarget,
  MapLayerSpec,
  MapMarker,
  MapView,
  MapViewOptions,
  MapViewState,
  MarkerHover,
  TileStatus,
  Unsubscribe,
} from '../types';
import { CanvasMarkerLayer } from './canvasMarkerLayer';
import { createTileLayer, imageBounds } from './tileLayer';

const MARKER_PANE = 'atlasMarkers';

/** Probe results per tile source URL, so switching back to a layer does not probe again. */
const probes = new Map<string, Promise<boolean>>();

function tilesAvailable(spec: MapLayerSpec): Promise<boolean> {
  // A known native range comes from a status file written with the tiles.
  if (spec.nativeZoom) return Promise.resolve(true);
  let probe = probes.get(spec.tiles.url);
  if (!probe) {
    probe = probeTiles(spec.tiles, spec.minZoom);
    probes.set(spec.tiles.url, probe);
  }
  return probe;
}

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
  const hoverListeners = new Set<(hover: MarkerHover | null) => void>();
  const tileListeners = new Set<(status: TileStatus) => void>();
  let tileStatus: TileStatus | null = null;
  let destroyed = false;
  const setTileStatus = (status: TileStatus) => {
    tileStatus = status;
    container.classList.toggle('atlas-no-tiles', status.status === 'missing');
    tileListeners.forEach((listener) => {
      listener(status);
    });
  };

  // Side panels opening and closing resize the container without a window
  // resize event, so watch the container itself.
  let resizeFrame = 0;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      map.invalidateSize({ pan: false });
    });
  });
  resizeObserver.observe(container);

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
      if (destroyed) return;
      const sameLayer =
        layer?.id === spec.id &&
        layer.tiles.url === spec.tiles.url &&
        layer.width === spec.width &&
        layer.height === spec.height &&
        layer.minZoom === spec.minZoom &&
        layer.maxZoom === spec.maxZoom &&
        layer.tileSize === spec.tileSize;
      const maxMapZoom = spec.maxZoom + overZoom;
      const showTiles = () => {
        tileLayer?.remove();
        tileLayer = null;
        if (tileStatus?.layerId !== spec.id || tileStatus.status !== 'ready') {
          setTileStatus({ layerId: spec.id, status: 'loading' });
        }
        void tilesAvailable(spec).then((available) => {
          if (layer !== spec) return;
          tileLayer?.remove();
          tileLayer = available ? createTileLayer(spec, maxMapZoom).addTo(map) : null;
          setTileStatus({ layerId: spec.id, status: available ? 'ready' : 'missing' });
        });
      };
      if (sameLayer) {
        // Only the levels on disk changed: swap the tiles, keep the view and markers.
        if (
          layer?.nativeZoom?.min !== spec.nativeZoom?.min ||
          layer?.nativeZoom?.max !== spec.nativeZoom?.max
        ) {
          layer = spec;
          showTiles();
        }
        return;
      }
      tileLayer?.remove();
      markerLayer?.remove();
      layer = spec;
      markers = [];
      selectedId = null;

      const bounds = imageBounds(spec);
      map.setMinZoom(spec.minZoom);
      map.setMaxZoom(maxMapZoom);
      map.setMaxBounds(bounds.pad(0.25));
      map.fitBounds(bounds, { animate: false });

      tileLayer = null;
      showTiles();
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
        onHover: (hover) => {
          hoverListeners.forEach((listener) => {
            listener(hover);
          });
        },
      }).addTo(map);
      emitView();
    },

    setMarkers(next) {
      if (destroyed) return;
      markers = next;
      markerLayer?.setMarkers(markers);
      if (selectedId !== null && !markers.some((m) => m.id === selectedId)) {
        selectedId = null;
        markerLayer?.setSelected(null);
      }
    },

    setSelected(id) {
      if (destroyed) return;
      selectedId = id;
      markerLayer?.setSelected(id);
    },

    refreshStyle() {
      markerLayer?.refreshPalette();
    },

    flyTo(target: FlyToTarget, flyOptions = {}) {
      if (destroyed || !layer) return;
      const center = toLatLng(target.x, target.y);
      const zoom = target.zoom ?? map.getZoom();
      if (flyOptions.animate === false) map.setView(center, zoom, { animate: false });
      else map.flyTo(center, zoom);
    },

    onSelect(listener): Unsubscribe {
      selectListeners.add(listener);
      return () => selectListeners.delete(listener);
    },

    onHover(listener): Unsubscribe {
      hoverListeners.add(listener);
      return () => hoverListeners.delete(listener);
    },

    onTileStatus(listener): Unsubscribe {
      tileListeners.add(listener);
      if (tileStatus) listener(tileStatus);
      return () => tileListeners.delete(listener);
    },

    onViewChange(listener): Unsubscribe {
      viewListeners.add(listener);
      return () => viewListeners.delete(listener);
    },

    getView,

    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(viewFrame);
      cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      selectListeners.clear();
      viewListeners.clear();
      hoverListeners.clear();
      tileListeners.clear();
      container.classList.remove('atlas-no-tiles');
      // Stops a tile probe that is still running from adding a layer to the removed map.
      layer = null;
      map.remove();
    },
  };
}
