import { devices, type Page } from '@playwright/test';
import { collectErrors, openGuidesSection } from './helpers';
import { expect, test } from './layout';
import { back } from './touch';

/**
 * The larger view of a picture in the text of a page
 * (components/PictureViewer.tsx): the demo pack's made-up wiki, its
 * Regions page served with pictures of every sort. The demo's waystone
 * picture is 640 by 400 pixels.
 */

test.use({ layout: 'standard' });

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

const shownPage = (page: Page) => page.getByTestId('guides-page');
const viewer = (page: Page) => page.getByTestId('photo-viewer');
const viewed = (page: Page) => page.getByTestId('photo-viewer-picture');

/** A page with a picture shown smaller than its file, an icon in a line, a linked icon and a hidden picture. */
const PICTURES = [
  'The old stone: ![a waystone](demo:picture:wiki-waystone "=320").',
  '',
  'A badge ![a small waystone](demo:picture:wiki-waystone "=24x15") in a line, and one that leads to [![Wolves](demo:picture:wiki-waystone "=24x15")](demo:guide:wiki-wolves).',
  '',
  'Under the lake: ||![the sunken waystone](demo:picture:wiki-waystone "=200")||',
].join('\n');

/** Serves the demo pack with the Regions page's text as `body`, and the pictures list changed by `pictures`. */
async function serveRegions(
  page: Page,
  body: string,
  pictures?: (list: Record<string, unknown>[]) => Record<string, unknown>[],
): Promise<void> {
  await page.route('**/packs/demo/guides.json', async (route) => {
    const response = await route.fetch();
    const all = (await response.json()) as { id: string; body: string }[];
    await route.fulfill({
      response,
      json: all.map((guide) =>
        guide.id === 'demo:guide:wiki-regions' ? { ...guide, body } : guide,
      ),
    });
  });
  if (pictures) {
    await page.route('**/packs/demo/pictures.json', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: pictures((await response.json()) as Record<string, unknown>[]),
      });
    });
  }
}

async function openRegions(page: Page): Promise<void> {
  await page.goto('./');
  await page.getByTestId('section-guides').click();
  await expect(page.getByTestId('guides-screen')).toBeVisible();
  await openGuidesSection(page, 'The isle');
  await page.getByTestId('guides-page-link').filter({ hasText: 'Regions' }).first().click();
  await expect(shownPage(page).locator('h1')).toHaveText('Regions');
}

test.describe('on a desktop', () => {
  test('opens a picture larger than shown, closes it every way, and leaves a linked one a link', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await serveRegions(page, PICTURES);
    await openRegions(page);
    const pictures = shownPage(page).locator('.guide-picture img');
    await expect(pictures).toHaveCount(4);
    const large = pictures.nth(0);
    const icon = pictures.nth(1);
    const linked = pictures.nth(2);
    await expect(large).toHaveAttribute('data-opens-large', '');
    await expect(large).toHaveAttribute('role', 'button');
    await expect(icon).toHaveAttribute('data-opens-large', '');
    // A picture that is a link is a link, as before.
    await expect(linked).not.toHaveAttribute('data-opens-large');

    // Pressed: over everything, fitted to the window, with its caption and size.
    await large.click();
    await expect(viewer(page)).toBeVisible();
    await expect(viewer(page)).toHaveAttribute('aria-label', /A woken waystone/);
    await expect(viewed(page)).toHaveAttribute('src', /pictures\/wiki-waystone\.png$/);
    await expect(viewer(page).locator('figcaption')).toContainText('A woken waystone');
    await expect(page.getByTestId('photo-viewer-size')).toContainText('640 × 400 pixels');
    await expect(viewer(page).getByRole('button', { name: 'Close picture' })).toBeFocused();
    // 640 by 400 fits a window of 1280 by 800: enlarged, with nothing more at real size.
    const box = await viewed(page).boundingBox();
    expect(box!.height).toBeGreaterThan(400);
    expect(box!.height).toBeLessThanOrEqual(800 - 120);
    expect(Math.round((box!.width / box!.height) * 100)).toBe(160);
    await expect(page.getByTestId('photo-viewer-zoom')).toHaveCount(0);
    // Escape closes it, and the focus is back on the picture.
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toBeHidden();
    await expect(large).toBeFocused();

    // From the keyboard; closed with its button.
    await page.keyboard.press('Enter');
    await expect(viewer(page)).toBeVisible();
    await viewer(page).getByRole('button', { name: 'Close picture' }).click();
    await expect(viewer(page)).toBeHidden();
    await expect(large).toBeFocused();

    // The icon in the line of text, named by its tooltip; a press beside it closes it.
    await icon.click();
    await expect(viewer(page)).toHaveAttribute('aria-label', 'A woken waystone');
    await page.mouse.click(4, 400);
    await expect(viewer(page)).toBeHidden();

    // Android's Back closes it, before going back a page.
    await icon.click();
    await expect(viewer(page)).toBeVisible();
    expect(await back(page)).toBe(true);
    await expect(viewer(page)).toBeHidden();
    await expect(shownPage(page).locator('h1')).toHaveText('Regions');

    // A hidden picture: the first press shows it, a later press opens it.
    await expect(pictures.nth(3)).toBeHidden();
    await shownPage(page).getByRole('button', { name: 'Show hidden text' }).click();
    await expect(pictures.nth(3)).toBeVisible();
    await expect(viewer(page)).toBeHidden();
    await expect(pictures.nth(3)).toHaveAttribute('data-opens-large', '');
    await pictures.nth(3).click();
    await expect(viewer(page)).toBeVisible();
    await page.keyboard.press('Escape');

    // The linked icon follows its link and opens nothing.
    await linked.click();
    await expect(shownPage(page).locator('h1')).toHaveText('Wolves');
    await expect(viewer(page)).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('shows a picture’s copy for pages on the page and its file in the larger view', async ({
    page,
  }) => {
    await serveRegions(
      page,
      'The old stone: ![a waystone](demo:picture:wiki-waystone "=320").',
      (list) =>
        list.map((picture) =>
          picture.id === 'demo:picture:wiki-waystone'
            ? { ...picture, pageCopy: { file: 'pictures/wiki-waystone.page.png', width: 640 } }
            : picture,
        ),
    );
    // The copy is the same drawing here; what matters is which file is asked for where.
    await page.route('**/packs/demo/pictures/wiki-waystone.page.png', async (route) =>
      route.fulfill({
        response: await route.fetch({
          url: route.request().url().replace('wiki-waystone.page.png', 'wiki-waystone.png'),
        }),
      }),
    );
    await openRegions(page);
    const picture = shownPage(page).locator('.guide-picture img');
    await expect(picture).toHaveAttribute('src', /pictures\/wiki-waystone\.page\.png$/);
    await expect(picture).toHaveAttribute('data-opens-large', '');
    await picture.click();
    await expect(viewed(page)).toHaveAttribute('src', /pictures\/wiki-waystone\.png$/);
    await page.keyboard.press('Escape');
  });

  test('shows the file on the page when its copy for pages is not there', async ({ page }) => {
    await serveRegions(
      page,
      'The old stone: ![a waystone](demo:picture:wiki-waystone "=320").',
      (list) =>
        list.map((picture) =>
          picture.id === 'demo:picture:wiki-waystone'
            ? { ...picture, pageCopy: { file: 'pictures/wiki-waystone.page.png', width: 640 } }
            : picture,
        ),
    );
    await page.route('**/packs/demo/pictures/wiki-waystone.page.png', (route) =>
      route.fulfill({ status: 404, body: 'not found' }),
    );
    await openRegions(page);
    const picture = shownPage(page).locator('.guide-picture img');
    await expect(picture).toHaveAttribute('src', /pictures\/wiki-waystone\.png$/);
    await expect(shownPage(page).locator('.guide-picture[data-missing]')).toHaveCount(0);
    await expect(picture).toHaveAttribute('data-opens-large', '');
  });
});

test.describe('on a phone', () => {
  test.use({ ...pixel });

  test('fits a picture wider than the screen, and shows it at real size to be moved around', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await serveRegions(page, PICTURES);
    await openRegions(page);
    await shownPage(page).locator('.guide-picture img').first().tap();
    await expect(viewer(page)).toBeVisible();
    const fitted = await viewed(page).boundingBox();
    expect(fitted!.width).toBeLessThanOrEqual(412 - 24);
    // At real size: one pixel of the file to one pixel of the page.
    const zoom = page.getByTestId('photo-viewer-zoom');
    await expect(zoom).toHaveAttribute('aria-pressed', 'false');
    await viewed(page).tap();
    await expect(zoom).toHaveAttribute('aria-pressed', 'true');
    await expect(viewer(page).locator('figure')).toHaveAttribute('data-zoom', 'real');
    const real = await viewed(page).evaluate((img: HTMLImageElement) => img.clientWidth);
    expect(real).toBe(640);
    const stage = page.getByTestId('photo-viewer-stage');
    const before = await stage.evaluate((el) => el.scrollLeft);
    expect(await stage.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // Dragged sideways, it moves; the end of a drag is no press.
    const at = await stage.boundingBox();
    const y = at!.y + at!.height / 2;
    await page.mouse.move(at!.x + 300, y);
    await page.mouse.down();
    await page.mouse.move(at!.x + 250, y, { steps: 4 });
    await page.mouse.move(at!.x + 200, y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => stage.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);
    await expect(zoom).toHaveAttribute('aria-pressed', 'true');
    // The arrow keys move it too.
    const dragged = await stage.evaluate((el) => el.scrollLeft);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => stage.evaluate((el) => el.scrollLeft)).toBeLessThan(dragged);
    // Back to fitted with the button; the page does not scroll sideways.
    await zoom.tap();
    await expect(zoom).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      412,
    );
    expect(await back(page)).toBe(true);
    await expect(viewer(page)).toBeHidden();
    expect(errors).toEqual([]);
  });
});
