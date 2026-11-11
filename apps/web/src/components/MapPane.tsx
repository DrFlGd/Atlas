import { isDownloadable, layerViewSpec, nativeZoomOf, readTileStatus } from '@atlas/core';
import { createMapView, type MapView } from '@atlas/core/mapview';
import { useEffect, useRef, useState } from 'react';
import { downloadsOffered } from '../features';
import { select, showMap } from '../state/actions';
import { numberFormat, useLayerMarkers, useSummary } from '../state/derived';
import { setDownloadPanelOpen } from '../state/downloads';
import { useAtlas } from '../state/store';
import { DownloadPanel, MapImagesButton } from './DownloadPanel';
import { downloadPercent } from './downloadFormat';
import { UiIcon } from './icons';

/** Hosts the map view and keeps it in sync with the store. */
export function MapPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapView | null>(null);
  const game = useAtlas((s) => s.game);
  const layerId = useAtlas((s) => s.layerId);
  const selectedId = useAtlas((s) => s.selectedId);
  const fly = useAtlas((s) => s.fly);
  const clustering = useAtlas((s) => s.config?.clustering ?? true);
  const theme = useAtlas((s) => s.theme);
  const markers = useLayerMarkers();
  const pack = game?.pack;

  // One map view for the life of the pane; packs and layers are swapped into it.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const view = createMapView(container, { clustering });
    const unsubscribe = [
      view.onViewChange((state) => {
        useAtlas.setState({ view: state });
      }),
      view.onSelect((id) => {
        select(id);
      }),
      view.onHover((hover) => {
        useAtlas.setState({ hover });
      }),
      view.onTileStatus((tileStatus) => {
        useAtlas.setState({ tileStatus });
      }),
    ];
    setMap(view);
    return () => {
      unsubscribe.forEach((off) => {
        off();
      });
      view.destroy();
      setMap(null);
      useAtlas.setState({ hover: null, view: null });
    };
  }, [clustering]);

  // Theme colours live in CSS variables, which the marker canvas reads when drawing sprites.
  useEffect(() => {
    map?.refreshStyle();
  }, [map, theme]);

  // The layer. Switching between layers of one map keeps the view. For a
  // layer whose map images the desktop app downloads, the status file says
  // which levels are there; it is read again when a download adds levels.
  const shownLayer = useRef<{ view: MapView; layerId: string; mapId: string } | null>(null);
  const [shownLayerId, setShownLayerId] = useState<string | null>(null);
  const tileRevision = useAtlas((s) => s.tileRevision);
  const shownRevision = useRef(tileRevision);
  const offlineTiles = useAtlas((s) => s.downloads.packFolder !== null);
  useEffect(() => {
    if (!map || !pack || !layerId) return;
    const layer = pack.layers.get(layerId);
    if (!layer) return;
    let current = true;
    // Map images were added on disk since the layer was last looked at.
    const imagesAdded = shownRevision.current !== tileRevision;
    shownRevision.current = tileRevision;
    const show = (nativeZoom: { min: number; max: number } | null) => {
      if (!current) return;
      const previous = shownLayer.current?.view === map ? shownLayer.current : null;
      const previousView = map.getView();
      map.setLayer({ ...layerViewSpec(pack, layer), ...(nativeZoom ? { nativeZoom } : {}) });
      // The same layer with the same levels changes nothing above; single
      // images may still be new (saved while browsing a map page), so look
      // for the ones that were missing.
      if (imagesAdded && previous?.layerId === layer.id) map.refreshTiles();
      if (previous?.mapId === layer.mapId && previous.layerId !== layer.id && previousView) {
        map.flyTo({ ...previousView.center, zoom: previousView.zoom }, { animate: false });
      }
      shownLayer.current = { view: map, layerId: layer.id, mapId: layer.mapId };
      setShownLayerId(layer.id);
    };
    if (offlineTiles && isDownloadable(layer)) {
      void readTileStatus(pack, layer).then((status) => {
        show(nativeZoomOf(layer, status));
      });
    } else {
      show(null);
    }
    return () => {
      current = false;
    };
  }, [map, pack, layerId, offlineTiles, tileRevision]);
  const layerShown = map !== null && shownLayerId === layerId;

  // Markers, selection and fly requests wait until the layer is shown, since
  // showing a new layer clears its markers and fits the view.
  useEffect(() => {
    if (layerShown) map.setMarkers(markers);
  }, [map, markers, layerShown]);

  useEffect(() => {
    if (layerShown) map.setSelected(selectedId);
  }, [map, selectedId, markers, layerShown]);

  // Fly requests run after the layer is set, so a jump to another layer lands on the right map.
  const handledFly = useRef(0);
  useEffect(() => {
    if (!layerShown || !fly || fly.seq === handledFly.current) return;
    handledFly.current = fly.seq;
    map.flyTo(fly, { animate: fly.animate });
  }, [map, fly, layerShown]);

  return (
    <div className="map-area">
      <div ref={containerRef} className="map-pane" data-testid="map" />
      <LayerSwitcher />
      <MarkerTooltip />
      <TileNotice />
      <DownloadControls />
      <MapStatus markerCount={markers.length} />
    </div>
  );
}

/** Buttons for the layers of the active map, shown when it has more than one. */
function LayerSwitcher() {
  const game = useAtlas((s) => s.game);
  const mapId = useAtlas((s) => s.mapId);
  const layerId = useAtlas((s) => s.layerId);
  const summary = useSummary();
  if (!game || !mapId) return null;
  const layers = game.pack.layersOf(mapId);
  if (layers.length < 2) return null;
  return (
    <div className="layer-switcher" role="group" aria-label="Map layer">
      <UiIcon name="layers" size={16} />
      {layers.map((layer) => {
        const tally = summary?.layer(layer.id);
        return (
          <button
            key={layer.id}
            type="button"
            className="chip"
            aria-pressed={layer.id === layerId}
            onClick={() => {
              showMap(mapId, layer.id);
            }}
          >
            {layer.name}
            {tally && tally.total > 0 ? (
              <span className="chip-count">
                {tally.found}/{tally.total}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** The name of the marker under the pointer. */
function MarkerTooltip() {
  const hover = useAtlas((s) => s.hover);
  const location = useAtlas((s) => (s.hover ? s.game?.pack.locations.get(s.hover.id) : undefined));
  if (!hover || !location) return null;
  return (
    <div className="marker-tooltip" role="tooltip" style={{ left: hover.x, top: hover.y }}>
      {location.name}
    </div>
  );
}

/** The "Map images" button and the download panel, in a build with downloads. */
function DownloadControls() {
  const offered = useAtlas(downloadsOffered);
  return __ATLAS_DOWNLOADS__ && offered ? (
    <>
      <MapImagesButton />
      <DownloadPanel />
    </>
  ) : null;
}

/**
 * Says when the map image is missing, and offers to download it where the
 * app can: only a build with downloads ever does.
 */
function TileNotice() {
  const tileStatus = useAtlas((s) => s.tileStatus);
  const canDownload = useAtlas(
    (s) => __ATLAS_DOWNLOADS__ && downloadsOffered(s) && s.downloads.packFolder !== null,
  );
  const job = useAtlas((s) => s.downloads.job);
  const panelOpen = useAtlas((s) => s.downloads.panelOpen);
  if (tileStatus?.status !== 'missing' || panelOpen) return null;
  const downloading = job?.state === 'running' || job?.state === 'paused';
  return (
    <div className="tile-notice" role="status" data-testid="tile-notice">
      <span>
        {downloading
          ? `Downloading map images (${downloadPercent(job)}%). The map appears as soon as the first level is ready.`
          : 'Map image not installed. Markers are shown on a plain background.'}
      </span>
      {__ATLAS_DOWNLOADS__ && canDownload ? (
        <button
          type="button"
          className="button button-primary button-small"
          data-testid="download-map-images"
          onClick={() => {
            setDownloadPanelOpen(true);
          }}
        >
          <UiIcon name="download" size={16} />
          {downloading ? 'Show progress' : 'Download map images'}
        </button>
      ) : null}
    </div>
  );
}

/** Machine-readable map state for tests and diagnostics; visually hidden. */
function MapStatus({ markerCount }: { markerCount: number }) {
  const view = useAtlas((s) => s.view);
  const layerId = useAtlas((s) => s.layerId);
  return (
    <div
      className="visually-hidden"
      data-testid="map-status"
      data-layer={layerId ?? ''}
      data-zoom={view?.zoom ?? ''}
      data-center-x={view ? Math.round(view.center.x) : ''}
      data-center-y={view ? Math.round(view.center.y) : ''}
    >
      <span data-testid="marker-count">{numberFormat.format(markerCount)}</span>
    </div>
  );
}
