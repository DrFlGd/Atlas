// @ts-check
/**
 * A made-up "demo map site" on 127.0.0.1 for the desktop import test, read
 * by the demo importer (`packages/importer-api/demo/demo-importer.js`). All
 * of its data is invented here; it never talks to any other server.
 *
 * - `/demo-maps/<world>/<map>`: a map page. Its script sets
 *   `window.demoMaps` a moment after the page has loaded, as a site that
 *   loads its data with scripts would. Before that it tries what a hostile
 *   page might (calling the app, reading the app's packs, opening a window,
 *   leaving for another site) and reports what happened to `/probe`.
 *   Special maps: `never` (the data never appears) and `broken` (data in
 *   the wrong shape).
 * - `/demo-maps/<world>`: a world's game page, whose links name its maps,
 *   its checklist pages and its guides (which the demo importer does not
 *   read), next to links to another world and another site. The page says
 *   it is ready (`data-ready`) a moment after it has loaded.
 * - `/demo-maps/<world>/checklists/<slug>`: a checklist page, whose script
 *   sets `window.demoChecklist` (rows that name places of the world's maps).
 * - `/demo-maps`: the list of worlds; a world with one map links straight
 *   to it.
 * - `/tiles/<map>/<z>/<x>/<y>.png`: map images of each map.
 *
 * The demo importer's list of worlds is at port 4432, and the bundled test
 * pack `test-isles` (see `islesPack.js`) names map images on this site, so
 * the import test serves it there (`ATLAS_E2E_SITE_PORT` to change it).
 *
 *   node apps/desktop/e2e/demoSite.js [port]   # serve until stopped
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { encodePng } from './tileServer.js';

/**
 * @typedef {{ id: number, name: string, kind: string, x: number, y: number }} Place
 * @typedef {{ slug: string, name: string, width: number, height: number, maxZoom: number,
 *   colour: number[], places: Place[] }} DemoMap
 */

/** The port the import test serves the site on. */
export const SITE_PORT = Number(process.env.ATLAS_E2E_SITE_PORT ?? 4432);

/**
 * @typedef {{ name: string, rows: { map: string, place: number, name: string }[] }} DemoChecklist
 * @typedef {{ name: string, maps: DemoMap[], later?: DemoMap[],
 *   checklists?: Record<string, DemoChecklist>, guides?: Record<string, string> }} World
 */

/** @type {Record<string, World>} */
export const WORLDS = {
  'test-valley': {
    name: 'Test Valley',
    maps: [
      {
        slug: 'east-field',
        name: 'East Field',
        width: 1024,
        height: 768,
        maxZoom: 2,
        colour: [80, 140, 90],
        places: [
          { id: 1, name: 'Old beacon', kind: 'beacon', x: 200, y: 180 },
          { id: 2, name: 'River camp', kind: 'camp', x: 520, y: 390 },
          { id: 3, name: 'Hollow cave', kind: 'cave', x: 820, y: 600 },
          { id: 4, name: 'Signpost', kind: 'sign', x: 640, y: 120 },
        ],
      },
      {
        slug: 'west-ridge',
        name: 'West Ridge',
        width: 512,
        height: 512,
        maxZoom: 1,
        colour: [120, 110, 160],
        places: [
          { id: 1, name: 'Ridge beacon', kind: 'beacon', x: 100, y: 120 },
          { id: 2, name: 'Cliff camp', kind: 'camp', x: 400, y: 300 },
        ],
      },
    ],
    // A map the site adds later (`addMap()`), for updating a game.
    later: [
      {
        slug: 'north-lake',
        name: 'North Lake',
        width: 256,
        height: 256,
        maxZoom: 0,
        colour: [60, 110, 180],
        places: [{ id: 1, name: 'Lake beacon', kind: 'beacon', x: 128, y: 100 }],
      },
    ],
    checklists: {
      beacons: {
        name: 'Every beacon',
        rows: [
          { map: 'east-field', place: 1, name: 'Old beacon' },
          { map: 'west-ridge', place: 1, name: 'Ridge beacon' },
          { map: 'north-lake', place: 1, name: 'Lake beacon' },
        ],
      },
    },
    guides: { 'getting-started': 'Getting started' },
  },
  // Two more games, for adding several maps at once.
  'test-coast': {
    name: 'Test Coast',
    maps: [
      {
        slug: 'north-bay',
        name: 'North Bay',
        width: 512,
        height: 256,
        maxZoom: 1,
        colour: [70, 120, 170],
        places: [
          { id: 1, name: 'Harbour light', kind: 'beacon', x: 60, y: 40 },
          { id: 2, name: 'Dune camp', kind: 'camp', x: 300, y: 200 },
        ],
      },
      {
        slug: 'south-cape',
        name: 'South Cape',
        width: 256,
        height: 256,
        maxZoom: 0,
        colour: [190, 170, 110],
        places: [{ id: 1, name: 'Cape beacon', kind: 'beacon', x: 128, y: 128 }],
      },
    ],
  },
  'test-hills': {
    name: 'Test Hills',
    maps: [
      {
        slug: 'high-pass',
        name: 'High Pass',
        width: 256,
        height: 512,
        maxZoom: 1,
        colour: [140, 120, 100],
        places: [
          { id: 1, name: 'Pass camp', kind: 'camp', x: 100, y: 400 },
          { id: 2, name: 'Summit cave', kind: 'cave', x: 150, y: 60 },
        ],
      },
    ],
  },
  // A world that comes with the app as the test pack `test-isles`, made from
  // these pages (`islesPack.js`), so the app can refresh it.
  'test-isles': {
    name: 'Test Isles',
    maps: [
      {
        slug: 'north-isle',
        name: 'North Isle',
        width: 512,
        height: 512,
        maxZoom: 1,
        colour: [90, 160, 140],
        places: [
          { id: 1, name: 'Isle beacon', kind: 'beacon', x: 250, y: 260 },
          { id: 2, name: 'Shore camp', kind: 'camp', x: 120, y: 400 },
        ],
      },
      {
        slug: 'south-isle',
        name: 'South Isle',
        width: 256,
        height: 256,
        maxZoom: 0,
        colour: [170, 150, 90],
        places: [{ id: 1, name: 'Reef cave', kind: 'cave', x: 200, y: 60 }],
      },
    ],
  },
  // A world with the id of a pack that comes with the app.
  demo: {
    name: 'Demo again',
    maps: [
      {
        slug: 'plain',
        name: 'Plain',
        width: 256,
        height: 256,
        maxZoom: 0,
        colour: [100, 100, 100],
        places: [{ id: 1, name: 'Stone', kind: 'beacon', x: 10, y: 10 }],
      },
    ],
  },
};

/** The place added to East Field when the site is "updated", to test refreshing. */
export const UPDATED_PLACE = { id: 5, name: 'New lookout', kind: 'beacon', x: 300, y: 600 };

/** The place added to North Isle when the site is "updated", to test refreshing a bundled game. */
export const UPDATED_ISLE_PLACE = { id: 3, name: 'Lighthouse', kind: 'beacon', x: 400, y: 80 };

/**
 * What a map page's script sets as `window.demoMaps`.
 * @param {string} worldSlug
 * @param {DemoMap} map
 * @param {string} origin the site's address, such as `http://127.0.0.1:4432`
 * @param {Place[]} places
 */
export const mapPageData = (worldSlug, map, origin, places = map.places) => ({
  loaded: true,
  world: { slug: worldSlug, name: WORLDS[worldSlug]?.name ?? worldSlug },
  map: {
    slug: map.slug,
    name: map.name,
    width: map.width,
    height: map.height,
    maxZoom: map.maxZoom,
    tiles: `${origin}/tiles/${map.slug}/{z}/{x}/{y}.png`,
  },
  places,
});

/**
 * A page that says it is ready a moment after it has loaded.
 * @param {string} title
 * @param {string} body HTML
 * @param {string} [script] run when it is ready
 */
const readyPage = (title, body, script = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title} – demo map site</title></head>` +
  `<body>${body}<script>setTimeout(() => { ${script} document.body.dataset.ready = 'yes'; }, 1000);</script>` +
  `</body></html>`;

const escape = (/** @type {string} */ text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

/** Columns × rows of tiles a map has on level z. */
export function tileCount(/** @type {DemoMap} */ map, /** @type {number} */ z) {
  const scale = 2 ** (z - map.maxZoom);
  return (
    Math.ceil(Math.ceil(map.width * scale) / 256) * Math.ceil(Math.ceil(map.height * scale) / 256)
  );
}

/** @param {DemoMap} map */
function drawTile(map) {
  const rgb = new Uint8Array(256 * 256 * 3);
  for (let i = 0; i < 256 * 256; i++) rgb.set(map.colour, i * 3);
  return encodePng(256, 256, rgb);
}

/**
 * The page's script. The probes run first; the data appears 1.5 s later.
 * @param {string} data the value of `window.demoMaps`, as JSON
 * @param {string} elsewhere a page on another site, which the window must not open
 */
const pageScript = (data, elsewhere) => `
(async () => {
  const results = { userAgent: navigator.userAgent };
  const internals = window.__TAURI_INTERNALS__;
  results.hasInternals = typeof internals !== 'undefined';
  try {
    await internals.invoke('library_list');
    results.invoke = 'allowed';
  } catch (error) {
    results.invoke = 'denied: ' + String(error && error.message || error);
  }
  for (const url of ['atlas-pack://localhost/demo/manifest.json', 'http://atlas-pack.localhost/demo/manifest.json']) {
    try {
      const response = await fetch(url);
      results[url] = 'status ' + response.status + ' ' + (await response.text()).slice(0, 40);
    } catch (error) {
      results[url] = 'failed';
    }
  }
  const popup = window.open('/popup', '_blank');
  results.popup = popup ? 'opened' : 'blocked';
  await fetch('/probe', { method: 'POST', body: JSON.stringify(results) });
  // Leaving for another site is not allowed; the page stays.
  location.assign(${JSON.stringify(elsewhere)});
  setTimeout(() => {
    window.demoMaps = ${data};
    document.body.dataset.ready = 'yes';
  }, 1500);
})();`;

/**
 * Starts the site on 127.0.0.1.
 * @param {{ port?: number }} [options]
 */
export async function startDemoSite({ port = 0 } = {}) {
  /** @type {{ path: string, userAgent: string, cookie: string | undefined }[]} */
  const seen = [];
  /** @type {Record<string, unknown>[]} */
  const probes = [];
  let updated = false;
  let mapAdded = false;
  /** The maps a world has now. @param {World} world */
  const mapsOf = (world) => [...world.maps, ...(mapAdded ? (world.later ?? []) : [])];
  const html = (
    /** @type {import('node:http').ServerResponse} */ response,
    /** @type {string} */ body,
  ) =>
    response
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'visit=1' })
      .end(body);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    seen.push({
      path: url.pathname,
      userAgent: request.headers['user-agent'] ?? '',
      cookie: request.headers.cookie,
    });
    if (url.pathname === '/probe' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        try {
          probes.push(JSON.parse(body));
        } catch {
          probes.push({ unreadable: body });
        }
        response.writeHead(204).end();
      });
      return;
    }
    // The list of worlds.
    if (/^\/demo-maps\/?$/.test(url.pathname)) {
      const links = Object.entries(WORLDS).map(([slug, world]) => {
        const maps = mapsOf(world);
        const href =
          maps.length === 1 ? `/demo-maps/${slug}/${maps[0]?.slug}` : `/demo-maps/${slug}`;
        return `<li><a href="${href}">${escape(world.name)}</a></li>`;
      });
      html(
        response,
        readyPage(
          'Worlds',
          `<h1>Demo map site</h1><ul>${links.join('')}</ul><p><a href="https://example.com/">Another site</a></p>`,
        ),
      );
      return;
    }
    // A world's game page: links to its maps, checklists and guides, and others.
    const game = /^\/demo-maps\/([a-z0-9-]+)\/?$/.exec(url.pathname);
    if (game) {
      const [, worldSlug = ''] = game;
      const world = WORLDS[worldSlug];
      if (!world) {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('No such world');
        return;
      }
      const base = `/demo-maps/${worldSlug}`;
      const links = [
        ...Object.entries(world.guides ?? {}).map(
          ([slug, name]) => `<a href="${base}/guides/${slug}">${escape(name)}</a>`,
        ),
        // Absolute and relative links (relative to `/demo-maps/`, as the
        // address has no slash at the end), and one without text.
        ...mapsOf(world).map((map, i) =>
          i === 0
            ? `<a href="http://127.0.0.1:${address()}${base}/${map.slug}">${escape(map.name)}</a>`
            : `<a href="${worldSlug}/${map.slug}/">${escape(map.name)}</a>`,
        ),
        ...Object.entries(world.checklists ?? {}).map(
          ([slug, list]) => `<a href="${base}/checklists/${slug}">${escape(list.name)}</a>`,
        ),
        `<a href="${base}/${world.maps[0]?.slug}?from=menu"></a>`,
        `<a href="/demo-maps/test-hills">Test Hills</a>`,
        `<a href="https://example.com${base}/elsewhere">Another site</a>`,
      ];
      html(
        response,
        readyPage(world.name, `<h1>${escape(world.name)}</h1><nav>${links.join(' ')}</nav>`),
      );
      return;
    }
    // A checklist page: its rows are places of the world's maps.
    const checklist = /^\/demo-maps\/([a-z0-9-]+)\/checklists\/([a-z0-9-]+)\/?$/.exec(url.pathname);
    if (checklist) {
      const [, worldSlug = '', slug = ''] = checklist;
      const world = WORLDS[worldSlug];
      const list = world?.checklists?.[slug];
      if (!world || !list) {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('No such checklist');
        return;
      }
      const data = JSON.stringify({
        loaded: true,
        world: { slug: worldSlug, name: world.name },
        slug,
        name: list.name,
        rows: list.rows,
      });
      html(
        response,
        readyPage(list.name, `<h1>${escape(list.name)}</h1>`, `window.demoChecklist = ${data};`),
      );
      return;
    }
    const page = /^\/demo-maps\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/.exec(url.pathname);
    if (page) {
      const [, worldSlug = '', mapSlug = ''] = page;
      const world = WORLDS[worldSlug];
      const map =
        (world ? mapsOf(world) : []).find((m) => m.slug === mapSlug) ??
        (mapSlug === 'never' || mapSlug === 'broken' ? world?.maps[0] : undefined);
      if (!world || !map) {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('No such map');
        return;
      }
      const places = !updated
        ? map.places
        : map.slug === 'east-field'
          ? [...map.places, UPDATED_PLACE]
          : map.slug === 'north-isle'
            ? [...map.places, UPDATED_ISLE_PLACE]
            : map.places;
      const data =
        mapSlug === 'never'
          ? 'undefined'
          : JSON.stringify({
              ...mapPageData(worldSlug, map, `http://127.0.0.1:${address()}`, places),
              ...(mapSlug === 'broken'
                ? { places: [{ id: 'one', name: '', kind: 1, x: 'a', y: null }] }
                : {}),
              // Not for the importer: the reader leaves it in the page.
              account: { email: 'someone@example.com', session: 'made-up-session-token' },
            });
      const elsewhere = `http://localhost:${address()}/elsewhere`;
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'visit=1' })
        .end(
          `<!doctype html><html><head><meta charset="utf-8"><title>${map.name} – demo map site</title></head>` +
            `<body><h1>${world.name}: ${map.name}</h1><p>Made-up map page for tests.</p>` +
            `<script>${pageScript(data, elsewhere)}</script></body></html>`,
        );
      return;
    }
    const tile = /^\/tiles\/([a-z0-9-]+)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url.pathname);
    const map = Object.values(WORLDS)
      .flatMap((world) => [...world.maps, ...(world.later ?? [])])
      .find((m) => m.slug === tile?.[1]);
    if (tile && map) {
      response.writeHead(200, { 'content-type': 'image/png' }).end(drawTile(map));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(undefined);
    });
  });
  function address() {
    const info = server.address();
    return typeof info === 'object' && info ? info.port : port;
  }
  return {
    url: `http://127.0.0.1:${address()}/`,
    seen,
    probes,
    /** Adds a place to East Field and to North Isle, as when the site's data changes. */
    update() {
      updated = true;
    },
    /** Adds North Lake to Test Valley, as when the site adds a map to a game. */
    addMap() {
      mapAdded = true;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const site = await startDemoSite({ port: Number(process.argv[2] ?? SITE_PORT) });
  console.log(`Demo map site at ${site.url}demo-maps/test-valley/east-field`);
}
