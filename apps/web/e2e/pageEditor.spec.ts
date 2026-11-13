import { devices, type Page } from '@playwright/test';
import { collectErrors, storedSetting } from './helpers';
import { expect, test } from './layout';

/**
 * The page editor of Guides, in the standard layout, on the demo pack's
 * made-up wiki: a table cell edited and a row added, a picture of one's
 * own added, the Markdown view and back, saved and read again, the wiki's
 * version taken back, a page moved, and what is said when the wiki
 * changed a page the person changed. The person's pages are kept in the
 * browser's storage (`ownPages:demo`), apart from the pack.
 */

test.use({ layout: 'standard' });

const SETTING = 'ownPages:demo';
const WAYSTONES = 'demo:guide:wiki-waystones';

interface StoredPages {
  pages: { id: string; title?: string; body?: string; basedOn?: string; hidden?: true }[];
  sections: { id: string; title: string }[];
  contents?: { top: string[]; sections: Record<string, string[]> };
  pictures?: { id: string; file: string }[];
}

async function stored(page: Page): Promise<StoredPages | null> {
  const text = await storedSetting(page, SETTING);
  return typeof text === 'string' ? (JSON.parse(text) as StoredPages) : null;
}

/** The pack's text of a page, as the importer wrote it. */
async function packBody(page: Page, id: string): Promise<string> {
  const response = await page.request.get('./packs/demo/guides.json');
  const guides = (await response.json()) as { id: string; body: string }[];
  return guides.find((guide) => guide.id === id)!.body;
}

async function openGuides(page: Page): Promise<void> {
  await page.goto('./');
  await page.getByTestId('section-guides').click();
  await expect(page.getByTestId('guides-screen')).toBeVisible();
}

async function openPage(page: Page, sections: string | string[], name: string): Promise<void> {
  const body = page.getByTestId('guides-body');
  for (const section of Array.isArray(sections) ? sections : [sections]) {
    await body.getByTestId('guides-section').filter({ hasText: section }).first().click();
  }
  await body.getByTestId('guides-page-link').filter({ hasText: name }).first().click();
  await expect(page.getByTestId('guides-page').locator('h1')).toHaveText(name);
}

async function editPage(page: Page): Promise<void> {
  await page.getByTestId('edit-page').click();
  await expect(page.getByTestId('page-editor')).toBeVisible();
  await expect(page.getByTestId('page-blocks')).toBeVisible();
}

test('edits a table cell and adds a row; only that row changes, and it is kept', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openGuides(page);
  await openPage(page, 'The isle', 'Waystones');
  await editPage(page);
  const original = await packBody(page, WAYSTONES);

  // The cell "Touch the stone." gets more text.
  const cell = page.getByTestId('table-cell').filter({ hasText: 'Touch the stone.' });
  await cell.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Gently.');
  await expect(page.getByTestId('table-tools')).toBeVisible();
  // A row below the last one, typed in.
  await page.getByTestId('table-cell').filter({ hasText: /^3$/ }).click();
  await page.getByTestId('table-add-row').click();
  await page.keyboard.type('4');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Travel on.');
  await page.getByTestId('save-page').click();

  // The reader shows it.
  await expect(page.getByTestId('page-editor')).toHaveCount(0);
  const table = page.getByTestId('guides-page').locator('table').first();
  await expect(table).toContainText('Touch the stone. Gently.');
  await expect(table.locator('tbody tr')).toHaveCount(4);
  await expect(table.locator('tbody tr').last()).toHaveText(/4\s*Travel on\./);
  await expect(page.getByTestId('changed-by-you')).toBeVisible();

  // Kept apart from the pack, and the rest of the page byte for byte as it was.
  await expect.poll(async () => (await stored(page))?.pages.length).toBe(1);
  const record = (await stored(page))!.pages[0]!;
  expect(record.id).toBe(WAYSTONES);
  expect(record.basedOn).toBe(original);
  expect(record.body).toBe(
    original
      .replace('| 2 | Touch the stone. |', '| 2 | Touch the stone. Gently. |')
      .replace(
        '| 3 | Wait for the marks to glow. |',
        '| 3 | Wait for the marks to glow. |\n| 4 | Travel on. |',
      ),
  );
  expect(await packBody(page, WAYSTONES)).toBe(original);

  // Read again after a restart: still there.
  await page.reload();
  await page.getByTestId('section-guides').click();
  await openPage(page, 'The isle', 'Waystones');
  await expect(page.getByTestId('guides-page').locator('table').first()).toContainText(
    'Touch the stone. Gently.',
  );
  expect(errors).toEqual([]);
});

test('switches to Markdown and back; a page opened and saved unchanged stays the pack’s', async ({
  page,
}) => {
  await openGuides(page);
  await openPage(page, 'Basics', 'Welcome to the Sundered Isle');
  const original = await packBody(page, 'demo:guide:wiki-welcome');
  await editPage(page);

  await page.getByTestId('mode-markdown').click();
  const markdown = page.getByTestId('markdown-text');
  await expect(markdown).toHaveValue(original);
  // Typed as Markdown, shown with the text tools.
  await markdown.press('ControlOrMeta+End');
  await markdown.pressSequentially('\n\n## Added here\n\nA **new** line.');
  await page.getByTestId('mode-formatted').click();
  await expect(page.getByTestId('heading-field').last()).toHaveText('Added here');
  await expect(page.getByTestId('paragraph-field').last().locator('strong')).toHaveText('new');
  // Undo goes back to before the typing; the Markdown is the pack's again.
  await page.getByTestId('tool-undo').click();
  await page.getByTestId('mode-markdown').click();
  await expect(markdown).toHaveValue(original);
  await page.getByTestId('mode-formatted').click();
  await page.getByTestId('save-page').click();
  await expect(page.getByTestId('page-editor')).toHaveCount(0);
  expect((await stored(page))?.pages ?? []).toEqual([]);
});

test('adds a picture of one’s own, shown in the line of text', async ({ page }) => {
  const errors = collectErrors(page);
  await openGuides(page);
  await openPage(page, 'Basics', 'Getting around');
  await editPage(page);
  const shot = await page.screenshot({ clip: { x: 0, y: 0, width: 120, height: 60 } });

  await page.getByTestId('paragraph-field').first().click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.getByTestId('tool-picture').click();
  await page.getByTestId('picture-alt-new').fill('The ford');
  const choosing = page.waitForEvent('filechooser');
  await page.getByTestId('add-own-picture').click();
  await (await choosing).setFiles({ name: 'ford.png', mimeType: 'image/png', buffer: shot });
  const picture = page.getByTestId('paragraph-field').first().locator('img.md-picture');
  await expect(picture).toBeVisible();
  // Chosen, it gets its tools: a size in the line of text.
  await picture.click();
  await expect(page.getByTestId('picture-tools')).toBeVisible();
  await expect(page.getByTestId('picture-alt')).toHaveValue('The ford');
  await page.getByTestId('picture-size').selectOption('inline');
  await page.getByTestId('save-page').click();

  const shown = page.getByTestId('guides-page').locator('img').first();
  await expect(shown).toBeVisible();
  await expect(shown).toHaveAttribute('alt', 'The ford');
  await expect.poll(async () => (await stored(page))?.pictures?.length).toBe(1);
  const record = (await stored(page))!;
  expect(record.pictures![0]!.file).toMatch(/^pictures\/own\.[a-z0-9]+\.(webp|jpg|png)$/);
  expect(record.pages[0]!.body).toMatch(/!\[The ford\]\(demo:picture:own\.[a-z0-9]+ "=\d+x20"\)/);
  expect(errors).toEqual([]);
});

test('goes back to the wiki’s version, after asking', async ({ page }) => {
  await openGuides(page);
  await openPage(page, ['The isle', 'Foes'], 'Stone wardens');
  await editPage(page);
  await page.getByTestId('page-title').fill('Wardens of stone');
  await page.getByTestId('save-page').click();
  await expect(page.getByTestId('guides-page').locator('h1')).toHaveText('Wardens of stone');

  await editPage(page);
  // The wiki's version, to see.
  await page.getByTestId('see-wiki-version').click();
  await expect(page.getByTestId('wiki-version').locator('h1')).toHaveText('Stone wardens');
  await page.getByTestId('see-wiki-version').click();
  await page.getByTestId('revert-to-wiki').click();
  await expect(page.getByTestId('revert-dialog')).toBeVisible();
  await page.getByTestId('revert-dialog').getByTestId('confirm-button').click();
  await expect(page.getByTestId('page-title')).toHaveValue('Stone wardens');
  await page.getByTestId('cancel-edit').click();
  await expect(page.getByTestId('guides-page').locator('h1')).toHaveText('Stone wardens');
  await expect(page.getByTestId('changed-by-you')).toHaveCount(0);
  await expect.poll(async () => (await stored(page))?.pages.length ?? 0).toBe(0);
});

test('moves a page to another section, and asks before leaving changes not saved', async ({
  page,
}) => {
  await openGuides(page);
  await openPage(page, 'The isle', 'Waystones');
  await editPage(page);
  const contents = page.getByTestId('contents-editor');
  const wolves = contents.getByTestId('contents-row').filter({ hasText: 'Wolves' });
  await wolves.getByTestId('contents-more').click();
  await wolves.getByTestId('contents-move-to').click();
  await page
    .getByTestId('move-dialog')
    .getByTestId('move-choice')
    .filter({ hasText: 'Basics' })
    .click();
  // In Basics now, after its pages.
  await expect(contents.locator('[data-entry="demo:guide:wiki-wolves"]')).toBeVisible();
  await expect
    .poll(async () => (await stored(page))?.contents?.sections)
    .toMatchObject({
      'demo:section:wiki-basics': expect.arrayContaining(['demo:guide:wiki-wolves']),
    });
  // Moved up with Alt+Up on its handle.
  const handle = contents
    .getByTestId('contents-row')
    .filter({ hasText: 'Wolves' })
    .getByTestId('contents-handle');
  const before = (await stored(page))!.contents!.sections['demo:section:wiki-basics']!;
  await handle.focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect
    .poll(async () => (await stored(page))!.contents!.sections['demo:section:wiki-basics'])
    .toEqual([...before.slice(0, -2), 'demo:guide:wiki-wolves', before.at(-2)!]);

  // A change not saved: leaving asks.
  await page.getByTestId('paragraph-field').nth(1).click();
  await page.keyboard.type('Changed. ');
  await contents.getByTestId('contents-page').filter({ hasText: 'Regions' }).click();
  await expect(page.getByTestId('leave-dialog')).toBeVisible();
  await page.getByTestId('leave-discard').click();
  await expect(page.getByTestId('page-title')).toHaveValue('Regions');

  // The reader's contents have it in Basics too.
  await page.getByTestId('cancel-edit').click();
  await page.locator('.guides-crumbs').getByRole('button', { name: 'Contents' }).click();
  await page
    .getByTestId('guides-body')
    .getByTestId('guides-section')
    .filter({ hasText: 'Basics' })
    .click();
  await expect(page.getByTestId('guides-body').getByTestId('guides-page-link')).toContainText([
    'Wolves',
  ]);
});

test('says when the wiki changed a page the person changed, and keeps their text', async ({
  page,
}) => {
  await page.goto('./');
  await page.getByTestId('section-guides').click();
  // A change made to an older wiki text of the page.
  await page.evaluate(async (key) => {
    const open = indexedDB.open('atlas');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => {
        resolve(open.result);
      };
      open.onerror = () => {
        reject(new Error(String(open.error)));
      };
    });
    const tx = db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({
      key,
      value: JSON.stringify({
        format: 'atlas-own-pages',
        version: 1,
        gameId: 'demo',
        updatedAt: '2026-11-13T10:00:00.000Z',
        pages: [
          {
            id: 'demo:guide:wiki-wolves',
            body: 'My own notes on wolves.',
            basedOn: 'An older text of the wiki.',
            updatedAt: '2026-11-13T10:00:00.000Z',
          },
        ],
        sections: [],
      }),
    });
    await new Promise((resolve) => {
      tx.oncomplete = resolve;
    });
    db.close();
  }, SETTING);
  await page.reload();
  await page.getByTestId('section-guides').click();
  await openPage(page, ['The isle', 'Foes'], 'Wolves');

  const notice = page.getByTestId('wiki-changed');
  await expect(notice).toContainText('The wiki changed this page since you changed it.');
  await expect(page.getByTestId('guides-page')).toContainText('My own notes on wolves.');
  await page.getByTestId('see-wiki-new').click();
  await expect(page.getByTestId('guides-page')).toContainText('Fire keeps them back.');
  await page.getByTestId('see-wiki-new').click();
  await expect(page.getByTestId('guides-page')).toContainText('My own notes on wolves.');
  // "Keep my version": the change counts as seen, the text stays.
  await page.getByTestId('keep-my-version').click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByTestId('guides-page')).toContainText('My own notes on wolves.');
  const wiki = await packBody(page, 'demo:guide:wiki-wolves');
  await expect.poll(async () => (await stored(page))?.pages[0]?.basedOn).toBe(wiki);
  expect((await stored(page))!.pages[0]!.body).toBe('My own notes on wolves.');
});

test.describe('on a phone', () => {
  const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];
  test.use({ ...pixel });

  test('edits a page with a finger: the text, then “About this page” under it', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openGuides(page);
    await openPage(page, 'Basics', 'Getting around');
    await page.getByTestId('edit-page').tap();
    await expect(page.getByTestId('page-editor')).toHaveClass(/pe-compact/);
    await expect(page.getByTestId('about-page')).toBeVisible();
    const field = page.getByTestId('paragraph-field').first();
    await field.tap();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' Bring a lamp.');
    // Enter makes a new paragraph, as a phone's keyboard sends it.
    await page.keyboard.press('Enter');
    await page.keyboard.type('A second thought.');
    await expect(page.getByTestId('paragraph-field').nth(1)).toHaveText('A second thought.');
    await page.getByTestId('save-page').tap();
    await expect(page.getByTestId('guides-page')).toContainText('Bring a lamp.');
    await expect(page.getByTestId('guides-page')).toContainText('A second thought.');
    expect(errors).toEqual([]);
  });
});
