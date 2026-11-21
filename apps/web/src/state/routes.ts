import {
  addRouteCorner,
  addRouteStep,
  copyRoute,
  newOwnRoute,
  routeFromList,
  routeLines,
  shownSteps,
  sortRoutes,
  stepAt,
  type ChecklistEntry,
  type ShownStep,
  type StepPlace,
} from '@atlas/core';
import type { RouteDrawing } from '@atlas/core/mapview';
import { isOwnId, makeId, parseId, type OwnRoute, type Route } from '@atlas/schema';
import { useMemo } from 'react';
import { create } from 'zustand';
import { applyProgress, goToLocation, goToPoint, notify, setFound } from './actions';
import { openChecklistPage } from './checklists';
import { canChangeOwnRoutes, putOwnRoute, useOwnRoutes, whyRoutesCannotChange } from './ownRoutes';
import { useAtlas, type AtlasState, type LoadedGame } from './store';

/**
 * Routes of the game shown (see `routes.ts` in the schema package): the
 * pack's and the person's own, the one open in Lists, its step, the ticks
 * of its steps, and the route editor's choice of what a press on the map
 * does. The open route is the page on top of the Lists section (a page of
 * kind `route`), so Back closes it as it closes a list; while it is open,
 * the map draws it (see `routeDrawing`).
 */

export interface RoutesState {
  /** The step open in each route, by route id: its index. */
  steps: Readonly<Record<string, number>>;
  /** The own route being changed, by id; null when none is. */
  editing: string | null;
  /**
   * What a press on the map does while a route is changed: add a step
   * (on a location pressed, or a free point), or add a corner of the line
   * before a step; null does what it always does.
   */
  pick: { kind: 'step' } | { kind: 'corner'; stepId: string } | null;
}

export const useRoutes = create<RoutesState>()(() => ({ steps: {}, editing: null, pick: null }));

const get = useRoutes.getState;
const set = useRoutes.setState;

/** A route of the game, and whether it is one of the person's own. */
export interface GameRoute {
  route: Route;
  own: boolean;
}

/** The game's routes: the pack's in their order, then the person's own, in the order made. */
export function routesOf(game: LoadedGame | null, own: readonly OwnRoute[]): GameRoute[] {
  if (!game) return [];
  const gameId = game.pack.manifest.gameId;
  return [
    ...sortRoutes(game.pack.data.routes ?? []).map((route) => ({ route, own: false })),
    ...own
      .filter((route) => parseId(route.id)?.gameId === gameId)
      .map((route) => ({ route, own: true })),
  ];
}

/** The game's routes, kept up to date. */
export function useGameRoutes(): GameRoute[] {
  const game = useAtlas((s) => s.game);
  const own = useOwnRoutes((s) => (s.gameId === game?.pack.manifest.gameId ? s.routes : NONE));
  return useMemo(() => routesOf(game, own), [game, own]);
}

const NONE: readonly OwnRoute[] = [];

/** A route of the game shown, by id. */
export function routeById(id: string): GameRoute | undefined {
  const { game } = useAtlas.getState();
  const own = useOwnRoutes.getState();
  return routesOf(game, own.gameId === game?.pack.manifest.gameId ? own.routes : NONE).find(
    (entry) => entry.route.id === id,
  );
}

/** The id of the route open in Lists, if one is. */
export function openRouteId(state: AtlasState): string | null {
  const page = state.checklistPages.at(-1);
  return page?.kind === 'route' ? page.id : null;
}

/** The steps of a route of the game shown, as they stand now. */
export function stepsOf(game: LoadedGame, route: Route): ShownStep[] {
  return shownSteps(route, (id) => game.pack.locations.get(game.pack.currentId(id)));
}

// ---------------------------------------------------------------------------
// Ticks

/**
 * What a step's tick is kept by: the location it stands on, when that can
 * be marked found (ticking the step marks it found); else a mark of its own,
 * kept with the progress as a location's found mark is.
 */
export function stepTarget(game: LoadedGame, route: Route, shown: ShownStep): string {
  if (shown.location && game.counter.isTrackable(shown.location.id)) return shown.location.id;
  const routeId = parseId(route.id);
  const local = `${routeId?.localId ?? 'route'}.step-${shown.step.id}`.slice(0, 120);
  return makeId(game.pack.manifest.gameId, 'route', local);
}

/** Whether a step is ticked. */
export function stepDone(
  game: LoadedGame,
  found: ReadonlyMap<string, unknown>,
  route: Route,
  shown: ShownStep,
): boolean {
  return found.has(stepTarget(game, route, shown));
}

/** Ticks a step or takes its tick away: a step on a location marks it found or not. */
export function tickStep(route: Route, shown: ShownStep, done: boolean): void {
  const { game } = useAtlas.getState();
  if (!game) return;
  const target = stepTarget(game, route, shown);
  if (target === shown.location?.id) {
    setFound(target, done);
    return;
  }
  applyProgress([{ targetId: target, found: done }], {
    undone: `Undone: step ${shown.number}, ${shown.step.title}, is ${done ? 'not done' : 'done'} again.`,
    selectId: null,
  });
}

// ---------------------------------------------------------------------------
// Opening and following

/** Opens a route in Lists, at the step it was left at (or the one given). */
export function openRoute(routeId: string, step?: number): void {
  if (step !== undefined) set({ steps: { ...get().steps, [routeId]: step } });
  openChecklistPage({ kind: 'route', id: routeId });
}

/** The step open in a route. */
export function stepIndexOf(routeId: string, count: number, state: RoutesState = get()): number {
  const at = state.steps[routeId] ?? 0;
  return Math.min(Math.max(at, 0), Math.max(count - 1, 0));
}

/** Opens a step of a route and shows it on the map, with its location's card unless the route is changed. */
export function goToStep(route: Route, index: number): void {
  const { game } = useAtlas.getState();
  if (!game) return;
  const steps = stepsOf(game, route);
  const shown = steps[index];
  if (!shown) return;
  set({ steps: { ...get().steps, [route.id]: index } });
  // While the route is changed, the map only moves: a location's card would cover it.
  if (shown.location && get().editing !== route.id) goToLocation(shown.location.id);
  else goToPoint(shown.mapId, shown.x, shown.y);
}

/**
 * The route open in Lists as the map draws it on the map shown: its line,
 * its steps (the open one larger, those ticked faded) and, while it is
 * changed, its corner points. Null when no route is open or none of it is
 * on the map shown.
 */
export function routeDrawing(
  game: LoadedGame | null,
  route: Route | undefined,
  mapId: string | null,
  found: ReadonlyMap<string, unknown>,
  current: number,
  editing: boolean,
): RouteDrawing | null {
  if (!game || !route || !mapId) return null;
  const steps = stepsOf(game, route);
  const onMap = steps.filter((shown) => shown.mapId === mapId);
  if (onMap.length === 0) return null;
  return {
    ...(route.color ? { color: route.color } : {}),
    lines: routeLines(steps, mapId),
    steps: onMap.map((shown) => ({
      x: shown.x,
      y: shown.y,
      label: String(shown.number),
      current: shown.number - 1 === current,
      done: stepDone(game, found, route, shown),
    })),
    ...(editing
      ? {
          corners: onMap.flatMap((shown) => (shown.step.via ?? []).map(([x, y]) => ({ x, y }))),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Making and changing the person's own

/** Why routes cannot be made or changed now, or null. */
export function whyNoRouteChange(): string | null {
  return whyRoutesCannotChange();
}

/** Starts changing an own route: it opens in Lists, ready for steps. */
export function editRoute(routeId: string): void {
  set({ editing: routeId, pick: null });
  openRoute(routeId);
}

/** Stops changing a route: the one given, or whichever is changed. */
export function stopRouteEditing(routeId?: string): void {
  const { editing, pick } = get();
  if (routeId !== undefined && editing !== routeId) return;
  if (editing !== null || pick !== null) set({ editing: null, pick: null });
}

/** What a press on the map does while the route is changed. */
export function setRoutePick(pick: RoutesState['pick']): void {
  set({ pick });
}

/** The own route being changed, as it is now. */
function editedRoute(): OwnRoute | undefined {
  const id = get().editing;
  return id ? useOwnRoutes.getState().routes.find((route) => route.id === id) : undefined;
}

function refused(): boolean {
  const why = whyRoutesCannotChange();
  if (why) notify(why, 'error');
  return why !== null;
}

/** Makes a new, empty route of the person's own and starts changing it. */
export function makeRoute(): void {
  const { game } = useAtlas.getState();
  if (!game || refused()) return;
  const route = newOwnRoute(game.pack.manifest.gameId, 'New route', new Date());
  if (putOwnRoute(route, 'New route made')) {
    editRoute(route.id);
    set({ pick: { kind: 'step' } });
  }
}

/** Makes a route of the person's own from a list in its order, and starts changing it. */
export function makeRouteFromList(entry: ChecklistEntry): void {
  const { game } = useAtlas.getState();
  if (!game || refused()) return;
  const route = routeFromList(
    game.pack.manifest.gameId,
    { id: entry.checklist.id, name: entry.checklist.name },
    entry.items.map((row) => row.item),
    (id) => game.pack.locations.get(game.pack.currentId(id)),
    new Date(),
  );
  if (route.steps.length === 0) {
    notify(`${entry.checklist.name} has no entry on the map, so no route was made from it.`);
    return;
  }
  if (putOwnRoute(route, `Route made from ${entry.checklist.name}`)) editRoute(route.id);
}

/** Copies a pack's route as one of the person's own, to change. */
export function copyPackRoute(route: Route): void {
  const { game } = useAtlas.getState();
  if (!game || refused()) return;
  const copy = copyRoute(game.pack.manifest.gameId, route, new Date());
  if (putOwnRoute(copy, `Copied ${route.title}`)) editRoute(copy.id);
}

/** Changes the route being changed. */
export function changeEditedRoute(change: (route: OwnRoute) => OwnRoute, label?: string): void {
  const route = editedRoute();
  if (!route || !canChangeOwnRoutes()) return;
  const next = change(route);
  if (next !== route) putOwnRoute(next, label);
}

/**
 * A press on the map while a route is changed: a location (by id), or a
 * point of the map shown. Returns whether the route editor took it.
 */
export function routePress(press: { locationId: string } | { x: number; y: number }): boolean {
  const { pick } = get();
  const route = editedRoute();
  const { game, mapId } = useAtlas.getState();
  if (!pick || !route || !game || !mapId) return false;
  if (pick.kind === 'corner') {
    const point =
      'locationId' in press ? game.pack.locations.get(press.locationId) : { ...press, mapId };
    const step = route.steps.find((s) => s.id === pick.stepId);
    if (!point || !step) return true;
    if (step.mapId !== mapId) {
      notify('A corner goes on the map of its step. Show that map first.');
      return true;
    }
    changeEditedRoute(
      (r) => addRouteCorner(r, pick.stepId, { x: point.x, y: point.y }, new Date()),
      'Corner added',
    );
    return true;
  }
  let place: StepPlace;
  if ('locationId' in press) {
    const location = game.pack.locations.get(press.locationId);
    if (!location) return true;
    place = { kind: 'location', location };
  } else {
    place = { kind: 'point', mapId, x: press.x, y: press.y };
  }
  const at = stepIndexOf(route.id, route.steps.length);
  const after = route.steps[at]?.id;
  changeEditedRoute((r) => addRouteStep(r, stepAt(r, place), new Date(), after), 'Step added');
  // The new step is the open one, so the next is added after it.
  const added = editedRoute();
  if (added)
    set({ steps: { ...get().steps, [route.id]: after ? at + 1 : added.steps.length - 1 } });
  return true;
}

/** Whether a route is one of the person's own. */
export const isOwnRoute = (route: Route) => isOwnId(route.id);
