// @ts-check
/**
 * End-to-end test of the built Map Maker on Linux, with its helper, on a made-up game folder:
 *
 *   python tools/gamefiles/tests/fixtures.py dsr /tmp/made-up-dsr
 *   xvfb-run -a node apps/mapmaker/e2e/linux.js /tmp/made-up-dsr [path/to/atlas-mapmaker]
 *
 * The app starts with its own temporary data and config folders, where the last game folder is already set (the
 * folder dialog cannot be driven), so this clicks Check game files, waits for the report, and checks the game
 * line, the areas table, the preview pictures and the report zip in the app's data. It uses the WebDriver client
 * of the viewer's tests (apps/desktop/e2e/webdriver.js) and saves a screenshot to
 * apps/mapmaker/test-results/mapmaker-linux.png.
 */
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, isolatedEnvironment, startDriver } from '../../desktop/e2e/webdriver.js';

const here = (/** @type {string} */ path) => fileURLToPath(new URL(path, import.meta.url));
const folder = process.argv[2];
if (!folder) {
  console.error('Usage: node e2e/linux.js <made-up game folder> [app]');
  process.exit(2);
}
const app = process.argv[3] ?? here('../src-tauri/target/release/atlas-mapmaker');
const resultsDir = here('../test-results/');

const environment = await isolatedEnvironment();
const config = join(environment.env.XDG_CONFIG_HOME ?? '', 'dev.atlas.mapmaker');
await mkdir(config, { recursive: true });
await writeFile(join(config, 'settings.json'), JSON.stringify({ lastFolder: folder }));

const driver = await startDriver({ env: environment.env });
let failed = false;
/** @type {import('../../desktop/e2e/webdriver.js').Session | null} */
let session = null;
try {
  session = await driver.session(app);
  await session.waitFor(
    `document.querySelector('.mm-path')?.textContent === ${JSON.stringify(folder)}`,
    {
      what: 'the last folder to be shown',
    },
  );
  check(true, 'the window shows the last game folder');
  const helperMissing = await session.run(
    `return document.body.textContent.includes('is missing');`,
  );
  check(!helperMissing, 'the app found its helper');

  await session.click('#check-start');
  await session.waitFor(`document.querySelector('#result-title')?.textContent`, {
    timeout: 180_000,
    what: 'the report',
  });
  const headline = await session.run(`return document.querySelector('#result-title').textContent;`);
  check(headline === 'Dark Souls Remastered, version 1.3.1.0', `the game line reads "${headline}"`);
  const rows = await session.run(
    `return [...document.querySelectorAll('.mm-table tbody tr')].map((row) => row.textContent);`,
  );
  check(rows.length === 2, `the areas table has 2 rows`);
  check(
    rows[0].includes('Undead Burg / Parish') && rows[0].includes('Read (6 triangles)'),
    `Undead Burg's collision was read: ${rows[0]}`,
  );
  check(
    rows[1].includes('Firelink Shrine') && rows[1].includes('No files'),
    'Firelink has no geometry files',
  );
  await session.waitFor(
    `(() => { const images = [...document.querySelectorAll('.mm-preview img')];
      return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0); })()`,
    { what: 'two preview pictures' },
  );
  check(true, 'both preview pictures are shown');
  const saveButton = await session.run(`return Boolean(document.querySelector('#save-report'));`);
  check(saveButton, 'Save report… is offered');

  const checks = join(environment.env.XDG_DATA_HOME ?? '', 'dev.atlas.mapmaker', 'checks');
  const runs = await readdir(checks);
  check(runs.length === 1, `one check folder in the app's data (${runs.join(', ')})`);
  const zip = await stat(join(checks, runs[0] ?? '', 'atlas-check-report.zip')).catch(() => null);
  check(Boolean(zip && zip.size > 0), 'the report zip was written there');

  await mkdir(resultsDir, { recursive: true });
  for (const [name, target] of [
    ['mapmaker-linux.png', 'h1'],
    ['mapmaker-linux-areas.png', '#areas-title'],
    ['mapmaker-linux-previews.png', '#previews-title'],
  ]) {
    await session.run(`document.querySelector(${JSON.stringify(target)}).scrollIntoView();`);
    const png = await session.wd('GET', `/session/${session.id}/screenshot`);
    await writeFile(join(resultsDir, name), Buffer.from(png, 'base64'));
    console.log(`Screenshot saved to ${join(resultsDir, name)}`);
  }
  console.log('Map Maker end-to-end test passed.');
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await session?.close();
  driver.stop();
}
process.exit(failed ? 1 : 0);
