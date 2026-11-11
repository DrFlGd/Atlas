// @ts-check
/**
 * Desktop delete test: deleting a map while its images download, and
 * deleting only the downloaded images of a map, through the Maps dialog of
 * the built app.
 *
 *   node apps/desktop/e2e/remotePack.js          # writes packs/e2e-remote/
 *   ATLAS_ENABLE_DOWNLOADS=1 ATLAS_BUNDLE_PACKS=e2e-remote,demo pnpm desktop:build --no-bundle
 *   xvfb-run -a pnpm --filter @atlas/desktop test:e2e:delete [path/to/binary]
 *
 * Linux only, like the other desktop tests: the app's data and the shared
 * maps folder live in a temporary folder (XDG_DATA_HOME). The map images
 * come from the mock tile server on 127.0.0.1; no request leaves this
 * computer. Every name is made up.
 *
 * Before the first launch it puts a made-up game, "My Game", into the maps
 * folder (the test pack under another id), a hidden `.deleting-*` folder as
 * an earlier run on Windows leaves behind when a file was in use, and a
 * file of the person's own next to the packs.
 *
 * Launch 1: the left-over folder is removed at start. The test pack (which
 * comes with the app and is installed into the maps folder) downloads its
 * images, then "Delete downloaded images…" says how many there are, removes
 * them and only them, and the map asks for them again. "My Game" starts a
 * slow download; "Delete…" says that the download is stopped first and how
 * many images go, and deletes the pack mid-download: the folder is gone, no
 * request follows, and the app goes on working.
 * Launch 2: "My Game" stays gone and the test pack has no images.
 */
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_PORT, MAPS, PACK_ID, packFiles, remoteTileCount } from './remotePack.js';
import { startTileServer } from './tileServer.js';
import { check, isolatedEnvironment, resultsDir, sleep, startDriver } from './webdriver.js';

const port = Number(process.env.ATLAS_E2E_TILE_PORT ?? DEFAULT_PORT);
const MY_GAME = 'my-game';

const [island, cave] = MAPS;
if (!island || !cave) throw new Error('remotePack.js defines two maps');
const standardTotal = remoteTileCount(island, island.maxZoom - 1) + remoteTileCount(cave);

const exists = (/** @type {string} */ path) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Every file below `dir`, relative to it. @param {string} dir @returns {Promise<string[]>} */
async function filesBelow(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1));
}

const environment = await isolatedEnvironment();
const data = environment.env.XDG_DATA_HOME ?? '';
const maps = join(data, 'atlas', 'maps');
const myGame = join(maps, MY_GAME);
const testPack = join(maps, PACK_ID);

// "My Game": the test pack's files under a made-up id and title.
await mkdir(myGame, { recursive: true });
for (const [name, content] of Object.entries(packFiles(port))) {
  const text = JSON.stringify(content, null, 2)
    .replaceAll(`${PACK_ID}:`, `${MY_GAME}:`)
    .replaceAll(`"${PACK_ID}"`, `"${MY_GAME}"`)
    .replace('"Remote tiles test"', '"My Game"');
  await writeFile(join(myGame, name), `${text}\n`);
}
// What a delete leaves when a file stays in use on Windows.
const leftover = join(maps, '.deleting-old-game');
await mkdir(join(leftover, 'tiles', 'island', '2', '0'), { recursive: true });
await writeFile(join(leftover, 'tiles', 'island', '2', '0', '0.png'), 'old image');
await writeFile(join(leftover, 'manifest.json'), '{}');
// A file of the person's own in the maps folder.
const ownFile = join(maps, 'my notes.txt');
await writeFile(ownFile, 'keep me');

const tiles = await startTileServer({ port });
const driver = await startDriver({ env: environment.env });
/** @type {import('./webdriver.js').Session | null} */
let session = null;
let passed = false;
/** Where screenshots of the confirmations are copied, if set. */
const shotsDir = process.env.ATLAS_E2E_SHOTS;

/** @param {import('./webdriver.js').Session} s @param {string} name */
async function shot(s, name) {
  const path = await s.screenshot(name);
  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    await writeFile(join(shotsDir, `${name}.png`), await readFile(path));
  }
}

/** @param {import('./webdriver.js').Session} s @param {string} state */
const waitForPanel = (s, state, timeout = 60_000) =>
  s.waitFor(
    `document.querySelector('[data-testid="download-panel"]')?.dataset.state === '${state}'`,
    { timeout, what: `the download panel to be ${state}` },
  );

/** @param {import('./webdriver.js').Session} s */
const notice = (s) => s.run(`return document.querySelector('.toast-region')?.textContent ?? '';`);

/** @param {import('./webdriver.js').Session} s */
const gameId = (s) =>
  s.run(`
    const select = [...document.querySelectorAll('.topbar select')]
      .find((el) => [...el.options].some((o) => o.value === 'demo'));
    return select?.value ?? null;`);

/** @param {import('./webdriver.js').Session} s */
async function openMapsDialog(s) {
  await s.click('[data-testid="maps-button"]');
  await s.waitFor(`document.querySelector('[data-pack="${PACK_ID}"]')`, {
    what: 'the pack list',
  });
}

/** @param {import('./webdriver.js').Session} s @param {string} selector */
const scrollTo = (s, selector) =>
  s.run(`document.querySelector('${selector}')?.scrollIntoView({ block: 'end' });`);

try {
  // ---- Launch 1 -------------------------------------------------------------
  session = await driver.session();
  let s = session;
  await s.waitFor(`document.querySelector('[data-testid="marker-count"]')?.textContent === '5'`, {
    what: 'the test pack to load',
  });
  for (let start = Date.now(); Date.now() - start < 15_000 && (await exists(leftover));) {
    await sleep(250);
  }
  check(!(await exists(leftover)), 'a folder left by an earlier delete is removed at start');

  // The test pack's images: download Standard detail.
  tiles.setMode('ok');
  await s.waitFor(`document.querySelector('[data-testid="download-map-images"]')`, {
    what: 'the download button',
  });
  await s.click('[data-testid="download-map-images"]');
  await waitForPanel(s, 'choose');
  await s.click('[data-testid="start-download"]');
  await waitForPanel(s, 'done', 120_000);
  await s.click('[data-testid="download-panel"] .download-head .icon-button');
  const images = (await filesBelow(join(testPack, 'tiles'))).filter((f) => f.endsWith('.png'));
  check(images.length > standardTotal, `the test pack has ${images.length} images on disk`);
  check(await exists(join(testPack, 'offline-tiles', 'island.json')), 'and status files');

  // "Delete downloaded images…" on the test pack, which comes with the app.
  await openMapsDialog(s);
  check(
    (await s.run(
      `return document.querySelector('[data-pack="${PACK_ID}"] [data-testid="delete-pack"]');`,
    )) === null,
    'a pack that comes with the app cannot be deleted, only its images',
  );
  await s.click(`[data-pack="${PACK_ID}"] [data-testid="delete-images"]`);
  const imagesText = await s.waitFor(
    `(() => { const t = document.querySelector('[data-testid="delete-images-confirm"]')?.textContent ?? '';
      return /map images \\(about/.test(t) ? t : null; })()`,
    { what: 'the images confirmation with the count' },
  );
  console.log('Images confirmation:', imagesText);
  check(
    imagesText.includes(`This removes ${images.length} map images`),
    'the confirmation says how many images go',
  );
  check(imagesText.includes('your found marks'), 'and that the places and progress stay');
  await scrollTo(s, '[data-testid="delete-images-confirm"]');
  await shot(s, 'delete-images-confirm');
  await s.click('[data-testid="confirm-delete-images"]');
  await s.waitFor(`!document.querySelector('[data-testid="delete-images-confirm"]')`, {
    what: 'the images to be deleted',
  });
  const imagesResult = await notice(s);
  console.log('Result:', imagesResult);
  check(
    imagesResult.includes(`Deleted ${images.length} map images`),
    'the result says what was deleted',
  );
  check(!(await exists(join(testPack, 'tiles'))), 'every downloaded image is gone');
  check(!(await exists(join(testPack, 'offline-tiles'))), 'with the status files');
  for (const kept of ['manifest.json', 'maps.json', 'layers.json', 'locations.json']) {
    check(await exists(join(testPack, kept)), `${kept} is kept`);
  }
  await s.click('[data-testid="maps-dialog"] .dialog-head .icon-button');
  await s.waitFor(
    `document.querySelector('[data-testid="tile-notice"]')?.textContent.includes('Map image not installed')`,
    { what: 'the map to ask for its images again' },
  );
  check(
    (await s.run(`return document.querySelector('[data-testid="marker-count"]').textContent;`)) ===
      '5',
    'the markers are still there',
  );

  // "My Game": a slow download, deleted half-way.
  await s.click(`.topbar option[value="${MY_GAME}"]`);
  await s.waitFor(
    `document.querySelector('.topbar select')?.value === '${MY_GAME}' &&
      document.querySelector('[data-testid="marker-count"]')?.textContent === '5' &&
      document.querySelector('[data-testid="download-map-images"]')`,
    { what: 'My Game to load' },
  );
  check((await gameId(s)) === MY_GAME, 'My Game is shown');
  tiles.setMode('slow');
  await s.click('[data-testid="download-map-images"]');
  await waitForPanel(s, 'choose');
  await s.click('[data-detail="full"]');
  await s.click('[data-testid="start-download"]');
  await waitForPanel(s, 'running');
  await s.waitFor(
    `(() => { const t = document.querySelector('[data-testid="download-count"]')?.textContent ?? '';
      return Number(t.split(' ')[0]) >= 4; })()`,
    { what: 'the first images of My Game' },
  );
  check(
    (await filesBelow(myGame)).some((f) => f.endsWith('.png')),
    'My Game has some images',
  );
  await openMapsDialog(s);
  await s.click(`[data-pack="${MY_GAME}"] [data-testid="delete-pack"]`);
  const packText = await s.waitFor(
    `(() => { const t = document.querySelector('[data-testid="delete-pack-confirm"]')?.textContent ?? '';
      return /map images? \\(about/.test(t) ? t : null; })()`,
    { what: 'the delete confirmation with the count' },
  );
  console.log('Delete confirmation:', packText);
  check(packText.includes('Delete My Game?'), 'the confirmation names the game');
  check(packText.includes('downloading right now'), 'and says the download is stopped first');
  await scrollTo(s, '[data-testid="delete-pack-confirm"]');
  await shot(s, 'delete-pack-confirm');
  await s.click('[data-testid="confirm-delete-pack"]');
  await s.waitFor(`!document.querySelector('[data-pack="${MY_GAME}"]')`, {
    what: 'My Game to leave the list',
  });
  const deletedAt = tiles.seen.length;
  const packResult = await notice(s);
  console.log('Result:', packResult);
  check(packResult.startsWith('Deleted My Game.'), 'the result says it was deleted');
  check(!(await exists(myGame)), 'the pack folder is gone');
  const hidden = (await readdir(maps)).filter((name) => name.startsWith('.'));
  check(hidden.length === 0, `nothing is left behind in the maps folder (${hidden.join(', ')})`);
  check(await exists(ownFile), "the person's own file next to it is kept");
  await sleep(3000);
  check(tiles.seen.length === deletedAt, 'no image is requested after the delete');
  check(!(await exists(myGame)), 'and nothing is written there again');

  // The app goes on working.
  check((await gameId(s)) !== MY_GAME, 'another game is shown');
  await s.click('[data-testid="refresh-maps"]');
  await s.waitFor(
    `document.querySelector('.toast-region')?.textContent.includes('Looked at every folder again')`,
    { what: 'the list to be looked at again' },
  );
  check(
    (await s.run(`return document.querySelector('[data-pack="${MY_GAME}"]');`)) === null,
    'My Game stays out of the list',
  );
  await s.click('[data-testid="maps-dialog"] .dialog-head .icon-button');
  await s.click(`.topbar option[value="${PACK_ID}"]`);
  await s.waitFor(`document.querySelector('[data-testid="marker-count"]')?.textContent === '5'`, {
    what: 'the test pack again',
  });
  await s.close();
  session = null;

  // ---- Launch 2 -------------------------------------------------------------
  session = await driver.session();
  s = session;
  await s.waitFor(`document.querySelector('[data-testid="marker-count"]')?.textContent === '5'`, {
    what: 'the test pack after a restart',
  });
  check(
    (await s.run(
      `return [...document.querySelectorAll('.topbar option')].some((o) => o.value === '${MY_GAME}');`,
    )) === false,
    'My Game is still gone after a restart',
  );
  check(
    (
      await s.run(
        `return document.querySelector('[data-testid="tile-notice"]')?.textContent ?? '';`,
      )
    ).includes('Map image not installed'),
    'the test pack still has no images',
  );
  check(!(await exists(join(testPack, 'tiles'))), 'and none came back on disk');
  passed = true;
} finally {
  await session?.close();
  driver.stop();
  await tiles.close();
  if (passed) await rm(environment.root, { recursive: true, force: true });
  else console.log(`Test data kept in ${environment.root}; screenshots in ${resultsDir}`);
}
