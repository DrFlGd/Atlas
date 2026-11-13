import { devices, type Page, type Route } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';

/**
 * Guides read as pages, in the standard layout: the demo pack's made-up
 * wiki (a contents of sections, pages with a table, a picture, hidden text,
 * links between them and a credit), and a game with no map at all.
 */

test.use({ layout: 'standard' });

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

const guides = (page: Page) => page.getByTestId('guides-screen');
const body = (page: Page) => page.getByTestId('guides-body');
const shownPage = (page: Page) => page.getByTestId('guides-page');

async function openGuides(page: Page): Promise<void> {
  await page.goto('./');
  await page.getByTestId('section-guides').click();
  await expect(guides(page)).toBeVisible();
}

/** Opens an entry of the contents shown (a section or a page) by its name. */
async function openEntry(page: Page, name: string): Promise<void> {
  await body(page)
    .locator('[data-testid="guides-section"], [data-testid="guides-page-link"]')
    .filter({ hasText: name })
    .first()
    .click();
}

test.describe('on a desktop', () => {
  test('a picture whose file is not here shows in words', async ({ page }) => {
    // As a picture listed to be downloaded later, before it is.
    await page.route('**/packs/demo/pictures/wiki-waystone.png', (route) =>
      route.fulfill({ status: 404, body: 'not found' }),
    );
    await openGuides(page);
    await openEntry(page, 'The isle');
    await openEntry(page, 'Waystones');
    const frame = shownPage(page).locator('.guide-picture');
    await expect(frame).toHaveAttribute('data-missing', '');
    await expect(frame.locator('img')).toHaveCount(0);
    await expect(frame.locator('.picture-alt')).toContainText('(picture not downloaded)');
  });

  test('browses the contents, follows links, and goes back to where it was read', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openGuides(page);
    await expect(page.locator('.touch')).toHaveAttribute('data-section', 'guides');
    // The contents: its sections, at the top and beside the page.
    const contents = page.getByTestId('guides-contents');
    await expect(contents.getByTestId('guides-section')).toHaveText([
      /Basics\s*2 pages/,
      /The isle\s*4 pages/,
    ]);
    await expect(page.locator('.guides-side')).toContainText('The isle');

    // A section, then a page with a table, a picture and its credit.
    await openEntry(page, 'The isle');
    await expect(page.locator('.guides-crumbs')).toHaveText(/Contents\s*›\s*The isle/);
    await openEntry(page, 'Waystones');
    await expect(shownPage(page).locator('h1')).toHaveText('Waystones');
    const picture = shownPage(page).locator('.guide-picture img');
    await expect(picture).toHaveAttribute('src', /packs\/demo\/pictures\/wiki-waystone\.png$/);
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(640);
    await expect(shownPage(page).locator('.guide-picture-note')).toHaveText(
      'A woken waystone · Drawn by the Atlas pipeline',
    );
    await expect(shownPage(page).locator('table')).toHaveCount(1);
    const credit = page.getByTestId('guides-credit');
    await expect(credit).toContainText('From “Waystones” on Example Wiki');
    await expect(credit).toContainText('Licence: CC BY-SA 4.0');
    await expect(credit.getByRole('link', { name: 'CC BY-SA 4.0' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by-sa/4.0/',
    );
    // Links to other sites leave the app; hidden text waits to be asked for.
    await expect(credit.getByRole('link').first()).toHaveAttribute('target', '_blank');
    const hidden = shownPage(page).locator('.hidden-text-block');
    await expect(hidden).toBeHidden();
    await shownPage(page).getByRole('button', { name: 'Show hidden text' }).click();
    await expect(shownPage(page)).toContainText('under the lake');

    // A link to another page opens it here; Back returns to the scroll left.
    await body(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const scrolled = await body(page).evaluate((el) => el.scrollTop);
    expect(scrolled).toBeGreaterThan(100);
    await shownPage(page).getByRole('button', { name: 'Getting around' }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Getting around');
    await expect(body(page)).toHaveJSProperty('scrollTop', 0);
    await page.getByTestId('guides-back').click();
    await expect(shownPage(page).locator('h1')).toHaveText('Waystones');
    await expect
      .poll(() => body(page).evaluate((el) => el.scrollTop))
      .toBeGreaterThan(scrolled - 2);
    await page.getByTestId('guides-forward').click();
    await expect(shownPage(page).locator('h1')).toHaveText('Getting around');

    // Back through the pages read, to the top of the contents.
    for (let i = 0; i < 3; i++) await page.getByTestId('guides-back').click();
    await expect(page.getByTestId('guides-contents')).toBeVisible();
    await expect(page.getByTestId('guides-back')).toBeDisabled();
    await expect(page.getByTestId('guides-forward')).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test('searches titles and text, never hidden text', async ({ page }) => {
    await openGuides(page);
    const field = page.getByTestId('guides-search');
    await field.fill('warden');
    const results = page.getByTestId('guides-results');
    await expect(results.locator('.guides-lead')).toHaveText(/^\d+ pages? with “warden”$/);
    // A title match comes first; the words found are marked in the line quoted.
    await expect(results.getByTestId('guides-result').first()).toContainText('Stone wardens');
    await expect(results.locator('mark').first()).toHaveText(/warden/i);
    // An answer that is only in hidden text is not found.
    await field.fill('under the lake');
    await expect(results.locator('.guides-lead')).toHaveText('No page has “under the lake”.');
    await field.fill('ferry');
    await results.getByTestId('guides-result').first().click();
    await expect(shownPage(page).locator('h1')).toHaveText('Getting around');
    // Back returns to the search, with the words typed.
    await page.getByTestId('guides-back').click();
    await expect(field).toHaveValue('ferry');
    await expect(results.getByTestId('guides-result')).toHaveCount(1);
  });

  test('keeps the pages read in Guides out of Lists, and the walkthroughs there', async ({
    page,
  }) => {
    await page.goto('./');
    await page.getByTestId('section-lists').click();
    const lists = page.locator('.touch-panel');
    await expect(lists).toContainText('Arriving on the isle');
    await expect(lists).not.toContainText('Welcome to the Sundered Isle');
  });
});

test.describe('on a phone', () => {
  test.use({ ...pixel });

  test('reads a page with a wide table that scrolls on its own', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await page.getByTestId('section-guides').tap();
    await expect(page.locator('.guides-side')).toHaveCount(0);
    await expect(page.getByTestId('guides-search')).toBeVisible();
    await openEntry(page, 'The isle');
    await openEntry(page, 'Regions');
    const table = shownPage(page).locator('table');
    const sizes = await table.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(sizes[0]).toBeGreaterThan(sizes[1]!);
    // The page itself does not scroll sideways.
    expect(await body(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
    await expect(page.getByTestId('guides-credit')).toContainText('Example Wiki');
    // Only where the page is shows above it; the contents is a tap away.
    await expect(page.locator('.guides-crumb-part:visible')).toHaveText(/The isle/);
    await page.getByTestId('guides-contents-button').tap();
    await expect(page.getByTestId('guides-contents')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

/**
 * A game with no map: the demo wiki alone, served as a pack of its own
 * with no map files at all.
 */
async function serveWikiOnly(page: Page): Promise<void> {
  await page.route('**/config.json', (route) =>
    route.fulfill({ json: { packs: [{ id: 'demo', url: 'packs/wiki/', title: 'Example Wiki' }] } }),
  );
  const demoFile = async (route: Route) =>
    route
      .fetch({ url: route.request().url().replace('/packs/wiki/', '/packs/demo/') })
      .then((r) => (r.ok() ? r : null));
  await page.route('**/packs/wiki/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/packs/wiki/')[1] ?? '';
    const response =
      ['manifest.json', 'sections.json', 'pictures.json', 'guides.json'].includes(name) ||
      name.startsWith('pictures/')
        ? await demoFile(route)
        : null;
    if (!response) return route.fulfill({ status: 404, body: 'not found' });
    if (name === 'manifest.json') {
      const manifest = (await response.json()) as { title: string };
      return route.fulfill({ json: { ...manifest, title: 'Example Wiki' } });
    }
    if (name === 'guides.json') {
      const all = (await response.json()) as { id: string }[];
      return route.fulfill({ json: all.filter((g) => g.id.startsWith('demo:guide:wiki-')) });
    }
    return route.fulfill({ response });
  });
}

test.describe('a game with no map', () => {
  test('opens on its guides, with no Map or Lists section', async ({ page }) => {
    const errors = collectErrors(page);
    await serveWikiOnly(page);
    await page.goto('./');
    await expect(guides(page)).toBeVisible();
    const shell = page.locator('.touch');
    await expect(shell).toHaveAttribute('data-map', 'none');
    await expect(shell).toHaveAttribute('data-section', 'guides');
    await expect(page.getByTestId('section-map')).toHaveCount(0);
    await expect(page.getByTestId('section-lists')).toHaveCount(0);
    await expect(page.locator('.leaflet-container')).toHaveCount(0);
    await expect(page.getByTestId('guides-contents').locator('h1')).toHaveText('Example Wiki');

    // `/` searches its pages.
    await page.keyboard.press('/');
    await expect(page.getByTestId('guides-search')).toBeFocused();
    await page.keyboard.type('wolves');
    await page.getByTestId('guides-result').first().click();
    await expect(shownPage(page).locator('h1')).toHaveText('Wolves');

    // The other sections still work, and Guides is where the app returns to.
    await page.getByTestId('section-progress').click();
    await expect(shell).toHaveAttribute('data-section', 'progress');
    await page.keyboard.press('Escape');
    await expect(shell).toHaveAttribute('data-section', 'guides');
    await page.getByTestId('section-games').click();
    await expect(page.getByTestId('games-screen')).toContainText('Example Wiki');
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });

  test.describe('in the classic layout', () => {
    test.use({ layout: 'classic' });

    test('says so, and shows the guides', async ({ page }) => {
      await serveWikiOnly(page);
      await page.goto('./');
      await expect(page.getByTestId('no-map')).toContainText('This game has no map');
      await page.getByTestId('no-map').getByRole('button', { name: 'Show the guides' }).click();
      await expect(page.getByRole('tab', { selected: true })).toContainText(/Guides|Lists/);
    });
  });
});
