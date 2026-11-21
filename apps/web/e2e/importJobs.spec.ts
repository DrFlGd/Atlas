import { mkdir } from 'node:fs/promises';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, SITE as PASTED, openedPages, realErrors, setUp, url } from './fakeShell';
import { collectErrors, storedSetting } from './helpers';

/**
 * Jobs (`src/state/importJobs.ts`, `src/components/ImportJobs.tsx`):
 * imports saved to run later, listed in Downloads, against the stand-in
 * shell of `fakeShell.ts` and the made-up demo importer.
 */

const SHOTS = 'test-results/import-jobs';
const SITE = 'http://127.0.0.1:4432/demo-maps';

test.describe.configure({ timeout: 180_000 });
test.use({ deviceScaleFactor: 2 });
test.skip(!DOWNLOADS_BUILD, 'Jobs are listed in Downloads, in an app that downloads.');

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

test('saves imports as jobs, lists them in Downloads, changes them and runs them one after another', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await setUp(page);
  await page.getByTestId('add-map-button').click();

  // Map pages pasted: Save as a job reads nothing.
  await page
    .getByTestId('add-map-url')
    .fill([url('test-valley', 'east-field'), url('test-valley', 'west-ridge')].join('\n'));
  await page.getByTestId('add-map-save-job').click();
  await expect(page.getByText('Saved as a job: Demo map site: 2 pages.')).toBeVisible();
  // A game's address is opened to choose from, not saved as it is.
  await page.getByTestId('add-map-url').fill(`${PASTED}/test-valley`);
  await page.getByTestId('add-map-save-job').click();
  await expect(page.getByText('cannot be saved as a job as it is')).toBeVisible();
  await page.getByTestId('add-map-url').fill('');

  // The games of the list, to add one at a time.
  await page.getByTestId('add-map-browse-games').click();
  await expect(page.getByTestId('library-flow')).toHaveAttribute('data-phase', 'catalogue', {
    timeout: 30_000,
  });
  await page
    .getByTestId('add-map-catalogue-select')
    .getByRole('button', { name: 'Tick all' })
    .click();
  await page.getByTestId('add-map-catalogue-session').click();
  await page.getByTestId('games-plan-save-job').click();
  await expect(page.getByText('Saved as a job: Demo map site: 3 games.')).toBeVisible();
  await page.getByTestId('games-plan-back').click();
  const listOpened = (await openedPages(page)).length;

  await page.getByTestId('all-downloads').click();
  const panel = page.getByTestId('downloads-panel');
  const jobs = panel.getByTestId('saved-job');
  await expect(jobs).toHaveCount(2);
  await expect(jobs.nth(0).getByTestId('saved-job-text')).toHaveText(
    'Reads 2 map pages on Demo map site, one at a time.',
  );
  await expect(jobs.nth(1).getByTestId('saved-job-text')).toContainText(
    'Adds 3 games from Demo map site, one at a time',
  );
  await expect(jobs.nth(1).getByTestId('saved-job-text')).toContainText(
    'Files them under Demo console.',
  );

  // Rename, and change what it reads.
  const pagesJob = jobs.nth(0);
  await pagesJob.getByTestId('saved-job-rename').click();
  await pagesJob.getByTestId('saved-job-name-input').fill('East Field only');
  await pagesJob.getByTestId('saved-job-name-save').click();
  await expect(pagesJob.getByTestId('saved-job-name')).toHaveText('East Field only');
  await pagesJob.getByTestId('saved-job-change').click();
  await pagesJob.getByTestId('saved-job-pages').fill(url('test-valley', 'east-field'));
  await pagesJob.getByTestId('saved-job-change-save').click();
  await expect(pagesJob.getByTestId('saved-job-text')).toHaveText(
    'Reads 1 map page on Demo map site, one at a time.',
  );
  const gamesJob = jobs.nth(1);
  await gamesJob.getByTestId('saved-job-change').click();
  await gamesJob.getByTestId('saved-job-game').filter({ hasText: 'Demo again' }).click();
  await gamesJob.getByTestId('saved-job-change-save').click();
  await expect(gamesJob.getByTestId('saved-job-text')).toContainText('Adds 2 games');
  await panel.screenshot({ path: `${SHOTS}/1-jobs.png` });

  // Kept on this device, as settings: what each reads, never the pages.
  const kept = (await storedSetting(page, 'importJobs')) as { name: string }[];
  expect(kept.map((job) => job.name)).toEqual(['East Field only', 'Demo map site: 3 games']);

  // Started together: one after another, the second waiting its turn.
  await gamesJob.getByTestId('saved-job-start').click();
  await expect(gamesJob).toHaveAttribute('data-state', 'running');
  await expect(pagesJob.getByTestId('saved-job-start')).toHaveText('Start after the job running');
  await pagesJob.getByTestId('saved-job-start').click();
  await expect(pagesJob).toHaveAttribute('data-state', 'queued');
  await expect(pagesJob).toHaveAttribute('data-state', 'idle', { timeout: 150_000 });
  await expect(gamesJob.getByTestId('saved-job-last')).toContainText('2 games added.');
  // East Field was added by the games just before: it is read again, as a refresh.
  await expect(pagesJob.getByTestId('saved-job-last')).toContainText('refreshed');
  await panel.screenshot({ path: `${SHOTS}/2-jobs-ran.png` });
  // One page at a time with the pause between them, the games first (`openedPages` checks the pause).
  expect((await openedPages(page)).slice(listOpened)).toEqual([
    `${SITE}/test-valley`,
    `${SITE}/test-valley/east-field`,
    `${SITE}/test-valley/west-ridge`,
    `${SITE}/test-valley/checklists/beacons`,
    `${SITE}/test-hills/high-pass`,
    // The address as it was pasted.
    url('test-valley', 'east-field'),
  ]);

  // Removed after asking; what it added stays.
  await pagesJob.getByTestId('saved-job-remove').click();
  await pagesJob.getByTestId('saved-job-remove-confirm').click();
  await expect(jobs).toHaveCount(1);
  expect(realErrors(errors)).toEqual([]);
});
