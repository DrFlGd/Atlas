// @ts-check
/**
 * Desktop smoke test: starts the built app through tauri-driver (WebDriver)
 * and checks that the window shows the map with its PMTiles tiles and
 * markers, that progress is saved (IndexedDB works), that the pack protocol
 * answers byte-range requests, that the shell commands answer, and saves a
 * screenshot. On Linux it also exports and imports progress through the
 * native save and open dialogs (driven with `xdotool`) and checks that a
 * guide link opens in the system browser, not in the app window, and opens
 * a pack folder through the native folder picker.
 *
 * It also checks that the app has map image downloads exactly when it was
 * built with them (as `pnpm desktop:build` recorded, or as
 * `ATLAS_ENABLE_DOWNLOADS` says when set): in a viewer build (the default)
 * the binary holds no download code, the download and map page commands do
 * not exist, a map without its images only says so, and the Maps dialog
 * offers no download and no saving, also for a pack that was added from a
 * web page.
 *
 *   pnpm --filter @atlas/desktop test:e2e [path/to/binary]
 *
 * Needs `tauri-driver` (`cargo install tauri-driver --locked`) and the
 * platform's WebDriver: WebKitWebDriver on Linux (package
 * `webkitgtk-webdriver`, or `webkit2gtk-driver` on older Ubuntu and
 * Debian releases) plus `xdotool`; on Windows, Microsoft Edge WebDriver
 * matching the installed WebView2, named by `TAURI_NATIVE_DRIVER` when it
 * is not on the PATH. On a
 * machine without a display, run it under `xvfb-run`. Build the app first
 * with `pnpm desktop:build`, or
 * `pnpm --filter @atlas/desktop build --debug --no-bundle` and pass
 * `src-tauri/target/debug/atlas-desktop`.
 */
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkBinary, expectDownloads } from '../scripts/check-binary.js';
import { PACK_ID as IMPORTED_PACK, writePack as writeImportedPack } from './mapPageSite.js';
import { writeRemotePack } from './remotePack.js';
import { appPath, check, here, isolatedEnvironment, sleep, startDriver } from './webdriver.js';

const linux = process.platform === 'linux';
const version = /** @type {{ version: string }} */ (
  JSON.parse(await readFile(here('../package.json'), 'utf8'))
).version;
const timeoutMs = 60_000;
const run = promisify(execFile);
/** The app was built with map image downloads. */
const downloads = await expectDownloads();

/**
 * Waits for a native dialog with this title, then types a path into it and
 * presses Enter, as a user would.
 * @param {string} title @param {string} path
 */
async function answerFileDialog(title, path) {
  let window = '';
  for (let start = Date.now(); !window; await sleep(250)) {
    window = await run('xdotool', ['search', '--name', `^${title}$`]).then(
      ({ stdout }) => stdout.trim().split('\n')[0] ?? '',
      () => '',
    );
    if (!window && Date.now() - start > 15_000) throw new Error(`No "${title}" dialog appeared`);
  }
  await sleep(500);
  await run('xdotool', ['windowfocus', '--sync', window]);
  // Ctrl+L opens the location field in an open dialog; in a save dialog it
  // selects the name field. Either way the typed path replaces its text.
  await run('xdotool', ['key', '--window', window, 'ctrl+l']);
  await run('xdotool', ['key', '--window', window, 'ctrl+a']);
  await run('xdotool', ['type', '--window', window, '--delay', '20', path]);
  await sleep(300);
  await run('xdotool', ['key', '--window', window, 'Return']);
}

/**
 * Chooses a folder in a native folder dialog, as a user would by typing its
 * path: Enter accepts the completed path and opens the folder in the
 * dialog, and the Open button (Alt+O) chooses it.
 * @param {string} title @param {string} path
 */
async function answerFolderDialog(title, path) {
  await answerFileDialog(title, path);
  for (const key of ['Return', 'alt+o']) {
    await sleep(1000);
    const window = await run('xdotool', ['search', '--name', `^${title}$`]).then(
      ({ stdout }) => stdout.trim().split('\n')[0] ?? '',
      () => '',
    );
    if (window) await run('xdotool', ['key', '--window', window, key]);
  }
}

const problem = await checkBinary(appPath, downloads);
check(
  problem === null,
  problem ?? `the binary ${downloads ? 'holds' : 'holds no'} code to download map images`,
);

const environment = linux ? await isolatedEnvironment() : null;
if (environment) {
  // A pack added from a web page, in the maps folder. Its addresses are
  // never visited: nothing here opens its pages.
  await writeImportedPack(
    join(environment.env.XDG_DATA_HOME ?? '', 'atlas', 'maps', IMPORTED_PACK),
    'http://127.0.0.1:9',
    'http://127.0.0.1:9',
  );
}
const driver = await startDriver({ env: environment?.env });
/** @type {import('./webdriver.js').Session | null} */
let session = null;
try {
  session = await driver.session();
  const s = session;

  /**
   * @type {{ error: string | null, map: boolean, tiles: number, loaded: number,
   *   markers: string | null, storage: string | null }}
   */
  let state = { error: null, map: false, tiles: 0, loaded: 0, markers: null, storage: null };
  for (let start = Date.now(); Date.now() - start < timeoutMs; await sleep(500)) {
    state = await s.run(`
      const tiles = [...document.querySelectorAll('.atlas-tiles img')];
      return {
        error: document.querySelector('.status-error')?.textContent ?? null,
        map: !!document.querySelector('.leaflet-container'),
        tiles: tiles.length,
        loaded: tiles.filter((tile) => tile.complete && tile.naturalWidth > 0).length,
        markers: document.querySelector('[data-testid="marker-count"]')?.textContent ?? null,
        storage: document.querySelector('.shell')?.getAttribute('data-storage') ?? null,
      };`);
    if (state.error || (state.tiles > 0 && state.loaded === state.tiles)) break;
  }
  console.log('Window state:', JSON.stringify(state));
  check(state.error === null, 'the app shows no load error');
  check(state.map, 'the map is shown');
  check(state.tiles > 0 && state.loaded === state.tiles, 'every visible tile has loaded');
  check(/^[1-9][\d,]*$/.test(state.markers ?? ''), 'the pack markers are shown');
  check(state.storage === 'saved', 'progress is saved on this device');

  // The request the PMTiles reader makes first: the archive header.
  /** @type {{ url: string, status: number, contentRange: string | null, bytes: number }} */
  const probe = await s.runAsync(`
    const configUrl = new URL('config.json', document.baseURI);
    const config = await (await fetch(configUrl, { cache: 'no-store' })).json();
    const packUrl = new URL(config.packs?.[0]?.url ?? config.packUrl, configUrl);
    const layers = await (await fetch(new URL('layers.json', packUrl))).json();
    const layer = layers.find((candidate) => candidate.tiles.type === 'pmtiles');
    if (!layer) return { url: '', status: 0, contentRange: null, bytes: 0 };
    const url = new URL(layer.tiles.url, packUrl).href;
    const response = await fetch(url, { headers: { range: 'bytes=0-126' } });
    const bytes = (await response.arrayBuffer()).byteLength;
    return { url, status: response.status, contentRange: response.headers.get('content-range'), bytes };`);
  console.log('Range request:', JSON.stringify(probe));
  if (probe.url) {
    check(probe.status === 206 && probe.bytes === 127, 'PMTiles byte ranges are answered with 206');
    check(/^bytes 0-126\/\d+$/.test(probe.contentRange ?? ''), 'Content-Range is reported');
  }

  // The shell's commands answer the page.
  const info = await s.runAsync(`return window.__TAURI_INTERNALS__.invoke('desktop_info');`);
  console.log('Desktop info:', JSON.stringify(info));
  check(info?.version === version, `the shell reports version ${version}`);
  check(
    info?.downloads === downloads,
    `the shell says it ${downloads ? 'downloads' : 'does not download'} map images`,
  );
  if (!downloads) {
    // The commands are not in the build, so the page cannot reach them.
    for (const [command, args] of /** @type {[string, Record<string, unknown>][]} */ ([
      ['tiles_plan', { packId: 'demo' }],
      ['tiles_start', { packId: 'demo', detail: 'overview' }],
      ['download_settings_get', {}],
      ['view_pages', { packId: 'demo' }],
      ['view_open', { packId: 'demo', url: 'http://127.0.0.1:9/', save: true }],
    ])) {
      const result = await s.runAsync(
        `try { await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}); return 'ok'; }
         catch (error) { return 'refused: ' + String(error && error.message || error); }`,
      );
      check(String(result).startsWith('refused'), `${command} is refused (${result})`);
    }
  }
  check(
    !(await s.run(
      `return !!document.querySelector('[data-testid="download-map-images"], [data-testid="map-images-button"]');`,
    )),
    'a pack without remote map images offers no download',
  );
  await s.screenshot('desktop-smoke');

  // A location with a guide, to mark found and to follow its link.
  await s.type('input[role="combobox"]', 'Rusted key 14');
  await s.waitFor(
    `document.querySelector('[data-testid="selected-name"]')?.textContent === 'Rusted key 14'`,
    { what: 'Rusted key 14 to be selected' },
  );
  const found = () =>
    s.run(
      `return document.querySelector('[data-testid="found-toggle"]')?.getAttribute('aria-pressed');`,
    );
  await s.click('[data-testid="found-toggle"]');
  await s.waitFor(
    `document.querySelector('[data-testid="found-toggle"]')?.getAttribute('aria-pressed') === 'true'`,
  );

  if (environment) {
    // Export through the save dialog, undo the change, then import it back.
    const exported = join(environment.root, 'progress.json');
    await s.click('.profile-button');
    await s.waitFor(`document.querySelector('[data-testid="profile-dialog"]')?.open`);
    await s.run(`[...document.querySelectorAll('[data-testid="profile-dialog"] button')]
      .find((button) => button.textContent.includes('Export this profile')).click();`);
    await answerFileDialog('Export progress', exported);
    await s.waitFor(
      `[...document.querySelectorAll('[data-testid="toast"]')].some((t) => t.textContent.includes('Exported 1 profile'))`,
      { what: 'the export to be confirmed' },
    );
    /** @type {{ format: string, profiles: unknown[], progress: { targetId: string, deleted: boolean }[] }} */
    const file = JSON.parse(await readFile(exported, 'utf8'));
    check(
      file.format === 'atlas-progress' &&
        file.profiles.length === 1 &&
        file.progress.some((row) => row.targetId === 'demo:loc:deep-0014' && !row.deleted),
      'the save dialog wrote the profile with the found location',
    );
    await s.click('[data-testid="profile-dialog"] .dialog-head .icon-button');
    await s.click('[data-testid="found-toggle"]');
    await s.waitFor(
      `document.querySelector('[data-testid="found-toggle"]')?.getAttribute('aria-pressed') === 'false'`,
    );

    await s.click('.profile-button');
    await s.waitFor(`document.querySelector('[data-testid="profile-dialog"]')?.open`);
    await s.run(`document.querySelector('[data-testid="import-file-desktop"]').click();`);
    await answerFileDialog('Import progress', exported);
    await s.waitFor(`document.querySelector('[data-testid="import-review"]')`, {
      what: 'the opened file to be reviewed',
    });
    await s.click('[data-testid="import-review"] input[value="replace"]');
    await s.waitFor(`document.querySelector('[data-testid="import-review"] [role="status"]')`);
    await s.click('[data-testid="import-review"] .button-primary');
    await s.waitFor(
      `[...document.querySelectorAll('[data-testid="toast"]')].some((t) => t.textContent.includes('Imported progress.json (replace)'))`,
      { what: 'the import to be confirmed' },
    );
    await s.click('[data-testid="profile-dialog"] .dialog-head .icon-button');
    await s.waitFor(
      `document.querySelector('[data-testid="found-toggle"]')?.getAttribute('aria-pressed') === 'true'`,
      { what: 'the imported progress to be shown' },
    );
    check((await found()) === 'true', 'the open dialog imported the file back');

    // A guide link opens in the system browser, and the window stays on the app.
    const pageUrl = await s.run('return location.href;');
    const href = await s.run(`return document.querySelector('.guide-body a')?.href;`);
    await s.click('.guide-body a');
    let opened = '';
    for (let start = Date.now(); Date.now() - start < 10_000 && !opened; await sleep(250)) {
      opened = await readFile(environment.opened, 'utf8').catch(() => '');
    }
    check(
      !!href && opened.trim() === href,
      `the guide link opened in the system browser (${href})`,
    );
    check((await s.run('return location.href;')) === pageUrl, 'the window stayed on the app');

    // A pack folder from anywhere, through the native folder picker. The
    // plain app has no importers, so it offers no "Add a map".
    check(
      !(await s.run(`return !!document.querySelector('[data-testid="add-map-button"]');`)),
      'the plain app offers no "Add a map"',
    );
    const folder = join(environment.root, 'Elsewhere', 'Remote pack');
    await writeRemotePack(folder);
    await s.click('[data-testid="maps-button"]');
    await s.waitFor(`document.querySelector('[data-testid="open-pack"]')`);
    const picked = answerFolderDialog('Open a map pack', folder);
    await s.click('[data-testid="open-pack"]');
    await picked;
    await s.waitFor(
      `[...document.querySelectorAll('.topbar select')].some((el) => el.value === 'e2e-remote')`,
      { what: 'the opened pack to be shown' },
    );
    check(true, 'a pack folder opened through the folder picker is shown');
    await s.screenshot('desktop-smoke-opened-pack');

    // Its map images are not there: the notice says so, and only a build
    // with downloads offers to download them.
    const dialogOpen = () =>
      s.run(`return !!document.querySelector('[data-testid="maps-dialog"]')?.open;`);
    if (await dialogOpen()) await s.click('[data-testid="maps-dialog"] .dialog-head .icon-button');
    await s.waitFor(`!document.querySelector('[data-testid="maps-dialog"]')?.open`);
    await s.waitFor(`document.querySelector('[data-testid="tile-notice"]')`, {
      what: 'the map image notice',
    });
    const notice = await s.run(
      `return document.querySelector('[data-testid="tile-notice"]')?.textContent ?? '';`,
    );
    const offers = await s.run(
      `return [...document.querySelectorAll('[data-testid="download-map-images"], [data-testid="map-images-button"], [data-testid="download-panel"]')].length;`,
    );
    if (downloads) {
      check(offers > 0, 'a map without its images offers to download them');
    } else {
      check(
        notice === 'Map image not installed. Markers are shown on a plain background.',
        `the notice only says the map image is not installed ("${notice}")`,
      );
      check(offers === 0, 'nothing offers to download map images');
    }
    // The note that the pack was added goes away by itself.
    await s.waitFor(`!document.querySelector('[data-testid="toast"]')`, {
      timeout: 20_000,
      what: 'the toast to go',
    });
    await s.screenshot('desktop-smoke-image-notice');

    // The Maps dialog lists the pack added from a web page; only a build
    // with downloads offers its map page, to view it and save its images.
    await s.click('[data-testid="maps-button"]');
    await s.waitFor(`document.querySelector('[data-pack="${IMPORTED_PACK}"]')`, {
      what: 'the pack added from a web page in the Maps dialog',
    });
    const dialog = await s.run(`
      const dialog = document.querySelector('[data-testid="maps-dialog"]');
      return {
        mapPages: dialog.querySelectorAll('[data-testid="map-page-details"]').length,
        text: dialog.textContent,
      };`);
    if (downloads) {
      check(dialog.mapPages > 0, 'the Maps dialog offers the map page of the added pack');
    } else {
      check(dialog.mapPages === 0, 'the Maps dialog offers no map page');
      check(
        !/download map images|save (map )?images as I browse|map page/i.test(dialog.text),
        'the Maps dialog offers no download and no saving',
      );
    }
    await s.screenshot('desktop-smoke-maps-dialog');
  } else {
    console.log(
      '# skipped: native dialogs and the system browser are only driven on Linux (xdotool)',
    );
  }
} finally {
  await session?.close();
  driver.stop();
  if (environment) await rm(environment.root, { recursive: true, force: true });
}
