import type { Page } from '@playwright/test';
import { collectErrors, demoLocations, mapStatus, openMap } from './helpers';
import { expect, test } from './layout';
import { mapSettled } from './touch';

/**
 * Moving around the app with the keys alone and with a gamepad, as on a
 * Steam Deck in Game Mode (`src/controller.ts`): the arrow keys move the
 * focus to the nearest control, Enter presses, Esc goes back and leaves
 * the map, the map keeps its own arrow keys, a text field keeps them while
 * typing, and the mouse works as before. The gamepad is a stand-in that
 * the page reads through `navigator.getGamepads`, as it reads a real one:
 * on the map its sticks move the map and its triggers zoom, a crosshair
 * holds a location that A opens, the bumpers switch sections, a bar at the
 * foot of the screen shows its buttons, and the guide lists them.
 */

// The standard layout on a computer, as the desktop app shows it.
test.use({ layout: null });

/** What has the focus: its test id, or its tag and class. */
const focusedId = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return 'body';
    return active.dataset.testid ?? `${active.tagName.toLowerCase()}.${active.className}`;
  });

/** The section shown, from the button marked as the current one. */
const currentSection = (page: Page) =>
  page
    .locator('.touch-rail [aria-current="page"]')
    .getAttribute('data-testid')
    .then((id) => id ?? '');

const moving = (page: Page) =>
  page.evaluate(() => document.documentElement.hasAttribute('data-moving'));

test('the arrow keys move between controls, Enter presses and Esc goes back', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page);
  expect(await focusedId(page)).toBe('body');
  expect(await currentSection(page)).toBe('section-map');

  // The first arrow key starts at the section shown, with the wide ring.
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedId(page)).toBe('section-map');
  expect(await moving(page)).toBe(true);
  const ring = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement!);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(ring).toEqual({ width: '3px', style: 'solid' });

  // Down the rail, one section at a time, and back up.
  const rail = await page
    .locator('.touch-rail [data-testid^="section-"]')
    .evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).dataset.testid));
  const map = rail.indexOf('section-map');
  expect(map).toBeGreaterThanOrEqual(0);
  const below = rail[map + 1]!;
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedId(page)).toBe(below);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => focusedId(page)).toBe('section-map');

  // Enter presses the section below; Esc goes back to the map.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(() => currentSection(page)).toBe(below);
  await page.keyboard.press('Escape');
  await expect.poll(() => currentSection(page)).toBe('section-map');

  // Right of the rail is the panel or the map, never the rail again.
  await page.locator(`[data-testid="${below}"]`).focus();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('.touch-rail') === null))
    .toBe(true);

  // A press of the mouse takes the wide ring off.
  await page.mouse.click(5, 790);
  expect(await moving(page)).toBe(false);
  expect(errors).toEqual([]);
});

test('on the map the arrow keys move the map, and Esc leaves it', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page, './#@4096,4096,3');
  await mapSettled(page);
  const before = await mapStatus(page);
  await page.getByTestId('map').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await mapStatus(page)).x).toBeGreaterThan(before.x);
  expect(await focusedId(page)).toBe('map');

  // Nothing is open, so Esc moves the focus out of the map, to the section shown.
  await page.keyboard.press('Escape');
  await expect.poll(() => focusedId(page)).toBe('section-map');
  expect(errors).toEqual([]);
});

test('in a dialog the focus stays in it, and Esc closes it', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page);
  await page.keyboard.press('?');
  const dialog = page.getByTestId('keys-dialog');
  await expect(dialog).toBeVisible();
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowUp']) {
    await page.keyboard.press(key);
    expect(
      await page.evaluate(
        () => document.activeElement?.closest('[data-testid="keys-dialog"]') !== null,
      ),
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

test('a text field keeps its arrow keys while typing', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page);
  const input = page.getByTestId('search-input');
  await input.click();
  await input.fill('Way');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await expect(input).toBeFocused();
  expect(errors).toEqual([]);
});

test('after a press of the mouse with nothing focused, the arrow keys focus nothing', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openMap(page);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await page.keyboard.press('ArrowDown');
  expect(await focusedId(page)).toBe('body');
  expect(await moving(page)).toBe(false);
  expect(errors).toEqual([]);
});

/** The buttons of the standard gamepad layout. */
const PAD = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  lb: 4,
  rb: 5,
  lt: 6,
  rt: 7,
  view: 8,
  menu: 9,
  r3: 11,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
} as const;

/** A stand-in gamepad in the standard layout, read through `navigator.getGamepads`. */
async function withGamepad(page: Page, id = 'Stand-in gamepad (STANDARD GAMEPAD)'): Promise<void> {
  await page.addInitScript((padId) => {
    const pad = {
      id: padId,
      index: 0,
      connected: true,
      mapping: 'standard',
      timestamp: 0,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    (window as unknown as { testPad: typeof pad }).testPad = pad;
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => [pad],
    });
  }, id);
}

/** Presses a gamepad button and lets it go, a few frames each. */
async function pressButton(page: Page, button: number): Promise<void> {
  await setButton(page, button, 1);
  await page.waitForTimeout(120);
  await setButton(page, button, 0);
  await page.waitForTimeout(120);
}

/** Holds a button (or pulls a trigger) as far as `value`, from 0 to 1. */
async function setButton(page: Page, button: number, value: number): Promise<void> {
  await page.evaluate(
    ([index, amount]) => {
      const pad = (
        window as unknown as { testPad: { buttons: { pressed: boolean; value: number }[] } }
      ).testPad;
      pad.buttons[index!] = { pressed: amount! > 0.5, value: amount! };
    },
    [button, value],
  );
}

/** Leans the sticks: left x and y, right x and y, each from -1 to 1. */
async function setSticks(page: Page, axes: [number, number, number, number]): Promise<void> {
  await page.evaluate((values) => {
    (window as unknown as { testPad: { axes: number[] } }).testPad.axes = values;
  }, axes);
}

/** Leans the left stick a little to the right for a few frames, as a person picking it up. */
async function nudge(page: Page): Promise<void> {
  await setSticks(page, [0.5, 0, 0, 0]);
  await page.waitForTimeout(120);
  await setSticks(page, [0, 0, 0, 0]);
  await page.waitForTimeout(120);
}

const hints = (page: Page) => page.getByTestId('pad-hints');

/** The location the crosshair holds, by its id, or '' when none. */
const heldLocation = async (page: Page) => {
  const target = page.getByTestId('pad-reticle-target');
  return (await target.count()) > 0 ? ((await target.getAttribute('data-location')) ?? '') : '';
};

test('on the map the left stick moves it and the triggers zoom, with a crosshair and hints', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await withGamepad(page);
  await openMap(page, './#@4096,4096,3');
  await mapSettled(page);

  // A notice says the controller reaches Atlas, and where its buttons are shown.
  await expect(page.getByText(/^A controller is connected\./)).toContainText('Press View');

  // The left stick moves the map; its use shows the crosshair and the hints of the map.
  const before = await mapStatus(page);
  await setSticks(page, [1, 0, 0, 0]);
  await expect.poll(async () => (await mapStatus(page)).x).toBeGreaterThan(before.x + 100);
  await setSticks(page, [0, 0, 0, 0]);
  await expect(page.getByTestId('pad-reticle')).toBeVisible();
  await expect(hints(page)).toBeVisible();
  await expect(hints(page)).toHaveAttribute('data-context', 'map');
  await expect(hints(page).locator('.pad-hint-label')).toHaveText([
    'Move',
    'Zoom',
    'Open',
    'Found',
    'Filters',
    'Sections',
  ]);
  // Up on the stick moves the map up.
  const across = await mapStatus(page);
  await setSticks(page, [0, -1, 0, 0]);
  await expect.poll(async () => (await mapStatus(page)).y).toBeLessThan(across.y - 100);
  await setSticks(page, [0, 0, 0, 0]);
  await mapSettled(page);

  // The right trigger zooms in, the left one out, about the middle.
  const start = await mapStatus(page);
  await setButton(page, PAD.rt, 1);
  await expect.poll(async () => (await mapStatus(page)).zoom).toBeGreaterThan(start.zoom + 0.5);
  await setButton(page, PAD.rt, 0);
  await mapSettled(page);
  const zoomed = await mapStatus(page);
  expect(Math.abs(zoomed.x - start.x)).toBeLessThan(4);
  expect(Math.abs(zoomed.y - start.y)).toBeLessThan(4);
  await setButton(page, PAD.lt, 1);
  await expect.poll(async () => (await mapStatus(page)).zoom).toBeLessThan(zoomed.zoom - 0.5);
  await setButton(page, PAD.lt, 0);

  // R3 shows the whole map.
  await mapSettled(page);
  await pressButton(page, PAD.r3);
  await mapSettled(page);
  expect((await mapStatus(page)).zoom).toBeLessThan(start.zoom);

  // A move of the mouse hides the hints and the crosshair; the controller brings them back.
  await page.mouse.move(600, 300);
  await page.mouse.move(640, 340);
  await expect(hints(page)).toBeHidden();
  await expect(page.getByTestId('pad-reticle')).toHaveCount(0);
  await setSticks(page, [0.6, 0, 0, 0]);
  await expect(hints(page)).toBeVisible();
  await setSticks(page, [0, 0, 0, 0]);
  expect(errors).toEqual([]);
});

test('the crosshair holds a location: A opens it, again into its card, X marks it, B closes it', async ({
  page,
  request,
}) => {
  const errors = collectErrors(page);
  await withGamepad(page);
  await openMap(page);
  const layer = (await mapStatus(page)).layer;
  const locations = (await demoLocations(request)).filter((l) => l.layerId === layer);
  const place = locations[Math.floor(locations.length / 2)]!;
  await page.goto(`./#@${place.x},${place.y},5`);
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
  await mapSettled(page);

  // The crosshair holds the location in the middle, ringed and named.
  await nudge(page);
  await expect.poll(() => heldLocation(page)).not.toBe('');
  const held = await heldLocation(page);
  const name = locations.find((l) => l.id === held)?.name ?? '';
  await expect(page.locator('.pad-reticle-name')).toContainText(name);

  // A opens it.
  await pressButton(page, PAD.a);
  await expect(page.getByTestId('place-sheet')).toBeVisible();
  await expect(page.getByTestId('selected-name')).toHaveText(name);

  // X marks it found, and again not found.
  await pressButton(page, PAD.x);
  await expect(page.getByTestId('toast')).toContainText(`${name}: found.`);
  await pressButton(page, PAD.x);
  await expect(page.getByTestId('toast')).toContainText(`${name}: not found.`);

  // A again moves into its card: the hints are the card's.
  await pressButton(page, PAD.a);
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.closest('[data-testid="place-sheet"]') !== null),
    )
    .toBe(true);
  await expect(hints(page)).toHaveAttribute('data-context', 'card');

  // B closes the card, and the controller moves the map again.
  await pressButton(page, PAD.b);
  await expect(page.getByTestId('place-sheet')).toHaveCount(0);
  await expect(hints(page)).toHaveAttribute('data-context', 'map');

  // The D-pad goes to the next location that way, and the map with it.
  const before = await mapStatus(page);
  await pressButton(page, PAD.right);
  await mapSettled(page);
  const after = await mapStatus(page);
  expect(after.x).toBeGreaterThan(before.x);
  await expect.poll(() => heldLocation(page)).not.toBe(held);
  expect(errors).toEqual([]);
});

test('the bumpers switch sections, and B leaves the map and goes back to it', async ({ page }) => {
  const errors = collectErrors(page);
  await withGamepad(page);
  await openMap(page, './#@4096,4096,3');
  await mapSettled(page);
  const rail = await page
    .locator('.touch-rail [data-testid^="section-"]')
    .evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).dataset.testid));
  const map = rail.indexOf('section-map');
  const below = rail[map + 1]!;

  // RB: the next section, LB: the one before, from the map itself.
  await pressButton(page, PAD.rb);
  await expect.poll(() => currentSection(page)).toBe(below);
  await pressButton(page, PAD.lb);
  await expect.poll(() => currentSection(page)).toBe('section-map');
  await expect(hints(page)).toHaveAttribute('data-context', 'map');

  // B with nothing open leaves the map, to the sections; the D-pad moves there and A presses.
  await pressButton(page, PAD.b);
  await expect.poll(() => focusedId(page)).toBe('section-map');
  await expect(hints(page)).toHaveAttribute('data-context', 'menus');
  await pressButton(page, PAD.down);
  await expect.poll(() => focusedId(page)).toBe(below);
  await pressButton(page, PAD.a);
  await expect.poll(() => currentSection(page)).toBe(below);
  // B goes back to the map's section, then to the map itself.
  await pressButton(page, PAD.b);
  await expect.poll(() => currentSection(page)).toBe('section-map');
  await pressButton(page, PAD.b);
  await expect(hints(page)).toHaveAttribute('data-context', 'map');
  expect(await focusedId(page)).toBe('body');

  // Y: the types and filters, with the focus in them; B: back to the map.
  await pressButton(page, PAD.y);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.closest('[data-testid="filters-panel"]') !== null,
      ),
    )
    .toBe(true);
  await pressButton(page, PAD.b);
  await expect(hints(page)).toHaveAttribute('data-context', 'map');
  expect(errors).toEqual([]);
});

test('View opens the guide of keys and controller, with both columns', async ({ page }) => {
  const errors = collectErrors(page);
  await withGamepad(page);
  await openMap(page);
  await pressButton(page, PAD.view);
  const dialog = page.getByTestId('keys-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Keys and controller' })).toBeVisible();
  const mapRows = dialog.getByTestId('keys-map');
  await expect(mapRows.locator('th')).toHaveText(['What', 'Keyboard', 'Controller']);
  const pan = mapRows.locator('tr[data-action="pan"]');
  await expect(pan.locator('kbd')).toHaveText(['W', 'A', 'S', 'D']);
  await expect(pan.getByRole('img', { name: 'Left stick' })).toBeVisible();
  const zoom = mapRows.locator('tr[data-action="zoom"]');
  await expect(zoom.getByRole('img')).toHaveCount(2);
  await expect(
    dialog.getByTestId('keys-everywhere').getByRole('img', { name: 'LB' }),
  ).toBeVisible();
  // The hints inside it are a menu's; B closes it.
  await expect(hints(page)).toHaveAttribute('data-context', 'menus');
  await pressButton(page, PAD.b);
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

test('a controller with shapes on its buttons gets them in the hints', async ({ page }) => {
  const errors = collectErrors(page);
  await withGamepad(page, 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)');
  await openMap(page);
  await nudge(page);
  await expect(hints(page).getByRole('img', { name: 'Cross' })).toBeVisible();
  await expect(hints(page).getByRole('img', { name: 'L2' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the map keys move and zoom the map, and show the crosshair', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page, './#@4096,4096,3');
  await mapSettled(page);
  const before = await mapStatus(page);
  await page.keyboard.down('d');
  await expect.poll(async () => (await mapStatus(page)).x).toBeGreaterThan(before.x + 50);
  await page.keyboard.up('d');
  await expect(page.getByTestId('pad-reticle')).toBeVisible();
  await mapSettled(page);
  const moved = await mapStatus(page);
  await page.keyboard.down('+');
  await expect.poll(async () => (await mapStatus(page)).zoom).toBeGreaterThan(moved.zoom);
  await page.keyboard.up('+');
  // E: the next section; Q: back.
  await page.keyboard.press('e');
  await expect.poll(() => currentSection(page)).not.toBe('section-map');
  await page.keyboard.press('q');
  await expect.poll(() => currentSection(page)).toBe('section-map');
  // A press of the mouse takes the crosshair off.
  await page.mouse.click(5, 790);
  await expect(page.getByTestId('pad-reticle')).toHaveCount(0);
  expect(errors).toEqual([]);
});
