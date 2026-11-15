import { devices, type Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { servePageTree } from './pageTreePack';

/**
 * The headings of a list page are levels under it in the contents: on the
 * made-up wiki of `pageTreePack.ts`, Gear's heading "Weapons" holds Short
 * Blades (a heading that links to that page, which holds the blades), and
 * "Charms" three charms. A level is no page: pressed, it opens Gear at
 * that heading, in the contents beside the page, in the line above the
 * page and among the pages under Gear on a phone.
 */

test.use({ layout: 'standard' });

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

const shownPage = (page: Page) => page.getByTestId('guides-page');
const side = (page: Page) => page.locator('.guides-side');
const crumbs = (page: Page) => page.locator('.guides-crumbs');
const body = (page: Page) => page.getByTestId('guides-body');
const headingOf = (page: Page, section: string) =>
  shownPage(page).locator(`.guides-page-body [data-section="${section}"]`);

/** The line as words, steps parted by "›". */
const line = (...steps: string[]) =>
  new RegExp(`^${steps.map((step) => step.replace(/\s+/g, '\\s*')).join('\\s*›\\s*')}$`);

/** A row of the tree beside the page (a page, or a heading by `testId`), with its toggle. */
const treeRow = (page: Page, title: string, testId = 'guides-tree-page') =>
  side(page)
    .locator('.guides-tree-page')
    .filter({ has: page.getByTestId(testId).getByText(title, { exact: true }) });

async function openBySearch(page: Page, query: string, title: string): Promise<void> {
  await page.getByTestId('guides-search').first().fill(query);
  await page.getByTestId('guides-result').filter({ hasText: title }).first().click();
  await expect(shownPage(page).locator('h1')).toHaveText(title);
}

test.describe('on a desktop', () => {
  test('shows the headings of a list page as levels, each opening the page at its heading', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await servePageTree(page);
    await page.goto('./');
    await side(page).locator('.guides-tree-section').filter({ hasText: 'Basics' }).click();
    await side(page).getByTestId('guides-tree-page').getByText('Gear', { exact: true }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Gear');
    // Under Gear: its headings that hold pages, not "Care", which lists none.
    await expect(side(page).getByTestId('guides-tree-heading')).toHaveText(['Weapons', 'Charms']);

    // Gear › Weapons › Short Blades › a blade.
    await treeRow(page, 'Weapons', 'guides-tree-heading').getByTestId('guides-tree-toggle').click();
    await treeRow(page, 'Short Blades').getByTestId('guides-tree-toggle').click();
    await side(page).getByTestId('guides-tree-page').getByText('Stiletto', { exact: true }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Stiletto');
    await expect(side(page).locator('[aria-current="page"]')).toHaveText('Stiletto');
    await expect(crumbs(page)).toHaveText(
      line('Example Wiki', 'Basics', 'Gear', 'Weapons', 'Short Blades', 'Stiletto'),
    );
    await expect(crumbs(page).getByTestId('guides-crumb')).toHaveText([
      'Basics',
      'Gear',
      'Weapons',
      'Short Blades',
    ]);

    // The step "Weapons" of the line opens Gear at that heading, marked in the tree.
    await crumbs(page).getByRole('button', { name: 'Weapons' }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Gear');
    await expect(headingOf(page, 'weapons')).toBeInViewport();
    await expect(side(page).locator('[aria-current="page"]')).toHaveText('Weapons');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Basics', 'Gear'));

    // "Charms" in the tree: Gear at that heading, further down, with the charms under it.
    await side(page).getByTestId('guides-tree-heading').getByText('Charms').click();
    await expect(headingOf(page, 'charms')).toBeInViewport();
    await expect.poll(() => body(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(side(page).locator('[aria-current="page"]')).toHaveText('Charms');
    await expect(
      treeRow(page, 'Charms', 'guides-tree-heading').getByTestId('guides-tree-toggle'),
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(side(page).getByTestId('guides-tree-page').getByText('Tin Charm')).toBeVisible();

    // Gear itself, at its top, is the page marked again.
    await side(page).getByTestId('guides-tree-page').getByText('Gear', { exact: true }).click();
    await expect(side(page).locator('[aria-current="page"]')).toHaveText('Gear');
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ ...pixel });

  test('groups the pages under a list page by its headings, and the line names them', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await servePageTree(page);
    await page.goto('./');
    await page.getByTestId('guides-tile').filter({ hasText: /^Gear/ }).tap();
    await expect(shownPage(page).locator('h1')).toHaveText('Gear');
    const under = page.getByTestId('pages-under');
    await expect(under.getByTestId('guides-heading-link')).toHaveText([
      /Weapons\s*9 pages/,
      /Charms\s*3 pages/,
    ]);
    await expect(under.getByTestId('guides-page-link')).toHaveText([
      /Short Blades\s*8 pages under it/,
      'Bone Charm',
      'Tin Charm',
      'Reed Charm',
    ]);
    // A heading opens the page at it.
    await under.getByTestId('guides-heading-link').filter({ hasText: 'Charms' }).tap();
    await expect(headingOf(page, 'charms')).toBeInViewport();
    await expect(shownPage(page).locator('h1')).toHaveText('Gear');

    // Opened from a search, a blade's line names the heading, which opens Gear there.
    await page.getByTestId('guides-contents-button').tap();
    await openBySearch(page, 'next to it lies the kris', 'Dirk');
    await expect(crumbs(page)).toHaveText(
      line('Example Wiki', 'Basics', 'Gear', 'Weapons', 'Short Blades', 'Dirk'),
    );
    await expect(crumbs(page).locator('[aria-current="page"]')).toBeInViewport();
    expect(await body(page).evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(
      0,
    );
    await crumbs(page).getByRole('button', { name: 'Weapons' }).tap();
    await expect(shownPage(page).locator('h1')).toHaveText('Gear');
    await expect(headingOf(page, 'weapons')).toBeInViewport();
    expect(await body(page).evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(
      0,
    );
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });
});
