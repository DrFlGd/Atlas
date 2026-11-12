import { expect, type Page } from '@playwright/test';
import { mapStatus } from './helpers';

/** Helpers for the touch layout (the Android app, or a browser with ?ui=touch). */

/** Whether the touch layout shows its side panel (a tablet, or a phone on its side). */
export async function isWide(page: Page): Promise<boolean> {
  return (await page.locator('.touch').getAttribute('data-arrangement')) === 'wide';
}

/** How many places are found in the game, as the progress ring says. */
export async function expectFound(page: Page, found: number): Promise<void> {
  await expect(page.getByTestId('progress-ring').first()).toHaveAttribute(
    'data-found',
    String(found),
  );
}

/** The search result row of the place with exactly this name. */
export function placeResult(page: Page, name: string) {
  const exact = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  return page
    .locator('[data-testid="search-result"][data-kind="location"]')
    .filter({ has: page.locator('.touch-row-title', { hasText: exact }) })
    .first();
}

/** Opens search and types a query. */
export async function search(page: Page, query: string): Promise<void> {
  if (await isWide(page)) await page.getByTestId('search-input').click();
  else await page.getByTestId('open-search').click();
  await page.getByTestId('search-input').fill(query);
}

/** Searches for a place by its exact name and opens it. */
export async function choosePlace(page: Page, name: string): Promise<void> {
  await search(page, name);
  await placeResult(page, name).locator('.touch-row-main').click();
  await expect(page.getByTestId('selected-name')).toHaveText(name);
}

/** Waits until the map stops moving. */
export async function mapSettled(page: Page): Promise<void> {
  let last = '';
  await expect
    .poll(async () => {
      const now = JSON.stringify(await mapStatus(page));
      const still = now === last;
      last = now;
      return still;
    })
    .toBe(true);
}

/** Where a place of the surface map is on the screen. */
export async function screenPoint(
  page: Page,
  place: { x: number; y: number },
  maxZoom = 5,
): Promise<{ x: number; y: number }> {
  await mapSettled(page);
  const view = await mapStatus(page);
  const box = (await page.getByTestId('map').boundingBox())!;
  const scale = 2 ** (maxZoom - view.zoom);
  return {
    x: box.x + box.width / 2 + (place.x - view.x) / scale,
    y: box.y + box.height / 2 + (place.y - view.y) / scale,
  };
}

/** A finger held down at a point for a while, then lifted. */
export async function pressAndHold(page: Page, point: { x: number; y: number }): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const touchPoints = [{ x: Math.round(point.x), y: Math.round(point.y) }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
  await page.waitForTimeout(800);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** What the Android Back button does: whether the page closed something. */
export function back(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { atlasBack(): boolean }).atlasBack());
}
