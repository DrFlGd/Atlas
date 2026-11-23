import { sceneBudget, sceneFrame } from '@atlas/core';
import { floorsOf } from '@atlas/schema';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MarkerTooltip, type TouchMapOptions } from '../components/MapPane';
import { setPadScene } from '../input/padState';
import { Reticle } from '../input/Reticle';
import { select } from '../state/actions';
import { useMarkersOn } from '../state/derived';
import { openRouteId, routeDrawing, stepIndexOf, useGameRoutes, useRoutes } from '../state/routes';
import { useScene3d, webglFailed } from '../state/scene3d';
import { useAtlas } from '../state/store';
import { deviceSignals } from './device';
import { SceneEngine, type SceneDot, type SceneStatus } from './engine';

/**
 * The 3D view of the map shown, in place of the 2D map (see
 * `state/scene3d.ts`): its own chunk, loaded only when a map with a model
 * is shown in 3D. It follows the same store as the 2D map: the filters,
 * the search, hiding found locations and the selection; pressing a dot
 * opens the same card.
 */
export default function SceneView({ touch }: { touch?: TouchMapOptions | undefined }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<SceneEngine | null>(null);
  const [status, setStatus] = useState<SceneStatus | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const game = useAtlas((s) => s.game);
  const mapId = useAtlas((s) => s.mapId);
  const layerId = useAtlas((s) => s.layerId);
  const selectedId = useAtlas((s) => s.selectedId);
  const theme = useAtlas((s) => s.theme);
  const fly = useAtlas((s) => s.fly);
  const pack = game?.pack;
  const map = pack && mapId ? pack.maps.get(mapId) : undefined;
  const touchRef = useRef(touch);
  useEffect(() => {
    touchRef.current = touch;
  });
  const fingers = touch !== undefined && touch.input !== 'mouse';

  // One engine for each map shown.
  useEffect(() => {
    const container = containerRef.current;
    const scene = map?.scene;
    if (!container || !pack || !scene || !map.worldTransform) return;
    const frame = sceneFrame(map.worldTransform, scene);
    if (!frame) return;
    let view: SceneEngine;
    try {
      view = new SceneEngine({
        container,
        scene,
        frame,
        resolveUrl: (file) => pack.resolveUrl(file),
        budget: sceneBudget(deviceSignals()),
        fingers,
        dark: useAtlas.getState().theme === 'dark',
        events: {
          pick: (id) => {
            select(id);
            touchRef.current?.onPick(id);
          },
          longPress: (id) => {
            if (fingers) touchRef.current?.onLongPress(id);
          },
          menu: (id) => {
            if (!fingers) touchRef.current?.onMarkerMenu?.(id);
          },
          hover: (hover) => {
            useAtlas.setState({ hover });
          },
          status: setStatus,
          failed: webglFailed,
          // Where the dots are once the view is at rest: for tests and diagnostics.
          settled: () => {
            const element = statusRef.current;
            if (!element) return;
            const seen = view.onScreen();
            element.dataset.onScreen = JSON.stringify(
              seen.ids.slice(0, 200).map((id, i) => ({
                id,
                x: Math.round(seen.points[i]!.x),
                y: Math.round(seen.points[i]!.y),
              })),
            );
          },
        },
      });
    } catch {
      webglFailed();
      return;
    }
    setPadScene({
      container,
      onScreen: () => view.onScreen(),
      nudge: (dx, dy, dz) => {
        view.nudge(dx, dy, dz);
      },
      turn: (yaw, pitch) => {
        view.turn(yaw, pitch);
      },
      lookAt: (id) => {
        view.lookAt(id);
      },
      fromAbove: () => {
        view.fromAbove();
      },
    });
    setEngine(view);
    return () => {
      setPadScene(null);
      view.dispose();
      setEngine(null);
      setStatus(null);
      useAtlas.setState({ hover: null });
    };
  }, [pack, map, fingers]);

  // The locations: on every floor, or on the one picked.
  const floors = useMemo(
    () => (pack && mapId ? floorsOf(pack.layersOf(mapId), mapId) : []),
    [pack, mapId],
  );
  const allFloors = useScene3d((s) => s.allFloors);
  const floor = floors.length > 0 && !allFloors ? floors.find((l) => l.id === layerId) : undefined;
  const layerIds = useMemo(
    () =>
      floor
        ? floor.id
        : pack && mapId
          ? pack
              .layersOf(mapId)
              .map((layer) => layer.id)
              .join('\n')
          : '',
    [floor, pack, mapId],
  );
  const markers = useMarkersOn(layerIds);
  useEffect(() => {
    if (!engine || !pack) return;
    const tops = new Map(floors.map((layer) => [layer.id, layer.heights?.[1] ?? null] as const));
    const dots: SceneDot[] = [];
    for (const marker of markers) {
      const location = pack.locations.get(marker.id);
      if (!location) continue;
      dots.push({
        id: marker.id,
        px: marker.x,
        py: marker.y,
        height: location.height ?? null,
        top: tops.get(location.layerId) ?? null,
        color: marker.color,
        muted: marker.muted === true,
      });
    }
    engine.setDots(dots);
  }, [engine, pack, markers, floors]);

  useEffect(() => {
    engine?.setSelected(selectedId);
  }, [engine, selectedId]);

  // The cuts: the floor's top, or the free cut; and toward the camera.
  const cut = useScene3d((s) => s.cut);
  const towardCamera = useScene3d((s) => s.cutTowardCamera);
  const top = floor?.heights ? floor.heights[1] : cut;
  useEffect(() => {
    engine?.setCut(top, towardCamera);
  }, [engine, top, towardCamera]);

  // The theme's colours are read from the page once it has them.
  useEffect(() => {
    if (!engine) return;
    const frame = requestAnimationFrame(() => {
      engine.setTheme(theme === 'dark');
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [engine, theme]);

  // The route open in Lists.
  const routeId = useAtlas(openRouteId);
  const routes = useGameRoutes();
  const openRoute = routes.find((entry) => entry.route.id === routeId)?.route;
  const found = useAtlas((s) => s.found);
  const routeStep = useRoutes((s) =>
    openRoute ? stepIndexOf(openRoute.id, openRoute.steps.length, s) : 0,
  );
  useEffect(() => {
    if (!engine) return;
    const drawing = routeDrawing(game, openRoute, mapId, found, routeStep, false);
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue('--atlas-accent').trim() ||
      '#63cdb9';
    engine.setRoute(
      drawing && drawing.lines.length > 0
        ? { lines: drawing.lines.map((line) => [...line]), color: drawing.color ?? accent }
        : null,
    );
  }, [engine, game, openRoute, mapId, found, routeStep]);

  // "View from above" and "Back to the start".
  const request = useScene3d((s) => s.request);
  const handledRequest = useRef(request?.seq ?? 0);
  useEffect(() => {
    if (!engine || !request || request.seq === handledRequest.current) return;
    handledRequest.current = request.seq;
    if (request.kind === 'above') engine.fromAbove();
    else engine.recenter();
  }, [engine, request]);

  // A location to show ("Show on the map", a search result): flown to,
  // also when it is what opened the view, as long as it is on this map.
  const handledFly = useRef(0);
  useEffect(() => {
    if (!engine || !fly || fly.seq === handledFly.current) return;
    // A request made before the view opened counts only for a location on this map.
    const opening = handledFly.current === 0;
    handledFly.current = fly.seq;
    const selected = useAtlas.getState().selectedId;
    const location = selected ? pack?.locations.get(selected) : undefined;
    if (selected && location?.mapId === mapId && engine.lookAt(selected, true)) return;
    if (!opening) engine.lookAtPixel(fly.x, fly.y);
  }, [engine, fly, pack, mapId, markers]);

  return (
    <div className="map-area scene-area">
      <div ref={containerRef} className="map-pane scene-view" data-testid="scene-view" />
      <Reticle />
      {fingers ? null : <MarkerTooltip />}
      <div
        ref={statusRef}
        className="visually-hidden"
        data-testid="scene-status"
        data-ready={status && status.cells > 0 && status.loading === 0 ? 'true' : 'false'}
        data-cells={status?.cells ?? 0}
        data-triangles={status?.triangles ?? 0}
        data-dots={status?.dots ?? 0}
        data-bias={status?.bias ?? 0}
        data-floor={floor?.id ?? 'all'}
        data-selected={selectedId ?? ''}
        data-cut={top ?? ''}
      >
        <span data-testid="marker-count">{markers.length}</span>
      </div>
    </div>
  );
}
