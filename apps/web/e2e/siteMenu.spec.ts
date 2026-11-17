import { devices, type Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { pageTreeGuides, pageTreeSections, servePageTree } from './pageTreePack';

/**
 * The bar beside the page shows the site's own menu, and nothing the app
 * worked out from the pages: on the made-up wiki of `pageTreePack.ts`, its
 * four sections and the pages they name, never the section of pages
 * outside the menu, and no page under another. "All pages", at the foot
 * of the bar, lists every page from A to Z. A page outside the menu shows,
 * above it, the pages the wiki files it under; at its foot, the pages that
 * link to it. "Home" leads to the landing page. A wiki with no menu has no
 * bar: the head of the page area holds what it would.
 */

test.use({ layout: 'standard' });

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

const shownPage = (page: Page) => page.getByTestId('guides-page');
const bar = (page: Page) => page.getByTestId('guides-bar');
const crumbs = (page: Page) => page.locator('.guides-crumbs');
const body = (page: Page) => page.getByTestId('guides-body');
const allList = (page: Page) => page.getByTestId('guides-all');

/** The line as words, steps parted by "›". */
const line = (...steps: string[]) =>
  new RegExp(`^${steps.map((step) => step.replace(/\s+/g, '\\s*')).join('\\s*›\\s*')}$`);

async function openBySearch(page: Page, query: string, title: string): Promise<void> {
  await page.getByTestId('guides-search').first().fill(query);
  await page.getByTestId('guides-result').filter({ hasText: title }).first().click();
  await expect(shownPage(page).locator('h1')).toHaveText(title);
}

/** Every page of the made-up wiki. */
const PAGES = pageTreeGuides().length;

test.describe('on a desktop', () => {
  test('shows only the site’s menu in the bar, and every page under All pages', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await servePageTree(page);
    await page.goto('./');
    await expect(page.getByTestId('guides-home')).toBeVisible();
    // The pack's sections, in its order: not its section of pages outside the menu.
    await expect(bar(page).locator('.guides-tree-section')).toHaveText([
      'Equipment',
      'The world',
      'Things',
      'Basics',
    ]);
    await bar(page).locator('.guides-tree-section').filter({ hasText: 'Equipment' }).click();
    await expect(bar(page).getByTestId('guides-tree-page')).toHaveText(['Armor', 'Weapons']);
    // Armor lists three pages, but none is under it: the app files no page by its links.
    await bar(page).getByTestId('guides-tree-page').getByText('Armor', { exact: true }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Armor');
    await expect(bar(page).getByTestId('guides-tree-toggle')).toHaveCount(0);
    await expect(page.getByTestId('pages-under')).toHaveCount(0);

    // One line at the foot of the bar, with every page counted.
    const all = bar(page).getByTestId('guides-all-pages');
    await expect(all).toContainText('All pages');
    await expect(all.getByTestId('guides-all-count')).toHaveText(PAGES.toLocaleString('en'));
    await all.click();
    await expect(all).toHaveAttribute('aria-current', 'page');
    await expect(allList(page).locator('h1')).toHaveText('All pages');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'All pages'));
    await expect(allList(page).getByTestId('guides-all-page')).toHaveCount(PAGES);
    // Digits and signs first, under #; then A to Z, numbers by their value.
    const letters = allList(page).getByTestId('guides-all-group');
    await expect(letters.first()).toHaveAttribute('data-letter', '#');
    await expect(letters.first().getByTestId('guides-all-page')).toHaveText(['1st Camp']);
    const m = allList(page).locator('[data-letter="M"]');
    await expect(m.getByTestId('guides-all-page')).toHaveText([
      'Marsh Toad',
      'Materials',
      ...Array.from({ length: 13 }, (_, i) => `Mine ${i + 1}`),
      'Mines',
    ]);

    // Each a link to its page; Back returns to the list where it was scrolled to.
    await allList(page).getByTestId('guides-all-letter-link').filter({ hasText: /^S$/ }).click();
    const scrolled = await body(page).evaluate((element) => element.scrollTop);
    expect(scrolled).toBeGreaterThan(1000);
    await allList(page).getByTestId('guides-all-page').filter({ hasText: 'Stray Note' }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Stray Note');
    await page.getByTestId('guides-back').click();
    await expect(allList(page)).toBeVisible();
    await expect
      .poll(() => body(page).evaluate((element) => element.scrollTop))
      .toBeGreaterThan(scrolled - 40);
    await page.getByTestId('guides-forward').click();
    await expect(shownPage(page).locator('h1')).toHaveText('Stray Note');
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });

  test('lists five thousand pages from A to Z at once', async ({ page }) => {
    // The made-up wiki with 4,500 more pages outside its menu.
    const more = Array.from({ length: 4500 }, (_, i) => ({
      id: `demo:guide:extra-${i}`,
      title: `Extra page ${4500 - i}`,
      body: 'More text.',
      locationIds: [],
    }));
    // Routes added later are asked first.
    await servePageTree(page);
    await page.route('**/packs/tree/guides.json', (route) =>
      route.fulfill({ json: [...pageTreeGuides(), ...more] }),
    );
    await page.route('**/packs/tree/sections.json', (route) => {
      const sections = pageTreeSections() as { id: string; items: string[] }[];
      const pages = sections.find((section) => section.id === 'demo:section:pages')!;
      pages.items.push(...more.map((guide) => guide.id));
      return route.fulfill({ json: sections });
    });
    await page.goto('./');
    const all = bar(page).getByTestId('guides-all-pages');
    await expect(all.getByTestId('guides-all-count')).toHaveText(
      (PAGES + 4500).toLocaleString('en'),
    );
    const started = Date.now();
    await all.click();
    await expect(allList(page).getByTestId('guides-all-page').first()).toBeVisible();
    expect(Date.now() - started).toBeLessThan(3000);
    const extra = allList(page).locator('[data-letter="E"]').getByTestId('guides-all-page');
    await expect(extra).toHaveCount(4500);
    await expect(extra.nth(0)).toHaveText('Extra page 1');
    await expect(extra.nth(9)).toHaveText('Extra page 10');
    // Parts out of view are left to be drawn when they come into view.
    await expect(allList(page).locator('.guides-all-part').first()).toHaveCSS(
      'content-visibility',
      'auto',
    );
  });

  test('shows above a page outside the menu the pages the wiki files it under', async ({
    page,
  }) => {
    await servePageTree(page);
    await page.goto('./');
    // Filed under a page not read, and Warden Plate, which is filed under Armor.
    await openBySearch(page, 'helm of the warden', 'Warden Helm');
    await expect(crumbs(page)).toHaveText(
      line('Example Wiki', 'Armor', 'Warden Plate', 'Warden Helm'),
    );
    // Not in the bar: nothing there is marked, and no section opens for it.
    await expect(bar(page).locator('[aria-current="page"]')).toHaveCount(0);
    await crumbs(page).getByRole('button', { name: 'Warden Plate' }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Warden Plate');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Armor', 'Warden Plate'));
    // Filed under nothing: the wiki's name, then the page.
    await openBySearch(page, 'nothing links here', 'Stray Note');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Stray Note'));
    // In the menu: the sections above it, as before.
    await bar(page).locator('.guides-tree-section').filter({ hasText: 'Basics' }).click();
    await bar(page).getByTestId('guides-tree-page').getByText('Gear', { exact: true }).click();
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Basics', 'Gear'));
    await expect(bar(page).locator('[aria-current="page"]')).toHaveText('Gear');
  });

  test('shows a section led by its own page as that page, in the bar and the line', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    // The wiki's menu as an importer writes a page with pages under it: a
    // section of its title, led by the page. Armor leads its section, which
    // also lists Warden Plate (listed under Basics too); Materials is alone in its own.
    await servePageTree(page);
    await page.route('**/packs/tree/sections.json', (route) => {
      const sections = pageTreeSections() as { id: string; title: string; items: string[] }[];
      const byId = (id: string) => sections.find((section) => section.id === `demo:section:${id}`)!;
      byId('equipment').items = ['demo:section:armor', 'demo:guide:weapons'];
      byId('basics').items = [
        'demo:guide:gear',
        'demo:section:materials',
        'demo:guide:field-notes',
        'demo:guide:warden-plate',
      ];
      sections.unshift(
        {
          id: 'demo:section:armor',
          title: 'Armor',
          items: ['demo:guide:armor', 'demo:guide:warden-plate', 'demo:guide:ash-mail'],
        },
        { id: 'demo:section:materials', title: 'Materials', items: ['demo:guide:materials'] },
      );
      return route.fulfill({ json: sections });
    });
    await page.goto('./');
    const heading = (name: string) =>
      bar(page).locator('.guides-tree-section').filter({ hasText: name });
    await heading('Equipment').click();
    await expect(heading('Armor')).toHaveAttribute('aria-expanded', 'false');
    await expect(bar(page).getByTestId('guides-tree-page')).toHaveText(['Weapons']);

    // The heading is the page: it opens it, and the page is not named again under it.
    await heading('Armor').click();
    await expect(shownPage(page).locator('h1')).toHaveText('Armor');
    await expect(heading('Armor')).toHaveAttribute('aria-current', 'page');
    await expect(heading('Armor')).toHaveAttribute('aria-expanded', 'true');
    await expect(bar(page).getByTestId('guides-tree-page')).toHaveText([
      'Warden Plate',
      'Ash Mail',
      'Weapons',
    ]);
    await expect(bar(page).locator('[aria-current="page"]')).toHaveText(['Armor']);
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Equipment', 'Armor'));
    // Pressed again while its page is shown, it folds and unfolds.
    await heading('Armor').click();
    await expect(heading('Armor')).toHaveAttribute('aria-expanded', 'false');
    await expect(bar(page).getByTestId('guides-tree-page')).toHaveText(['Weapons']);
    await expect(shownPage(page).locator('h1')).toHaveText('Armor');
    await heading('Armor').click();
    await expect(heading('Armor')).toHaveAttribute('aria-expanded', 'true');

    // A page under it: the section is a step of the line, which opens its page.
    await bar(page).getByTestId('guides-tree-page').getByText('Ash Mail', { exact: true }).click();
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Equipment', 'Armor', 'Ash Mail'));
    await crumbs(page).getByRole('button', { name: 'Armor' }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Armor');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Equipment', 'Armor'));

    // A section with its page alone: a heading with no arrow, which opens the page.
    await heading('Basics').click();
    await expect(heading('Materials')).not.toHaveAttribute('aria-expanded');
    await expect(heading('Materials').locator('svg')).toHaveCount(0);
    await heading('Materials').click();
    await expect(shownPage(page).locator('h1')).toHaveText('Materials');
    await expect(heading('Materials')).toHaveAttribute('aria-current', 'page');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Basics', 'Materials'));

    // A page listed twice, pressed at its second listing: shown there, its first not unfolded.
    await bar(page)
      .getByTestId('guides-tree-page')
      .getByText('Warden Plate', { exact: true })
      .click();
    await expect(shownPage(page).locator('h1')).toHaveText('Warden Plate');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Basics', 'Warden Plate'));
    await expect(heading('Basics')).toHaveAttribute('aria-expanded', 'true');
    await expect(heading('Equipment')).toHaveAttribute('aria-expanded', 'false');
    const here = bar(page).locator('[data-here]');
    await expect(here).toHaveCount(1);
    await expect(here).toHaveText('Warden Plate');
    await expect(here).toHaveAttribute('aria-current', 'page');
    await expect(here).toBeInViewport();
    const basicsList = heading('Basics').locator('xpath=..');
    await expect(basicsList.locator('[data-here]')).toHaveCount(1);

    // Opened another way (search): at its first place, under Armor.
    await openBySearch(page, 'heavy plate', 'Warden Plate');
    await expect(crumbs(page)).toHaveText(
      line('Example Wiki', 'Equipment', 'Armor', 'Warden Plate'),
    );
    await expect(heading('Armor')).toHaveAttribute('aria-expanded', 'true');
    await expect(heading('Basics')).toHaveAttribute('aria-expanded', 'false');
    await expect(here).toHaveCount(1);
    await expect(heading('Armor').locator('xpath=..').locator('[data-here]')).toHaveText(
      'Warden Plate',
    );

    // Back to the visit opened from Basics: shown there again.
    await page.getByTestId('guides-back').click();
    await expect(page.getByTestId('guides-results')).toBeVisible();
    await page.getByTestId('guides-back').click();
    await expect(shownPage(page).locator('h1')).toHaveText('Warden Plate');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Basics', 'Warden Plate'));
    await expect(heading('Basics')).toHaveAttribute('aria-expanded', 'true');
    await expect(basicsList.locator('[data-here]')).toHaveText('Warden Plate');

    // The first listing pressed while the page is shown: the bar and the line follow it.
    await heading('Equipment').click();
    await heading('Armor').click();
    await bar(page)
      .getByTestId('guides-tree-page')
      .getByText('Warden Plate', { exact: true })
      .first()
      .click();
    await expect(crumbs(page)).toHaveText(
      line('Example Wiki', 'Equipment', 'Armor', 'Warden Plate'),
    );
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });

  test('names the pages that link to a page, twelve at first', async ({ page }) => {
    await servePageTree(page);
    await page.goto('./');
    await openBySearch(page, 'heavy plate', 'Warden Plate');
    const from = page.getByTestId('linked-from');
    await expect(from.locator('h2')).toHaveText('Linked from');
    await expect(from.getByTestId('linked-from-page')).toHaveText([
      'Armor',
      'Warden Helm',
      'Longblade',
    ]);
    await from.getByRole('button', { name: 'Longblade' }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Longblade');
    // Walked to from Warden Plate: the line shows the way the reader came.
    await expect(crumbs(page)).toHaveText(
      line('Example Wiki', 'Armor', 'Warden Plate', 'Longblade'),
    );

    await openBySearch(page, 'found everywhere', 'Common Ore');
    const ore = page.getByTestId('linked-from');
    await expect(ore.getByTestId('linked-from-page')).toHaveCount(12);
    await expect(ore.getByTestId('linked-from-more')).toHaveText('and 5 more');
    await ore.getByTestId('linked-from-more').click();
    await expect(ore.getByTestId('linked-from-page')).toHaveCount(17);
    await expect(ore.getByTestId('linked-from-more')).toHaveCount(0);
  });

  test('leads home from Home beside Back and Forward, and from the key H', async ({ page }) => {
    await servePageTree(page);
    await page.goto('./');
    const home = page.getByTestId('guides-home-button');
    await expect(home).toHaveAccessibleName('Home');
    await expect(home).toHaveAttribute('title', /^Home/);
    await expect(home).toHaveAttribute('aria-current', 'page');
    await openBySearch(page, 'nothing links here', 'Stray Note');
    await expect(home).not.toHaveAttribute('aria-current', 'page');
    await home.click();
    await expect(page.getByTestId('guides-home')).toBeVisible();
    await expect(home).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('guides-back').click();
    await expect(shownPage(page).locator('h1')).toHaveText('Stray Note');
    // H, but not while typing.
    await page.getByTestId('guides-search').first().fill('h');
    await expect(page.getByTestId('guides-results')).toBeVisible();
    await page.getByTestId('guides-search').first().press('h');
    await expect(page.getByTestId('guides-search').first()).toHaveValue('hh');
    await page.getByTestId('guides-search').first().fill('');
    await expect(shownPage(page).locator('h1')).toHaveText('Stray Note');
    await page.getByTestId('guides-search').first().blur();
    await page.keyboard.press('h');
    await expect(page.getByTestId('guides-home')).toBeVisible();
  });

  test('has no bar for a wiki with no menu: the head holds search and All pages', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await servePageTree(page, { menu: false });
    await page.goto('./');
    await expect(page.getByTestId('guides-screen')).toHaveAttribute('data-menu', 'false');
    await expect(bar(page)).toHaveCount(0);
    // No menu and no home page: the landing page lists every page.
    const landing = page.getByTestId('guides-home');
    await expect(landing).toHaveAttribute('data-landing', 'all');
    await expect(landing.locator('h1')).toHaveText('Example Wiki');
    await expect(landing.getByTestId('guides-all-page')).toHaveCount(PAGES);
    // The page area takes the width.
    const width = await page.locator('.guides-reader').evaluate((e) => e.clientWidth);
    const screen = await page.getByTestId('guides-screen').evaluate((e) => e.clientWidth);
    expect(width).toBe(screen);
    // The head: Home, search and All pages, always in view.
    const tools = page.getByTestId('guides-head-tools');
    await expect(tools.getByTestId('guides-search')).toBeVisible();
    await expect(page.getByTestId('guides-home-button')).toBeVisible();
    await tools.getByTestId('guides-search').fill('heavy plate');
    await page.getByTestId('guides-result').first().click();
    await expect(shownPage(page).locator('h1')).toHaveText('Warden Plate');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Armor', 'Warden Plate'));
    await tools.getByTestId('guides-all-pages').click();
    await expect(allList(page).locator('h1')).toHaveText('All pages');
    await expect(tools.getByTestId('guides-all-pages')).toHaveAttribute('aria-current', 'page');
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ ...pixel });

  test('lists the pages put under a page by hand, and none the page lists', async ({ page }) => {
    await servePageTree(page);
    await page.goto('./');
    await page.getByTestId('guides-search').fill('heavy plate');
    await page.getByTestId('guides-result').first().tap();
    await expect(shownPage(page).locator('h1')).toHaveText('Warden Plate');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Armor', 'Warden Plate'));
    await expect(page.getByTestId('pages-under')).toHaveCount(0);
    await expect(page.getByTestId('linked-from')).toBeVisible();
    // The Contents button opens the menu, with All pages at its foot.
    const button = page.getByTestId('guides-contents-button');
    await expect(button).toHaveAccessibleName('Contents');
    await button.tap();
    const list = page.getByTestId('guides-contents');
    await expect(list.getByTestId('guides-section')).toHaveText([
      /Equipment/,
      /The world/,
      /Things/,
      /Basics/,
    ]);
    await list.getByTestId('guides-all-pages').tap();
    await expect(allList(page).locator('h1')).toHaveText('All pages');
  });

  test('opens All pages from the Contents button of a wiki with no menu', async ({ page }) => {
    await servePageTree(page, { menu: false });
    await page.goto('./');
    await expect(page.getByTestId('guides-home')).toHaveAttribute('data-landing', 'all');
    await page
      .getByTestId('guides-home')
      .getByTestId('guides-all-page')
      .filter({ hasText: 'Stray Note' })
      .tap();
    await expect(shownPage(page).locator('h1')).toHaveText('Stray Note');
    const button = page.getByTestId('guides-contents-button');
    await expect(button).toHaveAccessibleName('All pages');
    await expect(button).toHaveAttribute('title', 'All pages');
    await button.tap();
    await expect(allList(page).locator('h1')).toHaveText('All pages');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'All pages'));
    await expect(page.getByTestId('guides-home-button')).toBeInViewport();
    expect(await body(page).evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(
      0,
    );
  });
});
