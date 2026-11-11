// @ts-check
/**
 * Desktop download test: the built app downloads a pack's map images from a
 * local mock tile server through the real interface, and the map shows them
 * under its markers.
 *
 *   node apps/desktop/e2e/remotePack.js          # writes packs/e2e-remote/
 *   ATLAS_BUNDLE_PACKS=e2e-remote,demo pnpm desktop:build --no-bundle
 *   xvfb-run -a pnpm --filter @atlas/desktop test:e2e:download [path/to/binary]
 *
 * Linux only: the app's data, its web storage and the "system browser" are
 * redirected into a temporary folder (XDG_DATA_HOME, XDG_CONFIG_HOME), so the
 * test starts from a first launch and never touches the user's own data. Links
 * open in a stand-in browser that only writes the URL down. No request leaves
 * this computer: the pack's tiles point at 127.0.0.1.
 *
 * It checks, in three launches of the app:
 *  1. the first game in ATLAS_BUNDLE_PACKS is shown first; its map image is
 *     missing and the notice offers the download; the first request is for
 *     the middle of the map; a refusing server stops the
 *     job with a plain reason, the panel shows the refused image's address
 *     and the activity log has the refusal in full and copies it as it is in
 *     the log file; Standard detail downloads and the map shows it
 *     (markers on the dots), counting the corner image that the server
 *     answers like an object store without it as not on the server; Full
 *     detail fetches only the missing level, never asks for the images under
 *     that corner, pauses
 *     (no requests while paused) and resumes; the app is closed mid-way;
 *  2. the unfinished job is offered again and finishes; nothing is fetched
 *     twice; every request has the app's User-Agent and no cookie; a guide link
 *     opens in the system browser; the user switches to the demo game;
 *  3. the demo game is shown again on launch.
 */
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_PORT,
  MAPS,
  MISSING_TILE,
  PACK_ID,
  remoteTileCount,
  STORE_MISSING_TILE,
} from './remotePack.js';
import { DOT, startTileServer } from './tileServer.js';
import { check, here, isolatedEnvironment, sleep, startDriver } from './webdriver.js';

const port = Number(process.env.ATLAS_E2E_TILE_PORT ?? DEFAULT_PORT);
const version = /** @type {{ version: string }} */ (
  JSON.parse(await readFile(here('../package.json'), 'utf8'))
).version;
const userAgent = `Atlas/${version}`;

const [island, cave] = MAPS;
if (!island || !cave) throw new Error('remotePack.js defines two maps');
const standardTotal = remoteTileCount(island, island.maxZoom - 1) + remoteTileCount(cave);
const fullTotal = remoteTileCount(island) + remoteTileCount(cave);
const [islandLow, islandTop] = island.levels;
if (!islandLow || !islandTop) throw new Error('the island has two remote levels');
/** The remote address of island tile (x, y) of a remote level. */
const islandPath = (
  /** @type {import('./remotePack.js').RemoteLevel} */ level,
  /** @type {number} */ x,
  /** @type {number} */ y,
) => `/island/${level.sourceZ}/${x + level.offsetX}/${y + level.offsetY}.png`;
// The middle of level 2 (4 x 3 tiles) is asked for first.
const centrePath = islandPath(islandLow, 1, 1);
// The corner the server does not have, and the four tiles under it.
const storePath = islandPath(islandLow, STORE_MISSING_TILE.x, STORE_MISSING_TILE.y);
const underStore = [0, 1].flatMap((dx) =>
  [0, 1].map((dy) =>
    islandPath(islandTop, 2 * STORE_MISSING_TILE.x + dx, 2 * STORE_MISSING_TILE.y + dy),
  ),
);

/** @param {import('./webdriver.js').Session} s @param {string} state */
const waitForPanel = (s, state, timeout = 60_000) =>
  s.waitFor(
    `document.querySelector('[data-testid="download-panel"]')?.dataset.state === '${state}'`,
    {
      timeout,
      what: `the download panel to be ${state}`,
    },
  );

/** @param {import('./webdriver.js').Session} s */
const gameId = (s) =>
  s.run(`
    const select = [...document.querySelectorAll('.topbar select')]
      .find((el) => [...el.options].some((o) => o.value === 'demo'));
    return select?.value ?? null;`);

/**
 * The colour of a tile pixel as the pack protocol serves it: the map image at
 * image pixel (x, y) on level z.
 * @param {import('./webdriver.js').Session} s
 * @param {import('./remotePack.js').TestMap} map
 * @param {number} z @param {number} x @param {number} y
 */
async function tilePixel(s, map, z, x, y) {
  const scale = 2 ** (z - map.maxZoom);
  const tx = Math.floor((x * scale) / 256);
  const ty = Math.floor((y * scale) / 256);
  const px = Math.floor(x * scale) % 256;
  const py = Math.floor(y * scale) % 256;
  return s.runAsync(
    `const [path, px, py] = args;
     const config = await (await fetch(new URL('config.json', document.baseURI))).json();
     const pack = config.packs.find((p) => p.id === '${PACK_ID}');
     const response = await fetch(new URL(path, pack.url));
     if (!response.ok) return { status: response.status };
     const bitmap = await createImageBitmap(await response.blob());
     const canvas = document.createElement('canvas');
     canvas.width = bitmap.width;
     canvas.height = bitmap.height;
     const context = canvas.getContext('2d');
     context.drawImage(bitmap, 0, 0);
     return { status: 200, rgb: [...context.getImageData(px, py, 1, 1).data.slice(0, 3)] };`,
    [`tiles/${map.slug}/${z}/${tx}/${ty}.png`, px, py],
  );
}

/** @param {number[] | undefined} rgb @param {number[]} want */
const near = (rgb, want, tolerance = 40) =>
  !!rgb && rgb.every((value, i) => Math.abs(value - (want[i] ?? 0)) <= tolerance);

/**
 * The colour of the map image the window shows under the centre of the map,
 * read from the tile image there.
 * @param {import('./webdriver.js').Session} s
 */
const renderedCentrePixel = (s) =>
  s.runAsync(`
    const box = document.querySelector('[data-testid="map"]').getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const tile = [...document.querySelectorAll('.atlas-tiles img.leaflet-tile-loaded')].find((img) => {
      const r = img.getBoundingClientRect();
      return cx >= r.left && cx < r.right && cy >= r.top && cy < r.bottom;
    });
    if (!tile) return { error: 'no tile under the centre' };
    const r = tile.getBoundingClientRect();
    const bitmap = await createImageBitmap(await (await fetch(tile.src)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const x = Math.floor(((cx - r.left) / r.width) * bitmap.width);
    const y = Math.floor(((cy - r.top) / r.height) * bitmap.height);
    return { src: tile.src, rgb: [...context.getImageData(x, y, 1, 1).data.slice(0, 3)] };`);

/** @param {import('./webdriver.js').Session} s @param {string} layer */
const status = (s, layer) =>
  s.runAsync(`
    const config = await (await fetch(new URL('config.json', document.baseURI))).json();
    const pack = config.packs.find((p) => p.id === '${PACK_ID}');
    const response = await fetch(new URL('offline-tiles/${layer}.json', pack.url), { cache: 'no-store' });
    return response.ok ? response.json() : null;`);

const tiles = await startTileServer({ port });
tiles.setStoreMissing(true);
const environment = await isolatedEnvironment();
const driver = await startDriver({ env: environment.env });
/** @type {import('./webdriver.js').Session | null} */
let session = null;
const fetched = () => tiles.seen.filter((r) => r.status !== 403);

try {
  // ---- First launch -------------------------------------------------------
  session = await driver.session();
  let s = session;
  await s.waitFor(`document.querySelector('[data-testid="marker-count"]')?.textContent === '5'`, {
    what: 'the test pack to load',
  });
  check((await gameId(s)) === PACK_ID, 'the first pack in ATLAS_BUNDLE_PACKS is the default game');
  await s.waitFor(`document.querySelector('[data-testid="download-map-images"]')`, {
    what: 'the download button',
  });
  check(
    (
      await s.run(`return document.querySelector('[data-testid="tile-notice"]').textContent;`)
    ).includes('Map image not installed'),
    'the notice says the map image is missing',
  );
  await s.screenshot('download-1-before');

  await s.click('[data-testid="download-map-images"]');
  await waitForPanel(s, 'choose');
  const numbers = await s.run(`return {
    standard: document.querySelector('[data-testid="detail-standard"]')?.textContent,
    full: document.querySelector('[data-testid="detail-full"]')?.textContent,
  };`);
  console.log('Detail options:', JSON.stringify(numbers));
  check(
    numbers.standard?.startsWith(`${standardTotal} images`),
    `Standard offers ${standardTotal} images`,
  );
  check(numbers.full?.startsWith(`${fullTotal} images`), `Full detail offers ${fullTotal} images`);
  await s.screenshot('download-2-choose');

  // A server that refuses access stops the job with a plain reason.
  tiles.setMode('refuse');
  await s.click('[data-testid="start-download"]');
  await waitForPanel(s, 'stopped');
  const reason = await s.run(
    `return document.querySelector('[data-testid="download-reason"]')?.textContent;`,
  );
  check(
    /refused access \(HTTP 403\)/.test(reason ?? ''),
    'a 403 stops the job with a plain reason',
  );
  const refused = tiles.seen.length;
  check(
    refused >= 1 && refused <= 2,
    `the job stopped after the first refusal (${refused} requests)`,
  );
  check(
    tiles.seen.some((r) => r.path === centrePath),
    `the first request is for the middle of the map (${tiles.seen.map((r) => r.path).join(', ')})`,
  );

  // The panel says which image was refused, and the activity log has it in full.
  await s.waitFor(`document.querySelector('[data-testid="stop-detail-url"]')?.value`, {
    what: 'the address of the refused image',
  });
  const stop = await s.run(`return {
    url: document.querySelector('[data-testid="stop-detail-url"]').value,
    image: document.querySelector('[data-testid="stop-detail-image"]')?.textContent ?? '',
    saved: document.querySelector('[data-testid="stop-detail-saved"]')?.textContent ?? '',
  };`);
  console.log('Stop details:', JSON.stringify(stop));
  const refusedUrls = tiles.seen.map((r) => `http://127.0.0.1:${port}${r.path}`);
  check(refusedUrls.includes(stop.url), 'the panel shows the address of the refused image');
  check(
    /level \d+: column \d+ of \d+, row \d+ of \d+/.test(stop.image),
    'the panel says where the refused image is on the map',
  );
  check(stop.saved.startsWith('0 images'), 'the panel says no image was saved before it');
  await s.screenshot('download-3-error');

  await s.click('[data-testid="view-log"]');
  await s.waitFor(
    `document.querySelector('[data-testid="log-dialog"]')?.open &&
      [...document.querySelectorAll('[data-testid="log-row"]')].some((row) =>
        row.textContent.includes(${JSON.stringify(stop.url)}) &&
        row.textContent.includes('HTTP 403'))`,
    { what: 'the refusal in the activity log' },
  );
  check(
    (await s.run(`return document.querySelector('[data-testid="log-area"]').value;`)) ===
      'download',
    'the log opens on downloads',
  );
  await sleep(300);
  await s.screenshot('download-3-log');
  // Errors only, then copy what is shown. The clipboard is stood in for, so
  // the test reads what would be copied and leaves the real one alone.
  await s.run(`
    const select = document.querySelector('[data-testid="log-level"]');
    select.value = 'error';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    window.atlasCopied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { window.atlasCopied.push(text); } },
    });`);
  await s.waitFor(
    `[...document.querySelectorAll('[data-testid="log-row"]')].every((row) => row.dataset.level === 'error')`,
    { what: 'only errors in the log' },
  );
  await s.click('[data-testid="log-copy"]');
  await s.waitFor(`window.atlasCopied.length === 1`, { what: 'the log to be copied' });
  const copied = /** @type {string} */ (await s.run('return window.atlasCopied[0];'));
  const logFile = join(environment.root, 'data', 'atlas', 'logs', 'atlas.log');
  const errorLines = (await readFile(logFile, 'utf8'))
    .split('\n')
    .filter((line) => / download error: /.test(line));
  const refusal = errorLines.find((line) => line.includes(stop.url));
  console.log('Logged refusal:', refusal);
  // Lines can be added after the dialog read the file; none can be missing.
  const copiedLines = copied.endsWith('\n') ? copied.slice(0, -1).split('\n') : [];
  check(
    copiedLines.length >= 1 &&
      copiedLines.every((line, i) => line === errorLines[i]) &&
      copiedLines.length ===
        (await s.run(`return document.querySelectorAll('[data-testid="log-row"]').length;`)),
    `Copy takes the shown download errors as they are in the log file (${copiedLines.length} lines)`,
  );
  check(
    !!refusal &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[[^\]]+\] download error: /.test(refusal) &&
      refusal.includes('HTTP 403') &&
      refusal.includes('content-type: text/plain') &&
      refusal.includes('body: Forbidden'),
    'the log line has the time, app, address, answer headers and body',
  );
  await s.waitFor(
    `/Copied/.test(document.querySelector('[data-testid="log-status"]')?.textContent ?? '')`,
    { what: 'the copy to be confirmed' },
  );
  await s.click('[data-testid="log-dialog"] .icon-button');
  await s.waitFor(`!document.querySelector('[data-testid="log-dialog"]')?.open`, {
    what: 'the activity log to close',
  });

  // Standard detail.
  tiles.setMode('slow');
  await s.click('[data-testid="download-panel"] .button-primary');
  await waitForPanel(s, 'running');
  await s.waitFor(
    `/images\\/s/.test(document.querySelector('[data-testid="download-rate"]')?.textContent ?? '')`,
    {
      what: 'a download speed',
    },
  );
  await s.screenshot('download-4-progress');
  await waitForPanel(s, 'done', 120_000);
  const standardFetched = fetched().map((r) => r.path);
  check(
    standardFetched.length === standardTotal - 1 &&
      new Set(standardFetched).size === standardTotal - 1,
    `Standard fetched the ${standardTotal - 1} tiles the server has once each`,
  );
  check(
    tiles.seen.filter((r) => r.path === storePath).length === 1,
    'the corner the store does not have was asked for once',
  );
  const summary = await s.run(
    `return document.querySelector('[data-testid="download-summary"]')?.textContent ?? '';`,
  );
  check(
    summary.includes('1 not on the server'),
    `the summary counts it as not on the server (${summary})`,
  );
  const surface = await status(s, 'island');
  check(
    surface?.nativeMinZoom === 0 &&
      surface?.nativeMaxZoom === island.maxZoom - 1 &&
      !surface.complete,
    'the status file lists levels 0 to 2 of the island',
  );
  await s.waitFor(
    `!document.querySelector('[data-testid="tile-notice"]') &&
      document.querySelectorAll('.atlas-tiles img.leaflet-tile-loaded').length > 0`,
    {
      what: 'the map to show the downloaded tiles without a restart',
    },
  );
  const centre = await renderedCentrePixel(s);
  console.log('Map image under the centre beacon:', JSON.stringify(centre));
  check(near(centre.rgb, DOT), 'the centre marker sits on its dot in the shown map image');
  for (const beacon of island.beacons) {
    const pixel = await tilePixel(s, island, 2, beacon.x, beacon.y);
    check(near(pixel.rgb, DOT, 10), `level 2 has the dot under ${beacon.name}`);
  }
  const built = await tilePixel(s, island, 0, 1024, 768);
  check(built.status === 200, 'level 0 was built from the downloaded level');
  check(
    (built.rgb?.[0] ?? 0) > 140 && (built.rgb?.[1] ?? 255) < 140,
    'the built level shows the dot',
  );
  await s.screenshot('download-5-done');

  // Full detail: only the top level is fetched. Pause, then close the app mid-way.
  await s.click('[data-testid="download-panel"] .row-actions .button:not(.button-primary)');
  await waitForPanel(s, 'choose');
  await s.click('[data-detail="full"]');
  await s.click('[data-testid="start-download"]');
  await waitForPanel(s, 'running');
  await s.waitFor(
    `/\\b([1-9]\\d*) of/.test(document.querySelector('[data-testid="download-count"]')?.textContent ?? '')`,
    {
      what: 'the first full-detail tiles',
    },
  );
  await s.click('[data-testid="pause-download"]');
  await waitForPanel(s, 'paused');
  await sleep(1500);
  const whilePaused = tiles.seen.length;
  await sleep(2500);
  check(tiles.seen.length === whilePaused, 'no requests while paused');
  await s.screenshot('download-6-paused');
  await s.resize(720, 800);
  await sleep(500);
  await s.screenshot('download-6-paused-narrow');
  await s.resize(1280, 800);
  await s.click('[data-testid="resume-download"]');
  await waitForPanel(s, 'running');
  await s.waitFor(
    `(() => { const t = document.querySelector('[data-testid="download-count"]')?.textContent ?? '';
      const n = Number(t.split(' ')[0].replace(/,/g, '')); return n > ${standardTotal + 8}; })()`,
    {
      what: 'more full-detail tiles',
    },
  );
  await s.close();
  session = null;
  const beforeRestart = fetched().length;
  check(beforeRestart < fullTotal, `the app was closed mid-way (${beforeRestart} of ${fullTotal})`);

  // ---- Second launch ------------------------------------------------------
  session = await driver.session();
  s = session;
  await s.waitFor(`document.querySelector('[data-testid="marker-count"]')?.textContent === '5'`);
  check((await gameId(s)) === PACK_ID, 'the game is still the test pack');
  await s.waitFor(`document.querySelectorAll('.atlas-tiles img.leaflet-tile-loaded').length > 0`, {
    what: 'tiles shown at once after a restart',
  });
  await s.click('[data-testid="map-images-button"]');
  await s.waitFor(`document.querySelector('[data-testid="download-unfinished"]')`, {
    what: 'the unfinished download to be offered',
  });
  await s.screenshot('download-7-unfinished');
  tiles.setMode('ok');
  await s.click('[data-testid="download-unfinished"] .button-primary');
  await waitForPanel(s, 'done', 120_000);
  await s.screenshot('download-8-full-done');

  const all = fetched();
  const counts = new Map();
  for (const request of all) counts.set(request.path, (counts.get(request.path) ?? 0) + 1);
  check(
    counts.size === fullTotal - 1 - underStore.length,
    `every remote tile was fetched but the missing corner and the ${underStore.length} under it`,
  );
  check(
    underStore.every((path) => !tiles.seen.some((r) => r.path === path)),
    'the tiles under the missing corner were never asked for',
  );
  check(
    tiles.seen.filter((r) => r.path === storePath).length === 1,
    'the missing corner was not asked for again',
  );
  check(
    standardFetched.every((path) => counts.get(path) === 1),
    'the upgrade to full detail fetched nothing twice',
  );
  // A tile in flight when the app closed may be fetched again; nothing else.
  check(
    all.length <= fullTotal - 1 - underStore.length + 2,
    `at most the tiles in flight were fetched again (${all.length})`,
  );
  const missingPath = `/${MISSING_TILE.map}/13/${MISSING_TILE.x + 200}/${MISSING_TILE.y + 400}.png`;
  check(counts.get(missingPath) === 1, 'a 404 tile was asked for once');
  check(
    tiles.seen.every(
      (r) => r.userAgent === userAgent && r.accept === 'image/*' && r.cookie === undefined,
    ),
    `every request says "${userAgent}", asks for images and sends no cookie`,
  );
  const logText = await readFile(logFile, 'utf8');
  check(
    logText.includes(
      `Counting http://127.0.0.1:${port}${storePath} as not on the server: the store answered "access denied"`,
    ),
    'the log says why the missing corner counts as not on the server',
  );
  check(
    /[1-9]\d* not asked for, because the area above them is not on the server/.test(logText),
    'the log counts the tiles that were not asked for',
  );
  const full = await status(s, 'island');
  check(full?.complete === true && full.nativeMaxZoom === island.maxZoom, 'the island is complete');
  for (const beacon of island.beacons) {
    const pixel = await tilePixel(s, island, 3, beacon.x, beacon.y);
    check(near(pixel.rgb, DOT, 10), `level 3 has the dot under ${beacon.name}`);
  }
  for (const beacon of cave.beacons) {
    const pixel = await tilePixel(s, cave, 2, beacon.x, beacon.y);
    check(near(pixel.rgb, DOT, 10), `the cave has the dot under ${beacon.name}`);
  }

  // Close up on the centre beacon, then follow its guide link.
  await s.click('[data-testid="download-panel"] .icon-button');
  await s.type('input[role="combobox"]', 'Centre beacon');
  await s.waitFor(
    `document.querySelector('[data-testid="selected-name"]')?.textContent === 'Centre beacon'`,
  );
  await sleep(1500);
  const close = await renderedCentrePixel(s);
  console.log('Close up under the centre beacon:', JSON.stringify(close));
  check(near(close.rgb, DOT), 'close up, the centre marker sits on its dot');
  await s.screenshot('download-9-markers-on-dots');
  const pageUrl = await s.run('return location.href;');
  await s.click('.guide-body a');
  let opened = '';
  for (let start = Date.now(); Date.now() - start < 10_000 && !opened; await sleep(250)) {
    opened = await readFile(environment.opened, 'utf8').catch(() => '');
  }
  check(
    opened.trim() === 'https://example.com/atlas-e2e-guide',
    'the guide link opened in the system browser',
  );
  check((await s.run('return location.href;')) === pageUrl, 'the window stayed on the app');

  await s.click('.topbar option[value="demo"]');
  await s.waitFor(
    `document.querySelector('[data-testid="marker-count"]')?.textContent === '5,000'`,
    {
      what: 'the demo game',
    },
  );
  await sleep(500);
  await s.close();
  session = null;

  // ---- Third launch -------------------------------------------------------
  session = await driver.session();
  s = session;
  await s.waitFor(
    `document.querySelector('[data-testid="marker-count"]')?.textContent === '5,000'`,
    {
      what: 'the demo game after a restart',
    },
  );
  check((await gameId(s)) === 'demo', 'the last game picked is shown after a restart');
} finally {
  await session?.close();
  driver.stop();
  await tiles.close();
  await rm(environment.root, { recursive: true, force: true });
}
