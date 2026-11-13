import L from 'leaflet';
import { pixelToSimpleLatLng, simpleLatLngToPixel } from '../../geometry/coords';
import { probeTiles } from '../../pack/tileProbe';
import type {
  FlyToTarget,
  MapLayerSpec,
  MapOverlay,
  MapMarker,
  MapView,
  MapViewOptions,
  MapViewState,
  MarkerHover,
  PlayerMarker,
  TileStatus,
  Unsubscribe,
} from '../types';
import { CanvasMarkerLayer } from './canvasMarkerLayer';
import { createTileLayer, firstViewBounds, imageBounds } from './tileLayer';

const MARKER_PANE = 'atlasMarkers';
const PLAYER_PANE = 'atlasPlayer';
const OVERLAY_PANE = 'atlasOverlay';
/** How long a press must last to count as press and hold, in milliseconds. */
const LONG_PRESS_MS = 500;
/** How far a finger may wander during a press and hold, in CSS pixels. */
const LONG_PRESS_TOLERANCE = 10;

/** The player's marker: an arrow pointing up (turned by its heading), or a dot. */
function playerIcon(player: PlayerMarker): L.DivIcon {
  const shape =
    player.heading === null
      ? '<circle cx="16" cy="16" r="7" />'
      : '<path d="M16 3 L25 27 L16 21 L7 27 Z" />';
  const turn = player.heading === null ? '' : ` style="transform: rotate(${player.heading}deg)"`;
  return L.divIcon({
    className: 'atlas-player',
    html: `<svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true"${turn}><circle class="atlas-player-halo" cx="16" cy="16" r="15" />${shape}</svg>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

/** A numbered point of a list's overlay. */
function overlayIcon(point: MapOverlay['points'][number]): L.DivIcon {
  const size = point.style === 'current' ? 40 : point.style === 'pick' ? 28 : 26;
  const text = point.style === 'pick' ? '+' : point.label;
  const label = text.replace(/[^0-9+]/g, '');
  return L.divIcon({
    className: `atlas-step atlas-step-${point.style}`,
    html: `<span aria-hidden="true">${label}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

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
    zoomControl: options.zoomControl ?? true,
  });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  const pane = map.createPane(MARKER_PANE);
  pane.style.zIndex = '450';
  map.createPane(PLAYER_PANE).style.zIndex = '460';
  map.createPane(OVERLAY_PANE).style.zIndex = '455';

  let layer: MapLayerSpec | null = null;
  let tileLayer: L.GridLayer | null = null;
  let markerLayer: CanvasMarkerLayer | null = null;
  let markers: readonly MapMarker[] = [];
  let selectedId: string | null = null;
  const selectListeners = new Set<(id: string | null) => void>();
  const clickListeners = new Set<(point: { x: number; y: number }) => void>();
  const longPressListeners = new Set<(id: string) => void>();
  const markerMenuListeners = new Set<(id: string) => void>();
  /** Until when a click is the end of a press and hold, not a click. */
  let swallowClickUntil = 0;
  let player: PlayerMarker | null = null;
  let playerMarker: L.Marker | null = null;
  let overlay: MapOverlay | null = null;
  let overlayLayer: L.LayerGroup | null = null;
  const viewListeners = new Set<(state: MapViewState) => void>();
  const hoverListeners = new Set<(hover: MarkerHover | null) => void>();
  const tileListeners = new Set<(status: TileStatus) => void>();
  let tileStatus: TileStatus | null = null;
  let destroyed = false;
  // Tile images that failed to load, with the address they asked for, so
  // that `refreshTiles` can ask again once the tile may be there.
  const failedTiles = new Map<HTMLImageElement, string>();
  const watchTiles = (tiles: L.GridLayer): L.GridLayer => {
    failedTiles.clear();
    tiles.on('tileerror', (event: L.TileErrorEvent) => {
      const tile: HTMLElement = event.tile;
      if (tile instanceof HTMLImageElement && tile.src) failedTiles.set(tile, tile.src);
    });
    const forget = (event: L.TileEvent) => {
      failedTiles.delete(event.tile);
    };
    tiles.on('tileload', forget);
    tiles.on('tileunload', forget);
    return tiles;
  };
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
  map.on('click', (event: L.LeafletMouseEvent) => {
    if (!layer || performance.now() <= swallowClickUntil) return;
    const point = toPixel(event.latlng);
    clickListeners.forEach((listener) => {
      listener(point);
    });
  });

  // Press and hold on a marker. One pointer only: a second finger (a
  // pinch), moving, the map moving or zooming, or letting go early cancels
  // it. The click that may follow a press that fired is not a pick.
  let press: { id: number; x: number; y: number; timer: number } | null = null;
  const cancelPress = () => {
    if (press) window.clearTimeout(press.timer);
    press = null;
  };
  const onPointerDown = (event: PointerEvent) => {
    if (press) {
      // Another finger: a pinch, not a press.
      cancelPress();
      return;
    }
    if (longPressListeners.size === 0 || !event.isPrimary || event.button > 0) return;
    const rect = container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const timer = window.setTimeout(() => {
      press = null;
      const hit = markerLayer?.hitTest(L.point(x, y));
      if (hit?.kind !== 'point') return;
      swallowClickUntil = performance.now() + 800;
      longPressListeners.forEach((listener) => {
        listener(hit.point.id);
      });
    }, LONG_PRESS_MS);
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, timer };
  };
  const onPointerMove = (event: PointerEvent) => {
    if (press?.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_TOLERANCE) {
      cancelPress();
    }
  };
  const onContextMenu = (event: MouseEvent) => {
    // A held finger opens no menu over the map while presses are wanted.
    if (longPressListeners.size > 0) event.preventDefault();
    // A right click on a marker, where someone listens: theirs, not the page's menu.
    if (markerMenuListeners.size === 0 || !layer) return;
    const rect = container.getBoundingClientRect();
    const hit = markerLayer?.hitTest(L.point(event.clientX - rect.left, event.clientY - rect.top));
    if (!hit) return;
    event.preventDefault();
    if (hit.kind !== 'point') return;
    markerMenuListeners.forEach((listener) => {
      listener(hit.point.id);
    });
  };
  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', cancelPress);
  container.addEventListener('pointercancel', cancelPress);
  container.addEventListener('contextmenu', onContextMenu);
  map.on('zoomstart', cancelPress);
  const swallowClick = () => {
    if (performance.now() > swallowClickUntil) return false;
    swallowClickUntil = 0;
    return true;
  };

  const showPlayer = () => {
    playerMarker?.remove();
    playerMarker = null;
    if (!player || !layer) return;
    playerMarker = L.marker(toLatLng(player.x, player.y), {
      icon: playerIcon(player),
      pane: PLAYER_PANE,
      interactive: false,
      keyboard: false,
      title: player.label,
      alt: player.label,
    }).addTo(map);
    const element = playerMarker.getElement();
    element?.setAttribute('role', 'img');
    element?.setAttribute('aria-label', player.label);
  };

  const showOverlay = () => {
    overlayLayer?.remove();
    overlayLayer = null;
    if (!overlay || !layer || overlay.points.length === 0) return;
    const group = L.layerGroup();
    const steps = overlay.points.filter((point) => point.style !== 'pick');
    if (overlay.joined && steps.length > 1) {
      L.polyline(
        steps.map((point) => toLatLng(point.x, point.y)),
        {
          pane: OVERLAY_PANE,
          interactive: false,
          className: 'atlas-step-line',
          weight: 3,
          dashArray: '2 7',
          lineCap: 'round',
        },
      ).addTo(group);
    }
    // The open step last, so it is drawn on top.
    const ordered = [
      ...overlay.points.filter((point) => point.style !== 'current'),
      ...overlay.points.filter((point) => point.style === 'current'),
    ];
    for (const point of ordered) {
      L.marker(toLatLng(point.x, point.y), {
        icon: overlayIcon(point),
        pane: OVERLAY_PANE,
        interactive: false,
        keyboard: false,
      }).addTo(group);
    }
    overlayLayer = group.addTo(map);
  };

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
          tileLayer = available ? watchTiles(createTileLayer(spec, maxMapZoom)).addTo(map) : null;
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
      // The player belongs to one map; the app shows it again on its map.
      player = null;
      playerMarker?.remove();
      playerMarker = null;
      // So does an overlay.
      overlay = null;
      overlayLayer?.remove();
      overlayLayer = null;

      const bounds = imageBounds(spec);
      map.setMinZoom(spec.minZoom);
      map.setMaxZoom(maxMapZoom);
      map.setMaxBounds(bounds.pad(0.25));
      map.fitBounds(firstViewBounds(spec), { animate: false });

      tileLayer = null;
      showTiles();
      markerLayer = new CanvasMarkerLayer({
        pane: MARKER_PANE,
        maxZoom: spec.maxZoom,
        tileSize: spec.tileSize,
        clustering,
        ...(options.hitSlop === undefined ? {} : { hitSlop: options.hitSlop }),
        onPick: (hit) => {
          if (swallowClick()) return;
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

    setPlayer(next) {
      if (destroyed) return;
      const same =
        next !== null &&
        player !== null &&
        next.x === player.x &&
        next.y === player.y &&
        next.heading === player.heading &&
        next.label === player.label;
      if (same || (next === null && player === null)) return;
      player = next;
      showPlayer();
    },

    setOverlay(next) {
      if (destroyed || (next === null && overlay === null)) return;
      overlay = next;
      showOverlay();
    },

    setSelected(id) {
      if (destroyed) return;
      selectedId = id;
      markerLayer?.setSelected(id);
    },

    refreshStyle() {
      markerLayer?.refreshPalette();
    },

    refreshTiles() {
      if (destroyed) return;
      // Layers that had no tiles are looked at again when next shown.
      probes.clear();
      if (!layer) return;
      const spec = layer;
      if (!tileLayer) {
        // The layer had no tiles when it was shown: look again.
        void tilesAvailable(spec).then((available) => {
          if (destroyed || layer !== spec || tileLayer || !available) return;
          tileLayer = watchTiles(createTileLayer(spec, spec.maxZoom + overZoom)).addTo(map);
          setTileStatus({ layerId: spec.id, status: 'ready' });
        });
        return;
      }
      // Ask again for the tiles that were not there; the others stay as they are.
      for (const [tile, url] of [...failedTiles]) {
        failedTiles.delete(tile);
        if (!tile.isConnected) continue;
        tile.removeAttribute('src');
        tile.src = url;
      }
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

    onLongPress(listener): Unsubscribe {
      longPressListeners.add(listener);
      return () => longPressListeners.delete(listener);
    },

    onMarkerMenu(listener): Unsubscribe {
      markerMenuListeners.add(listener);
      return () => markerMenuListeners.delete(listener);
    },

    onMapClick(listener): Unsubscribe {
      clickListeners.add(listener);
      return () => clickListeners.delete(listener);
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
      cancelPress();
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', cancelPress);
      container.removeEventListener('pointercancel', cancelPress);
      container.removeEventListener('contextmenu', onContextMenu);
      selectListeners.clear();
      clickListeners.clear();
      longPressListeners.clear();
      markerMenuListeners.clear();
      viewListeners.clear();
      hoverListeners.clear();
      tileListeners.clear();
      failedTiles.clear();
      container.classList.remove('atlas-no-tiles');
      // Stops a tile probe that is still running from adding a layer to the removed map.
      layer = null;
      map.remove();
    },
  };
}
