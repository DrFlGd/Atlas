import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { mock, realErrors, setUp, url } from './fakeShell';

/**
 * The desktop app's own sections in the standard layout, against the
 * stand-in shell of `fakeShell.ts`: the Library (the games, adding a map
 * or a wiki, each game's More) and Settings (the maps folder, the
 * activity log, the keys). The flows of adding are covered by the classic
 * specs (addMaps, addGame, packFiles, downloads, saves), which reach the
 * same Library over the whole window; this checks that each is reachable
 * here and works.
 */

test.use({ layout: 'standard' });

test('adds a map in the Library, then finds it in the list of games', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page);
  await expect(page.locator('.touch')).toHaveAttribute('data-input', 'mouse');
  // The desktop app has a Library and Settings, and no Games.
  await expect(page.getByTestId('section-games')).toHaveCount(0);
  await page.getByTestId('section-library').click();
  const library = page.getByTestId('library');
  await expect(library.getByTestId('library-add-box')).toBeVisible();

  // Add a map or a wiki: the box on the left, the steps on the right.
  await page.getByTestId('add-map-url').fill(url('test-valley', 'east-field'));
  await page.getByTestId('add-map-url').press('Enter');
  const flow = page.getByTestId('library-flow');
  await expect(flow).toHaveAttribute('data-phase', 'done');
  await expect(page.getByTestId('add-map-game')).toHaveText('Test Valley');
  expect((await mock(page)).reports.map((r) => r.outcome)).toEqual(['added']);
  await flow.getByTestId('library-flow-close').click();
  await expect(flow).toBeHidden();

  // The new game is on the list of games; opening it shows what it is.
  const row = library.locator('[data-testid="library-game"][data-pack="test-valley"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Maps');
  await row.click();
  const pane = page.getByTestId('library-game-pane');
  await expect(pane).toHaveAttribute('data-pack', 'test-valley');
  await expect(pane.getByTestId('library-facts')).toContainText('1 map');

  // More: each thing it does, with a sentence.
  await pane.getByTestId('library-more').click();
  const more = page.getByTestId('library-more-menu');
  await expect(more.getByTestId('update-pack')).toContainText('Check the site for changes');
  await expect(more.getByTestId('update-pack')).toContainText('Nothing changes until you choose');
  await expect(more.getByTestId('export-pack')).toBeVisible();

  // Check the site for changes: the game's pages to choose from.
  await more.getByTestId('update-pack').click();
  await expect(more).toBeHidden();
  await expect(flow).toHaveAttribute('data-phase', 'choose', { timeout: 30_000 });
  await expect(page.getByTestId('add-map-choose')).toHaveAttribute('data-mode', 'update');
  await flow.getByTestId('library-flow-close').click();
  await expect(flow).toBeHidden();

  // Show the map: shows the game and leaves the Library for its map.
  await row.click();
  await pane.getByTestId('library-show').click();
  await expect(page.locator('.touch')).toHaveAttribute('data-section', 'map');
  await expect(page.getByTestId('library')).toBeHidden();
  expect(realErrors(errors)).toEqual([]);
});

test('Settings: the maps folder, the activity log and the list of keys', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page);
  await page.getByTestId('section-settings').click();
  const settings = page.getByTestId('settings-screen');
  await expect(settings.getByTestId('app-version')).toHaveText('Atlas 0.0.0');
  await expect(settings.getByTestId('maps-folder-path')).toBeVisible();
  await expect(settings.getByTestId('settings-locations')).toContainText('Map packs elsewhere');
  await settings.getByTestId('open-activity-log').click();
  const log = page.getByTestId('log-dialog');
  await expect(log).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(log).toBeHidden();
  await page.getByTestId('open-keys').click();
  await expect(page.getByTestId('keys-dialog')).toBeVisible();
  expect(realErrors(errors).filter((e) => !e.includes('activity_log_read'))).toEqual([]);
});
