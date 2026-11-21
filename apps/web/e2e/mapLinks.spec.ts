import { mkdir } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { collectErrors, openGuidesSection } from './helpers';
import { expect, test } from './layout';

/**
 * Links of a guide's pages to a location of a map (the manifest's
 * `mapLinks`): a made-up guide, a game of pages with no map, shown under
 * one title with the demo world. A link whose location the demo world has
 * is the app's own link and opens the map there, switching game from the
 * guide; one whose location no map has stays a web link. Nothing leaves
 * this computer: the guide's links name hosts under `example.org`, and a
 * link to the web is never followed.
 */

const SHOTS = process.env.ATLAS_MAP_LINK_SHOTS ?? 'test-results/map-links';

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

// Pictures for people to read: sharp on a screen of high density.
test.use({ deviceScaleFactor: 2, layout: 'standard' });

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' });

const GUIDE = 'isle-guide';
const PAGE_ID = `${GUIDE}:guide:chests`;

const BODY = [
  'Three chests of the isle, as the map of the guide shows them.',
  '',
  '- The [gilded chest](https://maps.example.org/isle/sundered?spot=2391) stands on the shore, past the first waystone.',
  '- The [iron-bound chest of the deep](https://maps.example.org/isle/hollow?spot=deep-0003) waits in the caves below.',
  '- The [chest of the old tower](https://maps.example.org/isle/sundered?spot=9999) is on no map you have yet.',
  '',
  'The guide’s [own map](https://maps.example.org/isle/sundered) shows every chest.',
].join('\n');

/** The made-up guide's files: a game of one page, whose links to the map site name its locations. */
const GUIDE_FILES: Record<string, unknown> = {
  'manifest.json': {
    schemaVersion: 2,
    gameId: GUIDE,
    title: 'Isle Guide',
    packVersion: '1.0.0',
    gamePatch: 'guide',
    attribution: [
      { name: 'Example Guides', url: 'https://guides.example.org/', license: 'CC BY-SA 4.0' },
    ],
    idMigrations: {},
    mapLinks: [{ hosts: ['maps.example.org'], address: '/isle/*', query: 'spot' }],
    contents: {
      counts: { maps: 0, layers: 0, locations: 0, categories: 0, regions: 0, guides: 1 },
      maps: [],
    },
  },
  'sections.json': [{ id: `${GUIDE}:section:chests`, title: 'Chests', items: [PAGE_ID] }],
  'pictures.json': [],
  'guides.json': [
    {
      id: PAGE_ID,
      title: 'Chests of the isle',
      body: BODY,
      locationIds: [],
      source: {
        url: 'https://guides.example.org/isle/chests',
        site: 'Example Guides',
        license: { name: 'CC BY-SA 4.0' },
        readAt: '2026-11-17',
      },
    },
  ],
};

/** Lists the demo world and the guide, and serves the guide's files. */
async function serveGuide(page: Page): Promise<void> {
  await page.route('**/packs/index.json', (route) =>
    route.fulfill({
      json: {
        packs: [
          { id: 'demo', url: 'packs/demo/', title: 'Atlas demo world' },
          { id: GUIDE, url: `packs/${GUIDE}/`, title: 'Isle Guide' },
        ],
      },
    }),
  );
  await page.route(`**/packs/${GUIDE}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.split(`/packs/${GUIDE}/`)[1] ?? '';
    const file = GUIDE_FILES[name];
    return file === undefined
      ? route.fulfill({ status: 404, body: 'not found' })
      : route.fulfill({ json: file });
  });
  // A link to the web is never followed here.
  await page.route('https://*.example.org/**', (route) => route.abort());
}

const gameRow = (page: Page, id: string) =>
  page.locator(`[data-testid="game-row"][data-pack="${id}"]`);

/** Shows the demo world and the guide under one title, from Games. */
async function oneTitle(page: Page): Promise<void> {
  await page.getByTestId('section-games').click();
  await gameRow(page, 'demo').getByTestId('show-with-another').click();
  const form = page.getByTestId('title-form');
  await form.getByTestId('title-choice').filter({ hasText: 'Isle Guide' }).click();
  await form.getByTestId('title-save').click();
  await expect(page.getByTestId('title-row')).toHaveCount(1);
}

/** Opens the guide, a source of the title, on its page of chests. */
async function openGuidePage(page: Page): Promise<void> {
  const title = page.getByTestId('title-row');
  await title.getByTestId('title-sources-toggle').click();
  await title
    .locator(`[data-testid="title-source"][data-pack="${GUIDE}"]`)
    .getByTestId('title-source-open')
    .click();
  await expect(page.getByTestId('section-guides')).toHaveAttribute('aria-current', /page|true/);
  await openGuidesSection(page, 'Chests');
  await page.getByTestId('guides-page-link').filter({ hasText: 'Chests of the isle' }).click();
  await expect(page.getByTestId('guides-page')).toContainText('Three chests of the isle');
}

/** The guide page's links: found ones are buttons of the app, the others links to the web. */
async function expectLinks(page: Page, other: boolean): Promise<void> {
  const shown = page.getByTestId('guides-page');
  const gilded = shown.getByRole('button', { name: 'gilded chest', exact: true });
  await expect(gilded).toHaveAttribute('data-atlas-target', 'demo:loc:2391');
  await expect(gilded).toHaveClass('app-link');
  const deep = shown.getByRole('button', { name: 'iron-bound chest of the deep', exact: true });
  await expect(deep).toHaveAttribute('data-atlas-target', 'demo:loc:deep-0003');
  for (const link of [gilded, deep]) {
    if (other) await expect(link).toHaveAttribute('data-atlas-game', 'demo');
    else await expect(link).not.toHaveAttribute('data-atlas-game');
  }
  // Not found: the web link it was, opening outside the app.
  const lost = shown.getByRole('link', { name: 'chest of the old tower' });
  await expect(lost).toHaveAttribute('href', 'https://maps.example.org/isle/sundered?spot=9999');
  await expect(lost).toHaveAttribute('target', '_blank');
  const map = shown.getByRole('link', { name: 'own map' });
  await expect(map).toHaveAttribute('href', 'https://maps.example.org/isle/sundered');
  await expect(shown.locator('button.app-link')).toHaveCount(2);
}

test('a link of the guide opens its location on the map of the title, one not found stays a web link', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await serveGuide(page);
  await page.goto('./');
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
  await oneTitle(page);
  await openGuidePage(page);

  // The guide is shown, the map is another source of its title.
  await expectLinks(page, true);
  await page.getByTestId('guides-page').getByRole('link', { name: 'own map' }).hover();
  await shot(page, '1-guide-page-desktop');

  await page
    .getByTestId('guides-page')
    .getByRole('button', { name: 'gilded chest', exact: true })
    .click();
  // The demo world opens on its map, at the location.
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
  await expect(page.getByTestId('map-chip')).toContainText('The Sundered Isle');
  await expect(page.getByTestId('selected-name')).toHaveText('Gilded chest 1');
  await page.waitForTimeout(800);
  await shot(page, '2-map-after-following-desktop');

  // With the map shown, Guides shows the guide the link was followed from, a source of
  // the title chosen at its top, and a link leads to another map of the title.
  await page.getByTestId('section-guides').click();
  await expect(page.getByTestId('guides-source-chip')).toContainText('Isle Guide');
  await openGuidesSection(page, 'Chests');
  await page.getByTestId('guides-page-link').filter({ hasText: 'Chests of the isle' }).click();
  await expectLinks(page, false);
  await page
    .getByTestId('guides-page')
    .getByRole('button', { name: 'iron-bound chest of the deep', exact: true })
    .click();
  await expect(page.getByTestId('map-chip')).toContainText('The Hollow Deep');
  await expect(page.getByTestId('selected-name')).toHaveText('Iron-bound chest 3');
  expect(errors.filter((e) => !e.includes('404') && !e.includes('ERR_FAILED'))).toEqual([]);
});

test('at phone size, the link opens the map of the title at its location', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = collectErrors(page);
  await serveGuide(page);
  await page.goto('./');
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
  await oneTitle(page);
  await openGuidePage(page);
  await expectLinks(page, true);
  // Nothing wider than the screen.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await shot(page, '3-guide-page-phone');

  await page
    .getByTestId('guides-page')
    .getByRole('button', { name: 'gilded chest', exact: true })
    .click();
  await expect(page.getByTestId('section-map')).toHaveAttribute('aria-current', /page|true/);
  await expect(page.getByTestId('selected-name')).toHaveText('Gilded chest 1');
  await page.waitForTimeout(800);
  await shot(page, '4-map-after-following-phone');
  expect(errors.filter((e) => !e.includes('404') && !e.includes('ERR_FAILED'))).toEqual([]);
});
