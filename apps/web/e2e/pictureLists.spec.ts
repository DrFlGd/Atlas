import { mkdir } from 'node:fs/promises';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, mock, realErrors, setUp } from './fakeShell';
import { collectErrors, storedSetting } from './helpers';

/**
 * The games of a list page whose games are each an anchor on it, added
 * one at a time (`src/state/gameSession.ts`, `src/state/anchoredPages.ts`):
 * a made-up importer that reads a made-up list page by fetching it, and
 * offers the page's list of games only at the address pasted
 * (`pastedOnly`). The list page is asked for once for the list and once
 * for the whole session, not once for each game.
 */

test.describe.configure({ timeout: 180_000 });

test.skip(!DOWNLOADS_BUILD, 'Pages are fetched only in a build with downloads.');

const SHOTS = 'test-results/picture-lists';

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

const ORIGIN = 'https://atlas.example.net';
const LIST = `${ORIGIN}/lists/saltbox.html`;

const section = (anchor: string, name: string, maps: string[]) =>
  `<section id="${anchor}"><h2>${name}</h2>${maps
    .map((map) => `<a class="map" href="/pictures/${anchor}-${map}.png">${map}</a>`)
    .join(' ')}</section>`;

const LIST_PAGE = `<!doctype html><html><body>
<h1>Saltbox</h1><p class="system">Saltbox 64</p>
<p><a href="#Ashgrove">Ashgrove</a> <a href="#Emberfall">Emberfall</a></p>
${section('Ashgrove', 'Ashgrove', ['Mill'])}
${section('Emberfall', 'Emberfall', ['Harbour', 'Tower'])}
${section('Frostvale', 'Frostvale', ['Gate'])}
</body></html>`;

/** A made-up importer of such list pages: a plain module with no imports, as every importer is. */
const IMPORTER = String.raw`
const ORIGIN = 'https://atlas.example.net';
const LISTS = ORIGIN + '/lists/';
const isList = (url) => /^https:\/\/atlas\.example\.net\/lists\/[a-z0-9-]+\.html$/.test(url);
const plain = (url) => url.split('#')[0];
const anchorOf = (url) => url.split('#')[1] || '';
const textOf = (pageData) => pageData?.fetched?.[0]?.status === 200 ? pageData.fetched[0].text : null;
const sectionsOf = (text) =>
  [...text.matchAll(/<section id="([^"]+)"><h2>([^<]+)<\/h2>(.*?)<\/section>/gs)].map((m) => ({
    anchor: m[1],
    name: m[2],
    maps: [...m[3].matchAll(/<a class="map" href="([^"]+)">([^<]+)<\/a>/g)].map((a) => ({
      href: a[1],
      name: a[2],
    })),
  }));
const systemOf = (text) => /<p class="system">([^<]+)<\/p>/.exec(text)?.[1];
const packIdOf = (url) =>
  plain(url).slice(LISTS.length).replace('.html', '') + '-' + anchorOf(url).toLowerCase();

export default {
  apiVersion: 1,
  id: 'picture-lists',
  title: 'Example atlas',
  description: 'Reads the made-up list pages of the example atlas.',
  version: '1.0.0',
  example: LISTS + 'saltbox.html#Emberfall',
  matches: (url) => isList(plain(url)) && anchorOf(url) !== '',
  fetch: { addresses: (url) => [plain(url)] },
  convert(pageData, context) {
    const text = textOf(pageData);
    const game = text && sectionsOf(text).find((s) => s.anchor === anchorOf(context.url));
    if (!game || game.maps.length === 0) return { ok: false, message: 'No such game on the page.' };
    const packId = packIdOf(context.url);
    const slug = (name) => name.toLowerCase();
    const pack = {
      manifest: {
        schemaVersion: 1,
        gameId: packId,
        title: game.name,
        packVersion: '1.0.0',
        gamePatch: 'example',
        attribution: [{ name: 'Example atlas (made-up test data)' }],
        idMigrations: {},
      },
      maps: game.maps.map((map) => ({
        id: packId + ':map:' + slug(map.name),
        name: map.name,
        width: 1024,
        height: 1024,
      })),
      layers: game.maps.map((map) => ({
        id: packId + ':layer:' + slug(map.name),
        mapId: packId + ':map:' + slug(map.name),
        name: 'Map',
        tiles: { type: 'xyz', url: 'tiles/' + slug(map.name) + '/{z}/{x}/{y}.png' },
        minZoom: 0,
        maxZoom: 2,
        tileSize: 256,
      })),
      regions: [],
      categoryGroups: [],
      categories: [],
      locations: [],
      entities: [],
      checklists: [],
      checklistItems: [],
      guides: [],
      links: [],
      presets: [],
    };
    return {
      ok: true,
      packId,
      sourceKey: anchorOf(context.url).toLowerCase(),
      mapId: pack.maps[0].id,
      pack,
      summary: {
        game: game.name,
        map: game.maps[0].name,
        maps: pack.maps.length,
        locations: 0,
        mapLocations: 0,
        categories: 0,
        refreshed: false,
      },
    };
  },
  games: {
    matches: () => false,
    pageReader: '() => null',
    convert: () => ({ ok: false, message: 'This site has no game pages.' }),
  },
  catalogues: () => [
    {
      address: LISTS,
      label: 'Games on Example atlas',
      site: 'Example atlas',
      pastedOnly: true,
      matches: isList,
      fetch: { addresses: (url) => [url] },
      convert(pageData, context) {
        const text = textOf(pageData);
        if (!text) return { ok: false, message: 'The list page could not be read.' };
        const system = systemOf(text);
        return {
          ok: true,
          games: sectionsOf(text).map((game) => {
            const address = context.url + '#' + game.anchor;
            return {
              id: packIdOf(address),
              name: game.name,
              address,
              maps: game.maps.length,
              ...(system ? { system } : {}),
            };
          }),
        };
      },
    },
  ],
};
`;

test('lists the games of a list page pasted, and adds them one at a time with the page fetched once', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await setUp(page, true, {
    pages: { [LIST]: LIST_PAGE },
    importers: [{ id: 'picture-lists', title: 'Example atlas', source: IMPORTER }],
  });
  await page.getByTestId('add-map-button').click();
  // The list read only at an address pasted has no button of its own.
  await expect(page.getByTestId('add-map-browse')).not.toContainText('Example atlas');
  await page.getByTestId('add-map-url').fill(LIST);
  await page.getByTestId('add-map-start').click();
  await expect(page.getByTestId('library-flow')).toHaveAttribute('data-phase', 'catalogue', {
    timeout: 30_000,
  });
  const games = page.getByTestId('add-map-catalogue-game');
  await expect(games).toHaveText([/Ashgrove\s*1 map/, /Emberfall\s*2 maps/, /Frostvale\s*1 map/]);
  await page.screenshot({ path: `${SHOTS}/1-list.png` });
  await page
    .getByTestId('add-map-catalogue-select')
    .getByRole('button', { name: 'Tick all' })
    .click();
  await page.getByTestId('add-map-catalogue-session').click();

  const plan = page.getByTestId('games-plan');
  await expect(plan).toContainText('Add 3 games from Example atlas, one at a time.');
  await expect(plan).toContainText('This app adds each game in turn');
  await expect(plan.getByTestId('games-plan-totals')).toContainText('4 maps.');
  // The one system the list names for every game is the list's, to change here.
  await expect(plan.getByTestId('games-plan-system')).toHaveValue('Saltbox 64');
  await expect(plan.getByTestId('games-plan-game').first()).toHaveText(/^Ashgrove\s*1 map$/);
  await page.screenshot({ path: `${SHOTS}/2-plan.png` });

  await page.getByTestId('games-plan-start').click();
  await expect(page.getByTestId('games-done')).toBeVisible({ timeout: 150_000 });
  const done = page.getByTestId('games-done').getByTestId('games-game');
  await expect(done).toHaveCount(3);
  await page.screenshot({ path: `${SHOTS}/3-done.png` });
  for (const n of [0, 1, 2]) await expect(done.nth(n)).toHaveAttribute('data-state', 'added');
  await expect(done.nth(1)).toContainText('1 page added. Filed under Saltbox 64.');
  // No game here had their titles: each is listed to put together by hand.
  await expect(page.getByTestId('games-unmatched-game')).toHaveCount(3);

  // The list page once for the list and once for the session, each after robots.txt.
  const fetched = (await mock(page)).events
    .filter((event) => event.what === 'fetch')
    .map((event) => event.url);
  expect(fetched).toEqual([`${ORIGIN}/robots.txt`, LIST, `${ORIGIN}/robots.txt`, LIST]);
  const tags = (await storedSetting(page, 'gameTags')) as {
    tags: Record<string, Record<string, string[]>>;
  };
  expect(tags.tags['game:saltbox-emberfall']).toEqual({ system: ['Saltbox 64'] });
  expect(realErrors(errors)).toEqual([]);

  // Pasted again, the games added are marked; adding one again reads nothing new.
  await page.getByTestId('games-close').click();
  await page.getByTestId('add-map-url').fill(LIST);
  await page.getByTestId('add-map-start').click();
  await expect(page.getByTestId('library-flow')).toHaveAttribute('data-phase', 'catalogue', {
    timeout: 30_000,
  });
  await expect(games.first()).toContainText('In your maps folder');
});
