import { mkdir } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';
import {
  DOWNLOADS_BUILD,
  EXAMPLE_WIKI,
  WIKI,
  mock,
  realErrors,
  setUp,
  type WikiSite,
} from './fakeShell';

/**
 * Wikis no importer knows, read by a general reader: the made-up "Other
 * wikis" importer of the contract's demo folder (`other-wikis-importer.js`),
 * against the stand-in shell of `fakeShell.ts`, which answers the made-up
 * wikis itself. The person chooses how a wiki is read, and confirms its
 * licence when its pages state none. Pages are fetched only in a build
 * with downloads, so these tests run in that build.
 */

test.use({ layout: 'standard' });
test.skip(!DOWNLOADS_BUILD, 'Pages are fetched only in a build with downloads.');

/** Where the screenshots go: ATLAS_GENERAL_SHOTS, or beside the other test results. */
const SHOTS = process.env.ATLAS_GENERAL_SHOTS ?? 'test-results/general-readers';

const BY_SA_3 = 'https://creativecommons.org/licenses/by-sa/3.0/';

/** A made-up wiki on a host no importer knows: Lanterns states a licence, Wicks and Glass do not. */
const MARSH: WikiSite = {
  headings: [{ title: 'Light', pages: ['Lanterns', 'Wicks', 'Glass'] }],
  pages: {
    Lanterns: {
      title: 'Lanterns',
      body: 'Lanterns light the marsh paths.',
      links: ['Wicks'],
      licence: BY_SA_3,
    },
    Wicks: { title: 'Wicks', body: 'Trim them short.' },
    Glass: { title: 'Glass', body: 'It fogs at dawn.' },
    Reeds: { title: 'Reeds', body: 'They grow by the water.', licence: BY_SA_3 },
  },
  busy: ['Fog'],
};
const MARSH_HOST = 'wiki.marsh.example';
const MARSH_WIKI = `https://${MARSH_HOST}/wiki`;
const OTHERS = { [MARSH_HOST]: MARSH, 'wiki.dunes.example': MARSH };

/** The app's own requests and windows, from the fake shell. */
async function events(page: Page, what: 'fetch' | 'open' | 'navigate' | 'read') {
  return (await mock(page)).events.filter((e) => e.what === what).map((e) => e.url!);
}

async function openLibrary(page: Page) {
  if (!(await page.getByTestId('library').isVisible())) {
    await page.getByTestId('section-library').click();
  }
}

async function add(page: Page, address: string) {
  await openLibrary(page);
  await page.getByTestId('add-map-url').fill(address);
  await page.getByTestId('add-map-url').press('Enter');
}

test('a wiki no importer knows: the person chooses how it is read, and it is read so until they change it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await setUp(page, true, { others: OTHERS, wiki: EXAMPLE_WIKI });
  const flow = page.getByTestId('library-flow');

  // A known wiki's address still goes to its own importer, which offers no choice.
  await add(page, `${WIKI}/Contents`);
  await expect(flow).toHaveAttribute('data-phase', 'choose', { timeout: 30_000 });
  await flow.getByTestId('library-flow-close').click();
  const known = await events(page, 'fetch');
  expect(known).toEqual(['https://wiki.example.org/robots.txt', `${WIKI}/Contents`]);

  // Typing an unknown wiki's address reads nothing; Add first asks how to read it.
  await openLibrary(page);
  await page.getByTestId('add-map-url').fill(`${MARSH_WIKI}/Contents`);
  await page.getByTestId('add-map-url').press('Enter');
  await expect(flow).toHaveAttribute('data-phase', 'how');
  const how = flow.getByTestId('add-how');
  await expect(how).toContainText(MARSH_HOST);
  await expect(how.getByTestId('site-notice')).toContainText('This app does not know this wiki');
  await expect(how.getByTestId('site-ways')).toHaveAttribute('data-way', 'fetch');
  await expect(how.getByTestId('site-way-fetch')).toContainText('By itself');
  await expect(how.getByTestId('site-way-window')).toContainText('In a window of this app');
  expect(await events(page, 'fetch')).toEqual(known);
  expect(await events(page, 'open')).toEqual([]);
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/reading-way-choice.png` });

  // In a window of this app: the contents and the pages open in a window; nothing is fetched.
  await how.getByTestId('site-way-window').click();
  await expect(how.getByTestId('site-ways')).toHaveAttribute('data-way', 'window');
  await how.getByTestId('add-how-go').click();
  await expect(flow).toHaveAttribute('data-phase', 'choose', { timeout: 30_000 });
  await page
    .getByTestId('add-map-choose-page')
    .filter({ hasText: 'Lanterns' })
    .getByRole('checkbox')
    .check();
  await flow.getByTestId('follow-links-ticked').click();
  await page.getByTestId('add-map-choose-confirm').click();
  await expect(flow).toHaveAttribute('data-run', 'finished', { timeout: 30_000 });
  expect(await events(page, 'fetch')).toEqual(known);
  expect(await events(page, 'read')).toEqual([`${MARSH_WIKI}/Contents`, `${MARSH_WIKI}/Lanterns`]);

  // Added again later: the choice is kept, so nothing is asked.
  await add(page, `${MARSH_WIKI}/Contents`);
  await expect(flow).toHaveAttribute('data-phase', 'choose', { timeout: 30_000 });
  await flow.getByTestId('library-flow-close').click();

  // The wiki's screen shows the choice; changed there, the next go is fetched, robots.txt first.
  await page.locator('[data-testid="library-game"][data-pack="wiki-marsh-example-wiki"]').click();
  const screen = page.getByTestId('wiki-screen');
  const reading = screen.getByTestId('wiki-reading');
  await expect(reading.getByTestId('site-notice')).toContainText('This app does not know');
  await expect(reading.getByTestId('site-ways')).toHaveAttribute('data-way', 'window');
  await reading.getByTestId('site-way-fetch').click();
  await expect(reading.getByTestId('site-ways')).toHaveAttribute('data-way', 'fetch');
  // The other wiki of the same importer keeps its own choice (none yet: it asks).
  await add(page, 'https://wiki.dunes.example/wiki/Reeds');
  await expect(flow).toHaveAttribute('data-phase', 'how');
  await expect(flow.getByTestId('site-ways')).toHaveAttribute('data-way', 'fetch');
  await flow.getByTestId('library-flow-close').click();
  expect(await events(page, 'fetch')).toEqual(known);
  await add(page, `${MARSH_WIKI}/Reeds`);
  await expect(flow).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
  expect((await events(page, 'fetch')).slice(known.length)).toEqual([
    `https://${MARSH_HOST}/robots.txt`,
    `${MARSH_WIKI}/Reeds`,
  ]);
  expect(realErrors(errors)).toEqual([]);
});

test('a refusal says the wiki can be read in a window instead, and the person chooses it there', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors = collectErrors(page);
  await setUp(page, true, { others: OTHERS });
  const flow = page.getByTestId('library-flow');
  await add(page, `${MARSH_WIKI}/Fog`);
  await flow.getByTestId('add-how-go').click();
  const error = flow.getByTestId('add-map-error');
  await expect(error).toContainText('stopped', { timeout: 30_000 });
  await expect(error).toContainText('In a window of this app');
  // Nothing is tried again or around it: the choice is the person's.
  await flow.getByTestId('add-map-how').click();
  await expect(flow).toHaveAttribute('data-phase', 'how');
  await expect(flow.getByTestId('site-ways')).toHaveAttribute('data-way', 'fetch');
  await flow.getByTestId('site-way-window').click();
  await flow.getByTestId('add-how-go').click();
  await expect.poll(() => events(page, 'open'), { timeout: 30_000 }).toEqual([`${MARSH_WIKI}/Fog`]);
  expect(realErrors(errors)).toEqual([]);
});

test('a page that states no licence is kept only once the person confirms one, which is kept for the wiki', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await setUp(page, true, { others: OTHERS });
  const flow = page.getByTestId('library-flow');

  // Not now: nothing is added.
  await add(page, `${MARSH_WIKI}/Glass`);
  await flow.getByTestId('add-how-go').click();
  const question = page.getByTestId('licence-question');
  await expect(question).toBeVisible({ timeout: 30_000 });
  await question.getByTestId('licence-decline').click();
  await expect(question).toHaveCount(0);
  await expect(flow.getByTestId('add-map-error')).toHaveText(
    'The wiki’s licence was not confirmed, so nothing was added from this page and no more pages were read.',
  );
  await expect(
    page.locator('[data-testid="library-game"][data-pack="wiki-marsh-example-wiki"]'),
  ).toHaveCount(0);

  // Confirmed: the page is read with it, and its guide says the person confirmed it.
  await add(page, `${MARSH_WIKI}/Wicks`);
  await expect(question).toBeVisible({ timeout: 30_000 });
  await expect(question).toContainText(`Which licence is ${MARSH_HOST} under?`);
  await expect(question.getByTestId('licence-confirm')).toBeDisabled();
  await question.getByTestId('licence-choice').selectOption({ label: 'CC BY-NC-SA 4.0' });
  await page.screenshot({ path: `${SHOTS}/licence-confirmation.png` });
  await question.getByTestId('licence-confirm').click();
  await expect(flow).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });

  // Another page of the same wiki that states none: read under it, without asking again.
  await add(page, `${MARSH_WIKI}/Glass`);
  await expect(flow).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
  await expect(question).toHaveCount(0);

  // The wiki's screen says so, and it can be forgotten.
  await flow.getByTestId('library-flow-close').click();
  await page.locator('[data-testid="library-game"][data-pack="wiki-marsh-example-wiki"]').click();
  const licence = page.getByTestId('wiki-licence');
  await expect(licence).toContainText('You confirmed this wiki’s licence: CC BY-NC-SA 4.0');

  // In Guides, the credit says it was confirmed by the person.
  await page.getByTestId('section-guides').click();
  await page.getByTestId('guides-page-link').filter({ hasText: 'Wicks' }).click();
  await expect(page.getByTestId('guides-credit')).toContainText(
    'CC BY-NC-SA 4.0 (confirmed by you: the page states no licence)',
  );
  await openLibrary(page);
  await page.locator('[data-testid="library-game"][data-pack="wiki-marsh-example-wiki"]').click();
  await page.getByTestId('wiki-licence-forget').click();
  await expect(page.getByTestId('wiki-licence')).toHaveCount(0);
  expect(realErrors(errors)).toEqual([]);
});
