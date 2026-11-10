import { expect, test } from '@playwright/test';
import { collectErrors, openMap, overlayView, paintedMarkerPixels, waitForTiles } from './helpers';

interface PackLocation {
  id: string;
  name: string;
  x: number;
  y: number;
}

test('shows the demo map with tiles and 5,000 markers', async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  await openMap(page);

  const tiles = page.locator('.atlas-tiles img.leaflet-tile-loaded');
  const sizes = await tiles.evaluateAll((images) =>
    (images as HTMLImageElement[]).map((img) => `${img.naturalWidth}x${img.naturalHeight}`),
  );
  expect(new Set(sizes)).toEqual(new Set(['256x256']));

  const canvas = page.locator('.atlas-marker-canvas');
  const clusters = Number(await canvas.getAttribute('data-drawn-clusters'));
  const markers = Number(await canvas.getAttribute('data-drawn-markers'));
  expect(clusters + markers).toBeGreaterThan(10);
  expect(await paintedMarkerPixels(page)).toBeGreaterThan(1000);

  await testInfo.attach('map', { body: await page.screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
});

test('zooms with the mouse wheel', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page);
  const before = await overlayView(page);

  await page.mouse.move(640, 400);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -250);
    await page.waitForTimeout(150);
  }
  await expect
    .poll(async () => (await overlayView(page)).zoom)
    .toBeGreaterThanOrEqual(before.zoom + 1);
  await waitForTiles(page);
  // Two levels below 1:1 every marker is drawn on its own.
  await page.mouse.wheel(0, -1000);
  await expect.poll(async () => (await overlayView(page)).zoom).toBeGreaterThanOrEqual(3);
  await expect(page.locator('.atlas-marker-canvas')).toHaveAttribute('data-drawn-clusters', '0');
  await expect(page.locator('.atlas-marker-canvas')).not.toHaveAttribute('data-drawn-markers', '0');
  expect(errors).toEqual([]);
});

test('pans by dragging', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page, './#@4096,4096,3');
  const before = await overlayView(page);
  expect(before.zoom).toBe(3);

  // At zoom 3 one screen pixel is 4 image pixels; dragging left moves the view right.
  await page.mouse.move(800, 400);
  await page.mouse.down();
  await page.mouse.move(600, 400, { steps: 10 });
  await page.mouse.move(500, 400, { steps: 5 });
  await page.mouse.up();

  await expect.poll(async () => (await overlayView(page)).x).toBeGreaterThan(before.x + 1000);
  const after = await overlayView(page);
  expect(Math.abs(after.y - before.y)).toBeLessThan(50);
  await waitForTiles(page);
  expect(errors).toEqual([]);
});

test('selects a marker on click', async ({ page, request }) => {
  const errors = collectErrors(page);
  const response = await request.get('./packs/demo/locations.json');
  const locations = (await response.json()) as PackLocation[];
  // The location nearest the map centre, so the view is not clamped by the map edges.
  const target = locations.reduce((best, loc) =>
    Math.hypot(loc.x - 4096, loc.y - 4096) < Math.hypot(best.x - 4096, best.y - 4096) ? loc : best,
  );

  await openMap(page, `./#@${target.x},${target.y},5`);
  await expect(page.getByTestId('selected')).toHaveText('Nothing');
  const map = await page.getByTestId('map').boundingBox();
  if (!map) throw new Error('map has no size');
  await page.mouse.click(map.x + map.width / 2, map.y + map.height / 2);
  await expect(page.getByTestId('selected')).toContainText(target.name);

  // Clicking empty water far from any marker clears the selection.
  await page.goto('about:blank');
  await openMap(page, './#@300,300,5');
  await page.mouse.click(map.x + map.width / 2, map.y + map.height / 2);
  await expect(page.getByTestId('selected')).toHaveText('Nothing');
  expect(errors).toEqual([]);
});
