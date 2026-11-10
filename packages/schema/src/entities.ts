import { z } from 'zod';
import { anyIdSchema, gameIdSchema, idOf } from './ids';

/** The pack schema version this package reads and writes. */
export const SCHEMA_VERSION = 1;

const nonEmpty = z.string().trim().min(1);
const nonNegativeInt = z.int().nonnegative();
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour');
const semver = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'must be a semantic version such as 1.2.0');

/** A point in map image pixels, origin top-left: `[x, y]`. */
export const pointSchema = z.tuple([z.number(), z.number()]);

// ---------------------------------------------------------------------------
// Manifest

export const attributionSchema = z.strictObject({
  name: nonEmpty,
  url: z.url().optional(),
  license: nonEmpty.optional(),
});

/**
 * Maps ids that existed in an earlier pack version to the id that replaces
 * them, so saved progress keyed by an old id can be carried forward.
 */
export const idMigrationsSchema = z.record(anyIdSchema, anyIdSchema);

export const manifestSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  gameId: gameIdSchema,
  /** Display name of the pack. */
  title: nonEmpty,
  packVersion: semver,
  /** Game version or patch the content describes, free-form (e.g. "1.4.2"). */
  gamePatch: nonEmpty,
  attribution: z.array(attributionSchema),
  idMigrations: idMigrationsSchema,
});

// ---------------------------------------------------------------------------
// Maps and layers

/**
 * Affine transform from map image pixels to in-game world coordinates, in the
 * canvas/SVG matrix order: `worldX = a*x + c*y + e`, `worldY = b*x + d*y + f`.
 */
export const worldTransformSchema = z.strictObject({
  a: z.number(),
  b: z.number(),
  c: z.number(),
  d: z.number(),
  e: z.number(),
  f: z.number(),
});

export const mapSchema = z.strictObject({
  id: idOf('map'),
  name: nonEmpty,
  /** Full-resolution map image width in pixels. */
  width: z.int().positive(),
  /** Full-resolution map image height in pixels. */
  height: z.int().positive(),
  /** Optional mapping to in-game coordinates; absent means none is known. */
  worldTransform: worldTransformSchema.optional(),
});

const hasTileTemplate = (url: string) =>
  url.includes('{z}') && url.includes('{x}') && url.includes('{y}');

/**
 * A remote tile server that an `xyz` layer's tiles can be copied from for
 * offline use. The desktop app offers this as "Download map images"; the
 * tiles are saved unchanged at the layer's own `url`.
 */
export const remoteTileSourceSchema = z.strictObject({
  /** `https` URL template of the remote tiles, with `{z}`, `{x}` and `{y}`. */
  urlTemplate: z
    .string()
    .trim()
    .startsWith('https://')
    .refine(hasTileTemplate, 'must contain {z}, {x} and {y}'),
  /**
   * The pyramid levels that are remote tiles under other numbers: the layer's
   * tile (z, x, y) is the remote tile (sourceZ, x + offsetX, y + offsetY).
   * Listed lowest first, consecutive, ending at the layer's `maxZoom`. Levels
   * of the layer below the first one listed are made by shrinking it.
   */
  levels: z
    .array(
      z.strictObject({
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
export const tileSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    /** A single PMTiles v3 archive, read with HTTP range requests. */
    type: z.literal('pmtiles'),
    url: nonEmpty,
  }),
  z.strictObject({
    /** A folder of tiles addressed by a `{z}/{x}/{y}` URL template. */
    type: z.literal('xyz'),
    url: nonEmpty.refine(hasTileTemplate, 'must contain {z}, {x} and {y}'),
    /** Where the tiles can be downloaded from when they are not in the pack yet. */
    remote: remoteTileSourceSchema.optional(),
  }),
]);

export const layerSchema = z
  .strictObject({
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

export const regionSchema = z.strictObject({
  id: idOf('region'),
  mapId: idOf('map'),
  /** Enclosing region, or null for a top-level region. */
  parentId: idOf('region').nullable(),
  name: nonEmpty,
  /** Outline in map image pixels; implicitly closed. */
  polygon: z.array(pointSchema).min(3),
});

// ---------------------------------------------------------------------------
// Categories

export const categoryGroupSchema = z.strictObject({
  id: idOf('catgroup'),
  name: nonEmpty,
  /** Sort order within the pack, ascending. */
  order: z.int(),
});

export const categorySchema = z.strictObject({
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

export const locationSchema = z.strictObject({
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
export const entitySchema = z.strictObject({
  id: idOf('entity'),
  name: nonEmpty,
  /** Free-form kind such as "item", "npc" or "enemy". */
  kind: nonEmpty,
  description: z.string().optional(),
});

export const checklistSchema = z.strictObject({
  id: idOf('checklist'),
  name: nonEmpty,
  description: z.string().optional(),
  order: z.int(),
});

export const checklistItemSchema = z.strictObject({
  id: idOf('checkitem'),
  checklistId: idOf('checklist'),
  name: nonEmpty,
  order: z.int(),
  locationIds: z.array(idOf('loc')),
  entityIds: z.array(idOf('entity')),
});

export const guideEntrySchema = z.strictObject({
  id: idOf('guide'),
  title: nonEmpty,
  /** Markdown text. */
  body: z.string(),
  locationIds: z.array(idOf('loc')),
});

/** A directed relation between two pieces of content, e.g. a portal between two locations. */
export const linkSchema = z.strictObject({
  id: idOf('link'),
  fromId: anyIdSchema,
  toId: anyIdSchema,
  /** Free-form relation kind such as "portal" or "requires". */
  kind: nonEmpty,
  label: z.string().optional(),
});

/** A named set of visible categories. */
export const presetSchema = z.strictObject({
  id: idOf('preset'),
  name: nonEmpty,
  categoryIds: z.array(idOf('cat')),
});

export type Attribution = z.infer<typeof attributionSchema>;
export type PackManifest = z.infer<typeof manifestSchema>;
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
export type ChecklistItem = z.infer<typeof checklistItemSchema>;
export type GuideEntry = z.infer<typeof guideEntrySchema>;
export type Link = z.infer<typeof linkSchema>;
export type Preset = z.infer<typeof presetSchema>;
export type Point = z.infer<typeof pointSchema>;
