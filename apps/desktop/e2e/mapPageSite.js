// @ts-check
/**
 * A made-up map site on 127.0.0.1 for the "View map page" test (`view.js`),
 * and a test pack made from it. Everything here is invented; nothing talks
 * to any other server.
 *
 * Two servers, as a real site and its image server would be:
 *
 * - the **site**, with two map pages of the made-up game "My Game":
 *   - `/my-game/world` loads its map images with `fetch` and
 *     `XMLHttpRequest` (binary), the way a map script does while someone
 *     pans and zooms: first the zoomed-out level, then, a moment later, the
 *     zoomed-in one. It also loads a marker icon and a level the pack does
 *     not use, which must be ignored. Before that it tries what a hostile
 *     page might (calling the app, reading the app's packs, opening a
 *     window, leaving for another site) and reports what happened to
 *     `/probe`.
 *   - `/my-game/caves` shows its map images with `<img>` elements and one
 *     `no-cors` request, whose bytes a page cannot read.
 * - the **image server**, which answers `/tiles/<map>/<z>/<x>/<y>.png` with
 *   a PNG whose colour encodes its address, allows other sites to read them
 *   (CORS), and records every request, so the test can check that each
 *   image was asked for exactly once. With `setStoreMissing(true)` it
 *   answers the images of `STORE_MISSING` (the world map's bottom edge on
 *   level 2) the way an object store answers for an image it does not have
 *   (403, `AccessDenied`), as if the map's grid were padded beyond the
 *   picture; off unless a test turns it on.
 *
 *   node apps/desktop/e2e/mapPageSite.js   # serve until stopped
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, NO_SUCH_OBJECT } from './tileServer.js';

export const PACK_ID = 'view-test';

/**
 * @typedef {{ z: number, sourceZ: number, offsetX: number, offsetY: number }} RemoteLevel
 * @typedef {{ slug: string, name: string, width: number, height: number, maxZoom: number,
 *   levels: RemoteLevel[] }} SiteMap
 */

/** @type {SiteMap} */
export const WORLD = {
  slug: 'world',
  name: 'World',
  width: 1024,
  height: 768,
  maxZoom: 2,
  // Level 0 is built from level 1.
  levels: [
    { z: 1, sourceZ: 5, offsetX: 3, offsetY: 2 },
    { z: 2, sourceZ: 6, offsetX: 6, offsetY: 4 },
  ],
};

/** @type {SiteMap} */
export const CAVES = {
  slug: 'caves',
  name: 'Caves',
  width: 512,
  height: 512,
  maxZoom: 1,
  levels: [{ z: 1, sourceZ: 1, offsetX: 0, offsetY: 0 }],
};

/**
 * World map images (layer level, column, row) that the image server answers
 * like an object store without them, once `setStoreMissing(true)`: one
 * loaded by `fetch`, one by binary `XMLHttpRequest` and one as a blob.
 */
export const STORE_MISSING = [
  { z: 2, x: 1, y: 2 },
  { z: 2, x: 2, y: 2 },
  { z: 2, x: 3, y: 2 },
];

/** Columns and rows of a level. */
export function levelGrid(/** @type {SiteMap} */ map, /** @type {number} */ z) {
  const scale = 2 ** (z - map.maxZoom);
  return {
    columns: Math.ceil(Math.max(1, Math.ceil(map.width * scale)) / 256),
    rows: Math.ceil(Math.max(1, Math.ceil(map.height * scale)) / 256),
  };
}

/**
 * Every remote image of a map's listed levels: its layer position and its
 * path on the image server.
 * @param {SiteMap} map
 */
export function remoteTiles(map) {
  return map.levels.flatMap((level) => {
    const grid = levelGrid(map, level.z);
    /** @type {{ z: number, x: number, y: number, path: string }[]} */
    const tiles = [];
    for (let y = 0; y < grid.rows; y++) {
      for (let x = 0; x < grid.columns; x++) {
        tiles.push({
          z: level.z,
          x,
          y,
          path: `/tiles/${map.slug}/${level.sourceZ}/${x + level.offsetX}/${y + level.offsetY}.png`,
        });
      }
    }
    return tiles;
  });
}

/** The image the server sends for a path: a flat colour from its numbers. */
export function tileImage(/** @type {string} */ path) {
  const numbers = (path.match(/\d+/g) ?? []).map(Number);
  const [z = 0, x = 0, y = 0] = numbers;
  const rgb = new Uint8Array(256 * 256 * 3);
  const colour = [40 + ((z * 37) % 200), 40 + ((x * 23) % 200), 40 + ((y * 29) % 200)];
  for (let i = 0; i < 256 * 256; i++) rgb.set(colour, i * 3);
  return encodePng(256, 256, rgb);
}

/** The page script of the world map: fetch and XHR, in two steps. */
const worldScript = (/** @type {string} */ images, /** @type {string} */ elsewhere) => {
  const tiles = remoteTiles(WORLD).map((tile) => ({ z: tile.z, url: images + tile.path }));
  return `
(async () => {
  const results = { userAgent: navigator.userAgent };
  const internals = window.__TAURI_INTERNALS__;
  try {
    await internals.invoke('view_status');
    results.invoke = 'allowed';
  } catch (error) {
    results.invoke = 'denied: ' + String(error && error.message || error);
  }
  for (const url of ['atlas-pack://localhost/${PACK_ID}/manifest.json', 'http://atlas-pack.localhost/${PACK_ID}/manifest.json']) {
    try {
      const response = await fetch(url);
      results[url] = 'status ' + response.status;
    } catch (error) {
      results[url] = 'failed';
    }
  }
  const popup = window.open('/popup', '_blank');
  results.popup = popup ? 'opened' : 'blocked';
  await fetch('/probe', { method: 'POST', body: JSON.stringify(results) });
  location.assign(${JSON.stringify(elsewhere)});

  const tiles = ${JSON.stringify(tiles)};
  const show = (blob) => {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    document.getElementById('map').append(img);
  };
  const byFetch = (url) => fetch(url).then((r) => r.blob()).then(show);
  const byXhr = (url, type) => new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = type;
    xhr.onload = () => {
      show(type === 'blob' ? xhr.response : new Blob([xhr.response], { type: 'image/png' }));
      resolve();
    };
    xhr.onerror = () => resolve();
    xhr.send();
  });
  // Zoomed out: the whole map at level 1, and things that are not map images.
  await Promise.all([
    ...tiles.filter((t) => t.z === 1).map((t) => byFetch(t.url)),
    fetch(${JSON.stringify(`${images}/tiles/icons/pin.png`)}).then((r) => r.arrayBuffer()),
    fetch(${JSON.stringify(`${images}/tiles/world/4/1/1.png`)}).then((r) => r.arrayBuffer()),
  ]);
  document.body.dataset.step = 'zoomed-out';
  // Zoomed in, a moment later: level 2, some by fetch, some by XHR.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const level2 = tiles.filter((t) => t.z === 2);
  await Promise.all(level2.map((t, i) =>
    i % 3 === 0 ? byFetch(t.url) : byXhr(t.url, i % 3 === 1 ? 'arraybuffer' : 'blob')));
  document.body.dataset.step = 'zoomed-in';
})();`;
};

/** The page script of the caves map: `<img>` elements and one no-cors request. */
const cavesScript = (/** @type {string} */ images) => {
  const urls = remoteTiles(CAVES).map((tile) => images + tile.path);
  return `
(() => {
  const urls = ${JSON.stringify(urls)};
  for (const url of urls.slice(0, -1)) {
    const img = document.createElement('img');
    img.src = url;
    document.getElementById('map').append(img);
  }
  fetch(urls[urls.length - 1], { mode: 'no-cors' }).catch(() => undefined);
})();`;
};

/** Starts the site and the image server on 127.0.0.1. */
export async function startMapPageSite() {
  /** @type {{ path: string, userAgent: string }[]} */
  const seen = [];
  /** @type {Map<string, number>} */
  const imageRequests = new Map();
  /** @type {Record<string, unknown>[]} */
  const probes = [];
  let storeMissing = false;
  const missingPaths = new Set(
    remoteTiles(WORLD)
      .filter((tile) =>
        STORE_MISSING.some((t) => t.z === tile.z && t.x === tile.x && t.y === tile.y),
      )
      .map((tile) => tile.path),
  );

  const imageServer = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    imageRequests.set(path, (imageRequests.get(path) ?? 0) + 1);
    if (storeMissing && missingPaths.has(path)) {
      response
        .writeHead(403, {
          'content-type': 'application/xml',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        })
        .end(NO_SUCH_OBJECT);
      return;
    }
    if (/^\/tiles\/[a-z]+\/\d+\/\d+\/\d+\.png$/.test(path)) {
      response
        .writeHead(200, {
          'content-type': 'image/png',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        })
        .end(tileImage(path));
      return;
    }
    response.writeHead(404, { 'access-control-allow-origin': '*' }).end();
  });

  const site = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    seen.push({ path: url.pathname, userAgent: request.headers['user-agent'] ?? '' });
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
    const map = { '/my-game/world': WORLD, '/my-game/caves': CAVES }[url.pathname];
    if (!map) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    const script =
      map === WORLD
        ? worldScript(images(), `http://localhost:${port(site)}/elsewhere`)
        : cavesScript(images());
    response
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      .end(
        `<!doctype html><html><head><meta charset="utf-8"><title>${map.name} – My Game map</title>` +
          '<style>body{font:14px sans-serif;background:#223;color:#eee}#map img{width:64px;height:64px;margin:2px}</style>' +
          `</head><body><h1>My Game: ${map.name}</h1><p>A made-up map page for tests.</p>` +
          `<div id="map"></div><script>${script}</script></body></html>`,
      );
  });

  const listen = (/** @type {import('node:http').Server} */ server) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(undefined));
    });
  await listen(site);
  await listen(imageServer);
  function port(/** @type {import('node:http').Server} */ server) {
    const info = server.address();
    return typeof info === 'object' && info ? info.port : 0;
  }
  const images = () => `http://127.0.0.1:${port(imageServer)}`;
  const close = (/** @type {import('node:http').Server} */ server) => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve(undefined)));
  };
  return {
    url: `http://127.0.0.1:${port(site)}`,
    images: images(),
    seen,
    probes,
    imageRequests,
    /** Answers the images of `STORE_MISSING` like an object store without them. */
    setStoreMissing(/** @type {boolean} */ on) {
      storeMissing = on;
    },
    close: () => Promise.all([close(site), close(imageServer)]),
  };
}

const id = (/** @type {string} */ kind, /** @type {string} */ local) =>
  `${PACK_ID}:${kind}:${local}`;

/**
 * The test pack's files: a version 2 manifest that records the two pages it
 * was made from, and layers whose remote images are on the image server.
 * @param {string} siteUrl @param {string} imagesUrl
 */
export function packFiles(siteUrl, imagesUrl) {
  const maps = [WORLD, CAVES];
  return {
    'manifest.json': {
      schemaVersion: 2,
      gameId: PACK_ID,
      title: 'My Game',
      packVersion: '1.0.0',
      gamePatch: '1',
      attribution: [{ name: 'Made-up test data' }],
      idMigrations: {},
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
      source: {
        importer: { id: 'demo-maps', title: 'Demo map site' },
        pages: [
          {
            url: `${siteUrl}/my-game/world`,
            mapId: id('map', 'world'),
            importedAt: '2026-01-01T00:00:00Z',
          },
          {
            url: `${siteUrl}/my-game/caves`,
            mapId: id('map', 'caves'),
            importedAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
      contents: {
        counts: { maps: 2, layers: 2, locations: 2, categories: 1, regions: 0, guides: 0 },
        maps: maps.map((map) => ({
          id: id('map', map.slug),
          name: map.name,
          width: map.width,
          height: map.height,
          locations: 1,
          layers: [
            {
              id: id('layer', map.slug),
              name: 'Map',
              minZoom: 0,
              maxZoom: map.maxZoom,
              tiles: 'xyz',
              downloadable: true,
            },
          ],
        })),
      },
    },
    'maps.json': maps.map((map) => ({
      id: id('map', map.slug),
      name: map.name,
      width: map.width,
      height: map.height,
    })),
    'layers.json': maps.map((map) => ({
      id: id('layer', map.slug),
      mapId: id('map', map.slug),
      name: 'Map',
      tiles: {
        type: 'xyz',
        url: `tiles/${map.slug}/{z}/{x}/{y}.png`,
        remote: {
          urlTemplate: `${imagesUrl}/tiles/${map.slug}/{z}/{x}/{y}.png`,
          levels: map.levels,
        },
      },
      minZoom: 0,
      maxZoom: map.maxZoom,
      tileSize: 256,
    })),
    'categoryGroups.json': [{ id: id('catgroup', 'places'), name: 'Places', order: 0 }],
    'categories.json': [
      {
        id: id('cat', 'camp'),
        groupId: id('catgroup', 'places'),
        name: 'Camp',
        icon: 'flame',
        color: '#f97316',
        trackable: true,
        defaultVisible: true,
      },
    ],
    'locations.json': maps.map((map) => ({
      id: id('loc', `${map.slug}-camp`),
      mapId: id('map', map.slug),
      layerId: id('layer', map.slug),
      x: map.width / 2,
      y: map.height / 2,
      categoryId: id('cat', 'camp'),
      regionId: null,
      name: `${map.name} camp`,
      entityIds: [],
      guideId: null,
      since: '1.0.0',
    })),
  };
}

/** Writes the test pack into `dir`. @param {string} dir @param {string} siteUrl @param {string} imagesUrl */
export async function writePack(dir, siteUrl, imagesUrl) {
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(packFiles(siteUrl, imagesUrl))) {
    await writeFile(join(dir, name), `${JSON.stringify(content, null, 2)}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const served = await startMapPageSite();
  console.log(`Map pages at ${served.url}/my-game/world and ${served.url}/my-game/caves`);
  console.log(`Map images at ${served.images}/tiles/`);
}
