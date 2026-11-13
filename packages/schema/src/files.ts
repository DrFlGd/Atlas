import { z } from 'zod';
import {
  categoryGroupSchema,
  categorySchema,
  checklistItemSchema,
  checklistSchema,
  entitySchema,
  guideEntrySchema,
  layerSchema,
  linkSchema,
  locationSchema,
  manifestSchema,
  mapSchema,
  packReadSchemas as read,
  pictureSchema,
  presetSchema,
  regionSchema,
  sectionSchema,
} from './entities';

/**
 * Every collection a pack can hold, the JSON file it lives in (relative to the
 * pack root) and whether the file must be present. Optional files that are
 * missing load as empty collections.
 *
 * A game with no map, which holds guides and lists only, may leave out the
 * required map files ({@link MAP_COLLECTIONS}), but only all of them
 * together; they then load as empty. Atlas 0.4.4 and earlier refuse such a
 * pack, so writers keep writing them, empty.
 *
 * `schema` is the strict one packs are written and checked with;
 * `readSchema` is the tolerant one the app reads them with (see
 * `SchemaMode`).
 */
export const PACK_COLLECTIONS = {
  maps: {
    file: 'maps.json',
    required: true,
    schema: z.array(mapSchema),
    readSchema: z.array(read.mapSchema),
  },
  layers: {
    file: 'layers.json',
    required: true,
    schema: z.array(layerSchema),
    readSchema: z.array(read.layerSchema),
  },
  regions: {
    file: 'regions.json',
    required: false,
    schema: z.array(regionSchema),
    readSchema: z.array(read.regionSchema),
  },
  categoryGroups: {
    file: 'categoryGroups.json',
    required: true,
    schema: z.array(categoryGroupSchema),
    readSchema: z.array(read.categoryGroupSchema),
  },
  categories: {
    file: 'categories.json',
    required: true,
    schema: z.array(categorySchema),
    readSchema: z.array(read.categorySchema),
  },
  locations: {
    file: 'locations.json',
    required: true,
    schema: z.array(locationSchema),
    readSchema: z.array(read.locationSchema),
  },
  entities: {
    file: 'entities.json',
    required: false,
    schema: z.array(entitySchema),
    readSchema: z.array(read.entitySchema),
  },
  checklists: {
    file: 'checklists.json',
    required: false,
    schema: z.array(checklistSchema),
    readSchema: z.array(read.checklistSchema),
  },
  checklistItems: {
    file: 'checklistItems.json',
    required: false,
    schema: z.array(checklistItemSchema),
    readSchema: z.array(read.checklistItemSchema),
  },
  guides: {
    file: 'guides.json',
    required: false,
    schema: z.array(guideEntrySchema),
    readSchema: z.array(read.guideEntrySchema),
  },
  links: {
    file: 'links.json',
    required: false,
    schema: z.array(linkSchema),
    readSchema: z.array(read.linkSchema),
  },
  presets: {
    file: 'presets.json',
    required: false,
    schema: z.array(presetSchema),
    readSchema: z.array(read.presetSchema),
  },
  // Guides read as pages: their contents, and the pictures they show.
  sections: {
    file: 'sections.json',
    required: false,
    schema: z.array(sectionSchema),
    readSchema: z.array(read.sectionSchema),
  },
  pictures: {
    file: 'pictures.json',
    required: false,
    schema: z.array(pictureSchema),
    readSchema: z.array(read.pictureSchema),
  },
} as const;

/** The folder that holds a pack's pictures (see `pictures.json`). */
export const PICTURES_DIR = 'pictures';

export const MANIFEST_FILE = 'manifest.json';

/** The required files that a game with no map may leave out, all of them together. */
export const MAP_COLLECTIONS = [
  'maps',
  'layers',
  'categoryGroups',
  'categories',
  'locations',
] as const satisfies readonly (keyof typeof PACK_COLLECTIONS)[];

export type CollectionName = keyof typeof PACK_COLLECTIONS;

export const COLLECTION_NAMES = Object.keys(PACK_COLLECTIONS) as CollectionName[];

function noneWhenEmpty<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}

/** The full, parsed contents of a pack, checked strictly: for packs being written. */
export const packDataSchema = z.strictObject({
  manifest: manifestSchema,
  maps: PACK_COLLECTIONS.maps.schema,
  layers: PACK_COLLECTIONS.layers.schema,
  regions: PACK_COLLECTIONS.regions.schema,
  categoryGroups: PACK_COLLECTIONS.categoryGroups.schema,
  categories: PACK_COLLECTIONS.categories.schema,
  locations: PACK_COLLECTIONS.locations.schema,
  entities: PACK_COLLECTIONS.entities.schema,
  checklists: PACK_COLLECTIONS.checklists.schema,
  checklistItems: PACK_COLLECTIONS.checklistItems.schema,
  guides: PACK_COLLECTIONS.guides.schema,
  links: PACK_COLLECTIONS.links.schema,
  presets: PACK_COLLECTIONS.presets.schema,
  // Optional, so packs made before them stay valid as they are; an empty
  // file reads as none, so a pack written with one reads back the same.
  sections: PACK_COLLECTIONS.sections.schema.transform(noneWhenEmpty).optional(),
  pictures: PACK_COLLECTIONS.pictures.schema.transform(noneWhenEmpty).optional(),
});

/**
 * The full contents of a pack, read tolerantly: what this app does not know
 * is skipped (see `SchemaMode`). For packs being shown.
 */
export const packDataReadSchema = z.object({
  manifest: read.manifestSchema,
  maps: PACK_COLLECTIONS.maps.readSchema,
  layers: PACK_COLLECTIONS.layers.readSchema,
  regions: PACK_COLLECTIONS.regions.readSchema,
  categoryGroups: PACK_COLLECTIONS.categoryGroups.readSchema,
  categories: PACK_COLLECTIONS.categories.readSchema,
  locations: PACK_COLLECTIONS.locations.readSchema,
  entities: PACK_COLLECTIONS.entities.readSchema,
  checklists: PACK_COLLECTIONS.checklists.readSchema,
  checklistItems: PACK_COLLECTIONS.checklistItems.readSchema,
  guides: PACK_COLLECTIONS.guides.readSchema,
  links: PACK_COLLECTIONS.links.readSchema,
  presets: PACK_COLLECTIONS.presets.readSchema,
  sections: PACK_COLLECTIONS.sections.readSchema.optional(),
  pictures: PACK_COLLECTIONS.pictures.readSchema.optional(),
});

export type PackData = z.infer<typeof packDataSchema>;
