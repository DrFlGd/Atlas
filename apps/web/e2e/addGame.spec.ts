import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { SITE, mock, openedPages, paste, realErrors, rows, setMock, setUp, url } from './fakeShell';
import { collectErrors } from './helpers';

/**
 * "Add a map" with a game's address, a site's list of games, and "Update
 * from the site…", against a stand-in for the desktop shell
 * (`fakeShell.ts`) and the made-up demo importer.
 */

const SHOTS = 'test-results/add-game';
const GAME = `${SITE}/test-valley`;
/** The demo importer's list of worlds; the fake shell answers for it. */
const CATALOGUE = 'http://127.0.0.1:4432/demo-maps';

// Each page waits a few seconds, with the pause between pages.
test.describe.configure({ timeout: 120_000 });

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

const choicePages = (page: Page) => page.getByTestId('add-map-choose-page');
const dialog = (page: Page) => page.getByTestId('add-map-dialog');

/** Each page in the choice: its title, kind, state and whether it is ticked. */
async function choiceRows(page: Page) {
  const pages = choicePages(page);
  const found: string[] = [];
  for (let i = 0; i < (await pages.count()); i++) {
    const row = pages.nth(i);
    const box = row.getByRole('checkbox');
    const ticked = (await box.isChecked()) ? 'ticked' : 'unticked';
    const disabled = (await box.isDisabled()) ? ', disabled' : '';
    found.push(
      `${await row.locator('label').innerText()} | ${await row.getAttribute('data-kind')} | ${await row.getAttribute('data-state')} | ${ticked}${disabled}`,
    );
  }
  return found;
}

test('adds the maps and checklist of a game from its game page, and updates it later', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await setUp(page);

  // A game address cannot come with other addresses.
  await paste(page, `${GAME}\n${url('test-valley', 'east-field')}`);
  await page.getByTestId('add-map-start').click();
  await expect(page.getByTestId('add-map-error')).toContainText(
    'A game address, or the address of a list of games, has to be added on its own',
  );
  expect((await mock(page)).events).toEqual([]);

  // On its own, the game page is read, and its pages are listed to choose from.
  await setMock(page, { hold: ['test-valley'] });
  await page.getByTestId('add-map-url').fill(GAME);
  await page.getByTestId('add-map-start').click();
  await expect(dialog(page)).toHaveAttribute('data-phase', 'listing');
  await expect(page.getByTestId('add-map-listing')).toContainText(
    'Reading the list of the game’s pages…',
  );
  await setMock(page, { hold: [] });
  await expect(dialog(page)).toHaveAttribute('data-phase', 'choose');
  expect(await choiceRows(page)).toEqual([
    'East Field | map | new | ticked',
    'West Ridge | map | new | ticked',
    'Where to start | guides | off | unticked, disabled',
    'Every beacon | checklists | new | ticked',
  ]);
  await expect(choicePages(page).nth(2)).toContainText('Not supported yet');
  await expect(page.getByTestId('add-map-choose-confirm')).toHaveText('Add 3 pages');
  await page.screenshot({ path: `${SHOTS}/1-choose.png` });

  // Leave West Ridge for later: its row of the checklist is left out until then.
  await choicePages(page).nth(1).getByRole('checkbox').uncheck();
  await expect(page.getByTestId('add-map-choose-confirm')).toHaveText('Add 2 pages');
  await page.getByTestId('add-map-choose-confirm').click();
  await expect(dialog(page)).toHaveAttribute('data-run', 'finished', { timeout: 30_000 });
  await expect(rows(page).nth(0)).toContainText('Added “East Field” to Test Valley');
  await expect(rows(page).nth(1)).toContainText(
    'Added “Every beacon” to Test Valley, a checklist of 1 item (1 left out until their maps are added)',
  );
  await expect(page.getByTestId('add-map-summary')).toHaveText('2 pages added.');

  // One page at a time, the game page first, with the pause between all of them.
  expect(await openedPages(page)).toEqual([
    GAME,
    url('test-valley', 'east-field'),
    `${GAME}/checklists/beacons`,
  ]);
  const { events, reports } = await mock(page);
  expect(events.find((event) => event.what === 'open')?.purpose).toBe('game');
  expect(reports[0]).toMatchObject({
    outcome: 'game-listed',
    pages: [GAME],
    kinds: { map: 2, guides: 1, checklists: 1 },
    alreadyAdded: 0,
  });

  // Later the site has a new map. "Update from the site…" reads the game page again.
  await setMock(page, { extra: { 'test-valley': { 'north-lake': 'North Lake' } } });
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByTestId('maps-button').click();
  // The dialog's foot and the app's name say which app and version this is.
  await expect(page.getByTestId('app-version')).toHaveText('Atlas 0.0.0');
  await expect(page.locator('.brand')).toHaveAttribute('title', 'Atlas 0.0.0');
  const row = page.locator('[data-testid="pack-row"][data-pack="test-valley"]');
  await expect(page.getByTestId('update-all')).toBeVisible();
  await row.getByTestId('update-pack').click();
  await expect(dialog(page)).toHaveAttribute('data-phase', 'choose', { timeout: 30_000 });
  await expect(page.getByTestId('add-map-choose')).toHaveAttribute('data-mode', 'update');
  expect(await choiceRows(page)).toEqual([
    'East Field | map | added | ticked',
    'West Ridge | map | new | ticked',
    'North Lake | map | new | ticked',
    'Where to start | guides | off | unticked, disabled',
    'Every beacon | checklists | added | ticked',
  ]);
  await expect(choicePages(page).nth(0)).toContainText('Already added (will be refreshed)');
  await page.screenshot({ path: `${SHOTS}/2-update.png` });
  await expect(page.getByTestId('add-map-choose-confirm')).toHaveText('Update 4 pages');
  await page.getByTestId('add-map-choose-confirm').click();
  await expect(page.getByTestId('add-map-run')).toContainText('Updating 4 pages');
  await expect(dialog(page)).toHaveAttribute('data-run', 'finished', { timeout: 60_000 });
  await expect(page.getByTestId('add-map-summary')).toHaveText('2 pages added, 2 refreshed.');
  // The checklist now has both rows, as West Ridge is in the game.
  await expect(rows(page).nth(3)).toContainText('a checklist of 2 items');

  const log = (await mock(page)).reports.map((r) => r.outcome);
  expect(log.slice(log.indexOf('update-started'))).toEqual([
    'update-started',
    'game-listed',
    'run-started',
    'updated',
    'added',
    'added',
    'updated',
    'run-finished',
  ]);
  expect(realErrors(errors)).toEqual([]);
});

test('lists the games of the site to tick, then their maps', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page);
  await page.getByTestId('add-map-button').click();
  const browse = page.getByTestId('add-map-browse-games');
  await expect(browse).toHaveText('All worlds of the demo map site…');
  await browse.click();

  await expect(dialog(page)).toHaveAttribute('data-phase', 'catalogue', { timeout: 30_000 });
  const games = page.getByTestId('add-map-catalogue-game');
  await expect(games).toHaveCount(3);
  await expect(page.getByTestId('add-map-catalogue')).toContainText('3 games on Demo map site.');
  // Nothing is ticked to start with.
  await expect(page.getByTestId('add-map-catalogue-confirm')).toHaveText('Tick the games to add');
  await expect(page.getByTestId('add-map-catalogue-confirm')).toBeDisabled();
  await page.getByTestId('add-map-catalogue-search').fill('hills');
  await expect(games).toHaveCount(1);
  await expect(games.first()).toContainText('One map');
  await games.first().getByRole('checkbox').check();
  await page.getByTestId('add-map-catalogue-search').fill('');
  await page.locator('[data-game="test-valley"]').getByRole('checkbox').check();
  await expect(page.getByTestId('add-map-catalogue-confirm')).toHaveText('Read 1 game page');
  await page.screenshot({ path: `${SHOTS}/3-catalogue.png` });
  await page.getByTestId('add-map-catalogue-confirm').click();

  // The game page of Test Valley is read; Test Hills has one map and needs none.
  await expect(dialog(page)).toHaveAttribute('data-phase', 'choose', { timeout: 30_000 });
  const chosenGames = page.getByTestId('add-map-choose-game');
  await expect(chosenGames).toHaveCount(2);
  // In the order of the list of games.
  await expect(chosenGames.nth(0)).toContainText('Test Valley');
  await expect(chosenGames.nth(1)).toContainText('Test Hills');
  await expect(page.getByTestId('add-map-choose-confirm')).toHaveText('Add 4 pages');
  await page.getByTestId('add-map-choose-confirm').click();
  await expect(dialog(page)).toHaveAttribute('data-run', 'finished', { timeout: 60_000 });
  await expect(page.getByTestId('add-map-summary')).toHaveText('4 pages added.');

  const origin = 'http://127.0.0.1:4432/demo-maps';
  expect(await openedPages(page)).toEqual([
    CATALOGUE,
    `${origin}/test-valley`,
    `${origin}/test-valley/east-field`,
    `${origin}/test-valley/west-ridge`,
    `${origin}/test-valley/checklists/beacons`,
    `${origin}/test-hills/high-pass`,
  ]);
  const { events, reports } = await mock(page);
  expect(events.filter((e) => e.what === 'open').map((e) => e.purpose ?? 'map')).toEqual([
    'catalogue',
    'game',
    'map',
    'map',
    'map',
    'map',
  ]);
  expect(reports[0]).toMatchObject({ outcome: 'catalogue-listed', games: 3, alreadyAdded: 0 });

  // The list marks the games that are in the maps folder now.
  await page.getByRole('button', { name: 'Add more maps' }).click();
  await page.getByTestId('add-map-browse-games').click();
  await expect(dialog(page)).toHaveAttribute('data-phase', 'catalogue', { timeout: 30_000 });
  await expect(page.locator('[data-game="test-valley"]')).toContainText('In your maps folder');
  await expect(page.locator('[data-game="demo"]')).not.toContainText('In your maps folder');
  expect(realErrors(errors)).toEqual([]);
});

test('"Update all" lists the games added from web pages, and reads each game page', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await setUp(page);
  await paste(page, `${url('test-valley', 'east-field')}\n${url('test-hills', 'high-pass')}`);
  await page.getByTestId('add-map-start').click();
  await expect(dialog(page)).toHaveAttribute('data-run', 'finished', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByTestId('maps-button').click();
  await page.getByTestId('update-all').click();
  await expect(dialog(page)).toHaveAttribute('data-phase', 'update-games');
  const games = page.getByTestId('add-map-update-game');
  await expect(games).toHaveCount(2);
  await expect(games.nth(0)).toContainText('Reads its game page on Demo map site.');
  await expect(page.getByTestId('add-map-update-confirm')).toHaveText('Read 2 game pages');
  await games.nth(1).getByRole('checkbox').uncheck();
  await expect(page.getByTestId('add-map-update-confirm')).toHaveText('Read 1 game page');
  await games.nth(1).getByRole('checkbox').check();
  await page.screenshot({ path: `${SHOTS}/4-update-all.png` });
  await page.getByTestId('add-map-update-confirm').click();

  await expect(dialog(page)).toHaveAttribute('data-phase', 'choose', { timeout: 60_000 });
  await expect(page.getByTestId('add-map-choose-game')).toHaveCount(2);
  // Both games' maps, the new ones too; one go.
  expect(await choiceRows(page)).toEqual([
    'East Field | map | added | ticked',
    'West Ridge | map | new | ticked',
    'Where to start | guides | off | unticked, disabled',
    'Every beacon | checklists | new | ticked',
    'High Pass | map | added | ticked',
  ]);
  // Untick everything: nothing to update.
  for (let i = 0; i < 5; i++) {
    const box = page.getByTestId('add-map-choose-page').nth(i).getByRole('checkbox');
    if (await box.isEnabled()) await box.uncheck();
  }
  await expect(page.getByTestId('add-map-choose-confirm')).toBeDisabled();
  await page.getByTestId('add-map-choose-page').nth(4).getByRole('checkbox').check();
  await expect(page.getByTestId('add-map-choose-confirm')).toHaveText('Update 1 map');
  await page.getByTestId('add-map-choose-confirm').click();
  await expect(dialog(page)).toHaveAttribute('data-run', 'finished', { timeout: 30_000 });
  await expect(page.getByTestId('add-map-summary')).toHaveText('1 map refreshed.');

  const reports = (await mock(page)).reports;
  const started = reports.find((r) => r.outcome === 'update-started');
  expect(started).toMatchObject({ games: 2 });
  expect(started?.pages).toEqual([`${SITE}/test-valley`, `${SITE}/test-hills`]);
  expect(reports.filter((r) => r.outcome === 'run-started').at(-1)).toMatchObject({
    update: true,
  });
  expect(realErrors(errors)).toEqual([]);
});
