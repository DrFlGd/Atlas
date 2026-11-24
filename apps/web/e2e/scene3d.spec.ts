import { expect, test, type Page } from '@playwright/test';
import { collectErrors, mapStatus, openMap, storedSetting } from './helpers';
import { choosePlace, mapSettled } from './touch';

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

/** Where the dot of a location is once the view is at rest, or undefined when it is not shown. */
async function dotOf(page: Page, id: string) {
  const json = await page.getByTestId('scene-status').getAttribute('data-on-screen');
  const dots = JSON.parse(json ?? '[]') as { id: string; x: number; y: number }[];
  return dots.find((dot) => dot.id === id);
}

/** Waits until the view, at rest, shows a location's dot near a point of its box (within `reach` pixels). */
async function dotSettlesAt(page: Page, id: string, x: number, y: number, reach: number) {
  await expect
    .poll(
      async () => {
        const dot = await dotOf(page, id);
        return dot ? Math.max(Math.abs(dot.x - x), Math.abs(dot.y - y)) : Infinity;
      },
      { timeout: 20_000 },
    )
    .toBeLessThan(reach);
}

test('pressing a location goes to it: its floor, cut above it, the view down at it; Escape goes back', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openKeep(page);
  const status = page.getByTestId('scene-status');
  const chest = 'demo:loc:keep-keep-chest-hall';
  await expect(status).toHaveAttribute('data-on-screen', /keep-chest-hall/, { timeout: 20_000 });
  const before = (await dotOf(page, chest))!;
  const box = (await page.getByTestId('scene-view').boundingBox())!;
  await status.evaluate((element) => {
    delete (element as HTMLElement).dataset.onScreen;
  });
  await page.mouse.click(box.x + before.x, box.y + before.y);
  await expect(status).toHaveAttribute('data-selected', chest);
  // The ground floor (the chest stands at 3.2 m), cut 3 m above it: under the floor's top at 6.75 m.
  await expect(status).toHaveAttribute('data-floor', 'demo:layer:keep-ground');
  await expect(status).toHaveAttribute('data-focus', chest);
  await expect(status).toHaveAttribute('data-cut', '6.2');
  await expect(page.getByTestId('scene-floor').filter({ hasText: 'Ground floor' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Flown down to it: at rest, it is near the middle of the view (the card is beside it here).
  await dotSettlesAt(page, chest, box.width / 2, box.height / 2, box.height * 0.1);

  // A press on nothing closes the card only: the floor and the cut stay.
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.85);
  await expect(status).toHaveAttribute('data-selected', '');
  await expect(status).toHaveAttribute('data-focus', chest);
  await expect(status).toHaveAttribute('data-floor', 'demo:layer:keep-ground');
  await expect(status).toHaveAttribute('data-cut', '6.2');
  // So does the card's Close.
  const again = (await dotOf(page, chest))!;
  await page.mouse.click(box.x + again.x, box.y + again.y);
  await expect(status).toHaveAttribute('data-selected', chest);
  await page.getByTestId('close-place').click();
  await expect(status).toHaveAttribute('data-selected', '');
  await expect(status).toHaveAttribute('data-cut', '6.2');
  // Escape then goes back: every floor, no cut.
  await page.keyboard.press('Escape');
  await expect(status).toHaveAttribute('data-floor', 'all');
  await expect(status).toHaveAttribute('data-cut', '');
  await expect(status).toHaveAttribute('data-focus', '');

  // With the card open, Escape closes it first, then goes back.
  await page.getByTestId('search-input').fill('Hall chest');
  await page
    .getByTestId('search-result')
    .filter({ hasText: 'Hall chest' })
    .first()
    .getByRole('button')
    .first()
    .click();
  await expect(status).toHaveAttribute('data-focus', chest);
  await page.locator('.scene-canvas').focus();
  await page.keyboard.press('Escape');
  await expect(status).toHaveAttribute('data-selected', '');
  await expect(status).toHaveAttribute('data-cut', '6.2');
  await page.keyboard.press('Escape');
  await expect(status).toHaveAttribute('data-floor', 'all');
  await expect(status).toHaveAttribute('data-cut', '');

  // All floors goes back too.
  await page.getByTestId('search-input').fill('Keep relic');
  await page
    .getByTestId('search-result')
    .filter({ hasText: 'Keep relic' })
    .first()
    .getByRole('button')
    .first()
    .click();
  await expect(status).toHaveAttribute('data-floor', 'demo:layer:keep-upper');
  await expect(status).toHaveAttribute('data-focus', 'demo:loc:keep-keep-relic');
  await page.getByTestId('scene-floor-all').click();
  await expect(status).toHaveAttribute('data-floor', 'all');
  await expect(status).toHaveAttribute('data-cut', '');
  expect(errors).toEqual([]);
});

test('the names of the areas float over the view, frame their area when pressed, and can be hidden', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openKeep(page);
  const status = page.getByTestId('scene-status');
  const titles = page.getByTestId('scene-title');
  await expect(titles.filter({ hasText: 'The keep' })).toBeVisible({ timeout: 20_000 });
  await expect(titles.filter({ hasText: 'Glimmer Caves' })).toBeVisible();
  await expect(status).toHaveAttribute('data-titles', /keep-halls/, { timeout: 20_000 });

  // No two overlap.
  const boxes = await titles.evaluateAll((elements) =>
    elements
      .filter((element) => (element as HTMLElement).style.visibility === 'visible')
      .map((element) => element.getBoundingClientRect().toJSON() as DOMRect),
  );
  expect(boxes.length).toBeGreaterThan(2);
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      const apart =
        a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
      expect(apart).toBe(true);
    }
  }

  // Pressed with the keyboard, a title shows its area: its name near the middle of the view.
  const caves = titles.filter({ hasText: 'Glimmer Caves' });
  await status.evaluate((element) => {
    delete (element as HTMLElement).dataset.onScreen;
  });
  await caves.focus();
  await page.keyboard.press('Enter');
  await expect(status).toHaveAttribute('data-on-screen', /\[/, { timeout: 20_000 });
  const view = (await page.getByTestId('scene-view').boundingBox())!;
  const title = (await caves.boundingBox())!;
  expect(Math.abs(title.x + title.width / 2 - (view.x + view.width / 2))).toBeLessThan(
    view.width * 0.15,
  );
  expect(Math.abs(title.y + title.height - (view.y + view.height / 2))).toBeLessThan(
    view.height * 0.15,
  );

  // Hidden from the view's tools, and kept so on the device.
  const toggle = page.getByTestId('scene-titles-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(titles).toHaveCount(0);
  await expect.poll(() => storedSetting(page, 'sceneTitles')).toBe(false);
  await page.reload();
  await expect(page.getByTestId('scene-view')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('scene-titles-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(titles).toHaveCount(0);
  await page.getByTestId('scene-titles-toggle').click();
  await expect(titles.filter({ hasText: 'The keep' })).toBeAttached();
  expect(errors).toEqual([]);
});

test('with a controller: the D-pad holds a location, A goes to it, B goes back', async ({
  page,
}) => {
  const errors = collectErrors(page);
  // A stand-in gamepad in the standard layout, read through `navigator.getGamepads`.
  await page.addInitScript(() => {
    const pad = {
      id: 'Stand-in gamepad (STANDARD GAMEPAD)',
      index: 0,
      connected: true,
      mapping: 'standard',
      timestamp: 0,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    (window as unknown as { testPad: typeof pad }).testPad = pad;
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] });
  });
  const press = async (button: number) => {
    for (const value of [1, 0]) {
      await page.evaluate(
        ([index, amount]) => {
          const pad = (window as unknown as { testPad: { buttons: unknown[] } }).testPad;
          pad.buttons[index!] = { pressed: amount === 1, value: amount };
        },
        [button, value],
      );
      await page.waitForTimeout(150);
    }
  };
  await openKeep(page);
  const status = page.getByTestId('scene-status');
  const target = page.getByTestId('pad-reticle-target');
  // The D-pad (right) holds the next location that way.
  await press(15);
  await expect(target).toHaveCount(1, { timeout: 10_000 });
  const held = (await target.getAttribute('data-location'))!;
  // A opens it, and the view goes to it.
  await press(0);
  await expect(status).toHaveAttribute('data-selected', held);
  await expect(status).toHaveAttribute('data-focus', held);
  await expect(status).not.toHaveAttribute('data-cut', '');
  // B closes it, keeping the floor and cut; B again goes back to the whole view.
  await press(1);
  await expect(status).toHaveAttribute('data-selected', '');
  await expect(status).toHaveAttribute('data-focus', held);
  await expect(status).not.toHaveAttribute('data-cut', '');
  await press(1);
  await expect(status).toHaveAttribute('data-focus', '');
  await expect(status).toHaveAttribute('data-floor', 'all');
  await expect(status).toHaveAttribute('data-cut', '');
  expect(errors).toEqual([]);
});

test('a row of Progress frames its area, as its title does', async ({ page }) => {
  const errors = collectErrors(page);
  await openKeep(page);
  const status = page.getByTestId('scene-status');
  /** The cave's dots once the view is at rest after `move`. */
  const caveDots = async (move: () => Promise<void>) => {
    const dots = await dotsAfter(page, move);
    await page.waitForTimeout(1200);
    const json = await status.getAttribute('data-on-screen');
    return (JSON.parse(json ?? '[]') as { id: string; x: number; y: number }[])
      .filter((dot) => dot.id.includes(':keep-cave-'))
      .sort((a, b) => a.id.localeCompare(b.id))
      .concat(dots.slice(0, 0));
  };
  // The title pressed, from where the view starts.
  const byTitle = await caveDots(() =>
    page.getByTestId('scene-title').filter({ hasText: 'Glimmer Caves' }).click(),
  );
  expect(byTitle.length).toBeGreaterThan(2);
  await caveDots(() => page.getByTestId('scene-recenter').click());
  // The row of Progress, from the same start: the same view.
  await page.getByTestId('section-progress').click();
  const byRow = await caveDots(() =>
    page
      .getByTestId('region-progress')
      .getByRole('button', { name: /^Glimmer Caves/ })
      .click(),
  );
  expect(byRow.map((dot) => dot.id)).toEqual(byTitle.map((dot) => dot.id));
  byRow.forEach((dot, k) => {
    expect(Math.abs(dot.x - byTitle[k]!.x)).toBeLessThan(6);
    expect(Math.abs(dot.y - byTitle[k]!.y)).toBeLessThan(6);
  });
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('a location gone to shows in the middle of what its card leaves free', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await page.getByTestId('map-chip').click();
    await page
      .getByTestId('maps-menu')
      .getByRole('button', { name: /^Mossgate Keep/ })
      .click();
    const status = page.getByTestId('scene-status');
    await expect(status).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
    await choosePlace(page, 'Hall chest');
    const chest = 'demo:loc:keep-keep-chest-hall';
    await expect(status).toHaveAttribute('data-focus', chest);
    const card = page.getByTestId('place-sheet');
    await expect(card).toBeVisible();
    await page.waitForTimeout(400);
    const view = (await page.getByTestId('scene-view').boundingBox())!;
    const over = (await card.boundingBox())!;
    const free = over.y - view.y;
    expect(free).toBeLessThan(view.height * 0.9);
    await dotSettlesAt(page, chest, view.width / 2, free / 2, 40);
    expect(errors).toEqual([]);
  });
});
