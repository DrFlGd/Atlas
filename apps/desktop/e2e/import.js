// @ts-check
/**
 * Desktop maps library and "Add a map" test, on a build with the made-up
 * demo importer and with downloads:
 *
 *   pnpm --filter @atlas/desktop e2e:pack        # writes packs/e2e-remote/ and packs/test-isles/
 *   ATLAS_ENABLE_DOWNLOADS=1 ATLAS_BUNDLE_PACKS=e2e-remote,demo,test-isles \
 *     ATLAS_BUNDLE_IMPORTERS=packages/importer-api/demo/demo-importer.js \
 *     pnpm desktop:build --no-bundle
 *   xvfb-run -a pnpm --filter @atlas/desktop test:e2e:import [path/to/binary]
 *
 * Linux only, like the download test: the app's data, the shared maps folder
 * and settings live in a temporary folder (XDG_DATA_HOME). The imported pages
 * come from a made-up site on 127.0.0.1 (`demoSite.js`) and the map images of
 * the test pack from the mock tile server; no request leaves this computer.
 *
 * Before the first launch it sets up what an earlier version and the person
 * would have left behind: a half-done version 0.2.0 download of the test
 * pack in the old app data folder, and a settings file that remembers a
 * copied pack folder (with its map images, under a path with spaces and
 * non-ASCII letters), a folder holding a second pack with an id already
 * shown, a folder on a drive that is gone, and a folder that is not a pack.
 *
 * Launch 1: the old download moves into the pack folder in the maps folder
 * and finishes without fetching what was there; download settings are saved
 * to the shared file; the Maps dialog lists every location with its state and
 * the hidden duplicate, forgets a location without deleting files, and the
 * copied pack shows its own map images. Then "Add a map": an address no
 * importer knows; a page whose data appears after a while (the page can't
 * call the app, read its packs, open windows or leave for another site); a
 * second map of the same game (one pack, two maps); the first page again
 * after the site changed (refreshed in place); a game that comes with the
 * app; data in the wrong shape; cancelling; waiting too long; and
 * downloading the imported game's map images into its pack folder.
 * Launch 2: everything is still there; the imported pack is deleted. Then
 * several addresses at once: two pages of one game, one of another, a game
 * that comes with the app, a page whose data never appears, a repeat and an
 * address no importer knows. The pages open one at a time, in the order
 * given, with the pause between them, and the run goes on past the pages
 * that were not added. Then a game's address: its game page is read, its
 * pages are listed (maps first, a guide as not supported yet), and the
 * ticked ones are added, a checklist among them; the site adds a map, and
 * "Update from the site…" lists it as new and adds it. The game that comes
 * with the app and was made from the site's pages (`islesPack.js`) is
 * refreshed from the site into the maps folder with a newer version, its
 * other map kept, and the site's list of worlds is read.
 * Launch 3: the refreshed game that comes with the app is kept.
 */
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SITE_PORT,
  startDemoSite,
  tileCount,
  UPDATED_ISLE_PLACE,
  UPDATED_PLACE,
  WORLDS,
} from './demoSite.js';
import { ISLES_ID } from './islesPack.js';
import {
  DEFAULT_PORT,
  levelGrid,
  MAPS,
  PACK_ID,
  packFiles,
  remoteTileCount,
} from './remotePack.js';
import { drawTile, startTileServer } from './tileServer.js';
import { check, here, isolatedEnvironment, sleep, startDriver } from './webdriver.js';

const port = Number(process.env.ATLAS_E2E_TILE_PORT ?? DEFAULT_PORT);
const version = /** @type {{ version: string }} */ (
  JSON.parse(await readFile(here('../package.json'), 'utf8'))
).version;

const [island, cave] = MAPS;
if (!island || !cave) throw new Error('remotePack.js defines two maps');
const standardTotal = remoteTileCount(island, island.maxZoom - 1) + remoteTileCount(cave);
const valley = WORLDS['test-valley'];
const [eastField, westRidge] = valley?.maps ?? [];
if (!eastField || !westRidge) throw new Error('demoSite.js defines two valley maps');

const exists = (/** @type {string} */ path) =>
  access(path).then(
    () => true,
    () => false,
  );
const readJson = async (/** @type {string} */ path) =>
  /** @type {any} */ (JSON.parse(await readFile(path, 'utf8')));

// ---- What earlier runs left behind -----------------------------------------

const environment = await isolatedEnvironment();
const data = environment.env.XDG_DATA_HOME ?? '';
const shared = join(data, 'atlas');
const maps = join(shared, 'maps');
const legacy = join(data, 'dev.atlas.desktop');
const root = environment.root;

/** Writes the test pack's files into `dir`, under another id and title if asked. */
async function writePack(/** @type {string} */ dir, id = PACK_ID, title = 'Remote tiles test') {
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(packFiles(port))) {
    let text = JSON.stringify(content, null, 2);
    if (id !== PACK_ID) {
      text = text.replaceAll(`${PACK_ID}:`, `${id}:`).replaceAll(`"${PACK_ID}"`, `"${id}"`);
      text = text.replace('"Remote tiles test"', JSON.stringify(title));
    }
    await writeFile(join(dir, name), `${text}\n`);
  }
}

// A version 0.2.0 download, stopped half-way: half of the island's level 2
// images in the old overlay folder, and the unfinished job.
const oldOverlay = join(legacy, 'packs', PACK_ID);
const level2 = island.levels.find((level) => level.z === 2);
if (!level2) throw new Error('the island has a remote level 2');
const grid2 = levelGrid(island, 2);
/** @type {string[]} */
const prefilled = [];
for (let y = 0; y < grid2.rows; y++) {
  for (let x = 0; x < grid2.columns; x++) {
    if ((x + y) % 2) continue;
    await mkdir(join(oldOverlay, 'tiles', 'island', '2', String(x)), { recursive: true });
    await writeFile(
      join(oldOverlay, 'tiles', 'island', '2', String(x), `${y}.png`),
      drawTile(island, 2, x, y),
    );
    prefilled.push(`/island/${level2.sourceZ}/${x + level2.offsetX}/${y + level2.offsetY}.png`);
  }
}
await mkdir(join(legacy, 'downloads'), { recursive: true });
await writeFile(
  join(legacy, 'downloads', `${PACK_ID}.json`),
  JSON.stringify({ packId: PACK_ID, detail: 'standard', stopReason: null }),
);

// A pack folder copied from elsewhere, with all of its map images.
const copied = join(root, 'Külső lemez', 'Térképek másolat', 'Copied pack');
await writePack(copied, 'e2e-copied', 'Copied pack');
for (let z = 0; z <= island.maxZoom; z++) {
  const grid = levelGrid(island, z);
  for (let x = 0; x < grid.columns; x++) {
    await mkdir(join(copied, 'tiles', 'island', String(z), String(x)), { recursive: true });
    for (let y = 0; y < grid.rows; y++) {
      await writeFile(
        join(copied, 'tiles', 'island', String(z), String(x), `${y}.png`),
        drawTile(island, z, x, y),
      );
    }
  }
}
// A folder with a second copy of the test pack, which is in the maps folder.
const otherMaps = join(root, 'Other maps');
await writePack(join(otherMaps, PACK_ID));
// A drive that is not connected, and a folder that is not a pack.
const unplugged = join(root, 'Unplugged drive', 'Maps');
const notAPack = join(root, 'Not a pack');
await mkdir(notAPack, { recursive: true });
await writeFile(join(notAPack, 'notes.txt'), 'Just notes.\n');

await mkdir(shared, { recursive: true });
await writeFile(
  join(shared, 'settings.json'),
  JSON.stringify(
    {
      format: 'atlas-settings',
      version: 1,
      mapsFolder: null,
      locations: [
        { path: copied, kind: 'pack' },
        { path: otherMaps, kind: 'folder' },
        { path: unplugged, kind: 'folder' },
        { path: notAPack, kind: 'pack' },
      ],
      downloads: { parallel: 2, pauseMs: 100, requestsPerMinute: null, kilobytesPerSecond: null },
    },
    null,
    2,
  ),
);

// ---- Helpers ---------------------------------------------------------------

/** @typedef {import('./webdriver.js').Session} Session */

/** @param {Session} s */
const gameId = (s) =>
  s.run(`
    const select = [...document.querySelectorAll('.topbar select')]
      .find((el) => [...el.options].some((o) => o.value === 'demo'));
    return select?.value ?? null;`);

/** @param {Session} s @param {string} state */
const waitForPanel = (s, state, timeout = 60_000) =>
  s.waitFor(
    `document.querySelector('[data-testid="download-panel"]')?.dataset.state === '${state}'`,
    { timeout, what: `the download panel to be ${state}` },
  );

/** @param {Session} s @param {string} phase */
const waitForPhase = (s, phase, timeout = 30_000) =>
  s.waitFor(
    `document.querySelector('[data-testid="add-map-dialog"]')?.dataset.phase === '${phase}'`,
    { timeout, what: `the import to be ${phase}` },
  );

/** @param {Session} s @param {string} testId */
const text = (s, testId) =>
  s.run(`return document.querySelector('[data-testid="${testId}"]')?.textContent ?? null;`);

/** Opens "Add a map" with an empty address field and starts an import. @param {Session} s @param {string} url */
async function importFrom(s, url) {
  const open = await s.run(
    `return document.querySelector('[data-testid="add-map-dialog"]')?.open ?? false;`,
  );
  if (open) await s.click('[data-testid="add-map-dialog"] .dialog-head .icon-button');
  await s.click('[data-testid="add-map-button"]');
  await s.waitFor(`document.querySelector('[data-testid="add-map-url"]')`);
  await s.type('[data-testid="add-map-url"]', url);
  await s.click('[data-testid="add-map-start"]');
}

/** @param {Session} s */
const closeAddMap = (s) => s.click('[data-testid="add-map-dialog"] .dialog-head .icon-button');

/** The activity log's lines of the area `import`, with their times in ms. */
async function importLog() {
  const text = await readFile(join(shared, 'logs', 'atlas.log'), 'utf8');
  return text.split('\n').flatMap((line) => {
    const match = /^(\S+) \[[^\]]+\] import (\w+): (.*)$/.exec(line);
    return match
      ? [{ at: Date.parse(match[1] ?? ''), level: match[2], message: match[3] ?? '' }]
      : [];
  });
}

const tiles = await startTileServer({ port });
// On the port the bundled test pack and the demo importer's list of worlds name.
const site = await startDemoSite({ port: SITE_PORT });
const page = (/** @type {string} */ world, /** @type {string} */ map) =>
  `${site.url}demo-maps/${world}/${map}`;
const driver = await startDriver({ env: environment.env });
/** @type {Session | null} */
let session = null;
let passed = false;

try {
  // ---- Launch 1 ------------------------------------------------------------
  session = await driver.session();
  let s = session;
  await s.waitFor(`document.querySelector('[data-testid="marker-count"]')?.textContent === '5'`, {
    what: 'the test pack to load',
  });
  check((await gameId(s)) === PACK_ID, 'the test pack is shown first');

  // The old download moved into the pack folder in the maps folder.
  const pack = join(maps, PACK_ID);
  for (let start = Date.now(); Date.now() - start < 20_000 && (await exists(oldOverlay));) {
    await sleep(250);
  }
  check(!(await exists(oldOverlay)), 'the version 0.2.0 overlay folder is gone');
  check(
    !(await exists(join(legacy, 'downloads', `${PACK_ID}.json`))),
    'the old job record is gone',
  );
  check(
    await exists(join(pack, 'manifest.json')),
    'the test pack was installed into the maps folder',
  );
  check(
    await exists(join(pack, 'tiles', 'island', '2', '0', '0.png')),
    'the downloaded images are in the pack folder',
  );
  check(
    (await readJson(join(pack, '.atlas', 'download-job.json'))).detail === 'standard',
    'the unfinished job moved with them',
  );

  // The game that comes with the app and was made from web pages is in the
  // maps folder (its map images can be downloaded), with its page data.
  const isles = join(maps, ISLES_ID);
  check(
    (await readJson(join(isles, 'manifest.json'))).packVersion === '1.0.0' &&
      (await readJson(join(isles, 'import', 'index.json'))).sources.length === 2,
    'the bundled game made from web pages is installed with the pages it was made from',
  );

  // Download settings are saved for every app, then the job finishes.
  await s.click('[data-testid="download-map-images"], [data-testid="map-images-button"]');
  await s.waitFor(`document.querySelector('[data-testid="download-unfinished"]')`, {
    what: 'the unfinished download to be offered',
  });
  await s.waitFor(`document.querySelector('[data-testid="download-settings"]')`);
  await s.click('[data-testid="download-settings"] summary');
  await s.click('[data-testid="setting-parallel"] option[value="1"]');
  await s.click('[data-testid="setting-rpm-on"]');
  await s.click('[data-testid="save-download-settings"]');
  await s.waitFor(
    `document.querySelector('[data-testid="save-download-settings"]')?.disabled === true`,
  );
  await s.screenshot('import-0-download-settings');
  const savedSettings = await readJson(join(shared, 'settings.json'));
  check(
    savedSettings.downloads.parallel === 1 &&
      savedSettings.downloads.pauseMs === 100 &&
      savedSettings.downloads.requestsPerMinute === 120 &&
      savedSettings.locations.length === 4,
    'the download settings are in the shared settings file, next to the locations',
  );
  await s.click('[data-testid="download-unfinished"] .button-primary');
  await waitForPanel(s, 'done', 120_000);
  const fetched = tiles.seen.filter((r) => r.status === 200).map((r) => r.path);
  check(
    fetched.length === standardTotal - prefilled.length,
    `only the ${standardTotal - prefilled.length} missing images were fetched (${fetched.length})`,
  );
  check(
    prefilled.every((path) => !fetched.includes(path)),
    'nothing that was downloaded before was fetched again',
  );
  check(
    (await readJson(join(pack, 'offline-tiles', 'island.json'))).levels.includes(2),
    'the status file is in the pack folder',
  );
  check(!(await exists(join(legacy, 'packs', PACK_ID))), 'nothing was written to the old folder');
  await s.click('[data-testid="download-panel"] .download-head .icon-button');

  // The Maps dialog.
  await s.click('[data-testid="maps-button"]');
  await s.waitFor(`document.querySelectorAll('[data-testid="location-row"]').length === 4`, {
    what: 'the remembered locations',
  });
  check((await text(s, 'maps-folder-path'))?.startsWith(maps), 'the maps folder is shown');
  const states = await s.run(
    `return [...document.querySelectorAll('[data-testid="location-row"]')].map((row) => row.dataset.state);`,
  );
  check(
    JSON.stringify(states) === JSON.stringify(['ok', 'ok', 'missing', 'not-a-pack']),
    `each location has its state (${states})`,
  );
  const hidden = (await text(s, 'hidden-packs')) ?? '';
  check(
    hidden.includes('Remote tiles test') &&
      hidden.includes('same id') &&
      hidden.includes(otherMaps),
    'the second copy of the test pack is not shown, and the dialog says why',
  );
  await s.screenshot('import-1-maps-dialog');
  await s.click(
    '[data-testid="location-row"][data-state="missing"] [data-testid="remove-location"]',
  );
  await s.waitFor(`document.querySelectorAll('[data-testid="location-row"]').length === 3`);
  const afterRemove = await readJson(join(shared, 'settings.json'));
  check(
    afterRemove.locations.length === 3 &&
      !afterRemove.locations.some((/** @type {any} */ l) => l.path === unplugged),
    'the missing location is forgotten',
  );
  check(await exists(join(notAPack, 'notes.txt')), 'no files were deleted');

  // The copied pack shows the map images it brought along.
  await s.click('[data-pack="e2e-copied"] .row-actions .link-button');
  // Wait for the game itself: a notice from the step before may still be showing.
  await s.waitFor(
    `[...document.querySelectorAll('.topbar select')].some((el) => el.value === 'e2e-copied')`,
    { what: 'the copied pack' },
  );
  await s.waitFor(
    `document.querySelector('[data-testid="marker-count"]')?.textContent === '5' &&
      !document.querySelector('[data-testid="tile-notice"]') &&
      document.querySelectorAll('.atlas-tiles img.leaflet-tile-loaded').length > 0`,
    { what: 'the copied pack with its map images' },
  );
  check((await gameId(s)) === 'e2e-copied', 'the copied pack is shown');
  await s.screenshot('import-2-copied-pack');

  // ---- Add a map -------------------------------------------------------------
  await importFrom(s, 'https://example.com/maps/somewhere');
  await waitForPhase(s, 'failed');
  check(
    ((await text(s, 'add-map-error')) ?? '').includes('None of the importers'),
    'an address no importer knows gets a plain answer',
  );

  await closeAddMap(s);
  await importFrom(s, page('test-valley', 'east-field'));
  await waitForPhase(s, 'waiting');
  await s.screenshot('import-3-waiting');
  await waitForPhase(s, 'done', 60_000);
  await s.screenshot('import-4-result');
  check((await text(s, 'add-map-game')) === 'Test Valley', 'the result names the game');
  check(
    (await text(s, 'add-map-locations')) === String(eastField.places.length),
    'the result counts the map’s locations',
  );
  check((await gameId(s)) === 'test-valley', 'the imported game is shown');

  const probe = /** @type {any} */ (site.probes[0]);
  console.log('What the page could do:', JSON.stringify(probe));
  check(!!probe && probe.invoke !== 'allowed', 'the page cannot call the app');
  check(
    !String(probe['atlas-pack://localhost/demo/manifest.json']).startsWith('status 200') &&
      !String(probe['http://atlas-pack.localhost/demo/manifest.json']).startsWith('status 200'),
    'the page cannot read the app’s packs',
  );
  check(!site.seen.some((r) => r.path === '/popup'), 'the page cannot open windows');
  check(!site.seen.some((r) => r.path === '/elsewhere'), 'the page cannot leave for another site');
  const pageRequest = site.seen.find((r) => r.path.startsWith('/demo-maps/'));
  check(
    !!pageRequest && pageRequest.userAgent === probe.userAgent && !/Atlas/.test(probe.userAgent),
    `the window uses the platform's own user agent (${probe.userAgent})`,
  );

  const valleyDir = join(maps, 'test-valley');
  const manifest = await readJson(join(valleyDir, 'manifest.json'));
  check(
    manifest.schemaVersion === 2 &&
      manifest.source.importer.id === 'demo-maps' &&
      manifest.source.pages.length === 1 &&
      manifest.contents.counts.locations === eastField.places.length &&
      manifest.writtenBy.name === 'Atlas' &&
      manifest.writtenBy.version === version,
    'the manifest describes the pack and where it came from',
  );
  const index = await readJson(join(valleyDir, 'import', 'index.json'));
  check(index.sources.length === 1, 'the page data is kept with the pack');
  const kept = await readFile(join(valleyDir, 'import', index.sources[0].file), 'utf8');
  check(
    kept.includes('Old beacon') &&
      !kept.includes('made-up-session-token') &&
      !kept.includes('example.com'),
    'only the map data was read from the page',
  );
  const served = await s.runAsync(`
    try {
      const response = await fetch('atlas-pack://localhost/test-valley/import/index.json');
      return response.status;
    } catch { return 'failed'; }`);
  check(served !== 200, `the kept page data is not served to the map (${served})`);

  // A second map of the same game joins its pack.
  await importFrom(s, page('test-valley', 'west-ridge'));
  await waitForPhase(s, 'done', 60_000);
  const mapNames = await s.run(`
    const select = [...document.querySelectorAll('.topbar select')]
      .find((el) => [...el.options].some((o) => o.textContent.startsWith('West Ridge')));
    return select ? [...select.options].map((o) => o.textContent) : null;`);
  check(
    Array.isArray(mapNames) && mapNames.length === 2,
    `one game with two maps in the map switcher (${mapNames})`,
  );
  check(
    (await readdir(maps)).filter((name) => name.startsWith('test-valley')).length === 1,
    'both maps are in one pack folder',
  );
  await s.screenshot('import-5-second-map');

  // The first page again, after the site changed: refreshed in place.
  site.update();
  await importFrom(s, page('test-valley', 'east-field'));
  await waitForPhase(s, 'done', 60_000);
  const refreshed =
    (await s.run(
      `return document.querySelector('[data-testid="add-map-result"] [role="status"]')?.textContent;`,
    )) ?? '';
  check(refreshed.startsWith('Updated East Field'), 'importing a page again updates its map');
  await s.screenshot('import-6-refreshed');
  const locations = /** @type {any[]} */ (await readJson(join(valleyDir, 'locations.json')));
  check(
    locations.length === eastField.places.length + 1 + westRidge.places.length,
    'the pack has both maps and the new place',
  );
  const added = locations.find((l) => l.name === UPDATED_PLACE.name);
  const old = locations.find((l) => l.name === 'Old beacon');
  check(
    added?.since === '1.2.0' && old?.since === '1.0.0',
    'each place keeps the version it came in',
  );
  const index2 = await readJson(join(valleyDir, 'import', 'index.json'));
  check(index2.sources.length === 2, 'the same page is kept once');
  const manifest2 = await readJson(join(valleyDir, 'manifest.json'));
  check(
    manifest2.created === manifest.created && manifest2.updated > manifest.updated,
    'the manifest keeps when the pack was created',
  );

  // A game that comes with the app is not replaced.
  await importFrom(s, page('demo', 'plain'));
  await waitForPhase(s, 'failed', 60_000);
  check(
    ((await text(s, 'add-map-error')) ?? '').includes('comes with this app'),
    'a game that comes with the app is not replaced',
  );
  check(!(await exists(join(maps, 'demo'))), 'nothing was written for it');

  // Data in the wrong shape.
  await importFrom(s, page('test-valley', 'broken'));
  await waitForPhase(s, 'failed', 60_000);
  check(
    ((await text(s, 'add-map-error')) ?? '').includes('expected shape'),
    'data in the wrong shape gets a plain answer',
  );

  // Waiting, then cancelling; then waiting too long.
  await importFrom(s, page('test-valley', 'never'));
  await waitForPhase(s, 'waiting');
  await s.waitFor(`document.querySelector('[data-testid="add-map-still-waiting"]')`, {
    timeout: 40_000,
    what: 'the still-waiting hint',
  });
  await s.screenshot('import-7-still-waiting');
  await s.click('[data-testid="add-map-cancel"]');
  await waitForPhase(s, 'idle');
  await closeAddMap(s);
  await importFrom(s, page('test-valley', 'never'));
  await waitForPhase(s, 'failed', 60_000);
  check(
    ((await text(s, 'add-map-error')) ?? '').includes('within 30 seconds'),
    'a page whose data never appears ends with a plain explanation',
  );
  await s.screenshot('import-8-timed-out');
  await closeAddMap(s);

  // Map images of the imported game download into its pack folder.
  await s.click('[data-testid="download-map-images"], [data-testid="map-images-button"]');
  await waitForPanel(s, 'choose');
  await s.click('[data-detail="full"]');
  await s.click('[data-testid="start-download"]');
  await waitForPanel(s, 'done', 120_000);
  check(
    await exists(join(valleyDir, 'tiles', 'east-field', String(eastField.maxZoom), '0', '0.png')),
    'the images are in the pack folder',
  );
  const tileRequests = site.seen.filter((r) => r.path.startsWith('/tiles/'));
  check(
    tileRequests.length ===
      tileCount(eastField, eastField.maxZoom) + tileCount(westRidge, westRidge.maxZoom) &&
      tileRequests.every((r) => r.userAgent.startsWith(`Atlas/${version}`) && !r.cookie),
    'the images were fetched once each, by the app, without cookies',
  );
  const manifest3 = await readJson(join(valleyDir, 'manifest.json'));
  const images = manifest3.contents.maps[0].layers[0].images;
  check(
    images?.complete === true && images.files > 0 && images.levels.includes(eastField.maxZoom),
    'the manifest records the downloaded images',
  );
  await s.click('[data-testid="download-panel"] .download-head .icon-button');
  await s.screenshot('import-9-imported-game');
  await s.close();
  session = null;

  // ---- Launch 2 --------------------------------------------------------------
  session = await driver.session();
  s = session;
  await s.waitFor(
    `[...document.querySelectorAll('.topbar select')].some((el) => el.value === 'test-valley')`,
    { what: 'the imported game after a restart' },
  );
  await s.click('[data-testid="maps-button"]');
  await s.waitFor(`document.querySelectorAll('[data-testid="location-row"]').length === 3`, {
    what: 'the remembered locations after a restart',
  });
  await s.click('[data-pack="test-valley"] [data-testid="delete-pack"]');
  await s.click('[data-testid="confirm-delete-pack"]');
  await s.waitFor(`!document.querySelector('[data-pack="test-valley"]')`, {
    what: 'the imported pack to be deleted',
  });
  check(!(await exists(valleyDir)), 'the pack folder is deleted');
  check(await exists(copied), 'packs in other folders are left alone');
  await s.waitFor(`document.querySelector('.topbar select')?.value !== 'test-valley'`);
  await s.screenshot('import-10-deleted');
  await s.click('[data-testid="maps-dialog"] .dialog-head .icon-button');

  // ---- Several addresses at once ---------------------------------------------
  const runPages = [
    page('test-coast', 'north-bay'),
    page('demo', 'plain'),
    page('test-coast', 'never'),
    page('test-coast', 'south-cape'),
    page('test-hills', 'high-pass'),
  ];
  const seenBefore = site.seen.length;
  const logBefore = (await importLog()).length;
  // Typed with commas and spaces: Enter would start the import.
  await importFrom(
    s,
    [
      runPages[0],
      `${runPages[1]} https://example.com/maps/somewhere`,
      runPages[2],
      runPages[0],
      runPages[3],
      runPages[4],
    ].join(', '),
  );
  await s.waitFor(`document.querySelector('[data-testid="add-map-check"]')`, {
    what: 'the addresses that cannot be added',
  });
  const checkStates = await s.run(
    `return [...document.querySelectorAll('[data-testid="add-map-check-address"]')].map((row) => row.dataset.state);`,
  );
  check(
    JSON.stringify(checkStates) ===
      JSON.stringify(['ready', 'ready', 'left-out', 'ready', 'ready', 'ready']),
    `the address no importer knows is shown before anything opens, the repeat is gone (${checkStates})`,
  );
  check(site.seen.length === seenBefore, 'no page was opened before the run started');
  await s.screenshot('import-11-check');
  await s.click('[data-testid="add-map-confirm"]');
  await s.waitFor(`document.querySelector('[data-testid="add-map-run-page"][data-state="open"]')`, {
    what: 'the first page of the run to open',
  });
  await s.screenshot('import-12-run');
  await s.waitFor(
    `document.querySelector('[data-testid="add-map-dialog"]')?.dataset.run === 'finished'`,
    { timeout: 180_000, what: 'the run to end' },
  );
  await s.screenshot('import-13-run-done');
  const runStates = await s.run(
    `return [...document.querySelectorAll('[data-testid="add-map-run-page"]')].map((row) => row.dataset.state + ': ' + row.textContent);`,
  );
  console.log(runStates.join('\n'));
  check(
    JSON.stringify(runStates.map((/** @type {string} */ r) => r.split(':')[0])) ===
      JSON.stringify(['added', 'failed', 'failed', 'added', 'added']) &&
      runStates[1].includes('comes with this app') &&
      runStates[2].includes('within 30 seconds') &&
      runStates[3].includes('Added “South Cape” to Test Coast') &&
      runStates[4].includes('Added “High Pass” to Test Hills'),
    'each page has its state, and the run went on past the pages that were not added',
  );
  check(
    (await text(s, 'add-map-summary')) === '3 maps added, 2 not added.',
    'the run ends with a summary',
  );
  check(
    (await s.run(
      `return document.querySelectorAll('[data-testid="add-map-download"]').length;`,
    )) === 1,
    'the map images are offered once, for the game shown',
  );
  check((await gameId(s)) === 'test-hills', 'the game of the last map added is shown');
  const coastMaps = /** @type {any[]} */ (await readJson(join(maps, 'test-coast', 'maps.json')));
  check(
    coastMaps.map((m) => m.name).join(', ') === 'North Bay, South Cape' &&
      (await exists(join(maps, 'test-hills', 'manifest.json'))) &&
      !(await exists(join(maps, 'demo'))),
    'two maps of one game went into one pack, the other game into its own',
  );
  const runRequests = site.seen
    .slice(seenBefore)
    .filter((r) => r.path.startsWith('/demo-maps/'))
    .map((r) => `${site.url}${r.path.slice(1)}`);
  check(
    JSON.stringify(runRequests) === JSON.stringify(runPages),
    `each page was asked for once, in the order given (${runRequests.join(' ')})`,
  );
  // The log: the run's start, each page opened only after the one before
  // ended and the pause, and the summary.
  const log = (await importLog()).slice(logBefore);
  const start = log.findIndex((l) => l.message.startsWith('Adding 5 pages, one page at a time'));
  check(
    start >= 0 &&
      log[start]?.message ===
        `Adding 5 pages, one page at a time, from ${site.url.slice(0, -1)} | left out, as no importer recognises them: 1`,
    'the activity log has the start of the run, with the site only',
  );
  let ended = /** @type {number | null} */ (null);
  let opened = 0;
  let pausesOk = true;
  let oneAtATime = true;
  for (const line of log) {
    if (line.message.startsWith('Opened ')) {
      if (ended === null && opened > 0) oneAtATime = false;
      if (ended !== null && line.at - ended < 3000) pausesOk = false;
      opened++;
      ended = null;
    } else if (/^Read the page data|timed out/.test(line.message)) {
      ended = line.at;
    }
  }
  check(opened === 5 && oneAtATime, 'one page at a time, five in all');
  check(pausesOk, 'at least three seconds between one page ending and the next opening');
  check(
    log.some(
      (l) =>
        l.message ===
        'Adding maps ended: 3 added, 0 refreshed, 2 not added, 0 not started | left out, as no importer recognises them: 1',
    ),
    'the activity log has the summary',
  );
  await closeAddMap(s);

  // ---- A game's address -------------------------------------------------------
  /** Each page of the choice: title | kind | state | ticked | enabled. @param {Session} s */
  const choiceRows = (s) =>
    s.run(`return [...document.querySelectorAll('[data-testid="add-map-choose-page"]')].map((row) => {
      const box = row.querySelector('input');
      return [row.querySelector('label').textContent, row.dataset.kind, row.dataset.state,
        box.checked ? 'ticked' : 'unticked', box.disabled ? 'disabled' : 'enabled'].join(' | ');
    });`);
  /** The paths the site was asked for since `from`, map, game and checklist pages only. */
  const pagesAsked = (/** @type {number} */ from) =>
    site.seen
      .slice(from)
      .filter((r) => r.path.startsWith('/demo-maps'))
      .map((r) => r.path);
  /** One page at a time, with the pause between them, from the activity log. */
  const paced = (/** @type {{ at: number, message: string }[]} */ lines) => {
    let ended = /** @type {number | null} */ (null);
    let opened = 0;
    let ok = true;
    for (const line of lines) {
      if (line.message.startsWith('Opened ')) {
        if (ended === null && opened > 0) ok = false;
        if (ended !== null && line.at - ended < 3000) ok = false;
        opened++;
        ended = null;
      } else if (/^Read the page(?:'s list| data)|timed out/.test(line.message)) {
        ended = line.at;
      }
    }
    return { opened, ok };
  };
  const waitForRun = (/** @type {Session} */ s, timeout = 180_000) =>
    s.waitFor(
      `document.querySelector('[data-testid="add-map-dialog"]')?.dataset.run === 'finished'`,
      { timeout, what: 'the run to end' },
    );
  const runRows = (/** @type {Session} */ s) =>
    s.run(
      `return [...document.querySelectorAll('[data-testid="add-map-run-page"]')].map((row) => row.dataset.state + ': ' + row.textContent);`,
    );

  const gameUrl = `${site.url}demo-maps/test-valley`;
  const seenBeforeGame = site.seen.length;
  const logBeforeGame = (await importLog()).length;
  // A game address with other addresses is refused before anything opens.
  await importFrom(s, `${gameUrl}, ${page('test-coast', 'north-bay')}`);
  await waitForPhase(s, 'failed');
  check(
    ((await text(s, 'add-map-error')) ?? '').includes('has to be added on its own'),
    'a game address must be added on its own',
  );
  await closeAddMap(s);
  await importFrom(s, gameUrl);
  await waitForPhase(s, 'listing');
  await waitForPhase(s, 'choose', 60_000);
  const gameChoice = await choiceRows(s);
  check(
    JSON.stringify(gameChoice) ===
      JSON.stringify([
        'East Field | map | new | ticked | enabled',
        'West Ridge | map | new | ticked | enabled',
        'Getting started | guides | off | unticked | disabled',
        'Every beacon | checklists | new | ticked | enabled',
      ]),
    `the game page's pages are listed, maps first, the guide not supported yet (${gameChoice.join('; ')})`,
  );
  await s.screenshot('import-14-game-pages');
  await s.click(
    `[data-testid="add-map-choose-page"][data-url="${page('test-valley', 'west-ridge')}"] input`,
  );
  check(
    (await text(s, 'add-map-choose-confirm')) === 'Add 2 pages',
    'unticking a map leaves two pages to add',
  );
  await s.click('[data-testid="add-map-choose-confirm"]');
  await waitForRun(s);
  const gameRun = await runRows(s);
  console.log(gameRun.join('\n'));
  check(
    gameRun.length === 2 &&
      gameRun[0]?.startsWith('added: ') === true &&
      gameRun[0].includes('Added “East Field” to Test Valley') &&
      gameRun[1]?.includes('a checklist of 1 item (2 left out until their maps are added)') ===
        true,
    'the map and the checklist were added; rows on maps not added yet are left out',
  );
  check(
    JSON.stringify(pagesAsked(seenBeforeGame)) ===
      JSON.stringify([
        '/demo-maps/test-valley',
        '/demo-maps/test-valley/east-field',
        '/demo-maps/test-valley/checklists/beacons',
      ]),
    `the game page, then the ticked pages, each once (${pagesAsked(seenBeforeGame).join(' ')})`,
  );
  const valleyLists = /** @type {any[]} */ (await readJson(join(valleyDir, 'checklists.json')));
  const valleyItems = /** @type {any[]} */ (await readJson(join(valleyDir, 'checklistItems.json')));
  check(
    valleyLists.length === 1 &&
      valleyLists[0].name === 'Every beacon' &&
      valleyItems.length === 1 &&
      valleyItems[0].locationIds[0] === 'test-valley:loc:east-field-1',
    'the checklist is in the pack, with the rows whose places are in it',
  );
  const gameLog = (await importLog()).slice(logBeforeGame);
  check(
    gameLog.some(
      (l) =>
        l.message ===
        `Read the list of a game's pages from ${site.url.slice(0, -1)}: 2 map pages (0 already added, 2 new), 1 of kind checklists, 1 of kind guides`,
    ),
    'the activity log names the kinds of pages found, and the site only',
  );
  const gamePacing = paced(gameLog);
  check(
    gamePacing.opened === 3 && gamePacing.ok,
    'the game page and the pages after it opened one at a time, with the pause between them',
  );
  await closeAddMap(s);

  // ---- Update from the site: a new map ----------------------------------------
  site.addMap();
  const seenBeforeUpdate = site.seen.length;
  await s.click('[data-testid="maps-button"]');
  await s.waitFor(
    `document.querySelector('[data-pack="test-valley"] [data-testid="update-pack"]')`,
    {
      what: '"Update from the site…" for the game added from web pages',
    },
  );
  await s.click('[data-pack="test-valley"] [data-testid="update-pack"]');
  await waitForPhase(s, 'choose', 60_000);
  const updateChoice = await choiceRows(s);
  check(
    JSON.stringify(updateChoice) ===
      JSON.stringify([
        'East Field | map | added | ticked | enabled',
        'West Ridge | map | new | ticked | enabled',
        'North Lake | map | new | ticked | enabled',
        'Getting started | guides | off | unticked | disabled',
        'Every beacon | checklists | added | ticked | enabled',
      ]),
    `the update lists the new map as new and the added pages as added (${updateChoice.join('; ')})`,
  );
  await s.screenshot('import-15-update');
  await s.click('[data-testid="add-map-choose-confirm"]');
  await waitForRun(s);
  const updateRun = await runRows(s);
  console.log(updateRun.join('\n'));
  check(
    (await text(s, 'add-map-summary')) === '2 pages added, 2 refreshed.' &&
      updateRun[3]?.includes('a checklist of 3 items') === true,
    'the update added the new maps and refreshed the rest; the checklist has every row now',
  );
  check(
    JSON.stringify(pagesAsked(seenBeforeUpdate)) ===
      JSON.stringify([
        '/demo-maps/test-valley',
        '/demo-maps/test-valley/east-field',
        '/demo-maps/test-valley/west-ridge',
        '/demo-maps/test-valley/north-lake',
        '/demo-maps/test-valley/checklists/beacons',
      ]),
    'the update read the game page, then each ticked page once',
  );
  const valleyMaps = /** @type {any[]} */ (await readJson(join(valleyDir, 'maps.json')));
  check(
    valleyMaps.map((m) => m.name).join(', ') === 'East Field, West Ridge, North Lake',
    'the game has the new map',
  );
  await closeAddMap(s);

  // ---- Refreshing the game that comes with the app ----------------------------
  const seenBeforeIsles = site.seen.length;
  const logBeforeIsles = (await importLog()).length;
  await s.click('[data-testid="maps-button"]');
  await s.waitFor(
    `document.querySelector('[data-pack="${ISLES_ID}"] [data-testid="update-pack"]')`,
    {
      what: '"Update from the site…" for the game that comes with the app',
    },
  );
  await s.click(`[data-pack="${ISLES_ID}"] [data-testid="update-pack"]`);
  await waitForPhase(s, 'choose', 60_000);
  const islesChoice = await choiceRows(s);
  check(
    JSON.stringify(islesChoice) ===
      JSON.stringify([
        'North Isle | map | added | ticked | enabled',
        'South Isle | map | added | ticked | enabled',
      ]),
    `the bundled game's maps are listed as added (${islesChoice.join('; ')})`,
  );
  await s.click(
    `[data-testid="add-map-choose-page"][data-url="${page(ISLES_ID, 'south-isle')}"] input`,
  );
  await s.click('[data-testid="add-map-choose-confirm"]');
  await waitForRun(s);
  check(
    (await text(s, 'add-map-summary')) === '1 map refreshed.',
    'one map of the bundled game was refreshed',
  );
  await s.screenshot('import-16-bundled-refreshed');
  const islesManifest = await readJson(join(isles, 'manifest.json'));
  const islesMaps = /** @type {any[]} */ (await readJson(join(isles, 'maps.json')));
  const islesPlaces = /** @type {any[]} */ (await readJson(join(isles, 'locations.json')));
  check(
    islesManifest.packVersion === '1.1.0' &&
      islesMaps.map((m) => m.id).join(' ') ===
        `${ISLES_ID}:map:north-isle ${ISLES_ID}:map:south-isle` &&
      islesPlaces.find((l) => l.name === UPDATED_ISLE_PLACE.name)?.since === '1.1.0' &&
      islesPlaces.find((l) => l.name === 'Reef cave')?.since === '1.0.0',
    'the refreshed copy has a newer version, the same ids, its other map and the new place',
  );
  check(
    JSON.stringify(pagesAsked(seenBeforeIsles)) ===
      JSON.stringify([`/demo-maps/${ISLES_ID}`, `/demo-maps/${ISLES_ID}/north-isle`]),
    'its game page and the ticked map were read',
  );
  check(
    (await importLog())
      .slice(logBeforeIsles)
      .some((l) =>
        l.message.startsWith(
          `Updating 1 game from its site: reading 1 game page, one at a time, from ${site.url.slice(0, -1)}`,
        ),
      ),
    'the activity log has the update',
  );
  await closeAddMap(s);

  // ---- The site's list of worlds ----------------------------------------------
  await s.click('[data-testid="add-map-button"]');
  await s.click('[data-testid="add-map-browse-games"]');
  await waitForPhase(s, 'catalogue', 60_000);
  const worlds = await s.run(
    `return [...document.querySelectorAll('[data-testid="add-map-catalogue-game"]')].map((row) => row.textContent);`,
  );
  console.log(worlds.join('\n'));
  check(
    worlds.length === Object.keys(WORLDS).length &&
      worlds.some(
        (/** @type {string} */ w) =>
          w.startsWith('Test Valley') && w.includes('In your maps folder'),
      ),
    'the list of worlds is read, and the worlds in the maps folder are marked',
  );
  await s.screenshot('import-17-worlds');
  await closeAddMap(s);
  await s.close();
  session = null;

  // ---- Launch 3 --------------------------------------------------------------
  session = await driver.session();
  s = session;
  await s.waitFor(`document.querySelector('[data-testid="marker-count"]')`, {
    what: 'the app after a restart',
  });
  await sleep(2000);
  check(
    (await readJson(join(isles, 'manifest.json'))).packVersion === '1.1.0' &&
      (await readJson(join(isles, 'import', 'index.json'))).sources.length === 2,
    'the refreshed game that comes with the app is kept at start-up',
  );
  passed = true;
} finally {
  await session?.close();
  driver.stop();
  await tiles.close();
  await site.close();
  // The temporary folder is kept when the test fails, to look at.
  if (passed) await rm(environment.root, { recursive: true, force: true });
  else console.log(`Test data kept in ${environment.root}`);
}
