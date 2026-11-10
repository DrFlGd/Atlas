import { layerMarkers, layerViewSpec, type LoadedPack } from '@atlas/core';
import { createMapView, type MapView } from '@atlas/core/mapview';
import { useEffect, useRef } from 'react';
import { useAtlasStore } from '../state/atlasStore';
import type { HashView } from '../viewHash';

interface MapPaneProps {
  pack: LoadedPack;
  layerId: string;
  clustering: boolean;
  /** View to start at instead of fitting the whole map. */
  initialView: HashView | null;
}

/** Hosts the map view and keeps it in sync with the store. */
export function MapPane({ pack, layerId, clustering, initialView }: MapPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapView | null>(null);
  const initialViewRef = useRef(initialView);
  const selectedId = useAtlasStore((state) => state.selectedId);

  useEffect(() => {
    const container = containerRef.current;
    const layer = pack.layers.get(layerId);
    if (!container || !layer) return;

    const { setView, select } = useAtlasStore.getState();
    const map = createMapView(container, { clustering });
    mapRef.current = map;
    const unsubscribeView = map.onViewChange(setView);
    const unsubscribeSelect = map.onSelect(select);

    const visible = new Set(pack.data.categories.filter((c) => c.defaultVisible).map((c) => c.id));
    map.setLayer(layerViewSpec(pack, layer));
    map.setMarkers(layerMarkers(pack, layerId, visible));
    map.setSelected(useAtlasStore.getState().selectedId);
    if (initialViewRef.current) map.flyTo(initialViewRef.current, { animate: false });

    return () => {
      unsubscribeView();
      unsubscribeSelect();
      map.destroy();
      mapRef.current = null;
    };
  }, [pack, layerId, clustering]);

  useEffect(() => {
    mapRef.current?.setSelected(selectedId);
  }, [selectedId]);

  return <div ref={containerRef} className="map-pane" data-testid="map" />;
}
