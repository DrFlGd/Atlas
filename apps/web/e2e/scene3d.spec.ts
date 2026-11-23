import { expect, test, type Page } from '@playwright/test';
import { collectErrors, mapStatus, openMap } from './helpers';
import { mapSettled } from './touch';

/**
 * The 3D view of a map with a model: the demo's Mossgate Keep, a made-up
 * keep on a hill with a cave, in three floors. WebGL 2 runs on the CPU here
 * (SwiftShader), as on a computer without a graphics card.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
test.use({
  launchOptions: {
    ...(executablePath ? { executablePath } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  },
});

async function openKeep(page: Page): Promise<void> {
  await openMap(page);
  await page.getByTestId('map-chip').click();
  await page
    .getByTestId('maps-menu')
    .getByRole('button', { name: /^Mossgate Keep/ })
    .click();
  await expect(page.getByTestId('scene-view')).toBeVisible();
  await expect(page.getByTestId('scene-status')).toHaveAttribute('data-ready', 'true', {
    timeout: 60_000,
  });
}

/** The dots in the view once it is at rest, after `move` (which moves it). */
async function dotsAfter(page: Page, move: () => Promise<void>) {
  const status = page.getByTestId('scene-status');
  await status.evaluate((element) => {
    delete (element as HTMLElement).dataset.onScreen;
  });
  await move();
  await expect(status).toHaveAttribute('data-on-screen', /\[/, { timeout: 15_000 });
  const json = await status.getAttribute('data-on-screen');
  return JSON.parse(json ?? '[]') as { id: string; x: number; y: number }[];
}

test('opens a map with a model in 3D, switches floors and opens a location from its dot', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openKeep(page);
  await expect(page.getByTestId('scene-mode-3d')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('map-chip')).toContainText('All floors');
  const all = Number(await page.getByTestId('marker-count').textContent());
  expect(all).toBeGreaterThan(20);

  // One floor: only its locations, and the model cut above it.
  await page.getByTestId('scene-floor').filter({ hasText: 'Upper floor' }).click();
  const status = page.getByTestId('scene-status');
  await expect(status).toHaveAttribute('data-floor', 'demo:layer:keep-upper');
  await expect(status).not.toHaveAttribute('data-cut', '');
  const upper = Number(await page.getByTestId('marker-count').textContent());
  expect(upper).toBeGreaterThan(0);
  expect(upper).toBeLessThan(all);
  await expect(page.getByTestId('map-chip')).toContainText('Upper floor');

  // Seen from above, a dot pressed opens the same card as on the 2D map.
  const dots = await dotsAfter(page, () => page.getByTestId('scene-from-above').click());
  expect(dots.length).toBeGreaterThan(0);
  const dot = dots[0]!;
  const box = (await page.getByTestId('scene-view').boundingBox())!;
  await page.mouse.click(box.x + dot.x, box.y + dot.y);
  await expect(status).toHaveAttribute('data-selected', dot.id);
  await expect(page.getByTestId('place-sheet')).toBeVisible();
  await expect(page.getByTestId('selected-name')).not.toBeEmpty();

  // All floors again.
  await page.getByTestId('scene-floor-all').click();
  await expect(status).toHaveAttribute('data-floor', 'all');

  // 2D is one press away, and the choice is kept.
  await page.getByTestId('scene-mode-2d').click();
  await expect(page.getByTestId('scene-view')).toHaveCount(0);
  await expect(page.getByTestId('map')).toBeVisible();
  await mapSettled(page);
  // Moved on the 2D map, it is where it was after a look in 3D.
  const box2d = (await page.getByTestId('map').boundingBox())!;
  await page.mouse.move(box2d.x + box2d.width * 0.3, box2d.y + box2d.height * 0.4);
  const fitted = (await mapStatus(page)).zoom;
  await page.mouse.wheel(0, 400);
  await expect.poll(async () => (await mapStatus(page)).zoom).toBeLessThan(fitted);
  await mapSettled(page);
  const kept = await mapStatus(page);
  await page.getByTestId('scene-mode-3d').click();
  await expect(page.getByTestId('scene-view')).toBeVisible();
  await page.getByTestId('scene-mode-2d').click();
  await expect(page.getByTestId('map')).toBeVisible();
  await mapSettled(page);
  const back = await mapStatus(page);
  expect(back.zoom).toBeCloseTo(kept.zoom, 1);
  expect(Math.abs(back.x - kept.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(back.y - kept.y)).toBeLessThanOrEqual(2);
  await page.getByTestId('scene-mode-3d').click();
  await expect(page.getByTestId('scene-view')).toBeVisible();

  expect(errors).toEqual([]);
});

test('runs the 3D trial from Settings and shows its report', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await openMap(page);
  await page.getByTestId('section-games').click();
  await page.getByTestId('open-scene-trial').click();
  const trial = page.getByTestId('scene-trial');
  await expect(trial).toBeVisible();
  await trial.getByTestId('scene-trial-start').click();
  const report = trial.getByTestId('scene-trial-report');
  await expect(report).toBeVisible({ timeout: 90_000 });
  await expect(report).toContainText('3D trial');
  await expect(report).toContainText('1. 250,000 triangles');
  await expect(trial.getByTestId('scene-trial-start')).toHaveText('Run the trial again');
  expect(errors).toEqual([]);
});

test('a search result on a 3D map opens the 3D view at the location', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page);
  await page.getByTestId('search-input').fill('West waystone');
  const result = page.getByTestId('search-result').filter({ hasText: 'West waystone' }).first();
  await result.getByRole('button').first().click();
  await expect(page.getByTestId('scene-view')).toBeVisible();
  const status = page.getByTestId('scene-status');
  await expect(status).toHaveAttribute('data-selected', 'demo:loc:keep-waystone-west');
  // The view flies to it: once at rest, its dot is near the middle.
  await expect(status).toHaveAttribute('data-on-screen', /keep-waystone-west/, {
    timeout: 20_000,
  });
  await page.waitForTimeout(1500);
  const box = (await page.getByTestId('scene-view').boundingBox())!;
  const dots = JSON.parse((await status.getAttribute('data-on-screen')) ?? '[]') as {
    id: string;
    x: number;
    y: number;
  }[];
  const dot = dots.find((d) => d.id === 'demo:loc:keep-waystone-west')!;
  expect(Math.abs(dot.x - box.width / 2)).toBeLessThan(box.width * 0.2);
  expect(Math.abs(dot.y - box.height / 2)).toBeLessThan(box.height * 0.2);
  expect(errors).toEqual([]);
});
