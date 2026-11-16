import { mkdir } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, mock, pickSavedPage, pickSiteFile, realErrors, setUp } from './fakeShell';

/**
 * Settings, "Sites": the site rules files the importers read sites by,
 * against the stand-in shell of `fakeShell.ts` and the made-up "Other
 * wikis" importer (`other-wikis-importer.js` in the importer contract's
 * demo folder), which comes with the defaults of its reader, a file for a
 * made-up wiki and a refusal file for a made-up wiki farm, and tries a file
 * read by rules on a saved page. Every page here is made up. Only Atlas
 * Importer has the Sites folder, so these tests run in the build with
 * downloads.
 */

test.use({ layout: 'standard' });
test.skip(!DOWNLOADS_BUILD, 'Only a build with downloads keeps site rules files.');

/** Where the screenshots go: ATLAS_SITES_SHOTS, or beside the other test results. */
const SHOTS = process.env.ATLAS_SITES_SHOTS ?? 'test-results/sites';

const OTHERS = {
  'wiki.example.net': {
    headings: [{ title: 'Basics', pages: ['Welcome'] }],
    pages: { Welcome: { title: 'Welcome', body: 'Hello.' } },
  },
};

/** A file of the person's for the made-up wiki the importer comes with a file for. */
const OWN_HARBOUR = {
  format: 'atlas-site-rules',
  version: 1,
  site: {
    id: 'harbour-wiki',
    name: 'Harbour Wiki, as I read it',
    game: 'Harbour',
    hosts: ['harbour.example.net'],
    licence: { permission: 'Permission from the wiki’s owner for personal use' },
  },
  parts: [{ type: 'wiki', reader: 'other-wiki', reading: { ways: ['browse'] } }],
};

/** A file whose one part is read by `rules`, which this version only checks. */
const BY_RULES = {
  format: 'atlas-site-rules',
  version: 1,
  site: {
    id: 'lantern-guide',
    name: 'Lantern Guide',
    game: 'Lantern',
    hosts: ['guide.example.org'],
  },
  parts: [
    {
      type: 'wiki',
      reader: 'rules',
      start: '/',
      reading: { ways: ['fetch'] },
      pages: { include: ['/pages/*'] },
      contents: { from: 'sitemap' },
      article: { content: 'main article' },
    },
  ],
};

const row = (page: Page, key: string) =>
  page.locator(`[data-testid="site-row"][data-key="${key}"]`);

async function openSites(page: Page) {
  await page.getByTestId('section-settings').click();
  const sites = page.getByTestId('settings-sites');
  await expect(sites).toBeVisible();
  return sites;
}

test('lists the files, adds one of the person’s off until switched on, and saves the guide', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await mkdir(SHOTS, { recursive: true });
  await setUp(page, true, { others: OTHERS });
  const sites = await openSites(page);

  // The files the importer comes with, each on, with its site, types, hosts and ways.
  const harbour = row(page, 'other-wikis/harbour-wiki.atlas-site.json');
  await expect(harbour).toHaveAttribute('data-on', 'true');
  await expect(harbour).toContainText('Harbour Wiki');
  await expect(harbour).toContainText('Wiki · By itself, As I browse');
  await expect(harbour.getByTestId('site-hosts')).toHaveText('Host: harbour.example.net');
  const defaults = row(page, 'other-wikis/other-wiki.reader.atlas-site.json');
  await expect(defaults).toContainText('Defaults of the reader “other-wiki”');
  await expect(defaults).toContainText('By itself, In a window, As I browse');
  await sites.screenshot({ path: `${SHOTS}/sites-built-in.png` });

  // A file with problems is not kept: its problems are shown in plain words.
  await pickSiteFile(page, {
    name: 'broken.json',
    text: JSON.stringify({ ...OWN_HARBOUR, site: { ...OWN_HARBOUR.site, name: undefined } }),
  });
  await sites.getByTestId('sites-add').click();
  const refused = sites.getByTestId('sites-refused');
  await expect(refused).toContainText('broken.json was not added.');
  await expect(refused).toContainText('site.name: is missing, and it is needed.');
  expect((await mock(page)).sites.files).toEqual({});
  await sites.screenshot({ path: `${SHOTS}/sites-refused.png` });

  // A good file is kept under the name its contents give it, off, and its hosts shown first.
  await pickSiteFile(page, { name: 'my harbour.json', text: JSON.stringify(OWN_HARBOUR) });
  await sites.getByTestId('sites-add').click();
  const confirm = sites.getByTestId('sites-confirm');
  await expect(confirm).toContainText('Added harbour-wiki.atlas-site.json');
  await expect(confirm.getByTestId('sites-confirm-hosts')).toHaveText('harbour.example.net');
  const own = row(page, 'own/harbour-wiki.atlas-site.json');
  await expect(own).toHaveAttribute('data-on', 'false');
  expect(Object.keys((await mock(page)).sites.files)).toEqual(['harbour-wiki.atlas-site.json']);
  expect((await mock(page)).sites.switches.on).toEqual({});
  await sites.screenshot({ path: `${SHOTS}/sites-confirm.png` });

  // Switched on, it takes the place of the importer's file for the same site.
  await confirm.getByTestId('sites-confirm-on').click();
  await expect(own).toHaveAttribute('data-on', 'true');
  await expect(own).toContainText('In place of the importer’s');
  await expect(own).toContainText('As I browse');
  await expect(harbour).toContainText('Your file harbour-wiki.atlas-site.json is switched on');
  const on = (await mock(page)).sites.switches.on;
  expect(Object.keys(on)).toEqual(['own/harbour-wiki.atlas-site.json']);
  expect(on['own/harbour-wiki.atlas-site.json']).toMatch(/^[0-9a-f]{64}$/);
  await sites.screenshot({ path: `${SHOTS}/sites-own-on.png` });

  // A file the importer comes with is switched off and on by its switch alone.
  await defaults.getByTestId('site-switch').click({ force: true });
  await expect(defaults).toHaveAttribute('data-on', 'false');
  expect((await mock(page)).sites.switches.off).toEqual([
    'other-wikis/other-wiki.reader.atlas-site.json',
  ]);
  await defaults.getByTestId('site-switch').click({ force: true });
  await expect(defaults).toHaveAttribute('data-on', 'true');
  expect((await mock(page)).sites.switches.off).toEqual([]);

  // A part read by rules is checked, and the importer says it only tries it on a saved page.
  await pickSiteFile(page, { name: 'lantern.json', text: JSON.stringify(BY_RULES) });
  await sites.getByTestId('sites-add').click();
  await sites.getByTestId('sites-confirm-off').click();
  const lantern = row(page, 'own/lantern-guide.atlas-site.json');
  await expect(lantern.getByTestId('site-problems')).toHaveText(
    'Part 1: is read by rules, which this importer only tries on a saved page: it does not read the site by it.',
  );

  // The guide, with what the importer says of its readers, and the schema.
  await sites.getByTestId('sites-save-guide').click();
  await sites.getByTestId('sites-save-schema').click();
  await expect.poll(async () => (await mock(page)).sites.saved.length).toBe(2);
  const [guide, schema] = (await mock(page)).sites.saved;
  expect(guide!.what).toBe('guide');
  expect(guide!.contents).toMatch(/^# Writing an Atlas site rules file/);
  expect(guide!.contents).toContain('## Readers of the importer “Other wikis”');
  expect(schema!.what).toBe('schema');
  expect(JSON.parse(schema!.contents)).toMatchObject({ title: expect.any(String) });

  // Removing the person's file brings the importer's back.
  await own.getByTestId('site-remove').click();
  await expect(own).toHaveCount(0);
  await expect(harbour).not.toContainText('Your file');
  expect((await mock(page)).sites.switches.on).toEqual({});
  await sites.screenshot({ path: `${SHOTS}/sites-removed.png` });

  expect(realErrors(errors)).toEqual([]);
});

/** Made-up guide pages, as saved from a made-up site. */
const GUIDE_RULES = {
  format: 'atlas-site-rules',
  version: 1,
  site: {
    id: 'cove-guide',
    name: 'Cove Guide',
    game: 'Cove',
    hosts: ['guide.example.org'],
    licence: { blank: true },
  },
  parts: [
    {
      type: 'guide',
      reader: 'rules',
      start: '/cove',
      reading: { ways: ['browse'] },
      pages: { include: ['/cove/*'] },
      contents: { from: 'menu', links: 'nav.menu li a', groups: 'nav.menu li.group' },
      article: {
        content: 'main .text',
        title: 'main h1',
        remove: ['.notice', '.promo'],
        credit: 'main .byline',
      },
      pictures: { full: 'attribute', fullAttribute: 'data-large' },
      order: { from: 'next', next: 'a.next-page' },
    },
  ],
};

const SAVED_PAGE = (canonical: boolean) => `<!doctype html>
<html><head><title>The Old Quay | Cove Guide</title>
${canonical ? '<link rel="canonical" href="https://guide.example.org/cove/old-quay">' : ''}
<script>window.ran = true;</script></head>
<body>
<nav class="menu"><ul>
<li class="group">Arrival</li>
<li><a href="/cove/harbour">The Harbour</a></li>
<li><a href="/cove/old-quay">The Old Quay</a></li>
<li class="group">The Hills</li>
<li><a href="/cove/lookout">The Lookout</a></li>
</ul></nav>
<main>
<h1>The Old Quay</h1>
<p class="byline">By A. Writer, 3 March 2026</p>
<div class="text">
<p class="notice">Made-up notice to leave out.</p>
<h2>Getting there</h2>
<p>Walk past the nets and the lamp posts until the stones turn green.</p>
<img src="/img/quay-small.png" data-large="/img/quay.png" alt="The quay">
<h2>What to find</h2>
<p>Three crates, a rope and a bell.</p>
<img src="/img/bell-small.png" data-large="/img/bell.png" alt="The bell">
<table><tr><td>Crate</td><td>3</td></tr></table>
</div>
<a class="next-page" href="/cove/lookout">Next</a>
</main>
</body></html>`;

/** A made-up site with a wiki and a map, both read by rules. */
const MAP_RULES = {
  format: 'atlas-site-rules',
  version: 1,
  site: {
    id: 'reed-isle',
    name: 'Reed Isle Wiki',
    game: 'Reed Isle',
    hosts: ['reed.example.org'],
    licence: { blank: true },
  },
  parts: [
    {
      type: 'wiki',
      reader: 'rules',
      start: '/',
      reading: { ways: ['fetch'] },
      pages: { include: ['/*'], exclude: ['/map'] },
      contents: { from: 'menu', links: 'nav a' },
      article: { content: 'main' },
    },
    {
      type: 'map',
      reader: 'rules',
      start: '/map',
      data: { from: 'file', address: '/map/data.json' },
      maps: {
        path: 'areas[*]',
        id: 'key',
        name: 'title',
        size: 'pixels',
        maxZoom: 'zoom',
        group: 'tower',
        floor: 'level',
        picture: { images: '/tiles/{map}/{z}/{x}/{y}.png?v=7', tile: 256 },
      },
      types: { from: 'locations', names: { 'key-items': 'Key items' }, found: ['key-items'] },
      locations: {
        path: 'spots[*]',
        fields: {
          map: 'area',
          type: 'kind',
          name: 'label',
          x: 'at[0]',
          y: 'at[1]',
          description: 'text',
          page: 'link',
          picture: 'photo',
        },
      },
      position: { units: 'pixels', origin: 'top-left' },
      reading: { ways: ['fetch'] },
    },
  ],
};

/** A made-up data file for that map, as saved from the made-up site. */
const MAP_DATA = {
  areas: [
    { key: 'harbour', title: 'Harbour', pixels: [4096, 3072], zoom: 4 },
    {
      key: 'tower-1',
      title: 'Old Tower',
      pixels: [1024, 1024],
      zoom: 2,
      tower: 'old-tower',
      level: 'Ground floor',
    },
    {
      key: 'tower-2',
      title: 'Old Tower',
      pixels: [1024, 1024],
      zoom: 2,
      tower: 'old-tower',
      level: 'Top floor',
    },
  ],
  spots: [
    {
      area: 'harbour',
      kind: 'key-items',
      label: 'Rusty key',
      at: [1200, 2210],
      text: '<p>Under the third crate.</p>',
      link: '/rusty-key',
    },
    { area: 'harbour', kind: 'chests', label: 'Net chest', at: [300, 410] },
    { area: 'harbour', kind: 'chests', label: 'Far chest', at: [5000, 10] },
    {
      area: 'tower-1',
      kind: 'chests',
      label: 'Stair chest',
      at: [512, 512],
      text: '<p>By the stairs.</p>',
    },
    { area: 'tower-2', kind: 'key-items', label: 'Bell key', at: [100, 900], link: '/bell-key' },
  ],
};

test.describe('what a file widens, and trying a file on a saved page', () => {
  test.use({ deviceScaleFactor: 2 });

  test('lists what a file of the person’s widens before it is on, and on its row', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await mkdir(SHOTS, { recursive: true });
    await setUp(page, true, { others: OTHERS });
    const sites = await openSites(page);

    // The refusal file the importer comes with.
    const refusal = row(page, 'other-wikis/quiet-archive.refused.atlas-site.json');
    await expect(refusal).toContainText('Quiet Archive wikis');
    await expect(refusal).toContainText('Refused: the importers never read these sites');
    await expect(refusal.getByTestId('site-hosts')).toHaveText('Host: quiet-archive.example');

    // A file that adds a way for a host, and reads a host the importer refuses.
    await pickSiteFile(page, {
      name: 'wider.json',
      text: JSON.stringify({
        ...OWN_HARBOUR,
        site: {
          ...OWN_HARBOUR.site,
          hosts: ['harbour.example.net', 'north.quiet-archive.example'],
        },
        parts: [{ type: 'wiki', reader: 'other-wiki', reading: { ways: ['window', 'browse'] } }],
      }),
    });
    await sites.getByTestId('sites-add').click();
    const confirm = sites.getByTestId('sites-confirm');
    await expect(confirm).toContainText('It widens the limits of the importers’ files.');
    await expect(confirm.getByTestId('sites-confirm-widens').locator('li')).toHaveText([
      'Part 1, reading.ways: adds In a window for harbour.example.net.',
      'site.hosts, entry 2: reads north.quiet-archive.example, which the file “quiet-archive.refused.atlas-site.json” of the importer refuses: This app does not read the Quiet Archive’s wikis, so nothing was opened or added.',
    ]);
    await confirm.screenshot({ path: `${SHOTS}/reader-widens-confirm.png` });

    await confirm.getByTestId('sites-confirm-on').click();
    const own = row(page, 'own/harbour-wiki.atlas-site.json');
    await expect(own).toHaveAttribute('data-on', 'true');
    await expect(own.getByTestId('site-widens').locator('li')).toHaveCount(2);
    await own.screenshot({ path: `${SHOTS}/reader-widens-row.png` });
    expect(realErrors(errors)).toEqual([]);
  });

  test('tries a file read by rules on a saved page, and says what it understood', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await mkdir(SHOTS, { recursive: true });
    await setUp(page, true, { others: OTHERS });
    const sites = await openSites(page);
    await pickSiteFile(page, { name: 'cove.json', text: JSON.stringify(GUIDE_RULES) });
    await sites.getByTestId('sites-add').click();
    await sites.getByTestId('sites-confirm-off').click();
    const cove = row(page, 'own/cove-guide.atlas-site.json');

    // A page with a canonical link is tried at once; nothing of it runs.
    await pickSavedPage(page, { name: 'old-quay.html', text: SAVED_PAGE(true) });
    await cove.getByTestId('site-try').click();
    const trial = cove.getByTestId('site-trial');
    await expect(trial).toContainText('the page at https://guide.example.org/cove/old-quay');
    await expect(trial.getByTestId('site-trial-facts').locator('li')).toHaveText([
      'Part 1 of the file read it, as a page of a guide.',
      'Its title is “The Old Quay”.',
      'The game is “Cove”.',
      'It has 2 headings, 2 pictures and 1 table.',
      'Every picture has the address of its full-size file.',
      'The contents it shows list 3 pages in 2 groups.',
      'The first: The Harbour (Arrival), The Old Quay (Arrival), The Lookout (The Hills).',
      'The next page is https://guide.example.org/cove/lookout.',
      'The credit line reads “By A. Writer, 3 March 2026”.',
      'Licence: None recorded, as the file says.',
      'The layout is read as the browser shows it.',
      'No layout was found: the page is kept in one column.',
      'A page saved from a browser has no notes of its layout, so layout that comes only from the wiki’s style sheet is not seen here: it shows once the wiki is read in the app.',
    ]);
    await expect(trial.getByTestId('site-trial-text')).toContainText(
      'Getting there Walk past the nets',
    );
    await expect(trial.getByTestId('site-trial-text')).not.toContainText('Made-up notice');
    await expect(trial.getByTestId('site-trial-problems')).toHaveText(
      '“article.remove” (.promo) matched nothing on this page.',
    );
    expect(await page.evaluate(() => (window as { ran?: boolean }).ran)).toBeUndefined();
    await trial.screenshot({ path: `${SHOTS}/reader-try-page.png` });

    // A page without one: the person is asked for its address first.
    await pickSavedPage(page, { name: 'old-quay.html', text: SAVED_PAGE(false) });
    await cove.getByTestId('site-try').click();
    await expect(trial).toContainText('The page does not say its own address.');
    await trial.getByTestId('site-trial-address').fill('guide.example.org/cove/old-quay');
    await trial.getByTestId('site-trial-go').click();
    await expect(trial.getByRole('alert')).toHaveText(
      'Give the whole address, starting with https://.',
    );
    await trial.screenshot({ path: `${SHOTS}/reader-try-address.png` });
    await trial.getByTestId('site-trial-address').fill('https://guide.example.org/cove/old-quay');
    await trial.getByTestId('site-trial-go').click();
    await expect(trial.getByTestId('site-trial-facts')).toContainText(
      'Its title is “The Old Quay”.',
    );

    // An address the file does not name is answered in words.
    await pickSavedPage(page, { name: 'elsewhere.html', text: SAVED_PAGE(false) });
    await cove.getByTestId('site-try').click();
    await trial.getByTestId('site-trial-address').fill('https://elsewhere.example.org/page');
    await trial.getByTestId('site-trial-go').click();
    await expect(trial.getByTestId('site-trial-problems')).toHaveText(
      'The address https://elsewhere.example.org/page is not on a host the file names.',
    );
    await trial.getByTestId('site-trial-close').click();
    await expect(trial).toHaveCount(0);
    expect(realErrors(errors)).toEqual([]);
  });
  test('tries a file’s map part on a saved data file, and says what it found', async ({ page }) => {
    const errors = collectErrors(page);
    await mkdir(SHOTS, { recursive: true });
    await setUp(page, true, { others: OTHERS });
    const sites = await openSites(page);
    await pickSiteFile(page, { name: 'reed.json', text: JSON.stringify(MAP_RULES) });
    await sites.getByTestId('sites-add').click();
    await sites.getByTestId('sites-confirm-off').click();
    const reed = row(page, 'own/reed-isle.atlas-site.json');
    await expect(reed.getByTestId('site-problems')).toContainText(
      'Part 2: is a map part read by rules, which this importer only tries on a saved data file: it does not read the map by it.',
    );

    await pickSavedPage(page, { name: 'data.json', text: JSON.stringify(MAP_DATA) });
    await reed.getByTestId('site-try').click();
    const trial = reed.getByTestId('site-trial');
    await expect(trial).toContainText(
      'tried on data.json. Nothing was kept, and nothing was downloaded.',
    );
    await expect(trial.getByTestId('site-trial-facts').locator('li')).toHaveText([
      'Part 2 of the file read it, as the data of a map.',
      'The game is “Reed Isle”.',
      'It has 3 maps, 2 types of location and 4 locations.',
      '“Harbour”, 4,096 × 3,072 pixels: 2 locations, with 1 description, 1 link, 0 pictures. 1 location falls outside it.',
      'One image of “Harbour”: https://reed.example.org/tiles/harbour/0/0/0.png?v=7',
      '“Old Tower, Ground floor”, 1,024 × 1,024 pixels: 1 location, with 1 description, 0 links, 0 pictures. It is a floor of “old-tower”.',
      'One image of “Old Tower, Ground floor”: https://reed.example.org/tiles/tower-1/0/0/0.png?v=7',
      '“Old Tower, Top floor”, 1,024 × 1,024 pixels: 1 location, with 0 descriptions, 1 link, 0 pictures. It is a floor of “old-tower”.',
      'One image of “Old Tower, Top floor”: https://reed.example.org/tiles/tower-2/0/0/0.png?v=7',
      'The first types: Key items, chests.',
      'Can be ticked as found: Key items. Cannot: chests.',
      'The first locations: Rusty key (Key items) on “Harbour” at 1,200, 2,210; Net chest (chests) on “Harbour” at 300, 410; Stair chest (chests) on “Old Tower, Ground floor” at 512, 512; Bell key (Key items) on “Old Tower, Top floor” at 100, 900.',
      'Not every position falls inside its map: the maps above say how many fall outside.',
    ]);
    await expect(trial.getByTestId('site-trial-problems').locator('li')).toHaveText([
      '1 location falls outside its map, so it would be left out: x and y may be the other way round, or counted at another zoom.',
      '“locations.fields.picture” (photo) matched nothing in the data.',
    ]);
    await trial.screenshot({ path: `${SHOTS}/map-try-data.png` });

    // A data file whose positions all fall inside, and every path matches.
    const inside = {
      ...MAP_DATA,
      spots: MAP_DATA.spots
        .filter((spot) => spot.label !== 'Far chest')
        .map((spot) => ({ ...spot, photo: '/img/spot.png' })),
    };
    await pickSavedPage(page, { name: 'data.json', text: JSON.stringify(inside) });
    await reed.getByTestId('site-try').click();
    await expect(trial.getByTestId('site-trial-facts')).toContainText(
      'Every position falls inside its map.',
    );
    await expect(trial.getByTestId('site-trial-problems')).toHaveCount(0);
    await trial.screenshot({ path: `${SHOTS}/map-try-data-inside.png` });

    // A data file for a file with no map part is answered in words.
    await pickSiteFile(page, { name: 'cove.json', text: JSON.stringify(GUIDE_RULES) });
    await sites.getByTestId('sites-add').click();
    await sites.getByTestId('sites-confirm-off').click();
    const cove = row(page, 'own/cove-guide.atlas-site.json');
    await pickSavedPage(page, { name: 'data.json', text: JSON.stringify(MAP_DATA) });
    await cove.getByTestId('site-try').click();
    await expect(cove.getByTestId('site-trial').getByRole('alert')).toHaveText(
      'This file has no map part read by rules, so a data file cannot be tried on it. Choose a page saved from the site instead.',
    );
    await cove.getByTestId('site-trial').screenshot({ path: `${SHOTS}/map-try-no-map.png` });
    expect(realErrors(errors)).toEqual([]);
  });
});
