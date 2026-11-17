import { mkdir } from 'node:fs/promises';
import { devices, type Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';

/**
 * The landing page of Guides, in the standard layout. The demo pack keeps
 * the made-up wiki's own home page (the manifest's `homePage`): Guides
 * opens on it, named after the game, and the game's name above every page
 * and at the top of the contents leads back to it. The same wiki served
 * without its home page gets a landing page made from its contents, its
 * sections as groups of tiles. Screenshots of both go to `SHOTS`.
 */

test.use({ layout: 'standard', deviceScaleFactor: 2 });

const SHOTS = process.env.ATLAS_LANDING_SHOTS ?? 'test-results/landing';
test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' });

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

const landing = (page: Page) => page.getByTestId('guides-home');
const shownPage = (page: Page) => page.getByTestId('guides-page');
const crumbs = (page: Page) => page.locator('.guides-crumbs');

/** Shows the app in a theme, as a site's settings would choose it. */
async function inTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.route('**/config.json', async (route) => {
    const config = (await (await route.fetch()).json()) as Record<string, unknown>;
    return route.fulfill({ json: { ...config, theme } });
  });
}

async function openGuides(page: Page, theme: 'light' | 'dark' = 'light'): Promise<void> {
  await inTheme(page, theme);
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.getByTestId('section-guides').click();
  await expect(page.getByTestId('guides-screen')).toBeVisible();
}

/** The demo's wiki as a game of its own whose home page was never read. */
async function serveWithoutHome(page: Page, theme: 'light' | 'dark' = 'light'): Promise<void> {
  await page.route('**/config.json', (route) =>
    route.fulfill({
      json: { packs: [{ id: 'demo', url: 'packs/wiki/', title: 'Example Wiki' }], theme },
    }),
  );
  await page.route('**/packs/wiki/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/packs/wiki/')[1] ?? '';
    if (!['manifest.json', 'sections.json', 'pictures.json', 'guides.json'].includes(name)) {
      if (!name.startsWith('pictures/')) return route.fulfill({ status: 404, body: 'not found' });
    }
    const response = await route.fetch({
      url: route.request().url().replace('/packs/wiki/', '/packs/demo/'),
    });
    if (name === 'manifest.json') {
      const { homePage: _home, ...manifest } = (await response.json()) as Record<string, unknown>;
      return route.fulfill({ json: { ...manifest, title: 'Example Wiki' } });
    }
    if (name === 'guides.json') {
      const all = (await response.json()) as { id: string }[];
      return route.fulfill({
        json: all.filter(
          (g) => g.id.startsWith('demo:guide:wiki-') && g.id !== 'demo:guide:wiki-main-page',
        ),
      });
    }
    return route.fulfill({ response });
  });
}

test.describe('on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('opens on the wiki’s home page, and the game’s name leads back to it', async ({ page }) => {
    const errors = collectErrors(page);
    await openGuides(page);
    // The home page, read as any page, headed with the game's name.
    await expect(landing(page)).toHaveAttribute('data-landing', 'page');
    await expect(shownPage(page)).toHaveAttribute('data-home', 'true');
    await expect(shownPage(page).locator('h1')).toHaveText('Atlas demo world');
    await expect(shownPage(page)).toContainText('Welcome to the Example Wiki');
    // Its picture leads to a page; its headings group the main areas.
    const picture = shownPage(page).locator('.app-link img, a img').first();
    await expect(picture).toBeVisible();
    await expect(
      shownPage(page).locator('.guides-page-body').getByRole('heading', { name: 'Foes' }),
    ).toBeVisible();
    // Here: the start of the way, and the top of the contents beside it.
    await expect(page.getByTestId('guides-crumb-game')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('guides-tree-home')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('guides-tree-home')).toHaveText('Atlas demo world');
    // Not a page about the map: nothing to add to a build, no "Linked from".
    await expect(page.getByTestId('linked-from')).toHaveCount(0);
    await shot(page, '1-desktop-landing-light');

    // A link on it opens the page; the way above starts with the game's name.
    await shownPage(page).locator('.app-link', { hasText: 'Stone wardens' }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Stone wardens');
    await expect(crumbs(page)).toHaveText(/^Atlas demo world\s*›/);
    await shot(page, '2-desktop-page-way-light');
    await page.getByTestId('guides-crumb-game').click();
    await expect(landing(page)).toBeVisible();
    await expect(page.getByTestId('guides-back')).toBeEnabled();

    // Its picture opens the page it leads to; the top of the contents leads back.
    await picture.click();
    await expect(shownPage(page).locator('h1')).toHaveText('Waystones');
    await expect(page.getByTestId('guides-tree-home')).not.toHaveAttribute('aria-current', 'page');
    await page.getByTestId('guides-tree-home').click();
    await expect(landing(page)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('the home page is edited as any page, and named by the game in the arrange tool', async ({
    page,
  }) => {
    await openGuides(page);
    await expect(landing(page)).toBeVisible();
    await page.getByTestId('edit-page').click();
    await expect(page.getByTestId('page-editor')).toBeVisible();
    await expect(page.getByTestId('page-title')).toHaveValue('Main Page');
    // Named by the game's name, as the reader's menu names it, and tagged as the home page.
    const home = page.getByTestId('contents-home');
    await expect(home.getByTestId('contents-home-page')).toHaveText('Atlas demo world');
    await expect(home).toContainText('Home page');
    await expect(home.getByTestId('contents-home-page')).toHaveAttribute('aria-current', 'page');
    await shot(page, '3-desktop-editor-home-light');
    await page.getByTestId('cancel-edit').click();
    await expect(landing(page)).toBeVisible();
  });

  test('in the dark theme', async ({ page }) => {
    await openGuides(page, 'dark');
    await expect(landing(page)).toBeVisible();
    await expect(shownPage(page).locator('img').first()).toBeVisible();
    await shot(page, '4-desktop-landing-dark');
  });

  test('a wiki whose home page was not read lands on one made from its contents', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await serveWithoutHome(page);
    await page.goto('./');
    await expect(landing(page)).toHaveAttribute('data-landing', 'made');
    await expect(landing(page).locator('h1')).toHaveText('Example Wiki');
    // A group of tiles for each section, a picture where a page has one.
    await expect(page.getByTestId('guides-landing-section')).toHaveText([
      /Basics/,
      /The isle/,
      /Gear/,
    ]);
    const waystones = page.getByTestId('guides-tile').filter({ hasText: 'Waystones' });
    await expect(waystones.locator('img')).toBeVisible();
    await expect(page.getByTestId('guides-landing-note')).toContainText(
      'The site’s own home page has not been read',
    );
    // Not a stored page: nothing to edit as a page.
    await expect(page.getByTestId('edit-page')).toHaveCount(0);
    await shot(page, '5-desktop-made-landing-light');
    // A tile opens its page; a section's heading its contents; the name leads back.
    await waystones.click();
    await expect(shownPage(page).locator('h1')).toHaveText('Waystones');
    // Walked to from the landing page: the way the reader came, not the contents.
    await expect(crumbs(page)).toHaveText(/^Example Wiki\s*›\s*Waystones$/);
    await page.getByTestId('guides-crumb-game').click();
    await page.getByTestId('guides-landing-section').filter({ hasText: 'Gear' }).click();
    await expect(page.getByTestId('guides-contents').locator('h1')).toHaveText('Gear');
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ ...pixel, deviceScaleFactor: 2 });

  test('lands on the home page, and the contents lead back to it', async ({ page }) => {
    const errors = collectErrors(page);
    await openGuides(page);
    await expect(landing(page)).toHaveAttribute('data-landing', 'page');
    await expect(shownPage(page).locator('h1')).toHaveText('Atlas demo world');
    // Nothing wider than the screen.
    expect(
      await page.getByTestId('guides-body').evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBe(0);
    await shot(page, '6-phone-landing-light');
    // The contents, headed with the game's name, the home page first.
    await page.getByTestId('guides-contents-button').tap();
    const contents = page.getByTestId('guides-contents');
    await expect(contents.locator('h1')).toHaveText('Atlas demo world');
    await expect(crumbs(page)).toHaveText(/Atlas demo world\s*›\s*Contents/);
    await shot(page, '7-phone-contents-light');
    await contents.getByTestId('guides-home-link').tap();
    await expect(landing(page)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a made landing page in the dark theme', async ({ page }) => {
    await serveWithoutHome(page, 'dark');
    await page.goto('./');
    await expect(landing(page)).toHaveAttribute('data-landing', 'made');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(
      page.getByTestId('guides-tile').filter({ hasText: 'Waystones' }).locator('img'),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await shot(page, '8-phone-made-landing-dark');
    await page.getByTestId('guides-tile').filter({ hasText: 'Getting around' }).tap();
    await expect(shownPage(page).locator('h1')).toHaveText('Getting around');
  });
});
