import { devices, expect, test, type Page } from '@playwright/test';
import { collectErrors, demoLocations, expectOverallFound, openMap, selectByName } from './helpers';

/**
 * The web app as the Android app runs it. A stand-in shell answers
 * `desktop_info` as the Android shell does (no folders, no progress files,
 * no import window, no downloads) and refuses every desktop-only command,
 * as the Android shell does. The real Android app is built in CI; this
 * checks what the page offers in it.
 */
function installAndroidShell() {
  const calls: string[] = [];
  (window as unknown as { __shellCalls: string[] }).__shellCalls = calls;
  const invoke = (command: string) => {
    calls.push(command);
    switch (command) {
      case 'desktop_info':
        return Promise.resolve({
          name: 'Atlas',
          version: '0.0.0',
          platform: 'android',
          downloads: false,
          folders: false,
          progressFiles: false,
          imports: false,
        });
      case 'library_list':
        return Promise.resolve({
          mapsFolder: {
            path: '/data/user/0/dev.atlas.android/Atlas/Maps',
            isDefault: true,
            exists: false,
          },
          packs: [],
          hidden: [],
          locations: [],
          busy: [],
        });
      default:
        return Promise.reject(new Error('This is not available on this device.'));
    }
  };
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
}

/** The commands the page called, in order. */
function shellCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __shellCalls: string[] }).__shellCalls);
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
  await page.addInitScript(installAndroidShell);
});

test('offers no folders, progress files or adding maps', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page);
  await expect(page.getByTestId('profile-name')).toBeVisible();
  await expect(page.getByTestId('maps-button')).toHaveCount(0);
  await expect(page.getByTestId('add-map-button')).toHaveCount(0);

  await page.getByTestId('profile-name').click();
  const dialog = page.getByTestId('profile-dialog');
  await expect(dialog.getByTestId('no-progress-files')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Export/ })).toHaveCount(0);
  await expect(dialog.getByText('Import from file…')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Create' })).toBeVisible();

  expect(await shellCalls(page)).toEqual(expect.arrayContaining(['desktop_info', 'library_list']));
  const desktopOnly = (await shellCalls(page)).filter(
    (command) => !['desktop_info', 'library_list'].includes(command),
  );
  expect(desktopOnly).toEqual([]);
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
});
