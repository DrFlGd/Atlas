import { expect, type APIRequestContext, type Page } from '@playwright/test';

export interface PackLocation {
  id: string;
  name: string;
  x: number;
  y: number;
  mapId: string;
  layerId: string;
  categoryId: string;
}

/** Collects uncaught page errors and console errors for the lifetime of the page. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/**
 * A setting of this device as it is stored now. The app saves settings
 * without waiting, so a test that restarts the app waits for this first: a
 * reload while the page is busy would drop a save that has not finished.
 */
export function storedSetting(page: Page, key: string): Promise<unknown> {
  return page.evaluate(
    (settingKey) =>
      new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open('atlas');
        open.onerror = () => {
          reject(open.error ?? new Error('The settings could not be opened'));
        };
        open.onsuccess = () => {
          const db = open.result;
          const get = db.transaction('settings').objectStore('settings').get(settingKey);
          get.onsuccess = () => {
            db.close();
            resolve((get.result as { value?: unknown } | undefined)?.value);
          };
          get.onerror = () => {
            db.close();
            reject(get.error ?? new Error('The setting could not be read'));
          };
        };
      }),
    key,
  );
}

/** Opens the app and waits until the demo pack is loaded and the surface map has drawn. */
export async function openMap(page: Page, path = './', markers = '5,000'): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId('marker-count')).toHaveText(markers);
  await expect(page.locator('.atlas-marker-canvas')).toHaveAttribute('data-draw-ms', /\d/);
  await waitForTiles(page);
}

/** Waits until the visible tiles have loaded and decoded. */
export async function waitForTiles(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page
        .locator('.atlas-tiles img.leaflet-tile-loaded')
        .evaluateAll(
          (images) =>
            (images as HTMLImageElement[]).filter((img) => img.complete && img.naturalWidth > 0)
              .length,
        ),
    )
    .toBeGreaterThan(3);
}

export interface MapStatus {
  zoom: number;
  x: number;
  y: number;
  layer: string;
}

/** The current view and layer, as reported by the app. */
export async function mapStatus(page: Page): Promise<MapStatus> {
  const status = page.getByTestId('map-status');
  const [zoom, x, y, layer] = await Promise.all([
    status.getAttribute('data-zoom'),
    status.getAttribute('data-center-x'),
    status.getAttribute('data-center-y'),
    status.getAttribute('data-layer'),
  ]);
  return { zoom: Number(zoom), x: Number(x), y: Number(y), layer: layer ?? '' };
}

/** Number of marker canvas pixels that are not fully transparent. */
export async function paintedMarkerPixels(page: Page): Promise<number> {
  return page.locator('.atlas-marker-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) painted++;
    return painted;
  });
}

/** The demo pack's locations, read from the server the tests run against. */
export async function demoLocations(request: APIRequestContext): Promise<PackLocation[]> {
  const response = await request.get('./packs/demo/locations.json');
  return (await response.json()) as PackLocation[];
}

export interface PackRegion {
  id: string;
  mapId: string;
  parentId: string | null;
  name: string;
  polygon?: [number, number][];
  center?: [number, number];
}

/** The demo pack's regions, read from the server the tests run against. */
export async function demoRegions(request: APIRequestContext): Promise<PackRegion[]> {
  const response = await request.get('./packs/demo/regions.json');
  return (await response.json()) as PackRegion[];
}

/** Overall found and total, from the top bar. */
export async function overall(page: Page): Promise<{ found: number; total: number }> {
  const element = page.getByTestId('overall-progress');
  return {
    found: Number(await element.getAttribute('data-found')),
    total: Number(await element.getAttribute('data-total')),
  };
}

/**
 * Reloads the page once nothing is being saved. The app saves without
 * waiting and says so on its root element (`data-saving`); a reload while a
 * save is under way would drop it.
 */
export async function reloadSaved(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-saving', 'false');
  await page.reload();
}

export async function expectOverallFound(page: Page, found: number): Promise<void> {
  await expect(page.getByTestId('overall-progress')).toHaveAttribute('data-found', String(found));
}

/** Searches for a name and chooses the first result. */
export async function searchAndChoose(page: Page, query: string): Promise<void> {
  await page.keyboard.press('/');
  const input = page.getByRole('combobox', { name: 'Search locations' });
  await expect(input).toBeFocused();
  await input.fill(query);
  await expect(
    page.getByRole('listbox', { name: 'Search results' }).getByRole('option').first(),
  ).toBeVisible();
  await input.press('Enter');
}

/** Searches for an exact location name and waits until it is selected. */
export async function selectByName(page: Page, name: string): Promise<void> {
  await searchAndChoose(page, name);
  await expect(page.getByTestId('selected-name')).toHaveText(name);
}

/** The count shown on a category row, such as "0/896". */
export async function categoryCount(page: Page, categoryId: string): Promise<string> {
  return (await page.getByTestId(`category-${categoryId}`).locator('.count').textContent()) ?? '';
}
