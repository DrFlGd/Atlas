import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, mock, paste, realErrors, setUp, url } from './fakeShell';

/**
 * The Library of the desktop app, against the stand-in shell of
 * `fakeShell.ts`: the games with their type and one line on their state,
 * the game open on the right with its cards, More with a sentence for
 * each thing it does, Settings, and adding a map from its box. In the
 * classic layout it fills the window; in the standard layout it is a
 * section (see `standardDesktop.spec.ts`).
 */

test('the folder button opens the Library over the whole window', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page);
  await page.getByTestId('maps-button').click();
  const library = page.getByTestId('library');
  await expect(library).toBeVisible();

  // The games, each with its type and one line on its state; the one shown is open.
  const demo = library.locator('[data-testid="library-game"][data-pack="demo"]');
  await expect(demo).toContainText('Shown');
  await expect(demo).toContainText('Maps');
  // Its state: what it holds, or in a build with downloads, what is left to download.
  await expect(demo.getByTestId('library-status')).toContainText(
    DOWNLOADS_BUILD ? 'Nothing to download' : 'maps,',
  );
  const pane = page.getByTestId('library-game-pane');
  await expect(pane).toHaveAttribute('data-pack', 'demo');
  await expect(pane.getByTestId('library-contents-card')).toContainText('locations');
  // A build without downloads has no map image or photo cards (`downloads.spec.ts` covers them).
  if (!DOWNLOADS_BUILD) {
    await expect(pane.getByTestId('library-images-card')).toHaveCount(0);
    await expect(pane.getByTestId('library-photos-card')).toHaveCount(0);
  }

  // More: each thing it does has a sentence; Esc closes it, and only it.
  await pane.getByTestId('library-more').click();
  const more = page.getByTestId('library-more-menu');
  const rows = more.getByRole('menuitem');
  expect(await rows.count()).toBeGreaterThan(0);
  for (const row of await rows.all()) {
    await expect(row.locator('.library-more-sentence')).not.toBeEmpty();
  }
  await page.keyboard.press('Escape');
  await expect(more).toBeHidden();
  await expect(library).toBeVisible();

  // Settings, on the right: the maps folder and the folders elsewhere, each said in a sentence.
  await page.getByTestId('library-settings').click();
  const settings = page.getByTestId('settings-screen');
  await expect(settings.getByTestId('maps-folder-path')).toBeVisible();
  await expect(settings.getByTestId('settings-locations')).toContainText(
    'Remove from list forgets it and does not delete any files.',
  );
  // The classic layout's own bar has the theme and the layout.
  await expect(settings.getByTestId('layout-setting')).toHaveCount(0);
  await demo.click();
  await expect(pane).toBeVisible();

  // Esc closes the Library.
  await page.keyboard.press('Escape');
  await expect(library).toBeHidden();
  expect(realErrors(errors)).toEqual([]);
});

test('adds a map from the box, opens it, and shows its map', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page);
  // "Add a map or a wiki" opens the Library on the steps of adding.
  await paste(page, url('test-valley', 'east-field'));
  const flow = page.getByTestId('library-flow');
  await expect(flow).toHaveAttribute('data-phase', 'idle');
  await page.getByTestId('add-map-start').click();
  await expect(flow).toHaveAttribute('data-phase', 'done');
  expect((await mock(page)).reports.map((r) => r.outcome)).toEqual(['added']);

  // Open Test Valley: the game, with what it holds.
  await page.getByTestId('add-map-done').click();
  await expect(flow).toBeHidden();
  const pane = page.getByTestId('library-game-pane');
  await expect(pane).toHaveAttribute('data-pack', 'test-valley');
  await expect(pane.getByTestId('library-facts')).toContainText('Added with Demo map site');
  const row = page.locator('[data-testid="library-game"][data-pack="test-valley"]');
  await expect(row).toHaveAttribute('aria-current', 'true');

  // Show the map: the Library closes on the game.
  await pane.getByTestId('library-show').click();
  await expect(page.getByTestId('library')).toBeHidden();
  await expect(page.getByTestId('map-status')).toBeVisible();
  expect(realErrors(errors)).toEqual([]);
});

test('More names the delete row for maps, and deletes only these maps after asking', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await setUp(page);
  await paste(page, url('test-valley', 'east-field'));
  await page.getByTestId('add-map-start').click();
  const flow = page.getByTestId('library-flow');
  await expect(flow).toHaveAttribute('data-phase', 'done');
  await page.getByTestId('add-map-done').click();
  const pane = page.getByTestId('library-game-pane');
  await expect(pane).toHaveAttribute('data-pack', 'test-valley');

  // The row says what it is and that only it goes; maps have no row to start again.
  await pane.getByTestId('library-more').click();
  const more = page.getByTestId('library-more-menu');
  const row = more.getByTestId('delete-pack');
  await expect(row.locator('.library-more-title')).toHaveText('Delete these maps');
  await expect(row.locator('.library-more-sentence')).toHaveText(
    'Deletes only these maps: their folder with the maps, locations and images. You are asked first, and told what happens to the marks you made.',
  );
  await expect(more.getByTestId('restart-wiki')).toHaveCount(0);
  await row.click();

  // Asked first: named for the maps, only they go, and nothing is said of a wiki's site.
  const confirm = pane.getByTestId('delete-pack-confirm');
  await expect(confirm).toHaveAttribute('data-kind', 'maps');
  await expect(confirm).toContainText('Delete the maps of Test Valley?');
  await expect(confirm.getByTestId('delete-pack-only')).toHaveText(
    'Only these maps are deleted. Your other games stay.',
  );
  await expect(confirm.getByTestId('delete-pack-site')).toHaveCount(0);
  await confirm.getByTestId('confirm-delete-pack').click();
  await expect(page.locator('[data-testid="library-game"][data-pack="test-valley"]')).toHaveCount(
    0,
  );
  expect((await mock(page)).events.filter((e) => e.what === 'delete').map((e) => e.url)).toEqual([
    'test-valley',
  ]);
  expect(realErrors(errors)).toEqual([]);
});
