import { z } from 'zod';
import { anyIdSchema, gameIdSchema, idOf } from './ids';

/**
 * The pack schema version this package writes. Version 2 adds the optional
 * descriptive fields of the manifest (see {@link manifestSchema}); version 1
 * packs, which have none of them, are still read.
 */
export const SCHEMA_VERSION = 2;

/** Every pack schema version this package reads. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2];

const nonEmpty = z.string().trim().min(1);
const nonNegativeInt = z.int().nonnegative();
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour');
const semver = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'must be a semantic version such as 1.2.0');

/** A point in map image pixels, origin top-left: `[x, y]`. */
export const pointSchema = z.tuple([z.number(), z.number()]);

const hasTileTemplate = (url: string) =>
  url.includes('{z}') && url.includes('{x}') && url.includes('{y}');

const LOOPBACK_HTTP = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//;

/** `https`, or plain `http` to this computer only. The desktop shell checks the same. */
export const isAllowedRemoteUrl = (url: string) =>
  url.startsWith('https://') || LOOPBACK_HTTP.test(url);

const isoTime = z.iso.datetime({ offset: true });

/**
 * Descriptive fields are informational: a value that does not have the
 * expected shape is dropped rather than making the whole pack unreadable,
 * and the app never relies on the numbers being current.
 */
const descriptive = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

/** What a list of items is to its reader, for grouping lists in the app (older packs). */
export const checklistKindSchema = z.enum(['checklist', 'guide']);

/**
 * What a list is, which decides how the app shows it (see the checklist's
 * `type`). The app's views are "By area", "By kind" and "In order".
 *
 * - `collection`: find everything of a set. Views: By area, By kind.
 * - `secrets`: a collection whose notes are solutions, with hidden text
 *   (`||like this||`) and places named in the text. Views: By area, By kind.
 * - `photos`: a collection shown with a photo per entry. Until photos are
 *   shown, it behaves as a collection.
 * - `route`: steps followed in order, with places. Views: In order (the
 *   default), By area, By kind; it has a next step.
 * - `build`: ordered steps of items, places and bosses, each with a reason.
 *   View: In order only; it has a next step.
 * - `plain`: things to do, shown as written, with no choice of view and no
 *   next step.
 */
export const checklistTypeSchema = z.enum([
  'collection',
  'secrets',
  'photos',
  'route',
  'build',
  'plain',
]);

/**
 * How a schema treats what it does not know. Packs are made strictly and
 * read tolerantly:
 *
 * - `write` (packs being made: the demo pack builder, pack checks, an
 *   importer's result): an unknown key on any record is an error, so a typo
 *   is caught where the pack is made.
 * - `read` (packs being shown: the app's loader): unknown keys are dropped,
 *   and an unknown value of an optional enum field (such as a list `type`
 *   added after this app was made) counts as if the field were absent. A
 *   pack written by a newer tool therefore still opens, without the parts
 *   this app cannot use.
 *
 * Everything else (required fields, ids, numbers, references) is checked the
 * same way in both.
 */
export type SchemaMode = 'write' | 'read';

function packSchemas(mode: SchemaMode) {
  const reading = mode === 'read';

  /** A pack record: strict when writing; unknown keys are dropped when reading. */
  const record = <T extends z.core.$ZodLooseShape>(shape: T) =>
    reading
      ? z.object(shape)
      : (z.strictObject(shape) as unknown as ReturnType<typeof z.object<T>>);

  /**
   * An optional enum field. When reading, a value it does not list (one a
   * newer pack may use) reads as absent; any other wrong value is an error.
   */
  const optionalEnum = <T extends z.ZodEnum>(values: T) =>
    reading
      ? (z
          .union([values, z.string().transform((): undefined => undefined)])
          .optional() as unknown as z.ZodOptional<T>)
      : values.optional();

  // ---------------------------------------------------------------------------
  // Manifest

  const attributionSchema = record({
    name: nonEmpty,
    url: z.url().optional(),
    license: nonEmpty.optional(),
  });

  /**
   * Maps ids that existed in an earlier pack version to the id that replaces
   * them, so saved progress keyed by an old id can be carried forward.
   */
  const idMigrationsSchema = z.record(anyIdSchema, anyIdSchema);

  const manifestBase = {
    gameId: gameIdSchema,
    /** Display name of the pack. */
    title: nonEmpty,
    packVersion: semver,
    /** Game version or patch the content describes, free-form (e.g. "1.4.2"). */
    gamePatch: nonEmpty,
    attribution: z.array(attributionSchema),
    idMigrations: idMigrationsSchema,
  };

  /** The program that wrote a pack: an app or a command-line tool, and its version. */
  const writtenBySchema = record({
    name: nonEmpty.max(100),
    version: nonEmpty.max(50),
  });

  /** Where an imported pack's content came from. Absent for packs built by hand or by a tool. */
  const packSourceSchema = record({
    importer: record({ id: nonEmpty.max(64), title: nonEmpty.max(200) }),
    /** One entry per imported page, in the order the maps appear. */
    pages: z.array(
      record({
        url: z.url(),
        /** The map the page became. */
        mapId: idOf('map').optional(),
        importedAt: isoTime,
      }),
    ),
  });

  /** The map images of one layer that are in the pack folder, as last recorded. */
  const layerImagesSchema = record({
    /** Complete pyramid levels. */
    levels: z.array(nonNegativeInt.max(24)),
    /** Every level from `minZoom` to `maxZoom` is complete. */
    complete: z.boolean(),
    /** Image files and their bytes, when last counted. */
    files: nonNegativeInt.optional(),
    bytes: nonNegativeInt.optional(),
    updatedAt: isoTime,
  });

  /** A summary of what the pack holds, for people and tools that read the manifest alone. */
  const packContentsSchema = record({
    counts: record({
      maps: nonNegativeInt,
      layers: nonNegativeInt,
      locations: nonNegativeInt,
      categories: nonNegativeInt,
      regions: nonNegativeInt,
      guides: nonNegativeInt,
    }),
    maps: z.array(
      record({
        id: idOf('map'),
        name: nonEmpty,
        width: z.int().positive(),
        height: z.int().positive(),
        locations: nonNegativeInt,
        layers: z.array(
          record({
            id: idOf('layer'),
            name: nonEmpty,
            minZoom: nonNegativeInt,
            maxZoom: nonNegativeInt.max(24),
            /** How the tiles are stored: one archive, or a `{z}/{x}/{y}` folder. */
            tiles: z.enum(['pmtiles', 'xyz']),
            /** The folder's images can be downloaded from a remote source. */
            downloadable: z.boolean(),
            images: layerImagesSchema.optional(),
          }),
        ),
      }),
    ),
  });

  /** A version 1 manifest: identity, versions and attribution only. */
  const manifestV1Schema = record({
    schemaVersion: z.literal(1),
    ...manifestBase,
  });

  /**
   * A version 2 manifest: the same fields plus an optional description of the
   * pack, so a pack folder says what it is without the app (see the root
   * README, "Data packs").
   */
  const manifestV2Schema = record({
    schemaVersion: z.literal(2),
    ...manifestBase,
    /** When the pack was first written, and when its content last changed. */
    created: descriptive(isoTime),
    updated: descriptive(isoTime),
    writtenBy: descriptive(writtenBySchema),
    source: descriptive(packSourceSchema),
    contents: descriptive(packContentsSchema),
  });

  const manifestSchema = z.discriminatedUnion('schemaVersion', [
    manifestV1Schema,
    manifestV2Schema,
  ]);

  // ---------------------------------------------------------------------------
  // Maps and layers

  /**
   * Affine transform from map image pixels to in-game world coordinates, in the
   * canvas/SVG matrix order: `worldX = a*x + c*y + e`, `worldY = b*x + d*y + f`.
   */
  const worldTransformSchema = record({
    a: z.number(),
    b: z.number(),
    c: z.number(),
    d: z.number(),
    e: z.number(),
    f: z.number(),
  });

  const mapSchema = record({
    id: idOf('map'),
    name: nonEmpty,
    /** Full-resolution map image width in pixels. */
    width: z.int().positive(),
    /** Full-resolution map image height in pixels. */
    height: z.int().positive(),
    /** Optional mapping to in-game coordinates; absent means none is known. */
    worldTransform: worldTransformSchema.optional(),
  });

  /**
   * A remote tile server that an `xyz` layer's tiles can be copied from for
   * offline use. The desktop app offers this as "Download map images"; the
   * tiles are saved unchanged at the layer's own `url`.
   */
  const remoteTileSourceSchema = record({
    /**
     * `https` URL template of the remote tiles, with `{z}`, `{x}` (column) and
     * `{y}` (row) in whatever order the source uses: `{z}/{y}/{x}` for one that
     * names the row first. Plain `http` is accepted only for this computer
     * (`127.0.0.1` or `localhost`), for tests and local mirrors.
     */
    urlTemplate: z
      .string()
      .trim()
      .refine(isAllowedRemoteUrl, 'must be an https URL')
      .refine(hasTileTemplate, 'must contain {z}, {x} and {y}'),
    /**
     * The pyramid levels that are remote tiles under other numbers: the layer's
     * tile (z, x, y) is the remote tile (sourceZ, x + offsetX, y + offsetY).
     * Listed lowest first, consecutive, ending at the layer's `maxZoom`. Levels
     * of the layer below the first one listed are made by shrinking it.
     */
    levels: z
      .array(
        record({
          z: nonNegativeInt.max(24),
          sourceZ: nonNegativeInt.max(30),
          offsetX: nonNegativeInt,
          offsetY: nonNegativeInt,
        }),
      )
      .min(1)
      .refine(
        (levels) => levels.every((level, i) => i === 0 || level.z === levels[i - 1]!.z + 1),
        'levels must be consecutive, lowest first',
      ),
  });

  /** Where a layer's tile pyramid lives, relative to the pack root. */
  const tileSourceSchema = z.discriminatedUnion('type', [
    record({
      /** A single PMTiles v3 archive, read with HTTP range requests. */
      type: z.literal('pmtiles'),
      url: nonEmpty,
    }),
    record({
      /**
       * A folder of tiles addressed by a URL template with `{z}`, `{x}`
       * (column) and `{y}` (row), usually `{z}/{x}/{y}`; the order is free.
       */
      type: z.literal('xyz'),
      url: nonEmpty.refine(hasTileTemplate, 'must contain {z}, {x} and {y}'),
      /** Where the tiles can be downloaded from when they are not in the pack yet. */
      remote: remoteTileSourceSchema.optional(),
    }),
  ]);

  const layerSchema = record({
    id: idOf('layer'),
    mapId: idOf('map'),
    name: nonEmpty,
    tiles: tileSourceSchema,
    /** Lowest pyramid level present. */
    minZoom: nonNegativeInt,
    /**
     * Highest pyramid level present. At this level one tile pixel equals one
     * pixel of the full-resolution map image.
     */
    maxZoom: nonNegativeInt.max(24),
    /** Tile edge length in pixels; a power of two. */
    tileSize: z
      .int()
      .min(64)
      .max(1024)
      .refine((n) => (n & (n - 1)) === 0, 'must be a power of two'),
  })
    .refine((layer) => layer.minZoom <= layer.maxZoom, {
      message: 'minZoom must not exceed maxZoom',
      path: ['minZoom'],
    })
    .refine(
      (layer) => {
        if (layer.tiles.type !== 'xyz' || !layer.tiles.remote) return true;
        const { levels } = layer.tiles.remote;
        return levels[0]!.z >= layer.minZoom && levels[levels.length - 1]!.z === layer.maxZoom;
      },
      {
        message: 'remote levels must start at or above minZoom and end at maxZoom',
        path: ['tiles', 'remote', 'levels'],
      },
    );

  /**
   * A named area of a map. Locations name the region they are in, and the app
   * counts progress per region (a region includes its sub-regions).
   *
   * Both geometry fields are optional and independent. A region can have an
   * outline, a centre, both or neither: one without either still groups its
   * locations for progress, but the app cannot show where it is.
   */
  const regionSchema = record({
    id: idOf('region'),
    mapId: idOf('map'),
    /** Enclosing region, or null for a top-level region. */
    parentId: idOf('region').nullable(),
    name: nonEmpty,
    /** Outline in map image pixels; implicitly closed. Absent when the region has none. */
    polygon: z.array(pointSchema).min(3).optional(),
    /**
     * The point the map goes to for this region, in map image pixels. When
     * absent, the app goes to the middle of the outline, if there is one.
     */
    center: pointSchema.optional(),
  });

  // ---------------------------------------------------------------------------
  // Categories

  const categoryGroupSchema = record({
    id: idOf('catgroup'),
    name: nonEmpty,
    /** Sort order within the pack, ascending. */
    order: z.int(),
  });

  const categorySchema = record({
    id: idOf('cat'),
    groupId: idOf('catgroup'),
    name: nonEmpty,
    /** Icon name from the app's icon set. */
    icon: nonEmpty,
    color: hexColor,
    /** Whether locations in this category can be checked off. */
    trackable: z.boolean(),
    /** Whether the category is shown before the user changes any filter. */
    defaultVisible: z.boolean(),
  });

  // ---------------------------------------------------------------------------
  // Locations and content

  const locationSchema = record({
    id: idOf('loc'),
    mapId: idOf('map'),
    layerId: idOf('layer'),
    /** Map image pixel, origin top-left. */
    x: z.number(),
    y: z.number(),
    categoryId: idOf('cat'),
    regionId: idOf('region').nullable(),
    name: nonEmpty,
    entityIds: z.array(idOf('entity')),
    guideId: idOf('guide').nullable(),
    /** Pack version in which the location first appeared. */
    since: semver,
    /** Game save-file flag that marks this location as done, when known. */
    flagId: nonEmpty.optional(),
  });

  /** Something in the game world that locations or checklist items refer to: an item, a character, an enemy. */
  const entitySchema = record({
    id: idOf('entity'),
    name: nonEmpty,
    /** Free-form kind such as "item", "npc" or "enemy". */
    kind: nonEmpty,
    description: z.string().optional(),
  });

  /**
   * A titled list of items. `kind` and `type` are optional and were added
   * without a schema version change: Atlas 0.3.3 and earlier refuse a pack
   * whose checklists have `kind`, and 0.4.4 and earlier one whose checklists
   * have `type`. Later apps read packs tolerantly (see {@link SchemaMode}).
   */
  const checklistSchema = record({
    id: idOf('checklist'),
    name: nonEmpty,
    description: z.string().optional(),
    order: z.int(),
    /**
     * `checklist` (the default when absent): things to do or collect.
     * `guide`: a route or guide that is a list of places. Apps that do not
     * know `type` list the two under separate headings; both work the same
     * way. Kept for them; `type`, when present, decides.
     */
    kind: optionalEnum(checklistKindSchema),
    /**
     * What the list is, and so how it is shown (see {@link checklistTypeSchema}).
     * When absent, the app works it out: a list of `kind: 'guide'` is a
     * route, a list with no places is plain, and any other is a collection.
     */
    type: optionalEnum(checklistTypeSchema),
  });

  /**
   * One entry of a checklist. An item that names locations is done when every
   * one of them that can be marked found is found; an item without such
   * locations (a step, a quest stage) has a done mark of its own.
   *
   * `section` and `note` are optional and were added without a schema version
   * change; Atlas 0.3.3 and earlier refuse a pack whose items have them.
   */
  const checklistItemSchema = record({
    id: idOf('checkitem'),
    checklistId: idOf('checklist'),
    name: nonEmpty,
    order: z.int(),
    locationIds: z.array(idOf('loc')),
    entityIds: z.array(idOf('entity')),
    /**
     * The heading the item is listed under. Items in `order` that share a
     * section are shown together under one heading.
     */
    section: nonEmpty.max(200).optional(),
    /** A short note in Markdown, shown under the item's name. */
    note: z.string().optional(),
  });

  /**
   * A guide in Markdown. A guide that belongs to exactly one location is that
   * location's note; any other guide (a walkthrough page, a chapter) is listed
   * on its own.
   *
   * `order` is optional and was added without a schema version change; Atlas
   * 0.3.3 and earlier refuse a pack whose guides have it.
   */
  const guideEntrySchema = record({
    id: idOf('guide'),
    title: nonEmpty,
    /** Markdown text. */
    body: z.string(),
    locationIds: z.array(idOf('loc')),
    /** Place in the list of guides, ascending; guides without one follow, by title. */
    order: z.int().optional(),
  });

  /** A directed relation between two pieces of content, e.g. a portal between two locations. */
  const linkSchema = record({
    id: idOf('link'),
    fromId: anyIdSchema,
    toId: anyIdSchema,
    /** Free-form relation kind such as "portal" or "requires". */
    kind: nonEmpty,
    label: z.string().optional(),
  });

  /** A named set of visible categories. */
  const presetSchema = record({
    id: idOf('preset'),
    name: nonEmpty,
    categoryIds: z.array(idOf('cat')),
  });

  return {
    attributionSchema,
    idMigrationsSchema,
    writtenBySchema,
    packSourceSchema,
    layerImagesSchema,
    packContentsSchema,
    manifestV1Schema,
    manifestV2Schema,
    manifestSchema,
    worldTransformSchema,
    mapSchema,
    remoteTileSourceSchema,
    tileSourceSchema,
    layerSchema,
    regionSchema,
    categoryGroupSchema,
    categorySchema,
    locationSchema,
    entitySchema,
    checklistSchema,
    checklistItemSchema,
    guideEntrySchema,
    linkSchema,
    presetSchema,
  };
}

/** The schemas packs are written with: strict (see {@link SchemaMode}). */
export const {
  attributionSchema,
  idMigrationsSchema,
  writtenBySchema,
  packSourceSchema,
  layerImagesSchema,
  packContentsSchema,
  manifestV1Schema,
  manifestV2Schema,
  manifestSchema,
  worldTransformSchema,
  mapSchema,
  remoteTileSourceSchema,
  tileSourceSchema,
  layerSchema,
  regionSchema,
  categoryGroupSchema,
  categorySchema,
  locationSchema,
  entitySchema,
  checklistSchema,
  checklistItemSchema,
  guideEntrySchema,
  linkSchema,
  presetSchema,
} = packSchemas('write');

/**
 * The same schemas for reading a pack: unknown keys and unknown values of
 * optional enum fields are skipped (see {@link SchemaMode}). Their output
 * types are those of the written schemas.
 */
export const packReadSchemas = packSchemas('read');

export type Attribution = z.infer<typeof attributionSchema>;
export type PackManifest = z.infer<typeof manifestSchema>;
export type PackManifestV2 = z.infer<typeof manifestV2Schema>;
export type PackContents = z.infer<typeof packContentsSchema>;
export type PackSource = z.infer<typeof packSourceSchema>;
export type LayerImages = z.infer<typeof layerImagesSchema>;
export type WrittenBy = z.infer<typeof writtenBySchema>;
export type WorldTransform = z.infer<typeof worldTransformSchema>;
export type MapDef = z.infer<typeof mapSchema>;
export type TileSource = z.infer<typeof tileSourceSchema>;
export type RemoteTileSource = z.infer<typeof remoteTileSourceSchema>;
export type Layer = z.infer<typeof layerSchema>;
export type Region = z.infer<typeof regionSchema>;
export type CategoryGroup = z.infer<typeof categoryGroupSchema>;
export type Category = z.infer<typeof categorySchema>;
export type Location = z.infer<typeof locationSchema>;
export type Entity = z.infer<typeof entitySchema>;
export type Checklist = z.infer<typeof checklistSchema>;
export type ChecklistKind = z.infer<typeof checklistKindSchema>;
export type ChecklistType = z.infer<typeof checklistTypeSchema>;
export type ChecklistItem = z.infer<typeof checklistItemSchema>;
export type GuideEntry = z.infer<typeof guideEntrySchema>;
export type Link = z.infer<typeof linkSchema>;
export type Preset = z.infer<typeof presetSchema>;
export type Point = z.infer<typeof pointSchema>;
