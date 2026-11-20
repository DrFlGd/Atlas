import type { Page } from '@playwright/test';
import { collectErrors, mapStatus, openMap } from './helpers';
import { expect, test } from './layout';
import { mapSettled } from './touch';

/**
 * Moving around the app with the keys alone and with a gamepad, as on a
 * Steam Deck in Game Mode (`src/controller.ts`): the arrow keys move the
 * focus to the nearest control, Enter presses, Esc goes back and leaves
 * the map, the map keeps its own arrow keys, a text field keeps them while
 * typing, and the mouse works as before. The gamepad is a stand-in that
 * the page reads through `navigator.getGamepads`, as it reads a real one.
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

/** A stand-in gamepad in the standard layout, read through `navigator.getGamepads`. */
async function withGamepad(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const pad = {
      id: 'Stand-in gamepad',
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
  });
}

/** Presses a gamepad button and lets it go, a few frames each. */
async function pressButton(page: Page, button: number): Promise<void> {
  await setButton(page, button, true);
  await page.waitForTimeout(120);
  await setButton(page, button, false);
  await page.waitForTimeout(120);
}

async function setButton(page: Page, button: number, pressed: boolean): Promise<void> {
  await page.evaluate(
    ([index, down]) => {
      const pad = (
        window as unknown as { testPad: { buttons: { pressed: boolean; value: number }[] } }
      ).testPad;
      pad.buttons[index as number] = { pressed: down as boolean, value: down ? 1 : 0 };
    },
    [button, pressed],
  );
}

test('a gamepad moves the focus, presses, goes back and moves the map', async ({ page }) => {
  const errors = collectErrors(page);
  await withGamepad(page);
  await openMap(page, './#@4096,4096,3');
  await mapSettled(page);

  // A notice says the controller reaches Atlas.
  await expect(page.getByText(/^A controller is connected\./)).toBeVisible();

  // D-pad down starts at the section shown, then moves down the rail.
  await pressButton(page, 13);
  await expect.poll(() => focusedId(page)).toBe('section-map');
  await pressButton(page, 13);
  const below = await focusedId(page);
  expect(below).toMatch(/^section-/);
  expect(below).not.toBe('section-map');

  // A presses it; B goes back to the map.
  await pressButton(page, 0);
  await expect.poll(() => currentSection(page)).toBe(below);
  await pressButton(page, 1);
  await expect.poll(() => currentSection(page)).toBe('section-map');

  // The right shoulder switches to the next section.
  await pressButton(page, 5);
  await expect.poll(() => currentSection(page)).toBe(below);
  await pressButton(page, 4);
  await expect.poll(() => currentSection(page)).toBe('section-map');

  // With the map focused, the right stick moves it.
  await page.getByTestId('map').focus();
  const before = await mapStatus(page);
  await page.evaluate(() => {
    (window as unknown as { testPad: { axes: number[] } }).testPad.axes = [0, 0, 1, 0];
  });
  await expect.poll(async () => (await mapStatus(page)).x).toBeGreaterThan(before.x + 50);
  await page.evaluate(() => {
    (window as unknown as { testPad: { axes: number[] } }).testPad.axes = [0, 0, 0, 0];
  });
  expect(await focusedId(page)).toBe('map');

  // B with nothing open leaves the map.
  await pressButton(page, 1);
  await expect.poll(() => focusedId(page)).toBe('section-map');
  expect(errors).toEqual([]);
});
