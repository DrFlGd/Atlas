import { mkdir } from 'node:fs/promises';
import { expect, test } from './layout';
import {
  DOWNLOADS_BUILD,
  expectStates,
  mock,
  openedPages,
  paste,
  rows,
  setMock,
  setUp,
  url,
} from './fakeShell';
import { collectErrors } from './helpers';

/**
 * "Add a map" with several addresses, against a stand-in for the desktop
 * shell (`fakeShell.ts`). Nothing is opened and no site is asked for
 * anything; the real import window is covered by the desktop tests.
 */

const SHOTS = 'test-results/add-maps';

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

test('adds several maps one after another, with a state for each and a summary', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await setUp(page);
  await paste(
    page,
    [
      `  ${url('test-valley', 'east-field')}`,
      `${url('test-valley', 'west-ridge')}, ${url('test-valley', 'east-field')}`,
      'https://other.example.org/maps/somewhere',
      `${url('demo', 'plain')} ${url('test-valley', 'broken')}`,
      url('test-hills', 'high-pass'),
    ].join('\n'),
  );
  // Six different addresses; the repeat is counted once.
  await expect(page.getByTestId('add-map-start')).toHaveText('Add 6 maps');
  await page.screenshot({ path: `${SHOTS}/0-form.png` });
  await page.getByTestId('add-map-start').click();

  // The address no importer recognises is shown before anything opens.
  const check = page.getByTestId('add-map-check');
  await expect(check).toContainText('One address cannot be added. The other 5 can');
  const checked = page.getByTestId('add-map-check-address');
  await expect(checked).toHaveCount(6);
  await expect(checked.nth(2)).toHaveAttribute('data-state', 'left-out');
  await expect(checked.nth(2)).toContainText('No importer in this app recognises this address.');
  expect((await mock(page)).events).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/1-check.png` });

  // The second page holds on to its data for a while.
  await setMock(page, { hold: ['west-ridge'] });
  await page.getByTestId('add-map-confirm').click();
  const dialog = page.getByTestId('library-flow');
  await expect(dialog).toHaveAttribute('data-phase', 'run');
  await expect(dialog).toHaveAttribute('data-run', 'running');
  await expect(rows(page).nth(0)).toHaveAttribute('data-state', 'added');
  await expect(rows(page).nth(0)).toContainText('Added “East Field” to Test Valley');
  await expect(rows(page).nth(1)).toHaveAttribute('data-state', 'open');
  await expect(rows(page).nth(2)).toHaveText(/Waiting$/);
  // After a while the open page gets the hint to look at its window.
  await page.clock.fastForward(21_000);
  await expect(rows(page).nth(1).getByTestId('add-map-still-waiting')).toContainText(
    'if it asks you to sign in, to confirm you are a person or to wait, deal with it there',
  );
  await page.screenshot({ path: `${SHOTS}/2-running.png` });
  await setMock(page, { hold: [] });

  await expect(dialog).toHaveAttribute('data-run', 'finished', { timeout: 30_000 });
  await expectStates(page, ['added', 'added', 'failed', 'failed', 'added']);
  await expect(rows(page).nth(1)).toContainText('Added “West Ridge” to Test Valley');
  await expect(rows(page).nth(2)).toContainText('Not added: Demo again comes with this app');
  await expect(rows(page).nth(3)).toContainText('Not added: The page did not hold demo map data');
  await expect(rows(page).nth(4)).toContainText('Added “High Pass” to Test Hills');
  await expect(page.getByTestId('add-map-summary')).toHaveText('3 maps added, 2 not added.');
  await expect(page.getByTestId('add-map-run')).toContainText('One address was left out');

  // Every page once, in order, one at a time, with the pause between.
  expect(await openedPages(page)).toEqual([
    url('test-valley', 'east-field'),
    url('test-valley', 'west-ridge'),
    url('demo', 'plain'),
    url('test-valley', 'broken'),
    url('test-hills', 'high-pass'),
  ]);

  // The game of the last map added is shown.
  await expect(
    page.locator('.topbar select').filter({ has: page.locator('option[value="test-hills"]') }),
  ).toHaveValue('test-hills');
  // The download is offered once, for the game shown.
  await expect(page.getByTestId('add-map-download')).toHaveCount(DOWNLOADS_BUILD ? 1 : 0);
  if (DOWNLOADS_BUILD) {
    await expect(page.getByTestId('add-map-download')).toHaveText(
      'Download map images of Test Hills…',
    );
  }
  await expect(page.getByTestId('add-map-images-note')).toContainText(
    DOWNLOADS_BUILD ? 'Test Hills is shown now' : 'Their map images are not installed',
  );
  await page.screenshot({ path: `${SHOTS}/3-finished.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SHOTS}/3-finished-narrow.png` });
  await page.setViewportSize({ width: 1280, height: 800 });

  // The activity log: the start with the pages, every page, the summary.
  const reports = (await mock(page)).reports;
  expect(reports[0]).toMatchObject({ outcome: 'run-started', run: { leftOut: 1 } });
  expect(reports[0]!.pages).toHaveLength(5);
  expect(reports.map((r) => r.outcome)).toEqual([
    'run-started',
    'added',
    'added',
    'failed',
    'failed',
    'added',
    'run-finished',
  ]);
  expect(reports.at(-1)).toMatchObject({
    run: { added: 3, refreshed: 0, notAdded: 2, notStarted: 0, leftOut: 1 },
  });

  // Adding a page of it again refreshes it.
  await page.getByRole('button', { name: 'Add more', exact: true }).click();
  await page
    .getByTestId('add-map-url')
    .fill(`${url('test-valley', 'west-ridge')}\n${url('test-hills', 'high-pass')}`);
  await page.getByTestId('add-map-start').click();
  await expect(dialog).toHaveAttribute('data-run', 'finished', { timeout: 30_000 });
  await expect(rows(page).nth(0)).toContainText('Refreshed “West Ridge” in Test Valley');
  await expect(page.getByTestId('add-map-summary')).toHaveText('2 maps refreshed.');

  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
});

test('stops after two pages in a row without data', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page);
  await paste(
    page,
    [
      url('test-valley', 'never'),
      url('test-hills', 'never'),
      url('test-valley', 'east-field'),
    ].join('\n'),
  );
  await page.getByTestId('add-map-start').click();
  const dialog = page.getByTestId('library-flow');
  await expect(rows(page).nth(0)).toHaveAttribute('data-state', 'open');
  // The demo importer waits 30 seconds for each page.
  await page.clock.fastForward(31_000);
  await expect(rows(page).nth(0)).toHaveAttribute('data-state', 'failed');
  await expect(rows(page).nth(0)).toContainText('did not provide the map data within 30 seconds');
  await expect(rows(page).nth(1)).toHaveAttribute('data-state', 'open', { timeout: 10_000 });
  await page.clock.fastForward(31_000);
  await expect(dialog).toHaveAttribute('data-run', 'stopped');
  await expectStates(page, ['failed', 'failed', 'not-started']);
  await expect(page.getByTestId('add-map-stopped')).toContainText(
    'Two pages in a row did not provide their map data, so this app stopped rather than open the rest.',
  );
  await expect(page.getByTestId('add-map-summary')).toHaveText('2 maps not added, 1 not started.');
  expect(await openedPages(page)).toEqual([
    url('test-valley', 'never'),
    url('test-hills', 'never'),
  ]);
  await page.screenshot({ path: `${SHOTS}/4-no-data.png` });
  const outcomes = (await mock(page)).reports.map((r) => r.outcome);
  expect(outcomes).toEqual([
    'run-started',
    'timed-out',
    'timed-out',
    'run-stopped',
    'run-finished',
  ]);
  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
});

test('Stop ends the run after the open page, and closing the page window ends it at once', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await setUp(page);
  const three = [
    url('test-valley', 'east-field'),
    url('test-valley', 'west-ridge'),
    url('test-hills', 'high-pass'),
  ];
  await setMock(page, { hold: ['east-field'] });
  await paste(page, three.join('\n'));
  await page.getByTestId('add-map-start').click();
  await expect(rows(page).nth(0)).toHaveAttribute('data-state', 'open');
  await page.getByTestId('add-map-stop').click();
  await expect(page.getByTestId('add-map-stopping')).toContainText(
    'This app stops after the page that is open now.',
  );
  await expect(page.getByTestId('add-map-stop')).toBeDisabled();
  await setMock(page, { hold: [] });
  const dialog = page.getByTestId('library-flow');
  await expect(dialog).toHaveAttribute('data-run', 'stopped');
  await expectStates(page, ['added', 'not-started', 'not-started']);
  await expect(page.getByTestId('add-map-stopped')).toHaveText(
    'You stopped adding maps, so the pages after that were not opened.',
  );
  await expect(page.getByTestId('add-map-summary')).toHaveText('1 map added, 2 not started.');
  await expect(
    page.locator('.topbar select').filter({ has: page.locator('option[value="test-valley"]') }),
  ).toHaveValue('test-valley');

  // The person closes the window of the second page: the run stops there.
  await page.getByRole('button', { name: 'Add more', exact: true }).click();
  await setMock(page, { close: ['west-ridge'] });
  await page.getByTestId('add-map-url').fill(three.join(', '));
  await page.getByTestId('add-map-start').click();
  await expect(dialog).toHaveAttribute('data-run', 'stopped', { timeout: 30_000 });
  await expectStates(page, ['added', 'failed', 'not-started']);
  await expect(rows(page).nth(1)).toContainText(
    'Not added: The page window was closed before the page provided the map data.',
  );
  await expect(page.getByTestId('add-map-stopped')).toHaveText(
    'The page window was closed, so this app stopped and opened no more pages.',
  );
  await expect(page.getByTestId('add-map-summary')).toHaveText(
    '1 map refreshed, 1 not added, 1 not started.',
  );
  await page.screenshot({ path: `${SHOTS}/5-closed.png` });
  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
});

test('one address works as before, and too many are refused', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page);
  await paste(page, ` ${url('test-valley', 'east-field')} `);
  await expect(page.getByTestId('add-map-start')).toHaveText('Add');
  await page.getByTestId('add-map-url').press('Enter');
  const dialog = page.getByTestId('library-flow');
  await expect(dialog).toHaveAttribute('data-phase', 'done');
  await expect(page.getByTestId('add-map-game')).toHaveText('Test Valley');
  await expect(page.getByTestId('add-map-run')).toHaveCount(0);
  expect((await mock(page)).reports.map((r) => r.outcome)).toEqual(['added']);

  await page.getByRole('button', { name: 'Add another', exact: true }).click();
  await expect(page.getByTestId('add-map-url')).toHaveValue('');
  await page
    .getByTestId('add-map-url')
    .fill(Array.from({ length: 26 }, (_, i) => url('test-valley', `map-${i}`)).join('\n'));
  await page.getByTestId('add-map-start').click();
  await expect(page.getByTestId('add-map-error')).toHaveText(
    'That is 26 addresses. This app adds at most 25 maps at a time, so remove some and add them afterwards.',
  );
  expect((await mock(page)).events.filter((e) => e.what === 'open')).toHaveLength(1);

  // Only addresses that cannot be added: nothing to start.
  await page.getByTestId('add-map-url').fill('https://other.example.org/a\nnot-an-address');
  await page.getByTestId('add-map-start').click();
  await expect(page.getByTestId('add-map-check')).toContainText(
    'None of these addresses can be added.',
  );
  await expect(page.getByTestId('add-map-check-address').nth(1)).toContainText(
    'This is not a web address this app can open.',
  );
  await expect(page.getByTestId('add-map-confirm')).toHaveCount(0);
  await page.getByTestId('add-map-edit').click();
  await expect(page.getByTestId('add-map-url')).toHaveValue(
    'https://other.example.org/a\nnot-an-address',
  );
  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
});
