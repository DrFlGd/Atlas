import { mkdir } from 'node:fs/promises';
import type { Page, Route } from '@playwright/test';
import { realErrors } from './fakeShell';
import { expect, test } from './layout';
import {
  collectErrors,
  libraryMore,
  openLibraryGame,
  ownLocationsText,
  ownListsText,
  selectByName,
  storedSetting,
} from './helpers';

/**
 * Pack files in the desktop app: "Export…" and "Details" on a game in
 * the Maps dialog, and "Import pack file…". A stand-in shell answers
 * the commands with made-up facts about the demo pack, and about a wiki
 * made from the demo's pages ("Isle Wiki", a game with no map); it writes
 * and reads no files. The real files are covered by the shell's own tests.
 */

/** Screenshots of the dialog for a wiki, for people to look at: only when ATLAS_PACK_SHOTS names a folder. */
const SHOTS = process.env.ATLAS_PACK_SHOTS;

interface Job {
  kind: 'export' | 'import';
  packId: string;
  title: string;
  entriesDone: number;
  entriesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  picturesDone?: number;
  picturesTotal?: number;
  cancelling: boolean;
}

interface PackShell {
  /** The export waits until this is false or it is cancelled. */
  hold: boolean;
  /** Saving the progress export beside the file fails. */
  progressFails: boolean;
  exports: { id: string; detail: string; progress: string | null }[];
  imports: { path: string; replace: boolean }[];
  /** What the next "Import pack file…" picks. */
  pick: unknown;
  job: Job | null;
  /** The demo pack is in the maps folder (after an import). */
  imported: boolean;
  /** Whether each export was asked to include one's own lists, locations and types. */
  exportsMine: boolean[];
  /** The pictures downloaded for the person's own use that the game has: count and bytes. */
  ownUse: { pictures: number; bytes: number } | null;
  /** Whether each export was asked to include them. */
  exportsPhotos: boolean[];
  /** The pictures to pass on whose file is here, offered at full size or smaller: count and bytes. */
  pictures: { pictures: number; bytes: number } | null;
  /** Whether each export was asked to make the pictures smaller. */
  exportsSmaller: boolean[];
  /** One's own files the next import gives back, as the shell reads them from the file. */
  importMine: {
    ownLists?: string;
    ownLocations?: string;
    ownNotes?: string;
    ownPictures?: { file: string; data: string }[];
  } | null;
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
    exportsMine: [],
    ownUse: null,
    exportsPhotos: [],
    pictures: null,
    exportsSmaller: [],
    importMine: null,
  };
  (window as unknown as { __packShell: PackShell }).__packShell = shell;
  /** What the shell says of the own files it put in a file. */
  const mineFacts = { lists: 1, locations: 2, types: 1, areas: 0 };
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
  /** The wiki: pages and pictures, no map. */
  const wikiContents = {
    maps: 0,
    layers: 0,
    locations: 0,
    categories: 0,
    regions: 0,
    checklists: 0,
    guides: 11,
  };
  const wikiPack = {
    id: 'isle-wiki',
    title: 'Isle Wiki',
    packVersion: '1.0.0',
    schemaVersion: 2,
    attribution: [],
  };
  const wikiSource = {
    kind: 'web-pages',
    importer: { id: 'demo-wiki', title: 'Demo wiki site' },
    pages: [{ url: 'https://wiki.example.com/demo-wiki/Isle' }],
    newestPageAt: '2026-11-01T10:00:00.000Z',
    oldestPageAt: '2026-11-01T10:00:00.000Z',
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
  const wikiHeader = (detail: string) => ({
    ...header(detail, 0),
    packId: 'isle-wiki',
    title: 'Isle Wiki',
    pack: wikiPack,
    source: wikiSource,
    contents: wikiContents,
    images: { detail, files: 0, bytes: 0, layers: [] },
    files: 30,
    bytes: 900_000,
  });
  /** Runs a job that counts up every 50 ms; it ends when done (and not held) or cancelled. */
  /** With `pictures`, that many pictures are made smaller first, as long as `hold` is set. */
  const run = <T>(kind: Job['kind'], total: number, done: () => T, pictures = 0) =>
    new Promise<T>((resolve, reject) => {
      shell.job = {
        kind,
        packId: 'demo',
        title: 'Atlas demo world',
        entriesDone: 0,
        entriesTotal: pictures > 0 ? 0 : total,
        bytesDone: 0,
        bytesTotal: pictures > 0 ? 0 : total * 6000,
        picturesDone: 0,
        picturesTotal: pictures,
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
        if (job.entriesTotal === 0) {
          job.picturesDone = Math.min(pictures, (job.picturesDone ?? 0) + Math.ceil(pictures / 5));
          if (job.picturesDone === pictures && !shell.hold) {
            job.entriesTotal = total;
            job.bytesTotal = total * 6000;
          }
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
        if (args.id === 'isle-wiki') {
          // No map: every detail is the same file, with no map images.
          return Promise.resolve({
            packId: 'isle-wiki',
            title: 'Isle Wiki',
            exportable: true,
            reason: null,
            details: ['overview', 'standard', 'full'].map((detail) => ({
              detail,
              available: true,
              reason: null,
              images: 0,
              imageBytes: 0,
              bytes: 900_000,
            })),
            wholeLayers: [],
            defaultNames: {
              overview: 'isle-wiki.atlaspack',
              standard: 'isle-wiki.atlaspack',
              full: 'isle-wiki.atlaspack',
            },
            downloading: false,
            ...(shell.ownUse
              ? { ownUsePictures: shell.ownUse.pictures, ownUsePictureBytes: shell.ownUse.bytes }
              : {}),
            ...(shell.pictures
              ? { pictures: shell.pictures.pictures, pictureBytes: shell.pictures.bytes }
              : {}),
          });
        }
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
          ...(shell.ownUse
            ? { ownUsePictures: shell.ownUse.pictures, ownUsePictureBytes: shell.ownUse.bytes }
            : {}),
          ...(shell.pictures
            ? { pictures: shell.pictures.pictures, pictureBytes: shell.pictures.bytes }
            : {}),
        });
      case 'packfile_export': {
        const detail = args.detail as string;
        const progress = (args.progress as string | null) ?? null;
        shell.exports.push({ id: args.id as string, detail, progress });
        const withMine = args.includeMine === true;
        shell.exportsMine.push(withMine);
        shell.exportsPhotos.push(args.includePhotos === true);
        const smaller = args.smallerPictures === true;
        shell.exportsSmaller.push(smaller);
        if (args.id === 'isle-wiki') {
          const made = () => ({
            path: '/home/test/Exports/isle-wiki.atlaspack',
            fileName: 'isle-wiki.atlaspack',
            size: 900_000,
            header: wikiHeader(detail),
            progressFile: null,
            progressError: null,
          });
          return run('export', 20, made);
        }
        const images = detail === 'overview' ? 18 : 340;
        const path = `/home/test/Exports/demo-${detail}.atlaspack`;
        const made = () => ({
          path,
          fileName: `demo-${detail}.atlaspack`,
          size: images * 6000 + 20_000,
          header: withMine
            ? { ...header(detail, images), version: 2, mine: mineFacts }
            : header(detail, images),
          progressFile:
            progress !== null && !shell.progressFails
              ? `/home/test/Exports/demo-${detail}.progress.json`
              : null,
          progressError:
            progress !== null && shell.progressFails
              ? `Your progress could not be saved beside it (demo-${detail}.progress.json): Permission denied`
              : null,
        });
        return run('export', 20, made, smaller ? (shell.pictures?.pictures ?? 0) : 0);
      }
      case 'packfile_pick':
        return Promise.resolve(shell.pick);
      case 'packfile_import': {
        const request = { path: args.path as string, replace: args.replace as boolean };
        shell.imports.push(request);
        if (
          (shell.pick as { header?: { packId?: string } } | null)?.header?.packId === 'isle-wiki'
        ) {
          return run('import', 20, () => ({
            packId: 'isle-wiki',
            title: 'Isle Wiki',
            replaced: request.replace,
            header: wikiHeader('full'),
            listing: listing(),
          }));
        }
        return run('import', 20, () => {
          shell.imported = true;
          return {
            packId: 'demo',
            title: 'Atlas demo world',
            replaced: request.replace,
            header: header('standard', 340),
            listing: listing(),
            ...(shell.importMine ?? {}),
          };
        });
      }
      case 'packfile_progress':
        return Promise.resolve(shell.job ? { ...shell.job } : null);
      case 'packfile_cancel':
        if (shell.job) shell.job.cancelling = true;
        return Promise.resolve(null);
      case 'library_pack_details':
        if (args.id === 'isle-wiki') {
          return Promise.resolve({
            pack: wikiPack,
            source: wikiSource,
            contents: wikiContents,
            layers: [],
            detail: null,
            imagesAt: null,
            archive: false,
            packFile: null,
          });
        }
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
  await openLibraryGame(page, 'demo');
  await libraryMore(page, 'export-pack');

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
  await expect(page.getByTestId('library')).toBeVisible();

  // When the progress cannot be saved, the pack file still is.
  await setShell(page, { progressFails: true });
  await libraryMore(page, 'export-pack');
  await dialog.getByTestId('export-with-progress').check();
  await dialog.getByTestId('export-start').click();
  await expect(dialog.getByTestId('export-result')).toContainText('Saved demo-standard.atlaspack');
  await expect(dialog.getByTestId('export-progress-error')).toHaveText(
    'The pack file is saved. Your progress could not be saved beside it (demo-standard.progress.json): Permission denied',
  );
  expect(errors).toEqual([]);
});

test('imports a pack file, saying which is newer and asking before using older data', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openLibraryGame(page, 'demo');
  const dialog = page.getByTestId('pack-file-dialog');

  // Older than the game installed: keeping it is the first choice.
  await setShell(page, { pick: pickedFile('2026-10-20T10:00:00.000Z') });
  await libraryMore(page, 'import-pack-file');
  await expect(dialog.getByRole('heading')).toHaveText('Import pack file');
  await expect(dialog.getByTestId('import-summary')).toHaveText(
    'Atlas demo world, version 1.0.0: 2 maps, 5,000 locations, 1 checklist, 1 guide. 340 map images at standard detail.',
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
  await libraryMore(page, 'import-pack-file');
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

  // The Library lists it, with where it came from.
  const row = page.getByTestId('library-game-pane');
  await expect(row.getByTestId('library-facts')).toContainText('In the maps folder');
  await row.getByTestId('pack-details-toggle').click();
  const details = row.getByTestId('pack-details');
  await expect(details).toContainText('Read from 1 web page with Demo map site.');
  await expect(details).toContainText('Downloaded at standard detail.');
  await expect(details).toContainText('Imported from demo-standard.atlaspack on');
  await expect(details.locator('time[title="2026-11-11T10:00:00Z"]')).toBeVisible();
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
  expect(errors).toEqual([]);
});

test('offers the photos downloaded for one’s own use in a pack file, and only when there are any', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openLibraryGame(page, 'demo');
  const dialog = page.getByTestId('pack-file-dialog');

  // A game with no such photos: nothing to offer.
  await libraryMore(page, 'export-pack');
  await expect(dialog.getByTestId('export-start')).toBeEnabled();
  await expect(dialog.getByTestId('export-with-photos')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // With photos downloaded: offered, off until ticked, with how many and how large.
  await setShell(page, { ownUse: { pictures: 1280, bytes: 96_000_000 } });
  await libraryMore(page, 'export-pack');
  const withPhotos = dialog.getByTestId('export-with-photos');
  await expect(withPhotos).toHaveAccessibleName('Include downloaded photos');
  await expect(withPhotos).toHaveAccessibleDescription(
    /The 1,280 photos downloaded for your own use/,
  );
  await expect(withPhotos).toHaveAccessibleDescription(/Keep a file with them to yourself/);
  await expect(withPhotos).not.toBeChecked();
  await dialog.getByTestId('export-start').click();
  await expect(dialog.getByTestId('export-result')).toContainText('Saved demo-standard.atlaspack');
  await dialog.getByRole('button', { name: 'Done' }).click();

  await libraryMore(page, 'export-pack');
  await withPhotos.check();
  await dialog.getByTestId('export-start').click();
  await expect(dialog.getByTestId('export-result')).toContainText('Saved demo-standard.atlaspack');
  expect((await packShell(page)).exportsPhotos).toEqual([false, true]);
  expect(errors).toEqual([]);
});

test('offers the pictures in a pack file at full size or smaller, and only when there are any', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openLibraryGame(page, 'demo');
  const dialog = page.getByTestId('pack-file-dialog');
  const choice = dialog.getByTestId('export-picture-size');

  // A shell that cannot make pictures smaller, or a game with none: nothing to choose.
  await libraryMore(page, 'export-pack');
  await expect(dialog.getByTestId('export-start')).toBeEnabled();
  await expect(choice).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await setShell(page, { pictures: { pictures: 0, bytes: 0 } });
  await libraryMore(page, 'export-pack');
  await expect(dialog.getByTestId('export-start')).toBeEnabled();
  await expect(choice).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // With pictures: full size until asked otherwise, with how many and how large.
  await setShell(page, { pictures: { pictures: 252, bytes: 41_000_000 }, hold: true });
  await libraryMore(page, 'export-pack');
  await expect(choice.locator('legend')).toHaveText('Pictures in the file');
  const full = choice.getByRole('radio', { name: /Full size/ });
  const smaller = choice.getByRole('radio', { name: /Smaller/ });
  await expect(full).toBeChecked();
  await expect(choice.getByTestId('export-pictures-full')).toContainText(
    'The pictures go in as this computer keeps them (252 pictures, 41 MB).',
  );
  await expect(choice.getByTestId('export-pictures-smaller')).toContainText(
    'at most 1,280 pixels wide',
  );
  await expect(choice.getByTestId('export-pictures-smaller')).toContainText(
    'The pictures on this computer and your own photos stay as they are.',
  );
  // The photos for one's own use count when they go in.
  await setShell(page, { ownUse: { pictures: 8, bytes: 4_000_000 } });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await libraryMore(page, 'export-pack');
  await dialog.getByTestId('export-with-photos').check();
  await expect(choice.getByTestId('export-pictures-full')).toContainText('(260 pictures, 45 MB)');
  await dialog.getByTestId('export-with-photos').uncheck();

  // Smaller: the pictures are made smaller before the file is written.
  await smaller.check();
  await dialog.getByTestId('export-start').click();
  const progress = dialog.getByTestId('pack-file-progress');
  await expect(progress).toContainText('Making the pictures smaller: 252 of 252');
  await expect(progress.getByRole('progressbar')).toHaveAttribute(
    'aria-valuetext',
    '252 of 252 pictures',
  );
  await setShell(page, { hold: false });
  await expect(dialog.getByTestId('export-result')).toContainText('Saved demo-standard.atlaspack');
  await dialog.getByRole('button', { name: 'Done' }).click();

  // The dialog asks again each time: full size.
  await libraryMore(page, 'export-pack');
  await expect(full).toBeChecked();
  await dialog.getByTestId('export-start').click();
  await expect(dialog.getByTestId('export-result')).toContainText('Saved demo-standard.atlaspack');
  expect((await packShell(page)).exportsSmaller).toEqual([true, false]);
  expect(errors).toEqual([]);
});

test('carries one’s own lists, locations and types in a pack file only when asked', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openLibraryGame(page, 'demo');
  const dialog = page.getByTestId('pack-file-dialog');

  // A game not made in the app: one's own things are left out unless asked for.
  await libraryMore(page, 'export-pack');
  const withMine = dialog.getByTestId('export-with-mine');
  await expect(withMine).toHaveAccessibleName('Include my lists, locations, types and photos');
  await expect(withMine).not.toBeChecked();
  await dialog.getByTestId('export-start').click();
  await expect(dialog.getByTestId('export-result')).toContainText('Saved demo-standard.atlaspack');
  await expect(dialog.getByTestId('export-mine')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Done' }).click();

  await libraryMore(page, 'export-pack');
  await withMine.check();
  await dialog.getByTestId('export-start').click();
  await expect(dialog.getByTestId('export-mine')).toHaveText(
    'It holds your own 1 list, 2 locations and 1 type.',
  );
  expect((await packShell(page)).exportsMine).toEqual([false, true]);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.keyboard.press('Escape');

  // A file with someone's own things says so, and importing it adds them.
  const picked = pickedFile('2026-11-08T10:00:00.000Z');
  await setShell(page, {
    pick: {
      ...picked,
      header: {
        ...picked.header,
        version: 2,
        mine: { lists: 1, locations: 2, types: 1, areas: 0 },
      },
    },
    importMine: { ownLists: ownListsText, ownLocations: ownLocationsText },
  });
  await openLibraryGame(page, 'demo');
  await libraryMore(page, 'import-pack-file');
  await expect(dialog.getByTestId('import-has-mine')).toContainText(
    'It also holds someone’s own 1 list, 2 locations and 1 type.',
  );
  await dialog.getByTestId('import-start').click();
  await expect(dialog.getByTestId('import-mine')).toHaveText(
    'Your own 1 list, 2 locations and 1 type from the file were added to yours.',
  );
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.keyboard.press('Escape');

  // They are on the map, found by search, and the list is there.
  await expect(page.getByTestId('marker-count')).toHaveText('5,002');
  await selectByName(page, 'Stone well');
  await expect(
    page.getByTestId('checklist-link').filter({ hasText: 'Wells to visit' }),
  ).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('restores the photos of one’s own locations from a pack file', async ({ page }) => {
  const errors = collectErrors(page);
  // The shell gives back the own locations file and the photo it names, in base64.
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 160, height: 100 } });
  const locations = JSON.parse(ownLocationsText) as {
    locations: { id: string; photos?: unknown[] }[];
    pictures?: unknown[];
  };
  locations.pictures = [
    {
      id: 'demo:picture:own.cove1',
      file: 'pictures/own.cove1.png',
      shareable: true,
      width: 160,
      height: 100,
    },
  ];
  locations.locations[0]!.photos = [{ picture: 'demo:picture:own.cove1' }];
  const picked = pickedFile('2026-11-08T10:00:00.000Z');
  await setShell(page, {
    pick: {
      ...picked,
      header: {
        ...picked.header,
        version: 3,
        mine: { lists: 0, locations: 2, types: 1, areas: 0, photos: 1 },
      },
    },
    importMine: {
      ownLocations: JSON.stringify(locations),
      ownPictures: [{ file: 'own.cove1.png', data: png.toString('base64') }],
    },
  });
  await openLibraryGame(page, 'demo');
  await libraryMore(page, 'import-pack-file');
  const dialog = page.getByTestId('pack-file-dialog');
  await expect(dialog.getByTestId('import-has-mine')).toContainText(
    'It also holds someone’s own 2 locations, 1 type and 1 photo.',
  );
  await dialog.getByTestId('import-start').click();
  await expect(dialog.getByTestId('import-mine')).toHaveText(
    'Your own 2 locations, 1 type and 1 photo from the file were added to yours.',
  );
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.keyboard.press('Escape');

  // The location shows its photo.
  await selectByName(page, 'Old well');
  const img = page.getByTestId('photo-strip').getByTestId('photo').locator('img');
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(160);
  expect(errors).toEqual([]);
});

test('adds the notes a pack file carries, with their photos, to one’s own', async ({ page }) => {
  const errors = collectErrors(page);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 120, height: 80 } });
  const at = '2026-11-14T10:00:00.000Z';
  const notes = {
    format: 'atlas-own-notes',
    version: 1,
    gameId: 'demo',
    updatedAt: at,
    notes: {
      'demo:loc:4010': {
        text: 'The ladder is behind the den.',
        name: 'Wolf den 3',
        photos: [{ picture: 'demo:picture:own.den1' }],
        updatedAt: at,
      },
    },
    pictures: [
      {
        id: 'demo:picture:own.den1',
        file: 'pictures/own.den1.png',
        shareable: true,
        width: 120,
        height: 80,
      },
    ],
  };
  const picked = pickedFile('2026-11-08T10:00:00.000Z');
  await setShell(page, {
    pick: {
      ...picked,
      header: {
        ...picked.header,
        version: 5,
        mine: { lists: 0, locations: 0, types: 0, areas: 0, photos: 1, notes: 1 },
      },
    },
    importMine: {
      ownNotes: JSON.stringify(notes),
      ownPictures: [{ file: 'own.den1.png', data: png.toString('base64') }],
    },
  });
  await openLibraryGame(page, 'demo');
  await libraryMore(page, 'import-pack-file');
  const dialog = page.getByTestId('pack-file-dialog');
  await expect(dialog.getByTestId('import-has-mine')).toContainText(
    'It also holds someone’s own 1 photo and 1 note.',
  );
  await dialog.getByTestId('import-start').click();
  await expect(dialog.getByTestId('import-mine')).toHaveText(
    'Your own 1 photo and 1 note from the file were added to yours.',
  );
  await expect
    .poll(async () => {
      const text = (await storedSetting(page, 'ownNotes:demo')) as string | undefined;
      return text ? Object.keys((JSON.parse(text) as typeof notes).notes) : [];
    })
    .toEqual(['demo:loc:4010']);
  expect(errors).toEqual([]);
});

test.describe('in the standard layout', () => {
  test.use({ layout: 'standard' });

  test('exports and imports from the Library', async ({ page }) => {
    const errors = collectErrors(page);
    await page.getByTestId('section-library').click();

    // Export to a file, in the game's More.
    await openLibraryGame(page, 'demo');
    await libraryMore(page, 'export-pack');
    const dialog = page.getByTestId('pack-file-dialog');
    await expect(dialog.getByRole('heading')).toHaveText('Export Atlas demo world');
    await dialog.getByTestId('export-start').click();
    await expect(dialog.getByTestId('export-result')).toContainText(
      'Saved demo-standard.atlaspack',
    );
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('library')).toBeVisible();
    expect((await packShell(page)).exports.map((e) => e.detail)).toEqual(['standard']);

    // Import a pack file, in the same More.
    await setShell(page, { pick: pickedFile('2026-11-08T10:00:00.000Z') });
    await libraryMore(page, 'import-pack-file');
    await expect(dialog.getByRole('heading')).toHaveText('Import pack file');
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

/** The files of the wiki made from the demo's pages: no map, its pages and their pictures only. */
const WIKI_FILES = ['manifest.json', 'sections.json', 'pictures.json', 'guides.json'];

/**
 * Lists "Isle Wiki" beside the demo world and serves it from the demo's
 * files with its ids changed: its pages only, and an empty list of maps.
 * Then opens the app again, so it is listed.
 */
async function serveWiki(page: Page): Promise<void> {
  await page.route('**/packs/index.json', (route) =>
    route.fulfill({
      json: {
        packs: [
          { id: 'demo', url: 'packs/demo/', title: 'Atlas demo world' },
          { id: 'isle-wiki', url: 'packs/isle-wiki/', title: 'Isle Wiki' },
        ],
      },
    }),
  );
  await page.route('**/packs/isle-wiki/**', async (route: Route) => {
    const name = new URL(route.request().url()).pathname.split('/packs/isle-wiki/')[1] ?? '';
    if (name === 'maps.json') return route.fulfill({ json: [] });
    if (!WIKI_FILES.includes(name) && !name.startsWith('pictures/')) {
      return route.fulfill({ status: 404, body: 'not found' });
    }
    const response = await route.fetch({
      url: route.request().url().replace('/packs/isle-wiki/', '/packs/demo/'),
    });
    if (!response.ok() || !name.endsWith('.json')) return route.fulfill({ response });
    const value = JSON.parse(
      (await response.text())
        .replaceAll('"demo:', '"isle-wiki:')
        .replaceAll('(demo:', '(isle-wiki:'),
    ) as unknown;
    if (name === 'manifest.json') {
      const { contents: _contents, ...manifest } = value as Record<string, unknown>;
      return route.fulfill({
        json: { ...manifest, gameId: 'isle-wiki', title: 'Isle Wiki', idMigrations: {} },
      });
    }
    if (name === 'guides.json') {
      const all = value as { id: string }[];
      return route.fulfill({ json: all.filter((g) => g.id.startsWith('isle-wiki:guide:wiki-')) });
    }
    return route.fulfill({ json: value });
  });
  await page.goto('./');
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
}

/** A picked file of the wiki, newer than the wiki in the maps folder, which it replaces. */
function pickedWikiFile() {
  const pack = {
    id: 'isle-wiki',
    title: 'Isle Wiki',
    packVersion: '1.0.0',
    schemaVersion: 2,
    attribution: [],
  };
  const source = (at: string) => ({
    kind: 'web-pages',
    importer: { id: 'demo-wiki', title: 'Demo wiki site' },
    pages: [{ url: 'https://wiki.example.com/demo-wiki/Isle' }],
    newestPageAt: at,
    oldestPageAt: at,
  });
  const contents = {
    maps: 0,
    layers: 0,
    locations: 0,
    categories: 0,
    regions: 0,
    checklists: 0,
    guides: 11,
  };
  return {
    path: '/home/test/Downloads/isle-wiki.atlaspack',
    fileName: 'isle-wiki.atlaspack',
    size: 900_000,
    header: {
      format: 'atlas-pack-file',
      version: 1,
      packId: 'isle-wiki',
      title: 'Isle Wiki',
      packVersion: '1.0.0',
      detail: 'full',
      exportedAt: '2026-11-11T09:30:00Z',
      exportedBy: { name: 'Atlas', version: '0.0.0', platform: 'windows' },
      pack,
      source: source('2026-11-08T10:00:00.000Z'),
      contents,
      images: { detail: 'full', files: 0, bytes: 0, layers: [] },
      files: 30,
      bytes: 900_000,
    },
    installed: {
      title: 'Isle Wiki',
      origin: 'maps-folder',
      folder: null,
      details: {
        pack,
        source: source('2026-11-01T10:00:00.000Z'),
        contents,
        layers: [],
        detail: null,
        imagesAt: null,
        archive: false,
        packFile: null,
      },
    },
    replaces: true,
    blocked: null,
  };
}

test.describe('a wiki, a game with no map', () => {
  // Sharp screenshots for people to look at.
  test.use({ deviceScaleFactor: 2 });

  test.beforeAll(async () => {
    if (SHOTS) await mkdir(SHOTS, { recursive: true });
  });

  test('is exported and imported as pages and pictures, with no detail to choose', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await serveWiki(page);
    await setShell(page, {
      ownUse: { pictures: 12, bytes: 3_000_000 },
      pictures: { pictures: 2, bytes: 400_000 },
    });
    await openLibraryGame(page, 'isle-wiki');
    await libraryMore(page, 'export-pack');

    const dialog = page.getByTestId('pack-file-dialog');
    await expect(dialog.getByRole('heading')).toHaveText('Export Isle Wiki');
    await expect(dialog.getByTestId('export-intro')).toHaveText(
      'A pack file holds Isle Wiki in one file: its pages, and the pictures of its pages as you choose below. Copy it to another computer or to Atlas for Android and import it there to read the pages offline. It never holds your progress.',
    );
    // No map: no detail to choose, and nothing said of maps, locations or map images.
    await expect(dialog.getByTestId('export-start')).toBeEnabled();
    await expect(dialog.getByTestId('export-detail')).toHaveCount(0);
    await expect(dialog).not.toContainText(/\bmaps?\b|locations?|map images?/i);
    await expect(dialog.getByTestId('export-wikis-apart')).toHaveCount(0);
    // The downloaded pictures decide whether the pages keep their pictures: offered first.
    const withPhotos = dialog.getByTestId('export-with-photos');
    await expect(withPhotos).toHaveAccessibleName('Include downloaded pictures');
    await expect(withPhotos).toHaveAccessibleDescription(
      /^The 12 pictures of its pages downloaded for your own use \(3\.0 MB\)\. Tick this so the pages show their pictures on the other device: without it, the file holds the pages without these pictures\./,
    );
    await expect(withPhotos).not.toBeChecked();
    const boxes = dialog.locator('input[type="checkbox"]');
    await expect(boxes.first()).toHaveAttribute('data-testid', 'export-with-photos');
    await expect(dialog.getByTestId('export-with-mine')).toHaveAccessibleName('Include my pages');
    await expect(dialog.getByTestId('export-with-mine')).toHaveAccessibleDescription(
      /^The pages you added or changed in this game and the title it shares with other games/,
    );
    if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/export-wiki.png` });

    // Exported with the pictures: the progress and the result speak of pages and pictures.
    await withPhotos.check();
    await setShell(page, { hold: true });
    await dialog.getByTestId('export-start').click();
    await expect(dialog.getByRole('progressbar')).toHaveAccessibleName(
      'Saving the pages and pictures in the pack file',
    );
    await setShell(page, { hold: false });
    await expect(dialog.getByTestId('export-result')).toHaveText(
      'Saved isle-wiki.atlaspack (900 KB): 11 pages and 14 pictures.',
    );
    await expect(dialog).not.toContainText(/map images?/i);
    const shell = await packShell(page);
    expect(shell.exports.map((e) => e.id)).toEqual(['isle-wiki']);
    expect(shell.exportsPhotos).toEqual([true]);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();

    // A wiki file: what it holds and what importing it replaces, in pages and pictures.
    await setShell(page, { pick: pickedWikiFile() });
    await libraryMore(page, 'import-pack-file');
    await expect(dialog.getByRole('heading')).toHaveText('Import pack file');
    await expect(dialog.getByTestId('import-summary')).toHaveText(
      'Isle Wiki, version 1.0.0: 11 pages.',
    );
    const compare = dialog.getByTestId('import-compare');
    await expect(compare.locator('tbody th')).toHaveText([
      'Version',
      'Pages last read',
      'Contents',
      'Made',
    ]);
    await expect(compare).toContainText('11 pages');
    await expect(dialog.getByTestId('import-verdict')).toHaveAttribute(
      'data-verdict',
      'file-newer',
    );
    await expect(dialog.getByTestId('import-replace-note')).toHaveText(
      'Importing replaces Isle Wiki in the maps folder. Your progress is kept; its pages and pictures are replaced by the ones in this file.',
    );
    await expect(
      dialog.getByText(/locations|checklists|map images?|\bmaps?\b(?! folder)/i),
    ).toHaveCount(0);
    if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/import-wiki.png` });
    await expect(dialog.getByTestId('import-start')).toHaveText('Import and replace');
    await dialog.getByTestId('import-start').click();
    await expect(dialog.getByTestId('import-result')).toHaveText(
      'Replaced Isle Wiki. It is in the maps folder and shown now. Your progress is kept.',
    );
    expect((await packShell(page)).imports).toEqual([
      { path: '/home/test/Downloads/isle-wiki.atlaspack', replace: true },
    ]);
    expect(realErrors(errors)).toEqual([]);
  });

  test('a map game’s export says that the wiki shown with it under one title goes apart', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await serveWiki(page);
    await openLibraryGame(page, 'demo');
    await libraryMore(page, 'export-pack');
    const dialog = page.getByTestId('pack-file-dialog');
    // Not under one title yet: nothing to say.
    await expect(dialog.getByTestId('export-detail')).toHaveCount(3);
    await expect(dialog.getByTestId('export-wikis-apart')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // The demo world and the wiki under one title.
    await libraryMore(page, 'show-with-another');
    const pane = page.getByTestId('library-game-pane');
    const form = pane.getByTestId('title-form');
    await form.getByTestId('title-choice').filter({ hasText: 'Isle Wiki' }).click();
    await form.getByTestId('title-name').fill('Sundered Isle');
    await form.getByTestId('title-save').click();
    await expect(pane.getByTestId('library-title-card')).toContainText('Sundered Isle');
    await expect(pane).toHaveAttribute('data-pack', 'demo');

    await libraryMore(page, 'export-pack');
    await expect(dialog.getByTestId('export-intro')).toContainText(
      'its maps, locations and checklists, and the map images at the detail you choose.',
    );
    await expect(dialog.getByTestId('export-wikis-apart')).toHaveText(
      'The wiki Isle Wiki, shown with this game under one title, is not in this file: export it by itself from the Library, under More, Export to a file.',
    );
    await expect(dialog.getByTestId('export-detail')).toHaveCount(3);
    if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/export-map.png` });
    expect(realErrors(errors)).toEqual([]);
  });
});
