import { devices, expect, test } from '@playwright/test';
import {
  androidShell,
  expectNoDesktopOnlyCalls,
  setShell,
  shellCalls,
  useAndroidShell,
} from './androidShell';
import { collectErrors, demoLocations, openMap } from './helpers';
import { back, choosePlace, expectFound } from './touch';

/**
 * The web app as the Android app runs it: the touch layout, with a
 * stand-in shell (see androidShell.ts). The real Android app is built in
 * CI; this checks what the page offers in it and which commands it calls.
 * At the default size (1280 by 800) the layout is the tablet one.
 */

test.beforeEach(async ({ page }) => {
  await useAndroidShell(page);
});

test('opens the touch layout, offers Games without folders and progress files', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openMap(page);
  await expect(page.locator('.touch')).toHaveAttribute('data-arrangement', 'wide');
  await expect(page.locator('.topbar')).toHaveCount(0);
  await expect(page.getByTestId('add-map-button')).toHaveCount(0);
  // No keyboard shortcuts offered: there is usually no keyboard.
  await expect(page.locator('kbd')).toHaveCount(0);

  await page.getByTestId('section-games').click();
  const games = page.getByTestId('games-screen');
  await expect(games.getByRole('heading', { name: 'Games on this device' })).toBeVisible();
  await expect(games.getByTestId('import-pack-file')).toHaveText('Import map pack file…');
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
    'delete-pack',
  ]) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }
  await expect(games).not.toContainText('/data/user/0');
  // The demo comes with the app; it is shown already.
  const demo = games.locator('[data-testid="game-row"][data-pack="demo"]');
  await expect(demo).toContainText('Shown · Comes with the app');
  await expect(demo).toHaveAttribute('data-current', 'true');
  await expect(games.getByTestId('app-version')).toHaveText('Atlas 0.3.6');
  await expect(games.getByTestId('open-activity-log')).toBeVisible();

  await page.getByTestId('section-progress').click();
  await page.getByTestId('profile-chip').click();
  const dialog = page.getByTestId('profile-dialog');
  await expect(dialog.getByTestId('no-progress-files')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Export all profiles/ })).toBeVisible();
  await expect(dialog.getByTestId('import-file-desktop')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create' })).toBeVisible();
  // Back closes the dialog first.
  expect(await back(page)).toBe(true);
  await expect(dialog).toBeHidden();

  expect(await shellCalls(page)).toEqual(expect.arrayContaining(['desktop_info', 'library_list']));
  await expectNoDesktopOnlyCalls(page);
  expect(errors).toEqual([]);
});

test('imports a map pack file from the picker, copying it into the app first', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page);
  await page.getByTestId('section-games').click();
  const maps = page.getByTestId('games-screen');
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
  const row = maps.locator('[data-testid="game-row"][data-pack="demo"]');
  await expect(row).toContainText('Imported from a map pack file');
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
  await expect(row).toContainText('Comes with the app');
  await expect(row.getByTestId('delete-pack')).toHaveCount(0);
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
  await choosePlace(page, place.name);
  const found = page.getByTestId('mark-found');
  await found.click();
  await expectFound(page, 1);

  await page.getByTestId('section-progress').click();
  await page.getByTestId('profile-chip').click();
  const dialog = page.getByTestId('profile-dialog');
  await dialog.getByRole('button', { name: /Export all profiles/ }).click();
  await expect(page.getByText('Exported 1 profile.')).toBeVisible();
  const [saved] = (await androidShell(page)).saved;
  expect(saved!.suggestedName).toMatch(/\.json$/);
  expect(JSON.parse(saved!.contents)).toMatchObject({ scope: 'all' });

  // Unmarked here, then the saved file is imported over it.
  await page.keyboard.press('Escape');
  await found.click();
  await expectFound(page, 0);
  await page.getByTestId('profile-chip').click();
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
  await expectFound(page, 1);
  await expect(page.getByTestId('overall-progress')).toHaveAttribute('data-found', '1');
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
    await expect(page.locator('.touch')).toHaveAttribute('data-arrangement', 'compact');
    await choosePlace(page, place.name);
    const found = page.getByTestId('mark-found');
    await found.tap();
    await expect(found).toHaveAttribute('aria-pressed', 'true');
    await expectFound(page, 1);

    await page.reload();
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    await expectFound(page, 1);
    await choosePlace(page, place.name);
    await expect(page.getByTestId('mark-found')).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
  });

  test('keeps everything clear of the system bars, without zoom buttons', async ({ page }) => {
    const errors = collectErrors(page);
    // What the app's activity hands over: a status bar of 30 px and a
    // navigation bar of 48 px, in CSS pixels.
    await page.addInitScript(() => {
      const icons: boolean[] = [];
      const screenOn: boolean[] = [];
      let insets = '30,0,48,0';
      Object.assign(window, {
        __barIcons: icons,
        __screenOn: screenOn,
        __setInsets: (text: string) => {
          insets = text;
          window.dispatchEvent(new CustomEvent('atlas-insets', { detail: text }));
        },
        AtlasAndroid: {
          insets: () => insets,
          darkIcons: (dark: boolean) => icons.push(dark),
          keepScreenOn: (on: boolean) => screenOn.push(on),
        },
      });
    });
    await openMap(page);
    const viewport = page.viewportSize()!;
    const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
    const clear = async (top: number, bottom: number) => {
      // The map runs under the bars; what is drawn over it keeps clear of them.
      const map = await box('[data-testid="map"]');
      expect(map.y).toBe(0);
      expect((await box('.touch-search-pill')).y).toBeGreaterThanOrEqual(top);
      const bar = await box('.touch-bar');
      expect(bar.y + bar.height).toBe(viewport.height);
      const sections = await box('[data-testid="section-map"]');
      expect(sections.y + sections.height).toBeLessThanOrEqual(viewport.height - bottom);
      const attribution = await box('.leaflet-control-attribution');
      expect(attribution.y + attribution.height).toBeLessThanOrEqual(bar.y);
    };
    await clear(30, 48);
    // Pinch to zoom: no zoom buttons on a touch screen.
    await expect(page.locator('.leaflet-control-zoom')).toHaveCount(0);

    // A dialog stays between the bars too.
    await page.getByTestId('section-progress').tap();
    await page.getByTestId('profile-chip').tap();
    const profiles = await box('[data-testid="profile-dialog"]');
    expect(profiles.y).toBeGreaterThanOrEqual(30);
    expect(profiles.y + profiles.height).toBeLessThanOrEqual(viewport.height - 48);
    expect(await back(page)).toBe(true);
    expect(await back(page)).toBe(true);
    await expect(page.locator('.touch')).toHaveAttribute('data-section', 'map');

    // The insets change, for example after a rotation.
    await page.evaluate(() => {
      (window as unknown as { __setInsets: (text: string) => void }).__setInsets('24,0,16,0');
    });
    await clear(24, 16);

    // The bar icons follow the theme: light on dark, dark on light.
    const icons = () =>
      page.evaluate(() => (window as unknown as { __barIcons: boolean[] }).__barIcons);
    expect((await icons()).at(-1)).toBe(false);
    await page.getByTestId('section-games').tap();
    await page.getByRole('button', { name: 'Light', exact: true }).tap();
    await expect.poll(async () => (await icons()).at(-1)).toBe(true);

    // The screen stays on unless that is switched off.
    const screenOn = () =>
      page.evaluate(() => (window as unknown as { __screenOn: boolean[] }).__screenOn);
    expect((await screenOn()).at(-1)).toBe(true);
    const keep = page.getByTestId('keep-screen-on');
    await expect(keep).toHaveAttribute('aria-checked', 'true');
    await keep.tap();
    await expect(keep).toHaveAttribute('aria-checked', 'false');
    expect((await screenOn()).at(-1)).toBe(false);
    await page.reload();
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    await expect.poll(async () => (await screenOn()).at(-1)).toBe(false);
    expect(errors).toEqual([]);
  });

  test('imports a map pack file from the Games screen', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page);
    await setShell(page, { pick: { fileName: 'demo.atlaspack', size: null } });
    await page.getByTestId('section-games').tap();
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
