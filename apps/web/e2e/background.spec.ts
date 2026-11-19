import type { Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, mock, realErrors, setBackground, setUp } from './fakeShell';

/**
 * Settings, "Atlas in the background", against the stand-in shell of
 * `fakeShell.ts`, which keeps the settings and answers their commands as
 * the shell's `background` module does on Windows. The tray, the hotkey
 * over a game and the start with Windows themselves are only seen in the
 * real app on Windows. Only the app without downloads has these settings.
 */

test.use({ layout: 'standard' });
test.skip(DOWNLOADS_BUILD, 'Only the app without downloads runs in the background.');

async function openSettings(page: Page) {
  await page.getByTestId('section-settings').click();
  await expect(page.getByTestId('settings-screen')).toBeVisible();
}

async function openBackground(page: Page) {
  await openSettings(page);
  const section = page.getByTestId('settings-background');
  await expect(section).toBeVisible();
  return section;
}

const toggle = (page: Page, setting: string) =>
  page.getByTestId(`background-${setting}-switch`).click({ force: true });

const switchOf = (page: Page, setting: string) => page.getByTestId(`background-${setting}-switch`);

const calls = async (page: Page) =>
  (await mock(page)).background.calls.map(({ command, args }) =>
    command === 'background_set'
      ? `${command} ${String(args.setting)} ${String(args.on)}`
      : command,
  );

test('is not offered where the shell says it does not work', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page, false);
  await openSettings(page);
  await expect(page.getByTestId('settings-maps-folder')).toBeVisible();
  await expect(page.getByTestId('settings-background')).toHaveCount(0);
  expect(await calls(page)).toEqual([]);
  expect(realErrors(errors)).toEqual([]);
});

test('turns each setting on and off, each off at first and with its sentence', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page, false, { background: true });
  const section = await openBackground(page);
  await expect(section.getByRole('heading')).toHaveText('Atlas in the background');
  const rows: [string, string, string][] = [
    [
      'keepRunning',
      'Keep Atlas running when its window is closed',
      'Closing the window hides it, and Atlas keeps running with its icon in the notification area',
    ],
    ['hotkey', 'Hotkey', 'Press these keys in any program, a game too, to bring Atlas forward'],
    [
      'onTop',
      'Stay above other windows',
      'a game in exclusive full screen covers every window, so set the game to borderless or windowed.',
    ],
    [
      'startWithSystem',
      'Start Atlas when Windows starts',
      'Atlas starts without coming to the front when you sign in to Windows, for your user only.',
    ],
  ];
  for (const [setting, label, help] of rows) {
    const row = page.getByTestId(`background-${setting}`);
    await expect(row).toContainText(label);
    await expect(row).toContainText(help);
    await expect(switchOf(page, setting)).not.toBeChecked();
  }
  await expect(page.getByTestId('background-hotkey-keys')).toHaveText('Ctrl+Alt+M');
  await expect(page.getByTestId('background-back')).toContainText(
    'it comes back with the same game, map, location, zoom and panel',
  );

  for (const setting of ['keepRunning', 'onTop', 'startWithSystem', 'hotkey']) {
    await toggle(page, setting);
    await expect(switchOf(page, setting)).toBeChecked();
  }
  await toggle(page, 'onTop');
  await expect(switchOf(page, 'onTop')).not.toBeChecked();
  expect(await calls(page)).toEqual([
    'background_state',
    'background_set keepRunning true',
    'background_set onTop true',
    'background_set startWithSystem true',
    'background_set hotkey true',
    'background_set onTop false',
  ]);

  expect(realErrors(errors)).toEqual([]);
});

test('sets the hotkey by pressing the keys, and refuses a combination with a sentence', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await setUp(page, false, { background: true });
  await openBackground(page);
  await toggle(page, 'hotkey');
  await expect(switchOf(page, 'hotkey')).toBeChecked();

  await page.getByTestId('background-hotkey-change').click();
  const field = page.getByTestId('background-hotkey-field');
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('placeholder', 'Press the keys you want');

  // A plain key, and one Windows keeps for itself: refused, the old keys kept.
  await field.press('KeyM');
  await expect(page.getByTestId('background-keys-problem')).toHaveText(
    'Press at least one of Ctrl, Alt, Shift or the Windows key together with one other key.',
  );
  await field.press('Alt+F4');
  await expect(page.getByTestId('background-keys-problem')).toHaveText(
    'Windows keeps Alt+F4 for itself. Choose another combination.',
  );
  await expect(page.getByTestId('background-hotkey-keys')).toHaveText('Ctrl+Alt+M');

  // Another program has it: the system does not take it.
  await setBackground(page, { taken: ['Ctrl+Alt+K'] });
  await field.press('Control+Alt+KeyK');
  await expect(page.getByTestId('background-keys-problem')).toHaveText(
    'Another program uses Ctrl+Alt+K already, so Atlas cannot. Choose another combination.',
  );
  await expect(page.getByTestId('background-hotkey-keys')).toHaveText('Ctrl+Alt+M');

  // One that works.
  await field.press('Control+Shift+KeyK');
  await expect(page.getByTestId('background-hotkey-keys')).toHaveText('Ctrl+Shift+K');
  await expect(field).toHaveCount(0);
  await expect(page.getByTestId('background-keys-problem')).toHaveCount(0);
  const called = await calls(page);
  // The hotkey did nothing while the keys were pressed, and works again after.
  expect(called.filter((command) => command === 'background_pause_hotkey').length).toBeGreaterThan(
    1,
  );
  expect(called.at(-1)).toBe('background_pause_hotkey');
  const pauses = (await mock(page)).background.calls
    .filter(({ command }) => command === 'background_pause_hotkey')
    .map(({ args }) => args.paused);
  expect(pauses[0]).toBe(true);
  expect(pauses.at(-1)).toBe(false);

  // Esc leaves the field as it was.
  await page.getByTestId('background-hotkey-change').click();
  await page.getByTestId('background-hotkey-field').press('Escape');
  await expect(page.getByTestId('background-hotkey-field')).toHaveCount(0);
  await expect(page.getByTestId('background-hotkey-keys')).toHaveText('Ctrl+Shift+K');
  expect(realErrors(errors)).toEqual([]);
});

test('says when the system does not take the hotkey or the start with Windows', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await setUp(page, false, { background: true });
  await setBackground(page, {
    taken: ['Ctrl+Alt+M'],
    startFails: 'Atlas could not change whether it starts when Windows starts: Access is denied.',
  });
  await openBackground(page);

  await toggle(page, 'hotkey');
  await expect(page.getByTestId('background-hotkey-problem')).toHaveText(
    'Another program uses Ctrl+Alt+M already, so Atlas cannot. Choose another combination.',
  );
  await expect(switchOf(page, 'hotkey')).not.toBeChecked();

  await toggle(page, 'startWithSystem');
  await expect(page.getByTestId('background-startWithSystem-problem')).toHaveText(
    'Atlas could not change whether it starts when Windows starts: Access is denied.',
  );
  await expect(switchOf(page, 'startWithSystem')).not.toBeChecked();

  // Another combination, then on.
  await page.getByTestId('background-hotkey-change').click();
  await page.getByTestId('background-hotkey-field').press('Control+Alt+KeyJ');
  await expect(page.getByTestId('background-hotkey-keys')).toHaveText('Ctrl+Alt+J');
  await toggle(page, 'hotkey');
  await expect(switchOf(page, 'hotkey')).toBeChecked();
  await expect(page.getByTestId('background-hotkey-problem')).toHaveCount(0);
  expect(realErrors(errors)).toEqual([]);
});
