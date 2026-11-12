import type { Page } from '@playwright/test';
import { collectErrors, demoLocations, mapStatus, openMap, type PackLocation } from './helpers';
import { expect, test } from './layout';
import { choosePlace, expectFound, mapSettled, screenPoint } from './touch';

/**
 * The standard layout on a computer: the default in the desktop app and a
 * browser, made for a mouse and keyboard. (On a touch screen and in the
 * Android app it is made for fingers: see touch.spec.ts and android.spec.ts.)
 * The classic layout stays a setting away.
 */

// The setting decides, as for a person who has never asked for a layout.
test.use({ layout: null });

const root = (page: Page) => page.locator('.touch');

async function surfacePlace(page: Page, kind = 'demo:cat:waystone'): Promise<PackLocation> {
  const places = await demoLocations(page.request);
  return places.find((l) => l.mapId === 'demo:map:world' && l.categoryId === kind)!;
}

/** Opens a place from search and closes it again, so the map is left on it. */
async function goToPlace(page: Page, place: PackLocation): Promise<{ x: number; y: number }> {
  await choosePlace(page, place.name);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('place-sheet')).toHaveCount(0);
  await mapSettled(page);
  return screenPoint(page, place);
}

test('opens in the standard layout, and the classic one is a setting away', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page);
  await expect(root(page)).toHaveAttribute('data-input', 'mouse');
  await expect(root(page)).toHaveAttribute('data-arrangement', 'wide');
  await expect(page.locator('.topbar')).toHaveCount(0);

  // Games › Settings › Layout: Classic. It stays after a reload, like the theme.
  await page.getByTestId('section-games').click();
  const setting = page.getByTestId('layout-setting');
  await expect(setting.getByTestId('layout-standard')).toHaveAttribute('aria-pressed', 'true');
  await setting.getByTestId('layout-classic').click();
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-ui', 'touch');
  await page.reload();
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
  await expect(page.locator('.topbar')).toBeVisible();

  // And back, from the classic top bar.
  await page.getByTestId('use-standard-layout').click();
  await expect(root(page)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
  await expect(root(page)).toBeVisible();

  // The address can ask for either for the rest of the session (previews, tests).
  await openMap(page, './?ui=classic');
  await expect(page.locator('.topbar')).toBeVisible();
  await openMap(page, './');
  await expect(page.locator('.topbar')).toBeVisible();
  await openMap(page, './?ui=desktop');
  await expect(page.locator('.topbar')).toBeVisible();
  // Choosing in the settings wins over what the address asked for.
  await page.getByTestId('use-standard-layout').click();
  await expect(root(page)).toHaveAttribute('data-input', 'mouse');
  expect(new URL(page.url()).searchParams.get('ui')).toBeNull();
  await openMap(page, './');
  await expect(root(page)).toBeVisible();
  // ?ui=touch is the Android app's interface: made for fingers.
  await openMap(page, './?ui=touch');
  await expect(root(page)).toHaveAttribute('data-input', 'touch');
  await openMap(page, './?ui=standard');
  await expect(root(page)).toHaveAttribute('data-input', 'mouse');
  expect(errors).toEqual([]);
});

test('a place shows its name on hover; a right click marks it found, with Undo', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openMap(page);
  const place = await surfacePlace(page);
  const point = await goToPlace(page, place);

  await page.mouse.move(point.x, point.y);
  await expect(page.locator('.marker-tooltip')).toHaveText(place.name);
  await page.mouse.move(point.x + 200, point.y + 120);
  await expect(page.locator('.marker-tooltip')).toHaveCount(0);

  // A right click marks it at once, as holding it does on a touch screen.
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expectFound(page, 1);
  const toast = page.getByTestId('toast');
  await expect(toast).toContainText('Marked found');
  await expect(page.getByTestId('place-sheet')).toHaveCount(0);
  await expect(toast.getByTestId('toast-undo')).toHaveAttribute('title', 'Undo (Z)');
  await toast.getByTestId('toast-undo').click();
  await expectFound(page, 0);
  // Again marks it found, and again takes it back.
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expectFound(page, 1);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expectFound(page, 0);
  await expect(toast).toContainText('Marked not found');

  // A click shows the place.
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId('selected-name')).toHaveText(place.name);
  expect(errors).toEqual([]);
});

test('zooms with the wheel and with the zoom buttons', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page, './#@4096,4096,2');
  const zoomIn = page.locator('.leaflet-control-zoom-in');
  await expect(zoomIn).toBeVisible();
  // Clear of the map's own controls at the top.
  const top = (await page.locator('.touch-map-top').boundingBox())!;
  const buttons = (await page.locator('.leaflet-control-zoom').boundingBox())!;
  expect(buttons.y).toBeGreaterThanOrEqual(top.y + top.height);

  const start = (await mapStatus(page)).zoom;
  await zoomIn.click();
  await expect.poll(async () => (await mapStatus(page)).zoom).toBeGreaterThan(start);
  await mapSettled(page);
  const afterButton = (await mapStatus(page)).zoom;
  await page.locator('.leaflet-control-zoom-out').click();
  await expect.poll(async () => (await mapStatus(page)).zoom).toBeLessThan(afterButton);
  await mapSettled(page);

  const box = (await page.getByTestId('map').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const beforeWheel = (await mapStatus(page)).zoom;
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await mapStatus(page)).zoom).toBeGreaterThan(beforeWheel);
  expect(errors).toEqual([]);
});

test('the classic keys work and are shown, and Esc closes what is on top', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page);
  const input = page.getByTestId('search-input');
  await expect(input).toHaveAttribute('placeholder', /\( \/ \)$/);

  // `/` goes to search, Esc empties it and then closes it.
  await page.keyboard.press('/');
  await expect(input).toBeFocused();
  await input.fill('Waystone');
  await expect(page.getByTestId('search-result').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('filters-panel')).toBeVisible();
  await input.blur();

  // N: the nearest place not yet found, with its keys on the card.
  await page.keyboard.press('n');
  const card = page.getByTestId('place-sheet');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('mark-found').locator('kbd')).toHaveText('F');
  await expect(card.getByTestId('next-nearest').locator('kbd')).toHaveText('N');
  await expect(page.getByTestId('nearest-unfound').locator('kbd')).toHaveText('N');

  // F marks it, Z undoes.
  await page.keyboard.press('f');
  await expectFound(page, 1);
  await expect(card.getByTestId('mark-found')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('z');
  await expectFound(page, 0);
  await page.keyboard.press('Control+z');
  await expectFound(page, 0);

  // C: the lists, and back.
  await expect(page.getByTestId('section-lists')).toHaveAttribute(
    'title',
    'Checklists and guides (C)',
  );
  await page.keyboard.press('c');
  await expect(root(page)).toHaveAttribute('data-section', 'lists');
  await page.keyboard.press('c');
  await expect(root(page)).toHaveAttribute('data-section', 'map');

  // Esc: the list of maps, then the place, one at a time.
  await page.getByTestId('map-chip').click();
  await expect(page.getByTestId('maps-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('maps-menu')).toHaveCount(0);
  await expect(card).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  // A list page, then the section.
  await page.keyboard.press('c');
  await page.getByTestId('list-link').filter({ hasText: 'Waystones' }).click();
  await expect(page.getByTestId('checklist-screen')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('checklist-screen')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(root(page)).toHaveAttribute('data-section', 'map');

  // ?: the list of keys, from the key or the rail; Esc closes it.
  await page.keyboard.press('?');
  const keys = page.getByTestId('keys-dialog');
  await expect(keys).toBeVisible();
  await expect(keys.locator('kbd')).toHaveText(['/', 'N', 'F', 'Z', 'C', 'Esc', '?']);
  await expect(keys).toContainText('Right-click a place');
  await page.keyboard.press('Escape');
  await expect(keys).toBeHidden();
  await page.getByTestId('keys-button').click();
  await expect(keys).toBeVisible();
  await keys.getByRole('button', { name: 'Close' }).click();
  await expect(keys).toBeHidden();
  // Keys do nothing while a dialog is open or while typing.
  await page.getByTestId('section-games').click();
  await page.getByTestId('open-keys').click();
  await expect(keys).toBeVisible();
  await page.keyboard.press('n');
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('follows the window from a large screen to a narrow one', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openMap(page);
  const noSideways = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  for (const [width, height] of [
    [1920, 1080],
    [1366, 768],
    [1024, 700],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(root(page)).toHaveAttribute('data-arrangement', 'wide');
    await expect(page.locator('.touch-rail')).toBeVisible();
    const panel = (await page.locator('.touch-panel').boundingBox())!;
    expect(panel.width).toBe(360);
    const map = (await page.getByTestId('map').boundingBox())!;
    expect(map.x).toBeGreaterThanOrEqual(panel.x + panel.width - 1);
    expect(map.width).toBeGreaterThan(500);
    await expect(page.locator('.leaflet-control-zoom')).toBeVisible();
    expect(await noSideways()).toBe(true);
  }

  // A small window: the map fills it, with a bar of sections at the bottom.
  await page.setViewportSize({ width: 700, height: 760 });
  await expect(root(page)).toHaveAttribute('data-arrangement', 'compact');
  await expect(page.locator('.touch-bar')).toBeVisible();
  await expect(page.locator('.touch-rail')).toHaveCount(0);
  await expect(page.getByTestId('open-search')).toBeVisible();
  await expect(page.locator('.leaflet-control-zoom')).toBeVisible();
  expect(await noSideways()).toBe(true);
  // A short one too: not a phone on its side, so still compact.
  await page.setViewportSize({ width: 700, height: 500 });
  await expect(root(page)).toHaveAttribute('data-arrangement', 'compact');

  // Search and the place work there as well.
  await page.setViewportSize({ width: 700, height: 760 });
  const place = await surfacePlace(page);
  await choosePlace(page, place.name);
  await expect(page.getByTestId('place-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('place-sheet')).toHaveCount(0);
  await page.keyboard.press('/');
  await expect(page.getByTestId('search-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search-input')).toHaveCount(0);

  // Wide again: the rail and panel come back.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(root(page)).toHaveAttribute('data-arrangement', 'wide');
  await expect(page.getByTestId('filters-panel')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the filters and lists do all the classic panes did', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page);
  const panel = page.locator('.touch-panel');

  // Hide all, then Reset filters (back to the pack's own choice).
  await panel.getByTestId('hide-all-kinds').click();
  await expect(page.getByTestId('marker-count')).toHaveText('0');
  await panel.getByTestId('reset-filters').click();
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');

  // A long list can be searched and filtered by region and category.
  await page.getByTestId('section-lists').click();
  await panel.getByTestId('list-link').filter({ hasText: 'Waystones' }).click();
  const items = panel.getByTestId('check-item');
  await panel.getByTestId('list-search').fill('Thornwood waystone 1');
  await expect(items.first()).toContainText('Attune Thornwood waystone 1');
  await panel.getByTestId('list-search').fill('no such waystone');
  await expect(panel).toContainText('No entries match the filters.');
  await panel.getByTestId('list-search').fill('');
  await panel.getByTestId('list-facets-toggle').click();
  const facets = panel.getByTestId('checklist-facets');
  await facets.getByRole('button', { name: 'Deselect all regions' }).click();
  await expect(panel).toContainText('No entries match the filters.');
  await expect(panel.getByTestId('list-facets-toggle')).toContainText(/\(\d+ off\)/);
  await facets.getByRole('button', { name: 'Select all regions', exact: true }).click();
  await expect(items.first()).toBeVisible();

  // An entry's note, and an entry's several places, open under it.
  await page.keyboard.press('Escape');
  await panel.getByTestId('list-link').filter({ hasText: 'The Sundered Isle story' }).click();
  const story = items.filter({ hasText: 'Wake on the shore' });
  await story.getByTestId('entry-more').click();
  await expect(story.getByTestId('entry-more-body')).toContainText('Start near');
  // Its link to a place shows the place.
  await story.getByTestId('entry-more-body').getByText('the first waystone').click();
  await expect(page.getByTestId('selected-name')).toHaveText('Thornwood waystone 1');

  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await panel.getByTestId('list-link').filter({ hasText: 'Lore of the isle' }).click();
  await panel.getByTestId('list-search').fill('Defeat 3 elite foes in Emberfall Vale');
  const lore = items.filter({ hasText: 'Defeat 3 elite foes in Emberfall Vale' });
  await lore.getByTestId('entry-more').click();
  const places = lore.locator('.touch-entry-places button');
  await expect(places).toHaveCount(3);
  await places.nth(1).click();
  await expect(page.getByTestId('place-sheet')).toBeVisible();
  expect(errors).toEqual([]);
});

test('profiles, and progress export and import, from the rail', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page);
  await page.keyboard.press('n');
  await page.keyboard.press('f');
  await expectFound(page, 1);

  await page.locator('.touch-rail-profile').click();
  const dialog = page.getByTestId('profile-dialog');
  await expect(dialog).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Export all profiles' }).click(),
  ]);
  const file = await download.path();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.keyboard.press('f');
  await expectFound(page, 0);
  // Also from Games, where a narrow window has no rail.
  await page.getByTestId('section-games').click();
  await page.getByTestId('profiles-row').click();
  await dialog.getByTestId('import-file').setInputFiles(file);
  await dialog.getByRole('radio', { name: /Replace/ }).check();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByTestId('import-review')).toHaveCount(0);
  await expectFound(page, 1);
  expect(errors).toEqual([]);
});
