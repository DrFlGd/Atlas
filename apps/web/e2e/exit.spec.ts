import type { Page } from '@playwright/test';
import { collectErrors, openMap } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, mock, realErrors, setUp } from './fakeShell';
import { reportMouse } from './touch';

/**
 * "Exit Atlas" (`src/library/ExitAtlas.tsx`), against the stand-in shell of
 * `fakeShell.ts`, which notes the call where the real shell ends the app.
 * Atlas really ending, and Game Mode on a Steam Deck, are only seen on the
 * device.
 */

test.use({ layout: 'standard' });

const exits = async (page: Page) =>
  (await mock(page)).background.calls.filter((call) => call.command === 'app_exit').length;

async function openSettings(page: Page) {
  await page.getByTestId('section-settings').click();
  await expect(page.getByTestId('settings-screen')).toBeVisible();
}

test('is at the head of Settings on Linux, asks first, and ends Atlas', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page, DOWNLOADS_BUILD, { exit: true });
  await openSettings(page);
  const button = page.getByTestId('exit-settings');
  await expect(button).toHaveText('Exit Atlas');

  await button.click();
  const dialog = page.getByTestId('exit-dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Exit Atlas?');
  await expect(dialog).toContainText('What you found and your settings are kept.');
  await expect(page.getByTestId('exit-confirm')).toBeFocused();
  await dialog.getByRole('button', { name: 'Stay' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await exits(page)).toBe(0);

  // Esc closes the question too, as B on a controller does.
  await button.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await button.click();
  await page.getByTestId('exit-confirm').click();
  await expect.poll(() => exits(page)).toBe(1);
  expect(realErrors(errors)).toEqual([]);
});

test('is not there where the window has its own close button', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page, DOWNLOADS_BUILD);
  await openSettings(page);
  await expect(page.getByTestId('settings-maps-folder')).toBeVisible();
  await expect(page.getByTestId('exit-settings')).toHaveCount(0);
  expect(realErrors(errors)).toEqual([]);
});

test('is not there in a browser', async ({ page }) => {
  await openMap(page);
  await expect(page.getByTestId('exit-settings')).toHaveCount(0);
  await expect(page.getByTestId('exit-rail')).toHaveCount(0);
});

test.describe('on Windows, in the app without downloads', () => {
  test.skip(DOWNLOADS_BUILD, 'Only the app without downloads keeps running in the background.');

  test('is there while Atlas keeps running when its window is closed', async ({ page }) => {
    const errors = collectErrors(page);
    await setUp(page, false, { background: true });
    await openSettings(page);
    await expect(page.getByTestId('settings-background')).toBeVisible();
    await expect(page.getByTestId('exit-settings')).toHaveCount(0);
    await page.getByTestId('background-keepRunning-switch').click({ force: true });
    await expect(page.getByTestId('exit-settings')).toBeVisible();
    await page.getByTestId('exit-settings').click();
    await page.getByTestId('exit-confirm').click();
    await expect.poll(() => exits(page)).toBe(1);
    expect(realErrors(errors)).toEqual([]);
  });
});

test.describe('on a Steam Deck', () => {
  test.use({
    layout: null,
    viewport: { width: 1280, height: 800 },
    screen: { width: 1280, height: 800 },
    hasTouch: true,
    isMobile: false,
  });
  test.skip(DOWNLOADS_BUILD, 'The Steam Deck build is the app without downloads.');

  test('is at the head of the rail, reached with a finger and with the controller', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await reportMouse(page);
    await setUp(page, false, { exit: true, steamLaunch: { state: 'usual', line: 'bash' } });
    await expect(page.locator('.touch')).toHaveAttribute('data-handheld', '');
    const rail = page.getByTestId('exit-rail');
    const box = (await rail.boundingBox())!;
    expect(box.y).toBeLessThan(80);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);

    await rail.tap();
    const dialog = page.getByTestId('exit-dialog');
    await expect(dialog).toBeVisible();
    // The D-pad (the arrow keys) moves between the dialog's two buttons, and A (Enter) presses.
    await expect(page.getByTestId('exit-confirm')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(dialog.getByRole('button', { name: 'Stay' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    expect(await exits(page)).toBe(0);

    // The focus moved with the keys reaches the button in Settings too.
    await page.getByTestId('section-settings').tap();
    await page.getByTestId('exit-settings').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('exit-confirm')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => exits(page)).toBe(1);
    expect(realErrors(errors)).toEqual([]);
  });
});
