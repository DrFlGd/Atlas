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
  presetSchema,
  regionSchema,
} from './entities';

/**
 * Every collection a pack can hold, the JSON file it lives in (relative to the
 * pack root) and whether the file must be present. Optional files that are
 * missing load as empty collections.
 */
export const PACK_COLLECTIONS = {
  maps: { file: 'maps.json', required: true, schema: z.array(mapSchema) },
  layers: { file: 'layers.json', required: true, schema: z.array(layerSchema) },
  regions: { file: 'regions.json', required: false, schema: z.array(regionSchema) },
  categoryGroups: {
    file: 'categoryGroups.json',
    required: true,
    schema: z.array(categoryGroupSchema),
  },
  categories: { file: 'categories.json', required: true, schema: z.array(categorySchema) },
  locations: { file: 'locations.json', required: true, schema: z.array(locationSchema) },
  entities: { file: 'entities.json', required: false, schema: z.array(entitySchema) },
  checklists: { file: 'checklists.json', required: false, schema: z.array(checklistSchema) },
  checklistItems: {
    file: 'checklistItems.json',
    required: false,
    schema: z.array(checklistItemSchema),
  },
  guides: { file: 'guides.json', required: false, schema: z.array(guideEntrySchema) },
  links: { file: 'links.json', required: false, schema: z.array(linkSchema) },
  presets: { file: 'presets.json', required: false, schema: z.array(presetSchema) },
} as const;

export const MANIFEST_FILE = 'manifest.json';

export type CollectionName = keyof typeof PACK_COLLECTIONS;

export const COLLECTION_NAMES = Object.keys(PACK_COLLECTIONS) as CollectionName[];

/** The full, parsed contents of a pack. */
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
});

export type PackData = z.infer<typeof packDataSchema>;
