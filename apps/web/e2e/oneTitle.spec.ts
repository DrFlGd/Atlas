import { mkdir } from 'node:fs/promises';
import type { Page, Route } from '@playwright/test';
import { collectErrors, storedSetting } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, mock, paste, realErrors, setUp, url } from './fakeShell';

/**
 * Games shown under one title: made in Games (a browser, the Android app)
 * and in the Library (the desktop app), the title's one row with its
 * sources, the maps menu with the maps of each source, Guides with the
 * pages of a wiki of the title, taking a source out and showing them
 * separately again, and the Importer's offer when a game of the same
 * title is added. Every game here is the made-up demo world, copied under
 * other ids and titles.
 */

const SHOTS = process.env.ATLAS_TITLE_SHOTS ?? 'test-results/one-title';

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

// A game's files may still be on their way when a test ends: what the copies
// are served with (see `serveGames`) is taken off first, so a file cut short
// by the page closing is not an error of the test.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

// Pictures for people to read: sharp on a screen of high density.
test.use({ deviceScaleFactor: 2 });

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' });

interface Copy {
  id: string;
  title: string;
  /** The title of the importer that made it, its source's name. */
  importer?: string;
  /** A game of pages: the demo's guides only, without its maps. */
  wiki?: boolean;
}

/**
 * Lists the demo world and copies of it in `packs/index.json`, and serves
 * each copy from the demo's files with its ids changed. `demoImporter`
 * names the importer the demo world came from.
 */
async function serveGames(page: Page, copies: Copy[], demoImporter?: string): Promise<void> {
  await page.route('**/packs/index.json', (route) =>
    route.fulfill({
      json: {
        packs: [
          { id: 'demo', url: 'packs/demo/', title: 'Atlas demo world' },
          ...copies.map((copy) => ({ id: copy.id, url: `packs/${copy.id}/`, title: copy.title })),
        ],
      },
    }),
  );
  if (demoImporter) {
    await page.route('**/packs/demo/manifest.json', async (route) => {
      const response = await route.fetch();
      const manifest = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ json: { ...manifest, source: importedBy(demoImporter) } });
    });
  }
  for (const copy of copies) {
    await page.route(`**/packs/${copy.id}/**`, (route) => serveCopy(route, copy));
  }
}

const importedBy = (title: string) => ({
  importer: { id: title.toLowerCase().replaceAll(' ', '-'), title },
  pages: [],
});

const WIKI_FILES = ['manifest.json', 'sections.json', 'pictures.json', 'guides.json'];

async function serveCopy(route: Route, copy: Copy): Promise<void> {
  const name = new URL(route.request().url()).pathname.split(`/packs/${copy.id}/`)[1] ?? '';
  if (copy.wiki && !WIKI_FILES.includes(name) && !name.startsWith('pictures/')) {
    return route.fulfill({ status: 404, body: 'not found' });
  }
  const response = await route.fetch({
    url: route.request().url().replace(`/packs/${copy.id}/`, '/packs/demo/'),
  });
  if (!response.ok() || !name.endsWith('.json')) return route.fulfill({ response });
  const value = JSON.parse(
    (await response.text())
      .replaceAll('"demo:', `"${copy.id}:`)
      .replaceAll('(demo:', `(${copy.id}:`),
  ) as unknown;
  if (name === 'manifest.json') {
    const { contents, ...manifest } = value as Record<string, unknown>;
    return route.fulfill({
      json: {
        ...manifest,
        ...(copy.wiki ? {} : { contents }),
        gameId: copy.id,
        title: copy.title,
        idMigrations: {},
        ...(copy.importer ? { source: importedBy(copy.importer) } : {}),
      },
    });
  }
  if (copy.wiki && name === 'guides.json') {
    const all = value as { id: string }[];
    return route.fulfill({ json: all.filter((g) => g.id.startsWith(`${copy.id}:guide:wiki-`)) });
  }
  return route.fulfill({ json: value });
}

const SECOND: Copy = { id: 'isles-two', title: 'Atlas Demo World!', importer: 'Second map site' };
const WIKI: Copy = { id: 'isle-wiki', title: 'Isle Wiki', wiki: true };

const gameRow = (page: Page, id: string) =>
  page.locator(`[data-testid="game-row"][data-pack="${id}"]`);

/** The record of titles as it is stored now: the text of the file, in a setting. */
async function storedGroups(page: Page) {
  const text = await storedSetting(page, 'gameGroups');
  if (typeof text !== 'string') return null;
  const file = JSON.parse(text) as {
    format: string;
    version: number;
    groups: { title: string; members: { gameId: string }[] }[];
  };
  expect(file).toMatchObject({ format: 'atlas-game-groups', version: 1 });
  return file;
}

/** Waits until the titles are stored as `titles` say, each with its games. */
async function stored(page: Page, titles: Record<string, string[]>): Promise<void> {
  await expect
    .poll(async () =>
      Object.fromEntries(
        ((await storedGroups(page))?.groups ?? []).map((group) => [
          group.title,
          group.members.map((member) => member.gameId),
        ]),
      ),
    )
    .toEqual(titles);
}

async function reloadShown(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
}

/** Games › the demo world › Show with another game…: chooses `other` and names the title. */
async function showWithAnother(page: Page, other: string, title?: string): Promise<void> {
  await page.getByTestId('section-games').click();
  await gameRow(page, 'demo').getByTestId('show-with-another').click();
  const form = page.getByTestId('title-form');
  await form.getByTestId('title-choice').filter({ hasText: other }).click();
  // The first game's title is offered; another can be typed.
  await expect(form.getByTestId('title-name')).toHaveValue('Atlas demo world');
  if (title) await form.getByTestId('title-name').fill(title);
}

test.describe('in Games', () => {
  test.use({ layout: 'standard' });

  test('two games are shown under one title, with the maps of each, and separately again', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await serveGames(page, [SECOND, WIKI], 'First map site');
    await page.goto('./');
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');

    await showWithAnother(page, 'Atlas Demo World!', 'The Sundered Isle');
    const form = page.getByTestId('title-form');
    await expect(form).toContainText(
      'Each source stays a whole game: found marks, lists, locations, notes and progress stay with the source they were made on.',
    );
    await shot(page, '1-making-a-title');
    await form.getByTestId('title-save').click();

    // One row for the title, with its sources; the one shown is said.
    const title = page.getByTestId('title-row');
    await expect(title).toHaveCount(1);
    await expect(title.locator('.touch-row-title')).toHaveText('The Sundered Isle');
    await expect(title.getByTestId('title-sources')).toHaveText(
      'Sources: First map site, Second map site',
    );
    await expect(title.getByTestId('title-shown')).toHaveText('Shown: First map site');
    await expect(gameRow(page, 'demo')).toHaveCount(0);
    await expect(gameRow(page, 'isles-two')).toHaveCount(0);
    await expect(gameRow(page, 'isle-wiki')).toHaveCount(1);
    await stored(page, { 'The Sundered Isle': ['demo', 'isles-two'] });
    await reloadShown(page);
    await page.getByTestId('section-games').click();
    await expect(title.getByTestId('title-sources')).toHaveText(
      'Sources: First map site, Second map site',
    );
    await title.getByTestId('title-sources-toggle').click();
    await expect(title.getByTestId('title-source')).toHaveCount(2);
    await shot(page, '2-title-row-in-games');

    // The maps menu: the maps of each source under its name.
    await page.getByTestId('section-map').click();
    const chip = page.getByTestId('map-chip');
    await expect(chip.getByTestId('map-chip-source')).toHaveText('First map site ·');
    await chip.click();
    const menu = page.getByTestId('maps-menu');
    await expect(menu.locator('.touch-sheet-title')).toHaveText('Maps of The Sundered Isle');
    await expect(menu.getByTestId('maps-menu-source')).toHaveText([
      'First map site · shown',
      'Second map site',
    ]);
    await shot(page, '3-maps-menu-two-sources');
    // A map of the other source shows that source, at that map.
    await menu
      .locator('div')
      .filter({ has: page.locator('[data-testid="maps-menu-source"][data-pack="isles-two"]') })
      .getByRole('button', { name: 'The Hollow Deep' })
      .click();
    await expect(chip).toContainText('Second map site · The Hollow Deep');
    await expect(page.getByTestId('marker-count')).not.toHaveText('');

    // Another game shown, then the title: the source shown last opens.
    await page.getByTestId('section-games').click();
    await expect(title.getByTestId('title-shown')).toHaveText('Shown: Second map site');
    await gameRow(page, 'isle-wiki').locator('.touch-game-main').click();
    // A game of pages opens on its Guides.
    await expect(page.getByTestId('section-guides')).toHaveAttribute('aria-current', /page|true/);
    await page.getByTestId('section-games').click();
    await expect(gameRow(page, 'isle-wiki')).toHaveAttribute('data-current', 'true');
    await expect(title).toHaveAttribute('data-current', 'false');
    const groupId = (await title.getAttribute('data-group'))!;
    await expect
      .poll(() => storedSetting(page, 'gameGroupsLast'))
      .toMatchObject({ [groupId]: 'isles-two' });
    await title.locator('.touch-game-main').click();
    await expect(title.getByTestId('title-shown')).toHaveText('Shown: Second map site');

    // Show separately again: two games, as before, and nothing lost; Undo is offered.
    await title.getByTestId('title-sources-toggle').click();
    await title.getByTestId('title-separate').click();
    await expect(page.getByTestId('title-row')).toHaveCount(0);
    await expect(gameRow(page, 'demo')).toHaveCount(1);
    await expect(gameRow(page, 'isles-two')).toHaveAttribute('data-current', 'true');
    await stored(page, {});
    await shot(page, '6-shown-separately-again');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId('title-row')).toHaveCount(1);
    await stored(page, { 'The Sundered Isle': ['demo', 'isles-two'] });
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });

  test('a wiki under the title shows its pages in Guides for every source', async ({ page }) => {
    const errors = collectErrors(page);
    await serveGames(page, [SECOND, WIKI]);
    await page.goto('./');
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    await showWithAnother(page, 'Isle Wiki');
    await page.getByTestId('title-save').click();
    await expect(page.getByTestId('title-row')).toHaveCount(1);
    // A third game joins the title from its sources.
    const title = page.getByTestId('title-row');
    await title.getByTestId('title-sources-toggle').click();
    await title.getByTestId('title-add').click();
    await title.getByTestId('title-choice').filter({ hasText: 'Atlas Demo World!' }).click();
    await title.getByTestId('title-save').click();
    await expect(title.getByTestId('title-sources')).toHaveText(
      'Sources: Atlas demo world, Isle Wiki, Second map site',
    );
    await stored(page, { 'Atlas demo world': ['demo', 'isle-wiki', 'isles-two'] });

    // Guides: the wiki's pages, under its heading, said to come with the title.
    await page.getByTestId('section-guides').click();
    const sections = page.getByTestId('guides-contents').getByTestId('guides-section');
    await expect(sections).toHaveText([/Basics/, /The isle/, /Isle Wiki\s*6 pages/]);
    await expect(page.getByTestId('guides-from-game')).toHaveText(/Isle Wiki/);
    await expect(page.getByTestId('guides-from-title')).toHaveText('With this title');
    await shot(page, '4-guides-wiki-of-the-title');

    // The other source has them too: worked out when shown, never written.
    await page.getByTestId('section-map').click();
    await page.getByTestId('map-chip').click();
    await page
      .getByTestId('maps-menu')
      .getByRole('button', { name: 'The Sundered Isle' })
      .last()
      .click();
    await expect(page.getByTestId('map-chip')).toContainText('Second map site');
    await page.getByTestId('section-guides').click();
    await expect(sections).toHaveText([/Basics/, /The isle/, /Isle Wiki\s*6 pages/]);
    expect(await storedSetting(page, 'guideLinks:isles-two')).toBeUndefined();

    // The wiki itself: the maps of its title, a tap away.
    await page.getByTestId('section-games').click();
    await title.getByTestId('title-sources-toggle').click();
    await title
      .locator('[data-testid="title-source"][data-pack="isle-wiki"]')
      .getByTestId('title-source-open')
      .click();
    await page.getByTestId('section-guides').click();
    const maps = page.getByTestId('title-maps');
    await expect(maps).toContainText('Maps of Atlas demo world');
    await maps.getByTestId('title-maps-show').first().click();
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');

    // Taking the wiki out leaves the other two under the title, and Guides without its pages.
    await page.getByTestId('section-games').click();
    await title.getByTestId('title-sources-toggle').click();
    await title
      .locator('[data-testid="title-source"][data-pack="isle-wiki"]')
      .getByTestId('title-source-out')
      .click();
    await expect(title.getByTestId('title-sources')).toHaveText(
      'Sources: Atlas demo world, Second map site',
    );
    await expect(gameRow(page, 'isle-wiki')).toHaveCount(1);
    await stored(page, { 'Atlas demo world': ['demo', 'isles-two'] });
    await reloadShown(page);
    await page.getByTestId('section-guides').click();
    await expect(sections).toHaveText([/Basics/, /The isle/]);
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });

  test('at phone size, the title is one row with its sources', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = collectErrors(page);
    await serveGames(page, [SECOND], 'First map site');
    await page.goto('./');
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    await showWithAnother(page, 'Atlas Demo World!');
    await page.getByTestId('title-save').click();
    const title = page.getByTestId('title-row');
    await expect(title.getByTestId('title-sources')).toHaveText(
      'Sources: First map site, Second map site',
    );
    await title.getByTestId('title-sources-toggle').click();
    await expect(title.getByTestId('title-panel')).toBeVisible();
    // Nothing wider than the screen.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    // In the light theme, as a phone set to it would show it.
    await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await title.getByTestId('title-panel').scrollIntoViewIfNeeded();
    await shot(page, '8-phone-games-light');
    // The keyboard reaches the title's buttons in order.
    await title.getByTestId('title-separate').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('title-row')).toHaveCount(0);
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });
});

test.describe('in the Library', () => {
  test('a title is one row, opens its source, and a game of it still opens in the classic layout', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await serveGames(page, [SECOND], 'First map site');
    await setUp(page);
    await page.getByTestId('maps-button').click();
    const library = page.getByTestId('library');
    await library.locator('[data-testid="library-game"][data-pack="demo"]').click();
    const pane = page.getByTestId('library-game-pane');
    await pane.getByTestId('library-more').click();
    await page.getByTestId('library-more-menu').getByTestId('show-with-another').click();
    const form = pane.getByTestId('title-form');
    await expect(form.getByTestId('title-name')).toHaveValue('Atlas demo world');
    await form.getByTestId('title-save').click();

    const row = library.getByTestId('library-title');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Atlas demo world');
    await expect(row.getByTestId('title-sources')).toHaveText(
      'Sources: First map site, Second map site',
    );
    await expect(library.getByTestId('library-game')).toHaveCount(0);
    const card = pane.getByTestId('library-title-card');
    await expect(card).toContainText('One title: Atlas demo world');
    await shot(page, '2-title-row-in-library');

    // Its other source opens in the pane; showing it switches the game.
    await card
      .locator('[data-testid="title-source"][data-pack="isles-two"]')
      .getByTestId('title-source-open')
      .click();
    await expect(pane).toHaveAttribute('data-pack', 'isles-two');
    await page.keyboard.press('Escape');
    await expect(library).toBeHidden();
    // The classic layout has no title row: the game is there under its own title, and opens.
    await page.getByLabel('Game').selectOption('isles-two');
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    expect(realErrors(errors)).toEqual([]);
  });

  test('adding a game of the same title offers, once, to show them under one title', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await serveGames(page, [{ id: 'hills-before', title: 'Test hills' }]);
    await setUp(page);
    await paste(page, url('test-hills', 'high-pass'));
    await page.getByTestId('add-map-start').click();
    await expect(page.getByTestId('library-flow')).toHaveAttribute('data-phase', 'done');
    expect((await mock(page)).reports.map((r) => r.outcome)).toEqual(['added']);
    const offer = page.getByTestId('title-offer');
    if (!DOWNLOADS_BUILD) {
      // The viewer has no Importer: it never offers.
      await expect(offer).toHaveCount(0);
      expect(await storedSetting(page, 'gameGroups')).toBeUndefined();
      expect(realErrors(errors)).toEqual([]);
      return;
    }
    await expect(offer).toHaveAttribute('data-pack', 'test-hills');
    await expect(offer).toContainText('Test Hills has the same title as Test hills, already here');
    await expect(offer.getByTestId('title-offer-name')).toHaveValue('Test hills');
    await shot(page, '7-importer-offer');
    await offer.getByTestId('title-offer-accept').click();
    await expect(offer).toHaveCount(0);
    await stored(page, { 'Test hills': ['hills-before', 'test-hills'] });
    await page.getByTestId('add-map-done').click();
    await expect(
      page.getByTestId('library').getByTestId('library-title').filter({ hasText: 'Test hills' }),
    ).toHaveCount(1);
    // Asked once: adding to it again does not ask again.
    expect(await storedSetting(page, 'gameGroupsAsked')).toEqual(
      expect.arrayContaining(['test-hills']),
    );
    expect(realErrors(errors)).toEqual([]);
  });
});
