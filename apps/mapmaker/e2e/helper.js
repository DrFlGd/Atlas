// @ts-check
/**
 * Runs the Map Maker's helper the way the app starts it (apps/mapmaker/src-tauri/src/checks.rs): no console window
 * (`windowsHide`, which is CREATE_NO_WINDOW), standard input, output and error all piped, `--stdin-cancel`, and the
 * output folder as the working folder. Standard input stays open until the check ends, as in the app.
 *
 *   node apps/mapmaker/e2e/helper.js <helper> <made-up game folder> <output folder> [--cancel]
 *
 * Without `--cancel`: the check must end with `done`, and collision and navmesh must have been read in at least one
 * area. With `--cancel`: writes `cancel` once the geometry reading starts, and the check must end with `cancelled`
 * (exit code 3) within 30 seconds.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const [helperArg, folderArg, outArg] = process.argv.slice(2, 5);
const cancel = process.argv.includes('--cancel');
if (!helperArg || !folderArg || !outArg) {
  console.error('Usage: node e2e/helper.js <helper> <game folder> <output folder> [--cancel]');
  process.exit(2);
}
// The working folder changes to the output folder, so every path is made absolute first.
const [helper, folder, out] = [helperArg, folderArg, outArg].map((path) => resolve(path));
const LIMIT_MS = 10 * 60 * 1000;

/** @param {boolean} ok @param {string} what */
function check(ok, what) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
}

await mkdir(out, { recursive: true });
const started = Date.now();
const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
const child = spawn(helper, ['check', folder, '--out', out, '--stdin-cancel'], {
  cwd: out,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
/** @type {Record<string, any>[]} */
const events = [];
let cancelSentAt = 0;
createInterface({ input: child.stderr }).on('line', (line) => console.log(`[stderr] ${line}`));
createInterface({ input: child.stdout }).on('line', (line) => {
  /** @type {Record<string, any>} */
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    console.log(`[not JSON] ${line}`);
    return;
  }
  events.push(event);
  console.log(`${seconds()} s  ${event.event}${event.message ? `: ${event.message}` : ''}`);
  if (
    cancel &&
    !cancelSentAt &&
    event.event === 'progress' &&
    /reading collision/.test(event.message)
  ) {
    cancelSentAt = Date.now();
    child.stdin.write('cancel\n');
  }
});
const timer = setTimeout(() => {
  console.error(`The helper was still running after ${LIMIT_MS / 1000} s; killing it.`);
  child.kill();
}, LIMIT_MS);
/** @type {number | null} */
const code = await new Promise((resolve) => child.on('close', (exitCode) => resolve(exitCode)));
clearTimeout(timer);
console.log(`The helper ended after ${seconds()} s with exit code ${code}.`);
const last = events.at(-1);

if (cancel) {
  check(cancelSentAt > 0, 'cancel was sent while the geometry was being read');
  check(
    last?.event === 'cancelled' && code === 3,
    'the check ended with "cancelled" (exit code 3)',
  );
  check(Date.now() - cancelSentAt < 30_000, 'it stopped within 30 s of the cancel');
} else {
  check(last?.event === 'done' && code === 0, 'the check ended with "done" (exit code 0)');
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  for (const area of report.areas) {
    for (const [source, result] of Object.entries(area.geometry ?? {})) {
      console.log(
        `${area.id} ${source}: ${result.status}${result.errors ? ` (${result.errors.join('; ')})` : ''}`,
      );
    }
  }
  const geometry = report.summary.geometry;
  check(geometry.collision.ok > 0, `collision was read (${JSON.stringify(geometry.collision)})`);
  check(geometry.navmesh.ok > 0, `navmesh was read (${JSON.stringify(geometry.navmesh)})`);
}
