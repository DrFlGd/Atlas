// @ts-check
/**
 * Start-up test of the built Map Maker on Windows:
 *
 *   pnpm --filter @atlas/mapmaker test:e2e:windows [path/to/atlas-mapmaker.exe]
 *
 * Checks that the helper sits next to the app, where the installer puts it, and answers `--version`; then starts
 * the app with a temporary WebView2 profile and checks from outside (as apps/desktop/e2e/windows.js does for the
 * viewer, since WebView2 cannot be driven from inside here) that its window opens with its title, the embedded
 * browser starts its page, and it still responds a few seconds later. Saves a picture of the desktop to
 * `apps/mapmaker/test-results/mapmaker-windows.png`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.error('This test runs on Windows only.');
  process.exit(1);
}

const here = (/** @type {string} */ path) => fileURLToPath(new URL(path, import.meta.url));
const appPath = process.argv[2] ?? here('../src-tauri/target/release/atlas-mapmaker.exe');
const resultsDir = here('../test-results/');
/** @param {boolean} ok @param {string} what */
function check(ok, what) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
}

const helper = join(dirname(appPath), 'atlas-gamefiles.exe');
check(
  await stat(helper).then(
    () => true,
    () => false,
  ),
  `the helper is next to the app (${helper})`,
);
const version = spawnSync(helper, ['--version'], { encoding: 'utf8', timeout: 120_000 });
check(
  version.status === 0 && /^atlas-gamefiles \d+\.\d+\.\d+/.test(version.stdout.trim()),
  `the helper answers --version (${version.stdout.trim() || version.stderr.trim()})`,
);

const config = JSON.parse(await readFile(here('../src-tauri/tauri.conf.json'), 'utf8'));
/** @type {string} */
const title = config.app.windows[0].title;
const waitSeconds = Number(process.env.ATLAS_E2E_TIMEOUT ?? 90);
const settleSeconds = 10;
const profile = await mkdtemp(join(tmpdir(), 'atlas-mapmaker-e2e-webview-'));
await mkdir(resultsDir, { recursive: true });
const picture = join(resultsDir, 'mapmaker-windows.png');

/** @type {string | null} */
let exited = null;
const app = spawn(appPath, [], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile },
});
app.once('error', (error) => {
  exited = `could not be started: ${String(error)}`;
});
app.once('exit', (code, signal) => {
  exited = `exited (code ${code}, signal ${signal})`;
});
console.log(`Started ${appPath} (process ${app.pid})`);

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
  /** @type {{ windowTitle: string, pageProcess: boolean, running: boolean, responding: boolean, picture: string }} */
  const state = JSON.parse(line);
  console.log('Window state:', JSON.stringify(state));
  check(state.running && exited === null, `the app is running${exited ? ` (it ${exited})` : ''}`);
  check(state.windowTitle === title, `the window is open with the title "${title}"`);
  check(state.pageProcess, "the embedded browser started the app's page");
  check(state.responding, `the app still responds ${settleSeconds} seconds later`);
  console.log('Map Maker start-up test passed.');
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  app.removeAllListeners('exit');
  app.kill();
}
process.exit(failed ? 1 : 0);
