import {
  SCHEMA_VERSION,
  type LayerImages,
  type PackContents,
  type PackManifestV2,
  type PackSource,
  type WrittenBy,
} from './entities';
import type { PackData } from './files';

/** What a writer knows about a pack beyond its data. */
export interface PackDescription {
  /** When the pack was first written; kept from the previous manifest when absent. */
  created?: string;
  /** When the pack's content last changed. */
  updated: string;
  writtenBy: WrittenBy;
  /** Where an imported pack came from; leave out for packs built by hand or by a tool. */
  source?: PackSource;
  /** Image summaries to keep, by layer id (for example from the previous manifest). */
  images?: ReadonlyMap<string, LayerImages>;
}

/** The `contents` block of a manifest, computed from the pack's data. */
export function describeContents(
  data: Omit<PackData, 'manifest'>,
  images: ReadonlyMap<string, LayerImages> = new Map(),
): PackContents {
  const locationsPerMap = new Map<string, number>();
  for (const location of data.locations) {
    locationsPerMap.set(location.mapId, (locationsPerMap.get(location.mapId) ?? 0) + 1);
  }
  return {
    counts: {
      maps: data.maps.length,
      layers: data.layers.length,
      locations: data.locations.length,
      categories: data.categories.length,
      regions: data.regions.length,
      guides: data.guides.length,
    },
    maps: data.maps.map((map) => ({
      id: map.id,
      name: map.name,
      width: map.width,
      height: map.height,
      locations: locationsPerMap.get(map.id) ?? 0,
      layers: data.layers
        .filter((layer) => layer.mapId === map.id)
        .map((layer) => {
          const kept = images.get(layer.id);
          return {
            id: layer.id,
            name: layer.name,
            minZoom: layer.minZoom,
            maxZoom: layer.maxZoom,
            tiles: layer.tiles.type,
            downloadable: layer.tiles.type === 'xyz' && layer.tiles.remote !== undefined,
            ...(kept ? { images: kept } : {}),
          };
        }),
    })),
  };
}

/** The image summaries recorded in a manifest, by layer id. */
export function recordedImages(manifest: PackData['manifest']): Map<string, LayerImages> {
  const images = new Map<string, LayerImages>();
  if (manifest.schemaVersion !== 2) return images;
  for (const map of manifest.contents?.maps ?? []) {
    for (const layer of map.layers) if (layer.images) images.set(layer.id, layer.images);
  }
  return images;
}

/**
 * A version 2 manifest for `data`: its identity fields, plus a description
 * of the pack computed from the data and `info`. Field order is fixed, so
 * the same input always gives the same file.
 */
export function describePack(data: PackData, info: PackDescription): PackManifestV2 {
  const previous = data.manifest;
  const created =
    info.created ?? (previous.schemaVersion === 2 ? previous.created : undefined) ?? info.updated;
  return {
    schemaVersion: SCHEMA_VERSION,
    gameId: previous.gameId,
    title: previous.title,
    packVersion: previous.packVersion,
    gamePatch: previous.gamePatch,
    attribution: previous.attribution,
    idMigrations: previous.idMigrations,
    created,
    updated: info.updated,
    writtenBy: info.writtenBy,
    ...(info.source ? { source: info.source } : {}),
    contents: describeContents(data, info.images ?? recordedImages(previous)),
  };
}
