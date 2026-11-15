import { devices, type Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { servePageTree } from './pageTreePack';

/**
 * The line above a page shows the way the reader came: walked from page
 * to page (a link in a page's text, a tile of the landing page, the pages
 * under a page), it names each page walked, and pressing one goes back to
 * it as Back would. Opened afresh (from the contents, a search), it is the
 * way to the page in the contents, as before. On the made-up wiki of
 * `pageTreePack.ts`: Basics › Gear › Weapons › Short Blades › Dirk.
 */

test.use({ layout: 'standard' });

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

const shownPage = (page: Page) => page.getByTestId('guides-page');
const crumbs = (page: Page) => page.locator('.guides-crumbs');
const walked = (page: Page) => page.getByTestId('guides-crumb-walked');
const body = (page: Page) => page.getByTestId('guides-body');
const side = (page: Page) => page.locator('.guides-side');

/** Follows a link in the text of the page shown. */
async function follow(page: Page, words: string, title: string, last = false): Promise<void> {
  const links = shownPage(page).locator('.guides-page-body .app-link', { hasText: words });
  await (last ? links.last() : links.first()).click();
  await expect(shownPage(page).locator('h1')).toHaveText(title);
}

/** The line as words, steps parted by "›". */
const line = (...steps: string[]) =>
  new RegExp(`^${steps.map((step) => step.replace(/\s+/g, '\\s*')).join('\\s*›\\s*')}$`);

test.describe('on a desktop', () => {
  test('shows the way walked from the landing page, and cuts it back to a page walked to again', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await servePageTree(page);
    await page.goto('./');
    await page.getByTestId('guides-tile').filter({ hasText: /^Gear/ }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Gear');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Gear'));

    await follow(page, 'Short Blades', 'Short Blades');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Gear', 'Short Blades'));
    await follow(page, 'Dirk', 'Dirk');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Gear', 'Short Blades', 'Dirk'));
    // The pages walked are a group of their own, named for screen readers and with a tooltip.
    const way = page.getByRole('group', { name: 'The way you came' });
    await expect(way).toHaveAttribute('title', 'The way you came');
    await expect(way.getByRole('button')).toHaveText(['Gear', 'Short Blades']);
    await expect(crumbs(page).locator('[aria-current="page"]')).toHaveText('Dirk');

    await follow(page, 'Kris', 'Kris');
    await expect(crumbs(page)).toHaveText(
      line('Example Wiki', 'Gear', 'Short Blades', 'Dirk', 'Kris'),
    );
    // Back to a page on the way: the way is cut back to it.
    await follow(page, 'gear', 'Gear');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Gear'));
    await expect(walked(page)).toHaveCount(0);

    // Each visit keeps its own line, Back and Forward.
    await page.getByTestId('guides-back').click();
    await expect(shownPage(page).locator('h1')).toHaveText('Kris');
    await expect(crumbs(page)).toHaveText(
      line('Example Wiki', 'Gear', 'Short Blades', 'Dirk', 'Kris'),
    );
    await page.getByTestId('guides-forward').click();
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Gear'));
    // The game's name opens the landing page, as before.
    await page.getByTestId('guides-crumb-game').click();
    await expect(page.getByTestId('guides-home')).toBeVisible();
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });

  test('goes back to a page walked through as Back would, where it was scrolled to', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await servePageTree(page);
    await page.goto('./');
    // Gear from the contents beside the page: a fresh start, under Basics.
    await side(page).locator('.guides-tree-section').filter({ hasText: 'Basics' }).click();
    await side(page).getByTestId('guides-tree-page').getByText('Gear', { exact: true }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Gear');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Basics', 'Gear'));

    // Read down to its foot, and on to the short blades.
    const scrolled = await body(page).evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(200);
    // The link at its foot, not the heading at its top.
    await follow(page, 'short blades', 'Short Blades', true);
    await follow(page, 'Dirk', 'Dirk');
    await expect(crumbs(page)).toHaveText(
      line('Example Wiki', 'Basics', 'Gear', 'Short Blades', 'Dirk'),
    );
    await expect(walked(page)).toHaveText(['Gear', 'Short Blades']);
    // The contents beside the page still marks where Dirk is in the contents.
    await expect(side(page).locator('[aria-current="page"]')).toHaveText('Dirk');

    // Gear, two steps back: where it was scrolled to, and Forward still there.
    await walked(page).filter({ hasText: 'Gear' }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Gear');
    await expect
      .poll(() => body(page).evaluate((element) => element.scrollTop))
      .toBeGreaterThan(scrolled - 40);
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Basics', 'Gear'));
    await expect(page.getByTestId('guides-forward')).toBeEnabled();
    await page.getByTestId('guides-forward').click();
    await expect(shownPage(page).locator('h1')).toHaveText('Short Blades');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Basics', 'Gear', 'Short Blades'));
    await page.getByTestId('guides-forward').click();
    await expect(shownPage(page).locator('h1')).toHaveText('Dirk');

    // A contents step opens the section, as before.
    await crumbs(page).getByRole('button', { name: 'Basics' }).click();
    await expect(page.getByTestId('guides-contents').locator('h1')).toHaveText('Basics');

    // Opened from a search: the way to it in the contents, nothing walked.
    await page.getByTestId('guides-search').first().fill('next to it lies the kris');
    await page.getByTestId('guides-result').filter({ hasText: 'Dirk' }).first().click();
    await expect(shownPage(page).locator('h1')).toHaveText('Dirk');
    await expect(crumbs(page)).toHaveText(
      line('Example Wiki', 'Basics', 'Gear', 'Weapons', 'Short Blades', 'Dirk'),
    );
    await expect(walked(page)).toHaveCount(0);
    await expect(crumbs(page).getByTestId('guides-crumb')).toHaveText([
      'Basics',
      'Gear',
      'Weapons',
      'Short Blades',
    ]);
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ ...pixel });

  test('shows a long way scrolled to its end, the page not scrolled sideways', async ({ page }) => {
    await servePageTree(page);
    await page.goto('./');
    await page.getByTestId('guides-tile').filter({ hasText: /^Gear/ }).tap();
    await expect(shownPage(page).locator('h1')).toHaveText('Gear');
    await shownPage(page)
      .locator('.guides-page-body .app-link', { hasText: 'Short Blades' })
      .first()
      .tap();
    await expect(shownPage(page).locator('h1')).toHaveText('Short Blades');
    // The pages under a page are a step on the way too.
    await page
      .getByTestId('pages-under')
      .getByTestId('guides-page-link')
      .filter({ hasText: 'Dirk' })
      .tap();
    await expect(shownPage(page).locator('h1')).toHaveText('Dirk');
    await shownPage(page).locator('.guides-page-body .app-link', { hasText: 'Kris' }).tap();
    await shownPage(page).locator('.guides-page-body .app-link', { hasText: 'Shiv' }).tap();
    await expect(shownPage(page).locator('h1')).toHaveText('Shiv');
    await expect(crumbs(page)).toHaveText(
      line('Example Wiki', 'Gear', 'Short Blades', 'Dirk', 'Kris', 'Shiv'),
    );
    await expect(crumbs(page).locator('[aria-current="page"]')).toBeInViewport();
    expect(await crumbs(page).evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    expect(await body(page).evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(
      0,
    );
    await walked(page).filter({ hasText: 'Dirk' }).tap();
    await expect(shownPage(page).locator('h1')).toHaveText('Dirk');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Gear', 'Short Blades', 'Dirk'));
  });
});
