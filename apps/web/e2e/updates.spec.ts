import type { Page } from '@playwright/test';
import { collectErrors, openMap, storedSetting } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, mock, realErrors, setUp } from './fakeShell';

/**
 * Updating Atlas itself (`src/state/updates.ts`, Settings' "Updates" and
 * the notice of `src/components/UpdateNotice.tsx`), against the stand-in
 * shell of `fakeShell.ts`, which answers the update commands with made-up
 * versions and notes the install where the real shell ends Atlas. The
 * install itself is only seen on a real computer.
 *
 * Screenshots of the group and the notice, in both themes, are saved when
 * `ATLAS_UPDATE_SHOTS` names a folder.
 */

test.use({ layout: 'standard' });

const ITSELF = { way: { way: 'itself', atStart: true }, platform: 'windows' };
const AVAILABLE = {
  state: 'available',
  version: '0.27.0',
  current: '0.26.0',
  notes:
    '- **Routes.** A route is a path on the map with a short guide at each step.\n- **Rename a map or a level.** Rename… beside each map gives it a name of your own.\n\nThis version has passed the automatic checks only.',
  date: '2026-11-20T10:00:00Z',
};

const calls = async (page: Page) => (await mock(page)).updates.calls;

const setCheck = (page: Page, check: Record<string, unknown> | string) =>
  page.evaluate((check) => {
    (
      window as unknown as { __mockShell: { updates: { check: unknown } } }
    ).__mockShell.updates.check = check;
  }, check);

async function openGroup(page: Page) {
  await page.getByTestId('section-settings').click();
  const group = page.getByTestId('settings-updates');
  await expect(group).toBeVisible();
  return group;
}

/** Saves a picture of the window, when asked for (see the module). */
async function shot(page: Page, name: string) {
  const folder = process.env.ATLAS_UPDATE_SHOTS;
  if (!folder) return;
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.screenshot({ path: `${folder}/${name}-${theme}.png` });
  }
}

test.describe('in the app that updates itself', () => {
  test.skip(DOWNLOADS_BUILD, 'The app with downloads does not update itself.');

  test('looks quietly a few seconds after the start, and offers the update', async ({ page }) => {
    const errors = collectErrors(page);
    await setUp(page, false, { updates: ITSELF });
    await setCheck(page, AVAILABLE);
    expect(await calls(page)).toEqual([]);
    await page.clock.runFor(6_000);
    const notice = page.getByTestId('update-notice');
    await expect(notice).toBeVisible();
    expect(await calls(page)).toEqual(['update_check']);
    await expect(notice.getByRole('heading', { level: 2 })).toHaveText('Atlas 0.27.0 is available');
    await expect(notice).toContainText('You have Atlas 0.26.0.');
    await expect(page.getByTestId('update-notes').getByRole('listitem')).toHaveText([
      'Routes. A route is a path on the map with a short guide at each step.',
      'Rename a map or a level. Rename… beside each map gives it a name of your own.',
    ]);
    await expect(notice).toContainText('saves your changes and closes Atlas');
    await shot(page, 'update-notice');

    // Later: gone until the next start, and nothing installed.
    await page.getByTestId('update-later').click();
    await expect(notice).toHaveCount(0);
    expect(await calls(page)).toEqual(['update_check']);
    expect(realErrors(errors)).toEqual([]);
  });

  test('Install now downloads with its progress, then installs', async ({ page }) => {
    const errors = collectErrors(page);
    await setUp(page, false, { updates: ITSELF });
    await setCheck(page, AVAILABLE);
    await page.clock.runFor(6_000);
    await page.getByTestId('update-install').click();
    const progress = page.getByTestId('update-progress');
    await page.clock.runFor(500);
    await expect(progress).toContainText('Downloading… 50% (60.0 of 120.0 MB)');
    await expect(page.getByTestId('update-later')).toBeDisabled();
    await shot(page, 'update-downloading');
    await page.clock.runFor(1_000);
    await expect(page.getByTestId('update-installing')).toHaveText(
      'Installing… Atlas starts again in a moment.',
    );
    await expect
      .poll(() => calls(page))
      .toEqual(['update_check', 'update_download', 'update_install']);
    expect(realErrors(errors)).toEqual([]);
  });

  test('says why the download did not work, and can try again', async ({ page }) => {
    const errors = collectErrors(page);
    await setUp(page, false, { updates: ITSELF });
    await setCheck(page, AVAILABLE);
    await page.evaluate(() => {
      (
        window as unknown as { __mockShell: { updates: { downloadFails: string } } }
      ).__mockShell.updates.downloadFails =
        'Atlas could not reach the update server. Check that this computer is online, then try again.';
    });
    await page.clock.runFor(6_000);
    await page.getByTestId('update-install').click();
    await page.clock.runFor(1_000);
    await expect(page.getByTestId('update-problem')).toHaveText(
      'Atlas could not reach the update server. Check that this computer is online, then try again.',
    );
    await expect(page.getByTestId('update-install')).toHaveText('Try again');
    expect(await calls(page)).toEqual(['update_check', 'update_download']);
    expect(realErrors(errors)).toEqual([]);
  });

  test('Settings checks, says what it found, and keeps the switch', async ({ page }) => {
    const errors = collectErrors(page);
    await setUp(page, false, { updates: ITSELF });
    const group = await openGroup(page);
    await expect(group.getByRole('heading')).toHaveText('Updates');
    await expect(page.getByTestId('update-version')).toHaveText('This is Atlas 0.26.0.');
    const atStart = page.getByTestId('update-at-start');
    await expect(atStart).toBeChecked();
    await expect(group).toContainText('Check for updates when Atlas starts');
    await expect(page.getByTestId('update-not-at-start')).toHaveCount(0);

    // Up to date.
    await page.getByTestId('update-check').click();
    await expect(page.getByTestId('update-result')).toHaveText('Atlas is up to date.');
    await shot(page, 'update-settings');

    // Offline: why, in a sentence.
    await setCheck(page, 'Atlas could not reach the update server.');
    await page.getByTestId('update-check').click();
    await expect(page.getByTestId('update-result')).toHaveText(
      'Atlas could not reach the update server.',
    );

    // A new version opens the notice, and the group can show it again.
    await setCheck(page, AVAILABLE);
    await page.getByTestId('update-check').click();
    await expect(page.getByTestId('update-result')).toHaveText('Atlas 0.27.0 is available.');
    await expect(page.getByTestId('update-notice')).toBeVisible();
    await page.getByTestId('update-skip').click();
    await expect(page.getByTestId('update-notice')).toHaveCount(0);
    await page.getByTestId('update-show').click();
    await expect(page.getByTestId('update-notice')).toBeVisible();
    await page.getByTestId('update-later').click();

    // The switch is kept for the next start.
    await atStart.click({ force: true });
    await expect(atStart).not.toBeChecked();
    // Settings are saved without waiting: wait for the save before the restart.
    await expect.poll(() => storedSetting(page, 'updateCheckAtStart')).toBe(false);
    await page.reload();
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    await page.clock.runFor(6_000);
    await openGroup(page);
    await expect(page.getByTestId('update-at-start')).not.toBeChecked();
    expect(realErrors(errors)).toEqual([]);
  });

  test('does not look at a start by Steam, and Settings still checks', async ({ page }) => {
    const errors = collectErrors(page);
    await setUp(page, false, {
      updates: { way: { way: 'itself', atStart: false }, platform: 'linux' },
    });
    await setCheck(page, AVAILABLE);
    await page.clock.runFor(10_000);
    await expect(page.getByTestId('update-notice')).toHaveCount(0);
    expect(await calls(page)).toEqual([]);
    await openGroup(page);
    await expect(page.getByTestId('update-not-at-start')).toContainText(
      'such as by Steam with a game',
    );
    await page.getByTestId('update-check').click();
    await expect(page.getByTestId('update-notice')).toBeVisible();
    await expect(page.getByTestId('update-notice')).toContainText(
      'replaces this version with the new one',
    );
    expect(realErrors(errors)).toEqual([]);
  });
});

test('a copy that does not update itself says where its updates come from', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page, DOWNLOADS_BUILD, {
    updates: { way: { way: 'elsewhere', from: 'system' }, platform: 'linux' },
  });
  await page.clock.runFor(10_000);
  expect(await calls(page)).toEqual([]);
  const group = await openGroup(page);
  await expect(page.getByTestId('update-elsewhere')).toHaveText(
    'Updates for this copy of Atlas come from your system’s software updates, since it was installed as a package. Atlas.AppImage from the Atlas releases page updates itself.',
  );
  await expect(group.getByTestId('update-check')).toHaveCount(0);
  await expect(group.getByTestId('update-at-start')).toHaveCount(0);
  await shot(page, 'update-settings-elsewhere');
  expect(realErrors(errors)).toEqual([]);
});

test('nothing of it in a browser, or from a shell that says nothing of updates', async ({
  page,
}) => {
  await openMap(page);
  await expect(page.getByTestId('update-notice')).toHaveCount(0);
  await expect(page.getByTestId('settings-updates')).toHaveCount(0);

  await setUp(page, DOWNLOADS_BUILD);
  await page.clock.runFor(10_000);
  expect(await calls(page)).toEqual([]);
  await page.getByTestId('section-settings').click();
  await expect(page.getByTestId('settings-screen')).toBeVisible();
  await expect(page.getByTestId('settings-updates')).toHaveCount(0);
});
