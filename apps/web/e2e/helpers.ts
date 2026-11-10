import { expect, type Page } from '@playwright/test';

/** Collects uncaught page errors and console errors for the lifetime of the page. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** Opens the app and waits until the pack is loaded and the map has drawn. */
export async function openMap(page: Page, path = './'): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
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

export interface OverlayView {
  zoom: number;
  x: number;
  y: number;
}

/** The current view as reported by the overlay. */
export async function overlayView(page: Page): Promise<OverlayView> {
  const overlay = page.getByTestId('overlay');
  const [zoom, x, y] = await Promise.all([
    overlay.getAttribute('data-zoom'),
    overlay.getAttribute('data-center-x'),
    overlay.getAttribute('data-center-y'),
  ]);
  return { zoom: Number(zoom), x: Number(x), y: Number(y) };
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
