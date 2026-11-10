// @ts-check
/**
 * A made-up importer for tests and as an example of the importer contract
 * (`../src/index.ts`). It reads the made-up "demo map site" that the desktop
 * tests serve on this computer (`apps/desktop/e2e/demoSite.js`): pages at
 * `/demo-maps/<world>/<map>` whose script sets `window.demoMaps` some time
 * after the page has loaded.
 *
 * It is a single plain ES module with no imports, as every importer module
 * must be: the app loads it as it is.
 */

/** @typedef {import('../src/index').AtlasImporter} AtlasImporter */
/** @typedef {import('../src/index').ImportContext} ImportContext */
/** @typedef {import('../src/index').ImportOutcome} ImportOutcome */
/** @typedef {import('@atlas/schema').PackData} PackData */

/**
 * @typedef {{ id: number, name: string, kind: string, x: number, y: number }} Place
 * @typedef {{ slug: string, name: string, width: number, height: number, maxZoom: number,
 *   tiles: string }} DemoMap
 * @typedef {{ world: { slug: string, name: string }, map: DemoMap, places: Place[] }} PageData
 */

/**
 * Runs inside the page: takes only the world, the map and its places, and
 * leaves everything else the page holds (such as `window.demoMaps.account`)
 * where it is.
 */
function readPage() {
  const site = /** @type {any} */ (globalThis).demoMaps;
  if (!site || !site.loaded || !Array.isArray(site.places)) return null;
  return {
    world: { slug: site.world.slug, name: site.world.name },
    map: {
      slug: site.map.slug,
      name: site.map.name,
      width: site.map.width,
      height: site.map.height,
      maxZoom: site.map.maxZoom,
      tiles: site.map.tiles,
    },
    places: site.places.map((/** @type {Place} */ p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      x: p.x,
      y: p.y,
    })),
  };
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;
const PAGE = /^\/demo-maps\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)\/?$/;

/** @type {Record<string, { name: string, icon: string, color: string, trackable: boolean }>} */
const KINDS = {
  beacon: { name: 'Beacon', icon: 'star', color: '#ffd166', trackable: true },
  camp: { name: 'Camp', icon: 'flame', color: '#f97316', trackable: true },
  cave: { name: 'Cave', icon: 'cave', color: '#a3e635', trackable: true },
  other: { name: 'Other', icon: 'pin', color: '#94a3b8', trackable: false },
};

/**
 * Whether page data has the shape this importer reads.
 * @param {unknown} value
 * @returns {value is PageData}
 */
function isPageData(value) {
  const data = /** @type {any} */ (value);
  const isText = (/** @type {unknown} */ t) =>
    typeof t === 'string' && t.length > 0 && t.length < 200;
  const isNumber = (/** @type {unknown} */ n) => typeof n === 'number' && Number.isFinite(n);
  return (
    typeof data === 'object' &&
    data !== null &&
    SLUG.test(data.world?.slug) &&
    isText(data.world?.name) &&
    SLUG.test(data.map?.slug) &&
    isText(data.map?.name) &&
    Number.isInteger(data.map?.width) &&
    data.map.width > 0 &&
    Number.isInteger(data.map?.height) &&
    data.map.height > 0 &&
    Number.isInteger(data.map?.maxZoom) &&
    data.map.maxZoom >= 0 &&
    data.map.maxZoom <= 10 &&
    typeof data.map?.tiles === 'string' &&
    Array.isArray(data.places) &&
    data.places.every(
      (/** @type {any} */ p) =>
        Number.isInteger(p?.id) &&
        p.id > 0 &&
        isText(p.name) &&
        typeof p.kind === 'string' &&
        isNumber(p.x) &&
        isNumber(p.y),
    )
  );
}

/**
 * Builds the pack of one world from the page data of each of its maps.
 * @param {PageData[]} pages in map order
 * @param {Map<string, string>} since `since` of each location id in the existing pack
 * @param {string} version the pack version to write
 * @returns {PackData}
 */
function buildPack(pages, since, version) {
  const world = pages[0]?.world ?? { slug: 'unknown', name: 'Unknown' };
  const game = world.slug;
  const id = (/** @type {string} */ kind, /** @type {string} */ local) =>
    `${game}:${kind}:${local}`;
  const kinds = new Set(
    pages.flatMap((page) => page.places.map((p) => (p.kind in KINDS ? p.kind : 'other'))),
  );
  return {
    manifest: {
      schemaVersion: 1,
      gameId: game,
      title: world.name,
      packVersion: version,
      gamePatch: 'demo',
      attribution: [{ name: 'Demo map site (made-up test data)' }],
      idMigrations: {},
    },
    maps: pages.map(({ map }) => ({
      id: id('map', map.slug),
      name: map.name,
      width: map.width,
      height: map.height,
    })),
    layers: pages.map(({ map }) => ({
      id: id('layer', map.slug),
      mapId: id('map', map.slug),
      name: 'Map',
      tiles: {
        type: /** @type {const} */ ('xyz'),
        url: `tiles/${map.slug}/{z}/{x}/{y}.png`,
        remote: {
          urlTemplate: map.tiles,
          levels: [{ z: map.maxZoom, sourceZ: map.maxZoom, offsetX: 0, offsetY: 0 }],
        },
      },
      minZoom: 0,
      maxZoom: map.maxZoom,
      tileSize: 256,
    })),
    regions: [],
    categoryGroups: [{ id: id('catgroup', 'places'), name: 'Places', order: 0 }],
    categories: Object.entries(KINDS)
      .filter(([kind]) => kinds.has(kind))
      .map(([kind, style]) => ({
        id: id('cat', kind),
        groupId: id('catgroup', 'places'),
        name: style.name,
        icon: style.icon,
        color: style.color,
        trackable: style.trackable,
        defaultVisible: true,
      })),
    locations: pages.flatMap(({ map, places }) =>
      places.map((place) => {
        const locationId = id('loc', `${map.slug}-${place.id}`);
        return {
          id: locationId,
          mapId: id('map', map.slug),
          layerId: id('layer', map.slug),
          x: place.x,
          y: place.y,
          categoryId: id('cat', place.kind in KINDS ? place.kind : 'other'),
          regionId: null,
          name: place.name,
          entityIds: [],
          guideId: null,
          since: since.get(locationId) ?? version,
        };
      }),
    ),
    entities: [],
    checklists: [],
    checklistItems: [],
    guides: [],
    links: [],
    presets: [],
  };
}

/** @type {AtlasImporter} */
const importer = {
  apiVersion: 1,
  id: 'demo-maps',
  title: 'Demo map site',
  description: 'Reads the made-up demo map site that the Atlas tests serve on this computer.',
  version: '1.0.0',
  example: 'http://127.0.0.1:4432/demo-maps/test-valley/east-field',
  waitSeconds: 30,

  matches(url) {
    try {
      return PAGE.test(new URL(url).pathname);
    } catch {
      return false;
    }
  },

  pageReader: readPage.toString(),

  async convert(pageData, context) {
    if (!isPageData(pageData)) {
      return { ok: false, message: 'The page did not hold demo map data in the expected shape.' };
    }
    const packId = pageData.world.slug;
    if (context.isBundled(packId)) {
      return {
        ok: false,
        message: `${pageData.world.name} comes with this app, so it is not imported again.`,
      };
    }
    // Earlier maps keep their place; importing a map again refreshes it in place.
    const saved = (await context.savedSources(packId)).filter((source) => isPageData(source.data));
    const refreshed = saved.some((source) => source.key === pageData.map.slug);
    const pages = saved.map((source) =>
      source.key === pageData.map.slug ? pageData : /** @type {PageData} */ (source.data),
    );
    if (!refreshed) pages.push(pageData);
    const existing = await context.existingPack(packId);
    const since = new Map((existing?.locations ?? []).map((l) => [l.id, l.since]));
    const [major = 1, minor = 0] = (existing?.manifest.packVersion ?? '').split('.').map(Number);
    const version = existing ? `${major}.${minor + 1}.0` : '1.0.0';
    const pack = buildPack(pages, since, version);
    return {
      ok: true,
      packId,
      sourceKey: pageData.map.slug,
      mapId: `${packId}:map:${pageData.map.slug}`,
      pack,
      summary: {
        game: pageData.world.name,
        map: pageData.map.name,
        maps: pack.maps.length,
        locations: pack.locations.length,
        mapLocations: pageData.places.length,
        categories: pack.categories.length,
        refreshed,
      },
    };
  },
};

export default importer;
