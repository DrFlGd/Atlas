import type { Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, mock, realErrors, setPacksFolder, setUp } from './fakeShell';

/**
 * Settings, the packs folder under "Games in other folders": Change packs
 * folder…, Use the default folder and the question before anything
 * changes, against the stand-in shell of `fakeShell.ts`, which answers as
 * the shell's `library/packsfolder.rs` does. The folders are made up; the
 * real moves are covered by the shell's own tests.
 */

test.use({ layout: 'standard' });

const DEFAULT = '/home/test/.local/share/atlas/packs';

async function openPacksFolder(page: Page) {
  await page.getByTestId('section-settings').click();
  const section = page.getByTestId('packs-folder');
  await expect(section).toBeVisible();
  return section;
}

const calls = async (page: Page) => (await mock(page)).packsFolder.calls;

test('changes the packs folder, moving the pack files there, and goes back to the default', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await setUp(page, DOWNLOADS_BUILD, { packsFolder: true });
  const section = await openPacksFolder(page);
  await expect(section).toContainText(`Packs folder: ${DEFAULT}`);
  await expect(section.getByTestId('packs-folder-default')).toHaveText('Default');
  await expect(section.getByTestId('default-packs-folder')).toHaveCount(0);
  await expect(section).toContainText(
    'Change packs folder chooses another folder and then asks whether to move the pack files there. Every Atlas app on this computer uses the same packs folder.',
  );

  // The dialog closed: nothing is asked and nothing changes.
  await section.getByTestId('change-packs-folder').click();
  await expect(section.getByTestId('packs-folder-confirm')).toHaveCount(0);

  // A folder picked: the question names both folders, the files and their size.
  await setPacksFolder(page, { pick: '/home/test/Packs' });
  await section.getByTestId('change-packs-folder').click();
  const confirm = section.getByRole('group', { name: 'Use the new packs folder?' });
  await expect(confirm).toContainText('Use /home/test/Packs as the packs folder from now on?');
  await expect(confirm).toContainText(
    `The packs folder now is ${DEFAULT}. It holds 2 pack files (3.4 MB).`,
  );
  await expect(confirm).toContainText('quick, as the new folder is on the same drive');
  await expect(confirm).toContainText(
    'If you leave them where they are, Atlas no longer shows the pack files in the old folder, unless you add that folder under Games in other folders.',
  );
  await expect(confirm.getByRole('button')).toHaveText([
    'Move the pack files there',
    'Leave them where they are',
    'Cancel',
  ]);

  // Cancel changes nothing.
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(section.getByTestId('packs-folder-confirm')).toHaveCount(0);
  await expect(section).toContainText(`Packs folder: ${DEFAULT}`);

  // Moved, with one file in use left behind: it is named, with why.
  await setPacksFolder(page, {
    pick: '/media/usb/Packs',
    left: [
      {
        path: `${DEFAULT}/Test Valley.atlaspack`,
        reason:
          'It is in use by another program or cannot be changed, so it stays in the old folder.',
      },
    ],
  });
  await section.getByTestId('change-packs-folder').click();
  await expect(confirm).toContainText(
    'The new folder is on another drive, so moving copies each pack file there, checks the copy and only then deletes the original.',
  );
  await confirm.getByRole('button', { name: 'Move the pack files there' }).click();
  await expect(section.getByTestId('packs-folder-confirm')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toContainText(
    'The packs folder is now /media/usb/Packs. Moved 1 pack file there. One pack file could not be moved and stays in the old folder.',
  );
  await expect(section).toContainText('Packs folder: /media/usb/Packs');
  await expect(section.getByTestId('packs-folder-default')).toHaveCount(0);
  await expect(section.getByTestId('packs-folder-left')).toContainText(
    `${DEFAULT}/Test Valley.atlaspack: It is in use by another program`,
  );

  // Back to the default, leaving the files where they are.
  await section.getByTestId('default-packs-folder').click();
  await expect(confirm).toContainText(`Use the default packs folder, ${DEFAULT}, from now on?`);
  await confirm.getByRole('button', { name: 'Leave them where they are' }).click();
  await expect(page.getByTestId('toast')).toContainText(
    `The packs folder is now ${DEFAULT}. The pack files in the old folder were left where they are.`,
  );
  await expect(section).toContainText(`Packs folder: ${DEFAULT}`);
  await expect(section.getByTestId('packs-folder-default')).toHaveText('Default');
  await expect(section.getByTestId('default-packs-folder')).toHaveCount(0);
  await expect(section.getByTestId('packs-folder-left')).toHaveCount(0);

  expect(await calls(page)).toEqual([
    'library_choose_packs_folder',
    'library_choose_packs_folder',
    'library_choose_packs_folder',
    'library_apply_packs_folder move',
    'library_default_packs_folder',
    'library_apply_packs_folder leave',
  ]);
  expect(realErrors(errors)).toEqual([]);
});

test('says why a folder is refused, and offers only Use this folder when there is nothing to move', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await setUp(page, DOWNLOADS_BUILD, { packsFolder: true });
  const section = await openPacksFolder(page);

  await setPacksFolder(page, {
    pick: '/home/test/Games',
    refuse:
      'That folder is listed under Games in other folders already. Remove it from that list first, then choose it again.',
  });
  await section.getByTestId('change-packs-folder').click();
  await expect(page.getByTestId('toast')).toContainText(
    'That folder is listed under Games in other folders already.',
  );
  await expect(section.getByTestId('packs-folder-confirm')).toHaveCount(0);

  await setPacksFolder(page, { pick: '/home/test/Empty', files: 0, bytes: 0 });
  await section.getByTestId('change-packs-folder').click();
  const confirm = section.getByRole('group', { name: 'Use the new packs folder?' });
  await expect(confirm).toContainText('It holds no pack files, so there is nothing to move.');
  await expect(confirm.getByRole('button')).toHaveText(['Use this folder', 'Cancel']);
  await confirm.getByRole('button', { name: 'Use this folder' }).click();
  await expect(section).toContainText('Packs folder: /home/test/Empty');
  expect(await calls(page)).toEqual([
    'library_choose_packs_folder',
    'library_choose_packs_folder',
    'library_apply_packs_folder leave',
  ]);
  expect(realErrors(errors)).toEqual([]);
});

test('an older shell that cannot change the packs folder offers no change', async ({ page }) => {
  await setUp(page, DOWNLOADS_BUILD);
  await page.getByTestId('section-settings').click();
  await expect(page.getByTestId('settings-locations')).toBeVisible();
  await expect(page.getByTestId('change-packs-folder')).toHaveCount(0);
  await expect(page.getByTestId('default-packs-folder')).toHaveCount(0);
});
