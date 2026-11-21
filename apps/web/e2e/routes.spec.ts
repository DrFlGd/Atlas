import { devices, expect, test, type Page } from '@playwright/test';
import { collectErrors, mapStatus, openMap, reloadSaved } from './helpers';
import { mapSettled } from './touch';

/**
 * Routes: the demo pack's "The lantern path" (six steps, a free point, a
 * bend around a ridge, the last two on the second map), followed step by
 * step with the line drawn on the map; a copy of it changed in the route
 * editor; and the bar over the map on a phone.
 */

const STANDARD = './?ui=standard';
const LANTERN = 'The lantern path';

async function openRoute(page: Page): Promise<void> {
  await page.getByTestId('section-lists').click();
  const section = page.getByTestId('map-routes');
  await expect(section.getByRole('heading')).toHaveText('Routes on the map');
  await section.getByTestId('route-link').filter({ hasText: LANTERN }).click();
  await expect(page.getByTestId('route-screen')).toBeVisible();
}

test('a route of the pack, followed step by step across two maps', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page, STANDARD);
  await openRoute(page);
  const screen = page.getByTestId('route-screen');
  const done = page.getByTestId('route-done');
  await expect(done).toContainText('Walkthrough · 0 of 6 steps done · 2 maps');
  await expect(page.getByTestId('route-current')).toContainText('Step 1 of 6');
  await expect(page.getByTestId('route-steps').getByTestId('route-step')).toHaveCount(6);

  // The line and the four steps on the surface map, the open one larger.
  await expect(page.locator('.atlas-route-step')).toHaveCount(4);
  await expect(page.locator('.atlas-route-step-current')).toHaveText('1');
  await expect(page.locator('.atlas-route-line')).toHaveCount(1);

  // Ticking a step on a location marks it found, and it stays after a reload.
  await page.getByTestId('route-tick').click();
  await expect(done).toHaveAttribute('data-done', '1');
  await expect(page.getByTestId('route-tick')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.atlas-route-step-done')).toHaveCount(1);

  // Next opens the free point, which has a tick of its own.
  await page.getByTestId('route-next').click();
  await page.getByTestId('route-next').click();
  await expect(page.getByTestId('route-current')).toContainText('Step 3 of 6');
  await expect(page.getByTestId('route-current')).toContainText('The stone circle');
  await page.getByTestId('route-tick').click();
  await expect(done).toHaveAttribute('data-done', '2');

  // A step on the second map shows that map, and the route's steps on it.
  await page.getByTestId('route-steps').getByTestId('route-step').nth(4).click();
  await expect(page.getByTestId('route-current')).toContainText('Step 5 of 6');
  await expect.poll(async () => (await mapStatus(page)).layer).toContain('deep');
  await expect(page.locator('.atlas-route-step')).toHaveCount(2);

  await reloadSaved(page);
  await openRoute(page);
  await expect(done).toHaveAttribute('data-done', '2');
  await expect(screen).toBeVisible();
  // A pack's route is not changed, but copied.
  await expect(page.getByTestId('edit-route')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a copy of a route changed in the editor: title, a free point, a bend', async ({ page }) => {
  const errors = collectErrors(page);
  // The map on open water, far from every location.
  await openMap(page, `${STANDARD}#@300,300,5`);
  await openRoute(page);
  await page.getByTestId('copy-route').click();
  const editor = page.getByTestId('route-editor');
  await expect(editor).toBeVisible();
  await expect(page.getByTestId('route-title')).toHaveValue(`${LANTERN} (my copy)`);
  await page.getByTestId('route-title').fill('My lantern path');
  await page.getByTestId('route-title').press('Tab');
  await page.getByTestId('route-type').selectOption('collection');
  const steps = editor.getByTestId('route-editor-step');
  await expect(steps).toHaveCount(6);

  // Step 1 is open: a press on the map adds a step after it.
  await expect(steps.first()).toHaveAttribute('aria-current', 'true');
  await page.getByTestId('route-add-steps').click();
  await expect(page.getByTestId('route-add-steps')).toHaveAttribute('aria-pressed', 'true');
  await mapSettled(page);
  const box = (await page.getByTestId('map').boundingBox())!;
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(middle.x + 70, middle.y + 50);
  await expect(steps).toHaveCount(7);
  await expect(steps.nth(1)).toHaveAttribute('aria-current', 'true');
  await page.getByTestId('route-add-steps').click();
  await page.getByTestId('route-step-title').fill('The old mill');
  await page.getByTestId('route-step-text').fill('Look for the *broken* wheel.');

  // Move it down, then bend the line to it.
  await steps.nth(1).getByTestId('route-step-down').click();
  await expect(steps.nth(2)).toContainText('The old mill');
  await expect(steps.nth(2)).toHaveAttribute('aria-current', 'true');
  await steps.nth(2).getByTestId('route-step-bend').click();
  await page.mouse.click(middle.x - 60, middle.y + 90);
  await expect(steps.nth(2).getByTestId('route-step-bend')).toHaveText('Done bending');
  // Its corner, and the two of the bend the copy came with.
  await expect(page.locator('.atlas-route-corner')).toHaveCount(3);
  await steps.nth(2).getByTestId('route-step-straighten').click();
  await expect(page.locator('.atlas-route-corner')).toHaveCount(2);

  // Done: the route is the person's own, listed after the pack's.
  await page.getByTestId('route-editor-done').click();
  await expect(page.getByTestId('route-done')).toContainText('Collection · 0 of 7 steps done');
  await reloadSaved(page);
  await page.getByTestId('section-lists').click();
  const links = page.getByTestId('map-routes').getByTestId('route-link');
  await expect(links).toHaveCount(2);
  await expect(links.nth(1)).toContainText('My lantern path');

  // Deleting it can be undone.
  await links.nth(1).click();
  await page.getByTestId('edit-route').click();
  await page.getByTestId('delete-route').click();
  await expect(links).toHaveCount(1);
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];
  test.use(pixel);

  test('the route open in Lists shows a bar over the map', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page, './?ui=touch');
    await openRoute(page);
    // Routes are followed on a phone, not made.
    await expect(page.getByTestId('copy-route')).toHaveCount(0);
    await expect(page.getByTestId('new-route')).toHaveCount(0);
    await page.getByTestId('section-map').click();
    const bar = page.getByTestId('route-bar');
    await expect(bar).toContainText(`${LANTERN} · Step 1 of 6`);
    await bar.getByRole('button', { name: 'Next step' }).click();
    await expect(bar).toContainText('Step 2 of 6');
    await bar.getByTestId('route-step-tick').click();
    await expect(bar.getByTestId('route-step-tick')).toHaveAttribute('aria-checked', 'true');
    await bar.locator('.route-bar-text').click();
    await expect(page.getByTestId('route-current')).toContainText('Step 2 of 6');
    expect(errors).toEqual([]);
  });
});
