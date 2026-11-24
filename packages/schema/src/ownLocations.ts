import { z } from 'zod';
import {
  ownRecordWriteSchemas,
  packReadSchemas,
  MAX_PHOTOS,
  type Category,
  type CategoryGroup,
  type Picture,
  type Region,
  type SchemaMode,
} from './entities';
import { gameIdSchema, idOf, isOwnId, OWN_ID_PREFIX, parseId } from './ids';
import { MAX_OWN_PICTURES, ownPictureFile } from './ownPictures';

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
 * A location may have photos (`photos`), the person's own pictures kept in
 * the file's `pictures` (see `ownPictures.ts`), and a height (`height`), as
 * a pack's location may: where it was put on a 3D map. The height is
 * optional and read tolerantly, so the file keeps its version.
 *
 * The person's own names of the game's maps and levels (`names`): each with
 * the id of the map or level (a layer), the name the person gave, and the
 * name the source gave it when they renamed it (`original`). The pack's own
 * name is never changed: a name here is shown in its place wherever the map
 * or level is named, and taking it out ("Use the original name") shows the
 * pack's name again. A name of a map or level the game does not have (now)
 * is kept, and shown again if the map comes back. A file with names is
 * version 2, so an app older than names shows its locations and does not
 * write over them (and so over the names); one without names stays version
 * 1.
 *
 * The person's own colour and icon of types of the game's pack
 * (`typeLooks`): each with the id of a type of the pack, and the colour
 * (`color`, `#rrggbb`) or the icon (`icon`), or both, that the person chose
 * for it. As with names, the pack's type is never changed: the type is
 * shown with them wherever it is shown (the map, the 3D view, the filters,
 * search, cards, lists), and taking them out ("Back to the pack's own")
 * shows the pack's again. A look of a type the pack does not have (now) is
 * kept for when it comes back. A file with type looks is version 3, so an
 * app older than them shows its locations and does not write over them.
 * The person's own types are changed in place, never here.
 *
 * Written strictly and read tolerantly: one record that cannot be read is
 * left out, not the file.
 */

/** What the own locations file of a game says it is. */
export const OWN_LOCATIONS_FORMAT = 'atlas-own-locations';
/** The newest version of the own locations file this app reads and writes: with type looks. */
export const OWN_LOCATIONS_VERSION = 3;
/** The version of a file with names of maps and levels but no type looks. */
export const OWN_LOCATIONS_VERSION_WITH_NAMES = 2;
/** The version of a file without names, which every app since own locations reads. */
export const OWN_LOCATIONS_VERSION_WITHOUT_NAMES = 1;
/** The most names of maps and levels one file may hold. */
export const MAX_OWN_NAMES = 2000;
/** The most type looks one file may hold. */
export const MAX_OWN_TYPE_LOOKS = 2000;
/** The longest icon name a type look may give (the app draws one it does not know as a pin). */
export const MAX_ICON_NAME_LENGTH = 40;

/** A colour as types have it: `#rrggbb`. */
export const TYPE_COLOUR = /^#[0-9a-fA-F]{6}$/;

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
    x: z.number(),
    y: z.number(),
    /** The pack's type or an own one. */
    categoryId: idOf('cat'),
    /** The pack's area or an own one, or none. */
    regionId: idOf('region').nullable(),
    name,
    note: reading
      ? z.string().max(MAX_OWN_NOTE_LENGTH).optional().catch(undefined)
      : z.string().max(MAX_OWN_NOTE_LENGTH).optional(),
    /**
     * Its height in the game's world, in the units of its map's
     * `worldTransform`, as a pack's location has it (see `scene.ts`): put
     * on a 3D map, it is the height of the surface pressed. Absent: it
     * sits on the model's surface below it. An app before heights leaves
     * it out when it reads the file, and the location then sits on the
     * surface.
     */
    height: reading ? z.number().optional().catch(undefined) : z.number().optional(),
    /** Photos of the location: the person's own pictures (in `pictures`) or the pack's. */
    photos: reading
      ? z.array(packReadSchemas.photoSchema).optional().catch(undefined)
      : z.array(ownRecordWriteSchemas.photoSchema).max(MAX_PHOTOS).optional(),
    createdAt: time,
    updatedAt: time,
  });

  /**
   * The person's name of a map or a level of the game, and the source's name
   * when they gave it.
   */
  const ownNameSchema = record({
    id: z.union([idOf('map'), idOf('layer')]),
    name,
    original: reading
      ? z.string().max(MAX_OWN_NAME_LENGTH).catch('')
      : z.string().max(MAX_OWN_NAME_LENGTH),
  });

  /**
   * The person's colour and icon of a type of the pack: at least one of
   * them. Read tolerantly: a colour or icon that cannot be read is left
   * out, and a look left with neither is left out.
   */
  const ownTypeLookSchema = record({
    id: idOf('cat'),
    color: reading
      ? z.string().regex(TYPE_COLOUR).optional().catch(undefined)
      : z.string().regex(TYPE_COLOUR).optional(),
    icon: reading
      ? z.string().trim().min(1).max(MAX_ICON_NAME_LENGTH).optional().catch(undefined)
      : z.string().min(1).max(MAX_ICON_NAME_LENGTH).optional(),
  }).refine((look) => look.color !== undefined || look.icon !== undefined, {
    message: 'must give a colour or an icon',
  });

  /** A person's own picture, named as `ownPictureFile` says. */
  const ownPictureSchema = (
    reading ? packReadSchemas.pictureSchema : ownRecordWriteSchemas.pictureSchema
  ).refine(
    (picture) => ownPictureFile(picture) !== null,
    'must be an own picture: an own id, with pictures/<its local id>.jpg, .png or .webp',
  );

  const own = <T extends z.ZodType<{ id: string }>>(schema: T) =>
    schema.refine((value) => isOwnId(value.id), { message: 'must be an own id', path: ['id'] });

  const ownLocationsFileSchema = record({
    format: z.literal(OWN_LOCATIONS_FORMAT),
    version: reading
      ? z.int().positive()
      : z.union([
          z.literal(OWN_LOCATIONS_VERSION_WITHOUT_NAMES),
          z.literal(OWN_LOCATIONS_VERSION_WITH_NAMES),
          z.literal(OWN_LOCATIONS_VERSION),
        ]),
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
    /** The person's own photos of their locations. */
    pictures: reading
      ? z.array(z.unknown()).optional().catch(undefined)
      : z.array(ownPictureSchema).max(MAX_OWN_PICTURES).optional(),
    /** The person's names of maps and levels. */
    names: reading
      ? z.array(z.unknown()).optional().catch(undefined)
      : z.array(ownNameSchema).max(MAX_OWN_NAMES).optional(),
    /** The person's colours and icons of the pack's types. */
    typeLooks: reading
      ? z.array(z.unknown()).optional().catch(undefined)
      : z.array(ownTypeLookSchema).max(MAX_OWN_TYPE_LOOKS).optional(),
  });

  return {
    ownLocationSchema,
    ownNameSchema,
    ownTypeLookSchema,
    ownPictureSchema,
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

/** A person's name of a map or a level, with the source's name when they gave it. */
export interface OwnName {
  /** The map's or the level's (layer's) id. */
  id: string;
  name: string;
  /** What the source called it when the person renamed it; kept, never shown in its place. */
  original: string;
}

/**
 * The person's colour and icon of a type of the game's pack, in place of
 * the pack's: at least one of them.
 */
export interface OwnTypeLook {
  /** The id of the pack's type. */
  id: string;
  /** `#rrggbb`, lower case. */
  color?: string;
  /** An icon name (see `ICON_NAMES`). */
  icon?: string;
}

/** A game's own locations, types, type groups and areas. */
export interface OwnLocations {
  categoryGroups: CategoryGroup[];
  categories: Category[];
  regions: Region[];
  locations: OwnLocation[];
  /** The person's own photos of their locations; absent when there are none. */
  pictures?: Picture[];
  /** The person's names of maps and levels; absent when there are none. */
  names?: OwnName[];
  /** The person's colours and icons of the pack's types; absent when there are none. */
  typeLooks?: OwnTypeLook[];
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
      ...(l.photos ?? []).map((photo) => photo.picture),
    ]),
  };
  const pictures = take(parsed.data.pictures ?? [], read.ownPictureSchema, () => []);
  if (pictures.length > 0) own.pictures = pictures;
  const names = take(parsed.data.names ?? [], read.ownNameSchema, () => []);
  if (names.length > 0) own.names = names;
  const looks = take(parsed.data.typeLooks ?? [], read.ownTypeLookSchema, () => []).map(
    (look): OwnTypeLook => ({
      id: look.id,
      ...(look.color !== undefined ? { color: look.color.toLowerCase() } : {}),
      ...(look.icon !== undefined ? { icon: look.icon } : {}),
    }),
  );
  if (looks.length > 0) own.typeLooks = looks;
  return { ok: true, file: { gameId, version: parsed.data.version, own, skipped } };
}

/** The own locations file of a game, checked strictly; throws when a record is not valid. */
export function writeOwnLocationsFile(gameId: string, own: OwnLocations, now: Date): string {
  const { pictures, names, typeLooks, ...records } = own;
  const named = names !== undefined && names.length > 0;
  const looked = typeLooks !== undefined && typeLooks.length > 0;
  const file = ownLocationsFileSchema.parse({
    format: OWN_LOCATIONS_FORMAT,
    version: looked
      ? OWN_LOCATIONS_VERSION
      : named
        ? OWN_LOCATIONS_VERSION_WITH_NAMES
        : OWN_LOCATIONS_VERSION_WITHOUT_NAMES,
    gameId,
    updatedAt: now.toISOString(),
    ...records,
    ...(pictures && pictures.length > 0 ? { pictures } : {}),
    ...(named ? { names } : {}),
    ...(looked ? { typeLooks } : {}),
  });
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * How many records there are, names of maps and levels and type looks
 * among them: for messages and the map pack file's description.
 */
export function countOwnLocations(own: OwnLocations): number {
  return (
    own.locations.length +
    own.categories.length +
    own.categoryGroups.length +
    own.regions.length +
    (own.names?.length ?? 0) +
    (own.typeLooks?.length ?? 0)
  );
}
