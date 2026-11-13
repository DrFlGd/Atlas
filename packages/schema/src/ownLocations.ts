import { z } from 'zod';
import {
  ownRecordWriteSchemas,
  packReadSchemas,
  type Category,
  type CategoryGroup,
  type Region,
  type SchemaMode,
} from './entities';
import { gameIdSchema, idOf, isOwnId, OWN_ID_PREFIX, parseId } from './ids';

/**
 * A person's own locations, types (`categories` in code), type groups and
 * areas (`regions`) of one game, kept apart from every pack, as own lists
 * are (see `ownLists.ts`).
 *
 * They are added to the game's own when it is shown (see `mergeOwnLocations`
 * in the core package), so they are on the map, in the filters, search,
 * counts, found marks and lists like any other. A pack's files are replaced
 * when the pack is refreshed, rebuilt or imported again, so nothing here is
 * ever written into them: in the desktop app they are a file of their own
 * beside the game's folder in the maps folder (`<game id>.my-locations.json`);
 * elsewhere they are kept where progress is.
 *
 * Every id is the game's, with a local id that starts with
 * {@link OWN_ID_PREFIX}, which packs may not use, so they never collide with
 * a pack's. A location may be of the pack's types and in the pack's areas
 * as well as of its own.
 *
 * Written strictly and read tolerantly: one record that cannot be read is
 * left out, not the file.
 */

/** What the own locations file of a game says it is. */
export const OWN_LOCATIONS_FORMAT = 'atlas-own-locations';
/** The version of the own locations file this app writes. */
export const OWN_LOCATIONS_VERSION = 1;

/** The longest name of a location, type, group or area. */
export const MAX_OWN_NAME_LENGTH = 200;
/** The longest note of a location. */
export const MAX_OWN_NOTE_LENGTH = 20_000;

const isoTime = z.iso.datetime({ offset: true });

/** An own id of one kind. */
export function ownRecordIdOf(kind: 'loc' | 'cat' | 'catgroup' | 'region') {
  return idOf(kind).refine(isOwnId, `must be an own id (local id starting with ${OWN_ID_PREFIX})`);
}

function ownLocationSchemas(mode: SchemaMode) {
  const reading = mode === 'read';
  const pack = reading ? packReadSchemas : ownRecordWriteSchemas;
  const record = <T extends z.core.$ZodLooseShape>(shape: T) =>
    reading
      ? z.object(shape)
      : (z.strictObject(shape) as unknown as ReturnType<typeof z.object<T>>);
  const name = z.string().trim().min(1).max(MAX_OWN_NAME_LENGTH);
  const time = reading ? isoTime.optional().catch(undefined) : isoTime.optional();

  /**
   * A location a person put on a map. It has what the app shows of a pack's
   * location, and a note of its own (Markdown, shown as its note).
   */
  const ownLocationSchema = record({
    id: ownRecordIdOf('loc'),
    mapId: idOf('map'),
    layerId: idOf('layer'),
    /** Map image pixel, origin top-left. */
    x: z.number().finite(),
    y: z.number().finite(),
    /** The pack's type or an own one. */
    categoryId: idOf('cat'),
    /** The pack's area or an own one, or none. */
    regionId: idOf('region').nullable(),
    name,
    note: reading
      ? z.string().max(MAX_OWN_NOTE_LENGTH).optional().catch(undefined)
      : z.string().max(MAX_OWN_NOTE_LENGTH).optional(),
    createdAt: time,
    updatedAt: time,
  });

  const own = <T extends z.ZodType<{ id: string }>>(schema: T) =>
    schema.refine((value) => isOwnId(value.id), { message: 'must be an own id', path: ['id'] });

  const ownLocationsFileSchema = record({
    format: z.literal(OWN_LOCATIONS_FORMAT),
    version: reading ? z.int().positive() : z.literal(OWN_LOCATIONS_VERSION),
    gameId: gameIdSchema,
    updatedAt: reading ? isoTime.optional().catch(undefined) : isoTime,
    // Read one record at a time (see `readOwnLocationsFile`), so one that
    // cannot be read does not lose the others.
    categoryGroups: reading
      ? z.array(z.unknown()).catch([])
      : z.array(own(pack.categoryGroupSchema)),
    categories: reading ? z.array(z.unknown()).catch([]) : z.array(own(pack.categorySchema)),
    regions: reading ? z.array(z.unknown()).catch([]) : z.array(own(pack.regionSchema)),
    locations: reading ? z.array(z.unknown()).catch([]) : z.array(ownLocationSchema),
  });

  return {
    ownLocationSchema,
    ownTypeGroupSchema: own(pack.categoryGroupSchema),
    ownTypeSchema: own(pack.categorySchema),
    ownAreaSchema: own(pack.regionSchema),
    ownLocationsFileSchema,
  };
}

/** The schemas this file is written with: strict. */
export const { ownLocationSchema, ownLocationsFileSchema } = ownLocationSchemas('write');

/** The same schemas for reading: tolerant (see {@link SchemaMode}). */
export const ownLocationReadSchemas = ownLocationSchemas('read');

/** A location a person put on a map. */
export type OwnLocation = z.infer<typeof ownLocationSchema>;

/** A game's own locations, types, type groups and areas. */
export interface OwnLocations {
  categoryGroups: CategoryGroup[];
  categories: Category[];
  regions: Region[];
  locations: OwnLocation[];
}

/** Nothing of one's own yet. */
export const NO_OWN_LOCATIONS: OwnLocations = {
  categoryGroups: [],
  categories: [],
  regions: [],
  locations: [],
};

/** What reading an own locations file found. */
export interface OwnLocationsRead {
  gameId: string;
  /** The file's version; later than {@link OWN_LOCATIONS_VERSION} when a newer app wrote it. */
  version: number;
  own: OwnLocations;
  /** Records that could not be read and were left out. */
  skipped: number;
}

/**
 * Reads an own locations file tolerantly. A record that cannot be read, is
 * not of the file's game, or has an id used before, is left out and
 * counted; a file that is not an own locations file at all is an error.
 */
export function readOwnLocationsFile(
  value: unknown,
): { ok: true; file: OwnLocationsRead } | { ok: false; error: string } {
  const read = ownLocationReadSchemas;
  const parsed = read.ownLocationsFileSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: 'This is not a file of Atlas locations and types.' };
  }
  const { gameId } = parsed.data;
  const ids = new Set<string>();
  let skipped = 0;
  const ofGame = (id: string | null) => id === null || parseId(id)?.gameId === gameId;
  const take = <T extends { id: string }>(
    raw: readonly unknown[],
    schema: z.ZodType<T>,
    refs: (record: T) => (string | null)[],
  ): T[] => {
    const out: T[] = [];
    for (const item of raw) {
      const result = schema.safeParse(item);
      if (
        !result.success ||
        !ofGame(result.data.id) ||
        !refs(result.data).every(ofGame) ||
        ids.has(result.data.id)
      ) {
        skipped++;
        continue;
      }
      ids.add(result.data.id);
      out.push(result.data);
    }
    return out;
  };
  const own: OwnLocations = {
    categoryGroups: take(parsed.data.categoryGroups, read.ownTypeGroupSchema, () => []),
    categories: take(parsed.data.categories, read.ownTypeSchema, (c) => [c.groupId]),
    regions: take(parsed.data.regions, read.ownAreaSchema, (r) => [r.mapId, r.parentId]),
    locations: take(parsed.data.locations, read.ownLocationSchema, (l) => [
      l.mapId,
      l.layerId,
      l.categoryId,
      l.regionId,
    ]),
  };
  return { ok: true, file: { gameId, version: parsed.data.version, own, skipped } };
}

/** The own locations file of a game, checked strictly; throws when a record is not valid. */
export function writeOwnLocationsFile(gameId: string, own: OwnLocations, now: Date): string {
  const file = ownLocationsFileSchema.parse({
    format: OWN_LOCATIONS_FORMAT,
    version: OWN_LOCATIONS_VERSION,
    gameId,
    updatedAt: now.toISOString(),
    ...own,
  });
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** How many records there are: for messages and the map pack file's description. */
export function countOwnLocations(own: OwnLocations): number {
  return (
    own.locations.length + own.categories.length + own.categoryGroups.length + own.regions.length
  );
}
