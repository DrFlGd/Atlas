import { devices, expect, test, type Page } from '@playwright/test';
import { collectErrors, demoLocations, openMap, type PackLocation } from './helpers';
import {
  back,
  choosePlace,
  expectFound,
  placeResult,
  pressAndHold,
  screenPoint,
  search,
} from './touch';

/**
 * The touch layout in a browser (?ui=touch), as the Android app shows it:
 * on a phone, and on a tablet.
 */

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];
const tablet = { viewport: { width: 1280, height: 800 }, hasTouch: true, isMobile: false };

async function openTouch(page: Page): Promise<void> {
  await openMap(page, './?ui=touch');
}

/** A place of the surface map whose kind is tracked, away from the edges of the island. */
async function surfacePlace(page: Page, kind = 'demo:cat:waystone'): Promise<PackLocation> {
  const places = await demoLocations(page.request);
  return places.find((l) => l.mapId === 'demo:map:world' && l.categoryId === kind)!;
}

/** Opens a place from search, then closes it again: the map is left on it. */
async function goToPlace(page: Page, place: PackLocation): Promise<void> {
  await choosePlace(page, place.name);
  expect(await back(page)).toBe(true);
  await expect(page.getByTestId('place-sheet')).toHaveCount(0);
}

test.describe('on a phone', () => {
  test.use(pixel);

  test('searches, ticks a place off from its row and undoes it', async ({ page }) => {
    const errors = collectErrors(page);
    await openTouch(page);
    await expect(page.locator('.touch')).toHaveAttribute('data-arrangement', 'compact');
    // The map's name is shown whole, on a row of its own when it has to be.
    const mapName = page.locator('.touch-map-chip-name');
    expect(await mapName.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const place = await surfacePlace(page);
    await search(page, place.name);
    await expect(page.getByTestId('search-summary')).toContainText(
      'nearest to the middle of the map first',
    );
    const row = placeResult(page, place.name);
    await row.getByTestId('result-tick').tap();
    await expect(row.getByTestId('result-tick')).toHaveAttribute('aria-pressed', 'true');
    await expectFound(page, 1);
    await expect(page.getByTestId('toast')).toContainText('Marked found');
    await page.getByTestId('toast-undo').tap();
    await expectFound(page, 0);
    await expect(row.getByTestId('result-tick')).toHaveAttribute('aria-pressed', 'false');

    // What was opened from search is offered again before typing.
    await row.locator('.touch-row-main').tap();
    await expect(page.getByTestId('selected-name')).toHaveText(place.name);
    await page.getByTestId('open-search').tap();
    await expect(page.getByTestId('recent-results')).toContainText(place.name);
    expect(errors).toEqual([]);
  });

  test('a tap on a marker opens it; mark found, undo, next nearest', async ({ page }) => {
    const errors = collectErrors(page);
    await openTouch(page);
    const place = await surfacePlace(page);
    await goToPlace(page, place);
    await page.touchscreen.tap(...xy(await screenPoint(page, place)));
    const sheet = page.getByTestId('place-sheet');
    await expect(sheet.getByTestId('selected-name')).toHaveText(place.name);
    await expect(sheet.getByTestId('place-where')).toContainText('found here');

    const found = sheet.getByTestId('mark-found');
    await found.tap();
    await expect(found).toHaveAttribute('aria-pressed', 'true');
    await expect(found).toHaveText('Found');
    await expectFound(page, 1);
    await page.getByTestId('toast-undo').tap();
    await expectFound(page, 0);
    await expect(found).toHaveAttribute('aria-pressed', 'false');

    // Pulled up, the sheet shows the rest; Back puts it down, then closes it.
    await sheet.getByTestId('place-details-row').tap();
    await expect(sheet.getByTestId('place-details')).toContainText('The Sundered Isle');
    expect(await back(page)).toBe(true);
    await expect(sheet.getByTestId('place-details')).toHaveCount(0);
    await expect(sheet).toBeVisible();

    await sheet.getByTestId('next-nearest').tap();
    await expect(sheet.getByTestId('selected-name')).not.toHaveText(place.name);
    expect(await back(page)).toBe(true);
    await expect(sheet).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('press and hold on a marker marks it found without opening it', async ({ page }) => {
    const errors = collectErrors(page);
    await openTouch(page);
    const place = await surfacePlace(page);
    await goToPlace(page, place);
    await pressAndHold(page, await screenPoint(page, place));
    await expectFound(page, 1);
    await expect(page.getByTestId('toast')).toContainText('Marked found');
    await expect(page.getByTestId('place-sheet')).toHaveCount(0);
    // Again: not found any more.
    await pressAndHold(page, await screenPoint(page, place));
    await expectFound(page, 0);
    await expect(page.getByTestId('toast')).toContainText('Marked not found');
    expect(errors).toEqual([]);
  });

  test('Nearest unfound opens the nearest place not found yet', async ({ page }) => {
    const errors = collectErrors(page);
    await openTouch(page);
    await page.getByTestId('nearest-unfound').tap();
    const sheet = page.getByTestId('place-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('mark-found')).toHaveAttribute('aria-pressed', 'false');
    // The chips and the button make way for the sheet.
    await expect(page.getByTestId('nearest-unfound')).toHaveCount(0);
    await expect(page.getByTestId('filters-chip')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a kind chip shows that kind alone, and puts the others back', async ({ page }) => {
    const errors = collectErrors(page);
    await openTouch(page);
    const count = page.getByTestId('marker-count');
    const chip = page.locator('[data-testid="kind-chip"][data-category="demo:cat:waystone"]');
    await chip.tap();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(count).not.toHaveText('5,000');
    await expect(page.getByTestId('filters-chip')).toContainText('hidden');
    await chip.tap();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await expect(count).toHaveText('5,000');
    await expect(page.getByTestId('filters-chip')).not.toContainText('hidden');
    expect(errors).toEqual([]);
  });

  test('filters: a kind off, hide found, show all', async ({ page }) => {
    const errors = collectErrors(page);
    await openTouch(page);
    const count = page.getByTestId('marker-count');
    await page.getByTestId('filters-chip').tap();
    const sheet = page.getByTestId('filters-sheet');
    const kind = sheet.locator('[data-testid="kind-switch"][data-category="demo:cat:waystone"]');
    await kind.tap();
    await expect(kind).toHaveAttribute('aria-checked', 'false');
    await expect(count).not.toHaveText('5,000');
    await sheet.getByTestId('show-all-kinds').tap();
    await expect(kind).toHaveAttribute('aria-checked', 'true');
    await expect(count).toHaveText('5,000');
    const hideFound = sheet.getByTestId('hide-found-switch');
    await hideFound.tap();
    await expect(hideFound).toHaveAttribute('aria-checked', 'true');
    expect(await back(page)).toBe(true);
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('hide-found-chip')).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
  });

  test('ticks a checklist entry and shows its place on the map', async ({ page }) => {
    const errors = collectErrors(page);
    await openTouch(page);
    await page.getByTestId('section-lists').tap();
    await page.getByTestId('list-link').filter({ hasText: 'Waystones' }).tap();
    const list = page.getByTestId('checklist-screen');
    // A collection opens by area; all of its entries, by kind, are a choice away.
    await list.getByTestId('view-kind').tap();
    await expect(list.getByTestId('checklist-done')).toHaveAttribute('data-done', '0');
    const first = list.getByTestId('check-item').first();
    await first.getByTestId('entry-tick').tap();
    await expect(first).toHaveAttribute('data-done', 'true');
    await expect(list.getByTestId('checklist-done')).toHaveAttribute('data-done', '1');

    await first.getByTestId('entry-show').tap();
    await expect(page.locator('.touch')).toHaveAttribute('data-section', 'map');
    await expectFound(page, 1);
    const sheet = page.getByTestId('place-sheet');
    await expect(sheet.getByTestId('mark-found')).toHaveAttribute('aria-pressed', 'true');
    // The list is still open: the next entry comes from it.
    await expect(sheet.getByTestId('next-on-list')).toBeVisible();
    await sheet.getByTestId('next-on-list').tap();
    await expect(sheet.getByTestId('mark-found')).toHaveAttribute('aria-pressed', 'false');

    // Back closes the place; Lists still has the list open, and Back goes to all lists.
    expect(await back(page)).toBe(true);
    await page.getByTestId('section-lists').tap();
    await expect(page.getByTestId('checklist-screen')).toBeVisible();
    expect(await back(page)).toBe(true);
    await expect(page.getByTestId('list-link').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Progress shows the figures, and a region opens on the map', async ({ page }) => {
    const errors = collectErrors(page);
    await openTouch(page);
    const place = await surfacePlace(page);
    await search(page, place.name);
    await placeResult(page, place.name).getByTestId('result-tick').tap();
    expect(await back(page)).toBe(true);
    const total = await page.getByTestId('progress-ring').getAttribute('data-total');
    await page.getByTestId('progress-ring').tap();
    const screen = page.getByTestId('progress-screen');
    const overall = screen.getByTestId('overall-progress');
    await expect(overall).toHaveAttribute('data-found', '1');
    await expect(overall).toHaveAttribute('data-total', total!);
    await expect(screen.getByTestId('profile-name')).not.toBeEmpty();
    await screen.getByTestId('region-progress').locator('button').first().tap();
    await expect(page.locator('.touch')).toHaveAttribute('data-section', 'map');
    expect(errors).toEqual([]);
  });

  test('Games lists the game and the settings', async ({ page }) => {
    const errors = collectErrors(page);
    await openTouch(page);
    await page.getByTestId('section-games').tap();
    const games = page.getByTestId('games-screen');
    const row = games.locator('[data-testid="game-row"][data-pack="demo"]');
    await expect(row).toHaveAttribute('data-current', 'true');
    // In a browser there is no file to import.
    await expect(games.getByTestId('import-pack-file')).toHaveCount(0);
    await games.getByRole('button', { name: 'Light', exact: true }).tap();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await games.getByRole('button', { name: 'Dark', exact: true }).tap();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(errors).toEqual([]);
  });

  test('Back closes what is on top, one thing at a time', async ({ page }) => {
    const errors = collectErrors(page);
    await openTouch(page);
    const root = page.locator('.touch');

    await page.getByTestId('open-search').tap();
    expect(await back(page)).toBe(true);
    await expect(page.getByTestId('search-input')).toHaveCount(0);

    await page.getByTestId('filters-chip').tap();
    expect(await back(page)).toBe(true);
    await expect(page.getByTestId('filters-sheet')).toHaveCount(0);

    await page.getByTestId('map-chip').tap();
    await expect(page.getByTestId('maps-menu')).toBeVisible();
    expect(await back(page)).toBe(true);
    await expect(page.getByTestId('maps-menu')).toHaveCount(0);

    await page.getByTestId('section-games').tap();
    expect(await back(page)).toBe(true);
    await expect(root).toHaveAttribute('data-section', 'map');

    // Nothing left: Back leaves the app.
    expect(await back(page)).toBe(false);
    expect(errors).toEqual([]);
  });

  test('turning the phone on its side brings the side panel', async ({ page }) => {
    const errors = collectErrors(page);
    await openTouch(page);
    const root = page.locator('.touch');
    await expect(page.locator('.touch-bar')).toBeVisible();
    await page.setViewportSize({ width: 915, height: 412 });
    await expect(root).toHaveAttribute('data-arrangement', 'wide');
    await expect(page.locator('.touch-rail')).toBeVisible();
    await expect(page.locator('.touch-panel')).toBeVisible();
    await expect(page.locator('.touch-bar')).toHaveCount(0);

    // Too short for a card over the map: the place is shown where the panel is.
    const place = await surfacePlace(page);
    await choosePlace(page, place.name);
    const sheet = (await page.getByTestId('place-sheet').boundingBox())!;
    const map = (await page.getByTestId('map').boundingBox())!;
    expect(sheet.x + sheet.width).toBeLessThanOrEqual(map.x + 1);
    const next = (await page.getByTestId('next-nearest').boundingBox())!;
    expect(next.x + next.width).toBeLessThanOrEqual(sheet.x + sheet.width);
    await expect(page.getByTestId('nearest-unfound')).toBeVisible();

    await page.setViewportSize({ width: 412, height: 915 });
    await expect(root).toHaveAttribute('data-arrangement', 'compact');
    await expect(page.locator('.touch-bar')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('on a tablet', () => {
  test.use(tablet);

  test('search and filters in the side panel, the place in a card beside', async ({ page }) => {
    const errors = collectErrors(page);
    await openTouch(page);
    await expect(page.locator('.touch')).toHaveAttribute('data-arrangement', 'wide');
    const panel = page.locator('.touch-panel');
    await expect(panel.getByTestId('filters-panel')).toBeVisible();

    const place = await surfacePlace(page);
    await choosePlace(page, place.name);
    const card = page.getByTestId('place-sheet');
    // The map stops with the place beside the card, not under it.
    await expect
      .poll(async () => {
        const point = await screenPoint(page, place);
        const box = (await card.boundingBox())!;
        return point.x > box.x - 20 && point.y > box.y - 20;
      })
      .toBe(false);
    // A wide screen shows the details at once.
    await expect(card.getByTestId('place-details')).toBeVisible();
    await expect(card.getByTestId('place-details-row')).toHaveCount(0);
    await card.getByTestId('mark-found').tap();
    await expectFound(page, 1);
    await expect(panel.getByTestId('filters-panel')).toBeVisible();

    // Lists in the panel; the map stays beside it.
    await page.getByTestId('section-lists').tap();
    await panel.getByTestId('list-link').filter({ hasText: 'Waystones' }).tap();
    await panel.getByTestId('view-kind').tap();
    const entry = panel.getByTestId('check-item').nth(1);
    await entry.getByTestId('entry-show').tap();
    await expect(page.locator('.touch')).toHaveAttribute('data-section', 'lists');
    await expect(card.getByTestId('next-on-list')).toBeVisible();
    await expect(page.getByTestId('map')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

function xy(point: { x: number; y: number }): [number, number] {
  return [point.x, point.y];
}
