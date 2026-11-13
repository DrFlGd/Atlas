import { mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { expect, test } from './layout';
import { downloadsEnabled } from '../tooling/buildFlags.ts';
import { collectErrors, selectByName } from './helpers';

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
/** Where the photo screenshots go: ATLAS_PHOTO_SHOTS, or beside the other test results. */
const PHOTO_SHOTS = process.env.ATLAS_PHOTO_SHOTS ?? 'test-results/photos';

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
      // The first two have a photo listed to be fetched later.
      ...(i < 2 ? { photos: [{ picture: id('picture', `beacon-${i + 1}`) }] } : {}),
    })),
    'pictures.json': [1, 2].map((n) => ({
      id: id('picture', `beacon-${n}`),
      file: `pictures/beacon-${n}.jpg`,
      caption: `Beacon ${n} at noon`,
      credit: 'Example photo site',
      remote: `https://photos.example.com/beacon-${n}.jpg`,
      shareable: false,
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
    notAsked: number;
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
    /** The map page window: its saved images make `revision` go up. */
    view: { open: false, revision: 0 },
    /** The "Download location photos" job: one photo a poll. */
    photos: null as Job | null,
  };
  (window as unknown as { __mockShell: typeof shell }).__mockShell = shell;
  // Set by a test before this script: the pack is also listed as one added from a web page.
  const listed = (window as unknown as { __listRemote?: boolean }).__listRemote === true;
  const viewStatus = () => ({
    open: shell.view.open,
    packId: shell.view.open ? 'remote' : null,
    url: shell.view.open ? 'https://maps.example.com/remote/island' : null,
    saving: shell.view.open,
    savedSession: shell.view.open,
    counts: {
      saved: 0,
      alreadyHad: 0,
      notOnServer: 0,
      notSaved: 0,
      fromElements: 0,
      otherProblems: 0,
      bytes: 0,
    },
    usesWorkers: false,
    revision: shell.view.revision,
    message: null,
  });
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
          notAsked: 0,
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
      case 'photos_plan': {
        const job = shell.photos;
        const saved = job ? job.done : 0;
        return Promise.resolve({
          packId: 'remote',
          total: 2,
          remaining: 2 - saved,
          hosts: ['photos.example.com'],
          job: job ? structuredClone(job) : null,
          busyWith: null,
        });
      }
      case 'photos_start':
        shell.photos = {
          packId: 'remote#photos',
          detail: 'full',
          state: 'running',
          reason: null,
          maps: [],
          done: 0,
          total: 2,
          saved: 0,
          missing: 0,
          notAsked: 0,
          failed: 0,
          bytes: 0,
          tilesPerSecond: 0,
          bytesPerSecond: 0,
          secondsLeft: null,
          statusRevision: 0,
        };
        return Promise.resolve(structuredClone(shell.photos));
      case 'photos_snapshot': {
        const job = shell.photos;
        if (job?.state === 'running' && !shell.hold) {
          job.done++;
          job.saved++;
          job.bytes += 84_000;
          job.statusRevision++;
          if (job.done === job.total) job.state = 'done';
        }
        return Promise.resolve(job ? structuredClone(job) : null);
      }
      case 'photos_pause':
      case 'photos_resume':
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        if (!shell.photos) return Promise.reject('The photos are not downloading.');
        shell.photos.state = command === 'photos_pause' ? 'paused' : 'running';
        return Promise.resolve(structuredClone(shell.photos));
      case 'photos_cancel':
        if (shell.photos) shell.photos.state = 'cancelled';
        return Promise.resolve(null);
      case 'desktop_info':
        return Promise.resolve({ name: 'Atlas', version: '0.0.0', platform: 'test', downloads });
      // The pack comes from the index, as a bundled pack would; no other folders.
      case 'library_list':
        return Promise.resolve({
          mapsFolder: { path: '/maps', isDefault: true, exists: true },
          packs: listed
            ? [
                {
                  id: 'remote',
                  title: 'Remote test pack',
                  url: 'http://atlas-pack.localhost/remote/',
                  origin: 'maps-folder',
                  path: '/maps/remote',
                  packVersion: '1.0.0',
                  bundled: false,
                  imported: { importerId: 'demo', importerTitle: 'Demo map site' },
                },
              ]
            : [],
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
      case 'view_pages':
        return Promise.resolve({
          pages: [
            {
              url: 'https://maps.example.com/remote/island',
              mapId: 'remote:map:island',
              mapName: 'Island',
              importedAt: null,
            },
          ],
          canSave: true,
          saveNote: null,
        });
      case 'view_open':
        shell.view.open = true;
        return Promise.resolve(viewStatus());
      case 'view_status':
        return Promise.resolve(viewStatus());
      case 'view_stop_saving':
      case 'view_close':
        shell.view.open = false;
        return Promise.resolve(viewStatus());
      default:
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(`Unknown command ${command}`);
    }
  };
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
}

/**
 * Serves the test pack. `levelsReady` is the top complete level of a
 * download (with its status file), or null; `savedTile` says which single
 * tiles are there without any complete level, as after saving while browsing.
 */
async function servePack(
  page: Page,
  levelsReady: () => number | null,
  savedTile: (name: string) => boolean = () => false,
  photosThere: () => boolean = () => false,
) {
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
    if (name.startsWith('tiles/') && (top !== null || savedTile(name))) {
      return route.fulfill({ headers: { ...cors, 'content-type': 'image/png' }, body: png });
    }
    // A downloaded photo, as the shell stores it (any image does here).
    if (name.startsWith('pictures/') && photosThere()) {
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
  expect(calls.filter((call) => /^(tiles_|download_settings_|view_|photos_)/.test(call))).toEqual(
    [],
  );
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

test('shows map images saved while browsing a map page without a restart', async ({ page }) => {
  test.skip(!DOWNLOADS_BUILD, 'only a build with ATLAS_ENABLE_DOWNLOADS=1 saves map images');
  const errors = collectErrors(page);
  // Which tiles are on disk: none, then every second one, then all.
  let saved: 'none' | 'some' | 'all' = 'none';
  const every2nd = (name: string) => {
    const [, x, y] = /\/(\d+)\/(\d+)\.png$/.exec(name) ?? [];
    return (Number(x) + Number(y)) % 2 === 0;
  };
  await page.addInitScript(() => {
    (window as unknown as { __listRemote: boolean }).__listRemote = true;
  });
  await page.addInitScript(installFakeShell, true);
  await servePack(
    page,
    () => null,
    (name) => saved === 'all' || (saved === 'some' && every2nd(name)),
  );
  await page.goto('./');
  const notice = page.getByTestId('tile-notice');
  await expect(notice).toContainText('Map image not installed');

  // Open the map page with saving on, from the Maps dialog.
  await page.getByTestId('maps-button').click();
  const row = page.locator('[data-testid="pack-row"][data-pack="remote"]');
  await row.getByText('Map page…').click();
  await row.getByTestId('map-page-save').click();
  await expect(page.getByTestId('maps-dialog')).toBeHidden();

  const savedMore = () =>
    page.evaluate(() => {
      (
        window as unknown as { __mockShell: { view: { revision: number } } }
      ).__mockShell.view.revision += 1;
    });
  const tiles = () =>
    page.locator('.atlas-tiles img').evaluateAll((images) => {
      const all = images as HTMLImageElement[];
      return {
        shown: all.filter(
          (img) =>
            img.complete && img.naturalWidth > 0 && getComputedStyle(img).visibility === 'visible',
        ).length,
        broken: all.filter((img) => img.complete && img.naturalWidth === 0).length,
        loading: all.filter((img) => !img.complete).length,
      };
    });

  // The first images arrive: the map shows them although it had none when it started.
  saved = 'some';
  await savedMore();
  await expect(notice).toHaveCount(0);
  await expect.poll(async () => (await tiles()).shown).toBeGreaterThan(0);

  // Zoomed in, every second image is still missing.
  await page.locator('.leaflet-control-zoom-in').click();
  await page.locator('.leaflet-control-zoom-in').click();
  await page.locator('.leaflet-control-zoom-in').click();
  await page.locator('.leaflet-control-zoom-in').click();
  await expect.poll(async () => (await tiles()).loading).toBe(0);
  const before = await tiles();
  expect(before.broken).toBeGreaterThan(0);

  // The rest arrive: the missing ones are asked for again and fill in.
  saved = 'all';
  await savedMore();
  await expect
    .poll(async () => {
      const now = await tiles();
      return now.broken + now.loading;
    })
    .toBe(0);
  expect((await tiles()).shown).toBeGreaterThan(before.shown);

  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
});

test.describe('location photos', () => {
  test.use({ deviceScaleFactor: 2 });

  test('downloads the location photos a pack lists, from the Maps dialog', async ({ page }) => {
    test.skip(!DOWNLOADS_BUILD, 'only a build with ATLAS_ENABLE_DOWNLOADS=1 downloads photos');
    await mkdir(PHOTO_SHOTS, { recursive: true });
    const errors = collectErrors(page);
    let photosThere = false;
    await page.addInitScript(() => {
      (window as unknown as { __listRemote: boolean }).__listRemote = true;
    });
    await page.addInitScript(installFakeShell, true);
    await servePack(
      page,
      () => null,
      () => false,
      () => photosThere,
    );
    await page.goto('./');
    await expect(page.getByTestId('tile-notice')).toContainText('Map image not installed');

    // Before: the location card says its photo is not downloaded, and nothing was asked for.
    await selectByName(page, 'Beacon 1');
    const missing = page.getByTestId('photo-missing');
    await expect(missing).toHaveText('Photo not downloaded');
    expect((await shellCalls(page)).filter((call) => call.startsWith('photos_'))).toEqual([]);

    // The Maps dialog offers it per game; nothing is fetched until asked.
    await page.getByTestId('maps-button').click();
    const row = page.locator('[data-testid="pack-row"][data-pack="remote"]');
    const photos = row.getByTestId('photo-download');
    await photos.getByText('Location photos…').click();
    await expect(photos.getByTestId('photo-download-plan')).toHaveText(
      '2 photos listed, 2 not on this device yet.',
    );
    await expect(photos).toContainText('From photos.example.com.');
    const start = photos.getByTestId('download-photos');
    await expect(start).toHaveText('Download location photos');
    await page.screenshot({ path: `${PHOTO_SHOTS}/7-download-photos.png` });
    expect(await shellCalls(page)).not.toContain('photos_start');

    // Paused and resumed, then done.
    await page.evaluate(() => {
      (window as unknown as { __mockShell: { hold: boolean } }).__mockShell.hold = true;
    });
    photosThere = true;
    await start.click();
    await expect(photos.getByTestId('photo-job')).toHaveAttribute('data-state', 'running');
    await photos.getByTestId('photos-pause').click();
    await expect(photos.getByTestId('photo-job')).toHaveAttribute('data-state', 'paused');
    await expect(photos).toContainText('Paused. Nothing is downloaded until you resume.');
    await page.evaluate(() => {
      (window as unknown as { __mockShell: { hold: boolean } }).__mockShell.hold = false;
    });
    await photos.getByTestId('photos-resume').click();
    await expect(photos.getByTestId('photo-job')).toHaveAttribute('data-state', 'done');
    await expect(photos.getByTestId('photo-download-summary')).toContainText('2 photos downloaded');
    await expect(photos.getByTestId('photo-download-plan')).toHaveText(
      '2 photos listed, all on this device.',
    );
    await expect(start).toHaveCount(0);
    await page.screenshot({ path: `${PHOTO_SHOTS}/8-download-photos-done.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${PHOTO_SHOTS}/8-download-photos-done-narrow.png` });
    await page.setViewportSize({ width: 1280, height: 800 });

    // The location card shows the photo now, without a restart.
    await page.keyboard.press('Escape');
    await expect(missing).toHaveCount(0);
    const img = page.getByTestId('photo').locator('img');
    await expect(img).toHaveAttribute('alt', 'Beacon 1 at noon');
    await expect
      .poll(() => img.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
    expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
  });
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
  await page.addInitScript(() => {
    (window as unknown as { __listRemote: boolean }).__listRemote = true;
  });
  await page.addInitScript(installFakeShell, true);
  await servePack(page, () => null);
  await page.goto('./');
  await expectNoDownloads(page);
  // No "Download location photos" either.
  await page.getByTestId('maps-button').click();
  await expect(page.locator('[data-testid="pack-row"][data-pack="remote"]')).toBeVisible();
  await expect(page.getByTestId('photo-download')).toHaveCount(0);
  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
});

test.describe('in the standard layout', () => {
  test.use({ layout: 'standard' });

  test('downloads map images, and saves them from a map page opened from Games', async ({
    page,
  }) => {
    test.skip(!DOWNLOADS_BUILD, 'only a build with ATLAS_ENABLE_DOWNLOADS=1 downloads map images');
    const errors = collectErrors(page);
    await page.addInitScript(() => {
      (window as unknown as { __listRemote: boolean }).__listRemote = true;
    });
    await page.addInitScript(installFakeShell, true);
    await servePack(page, () => null);
    await page.goto('./');
    await expect(page.locator('.touch')).toHaveAttribute('data-input', 'mouse');

    // The notice over the map offers the download; the panel is the classic one.
    await expect(page.getByTestId('tile-notice')).toContainText('Map image not installed');
    await page.getByTestId('download-map-images').click();
    const panel = page.getByTestId('download-panel');
    await expect(panel).toHaveAttribute('data-state', 'choose');
    await panel.getByTestId('start-download').click();
    await expect(panel).toHaveAttribute('data-state', 'running');
    await panel.getByRole('button', { name: 'Close' }).click();
    const chip = page.getByTestId('map-images-button');
    await expect(chip).toBeVisible();
    // Clear of the button beside it.
    const a = (await chip.boundingBox())!;
    const b = (await page.getByTestId('nearest-unfound').boundingBox())!;
    expect(a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    await chip.click();
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Close' }).click();

    // "View map page and save images as I browse", in the Maps dialog from Games.
    await page.getByTestId('section-games').click();
    await page.getByTestId('maps-button').click();
    const row = page.locator('[data-testid="pack-row"][data-pack="remote"]');
    await row.getByText('Map page…').click();
    await row.getByTestId('map-page-save').click();
    await expect(page.getByTestId('maps-dialog')).toBeHidden();
    await expect(page.getByTestId('map-page-status')).toBeVisible();
    expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
  });

  test('a shell without downloads offers none', async ({ page }) => {
    const errors = collectErrors(page);
    await page.addInitScript(installFakeShell, false);
    await servePack(page, () => null);
    await page.goto('./');
    await expect(page.locator('.touch')).toBeVisible();
    await expectNoDownloads(page);
    expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
  });

  test('a build without downloads offers none, even in a shell that has them', async ({ page }) => {
    test.skip(DOWNLOADS_BUILD, 'checks a build without ATLAS_ENABLE_DOWNLOADS');
    const errors = collectErrors(page);
    await page.addInitScript(installFakeShell, true);
    await servePack(page, () => null);
    await page.goto('./');
    await expect(page.locator('.touch')).toBeVisible();
    await expectNoDownloads(page);
    await page.getByTestId('section-games').click();
    await page.getByTestId('maps-button').click();
    await expect(page.getByTestId('maps-dialog')).toBeVisible();
    await expect(page.getByTestId('map-page')).toHaveCount(0);
    expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
  });
});
