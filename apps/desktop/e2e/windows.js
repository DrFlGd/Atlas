// @ts-check
/**
 * Start-up test for Windows.
 *
 *   pnpm --filter @atlas/desktop test:e2e:windows [path/to/atlas-desktop.exe]
 *
 * Starts the built app with a temporary WebView2 profile and checks, from
 * outside, that it comes up and stays up: its window opens with the app's
 * title, the embedded browser starts a page for it, and the app is still
 * running and responding a few seconds later. It then saves a picture of the
 * desktop to `apps/desktop/test-results/desktop-windows.png`, for a person to
 * look at. Before that it checks that the binary holds the code that
 * downloads map images exactly when the build was meant to (as
 * `pnpm desktop:build` recorded, or as `ATLAS_ENABLE_DOWNLOADS` says when
 * set): a viewer build, the default, holds none of it, so it offers no
 * download.
 *
 * It does not look inside the page. The WebDriver route used on Linux needs
 * an Edge driver matching the installed WebView2 exactly, and both that
 * driver and a direct DevTools connection rely on the
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` variable, which WebView2 does not
 * apply to an app that passes browser arguments of its own, as Tauri does.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { checkBinary, expectDownloads } from '../scripts/check-binary.js';
import { appPath, check, here, resultsDir } from './webdriver.js';

if (process.platform !== 'win32') {
  console.error('This test runs on Windows only. Use test:e2e on Linux.');
  process.exit(1);
}

const downloads = await expectDownloads();
const problem = await checkBinary(appPath, downloads);
check(
  problem === null,
  problem ??
    (downloads
      ? 'the binary holds the code to download map images'
      : 'the binary holds no code to download map images, so the app offers none'),
);

const waitSeconds = Number(process.env.ATLAS_E2E_TIMEOUT ?? 90);
const settleSeconds = 10;
const config = JSON.parse(await readFile(here('../src-tauri/tauri.conf.json'), 'utf8'));
// A build with a name of its own (ATLAS_APP_NAME) leaves its settings here.
const identity = await readFile(here('../src-tauri/tauri.identity.conf.json'), 'utf8').then(
  (text) => JSON.parse(text),
  () => null,
);
/** @type {string} */
const title = (identity ?? config).app.windows[0].title;

const profile = await mkdtemp(join(tmpdir(), 'atlas-e2e-webview-'));
await mkdir(resultsDir, { recursive: true });
const picture = join(resultsDir, 'desktop-windows.png');

/** @type {string | null} */
let exited = null;
const app = spawn(appPath, [], {
  stdio: ['ignore', 'inherit', 'inherit'],
  // A new profile, so the app starts as on a first launch.
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile },
});
app.once('error', (error) => {
  exited = `could not be started: ${String(error)}`;
});
app.once('exit', (code, signal) => {
  exited = `exited (code ${code}, signal ${signal})`;
});
console.log(`Started ${appPath} (process ${app.pid})`);

// Watches the app from outside: its window title, whether it responds, and
// the page process the embedded browser starts for it (found by the name of
// the profile folder on its command line). Prints one JSON object.
const watch = `
  $ErrorActionPreference = 'Stop'
  $appId = [int]$env:ATLAS_E2E_APP_PID
  $profileName = $env:ATLAS_E2E_PROFILE
  $state = [ordered]@{ windowTitle = ''; pageProcess = $false; running = $false; responding = $false; picture = '' }
  function Read-State {
    $process = Get-Process -Id $appId -ErrorAction SilentlyContinue
    $state.running = [bool]$process
    if ($process) {
      $state.windowTitle = [string]$process.MainWindowTitle
      $state.responding = [bool]$process.Responding
    }
    $pages = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
      Where-Object { $_.CommandLine -like '*--type=renderer*' -and $_.CommandLine -like "*$profileName*" }
    $state.pageProcess = [bool]$pages
  }
  $deadline = (Get-Date).AddSeconds([int]$env:ATLAS_E2E_WAIT)
  do {
    Read-State
    if (-not $state.running) { break }
    if ($state.windowTitle -and $state.pageProcess) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  if ($state.running -and $state.windowTitle -and $state.pageProcess) {
    Start-Sleep -Seconds ([int]$env:ATLAS_E2E_SETTLE)
    Read-State
  }
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $bitmap.Size)
    $bitmap.Save($env:ATLAS_E2E_PICTURE)
    $state.picture = $env:ATLAS_E2E_PICTURE
  } catch { $state.picture = "none: $_" }
  $state | ConvertTo-Json -Compress
`;

let failed = false;
try {
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', watch], {
    encoding: 'utf8',
    timeout: (waitSeconds + settleSeconds + 60) * 1000,
    env: {
      ...process.env,
      ATLAS_E2E_APP_PID: String(app.pid),
      ATLAS_E2E_PROFILE: basename(profile),
      ATLAS_E2E_WAIT: String(waitSeconds),
      ATLAS_E2E_SETTLE: String(settleSeconds),
      ATLAS_E2E_PICTURE: picture,
    },
  });
  if (result.error) throw result.error;
  if (result.stderr.trim()) console.error(result.stderr.trim());
  const line = result.stdout.trim().split(/\r?\n/).pop() ?? '';
  /**
   * @type {{ windowTitle: string, pageProcess: boolean, running: boolean,
   *   responding: boolean, picture: string }}
   */
  const state = JSON.parse(line);
  console.log('Window state:', JSON.stringify(state));
  console.log(`Desktop picture: ${state.picture}`);
  check(state.running && exited === null, `the app is running${exited ? ` (it ${exited})` : ''}`);
  check(state.windowTitle === title, `the window is open with the title "${title}"`);
  check(state.pageProcess, "the embedded browser started the app's page");
  check(state.responding, `the app still responds ${settleSeconds} seconds later`);
  console.log('Windows start-up test passed.');
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  app.removeAllListeners('exit');
  app.kill();
}
process.exit(failed ? 1 : 0);
