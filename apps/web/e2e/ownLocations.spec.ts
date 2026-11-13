import { expect, test, type Page } from '@playwright/test';
import {
  collectErrors,
  demoLocations,
  mapStatus,
  openMap,
  storedSetting,
  type PackLocation,
} from './helpers';
import { choosePlace, mapSettled } from './touch';

/**
 * Edit locations, in the standard layout on a computer (1280 by 800), in a
 * browser on the demo game: entering the mode on purpose, putting a
 * location of one's own on the map, its name, type, area and note, moving
 * it, a type and an area of one's own, deleting, Undo, leaving the mode,
 * and finding it all again after a reload. Then the list editor adds a
 * location of one's own from the map.
 */

const STANDARD = './?ui=standard';
const SETTING = 'ownLocations:demo';

/** An empty point of the map shown, in screen pixels: off every marker, the game's and one's own. */
async function emptyPoint(page: Page): Promise<{ x: number; y: number }> {
  await mapSettled(page);
  const text = (await storedSetting(page, SETTING)) as string | undefined;
  const mine = text ? (JSON.parse(text) as { locations: PackLocation[] }).locations : [];
  const places = [...(await demoLocations(page.request)), ...mine];
  const box = (await page.getByTestId('map').boundingBox())!;
  const view = await mapStatus(page);
  const scale = 2 ** (5 - view.zoom);
  const points = places
    .filter((p) => p.layerId === view.layer)
    .map((p) => ({
      x: box.x + box.width / 2 + (p.x - view.x) / scale,
      y: box.y + box.height / 2 + (p.y - view.y) / scale,
    }));
  // A point well inside the map, at least 30 screen pixels from any marker.
  for (let gy = 0.3; gy <= 0.8; gy += 0.05) {
    for (let gx = 0.2; gx <= 0.6; gx += 0.04) {
      const x = box.x + box.width * gx;
      const y = box.y + box.height * gy;
      if (points.every((p) => Math.hypot(p.x - x, p.y - y) > 30)) return { x, y };
    }
  }
  throw new Error('No empty point on the map');
}

/** A location of the game shown on the map now, in screen pixels, away from the edges. */
async function visibleGameLocation(page: Page): Promise<{ x: number; y: number }> {
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
  // Inside the map, below the bar over it, and apart from the others.
  const inside = points.filter(
    (p) =>
      p.x > box.x + 60 &&
      p.x < box.x + box.width - 80 &&
      p.y > box.y + 100 &&
      p.y < box.y + box.height - 60 &&
      points.every((q) => q === p || Math.hypot(q.x - p.x, q.y - p.y) > 24),
  );
  if (inside.length === 0) throw new Error('No location of the game on the map');
  return inside[0]!;
}

async function saved(page: Page): Promise<void> {
  await expect(page.getByTestId('locations-save-state')).toHaveAttribute('data-state', 'saved');
}

async function stored(page: Page): Promise<{
  locations: {
    id: string;
    name: string;
    categoryId: string;
    regionId: string | null;
    note?: string;
    x: number;
    y: number;
  }[];
  categories: { id: string; name: string; color: string; icon: string; groupId: string }[];
  categoryGroups: { id: string; name: string }[];
  regions: { id: string; name: string; mapId: string }[];
}> {
  const text = (await storedSetting(page, SETTING)) as string;
  return JSON.parse(text) as never;
}

test('Edit locations: drop, name, type, area, note, move, delete, undo, reload', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openMap(page, STANDARD);
  const count = page.getByTestId('marker-count');

  // Entered on purpose, with a clear way out.
  await page.getByTestId('edit-locations').click();
  const editor = page.getByTestId('location-editor');
  await expect(editor).toBeVisible();
  await expect(page.locator('.touch-panel')).toHaveAttribute('aria-label', 'Edit locations');
  await expect(page.getByTestId('locations-map-hint')).toHaveText(
    'Click the map to put a location there',
  );
  await expect(page.getByTestId('locations-undo')).toBeDisabled();

  // A click off the markers puts a location there, and its name takes the focus.
  const point = await emptyPoint(page);
  await page.mouse.click(point.x, point.y);
  const panel = page.getByTestId('location-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('location-name')).toBeFocused();
  await expect(count).toHaveText('5,001');
  await page.getByTestId('location-name').fill('Hidden spring');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('own-location-row')).toHaveText(/Hidden spring/);

  // Its type: one of the game's.
  await page.getByTestId('location-type').selectOption({ label: 'Waystone' });
  // Its note.
  await page.getByTestId('location-note').fill('Behind the **falls**.');
  await page.getByTestId('location-note').blur();
  await saved(page);
  let file = await stored(page);
  expect(file.locations).toHaveLength(1);
  expect(file.locations[0]).toMatchObject({
    name: 'Hidden spring',
    categoryId: 'demo:cat:waystone',
    note: 'Behind the **falls**.',
  });

  // A type of one's own: name, colour, icon, group; the location gets it.
  await page.getByTestId('location-new-type').click();
  const typePanel = page.getByTestId('type-panel');
  await expect(typePanel).toBeVisible();
  await expect(page.getByTestId('type-name')).toBeFocused();
  await page.getByTestId('type-name').fill('Spring');
  await typePanel.getByRole('radio', { name: 'Colour 6 of 12' }).check({ force: true });
  await typePanel.getByRole('radio', { name: 'Flask' }).check({ force: true });
  await page.getByTestId('type-group').selectOption({ label: 'A new group…' });
  await page.getByTestId('type-new-group').fill('Water');
  await page.getByTestId('save-type').click();
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('location-type')).toHaveValue(/:cat:own\./);
  await expect(page.getByTestId('own-type-row')).toHaveText(/Spring/);
  await expect(page.getByTestId('own-type-row')).toContainText('Water · one location');

  // An area of one's own; the location is in it.
  await page.getByTestId('location-new-area').click();
  await expect(page.getByTestId('area-name')).toBeFocused();
  await page.getByTestId('area-name').fill('Falls hollow');
  await page.getByTestId('save-area').click();
  await expect(page.getByTestId('location-area')).toHaveValue(/:region:own\./);
  await expect(page.getByTestId('own-area-row')).toHaveText('Falls hollow');
  await saved(page);
  file = await stored(page);
  expect(file.categories).toEqual([
    expect.objectContaining({ name: 'Spring', color: '#2aa3a3', icon: 'flask' }),
  ]);
  expect(file.categoryGroups).toEqual([expect.objectContaining({ name: 'Water' })]);
  expect(file.regions).toEqual([expect.objectContaining({ name: 'Falls hollow' })]);
  expect(file.locations[0]!.categoryId).toBe(file.categories[0]!.id);
  expect(file.locations[0]!.regionId).toBe(file.regions[0]!.id);

  // Moved by dragging the ring, and with the arrow keys.
  const before = file.locations[0]!;
  const handle = page.locator('.atlas-handle');
  await expect(handle).toBeVisible();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  await saved(page);
  file = await stored(page);
  expect(file.locations[0]!.x).toBeGreaterThan(before.x);
  expect(file.locations[0]!.y).toBeGreaterThan(before.y);
  const dragged = file.locations[0]!;
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(async () => (await stored(page)).locations[0]!.x, { timeout: 5000 })
    .toBeLessThan(dragged.x);

  // Undo takes the last change back.
  await expect(page.getByTestId('locations-undo')).toBeEnabled();
  await page.getByTestId('locations-undo').click();
  await saved(page);
  expect((await stored(page)).locations[0]!.x).toBe(dragged.x);

  // A location of the game is not changed here: a click on it says so,
  // and puts nothing new on the map.
  await page.getByTestId('close-side').click();
  await expect(panel).toHaveCount(0);
  const gamePoint = await visibleGameLocation(page);
  await page.mouse.click(gamePoint.x, gamePoint.y);
  await expect(page.getByTestId('game-location-panel')).toContainText('comes with the game');
  await expect(count).toHaveText('5,001');
  await page.getByTestId('close-side').click();

  // Deleted, and back with Undo on the notice.
  await page.getByTestId('own-location-row').click();
  await page.getByTestId('delete-location').click();
  await expect(count).toHaveText('5,000');
  await expect(page.getByTestId('own-location-row')).toHaveCount(0);
  await page.getByTestId('toast-action').click();
  await expect(count).toHaveText('5,001');
  await expect(page.getByTestId('own-location-row')).toHaveCount(1);

  // Done leaves the mode; the location stays on the map like any other.
  await page.getByTestId('locations-done').click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByTestId('edit-locations')).toBeFocused();
  await saved(page).catch(() => undefined);

  // After a reload it is all there: on the map, in search, with its note.
  await expect.poll(async () => (await stored(page)).locations.length).toBe(1);
  await page.reload();
  await expect(count).toHaveText('5,001');
  await choosePlace(page, 'Hidden spring');
  await expect(page.getByTestId('place-sheet')).toContainText('Hidden spring');
  await expect(page.getByTestId('place-sheet')).toContainText('Behind the falls.');
  expect(errors).toEqual([]);
});

/** Puts a location of one's own at an empty point and names it. */
async function dropLocation(page: Page, name: string): Promise<void> {
  const point = await emptyPoint(page);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId('location-name')).toBeFocused();
  await page.getByTestId('location-name').fill(name);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('own-location-row').filter({ hasText: name })).toHaveCount(1);
  await saved(page);
}

test('the list editor adds locations of one’s own: from the map, by type and by name', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openMap(page, STANDARD);
  await page.getByTestId('edit-locations').click();
  await dropLocation(page, 'Lookout stone');
  // A type of one's own, which the next location gets too.
  await page.getByTestId('location-new-type').click();
  await page.getByTestId('type-name').fill('Lookout');
  await page.getByTestId('save-type').click();
  await page.getByTestId('close-side').click();
  await dropLocation(page, 'Lookout ledge');
  await dropLocation(page, 'Lookout cairn');
  await expect(page.getByTestId('own-type-row')).toContainText('3 locations');
  await saved(page);
  await page.getByTestId('locations-done').click();
  const own = await stored(page);
  const stone = own.locations.find((l) => l.name === 'Lookout stone')!;

  // A list of one's own.
  await page.getByTestId('section-lists').click();
  await page.getByTestId('new-own-list').click();
  await page.getByTestId('own-list-name').fill('Lookouts');
  await page.getByTestId('template-dialog').getByTestId('template-collection').click();
  await page.getByTestId('template-dialog').getByTestId('template-start').click();
  await expect(page.getByTestId('list-editor')).toBeVisible();
  const rows = page.getByTestId('editor-rows').getByTestId('editor-row');

  // By name.
  await page.getByTestId('add-tab-search').click();
  await page.getByTestId('add-search-input').fill('Lookout ledge');
  await page.getByRole('button', { name: 'Add Lookout ledge', exact: true }).click();
  await expect(rows).toHaveCount(1);

  // From the map: a tap on the location of one's own.
  await page
    .getByTestId('editor-rows')
    .getByTestId('editor-row')
    .first()
    .locator('.editor-row-main')
    .click();
  await mapSettled(page);
  const view = await mapStatus(page);
  const box = (await page.getByTestId('map').boundingBox())!;
  const scale = 2 ** (5 - view.zoom);
  await page.mouse.click(
    box.x + box.width / 2 + (stone.x - view.x) / scale,
    box.y + box.height / 2 + (stone.y - view.y) / scale,
  );
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('Lookout stone');

  // By type: the third one, the others being in the list already.
  await page.getByTestId('editor-add').click();
  await page.getByTestId('add-tab-type').click();
  const lookouts = page.getByTestId('add-type-row').filter({ hasText: 'Lookout' });
  await expect(lookouts).toContainText('2 are already in the list');
  await lookouts.locator('input').check();
  await page.getByTestId('add-type-submit').click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText('Lookout cairn');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  expect(errors).toEqual([]);
});
