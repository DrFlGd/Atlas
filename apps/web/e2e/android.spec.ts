import { devices, expect, test, type Page } from '@playwright/test';
import { collectErrors, demoLocations, expectOverallFound, openMap, selectByName } from './helpers';

/**
 * The web app as the Android app runs it. A stand-in shell answers
 * `desktop_info` as the Android shell does (Maps without folders, progress
 * files through the system's screens, map pack files copied into the app
 * before they are imported; no import window, no downloads), answers the
 * commands the Android app has with made-up facts, and refuses every
 * desktop-only command, as the Android shell does. It reads and writes no
 * files: the copying, importing and `content://` reading and writing are
 * covered by the shell's own tests. The real Android app is built in CI;
 * this checks what the page offers in it and which commands it calls.
 */

interface Job {
  kind: 'import' | 'copy';
  packId: string;
  title: string;
  entriesDone: number;
  entriesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  cancelling: boolean;
}

interface AndroidShell {
  calls: { command: string; args: Record<string, unknown> }[];
  /** What the next "Import map pack file…" picks; null closes the picker. */
  pick: { fileName: string; size: number | null } | null;
  /** The copy waits until this is false or it is cancelled. */
  hold: boolean;
  job: Job | null;
  /** Copies made so far, and those discarded. */
  copies: string[];
  discarded: string[];
  /** The demo pack is in the maps folder (after an import). */
  imported: boolean;
  /** Progress files saved through the save screen. */
  saved: { suggestedName: string; contents: string }[];
  /** What the next progress import opens; null closes the picker. */
  open: { name: string; contents: string } | null;
}

/** Commands only the desktop shell has, or that need folders: never called on Android. */
const DESKTOP_ONLY = [
  'library_open_pack',
  'library_add_folder',
  'library_remove_location',
  'library_choose_maps_folder',
  'library_apply_maps_folder',
  'library_reveal',
  'library_delete_images',
  'import_open',
  'packfile_options',
  'packfile_export',
  'packfile_pick',
];

function installAndroidShell(desktopOnly: string[]) {
  const shell: AndroidShell = {
    calls: [],
    pick: null,
    hold: false,
    job: null,
    copies: [],
    discarded: [],
    imported: false,
    saved: [],
    open: null,
  };
  (window as unknown as { __androidShell: AndroidShell }).__androidShell = shell;
  const demoUrl = new URL('packs/demo/', window.location.href).href;
  const listing = () => ({
    mapsFolder: {
      path: '/data/user/0/dev.atlas.android/no_backup/Maps',
      isDefault: true,
      exists: true,
    },
    packs: shell.imported
      ? [
          {
            id: 'demo',
            title: 'Atlas demo world',
            url: demoUrl,
            origin: 'maps-folder',
            path: '/data/user/0/dev.atlas.android/no_backup/Maps/demo',
            packVersion: '1.0.0',
            // The Android shell lists no packs of its own: the demo comes
            // with the web build.
            bundled: false,
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
  const header = {
    format: 'atlas-pack-file',
    version: 1,
    packId: 'demo',
    title: 'Atlas demo world',
    packVersion: '1.0.0',
    detail: 'standard',
    exportedAt: '2026-11-11T09:30:00Z',
    exportedBy: { name: 'Atlas', version: '0.3.6', platform: 'windows' },
    pack: {
      id: 'demo',
      title: 'Atlas demo world',
      packVersion: '1.0.0',
      schemaVersion: 2,
      attribution: [],
    },
    source: { kind: 'app', pages: [] },
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
    bytes: 2_100_000,
  };
  /** Runs a job that counts up every 50 ms; it ends when done (and not held) or cancelled. */
  const run = <T>(kind: Job['kind'], total: number, done: () => T, cancelled: string) =>
    new Promise<T>((resolve, reject) => {
      shell.job = {
        kind,
        packId: 'demo',
        title: 'Atlas demo world',
        entriesDone: 0,
        entriesTotal: kind === 'copy' ? 0 : total,
        bytesDone: 0,
        bytesTotal: total * 100_000,
        cancelling: false,
      };
      let steps = 0;
      const timer = window.setInterval(() => {
        const job = shell.job!;
        if (job.cancelling) {
          window.clearInterval(timer);
          shell.job = null;
          // Tauri rejects with the command's error value, a string.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(cancelled);
          return;
        }
        steps = Math.min(total, steps + 2);
        if (kind === 'import') job.entriesDone = steps;
        job.bytesDone = steps * 100_000;
        if (steps === total && !shell.hold) {
          window.clearInterval(timer);
          shell.job = null;
          resolve(done());
        }
      }, 50);
    });
  const refuse = (message: string) =>
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    Promise.reject(message);
  const invoke = (command: string, args: Record<string, unknown> = {}) => {
    shell.calls.push({ command, args });
    if (desktopOnly.includes(command)) return refuse('This is not available on this device.');
    switch (command) {
      case 'desktop_info':
        return Promise.resolve({
          name: 'Atlas',
          version: '0.3.6',
          platform: 'android',
          downloads: false,
          folders: false,
          maps: true,
          progressFiles: true,
          imports: false,
          copyPickedFiles: true,
        });
      case 'library_list':
        return Promise.resolve(listing());
      case 'packfile_pick_copy':
        return Promise.resolve(
          shell.pick
            ? {
                ...shell.pick,
                packId: 'demo',
                title: 'Atlas demo world',
                roomNeeded: 2_100_000 * 2 + 64 * 1024 * 1024,
              }
            : null,
        );
      case 'packfile_copy_picked': {
        const name = shell.pick?.fileName ?? 'map-pack.atlaspack';
        return run(
          'copy',
          21,
          () => {
            const path = `/data/user/0/dev.atlas.android/cache/pack-files/${shell.copies.length + 1}/${name}`;
            shell.copies.push(path);
            return path;
          },
          'Cancelled. Nothing was imported.',
        );
      }
      case 'packfile_discard_copy':
        shell.discarded.push(args.path as string);
        return Promise.resolve(null);
      case 'packfile_inspect': {
        const path = args.path as string;
        return Promise.resolve({
          path,
          fileName: path.split('/').pop(),
          size: 2_100_000,
          header,
          installed: shell.imported
            ? {
                title: 'Atlas demo world',
                origin: 'maps-folder',
                folder: '/data/user/0/dev.atlas.android/no_backup/Maps/demo',
                details: null,
              }
            : null,
          replaces: shell.imported,
          blocked: null,
        });
      }
      case 'packfile_import':
        return run(
          'import',
          20,
          () => {
            shell.imported = true;
            return {
              packId: 'demo',
              title: 'Atlas demo world',
              replaced: args.replace as boolean,
              header,
              listing: listing(),
            };
          },
          'Cancelled. Nothing was written.',
        );
      case 'packfile_progress':
        return Promise.resolve(shell.job ? { ...shell.job } : null);
      case 'packfile_cancel':
        if (shell.job) shell.job.cancelling = true;
        return Promise.resolve(null);
      case 'library_pack_details':
        if (!shell.imported) return refuse('That game is not in the list any more.');
        return Promise.resolve({
          pack: header.pack,
          source: header.source,
          contents,
          layers: [],
          detail: 'standard',
          imagesAt: '2026-11-02T08:00:00.000Z',
          archive: false,
          packFile: {
            importedAt: '2026-11-11T10:00:00Z',
            fileName: 'demo-standard.atlaspack',
            header,
          },
        });
      case 'library_images_info':
        return Promise.resolve({ files: 340, bytes: 2_040_000, downloading: false });
      case 'library_delete_pack':
        shell.imported = false;
        return Promise.resolve({ complete: true });
      case 'save_text_file':
        shell.saved.push({
          suggestedName: args.suggestedName as string,
          contents: args.contents as string,
        });
        // The name the save screen gave it.
        return Promise.resolve({ name: 'atlas-progress.json' });
      case 'open_text_file':
        return Promise.resolve(shell.open);
      default:
        return refuse(`Unknown command ${command}`);
    }
  };
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
}

const androidShell = (page: Page) =>
  page.evaluate(() => (window as unknown as { __androidShell: AndroidShell }).__androidShell);

const setShell = (page: Page, patch: Partial<AndroidShell>) =>
  page.evaluate((patch) => {
    Object.assign((window as unknown as { __androidShell: AndroidShell }).__androidShell, patch);
  }, patch);

/** The commands the page called, in order. */
async function shellCalls(page: Page): Promise<string[]> {
  return (await androidShell(page)).calls.map((call) => call.command);
}

async function expectNoDesktopOnlyCalls(page: Page): Promise<void> {
  const called = (await shellCalls(page)).filter((command) => DESKTOP_ONLY.includes(command));
  expect(called).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  // An importer in config.json, as a desktop build could have: the Android
  // app still offers no "Add a map".
  await page.route('**/config.json', async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      json: {
        ...config,
        importers: [
          {
            id: 'demo-maps',
            title: 'Demo map site',
            description: 'Reads the made-up demo map site.',
            version: '1.0.0',
            module: 'importers/demo-maps.js',
          },
        ],
      },
    });
  });
  await page.addInitScript(installAndroidShell, DESKTOP_ONLY);
});

test('offers Maps without folders, progress files, and no adding maps', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page);
  await expect(page.getByTestId('profile-name')).toBeVisible();
  await expect(page.getByTestId('add-map-button')).toHaveCount(0);
  // No keyboard shortcuts offered: there is usually no keyboard.
  await expect(page.getByRole('combobox', { name: 'Search locations' })).toHaveAttribute(
    'placeholder',
    'Search',
  );
  await expect(page.getByTestId('details-empty')).not.toContainText('Keyboard');
  await expect(page.locator('kbd')).toHaveCount(0);
  const checklists = page.getByTestId('checklists-button');
  await expect(checklists).not.toHaveAttribute('title', /\(C\)/);
  await expect(checklists).not.toHaveAttribute('aria-keyshortcuts');

  await page.getByTestId('maps-button').click();
  const maps = page.getByTestId('maps-dialog');
  await expect(maps.getByRole('heading', { name: 'Games on this device' })).toBeVisible();
  await expect(maps.getByTestId('import-pack-file')).toHaveText('Import map pack file…');
  // No folder choices, no folders to open, nothing to export or download.
  for (const id of [
    'maps-folder-path',
    'change-maps-folder',
    'location-list',
    'open-pack',
    'add-packs-folder',
    'refresh-maps',
    'update-all',
    'export-pack',
    'delete-images',
  ]) {
    await expect(maps.getByTestId(id)).toHaveCount(0);
  }
  await expect(maps.getByRole('button', { name: 'Open folder' })).toHaveCount(0);
  await expect(maps).not.toContainText('/data/user/0');
  // The demo comes with the app; it is shown already.
  const demo = maps.locator('[data-testid="pack-row"][data-pack="demo"]');
  await expect(demo).toContainText('Comes with the app');
  await expect(demo.getByTestId('show-pack')).toHaveCount(0);
  await expect(maps.getByTestId('app-version')).toHaveText('Atlas 0.3.6');
  await maps.getByRole('button', { name: 'Close' }).click();

  await page.getByTestId('profile-name').click();
  const dialog = page.getByTestId('profile-dialog');
  await expect(dialog.getByTestId('no-progress-files')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Export all profiles/ })).toBeVisible();
  await expect(dialog.getByTestId('import-file-desktop')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create' })).toBeVisible();

  expect(await shellCalls(page)).toEqual(expect.arrayContaining(['desktop_info', 'library_list']));
  await expectNoDesktopOnlyCalls(page);
  expect(errors).toEqual([]);
});

test('imports a map pack file from the picker, copying it into the app first', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page);
  await page.getByTestId('maps-button').click();
  const maps = page.getByTestId('maps-dialog');
  const dialog = page.getByTestId('pack-file-dialog');
  const importButton = maps.getByTestId('import-pack-file');

  // The picker closed: nothing is copied.
  await importButton.click();
  await expect.poll(() => shellCalls(page)).toContain('packfile_pick_copy');
  await expect(dialog).toBeHidden();
  expect(await shellCalls(page)).not.toContain('packfile_copy_picked');

  // Copying shows how far it is; cancelled, nothing is kept.
  await setShell(page, {
    pick: { fileName: 'Atlas demo world (standard).atlaspack', size: 2_100_000 },
    hold: true,
  });
  await importButton.click();
  await expect(dialog.getByRole('heading')).toHaveText('Import map pack file');
  await expect(dialog.getByTestId('copy-file')).toHaveText(
    'Atlas demo world (standard).atlaspack (2.1 MB)',
  );
  await expect(dialog.getByTestId('copy-note')).toContainText('Atlas demo world');
  await expect(dialog.getByTestId('pack-file-progress')).toContainText(
    /Copying the file into the app….*of 2\.1 MB/,
  );
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeDisabled();
  await dialog.getByTestId('pack-file-cancel').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Cancelled. Nothing was imported.')).toBeVisible();
  expect((await androidShell(page)).copies).toEqual([]);

  // Copied, then the import dialog of the shared import, with the file's own name.
  await setShell(page, { hold: false });
  await importButton.click();
  await expect(dialog.getByTestId('import-file')).toContainText(
    'Atlas demo world (standard).atlaspack',
  );
  const copy =
    '/data/user/0/dev.atlas.android/cache/pack-files/1/Atlas demo world (standard).atlaspack';
  let shell = await androidShell(page);
  expect(shell.copies).toEqual([copy]);
  expect(shell.calls.filter((c) => c.command === 'packfile_inspect')).toEqual([
    { command: 'packfile_inspect', args: { path: copy } },
  ]);
  await expect(dialog.getByTestId('import-summary')).toContainText('Atlas demo world');
  await dialog.getByTestId('import-start').click();
  await expect(dialog.getByTestId('import-result')).toContainText('Imported Atlas demo world.');
  // The game is imported: the copy is deleted at once.
  shell = await androidShell(page);
  expect(shell.calls.filter((c) => c.command === 'packfile_import').map((c) => c.args)).toEqual([
    { path: copy, replace: false },
  ]);
  expect(shell.discarded).toEqual([copy]);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  expect((await androidShell(page)).discarded).toEqual([copy]);

  // Listed with its detail and size, and it can be deleted.
  const row = maps.locator('[data-testid="pack-row"][data-pack="demo"]');
  await expect(row).toContainText('Maps folder');
  await expect(row.getByTestId('pack-summary')).toHaveText(
    'Standard detail · 2.1 MB · 2 maps · 5,000 places',
  );
  await row.getByTestId('pack-details-toggle').click();
  await expect(row.getByTestId('pack-details')).toContainText(
    'Imported from demo-standard.atlaspack on',
  );
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');

  // Closing the import dialog without importing deletes the copy too.
  await importButton.click();
  await expect(dialog.getByTestId('import-replace-note')).toBeVisible();
  const second =
    '/data/user/0/dev.atlas.android/cache/pack-files/2/Atlas demo world (standard).atlaspack';
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await androidShell(page)).discarded).toEqual([copy, second]);

  await row.getByTestId('delete-pack').click();
  await row.getByTestId('confirm-delete-pack').click();
  await expect(maps.locator('[data-testid="pack-row"][data-pack="demo"]')).toContainText(
    'Comes with the app',
  );
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
  await expectNoDesktopOnlyCalls(page);
  expect(errors).toEqual([]);
});

test('exports progress through the save screen and imports it through the picker', async ({
  page,
  request,
}) => {
  const errors = collectErrors(page);
  const place = (await demoLocations(request)).find((l) => l.mapId === 'demo:map:world')!;
  await openMap(page);
  await selectByName(page, place.name);
  const found = page.getByTestId('found-toggle');
  await expect(found.locator('kbd')).toHaveCount(0);
  await found.click();
  await expectOverallFound(page, 1);

  await page.getByTestId('profile-name').click();
  const dialog = page.getByTestId('profile-dialog');
  await dialog.getByRole('button', { name: /Export all profiles/ }).click();
  await expect(page.getByText('Exported 1 profile.')).toBeVisible();
  const [saved] = (await androidShell(page)).saved;
  expect(saved!.suggestedName).toMatch(/\.json$/);
  expect(JSON.parse(saved!.contents)).toMatchObject({ scope: 'all' });

  // Unmarked here, then the saved file is imported over it.
  await page.keyboard.press('Escape');
  await found.click();
  await expectOverallFound(page, 0);
  await page.getByTestId('profile-name').click();
  // The picker closed: nothing happens.
  await dialog.getByTestId('import-file-desktop').click();
  await expect(dialog.getByTestId('import-review')).toHaveCount(0);
  await setShell(page, { open: { name: 'atlas-progress.json', contents: saved!.contents } });
  await dialog.getByTestId('import-file-desktop').click();
  const review = dialog.getByTestId('import-review');
  await expect(review).toContainText('atlas-progress.json holds 1 profile');
  await review.locator('input[value="replace"]').check();
  await review.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('Imported atlas-progress.json (replace).')).toBeVisible();
  await page.keyboard.press('Escape');
  await expectOverallFound(page, 1);
  await expectNoDesktopOnlyCalls(page);
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];
  test.use(pixel);

  test('keeps a found mark after the app restarts', async ({ page, request }) => {
    const errors = collectErrors(page);
    const place = (await demoLocations(request)).find((l) => l.mapId === 'demo:map:world')!;
    await openMap(page);
    await selectByName(page, place.name);
    const found = page.getByTestId('found-toggle');
    await found.tap();
    await expect(found).toHaveAttribute('aria-pressed', 'true');
    await expectOverallFound(page, 1);

    await page.reload();
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    await expectOverallFound(page, 1);
    await selectByName(page, place.name);
    await expect(page.getByTestId('found-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
  });

  test('keeps everything clear of the system bars, without zoom buttons', async ({ page }) => {
    const errors = collectErrors(page);
    // What the app's activity hands over: a status bar of 30 px and a
    // navigation bar of 48 px, in CSS pixels.
    await page.addInitScript(() => {
      const icons: boolean[] = [];
      let insets = '30,0,48,0';
      Object.assign(window, {
        __barIcons: icons,
        __setInsets: (text: string) => {
          insets = text;
          window.dispatchEvent(new CustomEvent('atlas-insets', { detail: text }));
        },
        AtlasAndroid: {
          insets: () => insets,
          darkIcons: (dark: boolean) => icons.push(dark),
        },
      });
    });
    await openMap(page);
    const viewport = page.viewportSize()!;
    const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
    const clear = async (top: number, bottom: number) => {
      expect((await box('.topbar')).y).toBeGreaterThanOrEqual(top);
      const attribution = await box('.leaflet-control-attribution');
      expect(attribution.y + attribution.height).toBeLessThanOrEqual(viewport.height - bottom);
      const shell = await box('.shell');
      expect(shell.y).toBe(top);
      expect(shell.y + shell.height).toBe(viewport.height - bottom);
    };
    await clear(30, 48);
    // Pinch to zoom: no zoom buttons on a touch screen.
    await expect(page.locator('.leaflet-control-zoom')).toBeHidden();

    // A dialog stays between the bars too.
    await page.getByTestId('maps-button').tap();
    const maps = await box('[data-testid="maps-dialog"]');
    expect(maps.y).toBeGreaterThanOrEqual(30);
    expect(maps.y + maps.height).toBeLessThanOrEqual(viewport.height - 48);
    await page.getByTestId('maps-dialog').getByRole('button', { name: 'Close' }).tap();

    // The insets change, for example after a rotation.
    await page.evaluate(() => {
      (window as unknown as { __setInsets: (text: string) => void }).__setInsets('24,0,16,0');
    });
    await clear(24, 16);

    // The bar icons follow the theme: light on dark, dark on light.
    const icons = () =>
      page.evaluate(() => (window as unknown as { __barIcons: boolean[] }).__barIcons);
    expect((await icons()).at(-1)).toBe(false);
    await page.getByRole('button', { name: 'Use light theme' }).tap();
    await expect.poll(async () => (await icons()).at(-1)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('imports a map pack file from the Maps screen', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page);
    await setShell(page, { pick: { fileName: 'demo.atlaspack', size: null } });
    await page.getByTestId('maps-button').tap();
    await page.getByTestId('import-pack-file').tap();
    const dialog = page.getByTestId('pack-file-dialog');
    await dialog.getByTestId('import-start').tap();
    await expect(dialog.getByTestId('import-result')).toContainText('Imported Atlas demo world.');
    expect((await androidShell(page)).discarded).toEqual([
      '/data/user/0/dev.atlas.android/cache/pack-files/1/demo.atlaspack',
    ]);
    expect(errors).toEqual([]);
  });
});
