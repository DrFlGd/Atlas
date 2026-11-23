import type { Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, realErrors, setUp } from './fakeShell';

/**
 * Settings, "Atlas in Steam", against the stand-in shell of
 * `fakeShell.ts`, which answers as the shell's `steam` module does. Writing
 * Steam's own files is tested in the shell's Rust tests; a real Steam is
 * only tried on a real computer. Only the app without downloads has this
 * group.
 */

test.use({ layout: 'standard' });
test.skip(DOWNLOADS_BUILD, 'Only the viewer adds itself to Steam.');

const FOLDER = 'C:\\Program Files (x86)\\Steam';

function status(more: Record<string, unknown> = {}) {
  return {
    folder: FOLDER,
    running: false,
    gameMode: false,
    users: [{ id: '22202', name: 'Someone', recent: true }],
    user: '22202',
    refused: null,
    wanted: false,
    waiting: false,
    inSteam: false,
    byHand: false,
    kept: [],
    ...more,
  };
}

async function openGroup(page: Page) {
  await page.getByTestId('section-settings').click();
  await expect(page.getByTestId('settings-screen')).toBeVisible();
  const group = page.getByTestId('settings-steam');
  await expect(group).toBeVisible();
  await expect(group.getByRole('heading')).toHaveText('Atlas in Steam');
  return group;
}

function calls(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __mockShell: { steam: { calls: unknown[] } } }).__mockShell.steam
        .calls,
  );
}

test('is not offered where the shell does not say so', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page, false);
  await page.getByTestId('section-settings').click();
  await expect(page.getByTestId('settings-maps-folder')).toBeVisible();
  await expect(page.getByTestId('settings-steam')).toHaveCount(0);
  expect(realErrors(errors)).toEqual([]);
});

test('adds Atlas to Steam while Steam is closed, and takes it out again', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page, false, { steam: status() });
  const group = await openGroup(page);
  await expect(page.getByTestId('steam-found')).toHaveText(
    `Steam is in ${FOLDER}. Atlas uses the Steam user Someone.`,
  );
  await expect(page.getByTestId('steam-user')).toHaveCount(0);
  await expect(page.getByTestId('steam-restart')).toHaveCount(0);
  await page.getByTestId('steam-add').click();
  await expect(page.getByTestId('steam-state')).toHaveText('Atlas is in Steam with its artwork.');
  await page.getByTestId('steam-remove').click();
  await expect(page.getByTestId('steam-add')).toBeVisible();
  await expect(page.getByTestId('steam-state')).toHaveCount(0);
  expect(await calls(page)).toEqual([
    { command: 'steam_set', args: { on: true, user: '22202' } },
    { command: 'steam_set', args: { on: false, user: null } },
  ]);
  await expect(group).not.toContainText(/\bTap\b|\bClick\b|\u2014/);
  expect(realErrors(errors)).toEqual([]);
});

test('waits for Steam to close, and restarts Steam to add it', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page, false, { steam: status({ running: true }) });
  await openGroup(page);
  await page.getByTestId('steam-add').click();
  await expect(page.getByTestId('steam-state')).toHaveText('Waiting for Steam to close.');
  await expect(page.getByTestId('steam-restart-help')).toHaveText(
    'Steam has to be closed for this. Press Restart Steam and add it, and Steam closes, Atlas adds itself, and Steam starts again.',
  );
  await page.getByTestId('steam-restart').click();
  await expect(page.getByTestId('steam-restarting')).toBeVisible();
  await page.clock.runFor(3500);
  await expect(page.getByTestId('steam-state')).toHaveText('Atlas is in Steam with its artwork.');
  await expect(page.getByTestId('steam-restart')).toHaveCount(0);
  expect((await calls(page)).map((c) => (c as { command: string }).command)).toEqual([
    'steam_set',
    'steam_restart',
  ]);
  expect(realErrors(errors)).toEqual([]);
});

test('says that Steam comes back by itself in Game Mode', async ({ page }) => {
  await setUp(page, false, {
    steam: status({ running: true, gameMode: true, wanted: true, waiting: true }),
  });
  await openGroup(page);
  await expect(page.getByTestId('steam-restart-help')).toHaveText(
    'Steam has to be closed for this. Press Restart Steam and add it, and Steam closes, Atlas adds itself, and Steam comes back by itself. Atlas closes with Steam.',
  );
  await expect(page.getByTestId('steam-remove')).toBeVisible();
});

test('lets the person choose among several Steam users', async ({ page }) => {
  await setUp(page, false, {
    steam: status({
      users: [
        { id: '22202', name: 'Someone', recent: true },
        { id: '1234', name: 'Other', recent: false },
      ],
    }),
  });
  await openGroup(page);
  await page.getByTestId('steam-user').selectOption('1234');
  await page.getByTestId('steam-add').click();
  await expect(page.getByTestId('steam-found')).toHaveText(
    `Steam is in ${FOLDER}. Atlas uses the Steam user Other.`,
  );
  expect(await calls(page)).toEqual([{ command: 'steam_set', args: { on: true, user: '1234' } }]);
});

test('says when Steam is not here', async ({ page }) => {
  await setUp(page, false, {
    steam: status({ folder: null, users: [], user: null }),
  });
  await openGroup(page);
  await expect(page.getByTestId('steam-found')).toHaveText("Steam isn't on this computer.");
  await expect(page.getByTestId('steam-add')).toHaveCount(0);
});

test('says why Atlas cannot add itself', async ({ page }) => {
  const refused =
    "Atlas is not running from an AppImage, so it can't add itself to Steam. Start Atlas.AppImage and come back here.";
  await setUp(page, false, { steam: status({ refused }) });
  await openGroup(page);
  await expect(page.getByTestId('steam-refused')).toHaveText(refused);
  await expect(page.getByTestId('steam-add')).toBeDisabled();
});
