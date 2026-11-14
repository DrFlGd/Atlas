import { devices, type Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';

/**
 * A box of facts on a page of the demo pack's made-up wiki (the
 * Stonebreaker maul): a box at the right of the text on a wide screen and
 * across the page above it on a phone; its labels and heading rows are no
 * headings of the page; its rows have no "Add to build" buttons; the page
 * editor shows it as the table it is and keeps it byte for byte.
 */

test.use({ layout: 'standard' });

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

const MAUL = 'demo:guide:wiki-stonebreaker-maul';
const body = (page: Page) => page.getByTestId('guides-body');
const shownPage = (page: Page) => page.getByTestId('guides-page');
const box = (page: Page) => shownPage(page).locator('aside[data-box]');
const firstLine = (page: Page) =>
  shownPage(page).locator('.guides-page-body > p').filter({ hasText: 'too heavy for most' });

/** Where the words of an element stand (a paragraph's own box runs under a box floated beside it). */
const wordsAt = (page: Page) =>
  firstLine(page).evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const { x, y, width, height } = range.getBoundingClientRect();
    return { x, y, width, height };
  });

async function openMaul(page: Page): Promise<void> {
  await page.goto('./');
  await page.getByTestId('section-guides').click();
  await body(page).getByTestId('guides-section').filter({ hasText: 'Gear' }).click();
  await body(page).getByTestId('guides-page-link').filter({ hasText: 'Stonebreaker maul' }).click();
  await expect(shownPage(page).locator('h1')).toHaveText('Stonebreaker maul');
}

async function packBody(page: Page, id: string): Promise<string> {
  const response = await page.request.get('./packs/demo/guides.json');
  const guides = (await response.json()) as { id: string; body: string }[];
  return guides.find((guide) => guide.id === id)!.body;
}

test.describe('on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('shows the box at the right of the text, its labels no headings of the page', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openMaul(page);
    const facts = box(page);
    await expect(facts).toBeVisible();
    await expect(facts).toHaveAttribute('aria-label', 'Stonebreaker maul');
    await expect(facts.locator('.guide-box-title')).toHaveText('Stonebreaker maul');
    await expect(facts.locator('img')).toBeVisible();
    await expect(facts.locator('.guide-box-label')).toHaveText([
      'Type',
      'Weight',
      'Price',
      'Damage',
      'Slam',
      'Combo',
      'Found in',
    ]);
    await expect(facts.locator('.guide-box-heading')).toHaveText(['Damage', 'Where']);
    // A link to another page of the guide stays one.
    await expect(facts.getByRole('button', { name: 'Stone wardens' })).toBeVisible();
    await expect(facts.locator('.guide-box-value').filter({ hasText: 'Two swings' })).toContainText(
      /Two swings\s*then a slam/,
    );

    // The box stands at the right, the first lines of text beside it.
    const [boxAt, textAt, pageAt] = await Promise.all([
      facts.boundingBox(),
      wordsAt(page),
      shownPage(page).locator('.guides-page-body').boundingBox(),
    ]);
    expect(boxAt!.width).toBeLessThan(pageAt!.width / 2);
    expect(pageAt!.x + pageAt!.width - (boxAt!.x + boxAt!.width)).toBeLessThan(4);
    expect(textAt.x + textAt.width).toBeLessThanOrEqual(boxAt!.x + 1);
    expect(textAt.y).toBeLessThan(boxAt!.y + boxAt!.height);

    // Only the page's own headings are headings.
    await expect(shownPage(page).locator('.guides-page-body').getByRole('heading')).toHaveText([
      'Using it',
      'Notes',
    ]);
    // A box is never sorted, and its rows are no things to add to a build.
    await expect(facts.getByRole('button', { name: /^Add “.*” to build$/u })).toHaveCount(0);
    await expect(shownPage(page).getByRole('button', { name: /^Add “.*” to build$/u })).toHaveCount(
      0,
    );
    expect(errors).toEqual([]);
  });

  test('the page editor shows the box as its table and keeps it unchanged', async ({ page }) => {
    const errors = collectErrors(page);
    await openMaul(page);
    const original = await packBody(page, MAUL);
    await page.getByTestId('edit-page').click();
    await expect(page.getByTestId('page-blocks')).toBeVisible();
    await expect(page.getByTestId('box-note')).toBeVisible();
    await expect(
      page.getByTestId('table-cell').filter({ hasText: /^Heavy weapon$/ }),
    ).toBeVisible();

    await page.getByTestId('mode-markdown').click();
    const markdown = page.getByTestId('markdown-text');
    await expect(markdown).toHaveValue(original);
    await page.getByTestId('mode-formatted').click();
    await expect(page.getByTestId('box-note')).toBeVisible();
    await page.getByTestId('mode-markdown').click();
    await expect(markdown).toHaveValue(original);

    // A value edited in the formatted view changes that row only.
    await page.getByTestId('mode-formatted').click();
    await page
      .getByTestId('table-cell')
      .filter({ hasText: /^Heavy$/ })
      .click();
    await page.keyboard.press('End');
    await page.keyboard.type(' indeed');
    await page.getByTestId('mode-markdown').click();
    await expect(markdown).toHaveValue(
      original.replace('| Weight | Heavy |', '| Weight | Heavy indeed |'),
    );
    expect(errors).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ ...pixel });

  test('shows the box across the page, above the text', async ({ page }) => {
    const errors = collectErrors(page);
    await openMaul(page);
    const facts = box(page);
    await expect(facts).toBeVisible();
    const [boxAt, textAt, pageAt] = await Promise.all([
      facts.boundingBox(),
      wordsAt(page),
      shownPage(page).locator('.guides-page-body').boundingBox(),
    ]);
    expect(boxAt!.width).toBeGreaterThan(pageAt!.width - 4);
    expect(textAt.y).toBeGreaterThanOrEqual(boxAt!.y + boxAt!.height);
    expect(errors).toEqual([]);
  });
});
