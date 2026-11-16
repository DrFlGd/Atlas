import { mkdir } from 'node:fs/promises';
import { devices, type Page } from '@playwright/test';
import { collectErrors, openGuidesSection, storedSetting } from './helpers';
import { expect, test } from './layout';

/**
 * The width a game's guide pages are shown at, on the demo wiki's made-up
 * pages: a column of text by default, wider or as wide as the window by
 * the person's choice in the head of Guides, which is kept with their own
 * pages, or by the pack's default (`pageWidth` of its manifest). A phone
 * always shows a page as wide as the phone. With ATLAS_WIDTH_SHOTS set to
 * a folder, the tests also keep screenshots there.
 */

test.use({ layout: 'standard', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

const SHOTS = process.env.ATLAS_WIDTH_SHOTS;
const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

const column = (page: Page) => page.locator('.guides-column');
const shownPage = (page: Page) => page.getByTestId('guides-page');
const widthOf = async (page: Page) => (await column(page).boundingBox())!.width;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS.replace(/\/$/, '')}/${name}.png` });
}

/** Opens a page of the demo wiki in Guides. */
async function openPage(page: Page, section: string, name: string): Promise<void> {
  await page.getByTestId('section-guides').click();
  await expect(page.getByTestId('guides-screen')).toBeVisible();
  await openGuidesSection(page, section);
  await page
    .getByTestId('guides-body')
    .getByTestId('guides-page-link')
    .filter({ hasText: name })
    .first()
    .click();
  await expect(shownPage(page).locator('h1')).toHaveText(name);
}

/** Chooses a width in the menu of the head of Guides. */
async function choose(page: Page, width: 'reading' | 'wide' | 'full'): Promise<void> {
  await page.getByTestId('guides-width').click();
  await page.getByTestId(`guides-width-${width}`).click();
  await expect(page.getByTestId('guides-width')).toHaveAttribute('data-width', width);
}

test.describe('on a computer', () => {
  test('shows the pages as a column of text, wider or as wide as the window, as the person chooses, and keeps it', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await openPage(page, 'Basics', 'Isle portal');
    const body = (await page.getByTestId('guides-body').boundingBox())!;

    // A column of text, as before.
    const button = page.getByTestId('guides-width');
    await expect(button).toHaveAttribute('data-width', 'reading');
    await expect(button).toHaveAccessibleName('Page width: Reading');
    expect(await widthOf(page)).toBeLessThanOrEqual(760);
    await shot(page, 'page-width-reading');

    // The menu: three widths, the one shown checked, the site's named.
    await button.click();
    const menu = page.getByRole('menu', { name: 'Page width' });
    await expect(menu.getByRole('menuitemradio')).toHaveText([
      /^Reading · the site’s width/,
      /^Wide/,
      /^Full/,
    ]);
    await expect(menu.getByRole('menuitemradio', { name: /^Reading/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(menu.getByRole('menuitemradio', { name: /^Reading/ })).toBeFocused();
    await shot(page, 'page-width-menu');
    // Closed with Escape, back on its button.
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(button).toBeFocused();

    await choose(page, 'wide');
    const wide = await widthOf(page);
    expect(wide).toBeGreaterThan(900);
    expect(wide).toBeLessThanOrEqual(1000);
    // The forms of the page use the room: blocks side by side are wider.
    await shot(page, 'page-width-wide');

    await choose(page, 'full');
    const full = await widthOf(page);
    expect(full).toBeGreaterThan(wide);
    // As wide as the window's part for pages, with the reader's side margins.
    expect(full).toBeLessThanOrEqual(body.width - 32);
    expect(full).toBeGreaterThan(body.width - 64);
    await shot(page, 'page-width-full');

    // Kept with the person's own pages, and after the app is opened again.
    await expect
      .poll(async () => {
        const stored = await storedSetting(page, 'ownPages:demo');
        return typeof stored === 'string' ? (JSON.parse(stored) as { pageWidth?: string }) : null;
      })
      .toMatchObject({ pageWidth: 'full' });
    await page.reload();
    await openPage(page, 'Basics', 'Isle portal');
    await expect(page.getByTestId('guides-width')).toHaveAttribute('data-width', 'full');
    expect(await widthOf(page)).toBeCloseTo(full, 0);
    // No page scrolls sideways at any width.
    expect(
      await page
        .getByTestId('guides-body')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);

    // A page with a table and "On this page", at full width.
    await openPage(page, 'The isle', 'Waystones');
    await expect(shownPage(page).locator('table')).toBeVisible();
    await shot(page, 'page-width-full-table');
    // A page with a box of facts beside its text, wide.
    await choose(page, 'wide');
    await openPage(page, 'Gear', 'Stonebreaker maul');
    await expect(shownPage(page).locator('aside[data-box]')).toBeVisible();
    await shot(page, 'page-width-wide-box');
    await choose(page, 'reading');
    expect(await widthOf(page)).toBeLessThanOrEqual(760);
    expect(realErrors(errors)).toEqual([]);
  });

  test('shows the pages at the width the pack gives, until the person chooses another', async ({
    page,
  }) => {
    await page.route('**/packs/demo/manifest.json', async (route) => {
      const manifest = (await (await route.fetch()).json()) as Record<string, unknown>;
      return route.fulfill({ json: { ...manifest, pageWidth: 'wide' } });
    });
    await page.goto('./');
    await openPage(page, 'Basics', 'Isle portal');
    await expect(page.getByTestId('guides-width')).toHaveAttribute('data-width', 'wide');
    expect(await widthOf(page)).toBeGreaterThan(900);
    await page.getByTestId('guides-width').click();
    await expect(page.getByRole('menuitemradio')).toHaveText([
      /^Reading/,
      /^Wide · the site’s width/,
      /^Full/,
    ]);
    await page.getByTestId('guides-width-reading').click();
    expect(await widthOf(page)).toBeLessThanOrEqual(760);
    // The person's choice wins over the pack's after the app is opened again.
    await expect
      .poll(async () => {
        const stored = await storedSetting(page, 'ownPages:demo');
        return typeof stored === 'string' ? (JSON.parse(stored) as { pageWidth?: string }) : null;
      })
      .toMatchObject({ pageWidth: 'reading' });
    await page.reload();
    await openPage(page, 'Basics', 'Isle portal');
    await expect(page.getByTestId('guides-width')).toHaveAttribute('data-width', 'reading');
  });

  test('ignores a width the pack gives that it cannot read', async ({ page }) => {
    await page.route('**/packs/demo/manifest.json', async (route) => {
      const manifest = (await (await route.fetch()).json()) as Record<string, unknown>;
      return route.fulfill({ json: { ...manifest, pageWidth: 1200 } });
    });
    await page.goto('./');
    await openPage(page, 'Basics', 'Isle portal');
    await expect(page.getByTestId('guides-width')).toHaveAttribute('data-width', 'reading');
  });
});

test.describe('on a phone', () => {
  test.use({ ...pixel, deviceScaleFactor: 2 });

  test('shows a page as wide as the phone, whatever width was chosen', async ({ page }) => {
    await page.route('**/packs/demo/manifest.json', async (route) => {
      const manifest = (await (await route.fetch()).json()) as Record<string, unknown>;
      return route.fulfill({ json: { ...manifest, pageWidth: 'full' } });
    });
    await page.goto('./');
    await openPage(page, 'Basics', 'Isle portal');
    await expect(page.getByTestId('guides-width')).toHaveCount(0);
    await expect(column(page)).not.toHaveAttribute('data-width');
    const viewport = page.viewportSize()!;
    expect(await widthOf(page)).toBeLessThanOrEqual(viewport.width - 32);
    expect(await widthOf(page)).toBeGreaterThan(viewport.width - 40);
  });
});

/** Errors of the page, but those of pictures the demo pack has no file for. */
function realErrors(errors: string[]): string[] {
  return errors.filter((error) => !/Failed to load resource/u.test(error));
}
