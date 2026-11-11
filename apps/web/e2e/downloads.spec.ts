import { mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { downloadsEnabled } from '../tooling/buildFlags.ts';
import { collectErrors } from './helpers';

/**
 * The "Download map images" interface, against a stand-in for the desktop
 * shell: the page gets a fake `__TAURI_INTERNALS__.invoke` whose download
 * job advances on every poll, and the pack is served at the Windows form of
 * the pack protocol (`http://atlas-pack.localhost/<id>/`), which the test
 * can intercept. The real shell is covered by the desktop tests.
 */

/**
 * The app under test was built with map image downloads. Run the tests with
 * the same `ATLAS_ENABLE_DOWNLOADS` as the build.
 */
const DOWNLOADS_BUILD = downloadsEnabled(process.env.ATLAS_ENABLE_DOWNLOADS);

const PACK_URL = 'http://atlas-pack.localhost/remote/';
const SHOTS = 'test-results/downloads';

function remotePack(): Record<string, unknown> {
  const id = (kind: string, local: string) => `remote:${kind}:${local}`;
  const layer = (slug: string, maxZoom: number) => ({
    id: id('layer', slug),
    mapId: id('map', slug),
    name: 'Surface',
    tiles: {
      type: 'xyz',
      url: `tiles/${slug}/{z}/{x}/{y}.png`,
      remote: {
        urlTemplate: `https://tiles.example.com/${slug}/{z}/{x}/{y}.png`,
        levels: [
          { z: maxZoom - 1, sourceZ: 11, offsetX: 4, offsetY: 8 },
          { z: maxZoom, sourceZ: 12, offsetX: 8, offsetY: 16 },
        ],
      },
    },
    minZoom: 0,
    maxZoom,
    tileSize: 256,
  });
  return {
    'manifest.json': {
      schemaVersion: 1,
      gameId: 'remote',
      title: 'Remote test pack',
      packVersion: '1.0.0',
      gamePatch: '1',
      attribution: [],
      idMigrations: {},
    },
    'maps.json': [
      { id: id('map', 'island'), name: 'Island', width: 2048, height: 1536 },
      { id: id('map', 'cave'), name: 'Cave', width: 1024, height: 1024 },
    ],
    'layers.json': [layer('island', 3), layer('cave', 2)],
    'categoryGroups.json': [{ id: id('catgroup', 'g'), name: 'Marks', order: 0 }],
    'categories.json': [
      {
        id: id('cat', 'c'),
        groupId: id('catgroup', 'g'),
        name: 'Beacon',
        icon: 'star',
        color: '#ffd166',
        trackable: true,
        defaultVisible: true,
      },
    ],
    'locations.json': Array.from({ length: 6 }, (_, i) => ({
      id: id('loc', String(i + 1)),
      mapId: id('map', 'island'),
      layerId: id('layer', 'island'),
      x: 200 + i * 300,
      y: 300 + (i % 3) * 400,
      categoryId: id('cat', 'c'),
      regionId: null,
      name: `Beacon ${i + 1}`,
      entityIds: [],
      guideId: null,
      since: '1.0.0',
    })),
    ...Object.fromEntries(
      ['regions', 'entities', 'checklists', 'checklistItems', 'guides', 'links', 'presets'].map(
        (name) => [`${name}.json`, []],
      ),
    ),
  };
}

/** A plain 256 px PNG tile. */
function tilePng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256, 0);
  header.writeUInt32BE(256, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + 256 * 3);
  for (let x = 0; x < 256; x++) row.set([90, 140, 100], 1 + x * 3);
  const rows = Buffer.concat(Array.from({ length: 256 }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Stands in for the shell's download commands. Each snapshot poll moves a
 * running job on by `step` images; `__mockShell` lets the test steer it.
 * `downloads` is what the shell says in `desktop_info`: whether it was built
 * with downloads.
 */
function installFakeShell(downloads: boolean) {
  interface Job {
    packId: string;
    detail: string;
    state: string;
    reason: string | null;
    maps: { mapId: string; name: string; done: number; total: number }[];
    done: number;
    total: number;
    saved: number;
    missing: number;
    failed: number;
    bytes: number;
    tilesPerSecond: number;
    bytesPerSecond: number;
    secondsLeft: number | null;
    statusRevision: number;
  }
  const totals: Record<string, [number, number]> = {
    standard: [12, 4],
    full: [60, 20],
  };
  const shell = {
    job: null as Job | null,
    step: 4,
    /** Stop the job with this reason on the next poll. */
    failNext: null as string | null,
    /** Hold the job where it is. */
    hold: false,
    calls: [] as string[],
  };
  (window as unknown as { __mockShell: typeof shell }).__mockShell = shell;
  const snapshot = () => (shell.job ? structuredClone(shell.job) : null);
  const plan = () => ({
    packId: 'remote',
    options: Object.entries(totals).map(([detail, [island, cave]]) => ({
      detail,
      tiles: island + cave,
      remaining: island + cave,
      estimatedSeconds: (island + cave) * 0.225,
      estimatedBytes: (island + cave) * 31_000,
      installed:
        shell.job?.state === 'done' && (detail === 'standard' || shell.job.detail === 'full'),
    })),
    recommended: 'standard',
    unfinished: null,
    job: snapshot(),
    busyWith: null,
    queue: [],
  });
  const advance = () => {
    const job = shell.job;
    if (job?.state !== 'running' || shell.hold) return;
    if (shell.failNext) {
      job.state = 'stopped';
      job.reason = shell.failNext;
      job.secondsLeft = null;
      shell.failNext = null;
      return;
    }
    for (let i = 0; i < shell.step && job.done < job.total; i++) {
      const map = job.maps.find((m) => m.done < m.total)!;
      map.done++;
      job.done++;
      job.saved++;
      job.bytes += 31_000;
    }
    job.tilesPerSecond = 4.2;
    job.bytesPerSecond = 130_000;
    job.secondsLeft = (job.total - job.done) / 4.2;
    // The first level is ready a third of the way in.
    if (job.done >= job.total / 3 && job.statusRevision === 0) job.statusRevision = 1;
    if (job.done === job.total) {
      job.state = 'done';
      job.statusRevision++;
      job.secondsLeft = null;
    }
  };
  const invoke = (command: string, args: Record<string, unknown> = {}) => {
    shell.calls.push(command);
    switch (command) {
      case 'tiles_plan':
        return Promise.resolve(plan());
      case 'tiles_snapshot':
        advance();
        return Promise.resolve(snapshot());
      case 'tiles_start': {
        const detail = args.detail as string;
        const [island, cave] = totals[detail]!;
        shell.job = {
          packId: 'remote',
          detail,
          state: 'running',
          reason: null,
          maps: [
            { mapId: 'remote:map:island', name: 'Island', done: 0, total: island },
            { mapId: 'remote:map:cave', name: 'Cave', done: 0, total: cave },
          ],
          done: 0,
          total: island + cave,
          saved: 0,
          missing: 0,
          failed: 0,
          bytes: 0,
          tilesPerSecond: 0,
          bytesPerSecond: 0,
          secondsLeft: (island + cave) * 0.225,
          statusRevision: shell.job?.statusRevision ?? 0,
        };
        return Promise.resolve(snapshot());
      }
      case 'tiles_pause':
      case 'tiles_resume':
        // Tauri rejects with the command's error value, a string.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        if (!shell.job) return Promise.reject('This pack is not downloading.');
        shell.job.state = command === 'tiles_pause' ? 'paused' : 'running';
        return Promise.resolve(snapshot());
      case 'tiles_cancel':
        if (shell.job) shell.job.state = 'cancelled';
        return Promise.resolve(null);
      case 'desktop_info':
        return Promise.resolve({ name: 'Atlas', version: '0.0.0', platform: 'test', downloads });
      // The pack comes from the index, as a bundled pack would; no other folders.
      case 'library_list':
        return Promise.resolve({
          mapsFolder: { path: '/maps', isDefault: true, exists: true },
          packs: [],
          hidden: [],
          locations: [],
          busy: [],
        });
      case 'download_settings_get':
        return Promise.resolve({
          settings: {
            parallel: 2,
            pauseMs: 250,
            requestsPerMinute: null,
            kilobytesPerSecond: null,
          },
          bounds: {
            parallel: [1, 4],
            pauseMs: [100, 5000],
            requestsPerMinute: [10, 600],
            kilobytesPerSecond: [50, 50000],
          },
        });
      default:
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(`Unknown command ${command}`);
    }
  };
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
}

async function servePack(page: Page, levelsReady: () => number | null) {
  const files = remotePack();
  const png = tilePng();
  const cors = { 'access-control-allow-origin': '*' };
  await page.route('**/packs/index.json', (route) =>
    route.fulfill({
      json: { packs: [{ id: 'remote', url: PACK_URL, title: 'Remote test pack' }] },
    }),
  );
  await page.route(`${PACK_URL}**`, (route) => {
    const name = new URL(route.request().url()).pathname.slice('/remote/'.length);
    const top = levelsReady();
    const status = /^offline-tiles\/(island|cave)\.json$/.exec(name);
    if (status && top !== null) {
      return route.fulfill({
        headers: cors,
        json: {
          format: 'atlas-tile-status',
          version: 1,
          layerId: `remote:layer:${status[1]}`,
          levels: Array.from({ length: top + 1 }, (_, z) => z),
          nativeMinZoom: 0,
          nativeMaxZoom: top,
          complete: false,
          updatedAt: Date.now(),
        },
      });
    }
    if (name.startsWith('tiles/') && top !== null) {
      return route.fulfill({ headers: { ...cors, 'content-type': 'image/png' }, body: png });
    }
    const body = files[name];
    return body === undefined
      ? route.fulfill({ status: 404, headers: cors, body: 'not found' })
      : route.fulfill({ headers: cors, json: body });
  });
}

const shell = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __mockShell: { job: { state: string } | null } }).__mockShell;
    return s.job?.state ?? null;
  });

const shellCalls = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __mockShell: { calls: string[] } }).__mockShell.calls,
  );

/** The map shows the plain notice, with no way to download or save map images. */
async function expectNoDownloads(page: Page) {
  const notice = page.getByTestId('tile-notice');
  await expect(notice).toHaveText(
    'Map image not installed. Markers are shown on a plain background.',
  );
  await expect(page.getByTestId('download-map-images')).toHaveCount(0);
  await expect(page.getByTestId('map-images-button')).toHaveCount(0);
  await expect(page.getByTestId('download-panel')).toHaveCount(0);
  await expect(page.getByTestId('marker-count')).toHaveText('6');
  const calls = await shellCalls(page);
  expect(calls).toContain('desktop_info');
  expect(calls.filter((call) => /^(tiles_|download_settings_|view_)/.test(call))).toEqual([]);
}

test('downloads map images from the notice, with pause, errors and progress', async ({ page }) => {
  test.skip(!DOWNLOADS_BUILD, 'only a build with ATLAS_ENABLE_DOWNLOADS=1 downloads map images');
  await mkdir(SHOTS, { recursive: true });
  const errors = collectErrors(page);
  let levelsReady: number | null = null;
  await page.addInitScript(installFakeShell, true);
  await servePack(page, () => levelsReady);
  await page.goto('./');

  // Before: no map image, and the notice offers the download.
  const notice = page.getByTestId('tile-notice');
  await expect(notice).toContainText('Map image not installed');
  const download = page.getByTestId('download-map-images');
  await expect(download).toHaveText('Download map images');
  await page.screenshot({ path: `${SHOTS}/1-before.png` });

  // The detail choice, with sizes.
  await download.click();
  const panel = page.getByTestId('download-panel');
  await expect(panel).toHaveAttribute('data-state', 'choose');
  await expect(panel.getByRole('radio', { name: /Standard/ })).toBeChecked();
  await expect(panel.getByTestId('detail-standard')).toHaveText(
    '16 images · about 496 KB · less than a minute',
  );
  await expect(panel.getByTestId('detail-full')).toContainText('80 images');
  await expect(panel).toContainText('from tiles.example.com');
  await expect(notice).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/2-choose.png` });

  // An error stops the job with the shell's reason.
  await page.evaluate(() => {
    (window as unknown as { __mockShell: { failNext: string } }).__mockShell.failNext =
      'The map image server refused access (HTTP 403), so the download stopped.';
  });
  await panel.getByTestId('start-download').click();
  await expect(panel).toHaveAttribute('data-state', 'stopped');
  await expect(panel.getByRole('alert')).toContainText('refused access (HTTP 403)');
  await page.screenshot({ path: `${SHOTS}/3-error.png` });

  // Try again: the job runs, with progress per map.
  await page.evaluate(() => {
    const s = (window as unknown as { __mockShell: { step: number } }).__mockShell;
    s.step = 2;
  });
  await panel.getByRole('button', { name: 'Try again' }).click();
  await expect(panel).toHaveAttribute('data-state', 'running');
  await expect(panel.getByTestId('download-rate')).toContainText('4.2 images/s');
  await expect(panel.getByRole('progressbar', { name: 'Island' })).toBeVisible();
  await expect(panel.getByRole('progressbar', { name: 'Cave' })).toBeVisible();

  // When the first levels are ready the map shows them while the rest downloads.
  levelsReady = 1;
  await expect(page.locator('.atlas-tiles img').first()).toBeVisible();
  await expect(page.getByTestId('tile-notice')).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/4-progress.png` });

  // Pause and resume.
  await panel.getByTestId('pause-download').click();
  await expect(panel).toHaveAttribute('data-state', 'paused');
  await expect(panel).toContainText('Paused');
  await page.screenshot({ path: `${SHOTS}/5-paused.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SHOTS}/5-paused-narrow.png` });
  await page.setViewportSize({ width: 1280, height: 800 });

  // Hidden, the panel leaves a button that shows the progress.
  await panel.getByRole('button', { name: 'Close' }).click();
  const chip = page.getByTestId('map-images-button');
  await expect(chip).toContainText('(paused)');
  await chip.click();
  await page.evaluate(() => {
    (window as unknown as { __mockShell: { step: number } }).__mockShell.step = 4;
  });
  await panel.getByTestId('resume-download').click();
  await expect(panel).toHaveAttribute('data-state', 'done', { timeout: 15_000 });
  levelsReady = 2;
  await expect(panel.getByTestId('download-summary')).toContainText('16 images downloaded');
  await page.screenshot({ path: `${SHOTS}/6-done.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SHOTS}/6-done-narrow.png` });
  await page.setViewportSize({ width: 1280, height: 800 });

  // More detail later; cancelling asks first and keeps the panel usable.
  await panel.getByRole('button', { name: 'Download more detail…' }).click();
  await expect(panel).toHaveAttribute('data-state', 'choose');
  await expect(panel.getByRole('radio', { name: /Full detail/ })).toBeChecked();
  await panel.getByTestId('start-download').click();
  await expect(panel).toHaveAttribute('data-state', 'running');
  await page.evaluate(() => {
    (window as unknown as { __mockShell: { hold: boolean } }).__mockShell.hold = true;
  });
  await panel.getByTestId('cancel-download').click();
  await expect(panel).toContainText('The images downloaded so far are kept.');
  await panel.getByRole('button', { name: 'Cancel download' }).click();
  await expect.poll(() => shell(page)).toBe('cancelled');
  await expect(panel).toHaveAttribute('data-state', 'choose');

  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
});

test('the plain web app offers no download', async ({ page }) => {
  const errors = collectErrors(page);
  await servePack(page, () => null);
  await page.goto('./');
  await expect(page.getByTestId('tile-notice')).toContainText('Map image not installed');
  await expect(page.getByTestId('download-map-images')).toHaveCount(0);
  await expect(page.getByTestId('map-images-button')).toHaveCount(0);
  // Without the shell no status file is asked for: the only 404 is the tile probe.
  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
  expect(errors.length).toBeLessThanOrEqual(1);
});

test('a shell without downloads offers none', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(installFakeShell, false);
  await servePack(page, () => null);
  await page.goto('./');
  await expectNoDownloads(page);
  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
});

test('a build without downloads offers none, even in a shell that has them', async ({ page }) => {
  test.skip(DOWNLOADS_BUILD, 'checks a build without ATLAS_ENABLE_DOWNLOADS');
  const errors = collectErrors(page);
  await page.addInitScript(installFakeShell, true);
  await servePack(page, () => null);
  await page.goto('./');
  await expectNoDownloads(page);
  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
});
