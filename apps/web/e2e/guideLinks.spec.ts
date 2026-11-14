import { devices, type Page, type Route } from '@playwright/test';
import { collectErrors, demoLocations, reloadSaved } from './helpers';
import { expect, test } from './layout';
import { choosePlace } from './touch';

/**
 * Guide pages linked to the map, in the standard layout: the demo pack's
 * made-up wiki compared by name with its map (Waystones is sure, a type;
 * Stone wardens is sure, a location name; Wolves is unsure, only near
 * "Wolf den"; Regions and the others have no match), reviewed and
 * confirmed; "From the wiki" on a location's card; "Show on the map" on a
 * page; a guide linked in a step of one's own list; the choices kept after
 * a reload; and the pages of another game (a wiki with no map) read with
 * the demo's map.
 */

test.use({ layout: 'standard' });

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

const row = (page: Page, title: string) =>
  page
    .getByTestId('link-row')
    .filter({ has: page.locator('.guide-links-page', { hasText: title }) });

async function openReview(page: Page): Promise<void> {
  await page.getByTestId('section-guides').click();
  await page.getByTestId('open-guide-links').click();
  await expect(page.getByTestId('guide-links')).toBeVisible();
}

async function saved(page: Page): Promise<void> {
  await expect(page.getByTestId('guide-links-status')).toContainText('Saved');
  await expect(page.locator('html')).toHaveAttribute('data-saving', 'false');
}

/** Confirms the sure pages and the unsure Wolves, and skips Regions. */
async function linkDemoPages(page: Page): Promise<void> {
  await openReview(page);
  await page.getByTestId('link-confirm-all').click();
  await row(page, 'Wolves').getByTestId('link-confirm').click();
  await row(page, 'Regions').getByTestId('link-skip').click();
  await saved(page);
}

test.describe('on a computer', () => {
  test('sorts the pages into sure, unsure and no match, and links only what is confirmed', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await openReview(page);
    const titles = (group: string) =>
      page.getByTestId(group).locator('.guide-links-page').allInnerTexts();
    expect(await titles('links-sure')).toEqual(['Waystones', 'Stone wardens']);
    expect(await titles('links-unsure')).toEqual(['Wolves']);
    expect(await titles('links-none')).toEqual([
      'Welcome to the Sundered Isle',
      'Getting around',
      'Regions',
      'Blades',
      'Ember blade',
      'Stonebreaker maul',
      'Tidecaller charm',
    ]);
    await expect(page.getByTestId('links-done')).toHaveCount(0);
    // Each row says what it would link to, and how many locations.
    await expect(row(page, 'Waystones').getByTestId('link-target-text')).toHaveText(
      /Waystone \(type\) · 120 locations/,
    );
    await expect(row(page, 'Stone wardens').getByTestId('link-target-text')).toHaveText(
      /Stone warden \(location name\) · 128 locations/,
    );
    await expect(row(page, 'Wolves').getByTestId('link-target-text')).toHaveText(
      /Wolf den \(location name\) · 149 locations/,
    );

    // Nothing is linked yet: a page says so.
    await row(page, 'Waystones').locator('.guide-links-page').click();
    await expect(page.getByTestId('guides-on-map')).toHaveText(/Not linked to the map/);
    await page.getByTestId('guides-back').click();

    // Confirm all sure.
    await page.getByTestId('link-confirm-all').click();
    await expect(page.getByTestId('links-sure')).toHaveCount(0);
    expect(await titles('links-done')).toEqual(['Waystones', 'Stone wardens']);
    await expect(row(page, 'Waystones')).toHaveAttribute('data-group', 'linked');

    // Change: another target, found by name. Getting around goes with Thornwood.
    await row(page, 'Getting around').getByTestId('link-change').click();
    await page.getByTestId('link-finder-input').fill('thornw');
    await page.getByTestId('link-hit').filter({ hasText: 'Thornwood (region)' }).click();
    await expect(row(page, 'Getting around').getByTestId('link-target-text')).toHaveText(
      /Linked to Thornwood \(region\)/,
    );
    // Skip, and Undo.
    await row(page, 'Regions').getByTestId('link-skip').click();
    await expect(row(page, 'Regions')).toHaveAttribute('data-group', 'skipped');
    await row(page, 'Welcome to the Sundered Isle').getByTestId('link-skip').click();
    await row(page, 'Welcome to the Sundered Isle').getByTestId('link-undo').click();
    await expect(row(page, 'Welcome to the Sundered Isle')).toHaveAttribute('data-group', 'none');
    // Wolves stays unsure and unlinked: it was never confirmed.
    await expect(row(page, 'Wolves')).toHaveAttribute('data-group', 'unsure');
    await saved(page);
    await expect(page.getByTestId('guide-links-status')).toContainText(
      '3 pages linked · 1 skipped',
    );
    expect(errors).toEqual([]);
  });

  test('shows a linked page on a location’s card, and the page’s locations on the map', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await linkDemoPages(page);

    // From the wiki, on the card of a waystone: the page of its type.
    await page.getByTestId('section-map').click();
    await choosePlace(page, 'Thornwood waystone 1');
    const wiki = page.getByTestId('from-the-wiki');
    await expect(wiki).toContainText('From the wiki');
    await expect(wiki.locator('.place-wiki-title')).toHaveText(
      'Waystones · about the type Waystone',
    );
    await expect(wiki.locator('.place-wiki-text')).toContainText('Waystones are standing stones');
    // Hidden text is left out of the first lines.
    await expect(wiki).not.toContainText('under the lake');
    await expect(page.getByTestId('from-the-wiki-credit')).toHaveText(
      'From “Waystones” on Example Wiki · CC BY-SA 4.0 · By the contributors of the Example Wiki',
    );
    // A location of its own name's page: that page first.
    await choosePlace(page, 'Stone warden 1');
    await expect(wiki.locator('.place-wiki-title')).toHaveText(
      'Stone wardens · about this location',
    );
    // The full page, in Guides.
    await page.getByTestId('read-wiki-page').click();
    await expect(page.getByTestId('guides-page').locator('h1')).toHaveText('Stone wardens');
    await expect(page.getByTestId('place-sheet')).toHaveCount(0);

    // On the map: the page's locations, alone, until the chip is pressed.
    const onMap = page.getByTestId('guides-on-map');
    await expect(onMap).toContainText('On the map: 128 locations');
    await onMap.getByTestId('show-page-on-map').click();
    await expect(page.locator('.touch')).toHaveAttribute('data-section', 'map');
    // Those on the map shown: the wardens of the surface (the others are in the caves).
    const surface = (await demoLocations(page.request)).filter(
      (l) => l.name.startsWith('Stone warden ') && l.layerId === 'demo:layer:surface',
    );
    await expect(page.getByTestId('marker-count')).toHaveText(String(surface.length));
    const chip = page.getByTestId('page-only-chip');
    await expect(chip).toContainText('Only Stone wardens');
    await chip.click();
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    await expect(chip).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('keeps the choices after a reload', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await linkDemoPages(page);
    await reloadSaved(page);
    await openReview(page);
    await expect(page.getByTestId('guide-links-status')).toContainText(
      '3 pages linked · 1 skipped',
    );
    await expect(row(page, 'Waystones')).toHaveAttribute('data-group', 'linked');
    await expect(row(page, 'Wolves')).toHaveAttribute('data-group', 'linked');
    await expect(row(page, 'Regions')).toHaveAttribute('data-group', 'skipped');
    await page.getByTestId('section-map').click();
    await choosePlace(page, 'Thornwood waystone 1');
    await expect(page.getByTestId('from-the-wiki')).toContainText('Waystones');
    expect(errors).toEqual([]);
  });

  test('links a guide page in a step of one’s own list, which opens it in Guides', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await page.getByTestId('section-lists').click();
    await page.getByTestId('new-own-list').click();
    await page.getByTestId('own-list-name').fill('Wolf hunt');
    await page.getByTestId('template-dialog').getByTestId('template-build').click();
    await page.getByTestId('template-dialog').getByTestId('template-start').click();
    await expect(page.getByTestId('list-editor')).toBeVisible();
    if ((await page.getByTestId('add-panel').count()) === 0) {
      await page.getByTestId('editor-add').click();
    }
    await page.getByTestId('add-tab-search').click();
    await page.getByTestId('add-search-input').fill('Wolf den 1');
    await page.getByRole('button', { name: 'Add Wolf den 1', exact: true }).click();
    await page
      .getByTestId('editor-rows')
      .getByTestId('editor-row')
      .first()
      .locator('.editor-row-main')
      .click();

    const note = page.getByTestId('step-note');
    await note.fill('Read up first: ');
    await note.press('End');
    await page.getByTestId('note-link-guide').click();
    await page.getByTestId('guide-finder-input').fill('wolves');
    await expect(page.getByTestId('guide-hit').first()).toContainText('Foes');
    await page.getByTestId('guide-hit').first().click();
    await expect(note).toHaveValue('Read up first: [Wolves](demo:guide:wiki-wolves)');
    await expect(page.locator('.editor-note-shown .app-link')).toHaveText('Wolves');

    // Used: the link opens the page in Guides.
    await page.getByTestId('editor-done').click();
    await expect(page.getByTestId('list-editor')).toHaveCount(0);
    const entry = page.getByTestId('check-item').first();
    await entry.getByTestId('entry-more').click();
    await entry.getByTestId('entry-more-body').locator('.app-link').click();
    await expect(page.locator('.touch')).toHaveAttribute('data-section', 'guides');
    await expect(page.getByTestId('guides-page').locator('h1')).toHaveText('Wolves');
    expect(errors).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ ...pixel });

  test('uses the links, and leaves the linking to a larger screen', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    await page.evaluate(async () => {
      // Links made on a larger screen, as they are kept on this device.
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
      tx.objectStore('settings').put({
        key: 'guideLinks:demo',
        value: JSON.stringify({
          format: 'atlas-guide-links',
          version: 1,
          gameId: 'demo',
          updatedAt: '2026-11-13T10:00:00.000Z',
          guidesFrom: [],
          choices: {
            'demo:guide:wiki-waystones': {
              state: 'linked',
              targets: [{ to: 'type', id: 'demo:cat:waystone' }],
            },
          },
        }),
      });
      await new Promise((resolve) => {
        tx.oncomplete = resolve;
      });
      db.close();
    });
    await page.reload();
    await page.getByTestId('section-guides').click();
    await page.getByTestId('open-guide-links').click();
    await expect(page.getByTestId('guide-links-phone-note')).toContainText('larger screen');
    await expect(page.getByTestId('link-row')).toHaveCount(0);

    await page.getByTestId('section-map').click();
    await choosePlace(page, 'Thornwood waystone 1');
    await page.getByTestId('place-details-row').click();
    await expect(page.getByTestId('from-the-wiki')).toContainText('Waystones');
    await page.getByTestId('read-wiki-page').click();
    await expect(page.getByTestId('guides-page').locator('h1')).toHaveText('Waystones');
    await expect(page.getByTestId('guides-on-map')).toContainText('On the map: 120 locations');
    expect(errors).toEqual([]);
  });
});

/**
 * Another game on the device with the demo wiki's pages and no map, as a
 * wiki read with an importer would be: ids of its own (`isle-wiki:`).
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
      const all = value as { id: string; title: string }[];
      return route.fulfill({
        json: all
          .filter((g) => g.id.startsWith('isle-wiki:guide:wiki-'))
          .map((g) => (g.title === 'Wolves' ? { ...g, title: 'Wolf dens' } : g)),
      });
    }
    return route.fulfill({ json: value });
  });
}

test.describe('the pages of another game', () => {
  test('are read with the map, linked, and kept after a reload', async ({ page }) => {
    const errors = collectErrors(page);
    await serveTwoGames(page);
    await page.goto('./');
    await page.getByTestId('section-guides').click();
    await page.getByTestId('add-guides-from').click();
    await page.getByTestId('guides-from-choice').filter({ hasText: 'Isle Wiki' }).click();
    await expect(page.getByTestId('guides-from-game')).toHaveText(/Isle Wiki/);
    // Its contents, under its own heading, and its pages read here.
    const sections = page.getByTestId('guides-contents').getByTestId('guides-section');
    await expect(sections).toHaveText([/Basics/, /The isle/, /Gear/, /Isle Wiki\s*10 pages/]);
    await sections.filter({ hasText: 'Isle Wiki' }).click();
    await page.getByTestId('guides-section').filter({ hasText: 'The isle' }).click();
    await page.getByTestId('guides-section').filter({ hasText: 'Foes' }).click();
    await page.getByTestId('guides-page-link').filter({ hasText: 'Wolf dens' }).click();
    await expect(page.getByTestId('guides-page').locator('h1')).toHaveText('Wolf dens');
    await expect(page.locator('.guides-crumbs')).toHaveText(/Isle Wiki\s*›\s*The isle\s*›\s*Foes/);
    // A link between its pages stays among them.
    await page.getByTestId('guides-page').locator('.app-link').first().click();
    await expect(page.getByTestId('guides-page')).toHaveAttribute(
      'data-guide',
      'isle-wiki:guide:wiki-travel',
    );

    // Linked to the demo's map: Wolf dens is a sure match now.
    await page.locator('.guides-crumbs').getByRole('button', { name: 'Contents' }).click();
    await page.getByTestId('open-guide-links').click();
    const wolfDens = row(page, 'Wolf dens');
    await expect(wolfDens).toHaveAttribute('data-guide', 'isle-wiki:guide:wiki-wolves');
    await expect(wolfDens).toHaveAttribute('data-group', 'sure');
    await wolfDens.getByTestId('link-confirm').click();
    await saved(page);

    await reloadSaved(page);
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    await choosePlace(page, 'Wolf den 1');
    await expect(page.getByTestId('from-the-wiki').locator('.place-wiki-title')).toHaveText(
      'Wolf dens · about this location',
    );
    await page.getByTestId('read-wiki-page').click();
    await expect(page.getByTestId('guides-page')).toHaveAttribute(
      'data-guide',
      'isle-wiki:guide:wiki-wolves',
    );
    await expect(page.getByTestId('guides-credit')).toContainText('Example Wiki');
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });
});
