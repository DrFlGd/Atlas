import { sceneBudget, sceneFrame } from '@atlas/core';
import { floorAt, floorsOf, type Layer, type Location } from '@atlas/schema';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkerTooltip, type TouchMapOptions } from '../components/MapPane';
import { setPadScene } from '../input/padState';
import { Reticle } from '../input/Reticle';
import { select } from '../state/actions';
import { useMarkersOn } from '../state/derived';
import { openRouteId, routeDrawing, stepIndexOf, useGameRoutes, useRoutes } from '../state/routes';
import { focusLocation, leaveFocus, useScene3d, webglFailed } from '../state/scene3d';
import { useAtlas } from '../state/store';
import { deviceSignals } from './device';
import { SceneEngine, type SceneDot, type SceneStatus } from './engine';
import { headCut } from './goTo';
import { SceneTitles } from './SceneTitles';
import { areaTitles, type AreaTitle } from './titles';

/**
 * Goes to a location in the 3D view: shows its floor (the one its height
 * is on, or with no height its own layer), cuts the model at head height
 * above it, and flies down to it (see `goTo.ts`).
 */
function goToLocation3d(view: SceneEngine, location: Location, floors: readonly Layer[]): void {
  let floor =
    floors.length === 0
      ? undefined
      : location.height !== undefined
        ? floorAt(floors, location.height)
        : floors.find((layer) => layer.id === location.layerId);
  const height =
    location.height ?? view.heightAt(location.x, location.y, floor?.heights?.[1] ?? null);
  if (!floor && floors.length > 0) floor = floorAt(floors, height);
  const top = floor?.heights?.[1] ?? null;
  focusLocation(location.id, floor?.id ?? null, headCut(height, top));
  view.goTo(location.x, location.y, location.height ?? null, top);
}

/**
 * The 3D view of the map shown, in place of the 2D map (see
 * `state/scene3d.ts`): its own chunk, loaded only when a map with a model
 * is shown in 3D. It follows the same store as the 2D map: the filters,
 * the search, hiding found locations and the selection; pressing a dot
 * opens the same card, and goes to the location: its floor, the model cut
 * above it, the view down at it. The names of the areas float over it.
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
  // What runs after each frame drawn: the titles follow the view.
  const frameRef = useRef<(() => void) | null>(null);
  const listenFrames = useCallback((update: (() => void) | null) => {
    frameRef.current = update;
  }, []);
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
          frame: () => {
            frameRef.current?.();
          },
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
            const titles = [
              ...document.querySelectorAll<HTMLElement>('.scene-titles [data-title-id]'),
            ].filter((title) => title.style.visibility === 'visible');
            element.dataset.titles = JSON.stringify(titles.map((title) => title.dataset.titleId));
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
  // The location the view went to, while it is on this map.
  const focus = useScene3d((s) => s.focus);
  const focusHere = focus && pack?.locations.get(focus.id)?.mapId === mapId ? focus : null;
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

  // The cuts: above the location gone to, the floor's top, or the free cut; and toward the camera.
  const cut = useScene3d((s) => s.cut);
  const towardCamera = useScene3d((s) => s.cutTowardCamera);
  const top = focusHere ? focusHere.cut : floor?.heights ? floor.heights[1] : cut;
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

  // A location pressed (its dot, a row of a list, a search result, a link,
  // the controller): the view goes to it. A location shown from elsewhere
  // (a search result, a list) when the view opens is gone to as well; a
  // selection it opens with is only looked at. Any other point asked for
  // (an area of the map) is looked at.
  const seen = useRef<{ engine: SceneEngine; selected: string | null; fly: number } | null>(null);
  useEffect(() => {
    if (!engine || engine.gone || !pack) return;
    const before = seen.current?.engine === engine ? seen.current : null;
    seen.current = { engine, selected: selectedId, fly: fly?.seq ?? 0 };
    const location = selectedId ? pack.locations.get(selectedId) : undefined;
    const here = location?.mapId === mapId ? location : undefined;
    // `goToLocation` aims the 2D map at the location (lower on a narrow screen): the same x.
    const flownTo = here !== undefined && fly !== null && Math.abs(fly.x - here.x) < 1;
    if (!before) {
      if (here && flownTo) goToLocation3d(engine, here, floors);
      else if (here) engine.lookAt(here.id, true);
      return;
    }
    if (here && selectedId !== before.selected) {
      goToLocation3d(engine, here, floors);
      return;
    }
    if (fly && fly.seq !== before.fly) {
      if (here && flownTo) goToLocation3d(engine, here, floors);
      else engine.lookAtPixel(fly.x, fly.y);
    }
  }, [engine, pack, mapId, selectedId, fly, floors]);

  // Back from a location: the selection cleared (Escape, B, Back, a press
  // on nothing), another map, or the view closed.
  useEffect(
    () =>
      useAtlas.subscribe((state, previous) => {
        if (previous.selectedId !== null && state.selectedId === null) leaveFocus();
      }),
    [],
  );
  useEffect(
    () => () => {
      leaveFocus();
    },
    [mapId],
  );

  // The names of the areas: those on the floor shown, unless turned off.
  const titlesOn = useScene3d((s) => s.titles);
  const allTitles = useMemo(
    () => (pack && mapId ? areaTitles(pack.regions.values(), pack.locations.values(), mapId) : []),
    [pack, mapId],
  );
  const titles = useMemo(
    () =>
      titlesOn
        ? allTitles.filter(
            (title) =>
              !floor || title.height === null || floorAt(floors, title.height)?.id === floor.id,
          )
        : [],
    [titlesOn, allTitles, floor, floors],
  );
  useEffect(() => {
    const floorTop = floor?.heights?.[1] ?? null;
    engine?.setTitles(
      titles.map((title) => ({
        id: title.id,
        px: title.px,
        py: title.py,
        height: title.height,
        top: floorTop,
        radius: title.radius,
      })),
    );
  }, [engine, titles, floor]);
  const showArea = useCallback(
    (title: AreaTitle) => {
      leaveFocus();
      engine?.frameArea(title.px, title.py, title.height, title.radius);
    },
    [engine],
  );

  return (
    <div className="map-area scene-area">
      <div ref={containerRef} className="map-pane scene-view" data-testid="scene-view" />
      {engine ? (
        <SceneTitles engine={engine} titles={titles} listen={listenFrames} onPress={showArea} />
      ) : null}
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
        data-focus={focusHere?.id ?? ''}
      >
        <span data-testid="marker-count">{markers.length}</span>
      </div>
    </div>
  );
}
