import type { CDPSession, Page } from '@playwright/test';
import { collectErrors, demoLocations, mapStatus, openMap } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, realErrors, setUp } from './fakeShell';
import {
  choosePlace,
  expectFound,
  mapSettled,
  pressAndHold,
  reportMouse,
  screenPoint,
} from './touch';

/**
 * The setting "Controls" and the version of the standard layout for
 * fingers on a computer with a touch screen, such as a Steam Deck
 * (`src/touch/controls.ts`, `followControls.ts`, `styles/handheld.css`).
 * The context has a touch screen of 1280 by 800 whose system still
 * reports a mouse, as the Deck's trackpads make it (`reportMouse`).
 */

test.use({
  layout: null,
  viewport: { width: 1280, height: 800 },
  hasTouch: true,
  isMobile: false,
});

const shell = (page: Page) => page.locator('.touch');

/** Opens Settings: under Games in a browser, its own section in the desktop app. */
async function openSettings(page: Page) {
  const own = page.getByTestId('section-settings');
  await ((await own.count()) > 0 ? own : page.getByTestId('section-games')).click();
  await expect(page.getByTestId('controls-setting')).toBeVisible();
}

/** A finger put down on a point, held, and lifted with `lift`. */
async function fingerDown(page: Page, point: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  const touchPoints = [{ x: Math.round(point.x), y: Math.round(point.y) }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
  return {
    lift: async () => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    },
  };
}

/** Moves fingers in steps from where they start to where they end. */
async function slide(
  cdp: CDPSession,
  from: { x: number; y: number }[],
  to: { x: number; y: number }[],
) {
  const at = (step: number) =>
    from.map((start, n) => ({
      x: Math.round(start.x + ((to[n]!.x - start.x) * step) / 10),
      y: Math.round(start.y + ((to[n]!.y - start.y) * step) / 10),
      id: n,
    }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
  for (let step = 1; step <= 10; step++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(step) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('on a computer whose screen is not a Steam Deck', () => {
  test.use({ screen: { width: 1920, height: 1080 } });

  test('Automatic changes to the finger version when the screen is touched, and keeps the map where it was', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await reportMouse(page);
    await openMap(page);
    await expect(shell(page)).toHaveAttribute('data-input', 'mouse');
    await expect(page.getByTestId('controls-now')).toHaveCount(0);
    await openSettings(page);
    await expect(page.getByTestId('controls-auto')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('controls-now')).toHaveText(
      'Now: for a mouse, because the screen has not been touched.',
    );
    await page.getByTestId('section-map').click();
    await mapSettled(page);
    const before = await mapStatus(page);

    // A finger on the empty part of the rail: the finger version, once it is lifted.
    const finger = await fingerDown(page, { x: 40, y: 560 });
    await page.waitForTimeout(800);
    await expect(shell(page)).toHaveAttribute('data-input', 'mouse');
    await finger.lift();
    await expect(shell(page)).toHaveAttribute('data-input', 'touch');
    await expect(shell(page)).toHaveAttribute('data-handheld', '');
    await mapSettled(page);
    const after = await mapStatus(page);
    expect(after.zoom).toBe(before.zoom);
    expect(Math.abs(after.x - before.x)).toBeLessThan(2);
    expect(Math.abs(after.y - before.y)).toBeLessThan(2);

    await openSettings(page);
    await expect(page.getByTestId('controls-now')).toHaveText(
      'Now: for fingers, because the screen was touched.',
    );
    // Presses of the mouse soon after do not change it back.
    for (let n = 0; n < 6; n++) await page.getByTestId('controls-setting').click();
    await page.waitForTimeout(600);
    await expect(shell(page)).toHaveAttribute('data-input', 'touch');
    expect(errors).toEqual([]);
  });

  test('Automatic waits while a dialog is open, and the mouse used for a while brings the mouse version back', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.clock.install();
    await reportMouse(page);
    await openMap(page);
    await page.locator('.touch-rail-profile').click();
    const dialog = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('heading') })
      .first();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('heading').first().tap();
    await page.waitForTimeout(800);
    await expect(shell(page)).toHaveAttribute('data-input', 'mouse');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(shell(page)).toHaveAttribute('data-input', 'touch');

    // Five presses of the mouse two minutes after the last touch.
    await page.clock.fastForward('02:01');
    for (let n = 0; n < 5; n++)
      await page.locator('.touch-panel').click({ position: { x: 5, y: 5 } });
    await expect(shell(page)).toHaveAttribute('data-input', 'mouse');
    await openSettings(page);
    await expect(page.getByTestId('controls-now')).toHaveText(
      'Now: for a mouse, because the mouse was used for a while without a touch.',
    );
    expect(errors).toEqual([]);
  });

  test('For fingers and For a mouse are kept, as the theme is', async ({ page }) => {
    const errors = collectErrors(page);
    await reportMouse(page);
    await openMap(page);
    await openSettings(page);
    await page.getByTestId('controls-touch').click();
    await expect(shell(page)).toHaveAttribute('data-input', 'touch');
    await expect(page.getByTestId('controls-touch')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('controls-now')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    await expect(shell(page)).toHaveAttribute('data-input', 'touch');

    // For a mouse stays so, a touch or not.
    await openSettings(page);
    await page.getByTestId('controls-mouse').tap();
    await expect(shell(page)).toHaveAttribute('data-input', 'mouse');
    await page.getByTestId('controls-setting').tap();
    await page.waitForTimeout(800);
    await expect(shell(page)).toHaveAttribute('data-input', 'mouse');
    await page.getByTestId('controls-auto').tap();
    await expect(shell(page)).toHaveAttribute('data-input', 'touch');
    expect(errors).toEqual([]);
  });

  test('a phone or tablet that reports no mouse keeps the finger version as before', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    // No `reportMouse`: Chromium with a touch screen reports a coarse pointer only.
    await openMap(page);
    await expect(shell(page)).toHaveAttribute('data-input', 'touch');
    await expect(shell(page)).not.toHaveAttribute('data-handheld', '');
    await openSettings(page);
    await expect(page.getByTestId('controls-now')).toHaveText(
      'Now: for fingers, because this screen is a touch screen without a mouse.',
    );
    expect(errors).toEqual([]);
  });
});

test.describe('on a Steam Deck', () => {
  test.use({ screen: { width: 1280, height: 800 } });
  test.skip(DOWNLOADS_BUILD, 'The Steam Deck build is the app without downloads.');

  test('starts in the finger version, with the controls where the thumbs reach', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await reportMouse(page);
    await setUp(page, false, {
      steamLaunch: {
        state: 'usual',
        line: `bash -c '"$HOME/Applications/Atlas.AppImage" --background & exec "$@"' -- %command%`,
      },
    });
    await expect(shell(page)).toHaveAttribute('data-input', 'touch');
    await expect(shell(page)).toHaveAttribute('data-handheld', '');
    // The mouse (here, the Deck's trackpads) does not change it.
    await page.getByTestId('section-settings').click();
    await expect(page.getByTestId('controls-now')).toHaveText(
      'Now: for fingers, because this looks like a Steam Deck, with a touch screen of 1280 by 800 on Linux.',
    );
    await expect(page.getByTestId('settings-steam-launch')).toBeVisible();
    await page.getByTestId('section-map').tap();

    // The sections at the foot of the rail, in the lower left corner.
    const sections = page.locator('.touch-rail [data-testid^="section-"]');
    const last = (await sections.last().boundingBox())!;
    expect(last.y + last.height).toBeGreaterThan(800 - 40);
    expect((await page.locator('.touch-rail-profile').boundingBox())!.y).toBeLessThan(80);
    // Nearest unfound in the lower right corner.
    const nearest = (await page.getByTestId('nearest-unfound').boundingBox())!;
    expect(nearest.x + nearest.width).toBeGreaterThan(1280 - 40);
    expect(nearest.y + nearest.height).toBeGreaterThan(800 - 40);

    // The card's two buttons at its foot, in the lower right corner.
    await choosePlace(page, 'Saltleaf 1');
    const card = (await page.getByTestId('place-sheet').boundingBox())!;
    const mark = (await page.getByTestId('mark-found').boundingBox())!;
    expect(mark.y + mark.height).toBeGreaterThan(card.y + card.height - 40);

    // Every target in view is at least 44 pixels, text links in a page aside.
    for (const section of ['map', 'guides', 'lists', 'progress', 'settings', 'library']) {
      await page.getByTestId(`section-${section}`).tap();
      await page.waitForTimeout(300);
      expect(await smallTargets(page), section).toEqual([]);
    }

    await page.getByTestId('section-settings').tap();
    await expect(page.getByTestId('controls-now')).toHaveText(
      'Now: for fingers, because the screen was touched.',
    );
    expect(realErrors(errors)).toEqual([]);
  });

  test('the map pans with one finger and zooms with two, and holding a location marks it', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await reportMouse(page);
    await setUp(page, false, {
      steamLaunch: { state: 'usual', line: 'bash' },
    });
    await page.getByTestId('section-map').tap();

    // Press and hold, where the mouse version uses a right click.
    const place = (await demoLocations(page.request)).find((l) => l.name === 'Saltleaf 1')!;
    await choosePlace(page, place.name);
    await page.getByTestId('close-place').tap();
    await expect(page.getByTestId('place-sheet')).toHaveCount(0);
    await pressAndHold(page, await screenPoint(page, place));
    await expectFound(page, 1);
    await expect(page.getByTestId('place-sheet')).toHaveCount(0);

    await mapSettled(page);
    const box = (await page.getByTestId('map').boundingBox())!;
    const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const cdp = await page.context().newCDPSession(page);

    const start = await mapStatus(page);
    await slide(cdp, [middle], [{ x: middle.x - 200, y: middle.y - 120 }]);
    await mapSettled(page);
    const panned = await mapStatus(page);
    expect(panned.zoom).toBe(start.zoom);
    expect(panned.x).toBeGreaterThan(start.x);
    expect(panned.y).toBeGreaterThan(start.y);

    await slide(
      cdp,
      [
        { x: middle.x - 40, y: middle.y },
        { x: middle.x + 40, y: middle.y },
      ],
      [
        { x: middle.x - 200, y: middle.y },
        { x: middle.x + 200, y: middle.y },
      ],
    );
    await mapSettled(page);
    expect((await mapStatus(page)).zoom).toBeGreaterThan(panned.zoom);
    await cdp.detach();
    expect(realErrors(errors)).toEqual([]);
  });

  test('a dialog sits at the top, clear of the on-screen keyboard, and stays open when its text field is pressed', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await reportMouse(page);
    await setUp(page, false, { steamLaunch: { state: 'usual', line: 'bash' } });
    await page.locator('.touch-rail-profile').tap();
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    expect((await dialog.boundingBox())!.y).toBeLessThan(40);
    expect(await smallTargets(page)).toEqual([]);
    const field = dialog.getByRole('textbox').first();
    await field.tap();
    await expect(field).toBeFocused();
    await page.waitForTimeout(500);
    await expect(dialog).toBeVisible();
    // The field is in the upper part of the screen, above where the keyboard comes up.
    const box = (await field.boundingBox())!;
    expect(box.y + box.height).toBeLessThan(800 * 0.6);
    expect(realErrors(errors)).toEqual([]);
  });

  test('the arrow keys still move between controls in the finger version', async ({ page }) => {
    const errors = collectErrors(page);
    await reportMouse(page);
    await setUp(page, false, { steamLaunch: { state: 'usual', line: 'bash' } });
    await expect(shell(page)).toHaveAttribute('data-handheld', '');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('section-map')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('section-guides')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.touch')).toHaveAttribute('data-section', 'guides');
    expect(realErrors(errors)).toEqual([]);
  });
});

/** The controls in view smaller than 44 pixels either way, but text links in a page. */
function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const small: string[] = [];
    const controls = document.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, summary, [role="button"], [role="switch"], [role="tab"]',
    );
    for (const control of controls) {
      const box = control.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth)
        continue;
      // Text links inside a page's text, and the map's credits, are words in a line.
      if (control.closest('.app-link, .guides-page-body a, .leaflet-control-attribution')) continue;
      if (box.width < 44 || box.height < 44) {
        small.push(
          `${control.dataset.testid ?? control.className} ${Math.round(box.width)}x${Math.round(box.height)}`,
        );
      }
    }
    return small;
  });
}
