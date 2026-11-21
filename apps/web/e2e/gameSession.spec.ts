import { mkdir } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from './layout';
import { mock, openedPages, realErrors, setMock, setUp } from './fakeShell';
import { collectErrors, storedSetting } from './helpers';

/**
 * Adding the games of a site's list one after another
 * (`src/state/gameSession.ts`, `src/components/GameSession.tsx`), against
 * the stand-in shell of `fakeShell.ts` and the made-up demo importer, whose
 * list of worlds says the system of its worlds and the maps of a world
 * with one map.
 */

const SHOTS = 'test-results/game-session';
const CATALOGUE = 'http://127.0.0.1:4432/demo-maps';

// Each page waits a few seconds, with the pause between pages.
test.describe.configure({ timeout: 180_000 });

test.use({ deviceScaleFactor: 2 });

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

const flow = (page: Page) => page.getByTestId('library-flow');

/** A game here before, of the same title as a world of the list (tidied). */
async function serveGameHere(page: Page): Promise<void> {
  await page.route('**/packs/index.json', (route) =>
    route.fulfill({
      json: {
        packs: [
          { id: 'demo', url: 'packs/demo/', title: 'Atlas demo world' },
          { id: 'valley-before', url: 'packs/valley-before/', title: 'Test valley' },
        ],
      },
    }),
  );
}

/** Browse the list of worlds, Tick all, and plan adding them one at a time. */
async function planAll(page: Page): Promise<void> {
  await page.getByTestId('add-map-button').click();
  await page.getByTestId('add-map-browse-games').click();
  await expect(flow(page)).toHaveAttribute('data-phase', 'catalogue', { timeout: 30_000 });
  await page
    .getByTestId('add-map-catalogue-select')
    .getByRole('button', { name: 'Tick all' })
    .click();
  await page.getByTestId('add-map-catalogue-session').click();
  await expect(page.getByTestId('games-plan')).toBeVisible();
}

test('adds every game ticked in a list, one at a time, filed under its system and matched by title', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await serveGameHere(page);
  await setUp(page);
  await planAll(page);

  const plan = page.getByTestId('games-plan');
  await expect(plan).toContainText('Add 3 games from Demo map site, one at a time.');
  await expect(plan.getByTestId('games-plan-game')).toHaveText([
    /Test Valley/,
    /Test Hills\s*1 map/,
    /Demo again\s*1 map/,
  ]);
  // What the list says before anything is read, and the room there is.
  await expect(plan.getByTestId('games-plan-totals')).toContainText(
    '2 maps, and the list does not say how many maps 1 other game has.',
  );
  await expect(plan.getByTestId('games-plan-space')).toContainText(
    'The list does not say how much room the games take',
  );
  await expect(plan.getByTestId('games-plan-space')).toContainText(
    '3.0 GB is free on the drive of your maps folder.',
  );
  await expect(plan.getByTestId('games-plan-system')).toHaveValue('Demo console');
  await page.screenshot({ path: `${SHOTS}/1-plan.png` });
  // Nothing was read for the plan but the list itself.
  expect(await openedPages(page)).toEqual([CATALOGUE]);

  await page.getByTestId('games-plan-start').click();
  await expect(page.getByTestId('games-bar')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('games-done')).toBeVisible({ timeout: 150_000 });
  await page.screenshot({ path: `${SHOTS}/2-done.png` });

  // One page at a time, with the pause between them (`openedPages` checks it).
  expect(await openedPages(page)).toEqual([
    CATALOGUE,
    `${CATALOGUE}/test-valley`,
    `${CATALOGUE}/test-valley/east-field`,
    `${CATALOGUE}/test-valley/west-ridge`,
    `${CATALOGUE}/test-valley/checklists/beacons`,
    `${CATALOGUE}/test-hills/high-pass`,
    `${CATALOGUE}/demo/plain`,
  ]);
  const games = page.getByTestId('games-done').getByTestId('games-game');
  await expect(games.nth(0)).toHaveAttribute('data-state', 'added');
  await expect(games.nth(0)).toContainText('3 pages added. Filed under Demo console.');
  await expect(games.nth(0)).toContainText('Shown under one title: Test valley.');
  await expect(games.nth(1)).toHaveAttribute('data-state', 'added');

  // Shown with the game of the same title here; the others are listed, not matched.
  const groups = (await storedSetting(page, 'gameGroups')) as string;
  expect(
    (
      JSON.parse(groups) as { groups: { title: string; members: { gameId: string }[] }[] }
    ).groups.map((group) => [group.title, group.members.map((member) => member.gameId)]),
  ).toEqual([['Test valley', ['valley-before', 'test-valley']]]);
  const unmatched = page.getByTestId('games-unmatched-game');
  await expect(unmatched.first()).toHaveAttribute('data-game', 'test-hills');
  await expect(unmatched.first()).toContainText('No game here has this title.');

  // Filed under the list's system, in the Library's System tag.
  const tags = (await storedSetting(page, 'gameTags')) as {
    tags: Record<string, Record<string, string[]>>;
  };
  expect(tags.tags['game:test-valley']).toEqual({ system: ['Demo console'] });
  expect(tags.tags['game:test-hills']).toEqual({ system: ['Demo console'] });
  // Nothing is left to continue.
  expect(await storedSetting(page, 'gameSession')).toBeNull();
  expect((await mock(page)).reports.filter((r) => r.outcome === 'run-started')).toHaveLength(3);
  expect(realErrors(errors)).toEqual([]);
});

test('stops when the page window is closed, keeps what is left, and continues later', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await setUp(page);
  await planAll(page);
  await page.getByTestId('games-plan-system').fill('');
  // The person closes the window of the second map of the first game.
  await setMock(page, { close: ['west-ridge'] });
  await page.getByTestId('games-plan-start').click();
  const done = page.getByTestId('games-done');
  await expect(done).toBeVisible({ timeout: 120_000 });
  await expect(done.getByTestId('games-stopped')).toContainText('The page window was closed');
  await expect(done.getByTestId('games-summary')).toHaveText(
    '0 games added from Demo map site, 3 games left.',
  );
  await expect(done.getByTestId('games-game').first()).toHaveAttribute('data-state', 'partial');
  await page.screenshot({ path: `${SHOTS}/3-stopped.png` });

  // Kept: the steps of adding offer to continue, and show what is left first.
  await setMock(page, { close: [] });
  await done.getByTestId('games-close').click();
  const kept = page.getByTestId('games-kept');
  await expect(kept).toContainText('3 games from Demo map site left to add.');
  await kept.getByTestId('games-kept-continue').click();
  const plan = page.getByTestId('games-plan');
  await expect(plan).toContainText('3 games left to add from Demo map site, of 3.');
  // The window the person closed has no close of the app's own: the windows opened, as noted.
  const opens = async () =>
    (await mock(page)).events.flatMap((event) => (event.what === 'open' ? [event.url ?? ''] : []));
  const before = (await opens()).length;
  await plan.getByTestId('games-plan-start').click();
  await expect(page.getByTestId('games-done')).toBeVisible({ timeout: 150_000 });
  // The world named like the game this app comes with is not added over it, and the session goes on.
  await expect(page.getByTestId('games-summary')).toHaveText('2 games added from Demo map site.');
  await expect(page.locator('[data-testid="games-game"][data-game="demo"]')).toHaveAttribute(
    'data-state',
    'failed',
  );
  // East Field was added before: it is not read again.
  const opened = (await opens()).slice(before);
  expect(opened.filter((address) => address.endsWith('/east-field'))).toEqual([]);
  expect(opened.filter((address) => address.endsWith('/west-ridge'))).toHaveLength(1);
  // Without a system, nothing is filed.
  const tags = (await storedSetting(page, 'gameTags')) as
    { tags: Record<string, unknown> } | undefined;
  expect(tags?.tags['game:test-hills']).toBeUndefined();
  expect(await storedSetting(page, 'gameSession')).toBeNull();
  expect(realErrors(errors)).toEqual([]);
});
