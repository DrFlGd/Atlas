import { devices, type Page } from '@playwright/test';
import {
  collectErrors,
  demoLocations,
  mapStatus,
  openGuidesSection,
  openMap,
  storedSetting,
} from './helpers';
import { expect, test } from './layout';
import { choosePlace, mapSettled } from './touch';

/**
 * Entries of a wiki page on the map, in the standard layout, on the demo
 * pack's made-up wiki: the small map mark after a location's name in the
 * first column of the "Stone wardens" table, which shows the location; a
 * page linked to several locations, whose mark lists them with "Show all
 * on the map"; "Put entries on the map", which puts "The hermit stone"
 * (on no map) on the map as a location of one's own linked to the page;
 * and the other way, "Add to a wiki page…" on a location's card, which
 * links it to a page of the wiki or puts a link to it on a page of one's
 * own.
 */

test.use({ layout: 'standard' });

const STANDARD = './?ui=standard';
const shownPage = (page: Page) => page.getByTestId('guides-page');
const marks = (page: Page) => shownPage(page).locator('.map-entry:not(.map-entry-add)');

async function openWardens(page: Page): Promise<void> {
  await page.getByTestId('section-guides').click();
  await openGuidesSection(page, 'The isle');
  await openGuidesSection(page, 'Foes');
  await page
    .getByTestId('guides-body')
    .getByTestId('guides-page-link')
    .filter({ hasText: 'Stone wardens' })
    .first()
    .click();
  await expect(shownPage(page).locator('h1')).toHaveText('Stone wardens');
}

/** An empty point of the map shown, in screen pixels: off every marker. */
async function emptyPoint(page: Page): Promise<{ x: number; y: number }> {
  await mapSettled(page);
  const places = await demoLocations(page.request);
  const box = (await page.getByTestId('map').boundingBox())!;
  const view = await mapStatus(page);
  const scale = 2 ** (5 - view.zoom);
  const points = places
    .filter((p) => p.layerId === view.layer)
    .map((p) => ({
      x: box.x + box.width / 2 + (p.x - view.x) / scale,
      y: box.y + box.height / 2 + (p.y - view.y) / scale,
    }));
  for (let gy = 0.3; gy <= 0.8; gy += 0.05) {
    for (let gx = 0.2; gx <= 0.6; gx += 0.04) {
      const x = box.x + box.width * gx;
      const y = box.y + box.height * gy;
      if (points.every((p) => Math.hypot(p.x - x, p.y - y) > 30)) return { x, y };
    }
  }
  throw new Error('No empty point on the map');
}

test('a location’s name in a table shows it on the map; a page with several lists them', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openMap(page, STANDARD);
  await openWardens(page);

  // The two waystones of the table's first column, and nothing for the stone on no map.
  await expect(marks(page)).toHaveCount(2);
  await expect(shownPage(page).locator('.map-entry-add')).toHaveCount(0);
  const name = (await marks(page).first().getAttribute('data-map-label'))!;
  expect(name).toMatch(/waystone/u);
  await expect(marks(page).first()).toHaveAttribute('aria-label', `Show ${name} on the map`);
  await marks(page).first().click();
  await expect(page.getByTestId('selected-name')).toHaveText(name);

  // Stone wardens linked to every warden from a card: a link to the page lists them.
  await choosePlace(page, 'Stone warden 12');
  await page.getByTestId('search-wiki').click();
  await page
    .getByTestId('wiki-search-hit')
    .filter({ hasText: 'Stone wardens' })
    .getByTestId('wiki-search-link')
    .click();
  await page.getByTestId('link-every-location').click();
  await page.getByTestId('section-guides').click();
  await openGuidesSection(page, 'Basics');
  await page
    .getByTestId('guides-body')
    .getByTestId('guides-page-link')
    .filter({ hasText: 'Welcome to the Sundered Isle' })
    .first()
    .click();
  const wardens = shownPage(page).locator('.map-entry[data-map-entry-kind="page"]');
  await expect(wardens).toHaveCount(1);
  await wardens.click();
  const menu = page.getByTestId('entry-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText(/stone wardens · \d+ locations/u);
  await expect(menu.getByTestId('entry-menu-location')).toHaveCount(8);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(wardens).toBeFocused();
  await wardens.click();
  await menu.getByTestId('entry-menu-all').click();
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(page.getByTestId('page-only-chip')).toContainText('Only stone wardens');
  expect(errors).toEqual([]);
});

test('an entry on no map put there, linked to its page; a link added to a page of one’s own', async ({
  page,
}) => {
  const errors = collectErrors(page);
  // The map on open water, far from every location.
  await openMap(page, `${STANDARD}#@300,300,5`);
  await openWardens(page);
  await page.getByTestId('put-entries').click();
  await expect(page.getByTestId('put-entries')).toHaveAttribute('aria-pressed', 'true');
  const hermit = shownPage(page).locator('.map-entry-add[data-map-add="The hermit stone"]');
  await expect(hermit).toHaveCount(1);
  // Instructions in a list are no entries.
  await expect(shownPage(page).locator('li .map-entry-add')).toHaveCount(0);

  await hermit.click();
  await expect(page.getByTestId('location-editor')).toBeVisible();
  await expect(page.getByTestId('locations-map-hint')).toContainText(
    'Press the map where “The hermit stone” is',
  );
  const point = await emptyPoint(page);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId('location-name')).toHaveValue('The hermit stone');
  await expect(page.getByTestId('location-entry-page')).toContainText('Stone wardens');
  // The first location of one's own asks for its type.
  await page.getByTestId('location-type').selectOption({ label: 'Waystone' });
  await page.getByTestId('add-location').click();
  await expect(page.getByTestId('location-panel')).toBeVisible();
  await page.getByTestId('locations-done').click();
  await choosePlace(page, 'The hermit stone');
  await expect(page.getByTestId('from-the-wiki')).toContainText('Stone wardens');

  // A page of one's own, then a link to the location put on it from the card.
  await page.getByTestId('section-guides').click();
  await page.getByTestId('edit-page').click();
  await page.getByTestId('new-page').click();
  await page.getByTestId('page-title').fill('My stones');
  await page.getByTestId('save-page').click();
  await expect(shownPage(page).locator('h1')).toHaveText('My stones');

  await page.getByTestId('section-map').click();
  await choosePlace(page, 'The hermit stone');
  await page.getByTestId('from-the-wiki').getByTestId('search-wiki').click();
  await expect(page.getByTestId('own-page-choice')).toHaveValue(/:guide:own\./u);
  await page.getByTestId('own-page-add-link').click();
  await expect(page.getByTestId('page-editor')).toBeVisible();
  await expect(page.getByTestId('page-title')).toHaveValue('My stones');
  await page.getByTestId('save-page').click();
  const mark = shownPage(page).locator('.map-entry[data-map-entry-kind="location"]');
  await expect(mark).toHaveAttribute('data-map-label', 'The hermit stone');
  await expect
    .poll(async () => {
      const text = (await storedSetting(page, 'ownPages:demo')) as string | undefined;
      return text ? (JSON.parse(text) as { pages: { body?: string }[] }).pages[0]?.body : null;
    })
    .toMatch(/^\[The hermit stone\]\(demo:loc:own\.[^)]+\)\n?$/u);
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];
  test.use(pixel);

  test('the marks show locations, and entries are not put on the map', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('./?ui=touch');
    await openWardens(page);
    await expect(marks(page)).toHaveCount(2);
    await expect(page.getByTestId('put-entries')).toHaveCount(0);
    const name = (await marks(page).first().getAttribute('data-map-label'))!;
    await marks(page).first().click();
    await expect(page.getByTestId('selected-name')).toHaveText(name);
    expect(errors).toEqual([]);
  });
});
