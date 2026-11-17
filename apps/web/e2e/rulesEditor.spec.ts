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

/** The made-up guide's file with a layout section. */
const LAYOUT_TEXT = `${JSON.stringify(
  {
    ...COVE,
    parts: [
      {
        ...COVE.parts[0],
        layout: {
          cards: { select: 'div.panel', title: '.panel-head' },
          sideBySide: ['div.two-up'],
          oneColumn: ['nav.side-menu'],
          row: ['ul.chapter-links'],
          leaveOut: ['div.advert'],
          pageWidth: 'wide',
        },
      },
    ],
  },
  null,
  2,
)}\n`;

/** A made-up page of the guide with cards, blocks side by side and a row of links. */
const LAYOUT_PAGE = `<!doctype html>
<html><head><title>Tide Tables | Cove Guide</title>
<link rel="canonical" href="https://guide.example.org/cove/tide-tables"></head>
<body><main><h1>Tide Tables</h1>
<p class="byline">By A. Writer, 3 March 2026</p>
<div class="text">
<ul class="chapter-links"><li><a href="/cove/harbour">The Harbour</a></li><li><a href="/cove/lookout">The Lookout</a></li></ul>
<div class="two-up">
<div class="panel"><p class="panel-head">High tide</p><p>The quay floods to the second step.</p></div>
<div class="panel"><p class="panel-head">Low tide</p><p>The sand bar opens to the far rocks.</p></div>
</div>
<div class="advert">Made-up advert to leave out.</div>
<p>Ring the bell before the water turns.</p>
</div>
<a class="next-page" href="/cove/lookout">Next</a>
</main></body></html>`;

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
    // A file whose site its importer's own reader reads is tried too: a page of another site is not read by it.
    await pickSavedPage(page, { name: 'old-quay.html', text: SAVED_PAGE(true) });
    await editor.getByTestId('rules-editor-add-page').click();
    await expect(editor.getByTestId('rules-result-problems')).toHaveText(
      'The address https://guide.example.org/cove/old-quay is not on a host the file names, so its reader does not read it by this file. Give the address the page was saved from, or add its host to site.hosts.',
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

  test('reports the layout the file finds on a saved page', async ({ page }) => {
    const errors = collectErrors(page);
    await mkdir(SHOTS, { recursive: true });
    await setUp(page, true, { others: OTHERS });
    const out = requestsOut(page);
    const sites = await openSites(page);
    await sites.getByTestId('sites-new').click();
    const editor = page.getByTestId('rules-editor');
    await editor.getByTestId('rules-template-guide').click();
    await setText(editor, LAYOUT_TEXT);
    await expect(editor.getByTestId('rules-editor-check')).toContainText(
      'The form of the file is right.',
    );
    await pickSavedPage(page, { name: 'tides.html', text: LAYOUT_PAGE });
    await editor.getByTestId('rules-editor-add-page').click();
    const result = editor.getByTestId('rules-editor-result');
    const layout = result.getByTestId('rules-result-layout');
    await expect(layout.locator('li')).toHaveText([
      'The layout is read as the browser shows it.',
      'Layout found: 1 row of blocks side by side, 2 cards and 1 list set in a row.',
      'The cards are titled: High tide, Low tide.',
      '1 block named in layout.leaveOut was left out.',
    ]);
    await expect(layout.getByTestId('rules-result-layout-note')).toHaveText(
      'A page saved from a browser has no notes of its layout, so layout that comes only from the wiki’s style sheet is not seen here: it shows once the wiki is read in the app.',
    );
    await expect(result.getByTestId('rules-result-page')).not.toContainText('Made-up advert');
    // The entry of the layout section that matched nothing leads to its field.
    await expect(result.getByTestId('rules-result-unmatched')).toContainText(
      'parts[0].layout.oneColumn[0]nav.side-menu',
    );
    await layout.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/editor-layout-report.png` });
    expect(out).toEqual([]);
    expect(realErrors(errors)).toEqual([]);
  });
});

/** A made-up page of a wiki the "Other wikis" reader reads, saved as one file with its style sheets inside it. */
const STYLED_PAGE = (pictures = 120) => `<!doctype html>
<html><head><title>Reed Beds - Marsh Wiki</title>
<base href="https://wiki.example.net/">
<link rel="canonical" href="https://wiki.example.net/wiki/Reed_Beds">
<link rel="icon" href="/favicon.ico">
<link rel="preload" href="https://fonts.example.org/fen.woff2" as="font">
<meta http-equiv="refresh" content="0;url=https://elsewhere.example.org/">
<style>
@import url("https://styles.example.org/more.css");
@font-face { font-family: Fen; src: url(https://fonts.example.org/fen.woff2); }
body { margin: 0; font: 16px/22px sans-serif; background: #fff url(/paper.png); }
#wiki-text { width: 960px; padding: 0 20px; }
.pair { display: flex; gap: 20px; }
.pair > div { flex: 1 1 0; }
.panel { border: 1px solid #887; padding: 8px; background-image: image-set("https://pictures.example.org/a.png" 1x); }
.gallery img { display: inline-block; }
</style>
<style media="print">.pair { display: block; }</style>
<script>document.title = 'changed';</script>
</head>
<body>
<h1 id="page-title">Reed Beds</h1>
<div id="wiki-text">
<p>The reeds grow tall where the river slows.</p>
<div class="pair">
<div class="panel"><h3>North bank</h3><p>Herons nest here.</p></div>
<div class="panel"><h3>South bank</h3><p>Frogs sing at dusk.</p></div>
</div>
<p class="gallery">${Array.from({ length: pictures }, (_, n) => `<img src="/images/reed-${n}.png" srcset="/images/reed-${n}-2x.png 2x" alt="Reed ${n}" width="40" height="40">`).join('')}</p>
<iframe src="https://elsewhere.example.org/embed"></iframe>
<iframe srcdoc="<p>inner</p>"></iframe>
<video poster="https://pictures.example.org/poster.png"><source src="https://media.example.org/clip.webm"></video>
<object data="https://elsewhere.example.org/thing.swf"></object>
<svg width="10" height="10"><image href="https://pictures.example.org/drawing.png" width="10" height="10"/></svg>
<div style="background: url(https://pictures.example.org/inline.png); height: 20px">Banner</div>
</div>
</body></html>`;

/** The same page saved with no style sheets at all. */
const PLAIN_PAGE = STYLED_PAGE(3).replace(/<style[^]*?<\/style>/gu, '');

/** The same page saved as "Webpage, complete": its sheet a file beside it. */
const LINKED_PAGE = PLAIN_PAGE.replace(
  '<link rel="icon"',
  '<link rel="stylesheet" href="Reed_Beds_files/skin.css"><link rel="icon"',
);

/** Every request that leaves the app, to any host: none may. */
function everyRequestOut(page: Page): string[] {
  const out: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (url.hostname === 'localhost') return;
    out.push(request.url());
  });
  // Anything that is not the app is stopped, whatever it is.
  void page.route(/^https?:\/\/(?!localhost[:/])/u, (route) => route.abort());
  return out;
}

test.describe('trying any file on a saved page', () => {
  test.use({ layout: 'standard' });

  test('tries a reader’s file on a saved page laid out with its own style sheets, and asks for nothing', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await mkdir(SHOTS, { recursive: true });
    await setUp(page, true, { others: OTHERS });
    const out = everyRequestOut(page);
    const sites = await openSites(page);
    const reader = sites.locator(
      '[data-testid="site-row"][data-key="other-wikis/other-wiki.reader.atlas-site.json"]',
    );
    const refusal = sites.locator(
      '[data-testid="site-row"][data-key="other-wikis/quiet-archive.refused.atlas-site.json"]',
    );
    // Every file offers a trial; a refusal, which names no page, says at once why it has none.
    await expect(reader.getByTestId('site-try')).toHaveAttribute('data-tryable', 'true');
    await expect(refusal.getByTestId('site-try')).toHaveAttribute('data-tryable', 'false');
    await refusal.getByTestId('site-try').click();
    const untried = refusal.getByTestId('site-trial');
    await expect(untried).toContainText(
      'Quiet Archive wikis cannot be tried on a saved page, so no page was asked for.',
    );
    await expect(untried.getByRole('alert')).toHaveText(
      'A refusal file names sites that are not read at all, so there is no page to try it on. To see how a page is read, try the file that reads its site.',
    );
    await expect(untried.getByTestId('site-trial-editor')).toHaveCount(0);
    await untried.getByTestId('site-trial-close').click();

    await reader.getByTestId('site-edit').click();
    const editor = page.getByTestId('rules-editor');
    await expect(editor.getByTestId('rules-editor-title')).toHaveText(
      'Copy of other-wiki.reader.atlas-site.json',
    );
    await pickSavedPage(page, { name: 'reed-beds.html', text: STYLED_PAGE() });
    await editor.getByTestId('rules-editor-add-page').click();
    const result = editor.getByTestId('rules-editor-result');
    await expect(result.getByTestId('rules-result-lead')).toHaveText(
      'The reader “other-wiki” read it with this file’s settings, as a page of a wiki.',
    );
    await expect(result.getByTestId('rules-result-facts')).toContainText('TitleReed Beds');
    const layout = result.getByTestId('rules-result-layout');
    await expect(layout.locator('li').first()).toHaveText(
      'The app laid the page out with the style sheets saved inside it, so it was read by position, as a page read in the app’s window is.',
    );
    await expect(layout).toContainText('Layout found: 1 row of blocks side by side and 2 cards.');
    await expect(layout.getByTestId('rules-result-layout-note')).toHaveCount(0);
    // Drawn as Guides draws it: the two cards side by side, at the width of the game's pages.
    const shown = result.getByTestId('rules-result-page');
    await expect(shown.locator('.guide-side .guide-card')).toHaveCount(2);
    const [north, south] = await shown.locator('.guide-card').all();
    const a = await north!.boundingBox();
    const b = await south!.boundingBox();
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
    expect(b!.x).toBeGreaterThan(a!.x + a!.width - 1);
    await expect(result.getByTestId('rules-result-sheet')).toHaveAttribute('data-width', 'reading');
    await expect(result.getByTestId('rules-result-width')).toContainText(
      'The file gives no width for the game’s pages, so this is drawn as Guides draws it at reading width, 760 pixels',
    );
    for (const img of await shown.locator('img').all()) {
      expect(await img.getAttribute('src')).toMatch(/^data:image\/svg\+xml,/u);
    }
    await toResultStart(editor);
    await page.screenshot({ path: `${SHOTS}/trial-readers-laid-out.png` });

    // A change to the layout section: tried again, at the new width.
    const text = editor.getByTestId('rules-editor-text');
    const wide = (await text.inputValue()).replace(
      '"licence": {',
      '"layout": {\n      "pageWidth": "wide"\n    },\n    "licence": {',
    );
    expect(wide).toContain('"pageWidth": "wide"');
    await setText(editor, wide);
    await expect(result.getByTestId('rules-result-sheet')).toHaveAttribute('data-width', 'wide');
    await expect(result.getByTestId('rules-result-width')).toContainText(
      'Drawn as Guides draws it at the width of the game’s pages, 1,000 pixels',
    );
    await expect(layout).toContainText(
      'The game’s pages are shown wide, about 1,000 pixels, as the file says (layout.pageWidth).',
    );
    await toResultStart(editor);
    await page.screenshot({ path: `${SHOTS}/trial-readers-wide.png` });

    // A page saved with no sheets, and one whose sheet is a file beside it: read as their HTML states.
    await pickSavedPage(page, { name: 'reed-beds-plain.html', text: PLAIN_PAGE });
    await editor.getByTestId('rules-editor-add-page').click();
    await expect(layout.locator('li').first()).toHaveText(
      'The saved page holds no style sheets, so it was read by the layout its HTML states, not by position. To try it by position, save the page as one file with its style sheets inside it.',
    );
    await expect(shown.locator('.guide-side')).toHaveCount(0);
    await expect(shown).toContainText('North bank');
    await pickSavedPage(page, { name: 'reed-beds-complete.html', text: LINKED_PAGE });
    await editor.getByTestId('rules-editor-add-page').click();
    await expect(layout.locator('li').first()).toHaveText(
      'The saved page links to style sheets it does not hold, so it was read by the layout its HTML states, not by position. To try it by position, save the page as one file with its style sheets inside it.',
    );
    // The pages stay side by side in the menu.
    await expect(editor.getByTestId('rules-editor-page').locator('option')).toHaveText([
      'reed-beds.html',
      'reed-beds-plain.html',
      'reed-beds-complete.html',
    ]);
    await editor.getByTestId('rules-editor-page').selectOption({ label: 'reed-beds.html' });
    await expect(shown.locator('.guide-side')).toHaveCount(1);

    // Nothing of any page ran, and nothing was asked of any host.
    expect(await page.evaluate(() => document.title)).not.toBe('changed');
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(out).toEqual([]);
    expect(realErrors(errors)).toEqual([]);
  });

  test('says why a file cannot be tried, and opens a trial from the Sites list in the editor', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await mkdir(SHOTS, { recursive: true });
    await setUp(page, true, { others: OTHERS });
    const out = everyRequestOut(page);
    const sites = await openSites(page);
    // A refusal, edited: there is no page to try it on, and the editor says what to do.
    await sites
      .locator(
        '[data-testid="site-row"][data-key="other-wikis/quiet-archive.refused.atlas-site.json"]',
      )
      .getByTestId('site-edit')
      .click();
    const editor = page.getByTestId('rules-editor');
    await pickSavedPage(page, { name: 'reed-beds.html', text: STYLED_PAGE(3) });
    await editor.getByTestId('rules-editor-add-page').click();
    await expect(editor.getByTestId('rules-editor-trial-problem')).toHaveText(
      'A refusal file names sites that are not read at all, so there is no page to try it on. To see how a page is read, try the file that reads its site.',
    );
    await editor.getByTestId('rules-editor-done').click();
    await expect(editor).toBeHidden();

    // "Try on a saved page…" on the reader's file, then "Open in the editor" with that page.
    const reader = sites.locator(
      '[data-testid="site-row"][data-key="other-wikis/other-wiki.reader.atlas-site.json"]',
    );
    await pickSavedPage(page, { name: 'reed-beds.html', text: STYLED_PAGE(3) });
    await reader.getByTestId('site-try').click();
    const card = reader.getByTestId('site-trial');
    await expect(card.getByTestId('site-trial-facts')).toContainText(
      'The reader “other-wiki” read it with this file’s settings, as a page of a wiki.',
    );
    await expect(card.getByTestId('site-trial-facts')).toContainText(
      'The app laid the page out with the style sheets saved inside it, so it was read by position, as a page read in the app’s window is.',
    );
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/trial-readers-sites-card.png` });
    await card.getByTestId('site-trial-editor').click();
    await expect(editor.getByTestId('rules-editor-title')).toHaveText(
      'Copy of other-wiki.reader.atlas-site.json',
    );
    await expect(editor.getByTestId('rules-editor-page').locator('option')).toHaveText([
      'reed-beds.html',
    ]);
    await expect(editor.getByTestId('rules-result-page').locator('.guide-card')).toHaveCount(2);
    await expect(card).toHaveCount(0);
    expect(out).toEqual([]);
    expect(realErrors(errors)).toEqual([]);
  });
});

test.describe('starting a new file from another', () => {
  test.use({ layout: 'standard' });

  test('starts from a copy of any file listed, made for another site, and starts again', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await mkdir(SHOTS, { recursive: true });
    await setUp(page, true, { others: OTHERS });
    const out = everyRequestOut(page);
    const sites = await openSites(page);
    await sites.getByTestId('sites-new').click();
    const editor = page.getByTestId('rules-editor');
    const templates = editor.getByTestId('rules-editor-templates');
    // Every file listed, as the importers report them, each with what it reads.
    const sources = templates.getByTestId('rules-copy-source');
    await expect(sources).toHaveCount(3);
    const harbour = templates.locator(
      '[data-testid="rules-copy-source"][data-key="other-wikis/harbour-wiki.atlas-site.json"]',
    );
    await expect(harbour).toContainText('Start from a copy of Harbour Wiki');
    await expect(harbour).toContainText(
      'It reads a wiki read by the reader “other-wiki” on harbour.example.net.',
    );
    await expect(
      templates.locator(
        '[data-testid="rules-copy-source"][data-key="other-wikis/other-wiki.reader.atlas-site.json"]',
      ),
    ).toContainText(
      'It holds the settings of the reader “other-wiki” for every site that reader reads. A copy is a file for one site.',
    );
    await page.screenshot({ path: `${SHOTS}/trial-readers-templates.png` });

    // A copy of a shipped site file: its own id, unless the person gives the shipped one.
    await harbour.click();
    const form = editor.getByTestId('rules-copy-form');
    await form.getByTestId('rules-copy-name').fill('Harbour Wiki');
    await expect(form.getByTestId('rules-copy-id')).toHaveValue('harbour-wiki');
    await expect(form.getByTestId('rules-copy-id-note')).toHaveText(
      'The file harbour-wiki.atlas-site.json comes with Other wikis: a copy saved with this id takes its place while your copy is switched on. To keep both, give another id.',
    );
    await form.getByTestId('rules-copy-name').fill('Marsh Wiki');
    await expect(form.getByTestId('rules-copy-id')).toHaveValue('marsh-wiki');
    await expect(form.getByTestId('rules-copy-id-note')).toHaveCount(0);
    await expect(form.getByTestId('rules-copy-name-note')).toHaveText(
      'The id comes from the site’s name unless you change it. The copy is saved as marsh-wiki.atlas-site.json.',
    );
    await form.getByTestId('rules-copy-make').click();
    await expect(form.getByTestId('rules-copy-problems')).toHaveText(
      'Give the site’s address or host, such as wiki.example.org.',
    );
    await form.getByTestId('rules-copy-host').fill('https://wiki.example.net/wiki/Reed_Beds');
    await form.getByTestId('rules-copy-game').fill('Marsh');
    await page.screenshot({ path: `${SHOTS}/trial-readers-copy-form.png` });
    await form.getByTestId('rules-copy-make').click();

    const text = editor.getByTestId('rules-editor-text');
    const copied = JSON.parse(await text.inputValue()) as {
      site: Record<string, unknown>;
      parts: { reader: string; reading: unknown }[];
    };
    expect(copied.site).toEqual({
      id: 'marsh-wiki',
      name: 'Marsh Wiki',
      game: 'Marsh',
      hosts: ['wiki.example.net'],
    });
    expect(copied.parts).toEqual([
      { type: 'wiki', reader: 'other-wiki', reading: { ways: ['fetch', 'browse'], pause: 5 } },
    ]);
    await expect(editor.getByTestId('rules-editor-title')).toHaveText('New rules file');
    await expect(editor.getByTestId('rules-editor-copied')).toContainText(
      'This file started from a copy of harbour-wiki.atlas-site.json, made for the site you named.',
    );
    await expect(editor.getByTestId('rules-editor-save-note')).toContainText(
      'It is saved as marsh-wiki.atlas-site.json in the Sites folder, switched off until you switch it on.',
    );
    await expect(editor.getByTestId('rules-editor-save')).toBeEnabled();

    // Tried on a page saved from the new site, in one step.
    await pickSavedPage(page, { name: 'reed-beds.html', text: STYLED_PAGE(3) });
    await editor.getByTestId('rules-editor-add-page').click();
    const result = editor.getByTestId('rules-editor-result');
    await expect(result.getByTestId('rules-result-lead')).toHaveText(
      'Part 1 of the file read it with the reader “other-wiki”, as a page of a wiki.',
    );
    await expect(result.getByTestId('rules-result-page').locator('.guide-card')).toHaveCount(2);
    await toResultStart(editor);
    await page.screenshot({ path: `${SHOTS}/trial-readers-copy.png` });

    // Start again from another template: asked first, as the copy is not saved.
    await editor.getByTestId('rules-editor-restart').click();
    await expect(editor.getByTestId('rules-editor-restart-ask')).toContainText(
      'Start again from another template? The text of this file as it stands is not kept. The example pages stay.',
    );
    await editor.getByTestId('rules-editor-restart-no').click();
    await expect(text).toHaveValue(/"marsh-wiki"/u);
    await editor.getByTestId('rules-editor-restart').click();
    await editor.getByTestId('rules-editor-restart-yes').click();
    // A reader's defaults, copied: a site file for the one site.
    await templates
      .locator(
        '[data-testid="rules-copy-source"][data-key="other-wikis/other-wiki.reader.atlas-site.json"]',
      )
      .click();
    await form.getByTestId('rules-copy-name').fill('Fen Wiki');
    await form.getByTestId('rules-copy-host').fill('wiki.example.net');
    await expect(form.getByTestId('rules-copy-what')).toContainText(
      'The copy is a file for the one site you name here',
    );
    await form.getByTestId('rules-copy-make').click();
    const fen = JSON.parse(await text.inputValue()) as Record<string, unknown>;
    expect(fen).toMatchObject({
      site: { id: 'fen-wiki', name: 'Fen Wiki', hosts: ['wiki.example.net'] },
      parts: [{ type: 'wiki', reader: 'other-wiki', start: '/' }],
    });
    expect(fen).not.toHaveProperty('readerDefaults');
    await expect(editor.getByTestId('rules-editor-page').locator('option')).toHaveText([
      'reed-beds.html',
    ]);
    await expect(result.getByTestId('rules-result-lead')).toHaveText(
      'Part 1 of the file read it with the reader “other-wiki”, as a page of a wiki.',
    );

    // And again, from an example for a type of site.
    await editor.getByTestId('rules-editor-restart').click();
    await editor.getByTestId('rules-editor-restart-yes').click();
    await templates.getByTestId('rules-template-wiki').click();
    await expect(text).toHaveValue(/"example-wiki"/u);
    await expect(editor.getByTestId('rules-editor-copied')).toHaveCount(0);
    await expect(editor.getByTestId('rules-editor-save')).toBeDisabled();
    expect(out).toEqual([]);
    expect(realErrors(errors)).toEqual([]);
  });
});

/** A made-up wiki's start page, saved from its start address. */
const LANTERNS_START = `<!doctype html>
<html><head><title>Lanterns Wiki</title>
<link rel="canonical" href="https://wiki.lanterns.example/"></head>
<body>
<nav class="side"><a href="/wiki/Lamps">Lamps</a> <a href="/wiki/Wicks">Wicks</a></nav>
<div id="body">
<h1 class="heading">Lanterns Wiki</h1>
<div class="text"><p>Welcome to the made-up wiki of lanterns, lamps and wicks.</p>
<h2>Where to start</h2><p>Read about <a href="/wiki/Lamps">lamps</a> first.</p></div>
</div>
</body></html>`;

/** Where the screenshots of what a page needs go: ATLAS_NEEDS_SHOTS, or with the editor's. */
const NEEDS_SHOTS = process.env.ATLAS_NEEDS_SHOTS ?? SHOTS;

test.describe('what a page needs', () => {
  test.use({ layout: 'standard' });

  test('lists the host, the address and where the text is for an example, and reads the page once all are the site’s own', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await mkdir(NEEDS_SHOTS, { recursive: true });
    await setUp(page, true, { others: OTHERS });
    const out = requestsOut(page);
    const sites = await openSites(page);
    await sites.getByTestId('sites-new').click();
    const editor = page.getByTestId('rules-editor');
    // The choice says what an example needs, and where a site an importer's own reader reads starts.
    await expect(editor.getByTestId('rules-templates-change')).toHaveText(
      'Before a saved page shows, change the example’s host, its start address and page patterns, and where the title and text are (for a map: where its data and locations are) to the site’s own; a site that one of the importers’ own readers reads is often simpler to start from a copy of that reader’s file instead, listed under “A copy of a file”.',
    );
    await editor.getByTestId('rules-template-wiki').click();
    const example = editor.getByTestId('rules-editor-example');
    await expect(example).toContainText(
      'Before a saved page shows here, change the host (site.hosts), the start address and page patterns (start, pages.include) and where the title and text are (article.title, article.content) to the site’s own;',
    );
    await expect(example).toContainText(
      'Still the example’s: site.hosts, parts[0].start, parts[0].pages.include, parts[0].article.content, parts[0].article.title.',
    );

    // A page saved from the made-up wiki's start address, tried on the untouched example.
    await pickSavedPage(page, { name: 'lanterns-start.html', text: LANTERNS_START });
    await editor.getByTestId('rules-editor-add-page').click();
    const result = editor.getByTestId('rules-editor-result');
    await expect(result).toContainText('The file did not read the page.');
    const needs = result.getByTestId('rules-result-need');
    await expect(needs).toHaveCount(3);
    await expect(needs.nth(0)).toHaveAttribute('data-state', 'missing');
    await expect(needs.nth(0)).toContainText(
      'The page was saved from wiki.lanterns.example, and site.hosts does not hold it (it holds "wiki.example.org").',
    );
    await expect(needs.nth(1)).toHaveAttribute('data-state', 'missing');
    await expect(needs.nth(1)).toContainText(
      'For a page saved from the site’s start address, set start to "/" and add "/" to pages.include.',
    );
    await expect(needs.nth(2)).toHaveAttribute('data-state', 'unchecked');
    await expect(needs.nth(2)).toContainText('Not checked yet');
    // Each need's sentence is said once: not again under what else went wrong.
    await expect(result.getByTestId('rules-result-problems')).toHaveCount(0);
    await toResultStart(editor);
    await page.screenshot({ path: `${NEEDS_SHOTS}/trial-needs-untouched-example.png` });

    // A need leads to its field.
    await needs.nth(0).getByRole('button', { name: 'Go to site.hosts' }).click();
    const text = editor.getByTestId('rules-editor-text');
    await expect(text).toBeFocused();

    // The host, the start and the selectors made the site's own: the page is read and drawn.
    const own = JSON.parse(await text.inputValue()) as {
      site: { hosts: string[] };
      parts: Record<string, unknown>[];
    };
    own.site.hosts = ['wiki.lanterns.example'];
    own.parts[0] = {
      ...own.parts[0],
      start: '/',
      pages: { include: ['/', '/wiki/*'] },
      contents: { from: 'menu', links: 'nav.side a' },
      article: { content: '#body .text', title: '#body .heading' },
    };
    await setText(editor, `${JSON.stringify(own, null, 2)}\n`);
    await expect(needs.nth(2)).toHaveAttribute('data-state', 'done');
    await expect(needs).toHaveText([
      /^DoneThe hostsite\.hosts holds wiki\.lanterns\.example/u,
      /^DoneThe addressThe page’s address, \/, is a page of part 1/u,
      'DoneWhere the title and text arearticle.content found the text, and article.title found the title “Lanterns Wiki”.',
    ]);
    await expect(result.getByTestId('rules-result-lead')).toHaveText(
      'Part 1 of the file read it, as a page of a wiki.',
    );
    await expect(result.getByTestId('rules-result-page')).toContainText(
      'Welcome to the made-up wiki of lanterns, lamps and wicks.',
    );
    await expect(example).toHaveCount(0);
    await toResultStart(editor);
    await page.screenshot({ path: `${NEEDS_SHOTS}/trial-needs-done.png` });
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
