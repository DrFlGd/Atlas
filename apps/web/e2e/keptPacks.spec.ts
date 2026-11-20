import type { Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, mock, realErrors, setKeptPacks, setUp } from './fakeShell';

/**
 * Settings, "Keep packs for Game Repo up to date", against the stand-in
 * shell of `fakeShell.ts`, which keeps the setting's state and answers its
 * commands as the shell's `keep` module does. The games are made up. Only
 * Atlas Importer keeps packs up to date, so these tests run in the build
 * with downloads.
 */

test.use({ layout: 'standard' });
test.skip(!DOWNLOADS_BUILD, 'Only a build with downloads keeps packs up to date.');

const GAMES = [
  {
    id: 'test-valley',
    title: 'Test Valley',
    state: 'up-to-date',
    path: '/repo/Maps and Guides/No game yet/Test Valley - Example Site.atlaspack',
    writtenAt: '2026-11-12T10:00:00Z',
    reason: null,
    extraCopies: [],
  },
  {
    id: 'example-game',
    title: 'Example Game',
    state: 'not-in-folder',
    path: '/repo/Maps and Guides/Example Game.atlaspack',
    writtenAt: '2026-11-11T10:00:00Z',
    reason: 'Its pack is not in the folder any more, so it is not written again unless you ask.',
    extraCopies: [],
  },
  {
    id: 'example-site',
    title: 'Example Site',
    state: 'left-out',
    path: null,
    writtenAt: null,
    reason: 'It was imported from a pack file, so its pack file is the one to keep.',
    extraCopies: [],
  },
];

async function openKeptPacks(page: Page) {
  await page.getByTestId('section-settings').click();
  const section = page.getByTestId('settings-kept-packs');
  await expect(section).toBeVisible();
  return section;
}

const row = (page: Page, id: string) =>
  page.locator(`[data-testid="kept-pack-row"][data-id="${id}"]`);

test('turns on in the packs folder or in a folder chosen in the dialog, lists each game and writes one again', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await setUp(page, true);
  const section = await openKeptPacks(page);
  await expect(section.getByRole('heading')).toHaveText('Keep packs for Game Repo up to date');
  await expect(section.getByTestId('kept-packs-status')).toHaveText(
    'Off. No pack files are written.',
  );
  await expect(section.getByTestId('kept-packs-folder')).toHaveText(
    '/maps/packsDefault: the packs folder',
  );

  // On with no folder chosen: in the packs folder, without a dialog.
  await section.getByTestId('kept-packs-switch').click({ force: true });
  await expect(section.getByTestId('kept-packs-switch')).toBeChecked();
  await expect(section.getByTestId('kept-packs-folder')).toContainText('the packs folder');
  await section.getByTestId('kept-packs-switch').click({ force: true });
  await expect(section.getByTestId('kept-packs-switch')).not.toBeChecked();

  // The dialog closed: nothing changes.
  await section.getByTestId('kept-packs-choose').click();
  await expect(section.getByTestId('kept-packs-switch')).not.toBeChecked();

  // A folder chosen: on, with each game and its state.
  await setKeptPacks(page, { pick: '/repo/Maps and Guides', games: GAMES });
  await section.getByTestId('kept-packs-choose').click();
  await expect(section.getByTestId('kept-packs-switch')).toBeChecked();
  await expect(section.getByTestId('kept-packs-folder')).toHaveText('/repo/Maps and Guides');
  await expect(section.getByTestId('kept-packs-status')).toContainText(
    '1 up to date, 1 not in the folder.',
  );
  await expect(row(page, 'test-valley')).toContainText('Up to date');
  await expect(row(page, 'test-valley')).toContainText('Test Valley - Example Site.atlaspack');
  await expect(row(page, 'example-site')).toContainText('Left out');
  await expect(row(page, 'example-site')).toContainText('imported from a pack file');
  await expect(row(page, 'example-game')).toContainText('Not in the folder');

  await row(page, 'example-game').getByTestId('kept-pack-write-again').click();
  await expect(row(page, 'example-game')).toHaveAttribute('data-state', 'up-to-date');
  await expect(row(page, 'example-game').getByTestId('kept-pack-write-again')).toHaveCount(0);

  await section.getByTestId('kept-packs-schedule').selectOption('weekly');
  await section.getByTestId('kept-packs-write-all').click();
  await expect(section.getByTestId('kept-packs-status')).toContainText('2 up to date.');

  // Off again: the folder stays as chosen.
  await section.getByTestId('kept-packs-switch').click({ force: true });
  await expect(section.getByTestId('kept-packs-status')).toHaveText(
    'Off. No pack files are written.',
  );
  await expect(section.getByTestId('kept-packs-games')).toHaveCount(0);
  const calls = (await mock(page)).keptPacks.calls.filter((call) => call !== 'kept_packs_status');
  expect(calls).toEqual([
    'kept_packs_set on start',
    'kept_packs_set off start',
    'kept_packs_choose_folder',
    'kept_packs_choose_folder',
    'kept_packs_write_again example-game',
    'kept_packs_set on weekly',
    'kept_packs_write_all',
    'kept_packs_set off weekly',
  ]);
  expect(realErrors(errors)).toEqual([]);
});
