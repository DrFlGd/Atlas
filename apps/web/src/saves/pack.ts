import type { PackForMatching } from '@atlas/saves';

/** The parts of a loaded pack the matcher reads. */
export function packForMatching(data: {
  maps: readonly PackForMatching['maps'][number][];
  categories: readonly PackForMatching['categories'][number][];
  locations: readonly PackForMatching['locations'][number][];
}): PackForMatching {
  return {
    maps: data.maps.map(({ id, name, width, height, worldTransform }) => ({
      id,
      name,
      width,
      height,
      worldTransform,
    })),
    categories: data.categories.map(({ id, name, trackable }) => ({ id, name, trackable })),
    locations: data.locations.map(({ id, mapId, x, y, categoryId, flagId }) => ({
      id,
      mapId,
      x,
      y,
      categoryId,
      flagId,
    })),
  };
}
