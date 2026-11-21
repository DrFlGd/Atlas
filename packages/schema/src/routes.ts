import { z } from 'zod';
import { pointSchema, type SchemaMode } from './entities';
import { gameIdSchema, idOf, isOwnId, OWN_ID_PREFIX, parseId } from './ids';

/**
 * Routes: an ordered path on a game's maps, with a short guide at each
 * step. The map draws a line from step to step and numbers the steps; a
 * panel lists them in order, each with its title and text.
 *
 * A route is a thing of its own, not a list. It has a title, a short
 * description, a type (`walkthrough`, `collection` or `build`), an
 * optional colour, and its steps in order. A step stands on a location of
 * the game (`locationId`) or on a free point of a map; either way it
 * records its map and its point, so a step whose location a newer pack no
 * longer has is still drawn where it was. Ticking a step that stands on a
 * location marks that location found.
 *
 * The line goes straight from step to step. Between two steps it may bend:
 * a step's `via` lists the corner points of the line from the step before
 * it to this one, in order, on the step's map. A corner is not a step and
 * has no number or text. A route may cross several maps of one game: the
 * line joins two steps only when both are on the same map.
 *
 * A pack's routes are in its `routes.json` (optional; a pack without one
 * has none). A person's own routes are kept apart from every pack, as their
 * own lists are (see `ownLists.ts`): in the desktop app a file beside the
 * game's folder in the maps folder (`<game id>.my-routes.json`), elsewhere
 * where progress is kept, in the shape {@link ownRoutesFileSchema} gives.
 *
 * Written strictly and read tolerantly, as packs are (see {@link SchemaMode}):
 * a route that cannot be read is left out, not the file, and an unknown
 * `type` reads as none.
 */

/** What a route is to its reader: it decides only the words shown with it. */
export const ROUTE_TYPES = ['walkthrough', 'collection', 'build'] as const;
export const routeTypeSchema = z.enum(ROUTE_TYPES);
export type RouteType = z.infer<typeof routeTypeSchema>;

/** The longest title of a route or a step. */
export const MAX_ROUTE_TITLE = 200;
/** The longest description of a route. */
export const MAX_ROUTE_DESCRIPTION = 5000;
/** The longest text of a step (Markdown). */
export const MAX_STEP_TEXT = 20_000;
/** The most steps a route has. */
export const MAX_ROUTE_STEPS = 2000;
/** The most corner points between two steps. */
export const MAX_STEP_CORNERS = 500;
/** The most routes a pack, or a person's own file, holds. */
export const MAX_ROUTES = 1000;

/** A step's own id inside its route: what its tick is kept by. */
export const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour');
const isoTime = z.iso.datetime({ offset: true });

function routeSchemas(mode: SchemaMode, { own = false }: { own?: boolean } = {}) {
  const reading = mode === 'read';
  const record = <T extends z.core.$ZodLooseShape>(shape: T) =>
    reading
      ? z.object(shape)
      : (z.strictObject(shape) as unknown as ReturnType<typeof z.object<T>>);

  const routeId = reading
    ? idOf('route')
    : own
      ? idOf('route').refine(isOwnId, `must be an own id (starting with ${OWN_ID_PREFIX})`)
      : idOf('route').refine(
          (id) => !isOwnId(id),
          `must not start with ${OWN_ID_PREFIX}, which is kept for what people make in the app`,
        );

  /** One step of a route: where it stands, its title and its text. */
  const routeStepSchema = record({
    /** Its id inside the route, which its tick is kept by. */
    id: z.string().regex(STEP_ID_PATTERN, 'must be 1 to 64 letters, digits, _, . and -'),
    title: z.string().trim().min(1).max(MAX_ROUTE_TITLE),
    /** A short guide to the step, in Markdown. */
    text: reading
      ? z.string().max(MAX_STEP_TEXT).optional().catch(undefined)
      : z.string().max(MAX_STEP_TEXT).optional(),
    /** The location it stands on, when it stands on one. */
    locationId: reading ? idOf('loc').optional().catch(undefined) : idOf('loc').optional(),
    /** The map it is on. */
    mapId: idOf('map'),
    /** Its point: map image pixels, origin top-left (the location's, when it stands on one). */
    x: z.number(),
    y: z.number(),
    /** The corner points of the line from the step before to this one, in order. */
    via: reading
      ? z.array(pointSchema).max(MAX_STEP_CORNERS).optional().catch(undefined)
      : z.array(pointSchema).min(1).max(MAX_STEP_CORNERS).optional(),
  });

  const routeSchema = record({
    id: routeId,
    title: z.string().trim().min(1).max(MAX_ROUTE_TITLE),
    description: reading
      ? z.string().max(MAX_ROUTE_DESCRIPTION).optional().catch(undefined)
      : z.string().max(MAX_ROUTE_DESCRIPTION).optional(),
    /** What it is (see {@link ROUTE_TYPES}); absent reads as a plain route. */
    type: reading ? routeTypeSchema.optional().catch(undefined) : routeTypeSchema.optional(),
    /** The colour of its line, `#rrggbb`; the theme's accent when absent. */
    color: reading ? hexColor.optional().catch(undefined) : hexColor.optional(),
    /** Place among the game's routes, ascending; routes without one follow, by title. */
    order: reading ? z.int().optional().catch(undefined) : z.int().optional(),
    steps: z.array(routeStepSchema).max(MAX_ROUTE_STEPS),
  }).superRefine((route, context) => {
    const seen = new Set<string>();
    route.steps.forEach((step, i) => {
      if (seen.has(step.id)) {
        context.addIssue({ code: 'custom', path: ['steps', i, 'id'], message: 'is used twice' });
      }
      seen.add(step.id);
    });
  });

  return { routeStepSchema, routeSchema };
}

/** The schemas a pack's routes are written with: strict. */
export const { routeStepSchema, routeSchema } = routeSchemas('write');
/** The same for reading: tolerant. */
export const routeReadSchemas = routeSchemas('read');
/** The schemas of a person's own routes, with own ids. */
const ownRouteWrite = routeSchemas('write', { own: true });

export type RouteStep = z.infer<typeof routeStepSchema>;
export type Route = z.infer<typeof routeSchema>;

/**
 * A pack's `routes.json`, read tolerantly: each route that cannot be read
 * is left out, not the pack.
 */
export const routesReadSchema = z
  .array(z.unknown())
  .max(MAX_ROUTES)
  .transform((list) =>
    list.flatMap((value) => {
      const route = routeReadSchemas.routeSchema.safeParse(value);
      return route.success ? [route.data] : [];
    }),
  ) as unknown as z.ZodType<Route[]>;

/** A pack's `routes.json`, written strictly. */
export const routesWriteSchema = z.array(routeSchema).max(MAX_ROUTES);

// ---------------------------------------------------------------------------
// A person's own routes

/** What the own routes file of a game says it is. */
export const OWN_ROUTES_FORMAT = 'atlas-own-routes';
/** The version of the own routes file this app writes. */
export const OWN_ROUTES_VERSION = 1;

/** One route a person made, or started from a list. */
export interface OwnRoute extends Route {
  /** The list it was started from, if it was. */
  fromList?: string;
  createdAt: string;
  updatedAt: string;
}

function ownRouteSchemaFor(mode: SchemaMode) {
  const reading = mode === 'read';
  const base = reading ? routeReadSchemas.routeSchema : ownRouteWrite.routeSchema;
  return base.and(
    (reading ? z.object : z.strictObject)({
      fromList: reading
        ? idOf('checklist').optional().catch(undefined)
        : idOf('checklist').optional(),
      createdAt: reading ? isoTime.optional().catch(undefined) : isoTime,
      updatedAt: reading ? isoTime.optional().catch(undefined) : isoTime,
    }),
  );
}

/** The strict schema of one own route: a route's fields and when it was made. */
export const ownRouteSchema = z.unknown().superRefine((value, context) => {
  if (typeof value !== 'object' || value === null) {
    context.addIssue({ code: 'custom', message: 'must be a route' });
    return;
  }
  const { fromList, createdAt, updatedAt, ...route } = value as Record<string, unknown>;
  const checked = ownRouteWrite.routeSchema.safeParse(route);
  if (!checked.success) {
    for (const issue of checked.error.issues) {
      context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }
  }
  const extra = z
    .strictObject({
      fromList: idOf('checklist').optional(),
      createdAt: isoTime,
      updatedAt: isoTime,
    })
    .safeParse({ fromList, createdAt, updatedAt });
  if (!extra.success) {
    for (const issue of extra.error.issues) {
      context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }
  }
});

export const ownRoutesFileSchema = z.strictObject({
  format: z.literal(OWN_ROUTES_FORMAT),
  version: z.literal(OWN_ROUTES_VERSION),
  gameId: gameIdSchema,
  updatedAt: isoTime,
  routes: z.array(ownRouteSchema).max(MAX_ROUTES),
});

const ownRoutesFileReadSchema = z.object({
  format: z.literal(OWN_ROUTES_FORMAT),
  version: z.int().positive(),
  gameId: gameIdSchema,
  routes: z.array(z.unknown()).catch([]),
});

/** What reading an own routes file found. */
export interface OwnRoutesRead {
  gameId: string;
  /** The file's version; later than {@link OWN_ROUTES_VERSION} when a newer app wrote it. */
  version: number;
  routes: OwnRoute[];
  /** Routes that could not be read and were left out. */
  skipped: number;
}

/** Whether every id a route names is of one game. */
function routeOfGame(route: Route, gameId: string): boolean {
  const ofGame = (id: string) => parseId(id)?.gameId === gameId;
  return (
    ofGame(route.id) &&
    route.steps.every((step) => ofGame(step.mapId) && (!step.locationId || ofGame(step.locationId)))
  );
}

/**
 * Reads an own routes file tolerantly. A route that cannot be read, is not
 * of the file's game or has an id used before is left out and counted; a
 * file that is not an own routes file at all is an error.
 */
export function readOwnRoutesFile(
  value: unknown,
): { ok: true; file: OwnRoutesRead } | { ok: false; error: string } {
  const parsed = ownRoutesFileReadSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: 'This is not a file of Atlas routes.' };
  const { gameId } = parsed.data;
  const reader = ownRouteSchemaFor('read');
  const routes: OwnRoute[] = [];
  const ids = new Set<string>();
  let skipped = 0;
  const epoch = new Date(0).toISOString();
  for (const raw of parsed.data.routes) {
    const result = reader.safeParse(raw);
    if (!result.success) {
      skipped++;
      continue;
    }
    const data = result.data as Route & {
      fromList?: string;
      createdAt?: string;
      updatedAt?: string;
    };
    if (!isOwnId(data.id) || !routeOfGame(data, gameId) || ids.has(data.id)) {
      skipped++;
      continue;
    }
    ids.add(data.id);
    routes.push({
      ...data,
      createdAt: data.createdAt ?? data.updatedAt ?? epoch,
      updatedAt: data.updatedAt ?? data.createdAt ?? epoch,
    });
  }
  return { ok: true, file: { gameId, version: parsed.data.version, routes, skipped } };
}

/** The own routes file of a game, checked strictly; throws when a route is not valid. */
export function writeOwnRoutesFile(gameId: string, routes: readonly OwnRoute[], now: Date): string {
  const file = ownRoutesFileSchema.parse({
    format: OWN_ROUTES_FORMAT,
    version: OWN_ROUTES_VERSION,
    gameId,
    updatedAt: now.toISOString(),
    routes,
  });
  for (const route of routes) {
    if (!routeOfGame(route, gameId)) {
      throw new Error(`route ${route.id} names something of another game`);
    }
  }
  return `${JSON.stringify(file, null, 2)}\n`;
}
