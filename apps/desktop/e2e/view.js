// @ts-check
/**
 * "View map page" and "Save map images as I browse" test, on any desktop
 * build (Linux):
 *
 *   pnpm desktop:build --no-bundle
 *   xvfb-run -a pnpm --filter @atlas/desktop test:e2e:view [path/to/binary]
 *
 * Only local servers on 127.0.0.1 are used (`mapPageSite.js`): a made-up map
 * site and its image server, which counts every request. Before the first
 * launch the test writes a pack made from two of the site's pages into the
 * maps folder, with one map image already in it.
 *
 * It checks that the Maps dialog lists the pack's pages; that "Open in my
 * browser" hands the recorded address to the system browser; that pages
 * the pack does not record are refused; that plain viewing saves nothing;
 * and then, with saving on, that the map images the page loads with fetch
 * and XMLHttpRequest land in the pack where "Download map images" puts
 * them, that the image already there is kept, that other images are
 * ignored, that three images at the map's edge, which the image server
 * answers the way an object store answers for an image it does not have
 * before the page loads the rest of their level, are recorded as not on
 * the server (the downloader's marker, the count on
 * the card and a line in the activity log) and let their level complete,
 * that the status file and the manifest are brought up to date,
 * that a download of the same pack cannot start meanwhile, that the page
 * cannot reach the app, and, the point of it all, that the image server saw
 * each image asked for exactly once: saving makes no request of its own.
 * A page that shows its images with `<img>` elements gets "could not be
 * saved" and nothing written; closing the window stops saving.
 */
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CAVES,
  PACK_ID,
  remoteTiles,
  startMapPageSite,
  STORE_MISSING,
  tileImage,
  WORLD,
  writePack,
} from './mapPageSite.js';
import { check, isolatedEnvironment, sleep, startDriver } from './webdriver.js';

const exists = (/** @type {string} */ path) =>
  access(path).then(
    () => true,
    () => false,
  );
const readJson = async (/** @type {string} */ path) =>
  /** @type {any} */ (JSON.parse(await readFile(path, 'utf8')));

const environment = await isolatedEnvironment();
const data = environment.env.XDG_DATA_HOME ?? '';
const maps = join(data, 'atlas', 'maps');
const pack = join(maps, PACK_ID);

const site = await startMapPageSite();
const worldPage = `${site.url}/my-game/world`;
await writePack(pack, site.url, site.images);

// One image is already in the pack, in another colour than the server's.
const worldTiles = remoteTiles(WORLD);
const caveTiles = remoteTiles(CAVES);
const kept = worldTiles.find((tile) => tile.z === 2 && tile.x === 0 && tile.y === 0);
if (!kept) throw new Error('the world map has a level 2');
const keptBytes = tileImage('/0/0/0');
// The world map's edge on level 2, which the store does not have once saving starts.
const edgeTiles = worldTiles.filter((tile) =>
  STORE_MISSING.some((t) => t.z === tile.z && t.x === tile.x && t.y === tile.y),
);
if (edgeTiles.length !== STORE_MISSING.length) throw new Error('the edge tiles are on the map');
await mkdir(join(pack, 'tiles', 'world', '2', '0'), { recursive: true });
await writeFile(join(pack, 'tiles', 'world', '2', '0', '0.png'), keptBytes);

const tilePath = (
  /** @type {string} */ map,
  /** @type {{ z: number, x: number, y: number }} */ t,
) => join(pack, 'tiles', map, String(t.z), String(t.x), `${t.y}.png`);
/** Image files of a map in the pack, by their path inside the pack. */
const filesOf = async (
  /** @type {string} */ map,
  /** @type {{ z: number, x: number, y: number }[]} */ tiles,
) => {
  const found = [];
  for (const tile of tiles) if (await exists(tilePath(map, tile))) found.push(tile);
  return found;
};

/** @typedef {import('./webdriver.js').Session} Session */

/** @param {Session} s @param {string} testId */
const count = async (s, testId) =>
  Number(
    await s.run(`return document.querySelector('[data-testid="${testId}"]')?.dataset.count ?? -1;`),
  );

/** @param {Session} s @param {string} state */
const waitForCard = (s, state, timeout = 30_000) =>
  s.waitFor(
    `document.querySelector('[data-testid="map-page-status"]')?.dataset.state === '${state}'`,
    { timeout, what: `the map page card to be ${state}` },
  );

/** Opens the Maps dialog and the pack's page list. @param {Session} s */
async function openPageList(s) {
  await s.click('[data-testid="maps-button"]');
  await s.waitFor(
    `document.querySelector('[data-pack="${PACK_ID}"] [data-testid="map-page-details"]')`,
    {
      what: 'the pack in the Maps dialog',
    },
  );
  // The pack list scrolls; bring the pack into view as a person would.
  await s.run(
    `document.querySelector('[data-pack="${PACK_ID}"]').scrollIntoView({ block: 'center' });`,
  );
  await s.click(`[data-pack="${PACK_ID}"] [data-testid="map-page-details"] summary`);
  await s.waitFor(
    `document.querySelectorAll('[data-pack="${PACK_ID}"] [data-testid="map-page"]').length === 2`,
    { what: 'the pack’s two pages' },
  );
}

/** Clicks an action of one of the pack's pages. @param {Session} s @param {number} index @param {string} action */
const pageAction = (s, index, action) =>
  s.click(
    `[data-pack="${PACK_ID}"] [data-testid="map-page"]:nth-child(${index + 1}) [data-testid="${action}"]`,
  );

/** Total requests the image server saw. */
const imageRequestTotal = () => [...site.imageRequests.values()].reduce((a, b) => a + b, 0);

/** Waits until the image server has seen `total` requests. */
async function waitForImageRequests(/** @type {number} */ total, timeout = 30_000) {
  for (let start = Date.now(); Date.now() - start < timeout; await sleep(200)) {
    if (imageRequestTotal() >= total) return;
  }
  throw new Error(`the page made ${imageRequestTotal()} image requests, not ${total}`);
}

/** Calls a shell command from the app's page and returns `ok` or the refusal. @param {Session} s @param {string} command @param {Record<string, unknown>} args */
const invoke = (s, command, args) =>
  s.runAsync(
    `try { await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}); return 'ok'; }
     catch (error) { return 'refused: ' + String(error && error.message || error); }`,
  );

/**
 * Sends the "close" request a window's close button sends (WM_DELETE_WINDOW)
 * to a window of the app whose title starts with `title`, through Xlib with
 * Python's ctypes: there is no window manager under Xvfb, and xdotool's
 * `windowclose` destroys the window instead, which ends the app. False when
 * that cannot be done here.
 */
function closeWindowByHand(/** @type {string} */ title) {
  const run = (/** @type {string} */ command, /** @type {string[]} */ args) =>
    execFileSync(command, args, { env: environment.env }).toString().trim();
  const send = `
import ctypes, sys
x = ctypes.cdll.LoadLibrary('libX11.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XInternAtom.restype = ctypes.c_ulong
x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
class Event(ctypes.Structure):
    _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong), ('send_event', ctypes.c_int),
                ('display', ctypes.c_void_p), ('window', ctypes.c_ulong), ('message_type', ctypes.c_ulong),
                ('format', ctypes.c_int), ('l', ctypes.c_long * 5), ('pad', ctypes.c_long * 12)]
x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(Event)]
x.XFlush.argtypes = [ctypes.c_void_p]
x.XCloseDisplay.argtypes = [ctypes.c_void_p]
display = x.XOpenDisplay(None)
window = int(sys.argv[1])
event = Event(type=33, window=window, message_type=x.XInternAtom(display, b'WM_PROTOCOLS', 0), format=32)
event.l[0] = x.XInternAtom(display, b'WM_DELETE_WINDOW', 0)
sent = x.XSendEvent(display, window, 0, 0, ctypes.byref(event))
x.XFlush(display)
x.XCloseDisplay(display)
sys.exit(0 if sent else 1)
`;
  try {
    // Every window, by class: xdotool's name search does not read every title encoding.
    const id = run('xdotool', ['search', '--class', ''])
      .split('\n')
      .find((window) => {
        try {
          return run('xdotool', ['getwindowname', window]).startsWith(title);
        } catch {
          return false;
        }
      });
    if (!id) return false;
    run('python3', ['-I', '-c', send, id]);
    return true;
  } catch {
    return false;
  }
}

/** Whether the pack folder's lock is free, as another app would find it. */
function packIsFree() {
  try {
    execFileSync('flock', ['--nonblock', join(pack, '.atlas', 'lock'), 'true'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

const driver = await startDriver({ env: environment.env });
/** @type {Session | null} */
let session = null;
let passed = false;
// The world page loads its levels 1 and 2, a marker icon and a level the pack does not use.
const worldRequests = worldTiles.length + 2;

try {
  session = await driver.session();
  const s = session;
  await s.waitFor(`document.querySelector('[data-testid="maps-button"]')`, {
    what: 'the app to start',
  });

  // ---- The pack's pages ------------------------------------------------------
  await openPageList(s);
  const labels = await s.run(
    `return [...document.querySelectorAll('[data-pack="${PACK_ID}"] [data-testid="map-page"] .map-page-name')].map((el) => el.textContent);`,
  );
  check(
    JSON.stringify(labels) === JSON.stringify(['World', 'Caves']),
    `the Maps dialog lists the pages the pack was made from (${labels})`,
  );
  await s.screenshot('view-0-map-pages');

  await pageAction(s, 0, 'map-page-browser');
  for (let start = Date.now(); Date.now() - start < 10_000; await sleep(200)) {
    if (await exists(environment.opened)) break;
  }
  const opened = (await readFile(environment.opened, 'utf8').catch(() => '')).trim();
  check(opened === worldPage, `"Open in my browser" opens the recorded address (${opened})`);

  for (const [command, args] of /** @type {[string, Record<string, unknown>][]} */ ([
    ['view_open', { packId: PACK_ID, url: `${site.url}/my-game/other`, save: false }],
    ['view_open', { packId: PACK_ID, url: 'https://example.com/', save: true }],
    ['view_open_in_browser', { packId: PACK_ID, url: `${site.url}/elsewhere` }],
    ['view_open', { packId: 'demo', url: worldPage, save: false }],
  ])) {
    const answer = await invoke(s, command, args);
    check(
      String(answer).includes('Only pages this map pack was made from'),
      `${command} refuses an address the pack does not record (${args.url}, ${args.packId})`,
    );
  }

  // ---- Plain viewing saves nothing ---------------------------------------------
  await pageAction(s, 0, 'map-page-view');
  await waitForCard(s, 'open');
  await waitForImageRequests(worldRequests);
  await sleep(1500);
  check(
    (await filesOf('world', worldTiles)).length === 1,
    'plain viewing writes nothing into the pack',
  );
  check(
    !(await exists(join(pack, 'offline-tiles'))),
    'plain viewing leaves the status files alone',
  );
  await s.click('[data-testid="map-page-close"]');
  await s.waitFor(`!document.querySelector('[data-testid="map-page-status"]')`, {
    what: 'the card to go after plain viewing',
  });
  site.imageRequests.clear();

  // ---- Saving while browsing -------------------------------------------------------
  site.setStoreMissing(true);
  await openPageList(s);
  await pageAction(s, 0, 'map-page-save');
  await waitForCard(s, 'saving');
  check(!packIsFree(), 'saving holds the pack folder’s lock');
  const blocked = await invoke(s, 'tiles_start', { packId: PACK_ID, detail: 'full' });
  check(
    String(blocked).startsWith('refused') && imageRequestTotal() <= worldRequests,
    `a download of the same pack cannot start while saving (${blocked})`,
  );
  await waitForImageRequests(worldRequests);
  await s.waitFor(
    `document.querySelector('[data-testid="map-page-saved"]')?.dataset.count === '${worldTiles.length - 1 - edgeTiles.length}' &&
      document.querySelector('[data-testid="map-page-had"]')?.dataset.count === '1' &&
      document.querySelector('[data-testid="map-page-not-on-server"]')?.dataset.count === '${edgeTiles.length}'`,
    { what: 'every image of the world page to be saved or found not on the server' },
  );
  check((await count(s, 'map-page-not-saved')) === 0, 'nothing on the world page failed');
  const edgeLine = String(
    await s.run(
      `return document.querySelector('[data-testid="map-page-not-on-server"]').textContent;`,
    ),
  );
  check(
    edgeLine === `${edgeTiles.length} not on the server (the map’s edge)`,
    `the card counts the images not on the server (${edgeLine})`,
  );
  await s.screenshot('view-1-saving');

  let same = true;
  for (const tile of worldTiles) {
    if (edgeTiles.includes(tile)) continue;
    const bytes = await readFile(tilePath('world', tile));
    const expected = tile === kept ? keptBytes : tileImage(tile.path);
    same &&= Buffer.compare(bytes, expected) === 0;
  }
  check(same, 'each image is in the pack where the downloader puts it, as the server sent it');
  check(
    Buffer.compare(await readFile(tilePath('world', kept)), keptBytes) === 0,
    'the image that was already there is kept as it was',
  );
  let marked = true;
  for (const tile of edgeTiles) {
    marked &&=
      !(await exists(tilePath('world', tile))) &&
      (await readFile(`${tilePath('world', tile)}.404`)).length === 0;
  }
  check(
    marked,
    'the images the store does not have get the downloader’s "not on the server" marker',
  );
  check(!(await exists(join(pack, 'tiles', 'world', '3'))), 'nothing is marked below them');
  check(
    !(await exists(join(pack, 'tiles', 'icons'))) &&
      !(await exists(join(pack, 'tiles', 'world', '4'))),
    'images that are not the pack’s map images are ignored',
  );
  const probe = /** @type {any} */ (site.probes.at(-1));
  console.log('What the page could do:', JSON.stringify(probe));
  check(!!probe && String(probe.invoke).startsWith('denied'), 'the page cannot call the app');
  check(
    !String(probe[`atlas-pack://localhost/${PACK_ID}/manifest.json`]).startsWith('status 200') &&
      !String(probe[`http://atlas-pack.localhost/${PACK_ID}/manifest.json`]).startsWith(
        'status 200',
      ),
    'the page cannot read the app’s packs',
  );
  check(!site.seen.some((r) => r.path === '/popup'), 'the page cannot open windows');
  check(!site.seen.some((r) => r.path === '/elsewhere'), 'the page cannot leave for another site');

  await s.click('[data-testid="map-page-stop"]');
  await waitForCard(s, 'open');
  const status = await readJson(join(pack, 'offline-tiles', 'world.json'));
  check(
    JSON.stringify(status.levels) === '[0,1,2]' && status.complete === true,
    `the status file records the complete levels (${JSON.stringify(status.levels)})`,
  );
  check(await exists(join(pack, 'tiles', 'world', '0', '0', '0.png')), 'level 0 was built');
  const manifest = await readJson(join(pack, 'manifest.json'));
  const images = manifest.contents.maps[0].layers[0].images;
  check(
    images?.complete === true && images.files === worldTiles.length + 1 - edgeTiles.length,
    `the manifest records the images (${JSON.stringify(images)})`,
  );
  check(
    manifest.source.pages.length === 2 && manifest.title === 'My Game',
    'the rest of the manifest is unchanged',
  );
  await sleep(1000);
  const counts = [...site.imageRequests.entries()];
  check(
    counts.length === worldRequests && counts.every(([, n]) => n === 1),
    `the image server saw each of the ${worldRequests} images asked for exactly once (${counts.length} paths, ${imageRequestTotal()} requests)`,
  );
  check(
    worldTiles.every((tile) => site.imageRequests.get(tile.path) === 1),
    'saving made no request of its own',
  );
  const logText = await readFile(join(data, 'atlas', 'logs', 'atlas.log'), 'utf8');
  const edgeLog = logText
    .split('\n')
    .find((line) => line.includes('Saving as you browse: counting'));
  console.log('Logged edge:', edgeLog);
  check(
    !!edgeLog &&
      new RegExp(
        `counting ${site.images.replace(/[.]/g, '\\.')}/tiles/world/6/\\d+/6\\.png as not on the server \\(the map's edge\\): the store answered the page's own request with "access denied" \\(HTTP 403 with an AccessDenied error document\\), as it does for images that do not exist, and then sent an image of this layer, so it is still serving`,
      ).test(edgeLog) &&
      logText.split('\n').filter((line) => line.includes('Saving as you browse: counting'))
        .length === 1,
    'the activity log says once why the map’s edge counts as not on the server',
  );
  check(
    logText.includes(`${edgeTiles.length} not on the server (the map's edge)`),
    'the summary when saving stops counts them',
  );
  check(
    !logText.includes('are not recorded as missing'),
    'no "access denied" answer was left without an image after it',
  );
  await s.click('[data-testid="map-page-close"]');
  await waitForCard(s, 'closed');
  check(packIsFree(), 'the pack is free again after saving stopped');
  // The map shows the saved images, without asking any server.
  await s.click('[data-testid="maps-button"]');
  await s.waitFor(`document.querySelector('[data-pack="${PACK_ID}"]')`);
  await s.run(
    `document.querySelector('[data-pack="${PACK_ID}"]').scrollIntoView({ block: 'center' });`,
  );
  await s.click(`[data-pack="${PACK_ID}"] .row-actions .link-button`);
  await s.waitFor(
    `[...document.querySelectorAll('.topbar select')].some((el) => el.value === '${PACK_ID}') &&
      !document.querySelector('[data-testid="tile-notice"]') &&
      document.querySelectorAll('.atlas-tiles img.leaflet-tile-loaded').length > 0`,
    { what: 'the pack to show its saved map images' },
  );
  await sleep(1000);
  await s.screenshot('view-2-saved-images');
  check(
    imageRequestTotal() === worldRequests,
    'the map shows the saved images without asking the image server',
  );
  await s.click('[data-testid="map-page-dismiss"]');
  site.imageRequests.clear();

  site.setStoreMissing(false);

  // ---- A page with <img> elements ---------------------------------------------------
  await openPageList(s);
  await pageAction(s, 1, 'map-page-save');
  await waitForCard(s, 'saving');
  await waitForImageRequests(caveTiles.length);
  await s.waitFor(
    `document.querySelector('[data-testid="map-page-not-saved"]')?.dataset.count === '${caveTiles.length}'`,
    { what: 'the images shown with elements to be counted' },
  );
  check((await count(s, 'map-page-saved')) === 0, 'nothing is saved from <img> elements');
  const note = String(
    await s.run(
      `return [...document.querySelectorAll('[data-testid="map-page-note"]')].map((el) => el.textContent).join(' ');`,
    ),
  );
  check(
    note.includes('could not be saved this way'),
    'the card says plainly that some images could not be saved this way',
  );
  check((await filesOf('caves', caveTiles)).length === 0, 'no cave images were written');
  await s.screenshot('view-3-not-saved');
  // Closing the window itself stops saving.
  // Closing the window itself (as with its close button) stops saving.
  const closedByHand = closeWindowByHand('Map page');
  if (!closedByHand) await s.click('[data-testid="map-page-close"]');
  await waitForCard(s, 'closed');
  check(true, `closing the window ${closedByHand ? 'itself' : 'from the card'} stops saving`);
  check(
    caveTiles.every((tile) => site.imageRequests.get(tile.path) === 1),
    'the image server saw each cave image exactly once',
  );
  check(packIsFree(), 'the pack is free again after the window closed');
  await s.screenshot('view-4-closed');
  passed = true;
} finally {
  await session?.close();
  driver.stop();
  await site.close();
  if (passed) await rm(environment.root, { recursive: true, force: true });
  else console.log(`Test data kept in ${environment.root}`);
}
