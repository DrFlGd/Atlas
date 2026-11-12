import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { mock, realErrors, setUp, url } from './fakeShell';

/**
 * The desktop app's own tools in the standard layout, against the stand-in
 * shell of `fakeShell.ts`: they are the classic layout's dialogs, reached
 * from Games (Add a map, Maps, the activity log) and the rail. The flows
 * inside each dialog are covered by the classic specs (addMaps, addGame,
 * packFiles, downloads, saves); this checks that each is reachable here
 * and works.
 */

test.use({ layout: 'standard' });

test('adds a map from Games, then finds it in Maps and in the list of games', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page);
  await expect(page.locator('.touch')).toHaveAttribute('data-input', 'mouse');
  await page.getByTestId('section-games').click();
  const tools = page.getByTestId('library-tools');
  await expect(tools.getByTestId('add-map-button')).toContainText('Add a map');

  // Add a map: the same dialog as the classic top bar's.
  await tools.getByTestId('add-map-button').click();
  const dialog = page.getByTestId('add-map-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('add-map-url').fill(url('test-valley', 'east-field'));
  await page.getByTestId('add-map-url').press('Enter');
  await expect(dialog).toHaveAttribute('data-phase', 'done');
  await expect(page.getByTestId('add-map-game')).toHaveText('Test Valley');
  expect((await mock(page)).reports.map((r) => r.outcome)).toEqual(['added']);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();

  // The new game is on the list of games, and shown.
  const games = page.getByTestId('games-screen');
  const row = games.locator('[data-testid="game-row"][data-pack="test-valley"]');
  await expect(row).toBeVisible();

  // Maps: the folder, the packs, updating from the site.
  await tools.getByTestId('maps-button').click();
  const maps = page.getByTestId('maps-dialog');
  await expect(maps).toBeVisible();
  await expect(maps.getByTestId('app-version')).toHaveText('Atlas 0.0.0');
  await expect(maps.getByTestId('maps-folder-path')).toBeVisible();
  const pack = maps.locator('[data-testid="pack-row"][data-pack="test-valley"]');
  await expect(pack.getByTestId('update-pack')).toBeVisible();
  await expect(pack.getByTestId('export-pack')).toBeVisible();
  // Esc closes the dialog, then nothing else is closed with it.
  await page.keyboard.press('Escape');
  await expect(maps).toBeHidden();
  await expect(page.locator('.touch')).toHaveAttribute('data-section', 'games');

  // Update from the site… opens Add a map on the game's pages.
  await tools.getByTestId('maps-button').click();
  await pack.getByTestId('update-pack').click();
  await expect(dialog).toHaveAttribute('data-phase', 'choose', { timeout: 30_000 });
  await expect(page.getByTestId('add-map-choose')).toHaveAttribute('data-mode', 'update');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();

  // Switch games from the list.
  await row.locator('.touch-game-main').click();
  await expect(row).toHaveAttribute('data-current', 'true');
  expect(realErrors(errors)).toEqual([]);
});

test('the activity log and the list of keys, from Games', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page);
  await page.getByTestId('section-games').click();
  await page.getByTestId('open-activity-log').click();
  const log = page.getByTestId('log-dialog');
  await expect(log).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(log).toBeHidden();
  await page.getByTestId('open-keys').click();
  await expect(page.getByTestId('keys-dialog')).toBeVisible();
  expect(realErrors(errors).filter((e) => !e.includes('activity_log_read'))).toEqual([]);
});
