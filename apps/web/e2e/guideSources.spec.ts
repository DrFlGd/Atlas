import { devices, type Page, type Route } from '@playwright/test';
import { collectErrors, reloadSaved, storedSetting } from './helpers';
import { expect, test } from './layout';

/**
 * Which source of pages Guides shows, in the standard layout: the demo
 * world's own made-up wiki pages, and another game on the device with the
 * same pages under ids of its own ("Isle Wiki", no map), read with it. The
 * switcher at the top lists both; the contents, the landing page and the
 * way above a page show the one chosen, which is remembered; a link to a
 * page of the other source switches to it; search names the source of a
 * page of the other one. The demo's pages are made a guide in the contents
 * editor: they read in order, with Previous, Next, the `[` and `]` keys and
 * Continue; the wiki has none of them.
 */

test.use({ layout: 'standard' });

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

/**
 * Another game on the device with the demo wiki's pages and no map, as a
 * wiki read with an importer would be: ids of its own (`isle-wiki:`). Its
 * page of wolves is called "Wolf dens", and links to a page of the demo.
 */
async function serveTwoGames(page: Page): Promise<void> {
  await page.route('**/config.json', (route) =>
    route.fulfill({
      json: {
        packs: [
          { id: 'demo', url: 'packs/demo/', title: 'Atlas demo world' },
          { id: 'isle-wiki', url: 'packs/isle-wiki/', title: 'Isle Wiki' },
        ],
      },
    }),
  );
  const demoFile = async (route: Route) =>
    route
      .fetch({ url: route.request().url().replace('/packs/isle-wiki/', '/packs/demo/') })
      .then((r) => (r.ok() ? r : null));
  await page.route('**/packs/isle-wiki/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/packs/isle-wiki/')[1] ?? '';
    const response =
      ['manifest.json', 'sections.json', 'pictures.json', 'guides.json'].includes(name) ||
      name.startsWith('pictures/')
        ? await demoFile(route)
        : null;
    if (!response) return route.fulfill({ status: 404, body: 'not found' });
    if (name.startsWith('pictures/')) return route.fulfill({ response });
    const text = (await response.text())
      .replaceAll('"demo:', '"isle-wiki:')
      .replaceAll('(demo:', '(isle-wiki:');
    const value = JSON.parse(text) as unknown;
    if (name === 'manifest.json') {
      const { contents: _contents, ...manifest } = value as Record<string, unknown>;
      return route.fulfill({
        json: { ...manifest, gameId: 'isle-wiki', title: 'Isle Wiki', idMigrations: {} },
      });
    }
    if (name === 'guides.json') {
      const all = value as { id: string; title: string; body: string }[];
      return route.fulfill({
        json: all
          .filter((g) => g.id.startsWith('isle-wiki:guide:wiki-'))
          .map((g) =>
            g.title === 'Wolves'
              ? {
                  ...g,
                  title: 'Wolf dens',
                  body: `${g.body}\n\nThe [regions](demo:guide:wiki-regions) of the map say where.`,
                }
              : g,
          ),
      });
    }
    return route.fulfill({ json: value });
  });
}

const chip = (page: Page) => page.getByTestId('guides-source-chip');
const menu = (page: Page) => page.getByTestId('guides-sources-menu');
const shownPage = (page: Page) => page.getByTestId('guides-page');
const treeSections = (page: Page) => page.locator('.guides-side .guides-tree-section');

async function choose(page: Page, source: string): Promise<void> {
  await chip(page).click();
  await menu(page).locator(`[data-testid="guides-source"][data-source="${source}"]`).click();
  await expect(menu(page)).toHaveCount(0);
  await expect(chip(page)).toHaveAttribute('data-source', source);
}

/** Opens Guides with the Isle Wiki's pages read with the demo's. */
async function withTheWiki(page: Page): Promise<void> {
  await serveTwoGames(page);
  await page.goto('./');
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
  await page.getByTestId('section-guides').click();
  // One source: no switcher.
  await expect(page.getByTestId('guides-home')).toBeVisible();
  await expect(chip(page)).toHaveCount(0);
  await page.getByTestId('add-guides-from').click();
  await page.getByTestId('guides-from-choice').filter({ hasText: 'Isle Wiki' }).click();
  await expect(page.getByTestId('guides-from-game')).toHaveText(/Isle Wiki/);
}

test.describe('on a computer', () => {
  test('a switcher chooses the source shown, which is remembered, and links and search reach the other', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await withTheWiki(page);

    // The game's own pages are shown: their contents only.
    await expect(chip(page)).toHaveAttribute('data-source', 'demo');
    await expect(chip(page)).toContainText('Atlas demo world');
    await expect(chip(page).getByTestId('guides-source-type')).toHaveText('Wiki');
    await expect(treeSections(page)).toHaveText([/Basics/, /The isle/, /Gear/]);

    // The list of sources: each with whether it is a guide or a wiki.
    await chip(page).click();
    const rows = menu(page).getByTestId('guides-source');
    await expect(rows).toHaveText([/Atlas demo world\s*Wiki/, /Isle Wiki\s*Wiki/]);
    await expect(rows.first()).toHaveAttribute('aria-current', 'true');
    // Guides of another game can be added from it too.
    await expect(menu(page).getByTestId('add-guides-from')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);

    // The wiki: its landing page, its contents and its way above a page.
    await choose(page, 'isle-wiki');
    await expect(page.getByTestId('guides-home')).toHaveAttribute('data-source', 'isle-wiki');
    await expect(page.getByTestId('guides-home').locator('h1').first()).toHaveText('Isle Wiki');
    await expect(page.getByTestId('guides-tree-home')).toHaveText('Isle Wiki');
    await expect(treeSections(page)).toHaveText([/Basics/, /The isle/, /Gear/]);
    await treeSections(page).filter({ hasText: 'The isle' }).click();
    await page.getByTestId('guides-section').filter({ hasText: 'Foes' }).click();
    await page.getByTestId('guides-page-link').filter({ hasText: 'Wolf dens' }).click();
    await expect(shownPage(page)).toHaveAttribute('data-guide', 'isle-wiki:guide:wiki-wolves');
    await expect(page.locator('.guides-crumbs')).toHaveText(/^Isle Wiki\s*›\s*The isle\s*›\s*Foes/);
    // A wiki reads as a collection: no Previous and Next.
    await expect(page.getByTestId('guides-sequence')).toHaveCount(0);

    // Remembered: Guides opens on the wiki after a restart.
    await expect.poll(() => storedSetting(page, 'guidesSource:demo')).toBe('isle-wiki');
    await reloadSaved(page);
    await page.getByTestId('section-guides').click();
    await expect(chip(page)).toHaveAttribute('data-source', 'isle-wiki');
    await expect(page.getByTestId('guides-home')).toHaveAttribute('data-source', 'isle-wiki');

    // Search looks in both, and names the source of a page of the other one.
    await page.getByTestId('guides-search').first().fill('wolves');
    const results = page.getByTestId('guides-result-row');
    await expect(results.filter({ hasText: 'Wolf dens' })).toHaveCount(1);
    await expect(
      results.filter({ hasText: 'Wolf dens' }).getByTestId('guides-result-source'),
    ).toHaveCount(0);
    const wolves = results.filter({ hasText: /^Wolves/ });
    await expect(wolves.getByTestId('guides-result-source')).toHaveText('In Atlas demo world');
    // Opening it shows its source.
    await wolves.getByTestId('guides-result').click();
    await expect(shownPage(page)).toHaveAttribute('data-guide', 'demo:guide:wiki-wolves');
    await expect(chip(page)).toHaveAttribute('data-source', 'demo');
    await expect(treeSections(page)).toHaveText([/Basics/, /The isle/, /Foes/, /Gear/]);
    await expect(page.locator('.guides-crumbs')).toHaveText(
      /^Atlas demo world\s*›\s*The isle\s*›\s*Foes/,
    );

    // A link from a page of the wiki to a page of the demo switches too; Back returns.
    await choose(page, 'isle-wiki');
    await page.getByTestId('guides-search').first().fill('wolf dens');
    await page.getByTestId('guides-result').filter({ hasText: 'Wolf dens' }).click();
    await expect(chip(page)).toHaveAttribute('data-source', 'isle-wiki');
    await shownPage(page).locator('.app-link').filter({ hasText: 'regions' }).click();
    await expect(shownPage(page)).toHaveAttribute('data-guide', 'demo:guide:wiki-regions');
    await expect(chip(page)).toHaveAttribute('data-source', 'demo');
    await page.getByTestId('guides-back').click();
    await expect(shownPage(page)).toHaveAttribute('data-guide', 'isle-wiki:guide:wiki-wolves');
    await expect(chip(page)).toHaveAttribute('data-source', 'isle-wiki');
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });

  test('pages said to be read in order are a guide: Previous, Next and Continue', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await withTheWiki(page);

    // The demo's pages are made a guide, in the contents editor.
    await page.getByTestId('guides-home').getByTestId('edit-page').first().click();
    const editor = page.getByTestId('contents-editor');
    await expect(editor).toBeVisible();
    const inOrder = editor.getByTestId('read-in-order-switch');
    await expect(inOrder).not.toBeChecked();
    await inOrder.check();
    await expect
      .poll(async () => {
        const text = await storedSetting(page, 'ownPages:demo');
        return typeof text === 'string'
          ? (JSON.parse(text) as { pagesInOrder?: boolean }).pagesInOrder
          : undefined;
      })
      .toBe(true);
    await page.getByTestId('cancel-edit').click();
    await expect(editor).toHaveCount(0);
    await expect(chip(page).getByTestId('guides-source-type')).toHaveText('Guide');

    // Its landing page leads to its first page; nothing to continue yet.
    await expect(page.getByTestId('guides-continue')).toHaveCount(0);
    await expect(page.getByTestId('guides-next')).toContainText('Welcome to the Sundered Isle');
    await expect(page.getByTestId('guides-previous')).toHaveCount(0);

    // A page ends with the pages before and after it, in the order of the contents.
    await treeSections(page).filter({ hasText: 'Basics' }).click();
    await page.getByTestId('guides-page-link').filter({ hasText: 'Getting around' }).click();
    await expect(page.getByTestId('guides-previous')).toContainText('Welcome to the Sundered Isle');
    await expect(page.getByTestId('guides-next')).toContainText('Isle portal');
    await page.getByTestId('guides-next').click();
    await expect(shownPage(page).locator('h1')).toHaveText('Isle portal');
    // Into the next section, by the key.
    await page.keyboard.press(']');
    await expect(shownPage(page).locator('h1')).toHaveText('Regions');
    await expect(page.locator('.guides-crumbs')).toHaveText(/^Atlas demo world\s*›\s*The isle/);
    await page.keyboard.press('[');
    await expect(shownPage(page).locator('h1')).toHaveText('Isle portal');
    await page.keyboard.press(']');
    await expect(shownPage(page).locator('h1')).toHaveText('Regions');

    // The landing page offers to continue there, also after a restart.
    await page.getByTestId('guides-crumb-game').click();
    await expect(page.getByTestId('guides-continue')).toContainText('Regions');
    await expect
      .poll(() => storedSetting(page, 'guideReadLast:demo'))
      .toBe('demo:guide:wiki-regions');
    await reloadSaved(page);
    await page.getByTestId('section-guides').click();
    await expect(page.getByTestId('guides-continue')).toContainText('Regions');
    await page.getByTestId('guides-continue-button').click();
    await expect(shownPage(page).locator('h1')).toHaveText('Regions');

    // The wiki is no guide: none of it.
    await choose(page, 'isle-wiki');
    await expect(chip(page).getByTestId('guides-source-type')).toHaveText('Wiki');
    await expect(page.getByTestId('guides-continue')).toHaveCount(0);
    await treeSections(page).filter({ hasText: 'Basics' }).click();
    await page.getByTestId('guides-page-link').filter({ hasText: 'Getting around' }).click();
    await expect(shownPage(page)).toHaveAttribute('data-guide', 'isle-wiki:guide:wiki-travel');
    await expect(page.getByTestId('guides-sequence')).toHaveCount(0);
    await page.keyboard.press(']');
    await expect(shownPage(page)).toHaveAttribute('data-guide', 'isle-wiki:guide:wiki-travel');
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ ...pixel });

  test('the switcher is one line over the reader, and the contents show the source chosen', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await withTheWiki(page);
    const box = await page.getByTestId('guides-sources').boundingBox();
    expect(box?.height ?? 0).toBeLessThan(60);
    // Nothing goes sideways.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await choose(page, 'isle-wiki');
    await page.getByTestId('guides-contents-button').click();
    const contents = page.getByTestId('guides-contents');
    await expect(contents.locator('h1')).toHaveText('Isle Wiki');
    await expect(contents.getByTestId('guides-section')).toHaveText([/Basics/, /The isle/, /Gear/]);
    // The pages of another game are changed in that game.
    await expect(contents.getByTestId('edit-pages')).toHaveCount(0);
    await choose(page, 'demo');
    await expect(page.getByTestId('guides-home')).toHaveAttribute('data-source', 'demo');
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });
});
