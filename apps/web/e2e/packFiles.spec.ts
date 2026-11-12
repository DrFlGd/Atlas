import type { Page } from '@playwright/test';
import { expect, test } from './layout';
import { collectErrors } from './helpers';

/**
 * Map pack files in the desktop app: "Export…" and "Details" on a game in
 * the Maps dialog, and "Import map pack file…". A stand-in shell answers
 * the commands with made-up facts about the demo pack; it writes and reads
 * no files. The real files are covered by the shell's own tests.
 */

interface Job {
  kind: 'export' | 'import';
  packId: string;
  title: string;
  entriesDone: number;
  entriesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  cancelling: boolean;
}

interface PackShell {
  /** The export waits until this is false or it is cancelled. */
  hold: boolean;
  /** Saving the progress export beside the file fails. */
  progressFails: boolean;
  exports: { id: string; detail: string; progress: string | null }[];
  imports: { path: string; replace: boolean }[];
  /** What the next "Import map pack file…" picks. */
  pick: unknown;
  job: Job | null;
  /** The demo pack is in the maps folder (after an import). */
  imported: boolean;
}

function installPackShell() {
  const shell: PackShell = {
    hold: false,
    progressFails: false,
    exports: [],
    imports: [],
    pick: null,
    job: null,
    imported: false,
  };
  (window as unknown as { __packShell: PackShell }).__packShell = shell;
  const demoUrl = new URL('packs/demo/', window.location.href).href;
  const listing = () => ({
    mapsFolder: { path: '/home/test/Atlas/Maps', isDefault: true, exists: true },
    packs: shell.imported
      ? [
          {
            id: 'demo',
            title: 'Atlas demo world',
            url: demoUrl,
            origin: 'maps-folder',
            path: '/home/test/Atlas/Maps/demo',
            packVersion: '1.0.0',
            bundled: true,
            imported: null,
          },
        ]
      : [],
    hidden: [],
    locations: [],
    busy: [],
  });
  const contents = {
    maps: 2,
    layers: 3,
    locations: 5000,
    categories: 6,
    regions: 4,
    checklists: 1,
    guides: 1,
  };
  const header = (detail: string, images: number) => ({
    format: 'atlas-pack-file',
    version: 1,
    packId: 'demo',
    title: 'Atlas demo world',
    packVersion: '1.0.0',
    detail,
    exportedAt: '2026-11-11T09:30:00Z',
    exportedBy: { name: 'Atlas', version: '0.0.0', platform: 'test' },
    pack: {
      id: 'demo',
      title: 'Atlas demo world',
      packVersion: '1.0.0',
      schemaVersion: 2,
      attribution: [],
    },
    source: {
      kind: 'web-pages',
      importer: { id: 'demo-maps', title: 'Demo map site' },
      pages: [{ url: 'https://maps.example.com/demo-maps/demo/world' }],
      newestPageAt: '2026-11-01T10:00:00.000Z',
      oldestPageAt: '2026-11-01T10:00:00.000Z',
    },
    contents,
    images: {
      detail,
      files: images,
      bytes: images * 6000,
      layers: [
        {
          id: 'demo:layer:world',
          name: 'Surface',
          mapName: 'World',
          minZoom: 0,
          maxZoom: 4,
          levels: [0, 1],
          files: images,
          bytes: images * 6000,
          complete: true,
          full: false,
          downloadable: true,
          downloadedAt: '2026-11-02T08:00:00.000Z',
        },
      ],
    },
    files: images + 8,
    bytes: images * 6000 + 40_000,
  });
  /** Runs a job that counts up every 50 ms; it ends when done (and not held) or cancelled. */
  const run = <T>(kind: Job['kind'], total: number, done: () => T) =>
    new Promise<T>((resolve, reject) => {
      shell.job = {
        kind,
        packId: 'demo',
        title: 'Atlas demo world',
        entriesDone: 0,
        entriesTotal: total,
        bytesDone: 0,
        bytesTotal: total * 6000,
        cancelling: false,
      };
      const timer = window.setInterval(() => {
        const job = shell.job!;
        if (job.cancelling) {
          window.clearInterval(timer);
          shell.job = null;
          // Tauri rejects with the command's error value, a string.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject('Cancelled. Nothing was written.');
          return;
        }
        job.entriesDone = Math.min(total, job.entriesDone + 2);
        job.bytesDone = job.entriesDone * 6000;
        if (job.entriesDone === total && !shell.hold) {
          window.clearInterval(timer);
          shell.job = null;
          resolve(done());
        }
      }, 50);
    });
  const invoke = (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case 'desktop_info':
        return Promise.resolve({ name: 'Atlas', version: '0.0.0', platform: 'test' });
      case 'library_list':
        return Promise.resolve(listing());
      case 'packfile_options':
        return Promise.resolve({
          packId: 'demo',
          title: 'Atlas demo world',
          exportable: true,
          reason: null,
          details: [
            {
              detail: 'overview',
              available: true,
              reason: null,
              images: 18,
              imageBytes: 108_000,
              bytes: 150_000,
            },
            {
              detail: 'standard',
              available: true,
              reason: null,
              images: 340,
              imageBytes: 2_040_000,
              bytes: 2_100_000,
            },
            {
              detail: 'full',
              available: false,
              reason: 'Not downloaded: Surface (World).',
              images: 5400,
              imageBytes: 32_400_000,
              bytes: 32_500_000,
            },
          ],
          wholeLayers: [],
          defaultNames: {
            overview: 'demo-overview.atlaspack',
            standard: 'demo-standard.atlaspack',
            full: 'demo-full.atlaspack',
          },
          downloading: false,
        });
      case 'packfile_export': {
        const detail = args.detail as string;
        const progress = (args.progress as string | null) ?? null;
        shell.exports.push({ id: args.id as string, detail, progress });
        const images = detail === 'overview' ? 18 : 340;
        const path = `/home/test/Exports/demo-${detail}.atlaspack`;
        return run('export', 20, () => ({
          path,
          fileName: `demo-${detail}.atlaspack`,
          size: images * 6000 + 20_000,
          header: header(detail, images),
          progressFile:
            progress !== null && !shell.progressFails
              ? `/home/test/Exports/demo-${detail}.progress.json`
              : null,
          progressError:
            progress !== null && shell.progressFails
              ? `Your progress could not be saved beside it (demo-${detail}.progress.json): Permission denied`
              : null,
        }));
      }
      case 'packfile_pick':
        return Promise.resolve(shell.pick);
      case 'packfile_import': {
        const request = { path: args.path as string, replace: args.replace as boolean };
        shell.imports.push(request);
        return run('import', 20, () => {
          shell.imported = true;
          return {
            packId: 'demo',
            title: 'Atlas demo world',
            replaced: request.replace,
            header: header('standard', 340),
            listing: listing(),
          };
        });
      }
      case 'packfile_progress':
        return Promise.resolve(shell.job ? { ...shell.job } : null);
      case 'packfile_cancel':
        if (shell.job) shell.job.cancelling = true;
        return Promise.resolve(null);
      case 'library_pack_details':
        return Promise.resolve({
          pack: header('standard', 340).pack,
          source: shell.imported ? header('standard', 340).source : { kind: 'app', pages: [] },
          contents,
          layers: [
            {
              id: 'demo:layer:world',
              name: 'Surface',
              mapName: 'World',
              minZoom: 0,
              maxZoom: 4,
              downloadable: true,
              levels: [0, 1, 2],
              downloadedAt: '2026-11-05T08:00:00.000Z',
            },
          ],
          detail: 'standard',
          imagesAt: '2026-11-05T08:00:00.000Z',
          archive: false,
          packFile: shell.imported
            ? {
                importedAt: '2026-11-11T10:00:00Z',
                fileName: 'demo-standard.atlaspack',
                header: header('standard', 340),
              }
            : null,
        });
      default:
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(`Unknown command ${command}`);
    }
  };
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
}

const packShell = (page: Page) =>
  page.evaluate(() => (window as unknown as { __packShell: PackShell }).__packShell);

const setShell = (page: Page, patch: Partial<PackShell>) =>
  page.evaluate((patch) => {
    Object.assign((window as unknown as { __packShell: PackShell }).__packShell, patch);
  }, patch);

/** A picked file of the demo pack whose pages were read at `pagesAt`, with the demo pack that comes with the app installed. */
function pickedFile(pagesAt: string) {
  const installedPagesAt = '2026-11-01T10:00:00.000Z';
  const source = (at: string) => ({
    kind: 'web-pages',
    importer: { id: 'demo-maps', title: 'Demo map site' },
    pages: [{ url: 'https://maps.example.com/demo-maps/demo/world' }],
    newestPageAt: at,
    oldestPageAt: at,
  });
  const pack = {
    id: 'demo',
    title: 'Atlas demo world',
    packVersion: '1.0.0',
    schemaVersion: 2,
    attribution: [],
  };
  const contents = {
    maps: 2,
    layers: 3,
    locations: 5000,
    categories: 6,
    regions: 4,
    checklists: 1,
    guides: 1,
  };
  return {
    path: '/home/test/Downloads/demo-standard.atlaspack',
    fileName: 'demo-standard.atlaspack',
    size: 2_100_000,
    header: {
      format: 'atlas-pack-file',
      version: 1,
      packId: 'demo',
      title: 'Atlas demo world',
      packVersion: '1.0.0',
      detail: 'standard',
      exportedAt: '2026-11-11T09:30:00Z',
      exportedBy: { name: 'Atlas', version: '0.0.0', platform: 'windows' },
      pack,
      source: source(pagesAt),
      contents,
      images: {
        detail: 'standard',
        files: 340,
        bytes: 2_040_000,
        layers: [
          {
            id: 'demo:layer:world',
            name: 'Surface',
            mapName: 'World',
            minZoom: 0,
            maxZoom: 4,
            levels: [0, 1, 2],
            files: 340,
            bytes: 2_040_000,
            complete: true,
            full: false,
            downloadable: true,
            downloadedAt: '2026-11-02T08:00:00.000Z',
          },
        ],
      },
      files: 348,
      bytes: 2_080_000,
    },
    installed: {
      title: 'Atlas demo world',
      origin: 'bundled',
      folder: null,
      details: {
        pack,
        source: source(installedPagesAt),
        contents,
        layers: [],
        detail: 'full',
        imagesAt: '2026-11-03T08:00:00.000Z',
        archive: false,
        packFile: null,
      },
    },
    replaces: false,
    blocked: null,
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installPackShell);
  await page.goto('./');
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
});

test('exports a game at a chosen detail, with progress beside it when asked', async ({ page }) => {
  const errors = collectErrors(page);
  await page.getByTestId('maps-button').click();
  const row = page.locator('[data-testid="pack-row"][data-pack="demo"]');
  await row.getByTestId('export-pack').click();

  const dialog = page.getByTestId('pack-file-dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Export Atlas demo world');
  await expect(dialog).toContainText('Atlas for Android');
  await expect(dialog).toContainText('It never holds your progress.');
  await expect(dialog.getByTestId('export-overview')).toHaveText('18 map images · about 150 KB');
  await expect(dialog.getByTestId('export-full')).toHaveText('Not downloaded: Surface (World).');
  await expect(dialog.locator('input[value="full"]')).toBeDisabled();
  // The most detail there is is chosen; progress is not saved unless asked for.
  await expect(dialog.locator('input[value="standard"]')).toBeChecked();
  const withProgress = dialog.getByTestId('export-with-progress');
  await expect(withProgress).not.toBeChecked();

  // Cancelled while it is written: nothing is saved, and it can start again.
  await setShell(page, { hold: true });
  await dialog.getByTestId('export-start').click();
  await expect(dialog.getByTestId('pack-file-progress')).toContainText(/of 20 files/);
  await dialog.getByTestId('pack-file-cancel').click();
  await expect(dialog.getByTestId('pack-file-error')).toHaveText('Cancelled. Nothing was written.');
  await expect(dialog.getByTestId('export-start')).toBeEnabled();

  // At overview detail, with the progress export beside it.
  await setShell(page, { hold: false });
  await dialog.locator('input[value="overview"]').check();
  await withProgress.check();
  await dialog.getByTestId('export-start').click();
  await expect(dialog.getByTestId('export-result')).toContainText(
    'Saved demo-overview.atlaspack (128 KB): 18 map images at overview detail.',
  );
  await expect(dialog).toContainText('/home/test/Exports/demo-overview.atlaspack');
  const dates = dialog.getByTestId('pack-file-dates');
  await expect(dates).toContainText('data read from the game’s pages on');
  await expect(dates.locator('time').first()).toHaveAttribute('title', '2026-11-01T10:00:00.000Z');
  await expect(dates.locator('time').last()).toHaveAttribute('title', '2026-11-02T08:00:00.000Z');
  await expect(dialog.getByTestId('export-progress-file')).toContainText(
    '/home/test/Exports/demo-overview.progress.json',
  );

  const { exports } = await packShell(page);
  expect(exports.map(({ detail, progress }) => [detail, progress !== null])).toEqual([
    ['standard', false],
    ['overview', true],
  ]);
  // The progress export is the one "Export all profiles" writes.
  const progress = JSON.parse(exports[1]!.progress!) as { scope: string; profiles: unknown[] };
  expect(progress.scope).toBe('all');
  expect(progress.profiles.length).toBeGreaterThan(0);

  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('maps-dialog')).toBeVisible();

  // When the progress cannot be saved, the map pack file still is.
  await setShell(page, { progressFails: true });
  await row.getByTestId('export-pack').click();
  await dialog.getByTestId('export-with-progress').check();
  await dialog.getByTestId('export-start').click();
  await expect(dialog.getByTestId('export-result')).toContainText('Saved demo-standard.atlaspack');
  await expect(dialog.getByTestId('export-progress-error')).toHaveText(
    'The map pack file is saved. Your progress could not be saved beside it (demo-standard.progress.json): Permission denied',
  );
  expect(errors).toEqual([]);
});

test('imports a map pack file, saying which is newer and asking before using older data', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.getByTestId('maps-button').click();
  const dialog = page.getByTestId('pack-file-dialog');

  // Older than the game installed: keeping it is the first choice.
  await setShell(page, { pick: pickedFile('2026-10-20T10:00:00.000Z') });
  await page.getByTestId('import-pack-file').click();
  await expect(dialog.getByRole('heading')).toHaveText('Import map pack file');
  await expect(dialog.getByTestId('import-summary')).toHaveText(
    'Atlas demo world, version 1.0.0: 2 maps, 5,000 places, 1 checklist, 1 guide. 340 map images at standard detail.',
  );
  const compare = dialog.getByTestId('import-compare');
  await expect(compare).toContainText('Atlas demo world, installed now');
  await expect(compare.locator('time[title="2026-10-20T10:00:00.000Z"]')).toBeVisible();
  await expect(compare.locator('time[title="2026-11-01T10:00:00.000Z"]')).toBeVisible();
  const verdict = dialog.getByTestId('import-verdict');
  await expect(verdict).toHaveAttribute('data-verdict', 'installed-newer');
  await expect(verdict).toContainText(
    'The installed game is newer: its data was read from the game’s pages on',
  );
  await expect(dialog.getByTestId('import-start')).toHaveCount(0);
  await dialog.getByTestId('import-older').click();
  await expect(dialog.getByTestId('import-start')).toHaveText('Replace with the older file');
  await dialog.getByRole('button', { name: 'Keep the installed game' }).click();
  await expect(dialog.getByTestId('import-start')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Keep the installed game' }).click();
  await expect(dialog).toBeHidden();
  expect((await packShell(page)).imports).toEqual([]);

  // Newer: imported at once, into the maps folder, and shown.
  await setShell(page, { pick: pickedFile('2026-11-08T10:00:00.000Z') });
  await page.getByTestId('import-pack-file').click();
  await expect(verdict).toHaveAttribute('data-verdict', 'file-newer');
  await expect(verdict).toContainText(
    'This file is newer: its data was read from the game’s pages on',
  );
  await expect(dialog.getByTestId('import-replace-note')).toContainText(
    'Atlas demo world comes with the app. The imported game goes into the maps folder and is shown in its place.',
  );
  await dialog.getByTestId('import-start').click();
  await expect(dialog.getByTestId('import-result')).toHaveText(
    'Imported Atlas demo world. It is in the maps folder and shown now.',
  );
  expect((await packShell(page)).imports).toEqual([
    { path: '/home/test/Downloads/demo-standard.atlaspack', replace: false },
  ]);
  await dialog.getByRole('button', { name: 'Done' }).click();

  // The Maps dialog lists it in the maps folder, with where it came from.
  const row = page.locator('[data-testid="pack-row"][data-pack="demo"]');
  await expect(row).toContainText('Maps folder');
  await row.getByTestId('pack-details-toggle').click();
  const details = row.getByTestId('pack-details');
  await expect(details).toContainText('Read from 1 web page with Demo map site.');
  await expect(details).toContainText('Downloaded at standard detail.');
  await expect(details).toContainText('Imported from demo-standard.atlaspack on');
  await expect(details.locator('time[title="2026-11-11T10:00:00Z"]')).toBeVisible();
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
  expect(errors).toEqual([]);
});

test.describe('in the standard layout', () => {
  test.use({ layout: 'standard' });

  test('exports from Maps and imports from Games', async ({ page }) => {
    const errors = collectErrors(page);
    await page.getByTestId('section-games').click();
    const games = page.getByTestId('games-screen');

    // Export…, in the Maps dialog opened from Games.
    await games.getByTestId('maps-button').click();
    await page
      .locator('[data-testid="pack-row"][data-pack="demo"]')
      .getByTestId('export-pack')
      .click();
    const dialog = page.getByTestId('pack-file-dialog');
    await expect(dialog.getByRole('heading')).toHaveText('Export Atlas demo world');
    await dialog.getByTestId('export-start').click();
    await expect(dialog.getByTestId('export-result')).toContainText(
      'Saved demo-standard.atlaspack',
    );
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('maps-dialog')).toBeHidden();
    expect((await packShell(page)).exports.map((e) => e.detail)).toEqual(['standard']);

    // Import map pack file…, on the Games screen itself.
    await setShell(page, { pick: pickedFile('2026-11-08T10:00:00.000Z') });
    await games.getByTestId('import-pack-file').click();
    await expect(dialog.getByRole('heading')).toHaveText('Import map pack file');
    await expect(dialog.getByTestId('import-verdict')).toHaveAttribute(
      'data-verdict',
      'file-newer',
    );
    await dialog.getByTestId('import-start').click();
    await expect(dialog.getByTestId('import-result')).toHaveText(
      'Imported Atlas demo world. It is in the maps folder and shown now.',
    );
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    expect((await packShell(page)).imports).toEqual([
      { path: '/home/test/Downloads/demo-standard.atlaspack', replace: false },
    ]);
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    expect(errors).toEqual([]);
  });
});
