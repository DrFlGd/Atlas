import { mkdir } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, EXAMPLE_WIKI, WIKI, mock, realErrors, setUp } from './fakeShell';

/**
 * The Library's wiki screen, against the stand-in shell of `fakeShell.ts`
 * and the made-up Example Wiki (`example-wiki-importer.js` in the importer
 * contract's demo folder), whose pages the shell answers itself. Pages are
 * fetched only in a build with downloads, so these tests run in that build.
 */

test.use({ layout: 'standard' });
test.skip(!DOWNLOADS_BUILD, 'Pages are fetched only in a build with downloads.');

/** Where the screenshots go: ATLAS_LIBRARY_SHOTS, or beside the other test results. */
const SHOTS = process.env.ATLAS_LIBRARY_SHOTS ?? 'test-results/library';

const row = (page: Page, title: string) =>
  page
    .getByTestId('wiki-row')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) });

/** The addresses fetched so far. */
async function fetched(page: Page): Promise<string[]> {
  return (await mock(page)).events.filter((e) => e.what === 'fetch').map((e) => e.url!);
}

/** Adds the wiki with its first page, Welcome, from its contents. */
async function addWiki(page: Page) {
  if (!(await page.getByTestId('library').isVisible())) {
    await page.getByTestId('section-library').click();
  }
  await page.getByTestId('add-map-url').fill(`${WIKI}/Contents`);
  await page.getByTestId('add-map-url').press('Enter');
  const flow = page.getByTestId('library-flow');
  await expect(flow).toHaveAttribute('data-phase', 'choose', { timeout: 30_000 });
  await page
    .getByTestId('add-map-choose-page')
    .filter({ hasText: 'Welcome' })
    .getByRole('checkbox')
    .check();
  // How far the go follows links: the pages they link to at first; here, only the page ticked.
  const follow = flow.getByTestId('follow-links');
  await expect(follow).toHaveAttribute('data-follow', 'linked');
  await follow.getByTestId('follow-links-ticked').click();
  await expect(follow).toHaveAttribute('data-follow', 'ticked');
  await page.getByTestId('add-map-choose-confirm').click();
  await expect(flow).toHaveAttribute('data-run', 'finished', { timeout: 30_000 });
  await flow.getByTestId('library-flow-close').click();
  await page.locator('[data-testid="library-game"][data-pack="example-wiki"]').click();
  await expect(page.getByTestId('wiki-screen')).toBeVisible();
}

test('lists a wiki’s pages by heading, previews them, and reads the pages ticked', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await setUp(page, true, { wiki: EXAMPLE_WIKI });
  await addWiki(page);
  const screen = page.getByTestId('wiki-screen');
  const before = await fetched(page);
  // robots.txt first in each go: the contents, then the page ticked.
  expect(before).toEqual([
    'https://wiki.example.org/robots.txt',
    `${WIKI}/Contents`,
    'https://wiki.example.org/robots.txt',
    `${WIKI}/Welcome`,
  ]);

  // The list of games says how much of the wiki was read.
  await expect(
    page
      .locator('[data-testid="library-game"][data-pack="example-wiki"]')
      .getByTestId('library-status'),
  ).toHaveText('1 of 6 pages read');

  // Every page of the contents under its heading; the pages Welcome links to that the contents do not list, found there.
  await expect(screen.getByTestId('wiki-group')).toHaveCount(2);
  await expect(screen.getByTestId('wiki-no-contents')).toHaveCount(0);
  await expect(row(page, 'Welcome')).toHaveAttribute('data-state', 'read');
  await expect(row(page, 'Welcome').getByTestId('wiki-row-state')).toContainText('Read today at');
  await expect(row(page, 'Welcome').getByTestId('wiki-row-state')).toContainText(
    'links to 4 pages',
  );
  await expect(row(page, 'Bells')).toHaveAttribute('data-state', 'not-read');
  await expect(screen.getByTestId('wiki-found')).toContainText('Old bell, Rusty gate');
  await expect(screen.getByTestId('wiki-found')).toContainText('Found on Welcome, not read');
  await expect(screen.getByTestId('wiki-filter-all')).toContainText('8');
  await expect(screen.getByTestId('wiki-filter-read')).toContainText('1');
  await expect(screen.getByTestId('wiki-filter-not-read')).toContainText('7');
  // No "Changed on the wiki": telling would mean reading every page again.
  await expect(screen.getByTestId('wiki-filter-changed')).toHaveCount(0);

  // The preview: the wiki is shown first, from the files on this computer.
  await row(page, 'Welcome').getByTestId('wiki-row-open').click();
  const preview = page.getByTestId('wiki-preview');
  await preview.getByTestId('wiki-preview-show').click();
  await expect(preview.getByTestId('wiki-preview-text')).toContainText(
    'The isle has bells and gates.',
  );
  await expect(preview.getByTestId('wiki-preview-sentence')).toContainText(
    'Read again fetches the page from the wiki now.',
  );
  await preview.getByTestId('wiki-tick-links').click();
  await expect(page.getByTestId('wiki-ticked')).toHaveText('4 pages ticked');

  // Leave out: never ticked or read from now on.
  await row(page, 'Gates').getByTestId('wiki-row-open').click();
  await preview.getByTestId('wiki-leave-out').click();
  await expect(row(page, 'Gates')).toHaveAttribute('data-state', 'left-out');
  await expect(page.getByTestId('wiki-ticked')).toHaveText('3 pages ticked');
  await expect(screen.getByTestId('wiki-filter-left-out')).toContainText('1');
  await row(page, 'Missing').getByTestId('wiki-row-tick').check();
  await expect(page.getByTestId('wiki-read')).toHaveText('Read 4 pages');
  await expect(page.getByTestId('wiki-foot')).toContainText('one page at a time with a pause');

  // Opening the screen and choosing pages fetched nothing.
  expect(await fetched(page)).toEqual(before);
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/wiki.png` });

  // Read: those four only, one at a time; a page the wiki does not have could not be read, and says why.
  await page.getByTestId('wiki-read').click();
  await expect(row(page, 'Bells')).toHaveAttribute('data-state', 'read', { timeout: 60_000 });
  await expect(row(page, 'Missing')).toHaveAttribute('data-state', 'failed', { timeout: 60_000 });
  await expect(row(page, 'Missing').getByTestId('wiki-row-state')).toHaveText(
    'Could not be read: The wiki has no such page',
  );
  await expect(row(page, 'Old bell')).toHaveAttribute('data-state', 'read');
  await expect(row(page, 'Rusty gate')).toHaveAttribute('data-state', 'read');
  expect((await fetched(page)).slice(before.length)).toEqual([
    'https://wiki.example.org/robots.txt',
    `${WIKI}/Bells`,
    `${WIKI}/Old_bell`,
    `${WIKI}/Rusty_gate`,
    `${WIKI}/Missing`,
  ]);
  await expect(page.getByTestId('wiki-ticked')).toHaveText('No page ticked');

  // Filters.
  await screen.getByTestId('wiki-filter-failed').click();
  await expect(screen.getByTestId('wiki-row')).toHaveCount(1);
  await row(page, 'Missing').getByTestId('wiki-row-open').click();
  await expect(preview.getByTestId('wiki-try-again')).toBeVisible();
  await screen.getByTestId('wiki-filter-all').click();

  // "Tick every page not read" leaves the page left out unticked.
  await page.getByTestId('wiki-tick-unread').click();
  await expect(page.getByTestId('wiki-ticked')).toHaveText('3 pages ticked');
  await expect(row(page, 'Gates').getByTestId('wiki-row-tick')).not.toBeChecked();
  expect(realErrors(errors)).toEqual([]);
});

test('Edit opens the page in Guides with its editor; the wiki screen then says it was changed', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await setUp(page, true, { wiki: EXAMPLE_WIKI });
  await addWiki(page);
  await row(page, 'Welcome').getByTestId('wiki-row-open').click();
  const preview = page.getByTestId('wiki-preview');
  await preview.getByTestId('wiki-preview-show').click();
  await expect(preview.getByTestId('wiki-edit')).toBeEnabled();
  await preview.getByTestId('wiki-edit').click();

  // Guides, at that page, with its editor open.
  await expect(page.getByTestId('library')).toBeHidden();
  await expect(page.locator('.touch')).toHaveAttribute('data-section', 'guides');
  await expect(page.getByTestId('page-editor')).toBeVisible();
  await page.getByTestId('page-blocks').getByText('The isle has').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Mind the tide.');
  await page.getByTestId('save-page').click();
  await expect(page.getByTestId('page-editor')).toHaveCount(0);
  await expect(page.getByTestId('guides-page').locator('h1')).toHaveText('Welcome');
  await expect(page.getByTestId('changed-by-you')).toBeVisible();

  // Back in the Library: changed by you.
  await page.getByTestId('section-library').click();
  await page.locator('[data-testid="library-game"][data-pack="example-wiki"]').click();
  await expect(row(page, 'Welcome').getByTestId('wiki-row-state')).toContainText('changed by you');

  // Leave out a page read: hidden from Guides; taken back in, shown again.
  await row(page, 'Welcome').getByTestId('wiki-row-open').click();
  await preview.getByTestId('wiki-leave-out').click();
  await expect(row(page, 'Welcome')).toHaveAttribute('data-state', 'left-out');
  await page.getByTestId('section-guides').click();
  await expect(page.getByTestId('guides-page-link').filter({ hasText: 'Welcome' })).toHaveCount(0);
  await page.getByTestId('section-library').click();
  await page.locator('[data-testid="library-game"][data-pack="example-wiki"]').click();
  await row(page, 'Welcome').getByTestId('wiki-row-open').click();
  await preview.getByTestId('wiki-take-back').click();
  await expect(row(page, 'Welcome')).toHaveAttribute('data-state', 'read');
  expect(realErrors(errors)).toEqual([]);
});

test.describe('following links', () => {
  test.use({ deviceScaleFactor: 2 });

  /** Ticks Harbour (and more) on the wiki screen, with the choice of how far to follow links. */
  async function tickAndChoose(page: Page, titles: string[], follow: 'ticked' | 'linked' | 'all') {
    for (const title of titles) await row(page, title).getByTestId('wiki-row-tick').check();
    const choice = page.getByTestId('wiki-foot').getByTestId('follow-links');
    // The choice of the first go is remembered.
    await expect(choice).toHaveAttribute('data-follow', 'ticked');
    await choice.getByTestId(`follow-links-${follow}`).click();
    await expect(choice).toHaveAttribute('data-follow', follow);
  }

  const found = (page: Page, on: string) =>
    page.locator(`[data-testid="wiki-found"][data-from="${WIKI}/${on}"]`);

  test('Only the pages ticked: the pages they link to are found, not read', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await setUp(page, true, { wiki: EXAMPLE_WIKI });
    await addWiki(page);
    const before = await fetched(page);
    await tickAndChoose(page, ['Harbour'], 'ticked');
    await expect(page.getByTestId('wiki-foot-sentence')).toContainText('Nothing else is read.');
    await page.getByTestId('wiki-read').click();
    await expect(row(page, 'Harbour')).toHaveAttribute('data-state', 'read', { timeout: 60_000 });
    await expect(page.getByTestId('wiki-read')).toBeVisible({ timeout: 30_000 });
    expect((await fetched(page)).slice(before.length)).toEqual([
      'https://wiki.example.org/robots.txt',
      `${WIKI}/Harbour`,
    ]);
    // Boats is listed as found on Harbour; Welcome, read before, is not.
    await expect(found(page, 'Harbour')).toContainText('Boats');
    await expect(found(page, 'Harbour')).toContainText('Found on Harbour, not read');
    await expect(found(page, 'Harbour')).not.toContainText('Welcome');

    // In the page, the link to Boats goes nowhere yet, and says why.
    await row(page, 'Harbour').getByTestId('wiki-row-open').click();
    const preview = page.getByTestId('wiki-preview');
    await preview.getByTestId('wiki-preview-show').click();
    const unread = preview.locator('.app-link-missing[data-unread]');
    await expect(unread).toHaveText('The boats');
    await expect(unread).toHaveAttribute('title', 'This page has not been read yet');
    await expect(unread).toHaveCSS('text-decoration-style', 'dotted');
    expect(realErrors(errors)).toEqual([]);
  });

  test('And the pages they link to: one step from the pages ticked, not further', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await setUp(page, true, { wiki: EXAMPLE_WIKI });
    await addWiki(page);
    const before = await fetched(page);
    await tickAndChoose(page, ['Harbour'], 'linked');
    await expect(page.getByTestId('wiki-foot-sentence')).toContainText(
      'Plus the pages they link to: how many is known only as they are read',
    );
    await expect(page.getByTestId('wiki-ticked')).toHaveText('1 page ticked');
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/follow-links-choice.png` });
    // Choosing fetched nothing.
    expect(await fetched(page)).toEqual(before);

    await page.getByTestId('wiki-read').click();
    await expect(row(page, 'Boats')).toHaveAttribute('data-state', 'read', { timeout: 60_000 });
    await expect(page.getByTestId('wiki-read')).toBeVisible({ timeout: 30_000 });
    expect((await fetched(page)).slice(before.length)).toEqual([
      'https://wiki.example.org/robots.txt',
      `${WIKI}/Harbour`,
      `${WIKI}/Boats`,
    ]);
    // Oars, two links away, is found on Boats and not read.
    await expect(found(page, 'Boats')).toContainText('Oars');
    await expect(found(page, 'Boats')).toContainText('Found on Boats, not read');

    // Now that Boats is read, the link to it in Harbour works.
    await row(page, 'Harbour').getByTestId('wiki-row-open').click();
    const preview = page.getByTestId('wiki-preview');
    await preview.getByTestId('wiki-preview-show').click();
    await expect(preview.locator('button.app-link')).toHaveText('The boats');
    await expect(preview.locator('[data-unread]')).toHaveCount(0);
    expect(realErrors(errors)).toEqual([]);
  });

  test('And every page those lead to: until no new page is found', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = collectErrors(page);
    await setUp(page, true, { wiki: EXAMPLE_WIKI });
    await addWiki(page);
    const before = await fetched(page);
    await tickAndChoose(page, ['Harbour', 'Lighthouse'], 'all');
    await page.getByTestId('wiki-read').click();

    // The go grows as pages are found, and says so.
    const strip = page.getByTestId('library-strip-now');
    await expect(strip).toContainText('3 found by links', { timeout: 60_000 });
    await expect(page.getByTestId('wiki-foot-sentence')).toContainText('found by links');
    await expect(found(page, 'Harbour')).toContainText('Found on Harbour, being read in this go');
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/follow-links-running.png` });

    await expect(row(page, 'Oars')).toHaveAttribute('data-state', 'read', { timeout: 90_000 });
    await expect(page.getByTestId('wiki-read')).toBeVisible({ timeout: 30_000 });
    // Each page once, the pages ticked first, then those found, in the order found.
    expect((await fetched(page)).slice(before.length)).toEqual([
      'https://wiki.example.org/robots.txt',
      `${WIKI}/Harbour`,
      `${WIKI}/Lighthouse`,
      `${WIKI}/Boats`,
      `${WIKI}/Lamp`,
      `${WIKI}/Keeper`,
      `${WIKI}/Oars`,
    ]);
    for (const title of ['Boats', 'Lamp', 'Keeper', 'Oars']) {
      await expect(row(page, title)).toHaveAttribute('data-state', 'read');
    }
    await expect(page.getByTestId('wiki-found')).toHaveCount(1);
    await expect(page.getByTestId('wiki-found')).toContainText('Found on Welcome, not read');

    // The end of the go, in Add a map: how many were found by links.
    await page.getByTestId('add-map-url').focus();
    await expect(page.getByTestId('add-map-summary')).toContainText(
      '6 pages added. 4 of the pages were found by links on the pages read.',
    );
    await expect(
      page.locator('[data-testid="add-map-run-page"][data-found]').first(),
    ).toContainText('Found by a link on Harbour');
    expect(realErrors(errors)).toEqual([]);
  });
});
