// @ts-check
/**
 * Desktop maps library and "Add a map" test, on a build with the made-up
 * demo importer and with downloads:
 *
 *   node apps/desktop/e2e/remotePack.js          # writes packs/e2e-remote/
 *   ATLAS_ENABLE_DOWNLOADS=1 ATLAS_BUNDLE_PACKS=e2e-remote,demo \
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
 * Launch 2: everything is still there; the imported pack is deleted.
 */
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startDemoSite, tileCount, UPDATED_PLACE, WORLDS } from './demoSite.js';
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

const tiles = await startTileServer({ port });
const site = await startDemoSite();
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
