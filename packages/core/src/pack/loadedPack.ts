import type {
  Category,
  CategoryGroup,
  Layer,
  Location,
  MapDef,
  PackData,
  PackManifest,
  Region,
} from '@atlas/schema';

/** A validated pack with lookup tables, as returned by `loadPack`. */
export interface LoadedPack {
  /** Absolute URL of the pack root, ending in `/`. */
  readonly baseUrl: URL;
  readonly manifest: PackManifest;
  readonly data: PackData;
  readonly maps: ReadonlyMap<string, MapDef>;
  readonly layers: ReadonlyMap<string, Layer>;
  readonly regions: ReadonlyMap<string, Region>;
  readonly categoryGroups: ReadonlyMap<string, CategoryGroup>;
  readonly categories: ReadonlyMap<string, Category>;
  readonly locations: ReadonlyMap<string, Location>;
  /** Layers of a map, in pack order. */
  layersOf(mapId: string): Layer[];
  /** Locations on a layer, in pack order. */
  locationsOn(layerId: string): Location[];
  /**
   * Absolute URL for a path relative to the pack root. `{` and `}` are kept
   * as-is so tile URL templates such as `{z}/{x}/{y}.webp` survive.
   */
  resolveUrl(relative: string): string;
  /**
   * Follows the manifest's id migrations to the id that is current in this
   * pack. Ids that were never migrated are returned unchanged.
   */
  readonly currentId: (id: string) => string;
  /**
   * The section of its page an id leads to on the way to the current id
   * (the manifest's `idSections`, for another name of a page that a site
   * forwards to a part of the page), or null when it names none.
   */
  readonly sectionOf: (id: string) => string | null;
  /**
   * The pack's home page (the manifest's `homePage`, a wiki's main page),
   * by its current id, when the pack has that guide; otherwise null.
   */
  readonly homePage: string | null;
}

const byId = <T extends { id: string }>(items: readonly T[]) =>
  new Map(items.map((item) => [item.id, item] as const));

/** Builds lookup tables over already validated pack data. */
export function indexPack(data: PackData, baseUrl: URL): LoadedPack {
  const locationsByLayer = new Map<string, Location[]>();
  for (const location of data.locations) {
    const list = locationsByLayer.get(location.layerId);
    if (list) list.push(location);
    else locationsByLayer.set(location.layerId, [location]);
  }
  const migrations = data.manifest.idMigrations;
  const sections = data.manifest.idSections ?? {};
  const currentId = (id: string) => {
    let current = id;
    // Bounded so a migration cycle in a hand-written pack cannot hang the app.
    for (let hops = 0; hops < 32 && migrations[current] !== undefined; hops++) {
      current = migrations[current]!;
    }
    return current;
  };
  const home = data.manifest.homePage ? currentId(data.manifest.homePage) : null;

  return {
    baseUrl,
    manifest: data.manifest,
    data,
    maps: byId(data.maps),
    layers: byId(data.layers),
    regions: byId(data.regions),
    categoryGroups: byId(data.categoryGroups),
    categories: byId(data.categories),
    locations: byId(data.locations),
    layersOf: (mapId) => data.layers.filter((layer) => layer.mapId === mapId),
    locationsOn: (layerId) => locationsByLayer.get(layerId) ?? [],
    resolveUrl: (relative) =>
      new URL(relative, baseUrl).href.replace(/%7B/gi, '{').replace(/%7D/gi, '}'),
    currentId,
    sectionOf: (id) => {
      let current = id;
      for (let hops = 0; hops < 32 && migrations[current] !== undefined; hops++) {
        const section = sections[current];
        if (section) return section;
        current = migrations[current]!;
      }
      return null;
    },
    homePage: home !== null && data.guides.some((guide) => guide.id === home) ? home : null,
  };
}
