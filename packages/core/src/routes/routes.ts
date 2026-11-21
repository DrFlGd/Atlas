import {
  parseId,
  STEP_ID_PATTERN,
  type ChecklistItem,
  type Location,
  type OwnRoute,
  type PackData,
  type Route,
  type RouteStep,
  type RouteType,
} from '@atlas/schema';
import { newOwnId, randomText, type RandomText } from '../checklists/ownLists';

/**
 * Routes (see `routes.ts` in the schema package): where each step stands
 * now, the line on one map, a pack's routes made safe to show, the
 * splitting of a line a site gives into corner points, and the pure changes
 * the editor makes to a route of the person's own. Every change returns a
 * new route and leaves what it was given as it was.
 */

/** A point in map image pixels. */
export interface RoutePoint {
  x: number;
  y: number;
}

/** A step as it is shown: where it stands now, and the location it stands on. */
export interface ShownStep {
  step: RouteStep;
  /** Its number, from 1. */
  number: number;
  mapId: string;
  x: number;
  y: number;
  /** The location it stands on, when the game has it. */
  location: Location | null;
}

/** The words for a route's type, and for none. */
export function routeTypeName(type: RouteType | undefined): string {
  switch (type) {
    case 'walkthrough':
      return 'Walkthrough';
    case 'collection':
      return 'Collection';
    case 'build':
      return 'Build';
    default:
      return 'Route';
  }
}

/**
 * The steps of a route as they are shown: a step on a location the game
 * has stands where that location is now (it may have moved, or be on
 * another map); any other step stands at its own point.
 */
export function shownSteps(
  route: Route,
  locationOf: (id: string) => Location | undefined,
): ShownStep[] {
  return route.steps.map((step, i) => {
    const location = step.locationId ? (locationOf(step.locationId) ?? null) : null;
    return {
      step,
      number: i + 1,
      mapId: location?.mapId ?? step.mapId,
      x: location?.x ?? step.x,
      y: location?.y ?? step.y,
      location,
    };
  });
}

/**
 * The line of a route on one map: one polyline for each pair of steps in a
 * row that are both on the map, through the corner points between them. A
 * pair on two maps is not joined.
 */
export function routeLines(steps: readonly ShownStep[], mapId: string): RoutePoint[][] {
  const lines: RoutePoint[][] = [];
  let current: RoutePoint[] | null = null;
  steps.forEach((shown, i) => {
    const previous = i > 0 ? steps[i - 1] : undefined;
    if (shown.mapId !== mapId) {
      current = null;
      return;
    }
    if (previous?.mapId !== mapId) {
      current = [{ x: shown.x, y: shown.y }];
      lines.push(current);
      return;
    }
    const corners = (shown.step.via ?? []).map(([x, y]) => ({ x, y }));
    current ??= [{ x: previous.x, y: previous.y }];
    current.push(...corners, { x: shown.x, y: shown.y });
  });
  return lines.filter((line) => line.length > 1);
}

/** The maps a route's steps are on, in the order it reaches them, each once. */
export function routeMaps(steps: readonly ShownStep[]): string[] {
  const maps: string[] = [];
  for (const shown of steps) if (!maps.includes(shown.mapId)) maps.push(shown.mapId);
  return maps;
}

/** A pack's routes in their order: by `order`, then by title. */
export function sortRoutes<T extends Route>(routes: readonly T[]): T[] {
  return [...routes].sort((a, b) => {
    if (a.order !== undefined && b.order !== undefined && a.order !== b.order) {
      return a.order - b.order;
    }
    if (a.order !== undefined && b.order === undefined) return -1;
    if (a.order === undefined && b.order !== undefined) return 1;
    return a.title.localeCompare(b.title);
  });
}

/**
 * A pack's routes made safe to show, as a pack is read: a step on a map
 * the pack does not have is left out, a location it does not have is
 * forgotten (the step keeps its point), a point outside its map is moved
 * to the nearest edge, and a route left with no step is left out.
 */
export function cleanRoutes(data: PackData): PackData {
  if (!data.routes || data.routes.length === 0) return data;
  const maps = new Map(data.maps.map((map) => [map.id, map]));
  const locations = new Set(data.locations.map((location) => location.id));
  const ids = new Set<string>();
  const routes = data.routes.flatMap((route) => {
    if (parseId(route.id)?.gameId !== data.manifest.gameId || ids.has(route.id)) return [];
    ids.add(route.id);
    const steps = route.steps.flatMap((step) => {
      const map = maps.get(step.mapId);
      if (!map) return [];
      const clamp = (x: number, y: number): [number, number] => [
        Math.min(Math.max(x, 0), map.width),
        Math.min(Math.max(y, 0), map.height),
      ];
      const [x, y] = clamp(step.x, step.y);
      const { locationId, via, ...rest } = step;
      return [
        {
          ...rest,
          x,
          y,
          ...(locationId !== undefined && locations.has(locationId) ? { locationId } : {}),
          ...(via && via.length > 0 ? { via: via.map(([vx, vy]) => clamp(vx, vy)) } : {}),
        },
      ];
    });
    return steps.length > 0 ? [{ ...route, steps }] : [];
  });
  return { ...data, routes };
}

/**
 * Splits a line a source gives for a route (every point of it, in order,
 * through the steps) into the corner points between its steps: each point
 * of the line until it reaches the next step is a corner before that step.
 * A line that does not pass through every step in order (within
 * `tolerance` pixels) gives no corners: the route is drawn straight.
 */
export function cornersFromLine(
  steps: readonly RoutePoint[],
  line: readonly RoutePoint[],
  tolerance = 1,
): ([number, number][] | undefined)[] {
  const none = steps.map((): [number, number][] | undefined => undefined);
  if (steps.length < 2 || line.length < 2) return none;
  const near = (a: RoutePoint, b: RoutePoint) =>
    Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
  const corners: ([number, number][] | undefined)[] = [...none];
  let next = 0;
  let pending: [number, number][] = [];
  for (const point of line) {
    const step = steps[next];
    if (step && near(point, step)) {
      if (next > 0 && pending.length > 0) corners[next] = pending;
      pending = [];
      next++;
    } else if (next > 0) {
      pending.push([point.x, point.y]);
    } else {
      // The line starts before the first step.
      return none;
    }
  }
  return next === steps.length ? corners : none;
}

// ---------------------------------------------------------------------------
// The person's own routes

/** A new step id that the route does not use yet. */
export function newStepId(route: Route, random: RandomText = randomText): string {
  const taken = new Set(route.steps.map((step) => step.id));
  for (;;) {
    const id = `s${random()}`;
    if (!taken.has(id) && STEP_ID_PATTERN.test(id)) return id;
  }
}

/** A new, empty route of the person's own. */
export function newOwnRoute(
  gameId: string,
  title: string,
  now: Date,
  random: RandomText = randomText,
): OwnRoute {
  const time = now.toISOString();
  return {
    id: newOwnId(gameId, 'route', new Set(), random),
    title: title.trim() || 'New route',
    type: 'walkthrough',
    steps: [],
    createdAt: time,
    updatedAt: time,
  };
}

/** What a new step stands on: a location, or a free point of a map. */
export type StepPlace =
  { kind: 'location'; location: Location } | { kind: 'point'; mapId: string; x: number; y: number };

/** A step on a location or a free point, its title the location's name or "Step N". */
export function stepAt(route: Route, place: StepPlace, random: RandomText = randomText): RouteStep {
  const id = newStepId(route, random);
  if (place.kind === 'location') {
    const { location } = place;
    return {
      id,
      title: location.name,
      locationId: location.id,
      mapId: location.mapId,
      x: location.x,
      y: location.y,
    };
  }
  return {
    id,
    title: 'New step',
    mapId: place.mapId,
    x: place.x,
    y: place.y,
  };
}

/** The route with its changes, its time of change set. */
function changed<T extends Route & { updatedAt?: string }>(
  route: T,
  change: Partial<Route>,
  now: Date,
): T {
  return { ...route, ...change, updatedAt: now.toISOString() };
}

/** Adds a step: at the end, or after the step `after` (by id). */
export function addRouteStep<T extends Route>(
  route: T,
  step: RouteStep,
  now: Date,
  after?: string,
): T {
  const steps = [...route.steps];
  const at = after === undefined ? -1 : steps.findIndex((s) => s.id === after);
  if (at < 0) steps.push(step);
  else steps.splice(at + 1, 0, step);
  return changed(route, { steps: withoutLostCorners(steps, route.steps) }, now);
}

/** Changes one step's fields. */
export function changeRouteStep<T extends Route>(
  route: T,
  stepId: string,
  change: Partial<Pick<RouteStep, 'title' | 'text'>>,
  now: Date,
): T {
  return changed(
    route,
    {
      steps: route.steps.map((step) => {
        if (step.id !== stepId) return step;
        const next = { ...step, ...change };
        if (next.text?.trim() === '') delete next.text;
        return next;
      }),
    },
    now,
  );
}

/** Removes a step. */
export function removeRouteStep<T extends Route>(route: T, stepId: string, now: Date): T {
  return changed(
    route,
    {
      steps: withoutLostCorners(
        route.steps.filter((step) => step.id !== stepId),
        route.steps,
      ),
    },
    now,
  );
}

/** Moves a step one place up (-1) or down (+1). */
export function moveRouteStep<T extends Route>(route: T, stepId: string, by: -1 | 1, now: Date): T {
  const steps = [...route.steps];
  const from = steps.findIndex((step) => step.id === stepId);
  const to = from + by;
  if (from < 0 || to < 0 || to >= steps.length) return route;
  const [step] = steps.splice(from, 1);
  steps.splice(to, 0, step!);
  return changed(route, { steps: withoutLostCorners(steps, route.steps) }, now);
}

/**
 * Corner points belong between a step and the one before it: when the step
 * before changes (a step moved, added or removed), the corners no longer
 * lead from it, so they are dropped. A step whose step before is the same
 * keeps them.
 */
function withoutLostCorners(steps: RouteStep[], before: readonly RouteStep[]): RouteStep[] {
  const previousOf = new Map<string, string | null>();
  before.forEach((step, i) => previousOf.set(step.id, i > 0 ? before[i - 1]!.id : null));
  return steps.map((step, i) => {
    if (!step.via) return step;
    const previous = i > 0 ? steps[i - 1]!.id : null;
    if (previousOf.get(step.id) === previous && i > 0 && steps[i - 1]!.mapId === step.mapId) {
      return step;
    }
    const { via: _lost, ...rest } = step;
    return rest;
  });
}

/** Adds a corner point of the line before a step, after the corners it has. */
export function addRouteCorner<T extends Route>(
  route: T,
  stepId: string,
  point: RoutePoint,
  now: Date,
): T {
  return changed(
    route,
    {
      steps: route.steps.map((step) =>
        step.id === stepId ? { ...step, via: [...(step.via ?? []), [point.x, point.y]] } : step,
      ),
    },
    now,
  );
}

/** Removes every corner point of the line before a step: the line goes straight again. */
export function clearRouteCorners<T extends Route>(route: T, stepId: string, now: Date): T {
  return changed(
    route,
    {
      steps: route.steps.map((step) => {
        if (step.id !== stepId || !step.via) return step;
        const { via: _gone, ...rest } = step;
        return rest;
      }),
    },
    now,
  );
}

/** Changes the route's own fields. An empty description or colour is removed. */
export function changeRoute<T extends Route>(
  route: T,
  change: Partial<Pick<Route, 'title' | 'description' | 'type' | 'color'>>,
  now: Date,
): T {
  const next = changed(route, change, now);
  if (next.description?.trim() === '') delete next.description;
  if (next.color === undefined || next.color === '') delete next.color;
  if (next.title.trim() === '') next.title = route.title;
  return next;
}

/**
 * A route of the person's own started from a list in order: a step for
 * each entry that names a location the game has (its first one), titled
 * as the entry and with its note as the step's text. Entries without a
 * location are left out.
 */
export function routeFromList(
  gameId: string,
  list: { id: string; name: string },
  items: readonly ChecklistItem[],
  locationOf: (id: string) => Location | undefined,
  now: Date,
  random: RandomText = randomText,
): OwnRoute {
  let route: OwnRoute = { ...newOwnRoute(gameId, list.name, now, random), fromList: list.id };
  const ordered = [...items].sort((a, b) => a.order - b.order);
  for (const item of ordered) {
    const location = item.locationIds.map(locationOf).find((found) => found !== undefined);
    if (!location) continue;
    const step: RouteStep = {
      ...stepAt(route, { kind: 'location', location }, random),
      title: item.name,
      ...(item.note?.trim() ? { text: item.note } : {}),
    };
    route = { ...route, steps: [...route.steps, step] };
  }
  return route;
}

/** A copy of a pack's route as one of the person's own, to change. */
export function copyRoute(
  gameId: string,
  route: Route,
  now: Date,
  random: RandomText = randomText,
): OwnRoute {
  const time = now.toISOString();
  const { order: _order, ...rest } = route;
  return {
    ...rest,
    id: newOwnId(gameId, 'route', new Set(), random),
    title: `${route.title} (my copy)`,
    createdAt: time,
    updatedAt: time,
  };
}

/** Which step comes next: the first one not done, after `from` when given. */
export function nextUndone(
  steps: readonly ShownStep[],
  done: (shown: ShownStep) => boolean,
  from = -1,
): number {
  for (let i = from + 1; i < steps.length; i++) if (!done(steps[i]!)) return i;
  return -1;
}
