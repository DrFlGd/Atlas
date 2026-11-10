// @ts-check
/**
 * Desktop smoke test: starts the built app through tauri-driver (WebDriver)
 * and checks that the window shows the map with its PMTiles tiles and
 * markers, that progress is saved (IndexedDB works), that the pack protocol
 * answers byte-range requests, and saves a screenshot.
 *
 *   pnpm --filter @atlas/desktop test:e2e [path/to/binary]
 *
 * Needs `tauri-driver` (`cargo install tauri-driver --locked`) and the
 * platform's WebDriver: WebKitWebDriver on Linux (package
 * `webkitgtk-webdriver`, or `webkit2gtk-driver` on older Ubuntu and
 * Debian releases). On a machine without a display, run it under
 * `xvfb-run`. Build the app first with `pnpm desktop:build`, or
 * `pnpm --filter @atlas/desktop build --debug --no-bundle` and pass
 * `src-tauri/target/debug/atlas-desktop`.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const here = (/** @type {string} */ path) => fileURLToPath(new URL(path, import.meta.url));
const exe = process.platform === 'win32' ? '.exe' : '';
const app = process.argv[2] ?? here(`../src-tauri/target/release/atlas-desktop${exe}`);
const resultsDir = here('../test-results/');
const timeoutMs = 60_000;

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Finds a free local port, so the test never collides with other servers. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
  });
}

const port = await freePort();
const nativePort = await freePort();
const driverUrl = `http://127.0.0.1:${port}`;
const driver = spawn(
  process.env.TAURI_DRIVER ?? 'tauri-driver',
  ['--port', String(port), '--native-port', String(nativePort)],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<any>}
 */
async function wd(method, path, body) {
  const response = await fetch(`${driverUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = /** @type {{ value: unknown }} */ (await response.json());
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.value)}`);
  return json.value;
}

/** @param {boolean} condition @param {string} message */
function check(condition, message) {
  if (!condition) throw new Error(`Check failed: ${message}`);
  console.log(`ok - ${message}`);
}

let sessionId = '';
try {
  for (let start = Date.now(); ; await sleep(250)) {
    const ready = await fetch(`${driverUrl}/status`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    if (Date.now() - start > 15_000) throw new Error('tauri-driver did not start');
  }

  ({ sessionId } = await wd('POST', '/session', {
    capabilities: { alwaysMatch: { 'tauri:options': { application: app } } },
  }));
  /** @param {string} script */
  const run = (script) => wd('POST', `/session/${sessionId}/execute/sync`, { script, args: [] });

  /**
   * @type {{ error: string | null, map: boolean, tiles: number, loaded: number,
   *   markers: string | null, storage: string | null }}
   */
  let state = { error: null, map: false, tiles: 0, loaded: 0, markers: null, storage: null };
  for (let start = Date.now(); Date.now() - start < timeoutMs; await sleep(500)) {
    state = await run(`
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
  const probe = await wd('POST', `/session/${sessionId}/execute/async`, {
    args: [],
    script: `
      const done = arguments[arguments.length - 1];
      (async () => {
        const configUrl = new URL('config.json', document.baseURI);
        const config = await (await fetch(configUrl, { cache: 'no-store' })).json();
        const packUrl = new URL(config.packs?.[0]?.url ?? config.packUrl, configUrl);
        const layers = await (await fetch(new URL('layers.json', packUrl))).json();
        const layer = layers.find((candidate) => candidate.tiles.type === 'pmtiles');
        if (!layer) return { url: '', status: 0, contentRange: null, bytes: 0 };
        const url = new URL(layer.tiles.url, packUrl).href;
        const response = await fetch(url, { headers: { range: 'bytes=0-126' } });
        const bytes = (await response.arrayBuffer()).byteLength;
        return { url, status: response.status, contentRange: response.headers.get('content-range'), bytes };
      })().then(done, (error) => done({ url: String(error), status: 0, contentRange: null, bytes: 0 }));`,
  });
  console.log('Range request:', JSON.stringify(probe));
  if (probe.url) {
    check(probe.status === 206 && probe.bytes === 127, 'PMTiles byte ranges are answered with 206');
    check(/^bytes 0-126\/\d+$/.test(probe.contentRange ?? ''), 'Content-Range is reported');
  }

  await mkdir(resultsDir, { recursive: true });
  const png = await wd('GET', `/session/${sessionId}/screenshot`);
  const screenshot = `${resultsDir}desktop-smoke.png`;
  await writeFile(screenshot, Buffer.from(png, 'base64'));
  console.log(`Screenshot saved to ${screenshot}`);
} finally {
  if (sessionId) await wd('DELETE', `/session/${sessionId}`).catch(() => undefined);
  driver.kill();
}
