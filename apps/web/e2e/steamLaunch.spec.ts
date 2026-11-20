import type { Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, realErrors, setUp } from './fakeShell';

/**
 * Settings, "Start Atlas with a game in Steam", against the stand-in shell
 * of `fakeShell.ts`, which says it runs on Linux and gives the line as the
 * shell's `linux.rs` builds it. Pasting the line into Steam is only tried
 * on a real Steam Deck. Only the app without downloads has this group.
 */

test.use({ layout: 'standard' });
test.skip(DOWNLOADS_BUILD, 'Only the app without downloads takes --background.');

const PATH = '/home/deck/My Games/Atlas.AppImage';
const LINE = `bash -c '"${PATH}" --background & exec "$@"' -- %command%`;
const USUAL_LINE = `bash -c '"$HOME/Applications/Atlas.AppImage" --background & exec "$@"' -- %command%`;

async function openGroup(page: Page) {
  await page.getByTestId('section-settings').click();
  await expect(page.getByTestId('settings-screen')).toBeVisible();
  const group = page.getByTestId('settings-steam-launch');
  await expect(group).toBeVisible();
  return group;
}

test('is not offered off Linux', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page, false);
  await page.getByTestId('section-settings').click();
  await expect(page.getByTestId('settings-maps-folder')).toBeVisible();
  await expect(page.getByTestId('settings-steam-launch')).toHaveCount(0);
  expect(realErrors(errors)).toEqual([]);
});

test('shows the line for the AppImage Atlas runs from, and copies it', async ({
  page,
  context,
}) => {
  const errors = collectErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await setUp(page, false, { steamLaunch: { state: 'appImage', path: PATH, line: LINE } });
  const group = await openGroup(page);
  await expect(group.getByRole('heading')).toHaveText('Start Atlas with a game in Steam');
  await expect(group).toContainText(
    'Put this line into the launch options of a game in Steam, and Atlas starts with that game without coming in front of it.',
  );
  const box = page.getByTestId('steam-launch-line');
  await expect(box).toHaveValue(LINE);
  await expect(box).toHaveAttribute('readonly', '');
  expect(await box.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/monospace/);
  await expect(page.getByTestId('steam-launch-path')).toHaveText(
    `The line names the file Atlas runs from now: ${PATH}. If you move that file, start Atlas from its new folder and copy the line again.`,
  );
  await expect(page.getByTestId('steam-launch-steps').getByRole('listitem')).toHaveText([
    'Press Copy.',
    'In Steam, open the Properties of the game.',
    'Under General, paste the line into Launch Options.',
    'Start the game. To stop Atlas starting with it, delete the line again.',
  ]);

  await page.getByTestId('steam-launch-copy').click();
  await expect(page.getByTestId('steam-launch-copied')).toHaveText('Copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LINE);
  expect(realErrors(errors)).toEqual([]);
});

test('selects the line when it cannot be copied', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('refused')) },
    });
    // The older way of copying, which the app tries next, fails too.
    Object.defineProperty(document, 'execCommand', { value: () => false });
  });
  await setUp(page, false, { steamLaunch: { state: 'appImage', path: PATH, line: LINE } });
  await openGroup(page);
  await page.getByTestId('steam-launch-copy').click();
  await expect(page.getByTestId('steam-launch-copied')).toHaveText(
    'The line is selected. Press Ctrl+C to copy it.',
  );
  const box = page.getByTestId('steam-launch-line');
  await expect(box).toBeFocused();
  expect(
    await box.evaluate((el: HTMLTextAreaElement) =>
      el.value.slice(el.selectionStart, el.selectionEnd),
    ),
  ).toBe(LINE);
  expect(realErrors(errors)).toEqual([]);
});

test('names the usual folder without an AppImage', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page, false, { steamLaunch: { state: 'usual', line: USUAL_LINE } });
  await openGroup(page);
  await expect(page.getByTestId('steam-launch-line')).toHaveValue(USUAL_LINE);
  await expect(page.getByTestId('steam-launch-path')).toContainText(
    'Atlas is not running from an AppImage now, so the line names $HOME/Applications/Atlas.AppImage',
  );
  await expect(page.getByTestId('steam-launch-path')).toContainText(
    'If your Atlas.AppImage is somewhere else, change that path in the line.',
  );
  expect(realErrors(errors)).toEqual([]);
});

test('says why there is no line for a path it cannot hold', async ({ page }) => {
  const errors = collectErrors(page);
  const odd = '/home/deck/$odd/Atlas.AppImage';
  await setUp(page, false, { steamLaunch: { state: 'refused', path: odd } });
  const group = await openGroup(page);
  await expect(page.getByTestId('steam-launch-line')).toHaveCount(0);
  await expect(page.getByTestId('steam-launch-copy')).toHaveCount(0);
  await expect(page.getByTestId('steam-launch-steps')).toHaveCount(0);
  await expect(group.getByTestId('steam-launch-path')).toContainText(
    `Atlas runs from ${odd}, and that path holds a character that cannot go in the line safely`,
  );
  expect(realErrors(errors)).toEqual([]);
});
