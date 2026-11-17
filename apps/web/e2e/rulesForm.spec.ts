import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, mock, pickSiteFile, realErrors, setUp } from './fakeShell';

/**
 * The settings of a site rules file in the rules file editor ("Settings…"
 * in Settings, "Sites"): the file's simple choices as ordinary controls,
 * beside its JSON, and "Revert to defaults". Against the stand-in shell of
 * `fakeShell.ts` and the made-up "Other wikis" importer, which comes with a
 * file for a made-up wiki, the defaults of its reader and a refusal file.
 * Every file here is made up. Only Atlas Importer has the Sites folder, so
 * these tests run in the build with downloads.
 */

test.skip(!DOWNLOADS_BUILD, 'Only a build with downloads keeps site rules files.');
test.use({ deviceScaleFactor: 2 });

/** Where the screenshots go: ATLAS_FORM_SHOTS, or beside the other test results. */
const SHOTS = process.env.ATLAS_FORM_SHOTS ?? 'test-results/rules-form';

const OTHERS = {
  'wiki.example.net': {
    headings: [{ title: 'Basics', pages: ['Welcome'] }],
    pages: { Welcome: { title: 'Welcome', body: 'Hello.' } },
  },
};

/** The made-up wiki's file the importer comes with, as the demo importer gives it. */
const HARBOUR = {
  format: 'atlas-site-rules',
  version: 1,
  site: {
    id: 'harbour-wiki',
    name: 'Harbour Wiki',
    game: 'Harbour',
    hosts: ['harbour.example.net'],
    notice: 'The Harbour Wiki asks readers to leave five seconds between pages.',
  },
  parts: [{ type: 'wiki', reader: 'other-wiki', reading: { ways: ['fetch', 'browse'], pause: 5 } }],
};
const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
/** The copy, with the pause longer and "By itself" left out. */
const CHANGED = text({
  ...HARBOUR,
  parts: [{ ...HARBOUR.parts[0], reading: { ways: ['browse'], pause: 8 } }],
});

const row = (page: Page, key: string) =>
  page.locator(`[data-testid="site-row"][data-key="${key}"]`);

const setting = (editor: Locator, field: string) =>
  editor.locator(`[data-testid="rules-form-setting"][data-field="${field}"]`);

async function openSites(page: Page): Promise<Locator> {
  const section = page.getByTestId('section-settings');
  if ((await section.count()) > 0) await section.click();
  else {
    if (!(await page.getByTestId('library').isVisible())) {
      await page.getByTestId('maps-button').click();
    }
    await page.getByTestId('library-settings').click();
  }
  const sites = page.getByTestId('settings-sites');
  await expect(sites).toBeVisible();
  return sites;
}

/** Scrolls the settings back to their start, for a screenshot. */
const toFormStart = (editor: Locator) =>
  editor.getByTestId('rules-editor-form').evaluate((pane) => {
    pane.scrollTop = 0;
  });

test.describe('in the standard layout', () => {
  test.use({ layout: 'standard' });

  test('changes a shipped file’s settings on a copy, puts one back and reverts to the defaults', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await mkdir(SHOTS, { recursive: true });
    await setUp(page, true, { others: OTHERS });
    const sites = await openSites(page);

    // "Settings…" on a site file and a reader's defaults; not on a refusal, which has none.
    const shipped = row(page, 'other-wikis/harbour-wiki.atlas-site.json');
    await expect(
      row(page, 'other-wikis/other-wiki.reader.atlas-site.json').getByTestId('site-settings'),
    ).toBeVisible();
    await expect(
      row(page, 'other-wikis/quiet-archive.refused.atlas-site.json').getByTestId('site-settings'),
    ).toHaveCount(0);
    await shipped.getByTestId('site-settings').click();

    // A copy of the shipped file, on its settings.
    const editor = page.getByTestId('rules-editor');
    await expect(editor.getByTestId('rules-editor-title')).toHaveText(
      'Copy of harbour-wiki.atlas-site.json',
    );
    await expect(editor.getByTestId('rules-editor-view-form')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(editor.getByTestId('rules-editor-copy')).toContainText(
      'Saving keeps it as a file of yours: the shipped file does not change.',
    );
    const form = editor.getByTestId('rules-form');
    await expect(form.getByTestId('rules-form-compared')).toHaveText(
      'Compared with the shipped file harbour-wiki.atlas-site.json, which comes with Other wikis. Every setting is as shipped.',
    );
    await expect(form.getByTestId('rules-form-revert')).toHaveCount(0);
    await expect(form.getByTestId('rules-form-group').locator('> legend')).toHaveText([
      'The site',
      'Part 1: a wiki, read by the reader “other-wiki”',
      'The file',
    ]);
    await expect(form.getByLabel('The site’s name')).toHaveValue('Harbour Wiki');
    await expect(form.getByLabel('The notice').first()).toHaveValue(
      'The Harbour Wiki asks readers to leave five seconds between pages.',
    );
    await expect(form.getByTestId('rules-form-also').first()).toHaveText(
      'The file also sets, for the site: the site’s id, the game and the site’s hosts. Open the JSON view',
    );
    const pause = setting(editor, 'parts[0].reading.pause');
    await expect(pause.getByRole('spinbutton')).toHaveValue('5');
    const ways = setting(editor, 'parts[0].reading.ways');
    await expect(ways.getByRole('checkbox', { name: 'By itself' })).toBeChecked();
    await expect(ways.getByRole('checkbox', { name: 'In a window' })).not.toBeChecked();
    await expect(ways.getByRole('checkbox', { name: 'As I browse' })).toBeChecked();
    await expect(editor.getByTestId('rules-form-changed')).toHaveCount(0);
    await toFormStart(editor);
    await page.screenshot({ path: join(SHOTS, 'form-shipped.png') });

    // Two settings changed: each marked, with the shipped value and "Put back".
    await pause.getByRole('spinbutton').fill('8');
    await ways.getByRole('checkbox', { name: 'By itself' }).uncheck();
    // At least one way stays ticked.
    await expect(ways.getByRole('checkbox', { name: 'As I browse' })).toBeDisabled();
    await expect(editor.getByTestId('rules-form-changed')).toHaveCount(2);
    await expect(pause.getByTestId('rules-form-shipped')).toHaveText('Shipped: 5 seconds Put back');
    await expect(ways.getByTestId('rules-form-shipped')).toHaveText(
      'Shipped: By itself, As I browse Put back',
    );
    await expect(form.getByTestId('rules-form-compared')).toContainText('2 settings are changed.');
    await expect(editor.getByTestId('rules-editor-state')).toHaveText('Changes not saved');
    await expect(editor.getByTestId('rules-editor-check')).toContainText(
      'The form of the file is right.',
    );
    // The two settings changed at the top of the settings, the editor's head kept in view.
    await editor.getByTestId('rules-editor-form').evaluate((pane) => {
      const one = pane.querySelector('[data-field="parts[0].reading.ways"]')!;
      pane.scrollTop += one.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12;
    });
    await page.screenshot({ path: join(SHOTS, 'form-changed.png') });

    // The JSON view shows the same text, changed only where the settings changed.
    await editor.getByTestId('rules-editor-view-json').click();
    const json = editor.getByTestId('rules-editor-text');
    await expect(json).toBeVisible();
    await expect(json).toHaveValue(CHANGED);
    await expect(form).toBeHidden();
    await page.screenshot({ path: join(SHOTS, 'json-after-change.png') });
    // The arrow keys move between the two tabs.
    await editor.getByTestId('rules-editor-view-json').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(editor.getByTestId('rules-editor-view-form')).toBeFocused();
    await expect(form).toBeVisible();

    // A change in the JSON shows in the settings at once.
    await editor.getByTestId('rules-editor-view-json').click();
    await json.fill(CHANGED.replace('"pause": 8', '"pause": 9'));
    await editor.getByTestId('rules-editor-view-form').click();
    await expect(pause.getByRole('spinbutton')).toHaveValue('9');
    await pause.getByRole('spinbutton').fill('8');

    // A problem of the checker shows beside its setting.
    await pause.getByRole('spinbutton').fill('90');
    await expect(pause.getByTestId('rules-form-problem')).toHaveText(
      'Part 1, reading.pause: must be at most 60.',
    );
    await pause.getByRole('spinbutton').fill('8');
    await expect(pause.getByTestId('rules-form-problem')).toHaveCount(0);

    // Saved as "Edit a copy…" saves: a file of the person's, off until switched on.
    await editor.getByTestId('rules-editor-save').click();
    const confirm = editor.getByTestId('sites-confirm');
    await expect(confirm).toContainText(
      'Saved harbour-wiki.atlas-site.json (Harbour Wiki). It is switched off.',
    );
    expect((await mock(page)).sites.files).toEqual({ 'harbour-wiki.atlas-site.json': CHANGED });
    await confirm.getByTestId('sites-confirm-off').click();
    await expect(editor.getByTestId('rules-editor-title')).toHaveText(
      'Edit harbour-wiki.atlas-site.json',
    );
    await editor.getByTestId('rules-editor-done').click();
    await expect(editor).toBeHidden();
    const own = row(page, 'own/harbour-wiki.atlas-site.json');
    await expect(sites.getByRole('heading', { name: 'Your files' })).toBeVisible();
    await expect(own).toContainText('Harbour Wiki');
    await expect(own.getByTestId('site-revert')).toBeVisible();
    await expect(shipped.getByTestId('site-revert')).toHaveCount(0);

    // "Settings…" on the person's file: still compared with the shipped file; one put back.
    await own.getByTestId('site-settings').click();
    await expect(editor.getByTestId('rules-editor-title')).toHaveText(
      'Edit harbour-wiki.atlas-site.json',
    );
    await expect(editor.getByTestId('rules-form-changed')).toHaveCount(2);
    await pause.getByTestId('rules-form-put-back').click();
    await expect(pause.getByRole('spinbutton')).toHaveValue('5');
    await expect(editor.getByTestId('rules-form-changed')).toHaveCount(1);
    await expect(pause.getByTestId('rules-form-shipped')).toHaveCount(0);
    await expect(form.getByTestId('rules-form-compared')).toContainText('One setting is changed.');
    await editor.getByTestId('rules-editor-view-json').click();
    await expect(json).toHaveValue(CHANGED.replace('"pause": 8', '"pause": 5'));
    await editor.getByTestId('rules-editor-view-form').click();

    // "Revert to defaults": asked first, in the app, naming the file; then the copy is removed.
    await form.getByTestId('rules-form-revert').click();
    const ask = form.getByTestId('rules-revert-confirm');
    await expect(ask).toHaveText(
      'Revert harbour-wiki.atlas-site.json to the defaults? Your file harbour-wiki.atlas-site.json is removed from the Sites folder, with your changes to it, and the shipped file that comes with Other wikis applies again.Revert to defaultsCancel',
    );
    await expect(ask.getByTestId('rules-revert-no')).toBeFocused();
    await expect(editor.getByTestId('rules-editor-check')).toContainText(
      'The form of the file is right.',
    );
    await toFormStart(editor);
    await page.screenshot({ path: join(SHOTS, 'revert-confirm.png') });
    await ask.getByTestId('rules-revert-no').click();
    await expect(ask).toBeHidden();
    expect(Object.keys((await mock(page)).sites.files)).toEqual(['harbour-wiki.atlas-site.json']);
    await form.getByTestId('rules-form-revert').click();
    await ask.getByTestId('rules-revert-yes').click();
    await expect(form.getByTestId('rules-form-compared')).toHaveText(
      'Reverted to the defaults: your file was removed, and the shipped file harbour-wiki.atlas-site.json applies again.',
    );
    expect((await mock(page)).sites.files).toEqual({});
    await expect(editor.getByTestId('rules-form-changed')).toHaveCount(0);
    await expect(editor.getByTestId('rules-editor-title')).toHaveText(
      'Copy of harbour-wiki.atlas-site.json',
    );
    await expect(editor.getByTestId('rules-editor-state')).toHaveText('');
    await editor.getByTestId('rules-editor-done').click();
    await expect(editor).toBeHidden();
    await expect(own).toHaveCount(0);
    await expect(shipped).toContainText('Harbour Wiki');

    expect(realErrors(errors)).toEqual([]);
  });

  test('reverts a file of the person’s to the defaults from its row in Sites', async ({ page }) => {
    const errors = collectErrors(page);
    await setUp(page, true, { others: OTHERS });
    const sites = await openSites(page);
    await pickSiteFile(page, { name: 'harbour.json', text: CHANGED });
    await sites.getByTestId('sites-add').click();
    await sites.getByTestId('sites-confirm-on').click();
    const own = row(page, 'own/harbour-wiki.atlas-site.json');
    await expect(own).toHaveAttribute('data-on', 'true');

    await own.getByTestId('site-revert').click();
    const ask = own.getByTestId('rules-revert-confirm');
    await expect(ask).toContainText(
      'Revert harbour-wiki.atlas-site.json to the defaults? Your file harbour-wiki.atlas-site.json is removed from the Sites folder, with your changes to it, and the shipped file that comes with Other wikis applies again.',
    );
    await expect(ask.getByTestId('rules-revert-no')).toBeFocused();
    await ask.getByTestId('rules-revert-no').click();
    await expect(own).toBeVisible();
    await own.getByTestId('site-revert').click();
    await own.getByTestId('rules-revert-yes').click();
    await expect(own).toHaveCount(0);
    expect((await mock(page)).sites.files).toEqual({});
    expect((await mock(page)).sites.switches.on).toEqual({});
    await expect(row(page, 'other-wikis/harbour-wiki.atlas-site.json')).not.toContainText(
      'Your file',
    );
    expect(realErrors(errors)).toEqual([]);
  });
});

test.describe('in the classic layout, narrow', () => {
  test.use({ layout: 'classic', viewport: { width: 760, height: 1000 } });

  test('shows a reader’s defaults as settings in one column, with no page scroll sideways', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await mkdir(SHOTS, { recursive: true });
    await setUp(page, true, { others: OTHERS });
    await openSites(page);
    await row(page, 'other-wikis/other-wiki.reader.atlas-site.json')
      .getByTestId('site-settings')
      .click();
    const editor = page.getByTestId('rules-editor');
    const form = editor.getByTestId('rules-form');
    await expect(form.getByTestId('rules-form-group').locator('> legend')).toHaveText([
      'The defaults of the reader “other-wiki”',
      'The file',
    ]);
    await expect(
      setting(editor, 'readerDefaults.licence').getByTestId('rules-form-licence'),
    ).toHaveAttribute('data-form', 'ask');
    await setting(editor, 'readerDefaults.layout.pageWidth')
      .getByRole('combobox')
      .selectOption({ label: 'Wide: About 1,000 pixels, for pages laid out wider' });
    await expect(
      setting(editor, 'readerDefaults.layout.pageWidth').getByTestId('rules-form-shipped'),
    ).toHaveText('Shipped: not set (Reading) Put back');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const wide = await editor.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth);
    expect(wide).toBe(true);
    await page.screenshot({ path: join(SHOTS, 'form-narrow.png') });
    expect(realErrors(errors)).toEqual([]);
  });
});
