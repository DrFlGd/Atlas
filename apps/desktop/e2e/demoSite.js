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
 * - `/tiles/<map>/<z>/<x>/<y>.png`: map images of each map.
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

/** @type {Record<string, { name: string, maps: DemoMap[] }>} */
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
    const page = /^\/demo-maps\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/.exec(url.pathname);
    if (page) {
      const [, worldSlug = '', mapSlug = ''] = page;
      const world = WORLDS[worldSlug];
      const map =
        world?.maps.find((m) => m.slug === mapSlug) ??
        (mapSlug === 'never' || mapSlug === 'broken' ? world?.maps[0] : undefined);
      if (!world || !map) {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('No such map');
        return;
      }
      const places =
        updated && map.slug === 'east-field' ? [...map.places, UPDATED_PLACE] : map.places;
      const data =
        mapSlug === 'never'
          ? 'undefined'
          : JSON.stringify({
              loaded: true,
              world: { slug: worldSlug, name: world.name },
              map: {
                slug: map.slug,
                name: map.name,
                width: map.width,
                height: map.height,
                maxZoom: map.maxZoom,
                tiles: `http://127.0.0.1:${address()}/tiles/${map.slug}/{z}/{x}/{y}.png`,
              },
              places:
                mapSlug === 'broken' ? [{ id: 'one', name: '', kind: 1, x: 'a', y: null }] : places,
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
      .flatMap((world) => world.maps)
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
    /** Adds a place to East Field, as when the site's data changes. */
    update() {
      updated = true;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const site = await startDemoSite({ port: Number(process.argv[2] ?? 4432) });
  console.log(`Demo map site at ${site.url}demo-maps/test-valley/east-field`);
}
