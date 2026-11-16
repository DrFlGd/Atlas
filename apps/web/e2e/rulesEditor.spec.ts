import { mkdir } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, mock, pickSavedPage, pickSiteFile, realErrors, setUp } from './fakeShell';

/**
 * The rules file editor, opened from Settings, "Sites": the file as JSON on
 * one side and what the reader makes of an example page on the other,
 * against the stand-in shell of `fakeShell.ts` and the made-up "Other
 * wikis" importer, which tries a file read by rules on a saved page. Every
 * file and page here is made up, and nothing is fetched. Only Atlas
 * Importer has the Sites folder, so these tests run in the build with
 * downloads.
 */

test.skip(!DOWNLOADS_BUILD, 'Only a build with downloads keeps site rules files.');
test.use({ deviceScaleFactor: 2 });

/** Where the screenshots go: ATLAS_EDITOR_SHOTS, or beside the other test results. */
const SHOTS = process.env.ATLAS_EDITOR_SHOTS ?? 'test-results/rules-editor';

const OTHERS = {
  'wiki.example.net': {
    headings: [{ title: 'Basics', pages: ['Welcome'] }],
    pages: { Welcome: { title: 'Welcome', body: 'Hello.' } },
  },
};

/** A made-up guide site's file, as the person writes it in the editor. */
const COVE = {
  format: 'atlas-site-rules',
  version: 1,
  site: {
    id: 'cove-guide',
    name: 'Cove Guide',
    game: 'Cove',
    hosts: ['guide.example.org'],
    licence: { blank: true },
  },
  parts: [
    {
      type: 'guide',
      reader: 'rules',
      start: '/cove',
      reading: { ways: ['browse'] },
      pages: { include: ['/cove/*'] },
      contents: { from: 'menu', links: 'nav.menu li a', groups: 'nav.menu li.group' },
      article: {
        content: 'main .text',
        title: 'main h1',
        remove: ['.notice', '.promo'],
        credit: 'main .byline',
      },
      pictures: { full: 'attribute', fullAttribute: 'data-large' },
      order: { from: 'next', next: 'a.next-page' },
    },
  ],
};
const COVE_TEXT = `${JSON.stringify(COVE, null, 2)}\n`;

/** A made-up page of that guide, as saved; its script must never run. */
const SAVED_PAGE = (canonical: boolean, title = 'The Old Quay') => `<!doctype html>
<html><head><title>${title} | Cove Guide</title>
${canonical ? '<link rel="canonical" href="https://guide.example.org/cove/old-quay">' : ''}
<script>window.ran = true;</script></head>
<body>
<nav class="menu"><ul>
<li class="group">Arrival</li>
<li><a href="/cove/harbour">The Harbour</a></li>
<li><a href="/cove/old-quay">The Old Quay</a></li>
<li class="group">The Hills</li>
<li><a href="/cove/lookout">The Lookout</a></li>
</ul></nav>
<main>
<h1>${title}</h1>
<p class="byline">By A. Writer, 3 March 2026</p>
<div class="text">
<p class="notice">Made-up notice to leave out.</p>
<h2>Getting there</h2>
<p>Walk past the <a href="/cove/nets">nets</a> and the lamp posts until the stones turn <strong>green</strong>.</p>
<img src="https://guide.example.org/img/quay-small.png" data-large="https://guide.example.org/img/quay.png" alt="The quay" width="320" height="180">
<h2>What to find</h2>
<ul><li>Three crates</li><li>A rope</li><li>A bell</li></ul>
<img src="https://guide.example.org/img/bell-small.png" alt="">
<table><tr><td>Thing</td><td>How many</td></tr><tr><td>Crate</td><td>3</td></tr></table>
</div>
<a class="next-page" href="/cove/lookout">Next</a>
</main>
</body></html>`;

/** Made-up data of a map, for the map template's paths. */
const MAP_DATA = {
  locations: [
    { type: 'chests', name: 'Old chest', x: 1200, y: 2210 },
    { type: 'chests', name: 'Net chest', x: 300, y: 410 },
    { type: 'keys', name: 'Rusty key', x: 3900, y: 120 },
    { type: 'keys', name: 'Far key', x: 5000, y: 10 },
  ],
};

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

/** Every request after `since` that goes anywhere but the app itself. */
function requestsOut(page: Page): string[] {
  const out: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol !== 'data:' && url.hostname !== 'localhost') out.push(request.url());
  });
  return out;
}

/** Scrolls what the reader makes of the page back to its start, for a screenshot. */
const toResultStart = (editor: Locator) =>
  editor.locator('.rules-editor-result').evaluate((pane) => {
    pane.scrollTop = 0;
  });

/** Puts a whole text in the editor's text box, as typing would. */
async function setText(editor: Locator, text: string) {
  await editor.getByTestId('rules-editor-text').fill(text);
}

test.describe('in the standard layout', () => {
  test.use({ layout: 'standard' });

  test('writes a new file beside what the reader makes of saved pages, and saves it off', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await mkdir(SHOTS, { recursive: true });
    await setUp(page, true, { others: OTHERS });
    const out = requestsOut(page);
    const sites = await openSites(page);

    // "New rules file…" starts from a template of each type, which passes the check.
    await sites.getByTestId('sites-new').click();
    const editor = page.getByTestId('rules-editor');
    await expect(editor).toBeVisible();
    await expect(editor.getByTestId('rules-editor-title')).toHaveText('New rules file');
    await editor.getByTestId('rules-template-guide').click();
    const text = editor.getByTestId('rules-editor-text');
    await expect(text).toHaveValue(/"id": "example-guide"/);
    await expect(editor.getByTestId('rules-editor-check')).toContainText(
      'The form of the file is right.',
    );
    await expect(editor.getByTestId('rules-editor-save')).toBeDisabled();

    // The person's file, and two saved pages to try it on.
    await setText(editor, COVE_TEXT);
    await pickSavedPage(page, { name: 'old-quay.html', text: SAVED_PAGE(true) });
    await editor.getByTestId('rules-editor-add-page').click();
    const result = editor.getByTestId('rules-editor-result');
    await expect(result.getByTestId('rules-result-lead')).toHaveText(
      'Part 1 of the file read it, as a page of a guide.',
    );
    const facts = result.getByTestId('rules-result-facts');
    await expect(facts).toContainText('TitleThe Old Quay');
    await expect(facts).toContainText('It has2 headings, 2 pictures and 1 table');
    await expect(facts).toContainText('Credit lineBy A. Writer, 3 March 2026');
    // The page as Atlas would show it: the text, and each picture as a box of its size.
    const shown = result.getByTestId('rules-result-page');
    await expect(shown.getByRole('heading', { name: 'Getting there' })).toBeVisible();
    await expect(shown).toContainText('until the stones turn green.');
    await expect(shown).not.toContainText('Made-up notice');
    await expect(shown.locator('table')).toContainText('Crate');
    const pictures = shown.locator('img');
    await expect(pictures).toHaveCount(2);
    for (const img of await pictures.all()) {
      expect(await img.getAttribute('src')).toMatch(/^data:image\/svg\+xml,/);
    }
    await expect(pictures.first()).toHaveAttribute('alt', 'The quay');
    await expect(pictures.first()).toHaveAttribute('width', '320');
    // Links lead nowhere from here.
    await shown.getByRole('link', { name: 'nets' }).click();
    await expect(editor).toBeVisible();
    await expect(result.getByTestId('rules-result-pictures').locator('li')).toHaveCount(2);
    await expect(result.getByTestId('rules-result-pictures')).toContainText(
      'https://guide.example.org/img/quay-small.png',
    );
    await expect(result.getByTestId('rules-result-contents')).toContainText(
      'It lists 3 pages in 2 groups.',
    );
    await expect(result.getByTestId('rules-result-contents')).toContainText(
      'ArrivalThe HarbourThe Old QuayThe HillsThe Lookout',
    );
    await expect(result.getByTestId('rules-result-order')).toContainText(
      'https://guide.example.org/cove/lookout',
    );
    // A selector that matched nothing leads to its field.
    const unmatched = result.getByTestId('rules-result-unmatched');
    await expect(unmatched).toHaveText('parts[0].article.remove[1].promo');
    await unmatched.getByRole('button').click();
    await expect(text).toBeFocused();
    expect(
      await text.evaluate((box: HTMLTextAreaElement) =>
        box.value.slice(box.selectionStart, box.selectionEnd),
      ),
    ).toBe('".promo"');
    expect(await page.evaluate(() => (window as { ran?: boolean }).ran)).toBeUndefined();
    await toResultStart(editor);
    await page.screenshot({ path: `${SHOTS}/editor-desktop-dark.png` });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    await page.screenshot({ path: `${SHOTS}/editor-desktop-light.png` });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });

    // A problem: listed under the text at its line, marked there, and the last result kept.
    await setText(editor, COVE_TEXT.replace('"main .text"', '""').replace('"Cove"', '3'));
    const problems = editor.getByTestId('rules-editor-problems');
    await expect(problems.locator('li')).toHaveText([
      'Line 7site.game: must be text, not number.',
      'Line 36Part 1, article.content: must not be empty.',
    ]);
    await expect(editor.locator('.rules-json-line[data-mark="problem"]')).toHaveText(['7', '36']);
    await expect(text).toHaveAttribute('aria-invalid', 'true');
    await expect(editor.getByTestId('rules-editor-trial-state')).toHaveText(
      'The file has problems, so this is what it read before your last change.',
    );
    await expect(editor.getByTestId('rules-editor-trial')).toHaveAttribute('data-stale', 'true');
    await expect(result.getByTestId('rules-result-lead')).toBeVisible();
    await expect(editor.getByTestId('rules-editor-save')).toBeDisabled();
    await problems.getByRole('button').nth(1).click();
    expect(
      await text.evaluate((box: HTMLTextAreaElement) =>
        box.value.slice(box.selectionStart, box.selectionEnd),
      ),
    ).toBe('"content": ""');
    await toResultStart(editor);
    await page.screenshot({ path: `${SHOTS}/editor-problems.png` });

    // Text that is not JSON says where; Format lays out JSON that is.
    await setText(editor, '{"format": "atlas-site-rules",, "version": 1}');
    await expect(problems).toHaveText(
      'Line 1The text is not plain JSON: at line 1, column 31, a name in double quotation marks is expected here.',
    );
    await expect(editor.getByTestId('rules-editor-format')).toBeDisabled();
    await setText(editor, JSON.stringify(COVE));
    await expect(editor.getByTestId('rules-editor-check')).toContainText(
      'The form of the file is right.',
    );
    await editor.getByTestId('rules-editor-format').click();
    await expect(text).toHaveValue(COVE_TEXT);

    // Tab puts in two spaces; Esc, then Tab, moves out of the text.
    await text.focus();
    await text.evaluate((box: HTMLTextAreaElement) => {
      box.setSelectionRange(0, 0);
    });
    await page.keyboard.press('Tab');
    await expect(text).toHaveValue(`  ${COVE_TEXT}`);
    await page.keyboard.press('Escape');
    await expect(editor).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(text).not.toBeFocused();
    await setText(editor, COVE_TEXT);

    // A second page, without its own address: asked for, then tried; the person switches between them.
    await pickSavedPage(page, { name: 'lookout.html', text: SAVED_PAGE(false, 'The Lookout') });
    await editor.getByTestId('rules-editor-add-page').click();
    await expect(editor.getByTestId('rules-editor-pages')).toContainText(
      'The page does not say its own address. Which address was it saved from?',
    );
    await editor.getByTestId('rules-editor-address').fill('guide.example.org/cove/lookout');
    await editor.getByTestId('rules-editor-address-go').click();
    await expect(editor.getByTestId('rules-editor-pages').getByRole('alert')).toHaveText(
      'Give the whole address, starting with https://.',
    );
    await editor.getByTestId('rules-editor-address').fill('https://guide.example.org/cove/lookout');
    await editor.getByTestId('rules-editor-address-go').click();
    await expect(facts).toContainText('TitleThe Lookout');
    await editor.getByTestId('rules-editor-page').selectOption({ label: 'old-quay.html' });
    await expect(facts).toContainText('TitleThe Old Quay');

    // Saving: said first, then kept switched off, and the hosts shown before it is switched on.
    await expect(editor.getByTestId('rules-editor-save-note')).toHaveText(
      'It is saved as cove-guide.atlas-site.json in the Sites folder, switched off until you switch it on.',
    );
    await editor.getByTestId('rules-editor-save').click();
    const confirm = editor.getByTestId('sites-confirm');
    await expect(confirm).toContainText(
      'Saved cove-guide.atlas-site.json (Cove Guide). It is switched off.',
    );
    await expect(confirm.getByTestId('sites-confirm-hosts')).toHaveText('guide.example.org');
    expect((await mock(page)).sites.files['cove-guide.atlas-site.json']).toBe(COVE_TEXT);
    expect((await mock(page)).sites.switches.on).toEqual({});
    await expect(editor.getByTestId('rules-editor-title')).toHaveText(
      'Edit cove-guide.atlas-site.json',
    );
    await expect(editor.getByTestId('rules-editor-state')).toHaveText('Saved');
    await confirm.getByTestId('sites-confirm-on').click();
    await expect
      .poll(async () => Object.keys((await mock(page)).sites.switches.on))
      .toEqual(['own/cove-guide.atlas-site.json']);

    // A change to a file that is on: the editor says saving switches it off, and it does.
    await setText(editor, COVE_TEXT.replace('"Cove Guide"', '"Cove Guide, as I read it"'));
    await expect(editor.getByTestId('rules-editor-save-note')).toContainText(
      'This file is switched on. Saving switches it off until you switch it on again.',
    );
    await editor.getByTestId('rules-editor-save').click();
    await expect(confirm).toContainText('(Cove Guide, as I read it)');
    expect((await mock(page)).sites.switches.on).toEqual({});
    await confirm.getByTestId('sites-confirm-off').click();

    // Leaving with changes asks first.
    await setText(editor, COVE_TEXT);
    await editor.getByTestId('rules-editor-done').click();
    const leave = editor.getByTestId('rules-editor-leave');
    await expect(leave).toContainText(
      'Leave without saving? Your changes to this file are not kept.',
    );
    await expect(leave.getByTestId('rules-editor-leave-no')).toBeFocused();
    await leave.getByTestId('rules-editor-leave-no').click();
    await expect(editor).toBeVisible();
    await page.keyboard.press('Escape');
    await leave.getByTestId('rules-editor-leave-yes').click();
    await expect(editor).toBeHidden();

    // "Edit…" on the file opens it again, with no example pages kept.
    const row = page.locator('[data-testid="site-row"][data-key="own/cove-guide.atlas-site.json"]');
    await row.getByTestId('site-edit').click();
    await expect(text).toHaveValue(/"Cove Guide, as I read it"/);
    await expect(editor.getByTestId('rules-editor-page')).toHaveCount(0);
    await editor.getByTestId('rules-editor-done').click();
    await expect(editor).toBeHidden();

    expect(out).toEqual([]);
    expect(realErrors(errors)).toEqual([]);
  });

  test('edits a copy of a shipped file, which stays as it is', async ({ page }) => {
    const errors = collectErrors(page);
    await setUp(page, true, { others: OTHERS });
    const sites = await openSites(page);
    const shipped = page.locator(
      '[data-testid="site-row"][data-key="other-wikis/harbour-wiki.atlas-site.json"]',
    );
    await shipped.getByTestId('site-edit').click();
    await expect(shipped.getByTestId('site-edit')).toHaveText('Edit a copy…');
    const editor = page.getByTestId('rules-editor');
    await expect(editor.getByTestId('rules-editor-title')).toHaveText(
      'Copy of harbour-wiki.atlas-site.json',
    );
    await expect(editor.getByTestId('rules-editor-copy')).toContainText(
      'Saving keeps it as a file of yours: the shipped file does not change.',
    );
    const text = editor.getByTestId('rules-editor-text');
    await expect(text).toHaveValue(/"id": "harbour-wiki"/);
    // A file with no part read by rules is not tried on a page.
    await pickSavedPage(page, { name: 'old-quay.html', text: SAVED_PAGE(true) });
    await editor.getByTestId('rules-editor-add-page').click();
    await expect(editor.getByTestId('rules-editor-trial-problem')).toHaveText(
      'Only a part read by rules can be tried on a page, and this file has none.',
    );
    const changed = (await text.inputValue()).replace('"Harbour Wiki"', '"Harbour Wiki, mine"');
    await setText(editor, changed);
    await editor.getByTestId('rules-editor-save').click();
    await expect(editor.getByTestId('sites-confirm')).toContainText(
      'Saved harbour-wiki.atlas-site.json (Harbour Wiki, mine).',
    );
    await editor.getByTestId('sites-confirm-off').click();
    await editor.getByTestId('rules-editor-done').click();
    await expect(editor).toBeHidden();
    expect(Object.keys((await mock(page)).sites.files)).toEqual(['harbour-wiki.atlas-site.json']);
    await expect(shipped).toContainText('Harbour Wiki');
    await expect(
      sites.locator('[data-testid="site-row"][data-key="own/harbour-wiki.atlas-site.json"]'),
    ).toContainText('Harbour Wiki, mine');
    expect(realErrors(errors)).toEqual([]);
  });

  test('tries a new map file on a saved data file', async ({ page }) => {
    const errors = collectErrors(page);
    await mkdir(SHOTS, { recursive: true });
    await setUp(page, true, { others: OTHERS });
    const out = requestsOut(page);
    const sites = await openSites(page);
    await sites.getByTestId('sites-new').click();
    const editor = page.getByTestId('rules-editor');
    await editor.getByTestId('rules-template-map').click();
    await pickSavedPage(page, { name: 'data.json', text: JSON.stringify(MAP_DATA) });
    await editor.getByTestId('rules-editor-add-page').click();
    const result = editor.getByTestId('rules-editor-result');
    await expect(result.getByTestId('rules-result-lead')).toHaveText(
      'Part 1 of the file read it, as the data of a map.',
    );
    await expect(result.getByTestId('rules-result-facts')).toContainText(
      'It has1 map, 2 types of location and 3 locations',
    );
    await expect(result.getByTestId('rules-result-maps').locator('tbody tr')).toHaveText([
      'The World4,096 × 4,09630001',
    ]);
    await expect(result.getByTestId('rules-result-types')).toContainText(
      'Can be ticked as foundchests, keys',
    );
    await expect(result.getByTestId('rules-result-locations').locator('tbody tr')).toHaveCount(3);
    await expect(result.getByTestId('rules-result-problems')).toContainText(
      '1 location falls outside its map',
    );
    await toResultStart(editor);
    await page.screenshot({ path: `${SHOTS}/editor-map-data.png` });
    expect(out).toEqual([]);
    expect(realErrors(errors)).toEqual([]);
  });
});

test.describe('in the classic layout, narrow', () => {
  test.use({ layout: 'classic', viewport: { width: 760, height: 1000 } });

  test('shows the two sides one above the other', async ({ page }) => {
    const errors = collectErrors(page);
    await mkdir(SHOTS, { recursive: true });
    await setUp(page, true, { others: OTHERS });
    const sites = await openSites(page);
    await pickSiteFile(page, { name: 'cove.json', text: COVE_TEXT });
    await sites.getByTestId('sites-add').click();
    await sites.getByTestId('sites-confirm-off').click();
    await page
      .locator('[data-testid="site-row"][data-key="own/cove-guide.atlas-site.json"]')
      .getByTestId('site-edit')
      .click();
    const editor = page.getByTestId('rules-editor');
    await expect(editor.getByTestId('rules-editor-title')).toHaveText(
      'Edit cove-guide.atlas-site.json',
    );
    await pickSavedPage(page, { name: 'old-quay.html', text: SAVED_PAGE(true) });
    await editor.getByTestId('rules-editor-add-page').click();
    await expect(editor.getByTestId('rules-result-lead')).toBeVisible();
    const file = await editor.locator('.rules-editor-pane').first().boundingBox();
    const read = await editor.locator('.rules-editor-pane').nth(1).boundingBox();
    expect(read!.y).toBeGreaterThan(file!.y + file!.height - 1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `${SHOTS}/editor-narrow.png`, fullPage: false });
    await editor.evaluate((dialog) => {
      dialog.scrollTop = dialog.scrollHeight;
    });
    await page.screenshot({ path: `${SHOTS}/editor-narrow-result.png` });
    expect(realErrors(errors)).toEqual([]);
  });
});
