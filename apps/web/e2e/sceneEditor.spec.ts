import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type Route } from '@playwright/test';
import { collectErrors, openMap, storedSetting } from './helpers';

/**
 * Edit locations in the 3D view of a map with a model: the demo's made-up
 * Mossgate Keep. A press on the model puts a new location on its surface,
 * at the height of the surface pressed and on the floor of that height;
 * one of the person's own is moved with Move and by dragging its dot; Undo
 * takes a change back; a floor's cut leaves nothing above it to press; a
 * controller's A puts one at the crosshair. Then the locations of another
 * pack of the same game (a copy of the demo, served under another id) are
 * taken onto the keep, with what lands off it reported first. WebGL 2 runs
 * on the CPU here (SwiftShader).
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
test.use({
  launchOptions: {
    ...(executablePath ? { executablePath } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  },
});

const SETTING = 'ownLocations:demo';
const KEEP = 'demo:map:keep';
/** The keep's floors, lowest first, as its pack has them. */
const FLOORS = [
  { id: 'demo:layer:keep-caves', name: 'Caves', min: -12, max: -4 },
  { id: 'demo:layer:keep-ground', name: 'Ground floor', min: -4, max: 6.75 },
  { id: 'demo:layer:keep-upper', name: 'Upper floor', min: 6.75, max: 10.75 },
];
/** The floor a height is on: the highest that starts at or below it. */
const floorOf = (height: number) =>
  FLOORS.reduce((found, floor) => (floor.min <= height ? floor : found), FLOORS[0]!).id;

const SHOTS = process.env.ATLAS_EDITOR3D_SHOTS ?? 'test-results/editor-3d';

interface Stored {
  id: string;
  name: string;
  mapId: string;
  layerId: string;
  x: number;
  y: number;
  height?: number;
  note?: string;
}

async function storedLocations(page: Page): Promise<Stored[]> {
  const text = (await storedSetting(page, SETTING)) as string | undefined;
  return text ? (JSON.parse(text) as { locations: Stored[] }).locations : [];
}

async function saved(page: Page): Promise<void> {
  await expect(page.getByTestId('locations-save-state')).toHaveAttribute('data-state', 'saved');
}

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

/** The dots in the view once it is at rest after `move`, in the view's box. */
async function dotsAfter(page: Page, move: () => Promise<void>) {
  const status = page.getByTestId('scene-status');
  await status.evaluate((element) => {
    delete (element as HTMLElement).dataset.onScreen;
  });
  await move();
  await expect(status).toHaveAttribute('data-on-screen', /\[/, { timeout: 15_000 });
  return JSON.parse((await status.getAttribute('data-on-screen')) ?? '[]') as {
    id: string;
    x: number;
    y: number;
  }[];
}

/** A point of the view, in page pixels, at least 34 pixels from every dot, near `near` (fractions of the view). */
async function emptyPoint(
  page: Page,
  dots: { x: number; y: number }[],
  near: { x: number; y: number } = { x: 0.5, y: 0.5 },
) {
  const box = (await page.getByTestId('scene-view').boundingBox())!;
  const candidates: { x: number; y: number }[] = [];
  for (let gy = 0.15; gy <= 0.85; gy += 0.025) {
    for (let gx = 0.05; gx <= 0.95; gx += 0.025) {
      const x = box.width * gx;
      const y = box.height * gy;
      if (dots.every((dot) => Math.hypot(dot.x - x, dot.y - y) > 34)) candidates.push({ x, y });
    }
  }
  // Only where the model shows, not under a panel or a button over it.
  const open = await page.evaluate(
    (points) =>
      points.filter((p) =>
        document.elementFromPoint(p.x + p.left, p.y + p.top)?.classList.contains('scene-canvas'),
      ),
    candidates.map((p) => ({ ...p, left: box.x, top: box.y })),
  );
  candidates.splice(0, candidates.length, ...open);
  const wanted = { x: box.width * near.x, y: box.height * near.y };
  candidates.sort(
    (a, b) =>
      Math.hypot(a.x - wanted.x, a.y - wanted.y) - Math.hypot(b.x - wanted.x, b.y - wanted.y),
  );
  const best = candidates[0];
  if (!best) throw new Error('No empty point in the view');
  return { x: box.x + best.x, y: box.y + best.y };
}

/** Enters Edit locations on the keep, seen from above, and gives the dots then shown. */
async function editFromAbove(page: Page) {
  await page.getByTestId('edit-locations').click();
  await expect(page.getByTestId('location-editor')).toBeVisible();
  // The 3D view stays: locations are put on the model.
  await expect(page.getByTestId('scene-view')).toBeVisible();
  await expect(page.getByTestId('scene-mode-3d')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('locations-map-hint')).toHaveText(
    'Press the model to put a location there',
  );
  return dotsAfter(page, () => page.getByTestId('scene-from-above').click());
}

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

test('puts a location on the model, moves it with Move and by dragging, and Undo takes it back', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await openKeep(page);
  const status = page.getByTestId('scene-status');
  const dots = await editFromAbove(page);

  // A press on the model: the first new location of the game asks for its type.
  const first = await emptyPoint(page, dots, { x: 0.45, y: 0.5 });
  await page.mouse.click(first.x, first.y);
  await expect(page.getByTestId('new-location-panel')).toBeVisible();
  await expect(page.getByTestId('location-position')).toContainText('high');
  await page.getByTestId('location-name').fill('Moss ledge');
  await page.getByTestId('location-type').selectOption({ index: 1 });
  const placed = await dotsAfter(page, () => page.getByTestId('add-location').click());
  await expect(page.getByTestId('location-panel')).toBeVisible();
  await saved(page);
  const [added] = await storedLocations(page);
  expect(added).toMatchObject({ name: 'Moss ledge', mapId: KEEP });
  expect(typeof added!.height).toBe('number');
  expect(added!.height!).toBeGreaterThanOrEqual(-12);
  expect(added!.height!).toBeLessThanOrEqual(40);
  // Its floor is the one its height is on.
  expect(added!.layerId).toBe(floorOf(added!.height!));
  // The view stays where it was: no flight to it while editing.
  await expect(status).toHaveAttribute('data-focus', '');
  await expect(status).toHaveAttribute('data-selected', added!.id);

  // Move, then a press elsewhere on the model.
  await page.getByTestId('location-move').click();
  await expect(page.getByTestId('locations-map-hint')).toContainText(
    'Press where “Moss ledge” goes',
  );
  const second = await emptyPoint(page, placed, { x: 0.62, y: 0.4 });
  const afterMove = await dotsAfter(page, () => page.mouse.click(second.x, second.y));
  await saved(page);
  const [moved] = await storedLocations(page);
  expect(moved!.id).toBe(added!.id);
  expect([moved!.x, moved!.y]).not.toEqual([added!.x, added!.y]);
  expect(typeof moved!.height).toBe('number');
  expect(moved!.layerId).toBe(floorOf(moved!.height!));

  // Dragged by its dot, over the model.
  const dot = afterMove.find((d) => d.id === added!.id);
  expect(dot).toBeDefined();
  const box = (await page.getByTestId('scene-view').boundingBox())!;
  const third = await emptyPoint(
    page,
    afterMove.filter((d) => d.id !== added!.id),
    { x: 0.35, y: 0.62 },
  );
  await page.mouse.move(box.x + dot!.x, box.y + dot!.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) {
    await page.mouse.move(
      box.x + dot!.x + ((third.x - box.x - dot!.x) * k) / 8,
      box.y + dot!.y + ((third.y - box.y - dot!.y) * k) / 8,
    );
  }
  await page.mouse.up();
  await saved(page);
  const [dragged] = await storedLocations(page);
  expect([dragged!.x, dragged!.y]).not.toEqual([moved!.x, moved!.y]);
  expect(typeof dragged!.height).toBe('number');
  // Undo: back where Move put it, and where its dot was: the drag did not move the view.
  const afterUndo = await dotsAfter(page, () => page.getByTestId('locations-undo').click());
  await saved(page);
  expect((await storedLocations(page))[0]).toMatchObject({ x: moved!.x, y: moved!.y });
  const back = afterUndo.find((d) => d.id === added!.id);
  expect(back).toBeDefined();
  expect(Math.abs(back!.x - dot!.x)).toBeLessThan(3);
  expect(Math.abs(back!.y - dot!.y)).toBeLessThan(3);
  // And again: where it was put.
  await page.getByTestId('locations-undo').click();
  await saved(page);
  expect((await storedLocations(page))[0]).toMatchObject({
    x: added!.x,
    y: added!.y,
    height: added!.height,
  });
  expect(errors).toEqual([]);
});

test('a floor’s cut leaves nothing above it to put a location on', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await openKeep(page);
  await editFromAbove(page);
  const status = page.getByTestId('scene-status');
  // The caves: the model is cut away above their top.
  const caves = FLOORS[0]!;
  const dots = await dotsAfter(page, () =>
    page.getByTestId('scene-floor').filter({ hasText: caves.name }).click(),
  );
  await expect(status).toHaveAttribute('data-floor', caves.id);
  await expect(status).toHaveAttribute('data-cut', String(caves.max));
  // Next to a cave's location, on the cave's floor.
  const cave = dots[0];
  expect(cave).toBeDefined();
  const box = (await page.getByTestId('scene-view').boundingBox())!;
  for (const [dx, dy] of [
    [26, 0],
    [-26, 0],
    [0, 26],
    [0, -26],
  ] as const) {
    await page.mouse.click(box.x + cave!.x + dx, box.y + cave!.y + dy);
    const panel = page.getByTestId('new-location-panel');
    if (await panel.isVisible()) break;
  }
  await expect(page.getByTestId('new-location-panel')).toBeVisible();
  await page.getByTestId('location-type').selectOption({ index: 1 });
  await page.getByTestId('add-location').click();
  await saved(page);
  const [inCave] = await storedLocations(page);
  // Never above the cut, so never on the ground over the cave.
  expect(inCave!.height!).toBeLessThanOrEqual(caves.max + 0.01);
  expect(inCave!.layerId).toBe(caves.id);
  expect(errors).toEqual([]);
});

test('with a controller: A puts a location where the crosshair points', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
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
  // The app reads the pad once a frame, and a 3D frame can take longer than a short press
  // on a busy machine: so a button is held down until what it does shows, then let go.
  const setButton = async (button: number, value: number) => {
    await page.evaluate(
      ([index, amount]) => {
        const pad = (window as unknown as { testPad: { buttons: unknown[] } }).testPad;
        pad.buttons[index!] = { pressed: amount === 1, value: amount };
      },
      [button, value],
    );
  };
  const setStick = async (x: number) => {
    await page.evaluate((amount) => {
      (window as unknown as { testPad: { axes: number[] } }).testPad.axes[0] = amount;
    }, x);
  };
  await openKeep(page);
  const dots = await editFromAbove(page);
  // The view starts on a location: open ground near the middle is dragged under the crosshair
  // (a drag moves the ground with the pointer), so the crosshair holds no location. The view
  // glides on a moment after a move, so the check waits for it to come to rest.
  const view = (await page.getByTestId('scene-view').boundingBox())!;
  const middle = { x: view.x + view.width / 2, y: view.y + view.height / 2 };
  const open = await emptyPoint(page, dots, { x: 0.5, y: 0.5 });
  await page.mouse.move(open.x, open.y);
  await page.mouse.down();
  await page.mouse.move(middle.x, middle.y, { steps: 12 });
  await page.mouse.up();
  // The controller in hand: the stick just past its dead zone shows the crosshair.
  const reticle = page.getByTestId('pad-reticle');
  const putHere = page.getByTestId('pad-hints').locator('[data-action="open-location"]');
  await setStick(0.35);
  await expect(reticle).toBeVisible();
  await setStick(0);
  await page.waitForTimeout(700);
  await expect(page.getByTestId('pad-reticle-target')).toHaveCount(0);
  await expect(putHere).toContainText('Put here');
  await setButton(0, 1);
  await expect(page.getByTestId('new-location-panel')).toBeVisible();
  await setButton(0, 0);
  await expect(page.getByTestId('location-position')).toContainText('high');
  expect(errors).toEqual([]);
});

/** A copy of the demo world, under another id and the same title: another pack of the game. */
const COPY = 'demo-copy';

async function serveCopy(page: Page): Promise<void> {
  await page.route('**/packs/index.json', (route) =>
    route.fulfill({
      json: {
        packs: [
          { id: 'demo', url: 'packs/demo/', title: 'Atlas demo world' },
          { id: COPY, url: `packs/${COPY}/`, title: 'Atlas demo world' },
        ],
      },
    }),
  );
  await page.route(`**/packs/${COPY}/**`, async (route: Route) => {
    const name = new URL(route.request().url()).pathname.split(`/packs/${COPY}/`)[1] ?? '';
    const response = await route.fetch({
      url: route.request().url().replace(`/packs/${COPY}/`, '/packs/demo/'),
    });
    if (!response.ok() || !name.endsWith('.json')) return route.fulfill({ response });
    const value = JSON.parse(
      (await response.text()).replaceAll('"demo:', `"${COPY}:`).replaceAll('(demo:', `(${COPY}:`),
    ) as Record<string, unknown>;
    if (name === 'manifest.json') {
      return route.fulfill({ json: { ...value, gameId: COPY, idMigrations: {} } });
    }
    return route.fulfill({ json: value });
  });
}

test('takes the locations of another pack of the game onto the keep, after saying what lands off it', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await serveCopy(page);
  await openKeep(page);
  await page.getByTestId('edit-locations').click();
  await page.getByTestId('take-locations').click();
  const panel = page.getByTestId('take-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('take-source').filter({ hasText: 'Atlas demo world' }).click();
  // Its maps: those with a world position are chosen; the one without cannot be.
  const maps = panel.getByTestId('take-map');
  await expect(maps).toHaveCount(3);
  await expect(maps.filter({ hasText: 'The Sundered Isle' }).locator('input')).toBeChecked();
  await expect(maps.filter({ hasText: 'Mossgate Keep' }).locator('input')).toBeChecked();
  await expect(maps.filter({ hasText: 'No world position' }).locator('input')).toBeDisabled();
  await panel.getByTestId('take-find').click();
  await expect(panel).toHaveAttribute('data-step', 'review', { timeout: 60_000 });
  // The keep's own locations are there already; most of the isle lies off the keep.
  await expect(panel.getByTestId('take-already')).toContainText('on Mossgate Keep already');
  await expect(panel.getByTestId('take-outside')).toContainText('Off Mossgate Keep');
  const summary = (await panel.getByTestId('take-summary').textContent()) ?? '';
  const count = Number(/^([\d,]+) locations/.exec(summary)?.[1]?.replaceAll(',', ''));
  expect(count).toBeGreaterThan(5);
  // Nothing is added before the person says so.
  expect(await storedLocations(page)).toEqual([]);
  await panel.getByTestId('take-confirm').click();
  await expect(panel).toHaveCount(0);
  await saved(page);
  const taken = await storedLocations(page);
  expect(taken).toHaveLength(count);
  for (const location of taken) {
    expect(location.mapId).toBe(KEEP);
    expect(location.x).toBeGreaterThanOrEqual(0);
    expect(location.x).toBeLessThanOrEqual(1024);
    // Each on the surface below it, on the floor of that height, or flagged.
    if (location.height === undefined) expect(location.note).toContain('No surface');
    else expect(location.layerId).toBe(floorOf(location.height));
  }
  // One Undo takes all of them back.
  await page.getByTestId('locations-undo').click();
  await saved(page);
  expect(await storedLocations(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test.describe('pictures for the docs', () => {
  test.use({ deviceScaleFactor: 2 });

  test('placing in 3D, and taking locations from another pack', async ({ page }) => {
    test.setTimeout(180_000);
    await serveCopy(page);
    await openKeep(page);
    await page.getByTestId('edit-locations').click();
    // From where the view starts, a little farther: the keep, tilted.
    const box = (await page.getByTestId('scene-view').boundingBox())!;
    const dots = await dotsAfter(page, async () => {
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.55);
      await page.mouse.wheel(0, 500);
    });
    const point = await emptyPoint(page, dots, { x: 0.4, y: 0.6 });
    await page.mouse.click(point.x, point.y);
    await page.getByTestId('location-name').fill('Moss ledge');
    await page.getByTestId('location-type').selectOption({ index: 1 });
    await page.getByTestId('add-location').click();
    await expect(page.getByTestId('location-panel')).toBeVisible();
    await saved(page);
    // Where it is: its height, and its floor.
    await page.getByTestId('location-position').scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/place-in-3d.png`, animations: 'disabled' });

    await page.getByTestId('take-locations').click();
    const panel = page.getByTestId('take-panel');
    await panel.getByTestId('take-source').filter({ hasText: 'Atlas demo world' }).click();
    await expect(panel.getByTestId('take-map')).toHaveCount(3);
    await page.screenshot({ path: `${SHOTS}/take-choose.png`, animations: 'disabled' });
    await panel.getByTestId('take-find').click();
    await expect(panel).toHaveAttribute('data-step', 'review', { timeout: 60_000 });
    await page.screenshot({ path: `${SHOTS}/take-review.png`, animations: 'disabled' });
  });
});
