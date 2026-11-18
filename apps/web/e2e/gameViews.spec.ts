import { mkdir } from 'node:fs/promises';
import { devices, type Locator, type Page } from '@playwright/test';
import { collectErrors, storedSetting } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, realErrors, setUp } from './fakeShell';

/**
 * How Games and the Library list many games: as cards or compact rows,
 * found by a name or a tag typed, and grouped under the tags of one group
 * (Source and Contents, which the app fills in, System, Genre and the
 * person's own), with headings that fold; and a game's tags, chosen in
 * "Tags…". Every game here is made up: the Library's are listed by the
 * stand-in shell, the phone's are the demo world listed under other names.
 */

const SHOTS = process.env.ATLAS_VIEWS_SHOTS ?? 'test-results/game-views';

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' });

interface Made {
  id: string;
  title: string;
  importer?: string;
  madeInApp?: boolean;
  system?: string;
  genre?: string[];
}

const SYSTEMS = ['Tern 16', 'Heron 64', 'Kestrel Duo', 'Wren Pocket'];
const GENRES = ['Puzzle', 'Racing', 'Adventure', 'Farming'];
const IMPORTERS = ['Reed Archive', 'Lantern Maps', 'Fern Atlas'];
const NAMES = [
  'Emberfall',
  'Saltmarsh',
  'Glasswing',
  'Mossgate',
  'Brindle Hollow',
  'Cinderwell',
  'Driftmoss',
  'Eelgrass Bay',
  'Flintcap',
  'Gorsebright',
  'Hazelrook',
  'Inkwater',
  'Jackdaw Mill',
  'Kelpie Run',
  'Lichenfold',
  'Mirefoot',
  'Nimbleweed',
  'Owlbarrow',
  'Pipwhistle',
  'Quarrystone',
  'Reedbank',
  'Slatehook',
  'Tumblecress',
  'Underbough',
  'Vetchmoor',
  'Whelkstone',
  'Yewcastle',
  'Brambleshore',
  'Clovergate',
  'Dunlin Point',
  'Ironbell',
  'Juniper Deep',
  'Kettlewhist',
  'Larkspur Run',
  'Marrowby',
  'Sablecrest',
  'Tidewrack',
  'Umberlight',
  'Willowmere',
  'Yarrowdale',
  'Zephyr Reach',
  'Hollowpine',
  'Gannet Rock',
  'Puffin Steps',
];

/** The made-up games: a system for most, a genre or two, from three made-up importers or made here. */
const GAMES: Made[] = NAMES.map((title, i) => ({
  id: title.toLowerCase().replaceAll(' ', '-'),
  title,
  ...(i % 9 === 4 ? { madeInApp: true } : { importer: IMPORTERS[i % 3]! }),
  ...(i % 7 === 6 ? {} : { system: SYSTEMS[i % 4]! }),
  genre: i % 5 === 0 ? [GENRES[i % 4]!, GENRES[(i + 1) % 4]!] : [GENRES[(i * 3) % 4]!],
}));

const count = (pick: (game: Made) => boolean) => GAMES.filter(pick).length;

/** A game as the shell lists a pack in the maps folder. */
const listedGame = (game: Made, base: string) => ({
  id: game.id,
  title: game.title,
  url: new URL(`packs/${game.id}/`, base).href,
  origin: 'maps-folder',
  path: `/maps/${game.id}`,
  packVersion: '1.0.0',
  bundled: false,
  madeInApp: game.madeInApp === true,
  imported: game.importer
    ? { importerId: game.importer.toLowerCase().replaceAll(' ', '-'), importerTitle: game.importer }
    : null,
  pages: [],
});

/** The tags of the made-up games as they are kept, with a group of one's own. */
const TAGS = {
  version: 1,
  groups: [{ id: 'own-status', name: 'Status' }],
  tags: Object.fromEntries(
    GAMES.map((game, i) => [
      `game:${game.id}`,
      {
        system: game.system ? [game.system] : [],
        genre: game.genre ?? [],
        ...(i % 6 === 0 ? { 'own-status': ['Finished'] } : {}),
      },
    ]),
  ),
};

/** Puts settings as they are kept on this device, then shows the app with them. */
async function putSettings(page: Page, settings: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (entries) => {
    const open = indexedDB.open('atlas');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => {
        resolve(open.result);
      };
      open.onerror = () => {
        reject(new Error(String(open.error)));
      };
    });
    const tx = db.transaction('settings', 'readwrite');
    for (const [key, value] of Object.entries(entries))
      tx.objectStore('settings').put({ key, value });
    await new Promise((resolve) => {
      tx.oncomplete = resolve;
    });
    db.close();
  }, settings);
  await page.reload();
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
}

/** Waits until the settings are saved, so a reload keeps them. */
async function saved(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-saving', 'false');
}

const headings = (scope: Locator) => scope.getByTestId('games-heading');

/** The headings' names in order, and the count each says. */
async function headingTexts(scope: Locator): Promise<string[]> {
  return Promise.all(
    (await headings(scope).all()).map(async (heading) => {
      const name = await heading.locator('.games-heading-name').textContent();
      const n = await heading.getByTestId('games-heading-count').textContent();
      return `${name ?? ''} ${n ?? ''}`;
    }),
  );
}

test.describe('the Library', () => {
  test.use({ deviceScaleFactor: 2 });

  test('lists many games as cards or compact rows, found and grouped by their tags', async ({
    page,
    baseURL,
  }) => {
    const errors = collectErrors(page);
    await setUp(page, DOWNLOADS_BUILD, {
      listed: GAMES.map((game) => listedGame(game, baseURL ?? '')),
    });
    await putSettings(page, { gameTags: TAGS, theme: 'light' });
    await page.getByTestId('maps-button').click();
    const library = page.getByTestId('library');
    const list = library.getByTestId('library-games');
    await expect(list).toHaveAttribute('data-view', 'cards');
    // The cards, as before, each with its tags.
    const ember = list.locator('[data-testid="library-game"][data-pack="emberfall"]');
    await expect(ember.getByTestId('game-tag')).toHaveText([
      'Tern 16',
      'Puzzle',
      'Racing',
      'Finished',
    ]);

    // Group by: Source and Contents first, then System, Genre and one's own.
    const groupBy = library.getByTestId('games-group-by');
    await expect(groupBy.locator('option')).toHaveText([
      'None',
      'Source',
      'Contents',
      'System',
      'Genre',
      'Status',
    ]);
    await groupBy.selectOption({ label: 'System' });
    const names = await headingTexts(list);
    expect(names).toEqual([
      ...[...SYSTEMS]
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
        .map((system) => `${system} ${count((game) => game.system === system)}`),
      `No system ${count((game) => !game.system) + 1}`,
    ]);
    // Under its heading, a game's system is not said again.
    await expect(ember.getByTestId('game-tag')).toHaveText(['Puzzle', 'Racing', 'Finished']);
    await shot(page, '1-library-cards-grouped-by-system');

    // The compact view: one short row each, with More.
    await library.getByTestId('games-view-compact').click();
    await expect(list).toHaveAttribute('data-view', 'compact');
    const row = list.locator('[data-testid="library-game"][data-pack="emberfall"]');
    await expect(row.getByTestId('library-compact-line')).toHaveText(
      `${GAMES[0]!.importer!} · 2 maps, 1 guide`,
    );
    const height = (await row.boundingBox())?.height ?? 0;
    expect(height).toBeLessThanOrEqual(48);

    // Grouped by genre: a game with two genres stands under both; a heading folds.
    await groupBy.selectOption({ label: 'Genre' });
    for (const genre of GENRES) {
      await expect(list.locator(`[data-heading="genre:${genre.toLowerCase()}"]`)).toHaveAttribute(
        'data-open',
        'true',
      );
    }
    await expect(list.locator('[data-heading="genre:racing"] [data-pack="emberfall"]')).toHaveCount(
      1,
    );
    await expect(list.locator('[data-heading="genre:puzzle"] [data-pack="emberfall"]')).toHaveCount(
      1,
    );
    const racing = list.locator('[data-heading="genre:racing"]');
    await racing.getByTestId('games-heading').click();
    await expect(racing).toHaveAttribute('data-open', 'false');
    await expect(racing.getByTestId('games-heading')).toHaveAttribute('aria-expanded', 'false');
    await expect(racing.getByTestId('games-heading')).toHaveAccessibleName(
      `Racing, ${count((game) => game.genre?.includes('Racing') === true)} games`,
    );
    await expect(racing.getByTestId('library-game')).toHaveCount(0);
    await shot(page, '2-library-compact-grouped-by-genre-one-folded');

    // Kept on this device: the view, the grouping and the heading folded.
    await saved(page);
    await page.reload();
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    await page.getByTestId('maps-button').click();
    await expect(list).toHaveAttribute('data-view', 'compact');
    await expect(groupBy).toHaveValue('genre');
    await expect(racing).toHaveAttribute('data-open', 'false');

    // Source, filled in by the app: the importer, or made here.
    await groupBy.selectOption({ label: 'Source' });
    expect(await headingTexts(list)).toEqual([
      'Comes with the app 1',
      `Fern Atlas ${count((game) => game.importer === 'Fern Atlas')}`,
      `Lantern Maps ${count((game) => game.importer === 'Lantern Maps')}`,
      `Made in Atlas ${count((game) => game.madeInApp === true)}`,
      `Reed Archive ${count((game) => game.importer === 'Reed Archive')}`,
    ]);

    // Ungrouped, in the order of before.
    await groupBy.selectOption('none');
    await expect(list.getByTestId('games-heading')).toHaveCount(0);
    await expect(list.locator('.library-compact')).toHaveCount(GAMES.length + 1);
    await shot(page, '3-library-compact-ungrouped');

    // Found by a name, or by a tag.
    const filter = library.getByTestId('games-filter');
    await filter.fill('moss');
    await expect(list.locator('.library-compact')).toHaveCount(2);
    await expect(library.getByTestId('games-found')).toHaveText(`2 of ${GAMES.length + 1} games.`);
    await filter.fill('wren');
    await expect(list.locator('.library-compact')).toHaveCount(
      count((game) => game.system === 'Wren Pocket'),
    );
    await filter.fill('nothing like it');
    await expect(library.getByTestId('games-found')).toHaveText(
      'No game has a name or a tag with “nothing like it”.',
    );
    await filter.fill('');

    // More on a row opens the game with its menu, the focus on its first row; Tags… is there.
    await list.getByRole('button', { name: 'More for Emberfall' }).click();
    await expect(page.getByTestId('library-game-pane')).toHaveAttribute('data-pack', 'emberfall');
    const menu = page.getByTestId('library-more-menu');
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await menu.getByTestId('game-tags').click();
    const dialog = page.getByTestId('tags-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Tags of Emberfall' })).toBeVisible();
    const system = dialog.locator('[data-group="system"]');
    await expect(system.getByLabel('Tern 16')).toBeChecked();
    await system.getByLabel('Heron 64').check();
    const genre = dialog.locator('[data-group="genre"]');
    await genre.getByLabel('New tag in Genre').fill('cozy');
    await genre.getByTestId('tags-new-add').click();
    await expect(genre.getByLabel('cozy')).toBeChecked();
    await shot(page, '4-tags-dialog');
    await dialog.getByTestId('tags-save').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('toast')).toContainText('The tags of Emberfall are saved.');
    await expect(page.getByTestId('library-game-pane').getByTestId('game-tag')).toHaveText([
      'Heron 64',
      'Tern 16',
      'cozy',
      'Puzzle',
      'Racing',
      'Finished',
    ]);
    // Two chips on the compact row, and how many more.
    const rowItem = list
      .locator('li.library-compact')
      .filter({ has: page.locator('[data-pack="emberfall"]') });
    await expect(rowItem.getByTestId('game-tag')).toHaveText(['Heron 64', 'Tern 16']);
    await expect(rowItem.locator('.game-tag-more')).toHaveText('+4');
    await saved(page);
    const kept = (await storedSetting(page, 'gameTags')) as typeof TAGS;
    expect(kept.tags['game:emberfall']).toEqual({
      system: ['Heron 64', 'Tern 16'],
      genre: ['cozy', 'Puzzle', 'Racing'],
      'own-status': ['Finished'],
    });

    // A group of one's own: added, renamed, removed after asking, its tags with it.
    await page.getByTestId('library-more').click();
    await menu.getByTestId('game-tags').click();
    await dialog.getByTestId('tags-add-group').click();
    await dialog.getByLabel('Name of the new group').fill('genre');
    await dialog.getByTestId('tags-group-save').click();
    await expect(dialog.getByRole('alert')).toHaveText('There is a group named genre already.');
    await dialog.getByLabel('Name of the new group').fill('Mood');
    await dialog.getByTestId('tags-group-save').click();
    const status = dialog.locator('[data-group="own-status"]');
    await status.getByTestId('tags-group-rename').click();
    await status.getByLabel('New name of the group Status').fill('Progress');
    await status.getByTestId('tags-group-save').click();
    await expect(status.locator('legend')).toHaveText('Progress');
    await status.getByTestId('tags-group-remove').click();
    await expect(status).toContainText('Its tags are taken off every game.');
    await status.getByTestId('tags-group-remove-confirm').click();
    await expect(status).toHaveCount(0);
    await expect(dialog.locator('legend')).toHaveText(['System', 'Genre', 'Mood']);
    await dialog.getByTestId('tags-cancel').click();
    await expect(groupBy.locator('option')).toHaveText([
      'None',
      'Source',
      'Contents',
      'System',
      'Genre',
      'Mood',
    ]);
    await expect(rowItem.locator('.game-tag-more')).toHaveText('+3');
    expect(realErrors(errors)).toEqual([]);
  });
});

test.describe('Games on a phone', () => {
  const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];
  test.use({ ...pixel, deviceScaleFactor: 2, layout: null });

  test('the compact view is a dense list with touch targets of 44 px, grouped by system', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.route('**/packs/index.json', (route) =>
      route.fulfill({
        json: {
          packs: [
            { id: 'demo', url: 'packs/demo/', title: 'Atlas demo world' },
            ...GAMES.map((game) => ({ id: game.id, url: 'packs/demo/', title: game.title })),
          ],
        },
      }),
    );
    await page.goto('./?ui=touch');
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    await putSettings(page, {
      gameTags: TAGS,
      theme: 'light',
      gamesList: { view: 'compact', groupBy: 'system', folded: [] },
    });
    await page.getByTestId('section-games').tap();
    const games = page.getByTestId('games-screen');
    const list = games.getByTestId('touch-games');
    await expect(list).toHaveAttribute('data-view', 'compact');
    await expect(games.getByTestId('games-group-by')).toHaveValue('system');
    const row = list.locator('[data-testid="game-row"][data-pack="emberfall"]');
    await expect(row).toBeVisible();
    // Every row and its More are 44 px high at least; rows are far denser than cards.
    for (const target of [
      row.locator('.touch-compact-main'),
      row.getByTestId('game-compact-more'),
    ]) {
      expect((await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    expect((await row.boundingBox())?.height ?? 0).toBeLessThan(60);
    await shot(page, '5-phone-compact-grouped-by-system');

    // More shows what the card offers, Tags… among it.
    await row.getByRole('button', { name: 'More for Emberfall' }).tap();
    await row.getByTestId('game-tags-open').tap();
    const dialog = page.getByTestId('tags-dialog');
    await expect(dialog).toBeVisible();
    await shot(page, '6-phone-tags-dialog');
    await dialog.getByTestId('tags-cancel').tap();
    await expect(dialog).toBeHidden();

    // The dark theme.
    await games.getByRole('button', { name: 'Dark', exact: true }).tap();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await games.getByTestId('games-filter').scrollIntoViewIfNeeded();
    await games.getByTestId('games-group-by').selectOption('genre');
    await page.locator('.touch-page-body').evaluate((element) => {
      element.scrollTop = 0;
    });
    await shot(page, '7-phone-compact-grouped-by-genre-dark');
    expect(realErrors(errors)).toEqual([]);
  });
});
