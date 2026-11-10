import { loadPack } from '@atlas/core';
import { useEffect, useMemo, useState } from 'react';
import { MapPane } from './components/MapPane';
import { Overlay } from './components/Overlay';
import { applyQueryOverrides, loadRuntimeConfig, type RuntimeConfig } from './config';
import { useAtlasStore } from './state/atlasStore';
import { formatViewHash, parseViewHash } from './viewHash';

/** Loads the runtime config and the configured pack, then shows the map. */
export function App() {
  const load = useAtlasStore((state) => state.load);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [initialView] = useState(() => parseViewHash(window.location.hash));

  useEffect(() => {
    const controller = new AbortController();
    // A function rather than a property read, so checks after an await are not narrowed away.
    const aborted = () => controller.signal.aborted;
    const { setLoaded, setError } = useAtlasStore.getState();
    (async () => {
      const runtime = applyQueryOverrides(await loadRuntimeConfig(), window.location.search);
      if (aborted()) return;
      document.documentElement.dataset.theme = runtime.theme;
      setConfig(runtime);
      const pack = await loadPack(runtime.packUrl, { signal: controller.signal });
      const firstMap = pack.data.maps[0];
      const firstLayer = firstMap ? pack.layersOf(firstMap.id)[0] : undefined;
      if (!firstLayer) throw new Error('The pack has no map layers.');
      if (!aborted()) setLoaded(pack, firstLayer.id);
    })().catch((error: unknown) => {
      if (!aborted()) setError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      controller.abort();
    };
  }, []);

  useViewHashSync();

  const markerCount = useMemo(
    () => (load.status === 'ready' ? load.pack.locationsOn(load.layerId).length : 0),
    [load],
  );

  if (load.status === 'error') {
    return (
      <main className="status status-error" role="alert">
        <h1>Could not load the map</h1>
        <pre>{load.message}</pre>
      </main>
    );
  }
  if (load.status === 'loading' || !config) {
    return (
      <main className="status" aria-busy="true">
        Loading…
      </main>
    );
  }
  return (
    <main className="app">
      <MapPane
        pack={load.pack}
        layerId={load.layerId}
        clustering={config.clustering}
        initialView={initialView}
      />
      <Overlay pack={load.pack} markerCount={markerCount} />
    </main>
  );
}

/** Mirrors the map view into the URL fragment without adding history entries. */
function useViewHashSync() {
  const view = useAtlasStore((state) => state.view);
  useEffect(() => {
    if (!view) return;
    const timer = window.setTimeout(() => {
      const hash = formatViewHash({ ...view.center, zoom: view.zoom });
      if (hash !== window.location.hash) {
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${window.location.search}${hash}`,
        );
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
    };
  }, [view]);
}
