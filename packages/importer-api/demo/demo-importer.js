// @ts-check
/**
 * A made-up importer for tests and as an example of the importer contract
 * (`../src/index.ts`). It reads the made-up "demo map site" that the desktop
 * tests serve on this computer (`apps/desktop/e2e/demoSite.js`): pages at
 * `/demo-maps/<world>/<map>` whose script sets `window.demoMaps` some time
 * after the page has loaded.
 *
 * It also reads a world's checklist pages (`/demo-maps/<world>/checklists/<slug>`,
 * `window.demoChecklist`), whose rows are places of its maps, into checklists
 * of the world's pack; lists a world's pages from its game page
 * (`/demo-maps/<world>`), whose links name its maps, checklists and other pages
 * (`/demo-maps/<world>/<kind>/<page>`, such as guides, which it does not read);
 * lists the site's worlds from `/demo-maps`; and refreshes worlds that come
 * with the app.
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
 * @typedef {{ map: string, place: number, name: string }} Row
 * @typedef {{ world: { slug: string, name: string }, checklist: { slug: string, name: string,
 *   rows: Row[] } }} ChecklistData
 */

/**
 * Runs inside the page: takes only the world, the map and its places, and
 * leaves everything else the page holds (such as `window.demoMaps.account`)
 * where it is. On a checklist page, its name and rows: each row names a
 * place of one of the world's maps.
 */
function readPage() {
  const list = /** @type {any} */ (globalThis).demoChecklist;
  if (list) {
    if (!list.loaded || !Array.isArray(list.rows)) return null;
    return {
      world: { slug: list.world.slug, name: list.world.name },
      checklist: {
        slug: list.slug,
        name: list.name,
        rows: list.rows.map((/** @type {Row} */ row) => ({
          map: row.map,
          place: row.place,
          name: row.name,
        })),
      },
    };
  }
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
/** A game page: `/demo-maps/<world>`. */
const GAME = /^\/demo-maps\/([a-z0-9][a-z0-9-]*)\/?$/;
/** Another page of a world, such as a guide: `/demo-maps/<world>/<kind>/<page>`. */
const OTHER = /^\/demo-maps\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)\/?$/;
/** A checklist page of a world: `/demo-maps/<world>/checklists/<checklist>`. */
const CHECKLIST = /^\/demo-maps\/([a-z0-9][a-z0-9-]*)\/checklists\/([a-z0-9][a-z0-9-]*)\/?$/;
/** The list of worlds: `/demo-maps`. */
const CATALOGUE = /^\/demo-maps\/?$/;

/**
 * Runs inside a game page or the list of worlds: once the page says it is
 * ready, every link's address and text, and the page's heading. It does not
 * click, scroll or ask for anything.
 */
function readLinks() {
  const doc = /** @type {any} */ (globalThis).document;
  if (!doc?.body || doc.body.dataset.ready !== 'yes') return null;
  const links = [];
  for (const link of doc.querySelectorAll('a[href]')) {
    links.push({ href: String(link.href), text: String(link.textContent ?? '').trim() });
    if (links.length >= 1000) break;
  }
  return { heading: String(doc.querySelector('h1')?.textContent ?? '').trim(), links };
}

/**
 * The links a link reader returned, as URLs with their text; anything else
 * is left out.
 * @param {unknown} value
 * @returns {{ url: URL, text: string }[] | null}
 */
function linksOf(value) {
  const data = /** @type {any} */ (value);
  if (typeof data !== 'object' || data === null || !Array.isArray(data.links)) return null;
  /** @type {{ url: URL, text: string }[]} */
  const links = [];
  for (const link of data.links) {
    if (typeof link?.href !== 'string' || typeof link.text !== 'string') continue;
    try {
      links.push({ url: new URL(link.href), text: link.text.trim().slice(0, 200) });
    } catch {
      // Not an address.
    }
  }
  return links;
}

/** "east-field" → "East field", for a link without text. */
const tidy = (/** @type {string} */ slug) =>
  slug.charAt(0).toUpperCase() + slug.slice(1).replaceAll('-', ' ');

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
 * Whether page data is a checklist page's.
 * @param {unknown} value
 * @returns {value is ChecklistData}
 */
function isChecklistData(value) {
  const data = /** @type {any} */ (value);
  return (
    typeof data === 'object' &&
    data !== null &&
    SLUG.test(data.world?.slug) &&
    typeof data.world?.name === 'string' &&
    SLUG.test(data.checklist?.slug) &&
    typeof data.checklist?.name === 'string' &&
    data.checklist.name.trim().length > 0 &&
    Array.isArray(data.checklist.rows) &&
    data.checklist.rows.length <= 10_000 &&
    data.checklist.rows.every(
      (/** @type {any} */ row) =>
        SLUG.test(row?.map) &&
        Number.isInteger(row.place) &&
        row.place > 0 &&
        typeof row.name === 'string' &&
        row.name.trim().length > 0,
    )
  );
}

/**
 * Adds the checklists of the world, in the order they were first added. A
 * row whose place is not in the pack (its map has not been added) is left
 * out and counted; it comes back when its map is added.
 * @param {PackData} pack
 * @param {ChecklistData[]} lists
 * @returns {Map<string, { items: number, leftOut: number }>} by checklist slug
 */
function addChecklists(pack, lists) {
  const game = pack.manifest.gameId;
  const places = new Set(pack.locations.map((location) => location.id));
  /** @type {Map<string, { items: number, leftOut: number }>} */
  const counts = new Map();
  lists.forEach(({ checklist }, order) => {
    const checklistId = `${game}:checklist:${checklist.slug}`;
    pack.checklists.push({ id: checklistId, name: checklist.name.trim(), order });
    const count = { items: 0, leftOut: 0 };
    const seen = new Set();
    checklist.rows.forEach((row, index) => {
      const locationId = `${game}:loc:${row.map}-${row.place}`;
      const id = `${game}:checkitem:${checklist.slug}-${row.map}-${row.place}`;
      if (seen.has(id)) return;
      seen.add(id);
      if (!places.has(locationId)) {
        count.leftOut++;
        return;
      }
      count.items++;
      pack.checklistItems.push({
        id,
        checklistId,
        name: row.name.trim(),
        order: index,
        locationIds: [locationId],
        entityIds: [],
      });
    });
    counts.set(checklist.slug, count);
  });
  return counts;
}

/** The key a checklist page's data is kept under. */
const checklistKey = (/** @type {string} */ slug) => `checklist-${slug}`;

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
    categoryGroups: [{ id: id('catgroup', 'places'), name: 'Locations', order: 0 }],
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
      const path = new URL(url).pathname;
      return PAGE.test(path) || CHECKLIST.test(path);
    } catch {
      return false;
    }
  },

  pageReader: readPage.toString(),

  games: {
    matches(url) {
      try {
        return GAME.test(new URL(url).pathname);
      } catch {
        return false;
      }
    },
    pageReader: readLinks.toString(),
    convert(pageData, context) {
      const links = linksOf(pageData);
      const world = GAME.exec(new URL(context.url).pathname)?.[1];
      if (!links || !world) {
        return { ok: false, message: 'The page did not hold a list of demo maps.' };
      }
      const origin = new URL(context.url).origin;
      const seen = new Set();
      /** @type {import('../src/index').ListedPage[]} */
      const pages = [];
      for (const { url, text } of links) {
        if (url.origin !== origin) continue;
        const map = PAGE.exec(url.pathname);
        const other = OTHER.exec(url.pathname);
        const address = `${origin}${url.pathname.replace(/\/$/, '')}`;
        if (seen.has(address)) continue;
        if (map?.[1] === world) {
          seen.add(address);
          pages.push({ url: address, kind: 'map', title: text || tidy(map[2] ?? '') });
        } else if (other?.[1] === world) {
          seen.add(address);
          pages.push({ url: address, kind: other[2] ?? '', title: text || tidy(other[3] ?? '') });
        }
      }
      const heading = /** @type {any} */ (pageData).heading;
      const game = typeof heading === 'string' && heading.trim() ? heading.trim() : tidy(world);
      return { ok: true, game, pages };
    },
    gameAddress(mapUrl) {
      try {
        const url = new URL(mapUrl);
        const world = PAGE.exec(url.pathname)?.[1];
        return world ? `${url.origin}/demo-maps/${world}` : null;
      } catch {
        return null;
      }
    },
  },

  catalogue: {
    address: 'http://127.0.0.1:4432/demo-maps',
    label: 'All worlds of the demo map site',
    matches(url) {
      try {
        return CATALOGUE.test(new URL(url).pathname);
      } catch {
        return false;
      }
    },
    pageReader: readLinks.toString(),
    convert(pageData, context) {
      const links = linksOf(pageData);
      if (!links) return { ok: false, message: 'The page did not hold a list of demo worlds.' };
      const origin = new URL(context.url).origin;
      /** @type {Map<string, import('../src/index').CatalogueGame>} */
      const games = new Map();
      for (const { url, text } of links) {
        if (url.origin !== origin) continue;
        // A world, or the one map of a world with a single map.
        const world = GAME.exec(url.pathname)?.[1] ?? PAGE.exec(url.pathname)?.[1];
        if (!world || games.has(world)) continue;
        games.set(world, {
          id: world,
          name: text || tidy(world),
          address: `${origin}${url.pathname.replace(/\/$/, '')}`,
        });
      }
      return { ok: true, games: [...games.values()] };
    },
  },

  // A world that comes with the app is refreshed like any other; its pack
  // keeps every id, because ids come from the site's slugs and numbers.
  refreshesBundledGames: true,

  async convert(pageData, context) {
    const checklist = isChecklistData(pageData);
    if (!checklist && !isPageData(pageData)) {
      return { ok: false, message: 'The page did not hold demo map data in the expected shape.' };
    }
    const packId = pageData.world.slug;
    const key = checklist ? checklistKey(pageData.checklist.slug) : pageData.map.slug;
    // Earlier pages keep their place; importing a page again refreshes it in place.
    const saved = await context.savedSources(packId);
    const refreshed = saved.some((source) => source.key === key);
    const current = (/** @type {import('../src/index').SavedSource} */ source) =>
      source.key === key ? pageData : source.data;
    const pages = saved.map(current).filter(isPageData);
    const lists = saved.map(current).filter(isChecklistData);
    if (!refreshed) {
      if (checklist) lists.push(pageData);
      else pages.push(pageData);
    }
    if (pages.length === 0) {
      return {
        ok: false,
        message: `${pageData.world.name} has no maps in this app yet. Add its maps first, then its checklists.`,
      };
    }
    const existing = await context.existingPack(packId);
    const since = new Map((existing?.locations ?? []).map((l) => [l.id, l.since]));
    const [major = 1, minor = 0] = (existing?.manifest.packVersion ?? '').split('.').map(Number);
    const version = existing ? `${major}.${minor + 1}.0` : '1.0.0';
    const pack = buildPack(pages, since, version);
    const counts = addChecklists(pack, lists);
    const summary = {
      game: pageData.world.name,
      maps: pack.maps.length,
      locations: pack.locations.length,
      categories: pack.categories.length,
      refreshed,
    };
    if (checklist) {
      return {
        ok: true,
        packId,
        sourceKey: key,
        checklistId: `${packId}:checklist:${pageData.checklist.slug}`,
        pack,
        summary: {
          ...summary,
          map: pageData.checklist.name.trim(),
          mapLocations: 0,
          checklist: counts.get(pageData.checklist.slug) ?? { items: 0, leftOut: 0 },
        },
      };
    }
    return {
      ok: true,
      packId,
      sourceKey: key,
      mapId: `${packId}:map:${pageData.map.slug}`,
      pack,
      summary: { ...summary, map: pageData.map.name, mapLocations: pageData.places.length },
    };
  },
};

export default importer;
