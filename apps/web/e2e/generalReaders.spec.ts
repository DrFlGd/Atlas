import { mkdir } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { collectErrors, libraryMore, openLibraryGame, storedSetting } from './helpers';
import { expect, test } from './layout';
import {
  DOWNLOADS_BUILD,
  EXAMPLE_WIKI,
  WIKI,
  browseTo,
  mock,
  realErrors,
  setMock,
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
/** A wiki of a made-up farm whose terms allow no programs: read only as the person browses it. */
const ROOM: WikiSite = {
  headings: [{ title: 'Isle', pages: ['Welcome', 'Boats'] }],
  pages: {
    Welcome: {
      title: 'Welcome',
      body: 'The isle has boats.',
      links: ['Boats', 'Harbour'],
      licence: BY_SA_3,
      picture: 'A reed boat',
    },
    Boats: { title: 'Boats', body: 'Two oars each.', links: ['Welcome'], licence: BY_SA_3 },
    Harbour: { title: 'Harbour', body: 'Boats leave at dawn.', licence: BY_SA_3 },
    Gate: { title: 'Gate', body: 'Behind a check.', licence: BY_SA_3 },
  },
};
const ROOM_HOST = 'wiki.isle.reading-room.example';
const ROOM_WIKI = `https://${ROOM_HOST}/wiki`;
const ROOM_PACK = 'wiki-isle-reading-room-example-wiki';
const MARSH_PACK = 'wiki-marsh-example-wiki';
const DUNES_WIKI = 'https://wiki.dunes.example/wiki';
const DUNES_PACK = 'wiki-dunes-example-wiki';
/** A made-up wiki whose first page states no licence and the next one does. */
const FENS: WikiSite = {
  headings: [{ title: 'Wet', pages: ['Mist', 'Rushes'] }],
  pages: {
    Mist: { title: 'Mist', body: 'It hangs low.' },
    Rushes: { title: 'Rushes', body: 'They bend.', licence: BY_SA_3 },
  },
};
const FENS_HOST = 'wiki.fens.example';
const FENS_WIKI = `https://${FENS_HOST}/wiki`;
const OTHERS = {
  [MARSH_HOST]: MARSH,
  'wiki.dunes.example': MARSH,
  [ROOM_HOST]: ROOM,
  [FENS_HOST]: FENS,
};

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
  await expect(how.getByTestId('site-way-browse')).toContainText('As I browse');
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

  // Cancel: nothing is added.
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
  // No page of the wiki is in the Library yet, so adding it asks how again, the way ticked.
  await add(page, `${MARSH_WIKI}/Wicks`);
  await expect(flow).toHaveAttribute('data-phase', 'how');
  await expect(flow.getByTestId('site-ways')).toHaveAttribute('data-way', 'fetch');
  await flow.getByTestId('add-how-go').click();
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
  // Its own home page was not read: the landing page is made from its pages.
  await page.getByTestId('section-guides').click();
  await expect(page.getByTestId('guides-home')).toHaveAttribute('data-landing', 'made');
  await page.getByTestId('guides-tile').filter({ hasText: 'Wicks' }).click();
  await expect(page.getByTestId('guides-credit')).toContainText(
    'CC BY-NC-SA 4.0 (confirmed by you: the page states no licence)',
  );
  await openLibrary(page);
  await page.locator('[data-testid="library-game"][data-pack="wiki-marsh-example-wiki"]').click();
  await page.getByTestId('wiki-licence-forget').click();
  await expect(page.getByTestId('wiki-licence')).toHaveCount(0);
  expect(realErrors(errors)).toEqual([]);
});

test('a page that states no licence can be read under words the person fills in, or with none recorded, and its game is kept for personal use', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await setUp(page, true, { others: OTHERS });
  const flow = page.getByTestId('library-flow');
  const question = page.getByTestId('licence-question');
  const marshRow = page.locator(`[data-testid="library-game"][data-pack="${MARSH_PACK}"]`);

  // Fill in: the words are required, the address of the terms is https only, the rest optional.
  await add(page, `${MARSH_WIKI}/Wicks`);
  await flow.getByTestId('add-how-go').click();
  await expect(question).toBeVisible({ timeout: 30_000 });
  await expect(question.getByTestId('licence-answer')).toHaveAttribute('data-type', 'known');
  await expect(question.getByTestId('licence-type-none')).toContainText(
    'Nothing is recorded about permission, and the pages are kept for your own use.',
  );
  await question.getByTestId('licence-type-permission').click();
  await expect(question.getByTestId('licence-confirm')).toBeDisabled();
  await question
    .getByTestId('licence-words')
    .fill('Permission from the site’s owner for personal use');
  await expect(question.getByTestId('licence-confirm')).toBeEnabled();
  await question.getByTestId('licence-terms').fill(`http://${MARSH_HOST}/wiki/Terms`);
  await expect(question.getByTestId('licence-terms-error')).toBeVisible();
  await expect(question.getByTestId('licence-confirm')).toBeDisabled();
  await question.getByTestId('licence-terms').fill(`https://${MARSH_HOST}/wiki/Terms`);
  await question.getByTestId('licence-given-by').fill('The wiki’s owner');
  await question.getByTestId('licence-given-on').fill('2026-11-16');
  await question.getByTestId('licence-note').fill('Asked by mail.');
  await page.screenshot({ path: `${SHOTS}/licence-fill-in.png` });
  await question.getByTestId('licence-confirm').click();
  await expect(flow).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });

  // Under the page: the words, linked to the terms, with who gave it, when and the note.
  await page.getByTestId('section-guides').click();
  await page.getByTestId('guides-tile').filter({ hasText: 'Wicks' }).click();
  const licence = page.getByTestId('guides-licence');
  await expect(licence).toHaveAttribute('data-basis', 'permission');
  await expect(licence).toContainText(
    'Licence: Permission from the site’s owner for personal use (filled in by you',
  );
  await expect(licence).toContainText('given by The wiki’s owner on 16 November 2026');
  await expect(licence.getByRole('link')).toHaveAttribute(
    'href',
    `https://${MARSH_HOST}/wiki/Terms`,
  );
  await expect(page.getByTestId('guides-licence-note')).toHaveText('Note: Asked by mail.');

  // The game is kept for personal use: said in the Library's list and on its screen.
  await openLibrary(page);
  await expect(marshRow.getByTestId('library-personal-use')).toHaveText('For personal use');
  await marshRow.click();
  await expect(
    page.getByTestId('library-game-pane').getByTestId('library-personal-use'),
  ).toHaveText('For personal use');

  // The answer is changed on the wiki's screen, to blank; the next page reads under it.
  const kept = page.getByTestId('wiki-licence');
  await expect(kept).toHaveAttribute('data-type', 'permission');
  await expect(kept).toContainText(
    'You filled in this wiki’s licence: “Permission from the site’s owner for personal use”',
  );
  await kept.getByTestId('wiki-licence-edit').click();
  const change = page.getByTestId('wiki-licence-change');
  await expect(change.getByTestId('licence-words')).toHaveValue(
    'Permission from the site’s owner for personal use',
  );
  await change.getByTestId('licence-type-none').click();
  await change.getByTestId('licence-confirm').click();
  await expect(kept).toHaveAttribute('data-type', 'none');
  await expect(kept).toContainText('You chose to record no licence for this wiki');
  await add(page, `${MARSH_WIKI}/Glass`);
  await expect(flow).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
  await expect(question).toHaveCount(0);
  await flow.getByTestId('library-flow-close').click();
  await page.getByTestId('section-guides').click();
  await page.getByTestId('guides-tile').filter({ hasText: 'Glass' }).click();
  await expect(page.getByTestId('guides-licence')).toHaveAttribute('data-basis', 'none');
  await expect(page.getByTestId('guides-licence')).toHaveText(
    'No licence recorded. Kept for personal use.',
  );

  // Export is not held back; its dialog says what the file is for.
  await openLibrary(page);
  await marshRow.click();
  await libraryMore(page, 'export-pack');
  await expect(page.getByTestId('export-personal-use')).toHaveText(
    'This game is kept for personal use. The file is for your own devices.',
  );
  await page.keyboard.press('Escape');

  // Blank, answered in the question for another wiki: its game is kept for personal use too.
  await add(page, `${DUNES_WIKI}/Wicks`);
  await flow.getByTestId('add-how-go').click();
  await expect(question).toBeVisible({ timeout: 30_000 });
  await question.getByTestId('licence-type-none').click();
  await page.screenshot({ path: `${SHOTS}/licence-blank.png` });
  await question.getByTestId('licence-confirm').click();
  await expect(flow).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
  await flow.getByTestId('library-flow-close').click();
  await expect(
    page
      .locator(`[data-testid="library-game"][data-pack="${DUNES_PACK}"]`)
      .getByTestId('library-personal-use'),
  ).toHaveText('For personal use');
  expect(realErrors(errors)).toEqual([]);
});

test('browse and keep: each page the person opens is kept once; the app never opens a page itself, and stops when the window closes', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await setUp(page, true, { others: OTHERS });
  const flow = page.getByTestId('library-flow');

  // A wiki read only as the person browses it: its notice, one way, and Start browsing.
  await add(page, `${ROOM_WIKI}/Contents`);
  await expect(flow).toHaveAttribute('data-phase', 'how');
  await expect(flow.getByTestId('site-notice')).toContainText('do not allow programs');
  await expect(flow.getByTestId('site-ways')).toHaveCount(0);
  await flow.getByTestId('add-how-go').click();
  await expect(flow.getByTestId('add-how-go')).toHaveCount(0);
  await expect(flow).toHaveAttribute('data-phase', 'browse');
  const keep = flow.getByTestId('browse-keep');
  await expect(keep).toHaveAttribute('data-state', 'browsing');
  // The window opens where the person asked, to browse; nothing is fetched.
  expect((await mock(page)).events.filter((e) => e.what === 'open')).toEqual([
    expect.objectContaining({ url: `${ROOM_WIKI}/Contents`, browse: true }),
  ]);

  // The person opens pages: each is kept once it has loaded.
  await browseTo(page, `${ROOM_WIKI}/Welcome`);
  await expect(keep).toHaveAttribute('data-kept', '1', { timeout: 30_000 });
  await expect(keep.getByTestId('browse-keep-status')).toContainText('Kept: Welcome');
  await browseTo(page, `${ROOM_WIKI}/Boats`);
  await expect(keep).toHaveAttribute('data-kept', '2', { timeout: 30_000 });
  await expect(keep.getByTestId('browse-keep-status')).toContainText('Kept: Boats');
  await expect(page.getByTestId('library-strip-now')).toContainText(
    `browsing ${ROOM_HOST}. Kept: Boats, 2 pages kept`,
  );
  await page.screenshot({ path: `${SHOTS}/browse-in-progress.png` });

  // Back to a page kept before, a page the wiki does not have, a page behind a check: none is kept again.
  await setMock(page, { check: ['Gate'] });
  for (const slug of ['Welcome', 'Nowhere', 'Gate']) await browseTo(page, `${ROOM_WIKI}/${slug}`);
  await page.clock.runFor(5_000);
  await expect(keep).toHaveAttribute('data-kept', '2');
  const saved = (await mock(page)).reports.filter(
    (r) => r.outcome === 'added' || r.outcome === 'updated',
  );
  expect(saved).toHaveLength(2);
  // The picture Welcome showed was kept with it, from the page; nothing was fetched or moved.
  const shell = await mock(page);
  expect(shell.pictures[ROOM_PACK]).toEqual(['pictures/welcome-1.png']);
  expect(shell.events.filter((e) => e.what === 'fetch' || e.what === 'navigate')).toEqual([]);

  // The person closes the window: browsing ends, what was kept stays.
  await setMock(page, { close: ['Boats'] });
  await browseTo(page, `${ROOM_WIKI}/Boats`);
  await expect(keep).toHaveAttribute('data-state', 'ended', { timeout: 30_000 });
  await expect(keep).toHaveAttribute('data-kept', '2');

  // Its screen: Start browsing instead of a go; the contents are not read by this app;
  // the pages the kept pages link to are found, not read.
  await flow.getByTestId('library-flow-close').click();
  await page.locator(`[data-testid="library-game"][data-pack="${ROOM_PACK}"]`).click();
  const screen = page.getByTestId('wiki-screen');
  await expect(screen.getByTestId('wiki-browse')).toBeVisible();
  await expect(screen.getByTestId('wiki-read')).toHaveCount(0);
  await expect(screen.getByTestId('wiki-read-contents')).toHaveCount(0);
  await expect(screen.getByTestId('wiki-foot-sentence')).toContainText('read as you browse it');
  await expect(screen.getByTestId('wiki-found')).toContainText('Harbour');
  expect((await mock(page)).events.filter((e) => e.what === 'fetch')).toEqual([]);

  // Start browsing from its screen: the window opens again, browsing; Stop browsing ends it.
  await screen.getByTestId('wiki-browse').click();
  await expect(flow).toHaveAttribute('data-phase', 'browse');
  await expect(flow.getByTestId('browse-keep')).toHaveAttribute('data-state', 'browsing');
  await page.getByTestId('library-strip-stop-browsing').click();
  await expect(flow.getByTestId('browse-keep')).toHaveAttribute('data-state', 'ended', {
    timeout: 30_000,
  });
  expect((await mock(page)).events.filter((e) => e.what === 'close').length).toBeGreaterThan(0);
  expect(realErrors(errors)).toEqual([]);
});

/** Reads one page of a wiki, choosing how first: `way` ticked, then Read it. */
async function readOnePage(page: Page, address: string, way: 'fetch' | 'window') {
  const flow = page.getByTestId('library-flow');
  await add(page, address);
  await expect(flow).toHaveAttribute('data-phase', 'how');
  await flow.getByTestId(`site-way-${way}`).click();
  await flow.getByTestId('add-how-go').click();
  await expect(flow).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
  await flow.getByTestId('library-flow-close').click();
}

const wikiRow = (page: Page, pack: string) =>
  page.locator(`[data-testid="library-game"][data-pack="${pack}"]`);

test('a wiki is deleted by itself, with what this app remembers of its site; another wiki keeps its own, and adding it again asks how', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await setUp(page, true, { others: OTHERS });
  const flow = page.getByTestId('library-flow');
  // Two wikis of the same importer: the marsh read in a window, the dunes by itself.
  await readOnePage(page, `${MARSH_WIKI}/Lanterns`, 'window');
  await readOnePage(page, `${DUNES_WIKI}/Reeds`, 'fetch');
  expect(await storedSetting(page, 'wikiSites:other-wikis')).toEqual({
    [MARSH_HOST]: { way: 'window' },
    'wiki.dunes.example': { way: 'fetch' },
  });

  // More names the row for a wiki, and says only it goes.
  await openLibraryGame(page, MARSH_PACK);
  await page.getByTestId('library-more').click();
  const more = page.getByTestId('library-more-menu');
  const row = more.getByTestId('delete-pack');
  await expect(row).toContainText('Delete this wiki');
  await expect(row).toContainText(
    'Deletes only this wiki: the pages read from it, their pictures, and what this app remembers of its site. You are asked first, and told what happens to the marks you made.',
  );
  await expect(more.getByTestId('restart-wiki')).toContainText(
    'Start this wiki again from the beginning',
  );
  await row.click();

  // The confirmation: what goes, that only it goes, and what this app forgets.
  const confirm = page.getByTestId('delete-pack-confirm');
  await expect(confirm).toHaveAttribute('data-kind', 'wiki');
  await expect(confirm).toContainText(/Delete the wiki .+\?/);
  await expect(confirm).toContainText('with the pages read from it and their downloaded pictures');
  await expect(confirm.getByTestId('delete-pack-only')).toHaveText(
    'Only this wiki is deleted. Your other games stay.',
  );
  await expect(confirm.getByTestId('delete-pack-site')).toContainText(
    `This app also forgets what it remembers of the wiki’s site, ${MARSH_HOST}: its list of pages,`,
  );
  await page.screenshot({ path: `${SHOTS}/delete-wiki.png` });
  await confirm.getByTestId('confirm-delete-pack').click();
  await expect(wikiRow(page, MARSH_PACK)).toHaveCount(0);
  await expect(wikiRow(page, DUNES_PACK)).toHaveCount(1);
  expect((await mock(page)).events.filter((e) => e.what === 'delete').map((e) => e.url)).toEqual([
    MARSH_PACK,
  ]);

  // Forgotten: the way chosen for the marsh; the dunes keep theirs (the unit tests cover the rest).
  await expect
    .poll(() => storedSetting(page, 'wikiSites:other-wikis'))
    .toEqual({ 'wiki.dunes.example': { way: 'fetch' } });
  await openLibraryGame(page, DUNES_PACK);
  await expect(page.getByTestId('wiki-reading').getByTestId('site-ways')).toHaveAttribute(
    'data-way',
    'fetch',
  );

  // Added again: it asks how its pages are read, before anything is read.
  const before = (await mock(page)).events.length;
  await add(page, `${MARSH_WIKI}/Lanterns`);
  await expect(flow).toHaveAttribute('data-phase', 'how');
  await expect(flow.getByTestId('site-ways')).toHaveAttribute('data-way', 'fetch');
  await expect(flow.getByTestId('site-remembered')).toHaveCount(0);
  expect((await mock(page)).events.slice(before).filter((e) => e.what !== 'poll')).toEqual([]);
  expect(realErrors(errors)).toEqual([]);
});

test('a wiki whose session kept no page is asked how again, with the way chosen ticked, and can be forgotten whole', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await setUp(page, true, { others: OTHERS });
  const flow = page.getByTestId('library-flow');

  // Read in a window; its first page states no licence, and the person does not confirm one.
  await add(page, `${FENS_WIKI}/Contents`);
  await flow.getByTestId('site-way-window').click();
  await flow.getByTestId('add-how-go').click();
  await expect(flow).toHaveAttribute('data-phase', 'choose', { timeout: 30_000 });
  for (const title of ['Mist', 'Rushes']) {
    await page
      .getByTestId('add-map-choose-page')
      .filter({ hasText: title })
      .getByRole('checkbox')
      .check();
  }
  await flow.getByTestId('follow-links-ticked').click();
  await page.getByTestId('add-map-choose-confirm').click();
  const question = page.getByTestId('licence-question');
  await expect(question).toBeVisible({ timeout: 30_000 });
  await question.getByTestId('licence-decline').click();
  const run = flow.getByTestId('add-map-run');
  await expect(run).not.toHaveAttribute('data-status', 'running', { timeout: 30_000 });

  // No page kept: no wiki in the Library, a way to choose how, and the page kept for later.
  await expect(wikiRow(page, 'wiki-fens-example-wiki')).toHaveCount(0);
  await expect(run.getByTestId('add-map-how-offer')).toContainText('No page was kept.');
  await expect(run.getByTestId('add-map-how')).toHaveText('Choose how its pages are read');
  const queued = run.getByTestId('add-map-queued-game');
  await expect(queued).toContainText('No page of this wiki is in the Library yet.');
  await page.screenshot({ path: `${SHOTS}/no-page-kept.png` });

  // Choose how: the way chosen is ticked; another can be chosen.
  await run.getByTestId('add-map-how').click();
  await expect(flow).toHaveAttribute('data-phase', 'how');
  await expect(flow.getByTestId('site-ways')).toHaveAttribute('data-way', 'window');
  await flow.getByTestId('library-flow-close').click();

  // Added again: asked again, the way chosen ticked, with what is still remembered of it.
  await add(page, `${FENS_WIKI}/Contents`);
  await expect(flow).toHaveAttribute('data-phase', 'how');
  await expect(flow.getByTestId('site-ways')).toHaveAttribute('data-way', 'window');
  const remembered = flow.getByTestId('site-remembered');
  await expect(remembered).toContainText('its list of pages');
  await expect(remembered).toContainText('1 page kept for later');
  await flow.getByTestId('library-flow-close').click();

  // Forget this wiki, from the pages kept for later: asked first, then all of it goes.
  await openLibrary(page);
  await page.getByTestId('add-map-url').focus();
  const waiting = page.getByTestId('add-map-queued-game');
  await waiting.getByTestId('add-map-queued-forget-wiki').click();
  const forget = page.getByTestId('queued-forget-confirm');
  await expect(forget).toContainText(/Forget .+\?/);
  await expect(forget).toContainText(
    `This app forgets the 1 page kept for later and what it remembers of the wiki’s site, ${FENS_HOST}:`,
  );
  await forget.getByTestId('queued-forget-confirm-button').click();
  await expect(page.getByTestId('add-map-queued')).toHaveCount(0);
  await expect.poll(() => storedSetting(page, 'wikiSites:other-wikis')).toEqual({});
  expect(await storedSetting(page, 'wikiContents:other-wikis')).toEqual({});
  expect(await storedSetting(page, 'pageQueue:other-wikis')).toEqual([]);

  // Added again: the importer's first way, and nothing remembered.
  await add(page, `${FENS_WIKI}/Contents`);
  await expect(flow).toHaveAttribute('data-phase', 'how');
  await expect(flow.getByTestId('site-ways')).toHaveAttribute('data-way', 'fetch');
  await expect(flow.getByTestId('site-remembered')).toHaveCount(0);
  expect(realErrors(errors)).toEqual([]);
});

test('a wiki started again from the beginning: asked first, deleted, then asked how its pages are read', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await setUp(page, true, { others: OTHERS });
  const flow = page.getByTestId('library-flow');
  await readOnePage(page, `${MARSH_WIKI}/Lanterns`, 'window');

  await openLibraryGame(page, MARSH_PACK);
  await page.getByTestId('library-more').click();
  const row = page.getByTestId('library-more-menu').getByTestId('restart-wiki');
  await expect(row).toContainText(
    'Deletes the pages read from this wiki and what this app remembers of its site, then asks again how its pages are read. Your own pages, notes, lists and found marks stay. You are asked first.',
  );
  await row.click();
  const confirm = page.getByTestId('restart-wiki-confirm');
  await expect(confirm).toContainText(/Start the wiki .+ again from the beginning\?/);
  await expect(confirm).toContainText(
    'from the maps folder, with the pages read from it and their downloaded pictures. This cannot be undone.',
  );
  await expect(confirm.getByTestId('restart-wiki-site')).toContainText(
    `This app also forgets what it remembers of the wiki’s site, ${MARSH_HOST}:`,
  );
  await expect(confirm.getByTestId('restart-wiki-kept')).toHaveText(
    'Your own pages, notes, lists and found marks for this wiki are kept.',
  );
  await expect(confirm.getByTestId('restart-wiki-next')).toContainText(
    `Then the address box holds its start address, ${MARSH_WIKI}/Contents,`,
  );
  await page.screenshot({ path: `${SHOTS}/start-wiki-again.png` });
  const before = (await mock(page)).events.filter((e) => e.what !== 'poll').length;
  await confirm.getByTestId('confirm-restart-wiki').click();

  // Deleted, and the steps of adding ask how its pages are read; nothing is read.
  await expect(flow).toHaveAttribute('data-phase', 'how');
  await expect(wikiRow(page, MARSH_PACK)).toHaveCount(0);
  await expect(page.getByTestId('add-map-url')).toHaveValue(`${MARSH_WIKI}/Contents`);
  await expect(flow.getByTestId('site-ways')).toHaveAttribute('data-way', 'fetch');
  expect(
    (await mock(page)).events
      .filter((e) => e.what !== 'poll')
      .slice(before)
      .map((e) => e.what),
  ).toEqual(['delete']);

  // Read by itself this time: its contents, then the page ticked; the wiki is back.
  await flow.getByTestId('add-how-go').click();
  await expect(flow).toHaveAttribute('data-phase', 'choose', { timeout: 30_000 });
  await page
    .getByTestId('add-map-choose-page')
    .filter({ hasText: 'Lanterns' })
    .getByRole('checkbox')
    .check();
  await flow.getByTestId('follow-links-ticked').click();
  await page.getByTestId('add-map-choose-confirm').click();
  await expect(flow).toHaveAttribute('data-run', 'finished', { timeout: 30_000 });
  await expect(wikiRow(page, MARSH_PACK)).toHaveCount(1);
  expect(await storedSetting(page, 'wikiSites:other-wikis')).toEqual({
    [MARSH_HOST]: { way: 'fetch' },
  });
  expect(realErrors(errors)).toEqual([]);
});
