// @ts-check
/**
 * Start-up test for Windows.
 *
 *   pnpm --filter @atlas/desktop test:e2e:windows [path/to/atlas-desktop.exe]
 *
 * The WebDriver route used on Linux needs an Edge driver that matches the
 * installed WebView2 runtime exactly, which a CI image does not promise. This
 * test talks to WebView2's own DevTools endpoint instead: it starts the built
 * app with remote debugging on a local port and a temporary profile folder,
 * waits for the app's page and checks that the map, its tiles and markers
 * show, that progress is saved, that the pack protocol answers byte ranges on
 * its `http://atlas-pack.localhost/` form and that the shell's commands
 * answer. It saves a screenshot to `apps/desktop/test-results/`.
 *
 * Set `ATLAS_E2E_CDP_URL` (for example `http://127.0.0.1:9222`) to check a
 * page that is already open in a Chromium browser instead of starting the
 * app; the checks that need the desktop shell are then left out.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appPath, check, freePort, here, resultsDir, sleep } from './webdriver.js';

const timeoutMs = Number(process.env.ATLAS_E2E_TIMEOUT ?? 90_000);
const attachUrl = process.env.ATLAS_E2E_CDP_URL ?? null;
const { version } = JSON.parse(await readFile(here('../package.json'), 'utf8'));

/** A DevTools connection to one page. */
class Page {
  /** @param {WebSocket} socket */
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
      else waiting.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const waiting of this.pending.values()) {
        waiting.reject(new Error('The DevTools connection closed'));
      }
      this.pending.clear();
    });
  }

  /** @param {string} url */
  static connect(url) {
    return /** @type {Promise<Page>} */ (
      new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.addEventListener('open', () => {
          resolve(new Page(socket));
        });
        socket.addEventListener('error', () => {
          reject(new Error(`Could not connect to ${url}`));
        });
      })
    );
  }

  /** @param {string} method @param {Record<string, unknown>} [params] @returns {Promise<any>} */
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Runs a function body in the page; it may `await`, and its return value
   * is the result.
   * @param {string} body
   * @returns {Promise<any>}
   */
  async run(body) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const { exception, text } = result.exceptionDetails;
      throw new Error(`Page script failed: ${exception?.description ?? text}`);
    }
    return result.result.value;
  }

  /** @param {string} name */
  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    await mkdir(resultsDir, { recursive: true });
    const file = join(resultsDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`Screenshot: ${file}`);
  }

  close() {
    this.socket.close();
  }
}

/**
 * Waits for the app's page to be listed by the DevTools endpoint.
 * @param {string} endpoint
 * @param {() => string | null} stopped Why the app is gone, or null while it runs.
 * @returns {Promise<{ url: string, webSocketDebuggerUrl: string }>}
 */
async function findPage(endpoint, stopped) {
  let seen = '';
  for (let start = Date.now(); Date.now() - start < timeoutMs; await sleep(500)) {
    const gone = stopped();
    if (gone) throw new Error(gone);
    /** @type {{ type: string, url: string, webSocketDebuggerUrl?: string }[]} */
    const targets = await fetch(`${endpoint}/json/list`).then(
      (response) => (response.ok ? response.json() : []),
      () => [],
    );
    seen = JSON.stringify(targets.map((target) => `${target.type} ${target.url}`));
    const page = targets.find(
      (target) =>
        target.type === 'page' && /^https?:\/\//.test(target.url) && target.webSocketDebuggerUrl,
    );
    if (page?.webSocketDebuggerUrl) {
      return { url: page.url, webSocketDebuggerUrl: page.webSocketDebuggerUrl };
    }
  }
  throw new Error(`The app's page did not appear within ${timeoutMs} ms (targets: ${seen})`);
}

/**
 * Prints what is known about a failed start on Windows: the installed
 * WebView2 runtime, the app's and the webview's processes, open windows, the
 * profile folder, and a picture of the desktop.
 * @param {string} endpoint @param {string | null} profile
 */
async function diagnose(endpoint, profile) {
  const version = await fetch(`${endpoint}/json/version`).then(
    (response) => response.text(),
    (error) => `unreachable: ${String(error?.cause ?? error)}`,
  );
  console.log(`DevTools endpoint ${endpoint}: ${version}`);
  if (profile) {
    const entries = await readdir(profile).catch((error) => [`unreadable: ${String(error)}`]);
    console.log(`Profile folder ${profile}: ${JSON.stringify(entries)}`);
  }
  if (process.platform !== 'win32') return;
  await mkdir(resultsDir, { recursive: true });
  const script = `
    $ErrorActionPreference = 'Continue'
    '--- WebView2 runtime'
    $id = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($root in 'HKLM:\\SOFTWARE\\WOW6432Node', 'HKLM:\\SOFTWARE', 'HKCU:\\SOFTWARE') {
      $key = "$root\\Microsoft\\EdgeUpdate\\Clients\\$id"
      if (Test-Path $key) { "$key pv=$((Get-ItemProperty $key).pv)" } else { "$key is missing" }
    }
    '--- app and webview processes'
    Get-Process | Where-Object { $_.ProcessName -match 'atlas|msedgewebview2|WerFault' } |
      Format-Table Id, ProcessName, MainWindowTitle, Responding -AutoSize | Out-String -Width 200
    '--- windows with a title'
    Get-Process | Where-Object { $_.MainWindowTitle } |
      Format-Table Id, ProcessName, MainWindowTitle -AutoSize | Out-String -Width 200
    '--- session'
    "session=$((Get-Process -Id $PID).SessionId) interactive=$([Environment]::UserInteractive)"
    '--- desktop picture'
    try {
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $bitmap.Size)
      $bitmap.Save($env:ATLAS_E2E_DESKTOP_PICTURE)
      "saved $env:ATLAS_E2E_DESKTOP_PICTURE ($($screen.Width)x$($screen.Height))"
    } catch { "no picture: $_" }
  `;
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ATLAS_E2E_DESKTOP_PICTURE: join(resultsDir, 'desktop-windows-failed.png'),
    },
  });
  console.log(result.stdout || result.stderr || String(result.error));
}

/** @type {import('node:child_process').ChildProcess | null} */
let app = null;
/** @type {string | null} */
let profile = null;
/** @type {string | null} */
let exited = null;
let endpoint = attachUrl;
if (!endpoint) {
  const port = await freePort();
  profile = await mkdtemp(join(tmpdir(), 'atlas-e2e-webview-'));
  endpoint = `http://127.0.0.1:${port}`;
  app = spawn(appPath, [], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      // A new profile, so the app starts as on a first launch.
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-allow-origins=*`,
    },
  });
  app.once('error', (error) => {
    exited = `The app could not be started: ${String(error)}`;
  });
  app.once('exit', (code, signal) => {
    exited = `The app exited at start-up (code ${code}, signal ${signal})`;
  });
  console.log(`Started ${appPath} with DevTools on ${endpoint}`);
}

/** @type {Page | null} */
let page = null;
let failed = false;
try {
  const target = await findPage(endpoint, () => exited);
  console.log(`Page: ${target.url}`);
  check(true, 'the app starts and opens its page');
  page = await Page.connect(target.webSocketDebuggerUrl);
  const p = page;

  /**
   * @type {{ error: string | null, map: boolean, tiles: number, loaded: number,
   *   markers: string | null, storage: string | null }}
   */
  let state = { error: null, map: false, tiles: 0, loaded: 0, markers: null, storage: null };
  for (let start = Date.now(); Date.now() - start < timeoutMs; await sleep(500)) {
    if (exited) throw new Error(exited);
    state = await p.run(`
      const tiles = [...document.querySelectorAll('.atlas-tiles img')];
      return {
        error: document.querySelector('.status-error')?.textContent ?? null,
        map: !!document.querySelector('.leaflet-container'),
        tiles: tiles.length,
        loaded: tiles.filter((tile) => tile.complete && tile.naturalWidth > 0).length,
        markers: document.querySelector('[data-testid="marker-count"]')?.textContent ?? null,
        storage: document.querySelector('.shell')?.getAttribute('data-storage') ?? null,
      };`);
    if (state.error) break;
    if (state.tiles > 0 && state.loaded === state.tiles && state.storage === 'saved') break;
  }
  console.log('Window state:', JSON.stringify(state));
  await p.screenshot('desktop-windows').catch((error) => {
    console.log(`No screenshot: ${String(error)}`);
  });
  check(state.error === null, 'the app shows no load error');
  check(state.map, 'the map is shown');
  check(state.tiles > 0 && state.loaded === state.tiles, 'every visible tile has loaded');
  check(/^[1-9][\d,]*$/.test(state.markers ?? ''), 'the pack markers are shown');
  check(state.storage === 'saved', 'progress is saved on this device');

  // The request the PMTiles reader makes first: the archive header.
  /** @type {{ url: string, status: number, contentRange: string | null, bytes: number }} */
  const probe = await p.run(`
    const configUrl = new URL('config.json', document.baseURI);
    const config = await (await fetch(configUrl, { cache: 'no-store' })).json();
    let packs = config.packs ?? (config.packUrl ? [{ url: config.packUrl }] : null);
    if (!packs) {
      const indexUrl = new URL(config.packIndex ?? 'packs/index.json', configUrl);
      packs = (await (await fetch(indexUrl, { cache: 'no-store' })).json()).packs;
    }
    for (const pack of packs) {
      const packUrl = new URL(pack.url, configUrl);
      const layers = await (await fetch(new URL('layers.json', packUrl))).json();
      const layer = layers.find((candidate) => candidate.tiles.type === 'pmtiles');
      if (!layer) continue;
      const url = new URL(layer.tiles.url, packUrl).href;
      const response = await fetch(url, { headers: { range: 'bytes=0-126' } });
      const bytes = (await response.arrayBuffer()).byteLength;
      return { url, status: response.status, contentRange: response.headers.get('content-range'), bytes };
    }
    return { url: '', status: 0, contentRange: null, bytes: 0 };`);
  console.log('Range request:', JSON.stringify(probe));
  check(probe.url !== '', 'a bundled pack has a PMTiles layer to probe');
  check(probe.status === 206 && probe.bytes === 127, 'PMTiles byte ranges are answered with 206');
  check(/^bytes 0-126\/\d+$/.test(probe.contentRange ?? ''), 'Content-Range is reported');

  if (!attachUrl) {
    check(
      probe.url.startsWith('http://atlas-pack.localhost/'),
      'packs are served on http://atlas-pack.localhost/',
    );
    const info = await p.run(`return window.__TAURI_INTERNALS__.invoke('desktop_info');`);
    console.log('Desktop info:', JSON.stringify(info));
    check(info?.version === version, `the shell reports version ${version}`);
    check(exited === null, 'the app is still running');
  }
  console.log('Windows start-up test passed.');
} catch (error) {
  failed = true;
  console.error(error);
  await diagnose(endpoint, profile).catch((problem) => {
    console.error(`Diagnosis failed: ${String(problem)}`);
  });
} finally {
  page?.close();
  app?.removeAllListeners('exit');
  app?.kill();
}
process.exit(failed ? 1 : 0);
