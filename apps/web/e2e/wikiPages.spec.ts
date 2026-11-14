import type { Page } from '@playwright/test';
import { collectErrors, libraryMore } from './helpers';
import { expect, test } from './layout';
import {
  DOWNLOADS_BUILD,
  WIKI,
  mock,
  realErrors,
  setMock,
  setUp,
  type WikiSite,
} from './fakeShell';

/**
 * Pages of the made-up Example Wiki read while the wiki is shown: the game
 * shown takes them in, a page the wiki forwards to another address is one
 * page under both names, a page found that could not be read says why, and
 * a page read while the game is built again from its saved pages is kept.
 */

test.use({ layout: 'standard' });
test.skip(!DOWNLOADS_BUILD, 'Pages are fetched only in a build with downloads.');

const SITE: WikiSite = {
  headings: [{ title: 'Basics', pages: ['Welcome', 'Bells'] }],
  pages: {
    Welcome: {
      title: 'Welcome',
      body: 'See [the boats](example-wiki:guide:boats) and [the lamp](example-wiki:guide:old-lamp).',
      links: ['Boats', 'Old_lamp', 'Gone'],
    },
    Bells: {
      title: 'Bells',
      body: 'Ring the bell under [the old lamp](example-wiki:guide:old-lamp).',
      links: ['Old_lamp'],
    },
    Boats: { title: 'Boats', body: 'The boats leave at dawn.' },
    // The wiki forwards the old name to the page's own address.
    Old_lamp: { title: 'Old lamp', body: '', forward: 'Lamp' },
    Lamp: { title: 'Lamp', body: 'It burns oil all night.' },
  },
};

const row = (page: Page, title: string) =>
  page
    .getByTestId('wiki-row')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) });

async function fetched(page: Page): Promise<string[]> {
  return (await mock(page)).events.filter((e) => e.what === 'fetch').map((e) => e.url!);
}

const wikiScreen = async (page: Page) => {
  await page.locator('[data-testid="library-game"][data-pack="example-wiki"]').click();
  await expect(page.getByTestId('wiki-screen')).toBeVisible();
};

/** Adds the wiki with its first page, Welcome, following no links. */
async function addWiki(page: Page) {
  if (!(await page.getByTestId('library').isVisible())) {
    await page.getByTestId('section-library').click();
  }
  await page.getByTestId('add-map-url').fill(`${WIKI}/Contents`);
  await page.getByTestId('add-map-url').press('Enter');
  const flow = page.getByTestId('library-flow');
  await expect(flow).toHaveAttribute('data-phase', 'choose', { timeout: 30_000 });
  await page
    .getByTestId('add-map-choose-page')
    .filter({ hasText: 'Welcome' })
    .getByRole('checkbox')
    .check();
  await flow.getByTestId('follow-links').getByTestId('follow-links-ticked').click();
  await page.getByTestId('add-map-choose-confirm').click();
  await expect(flow).toHaveAttribute('data-run', 'finished', { timeout: 30_000 });
  await flow.getByTestId('library-flow-close').click();
  await wikiScreen(page);
}

/** Reads the pages ticked on the wiki's screen, in one go, and waits for its end: `last` fetched, the go over. */
async function readTicked(page: Page, last: string) {
  await page.getByTestId('wiki-read').click();
  await expect.poll(() => fetched(page), { timeout: 60_000 }).toContain(`${WIKI}/${last}`);
  await expect(page.getByTestId('wiki-stop')).toHaveCount(0, { timeout: 60_000 });
}

async function openInGuides(page: Page, query: string, title: string) {
  await page.getByTestId('section-guides').click();
  await page.getByTestId('guides-search').first().fill(query);
  await page.getByTestId('guides-result').filter({ hasText: title }).first().click();
  await expect(page.getByTestId('guides-page').locator('h1')).toHaveText(title);
}

test('pages read while the wiki is shown show at once; a forwarded page is one page under both names', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await setUp(page, true, { wiki: SITE });
  await addWiki(page);
  // The wiki is the game shown.
  await page.getByTestId('wiki-show-game').click();
  await expect(page.getByTestId('wiki-show-game')).toHaveCount(0);

  // The pages found on Welcome, read in one go.
  const before = await fetched(page);
  await page.getByTestId('wiki-found-tick').check();
  await readTicked(page, 'Gone');
  expect((await fetched(page)).slice(before.length)).toEqual([
    'https://wiki.example.org/robots.txt',
    `${WIKI}/Boats`,
    `${WIKI}/Old_lamp`,
    `${WIKI}/Gone`,
  ]);

  // One row for the forwarded page, under its own name; none for the old name.
  await expect(row(page, 'Lamp')).toHaveAttribute('data-state', 'read');
  await expect(row(page, 'Old lamp')).toHaveCount(0);
  await expect(row(page, 'Boats')).toHaveAttribute('data-state', 'read');
  // A page found that could not be read is a row of its own, with why.
  const gone = page.getByTestId('wiki-found-row');
  await expect(gone.getByTestId('wiki-row-state')).toHaveText(
    'Could not be read: The wiki has no such page. Found on Welcome',
  );
  await gone.getByTestId('wiki-row-open').click();
  await expect(page.getByTestId('wiki-preview-state')).toHaveText(
    'Could not be read: The wiki has no such page.',
  );
  await expect(gone).toBeVisible();

  // Without loading the app again, the page read shows its text: the game shown took it in.
  await row(page, 'Boats').getByTestId('wiki-row-open').click();
  await expect(page.getByTestId('wiki-preview-text')).toContainText('The boats leave at dawn.');

  // Another page linking to the old name: the old name is not fetched again.
  await row(page, 'Bells').getByTestId('wiki-row-tick').check();
  const choice = page.getByTestId('wiki-foot').getByTestId('follow-links');
  await choice.getByTestId('follow-links-linked').click();
  const second = await fetched(page);
  await readTicked(page, 'Bells');
  expect((await fetched(page)).slice(second.length)).toEqual([
    'https://wiki.example.org/robots.txt',
    `${WIKI}/Bells`,
  ]);
  await expect(row(page, 'Old lamp')).toHaveCount(0);

  // In Guides, the links are solid: to the page read in the go, and to the old name.
  await openInGuides(page, 'leave at dawn', 'Boats');
  await openInGuides(page, 'see the boats', 'Welcome');
  const shown = page.getByTestId('guides-page');
  await shown.locator('.app-link', { hasText: 'the boats' }).click();
  await expect(shown.locator('h1')).toHaveText('Boats');
  await openInGuides(page, 'ring the bell', 'Bells');
  await expect(shown.locator('.app-link-missing')).toHaveCount(0);
  await shown.locator('.app-link', { hasText: 'the old lamp' }).click();
  await expect(shown.locator('h1')).toHaveText('Lamp');
  expect(realErrors(errors)).toEqual([]);
});

test('a page read while the wiki is built again from its saved pages is kept', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  // Boats is listed in the contents here.
  await setUp(page, true, {
    wiki: { ...SITE, headings: [{ title: 'Basics', pages: ['Welcome', 'Bells', 'Boats'] }] },
  });
  await addWiki(page);
  await row(page, 'Bells').getByTestId('wiki-row-tick').check();
  await readTicked(page, 'Bells');
  await expect(row(page, 'Bells')).toHaveAttribute('data-state', 'read');

  // A slow build again: each saved page takes six seconds to hand over.
  const sources = async () => (await mock(page)).events.filter((e) => e.what === 'source').length;
  const asked = await sources();
  const saves = async () => (await mock(page)).events.filter((e) => e.what === 'save').length;
  const saved = await saves();
  await setMock(page, { slowSources: 6000 });
  await libraryMore(page, 'rebuild-pack');
  // The build has read the game as it was and is going through its saved pages.
  await expect.poll(sources, { timeout: 30_000 }).toBe(asked + 2);
  // Meanwhile, a page read: it waits for the build, then is added to the game as built.
  await wikiScreen(page);
  await row(page, 'Boats').getByTestId('wiki-row-tick').check();
  const choice = page.getByTestId('wiki-foot').getByTestId('follow-links');
  await choice.getByTestId('follow-links-ticked').click();
  await page.getByTestId('wiki-read').click();
  await expect(row(page, 'Boats').getByTestId('wiki-row-state')).toContainText(
    'waiting while this wiki is built again',
    { timeout: 10_000 },
  );
  await expect.poll(() => fetched(page), { timeout: 60_000 }).toContain(`${WIKI}/Boats`);
  await expect(page.getByTestId('wiki-stop')).toHaveCount(0, { timeout: 60_000 });
  // Both saved the game: the build, and the page read.
  await expect.poll(saves, { timeout: 30_000 }).toBe(saved + 2);
  await setMock(page, { slowSources: 0 });

  // Every page is in the game: none was lost to the other step's save.
  const show = page.getByTestId('wiki-show-game');
  if ((await show.count()) > 0) await show.click();
  for (const [query, title] of [
    ['see the boats', 'Welcome'],
    ['ring the bell', 'Bells'],
    ['leave at dawn', 'Boats'],
  ] as const) {
    await openInGuides(page, query, title);
  }
  expect(realErrors(errors)).toEqual([]);
});
