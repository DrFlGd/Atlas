// @ts-check
/**
 * A small WebDriver client for the desktop tests: starts tauri-driver,
 * opens sessions on the built app and drives the page.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = (/** @type {string} */ path) => fileURLToPath(new URL(path, import.meta.url));
const exe = process.platform === 'win32' ? '.exe' : '';
/** The app binary: the first command-line argument, else the release build. */
export const appPath = process.argv[2] ?? here(`../src-tauri/target/release/atlas-desktop${exe}`);
export const resultsDir = here('../test-results/');

export const sleep = (/** @type {number} */ ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Finds a free local port, so the test never collides with other servers. */
export function freePort() {
  return /** @type {Promise<number>} */ (
    new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => {
          resolve(typeof address === 'object' && address ? address.port : 0);
        });
      });
    })
  );
}

/**
 * A temporary home for the app's data and a stand-in system browser (Linux):
 * XDG_DATA_HOME and XDG_CONFIG_HOME point into a new folder, so the app starts
 * as on a first launch and never touches the user's data, and http(s) links
 * open a script that only writes the URL to `opened`.
 */
export async function isolatedEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'atlas-e2e-'));
  const data = join(root, 'data');
  const config = join(root, 'config');
  const opened = join(root, 'opened.txt');
  const browser = join(root, 'browser.sh');
  await mkdir(join(data, 'applications'), { recursive: true });
  await mkdir(config, { recursive: true });
  await writeFile(browser, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`);
  await chmod(browser, 0o755);
  await writeFile(
    join(data, 'applications', 'atlas-e2e-browser.desktop'),
    `[Desktop Entry]\nType=Application\nName=Test browser\nExec=${browser} %u\n` +
      'MimeType=x-scheme-handler/http;x-scheme-handler/https;\n',
  );
  const handlers =
    'x-scheme-handler/http=atlas-e2e-browser.desktop\nx-scheme-handler/https=atlas-e2e-browser.desktop\n';
  await writeFile(join(config, 'mimeapps.list'), `[Default Applications]\n${handlers}`);
  await writeFile(
    join(data, 'applications', 'mimeapps.list'),
    `[Default Applications]\n${handlers}`,
  );
  return {
    root,
    opened,
    env: {
      ...process.env,
      XDG_DATA_HOME: data,
      XDG_CONFIG_HOME: config,
      BROWSER: browser,
      // GTK keeps its settings (such as the file dialog's) in memory.
      GSETTINGS_BACKEND: 'memory',
    },
  };
}

/** @param {boolean} condition @param {string} message */
export function check(condition, message) {
  if (!condition) throw new Error(`Check failed: ${message}`);
  console.log(`ok - ${message}`);
}

/**
 * Starts tauri-driver with an optional environment for the app.
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export async function startDriver({ env } = {}) {
  const port = await freePort();
  const nativePort = await freePort();
  const driverUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.env.TAURI_DRIVER ?? 'tauri-driver',
    [
      '--port',
      String(port),
      '--native-port',
      String(nativePort),
      // The platform's WebDriver, when it is not on the PATH.
      ...(process.env.TAURI_NATIVE_DRIVER
        ? ['--native-driver', process.env.TAURI_NATIVE_DRIVER]
        : []),
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], env: env ?? process.env },
  );

  /**
   * @param {string} method @param {string} path @param {unknown} [body]
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

  for (let start = Date.now(); ; await sleep(250)) {
    const ready = await fetch(`${driverUrl}/status`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    if (Date.now() - start > 15_000) {
      child.kill();
      throw new Error('tauri-driver did not start');
    }
  }

  return {
    /**
     * Starts the app and returns a session on its window, in the classic
     * layout these tests were written for (see `Session.useClassicLayout`).
     */
    async session(application = appPath) {
      const { sessionId } = await wd('POST', '/session', {
        capabilities: { alwaysMatch: { 'tauri:options': { application } } },
      });
      const session = new Session(wd, sessionId);
      await session.useClassicLayout();
      return session;
    },
    stop() {
      child.kill();
    },
  };
}

/** The id in a WebDriver element reference (W3C key, or the only key). */
const elementId = (/** @type {Record<string, string>} */ reference) =>
  reference['element-6066-11e4-a52e-4f735466cecc'] ?? Object.values(reference)[0];

export class Session {
  /**
   * @param {(method: string, path: string, body?: unknown) => Promise<any>} wd
   * @param {string} id
   */
  constructor(wd, id) {
    this.wd = wd;
    this.id = id;
  }

  /**
   * Shows the app's classic layout (a bar at the top, panes on both sides of
   * the map), which these tests were written for, as `?ui=classic` does in
   * a browser: the app keeps the choice in the page's session storage (see
   * `apps/web/src/touch/uiMode.ts`) and reads it when the page loads, so the
   * page is loaded again once it is set. The app shows its standard layout
   * otherwise; the web tests cover that one.
   */
  async useClassicLayout() {
    // Scripts may fail to run while the page is (re)loading; that is waited out.
    const settle = async (/** @type {string} */ script, /** @type {string} */ what) => {
      for (let start = Date.now(); ; await sleep(250)) {
        if (await this.run(script).catch(() => false)) return;
        if (Date.now() - start > 30_000) throw new Error(`Timed out waiting for ${what}`);
      }
    };
    await settle(
      `return document.readyState === 'complete' && location.href !== 'about:blank' &&
        document.getElementById('root') !== null;`,
      'the app page',
    );
    await this.run(`
      window.sessionStorage.setItem('atlas-ui', 'classic');
      window.__atlasReloading = true;
      setTimeout(() => window.location.reload(), 0);
      return true;
    `);
    await settle(
      `return !window.__atlasReloading && document.readyState === 'complete' &&
        window.sessionStorage.getItem('atlas-ui') === 'classic';`,
      'the app page in the classic layout',
    );
  }

  /** Runs a script in the page and returns its result. @param {string} script @param {unknown[]} [args] */
  run(script, args = []) {
    return this.wd('POST', `/session/${this.id}/execute/sync`, { script, args });
  }

  /**
   * Runs an async script: its body may `await`, and its return value is the result.
   * @param {string} body @param {unknown[]} [args]
   */
  runAsync(body, args = []) {
    return this.wd('POST', `/session/${this.id}/execute/async`, {
      args,
      script: `const done = arguments[arguments.length - 1];
        (async (...args) => { ${body} })(...Array.from(arguments).slice(0, -1))
          .then(done, (error) => done({ error: String(error) }));`,
    });
  }

  /** Polls a page expression until it is truthy, and returns it. @param {string} expression */
  async waitFor(expression, { timeout = 30_000, what = expression } = {}) {
    let value;
    for (let start = Date.now(); Date.now() - start < timeout; await sleep(250)) {
      value = await this.run(`return (${expression});`);
      if (value) return value;
    }
    throw new Error(`Timed out waiting for ${what} (last value ${JSON.stringify(value)})`);
  }

  /** Clicks the first element matching a CSS selector, as a user would. @param {string} selector */
  async click(selector) {
    const element = await this.wd('POST', `/session/${this.id}/element`, {
      using: 'css selector',
      value: selector,
    });
    await this.wd('POST', `/session/${this.id}/element/${elementId(element)}/click`, {});
  }

  /** Types into the first element matching a CSS selector. @param {string} selector @param {string} text */
  async type(selector, text) {
    const element = await this.wd('POST', `/session/${this.id}/element`, {
      using: 'css selector',
      value: selector,
    });
    await this.wd('POST', `/session/${this.id}/element/${elementId(element)}/value`, { text });
  }

  /** @param {number} width @param {number} height */
  resize(width, height) {
    return this.wd('POST', `/session/${this.id}/window/rect`, { width, height });
  }

  /** Saves a screenshot of the window to the results folder. @param {string} name */
  async screenshot(name) {
    await mkdir(resultsDir, { recursive: true });
    const png = await this.wd('GET', `/session/${this.id}/screenshot`);
    const path = `${resultsDir}${name}.png`;
    await writeFile(path, Buffer.from(png, 'base64'));
    console.log(`Screenshot saved to ${path}`);
    return path;
  }

  /** Closes the app. */
  close() {
    return this.wd('DELETE', `/session/${this.id}`).catch(() => undefined);
  }
}
