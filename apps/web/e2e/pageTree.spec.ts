import { devices, type Page } from '@playwright/test';
import { collectErrors, storedSetting } from './helpers';
import { expect, test } from './layout';
import { servePageTree } from './pageTreePack';

/**
 * Pages under pages: a made-up wiki whose pages nothing in its menu names
 * are placed under the pages that lead to them (see `pageTreePack.ts`).
 * The contents beside the page opens to the page shown, the line above
 * the page shows every step of the way, and a page names the other pages
 * that link to it.
 */

test.use({ layout: 'standard' });

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

/** Where the browser keeps the person's changes to the pages of the made-up wiki. */
const OWN_PAGES = 'ownPages:demo';

const shownPage = (page: Page) => page.getByTestId('guides-page');
const side = (page: Page) => page.locator('.guides-side');
const crumbs = (page: Page) => page.locator('.guides-crumbs');

async function openBySearch(page: Page, query: string, title: string): Promise<void> {
  await page.getByTestId('guides-search').first().fill(query);
  await page.getByTestId('guides-result').filter({ hasText: title }).first().click();
  await expect(shownPage(page).locator('h1')).toHaveText(title);
}

/** A page's row in the tree beside the page, with its button to show the pages under it. */
const treeRow = (page: Page, title: string) =>
  side(page)
    .locator('.guides-tree-page')
    .filter({
      has: page.getByTestId('guides-tree-page').getByText(title, { exact: true }),
    });

test.describe('on a desktop', () => {
  test('opens the contents to a page three levels down, with the way to it', async ({ page }) => {
    const errors = collectErrors(page);
    await servePageTree(page);
    await page.goto('./');
    await openBySearch(page, 'helm of the warden', 'Warden Helm');

    // The way: every section and page above it, then the page itself.
    await expect(crumbs(page)).toHaveText(
      /Contents\s*›\s*Equipment\s*›\s*Armor\s*›\s*Warden Plate\s*›\s*Warden Helm/,
    );
    await expect(crumbs(page).locator('[aria-current="page"]')).toHaveText('Warden Helm');

    // The tree is open to it, with what is around it.
    const current = side(page).locator('[aria-current="page"]');
    await expect(current).toHaveText('Warden Helm');
    await expect(treeRow(page, 'Armor').getByTestId('guides-tree-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(treeRow(page, 'Warden Plate').getByTestId('guides-tree-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(side(page).getByTestId('guides-tree-page').getByText('Ash Mail')).toBeVisible();
    // Pages keeps only what nothing in the menu leads to.
    const pages = side(page).locator('.guides-tree-section').filter({ hasText: 'Pages' });
    await pages.click();
    await expect(page.getByTestId('guides-contents').getByTestId('guides-page-link')).toHaveText([
      'Stray Note',
    ]);

    // A page step of the way opens that page; a section step its contents.
    await openBySearch(page, 'helm of the warden', 'Warden Helm');
    await crumbs(page).getByRole('button', { name: 'Armor' }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Armor');
    await crumbs(page).getByRole('button', { name: 'Equipment' }).click();
    await expect(page.getByTestId('guides-contents').locator('h1')).toHaveText('Equipment');
    await expect(page.getByTestId('guides-contents').getByTestId('guides-page-link')).toHaveText([
      /Armor\s*4 pages under it/,
      /Weapons\s*1 page under it/,
    ]);

    // A page with pages under it opens when pressed, and folds and unfolds.
    await side(page).getByTestId('guides-tree-page').getByText('Armor', { exact: true }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Armor');
    const toggle = treeRow(page, 'Armor').getByTestId('guides-tree-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(side(page).getByText('Ash Mail')).toHaveCount(0);
    // With the keyboard too.
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAccessibleName('Hide the pages under “Armor”');
    await expect(side(page).getByText('Ash Mail')).toBeVisible();
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });

  test('names the other pages that link to a page, a few at first', async ({ page }) => {
    await servePageTree(page);
    await page.goto('./');
    await openBySearch(page, 'heavy plate', 'Warden Plate');
    const also = page.getByTestId('also-linked-from');
    // Its home (Armor) is the way above; the others are named here, in contents order.
    await expect(also.getByTestId('also-linked-page')).toHaveText(['Warden Helm', 'Longblade']);
    await also.getByRole('button', { name: 'Longblade' }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Longblade');
    await expect(crumbs(page)).toHaveText(/Equipment\s*›\s*Weapons\s*›\s*Longblade/);

    // Linked from sixteen others: twelve, then the rest on request.
    await openBySearch(page, 'found everywhere', 'Common Ore');
    await expect(crumbs(page)).toHaveText(/Armor\s*›\s*Warden Plate\s*›\s*Common Ore/);
    const ore = page.getByTestId('also-linked-from');
    await expect(ore.getByTestId('also-linked-page')).toHaveCount(12);
    await ore.getByTestId('also-linked-more').click();
    await expect(ore.getByRole('button', { name: 'and 4 more' })).toHaveCount(0);
    await expect(ore.getByTestId('also-linked-page')).toHaveCount(16);
  });

  test('shows hundreds of pages under one page a few hundred at a time', async ({ page }) => {
    await servePageTree(page);
    await page.goto('./');
    await openBySearch(page, 'thing number 450', 'Item 450');
    // Shown though it is the 450th: the rows go as far as the page shown.
    await expect(side(page).locator('[aria-current="page"]')).toHaveText('Item 450');
    await expect(crumbs(page)).toHaveText(/Things\s*›\s*Catalogue\s*›\s*Item 450/);
    await openBySearch(page, 'thing number 3.', 'Item 003');
    // Under Things: Catalogue, and the first 200 pages under it.
    const under = side(page).locator('.guides-tree-level .guides-tree-level');
    await expect(under.getByTestId('guides-tree-page')).toHaveCount(201);
    await under.getByTestId('guides-more-rows').click();
    await expect(under.getByTestId('guides-tree-page')).toHaveCount(401);
    await expect(under.getByTestId('guides-more-rows')).toHaveText('Show the other 50');
  });
});

test('the arrange tool moves a page under another page, and it stays there', async ({ page }) => {
  await servePageTree(page);
  await page.goto('./');
  await openBySearch(page, 'nothing links here', 'Stray Note');
  await expect(crumbs(page)).toHaveText(/Contents\s*›\s*Pages\s*›\s*Stray Note/);
  await page.getByTestId('edit-page').click();
  const contents = page.getByTestId('contents-editor');
  // The arrange tool shows the tree too: Armor holds its pages, folded.
  const armor = contents.getByTestId('contents-row').filter({ hasText: /^Armor/ });
  await expect(armor.getByTestId('contents-fold')).toHaveAttribute('aria-expanded', 'false');
  const stray = contents.getByTestId('contents-row').filter({ hasText: 'Stray Note' });
  await stray.getByTestId('contents-more').click();
  await stray.getByTestId('contents-move-to').click();
  const dialog = page.getByTestId('move-dialog');
  await dialog.getByTestId('move-page-query').fill('bestiary');
  await dialog.getByTestId('move-under-choice').filter({ hasText: 'Bestiary' }).click();
  await page.getByTestId('cancel-edit').click();
  await expect(crumbs(page)).toHaveText(/The world\s*›\s*Bestiary\s*›\s*Stray Note/);
  // Kept after a restart: once it is saved, which the app does a moment after a change.
  await expect.poll(() => storedSetting(page, OWN_PAGES)).toContain('stray-note');
  await page.reload();
  await openBySearch(page, 'nothing links here', 'Stray Note');
  await expect(crumbs(page)).toHaveText(/The world\s*›\s*Bestiary\s*›\s*Stray Note/);
});

test.describe('on a phone', () => {
  test.use({ ...pixel });

  test('shows the way, and the pages under a page at its foot', async ({ page }) => {
    await servePageTree(page);
    await page.goto('./');
    await page.getByTestId('guides-search').fill('heavy plate');
    await page.getByTestId('guides-result').first().tap();
    await expect(shownPage(page).locator('h1')).toHaveText('Warden Plate');
    // The whole way, scrolled to its end.
    await expect(crumbs(page)).toHaveText(/Equipment\s*›\s*Armor\s*›\s*Warden Plate/);
    await expect(crumbs(page).getByRole('button', { name: 'Armor' })).toBeInViewport();
    const under = page.getByTestId('pages-under');
    await expect(under.getByTestId('guides-page-link')).toHaveText([/Warden Helm/, /Common Ore/]);
    await under.getByTestId('guides-page-link').filter({ hasText: 'Warden Helm' }).tap();
    await expect(shownPage(page).locator('h1')).toHaveText('Warden Helm');
    // Up, and across to the next set.
    await crumbs(page).getByRole('button', { name: 'Armor' }).tap();
    await page.getByTestId('pages-under').getByText('Ash Mail').tap();
    await expect(shownPage(page).locator('h1')).toHaveText('Ash Mail');
    await expect(page.getByTestId('also-linked-from')).toHaveCount(0);
  });
});
