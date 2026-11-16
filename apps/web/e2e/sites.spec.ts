import { mkdir } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, mock, pickSiteFile, realErrors, setUp } from './fakeShell';

/**
 * Settings, "Sites": the site rules files the importers read sites by,
 * against the stand-in shell of `fakeShell.ts` and the made-up "Other
 * wikis" importer (`other-wikis-importer.js` in the importer contract's
 * demo folder), which comes with the defaults of its reader and a file for
 * a made-up wiki. Only Atlas Importer has the Sites folder, so these tests
 * run in the build with downloads.
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

  // A part read by rules is checked, and this version says it cannot read it yet.
  await pickSiteFile(page, { name: 'lantern.json', text: JSON.stringify(BY_RULES) });
  await sites.getByTestId('sites-add').click();
  await sites.getByTestId('sites-confirm-off').click();
  const lantern = row(page, 'own/lantern-guide.atlas-site.json');
  await expect(lantern.getByTestId('site-problems')).toHaveText(
    'Part 1: This version cannot read a part read by rules yet.',
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
