import { devices, type Page } from '@playwright/test';
import { collectErrors, storedSetting } from './helpers';
import { expect, test } from './layout';
import { servePageTree } from './pageTreePack';

/**
 * The tools of the contents beside the page edited that arrange the menu,
 * on the made-up wiki of `pageTreePack.ts`: the pages its menu does not
 * name in one group at the end, "Not in the menu", moved into the menu
 * and back; pages ticked and moved together; a new level made of them
 * with a list of them in its text; the pages a page lists filed under it
 * at once; and a list of the pages under a page put in its text.
 */

test.use({ layout: 'standard' });

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

const OWN_PAGES = 'ownPages:demo';
const g = (local: string) => `demo:guide:${local}`;

interface Stored {
  pages: { id: string; title?: string; body?: string }[];
  contents?: { top: string[]; sections: Record<string, string[]> };
  listPages?: Record<string, boolean>;
}

async function stored(page: Page): Promise<Stored | null> {
  const text = await storedSetting(page, OWN_PAGES);
  return typeof text === 'string' ? (JSON.parse(text) as Stored) : null;
}

const shownPage = (page: Page) => page.getByTestId('guides-page');
const contents = (page: Page) => page.getByTestId('contents-editor');
const outside = (page: Page) => contents(page).getByTestId('contents-outside');
const row = (page: Page, title: string) =>
  contents(page)
    .getByTestId('contents-row')
    .filter({ has: page.getByTestId('contents-page').getByText(title, { exact: true }) });

async function openBySearch(page: Page, query: string, title: string): Promise<void> {
  await page.getByTestId('guides-search').first().fill(query);
  await page.getByTestId('guides-result').filter({ hasText: title }).first().click();
  await expect(shownPage(page).locator('h1')).toHaveText(title);
}

/** Opens a page in the page editor, the contents beside it. */
async function edit(page: Page, query: string, title: string): Promise<void> {
  await servePageTree(page);
  await page.goto('./');
  await openBySearch(page, query, title);
  await page.getByTestId('edit-page').click();
  await expect(contents(page)).toBeVisible();
}

/** Unfolds a page row of the contents editor. */
async function unfold(page: Page, title: string): Promise<void> {
  const fold = row(page, title).getByTestId('contents-fold');
  if ((await fold.getAttribute('aria-expanded')) === 'false') await fold.click();
}

test.describe('on a desktop', () => {
  test('ticks three pages, a run with Shift, and moves them under a page with one undo', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await edit(page, 'helm of the warden', 'Warden Helm');
    // The page edited is outside the menu: its group is open, its pages flat, in the wiki's order.
    await expect(outside(page).getByTestId('contents-outside-fold')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await row(page, 'Warden Helm').getByTestId('contents-tick').click();
    await row(page, 'Warden Gloves')
      .getByTestId('contents-tick')
      .click({ modifiers: ['Shift'] });
    const bar = page.getByTestId('contents-ticked-bar');
    await expect(bar.getByTestId('contents-ticked-count')).toHaveText('3 pages ticked');
    await expect(row(page, 'Warden Boots').getByTestId('contents-tick')).toBeChecked();

    await bar.getByTestId('ticked-move').click();
    const dialog = page.getByTestId('move-dialog');
    await expect(dialog.locator('h2, header').first()).toContainText('Move 3 pages to…');
    await dialog.getByTestId('move-page-query').fill('iron');
    await dialog.getByTestId('move-under-choice').filter({ hasText: 'Iron Cap' }).click();
    await expect(page.getByTestId('contents-ticked-bar')).toHaveCount(0);
    await expect
      .poll(async () => (await stored(page))?.contents?.sections[g('iron-cap')])
      .toEqual([g('warden-helm'), g('warden-boots'), g('warden-gloves')]);
    await unfold(page, 'Iron Cap');
    await expect(row(page, 'Warden Boots')).toBeVisible();

    // One undo puts all three back.
    await page.getByRole('button', { name: 'Undo' }).last().click();
    await expect
      .poll(async () => (await stored(page))?.contents?.sections[g('iron-cap')])
      .toBeUndefined();
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });

  test('makes a new level of the ticked pages, its text listing them', async ({ page }) => {
    await edit(page, 'light mail from the ash', 'Ash Mail');
    await row(page, 'Ash Mail').getByTestId('contents-tick').click();
    await row(page, 'Iron Cap').getByTestId('contents-tick').click();
    await page.getByTestId('ticked-level').click();
    const dialog = page.getByTestId('level-dialog');
    await expect(dialog.getByTestId('level-list')).toBeChecked();
    await dialog.getByTestId('level-name').fill('Light armour');
    await dialog.getByTestId('level-make').click();

    await expect
      .poll(async () => (await stored(page))?.pages.find((p) => p.title === 'Light armour'))
      .toBeTruthy();
    const level = (await stored(page))!.pages.find((p) => p.title === 'Light armour')!;
    expect(level.body).toBe(`- [Ash Mail](${g('ash-mail')})\n- [Iron Cap](${g('iron-cap')})\n`);
    expect((await stored(page))!.contents!.sections[level.id]).toEqual([
      g('ash-mail'),
      g('iron-cap'),
    ]);
    // Where Ash Mail was, outside the menu, holding the two.
    await expect(row(page, 'Light armour')).toBeVisible();
    await page.getByTestId('cancel-edit').click();
    await openBySearch(page, 'a plain cap', 'Iron Cap');
    await expect(page.locator('.guides-crumbs')).toHaveText(
      /^Example Wiki\s*›\s*Light armour\s*›\s*Iron Cap$/,
    );
  });

  test('files the pages a page lists under it at once, and nothing more after', async ({
    page,
  }) => {
    await edit(page, 'notes from the field', 'Field Notes');
    const notes = row(page, 'Field Notes');
    await expect(notes.getByTestId('contents-fold')).toHaveCount(0);
    // No say on the page to keep: one move, as if the person had made it.
    await expect(notes.getByTestId('contents-say')).toHaveCount(0);
    await notes.getByTestId('contents-more').click();
    await notes.getByTestId('contents-file-listed').click();
    await expect
      .poll(async () => (await stored(page))?.contents?.sections[g('field-notes')])
      .toEqual([g('old-map'), g('lost-key'), g('torn-page')]);
    expect((await stored(page))?.listPages).toBeUndefined();
    await expect(page.getByText('Filed 3 pages under “Field Notes”.')).toBeVisible();
    await unfold(page, 'Field Notes');
    await expect(row(page, 'Old Map')).toBeVisible();
    // Again: they are under it already, so nothing moves.
    await notes.getByTestId('contents-more').click();
    await notes.getByTestId('contents-file-listed').click();
    await expect(page.getByText(/so nothing moved/)).toBeVisible();
    // In the menu now, by hand: the bar shows them under Field Notes.
    await page.getByTestId('cancel-edit').click();
    await openBySearch(page, 'a keepsake: the lost key', 'Lost Key');
    await expect(page.locator('.guides-crumbs')).toHaveText(
      /^Example Wiki\s*›\s*Basics\s*›\s*Field Notes\s*›\s*Lost Key$/,
    );
    await expect(page.locator('.guides-side [aria-current="page"]')).toHaveText('Lost Key');
  });

  test('moves a page from Not in the menu into the menu, and back', async ({ page }) => {
    await edit(page, 'nothing links here', 'Stray Note');
    await expect(outside(page)).toContainText('Not in the menu');
    // No handle and no menu: it is no section to move.
    await expect(outside(page).getByTestId('contents-handle')).toHaveCount(0);
    await expect(outside(page).getByTestId('contents-more')).toHaveCount(0);
    const stray = row(page, 'Stray Note');
    await stray.getByTestId('contents-more').click();
    await stray.getByTestId('contents-move-to').click();
    const dialog = page.getByTestId('move-dialog');
    await dialog.getByTestId('move-choice').filter({ hasText: 'Basics' }).click();
    await expect
      .poll(async () => (await stored(page))?.contents?.sections['demo:section:basics'])
      .toEqual([g('gear'), g('field-notes'), g('stray-note')]);
    await page.getByTestId('cancel-edit').click();
    await expect(page.locator('.guides-crumbs')).toHaveText(
      /^Example Wiki\s*›\s*Basics\s*›\s*Stray Note$/,
    );

    // Taken out again: back to the group, and out of the bar.
    await page.getByTestId('edit-page').click();
    await row(page, 'Stray Note').getByTestId('contents-more').click();
    await row(page, 'Stray Note').getByTestId('contents-move-to').click();
    await page.getByTestId('move-dialog').getByTestId('move-outside').click();
    await expect
      .poll(async () => (await stored(page))?.contents?.sections['demo:section:basics'])
      .toEqual([g('gear'), g('field-notes')]);
    await page.getByTestId('cancel-edit').click();
    await expect(page.locator('.guides-crumbs')).toHaveText(/^Example Wiki\s*›\s*Stray Note$/);

    // A page the site's own menu names stays in the menu.
    await page.getByTestId('edit-page').click();
    await contents(page).locator('.pe-tree-section').filter({ hasText: 'Equipment' }).waitFor();
    const armor = row(page, 'Armor');
    await armor.getByTestId('contents-more').click();
    await armor.getByTestId('contents-move-to').click();
    await page.getByTestId('move-dialog').getByTestId('move-outside').click();
    await expect(page.getByText(/“Armor” is in the site’s own menu, so it stays/)).toBeVisible();
    expect((await stored(page))?.contents?.sections['demo:section:equipment']).toEqual([
      g('armor'),
      g('weapons'),
    ]);
  });

  test('puts a list of the pages under a page in its text, as links', async ({ page }) => {
    await edit(page, 'heavy plate worn by the wardens', 'Warden Plate');
    // The pages it lists, put under it first.
    const plate = row(page, 'Warden Plate');
    await plate.getByTestId('contents-more').click();
    await plate.getByTestId('contents-file-listed').click();
    await expect
      .poll(async () => (await stored(page))?.contents?.sections[g('warden-plate')])
      .toEqual([g('warden-helm'), g('warden-boots'), g('warden-gloves')]);
    await page.getByTestId('paragraph-field').first().click();
    await page.getByTestId('tool-more').click();
    await expect(page.getByText('The list is text from then on')).toBeVisible();
    await page.getByTestId('tool-pages-list').click();
    await page.getByTestId('save-page').click();
    await expect
      .poll(async () => (await stored(page))?.pages[0]?.body)
      .toContain(
        `- [Warden Helm](${g('warden-helm')})\n- [Warden Boots](${g('warden-boots')})\n- [Warden Gloves](${g('warden-gloves')})`,
      );
    await expect(shownPage(page).locator('.guides-page-body .app-link')).toContainText([
      'Warden Helm',
      'Warden Boots',
      'Warden Gloves',
    ]);
  });
});

/** Drags a row by its handle onto another row: its middle, or `at` of the way down it. */
async function dragOnto(
  page: Page,
  from: ReturnType<typeof row>,
  onto: ReturnType<typeof row>,
  at = 0.5,
) {
  const handle = await from.getByTestId('contents-handle').boundingBox();
  const target = await onto.boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height * at, {
    steps: 8,
  });
  await page.mouse.up();
}

test.describe('dragging and new pages', () => {
  test('drags the ticked pages together, and no page of the site’s menu out of it', async ({
    page,
  }) => {
    await edit(page, 'light mail from the ash', 'Ash Mail');
    await row(page, 'Ash Mail').getByTestId('contents-tick').click();
    await row(page, 'Iron Cap').getByTestId('contents-tick').click();
    // Weapons in view below the bar of ticked pages, and Iron Cap with it.
    await row(page, 'Weapons').evaluate((element) => {
      element.scrollIntoView({ block: 'start' });
      let parent = element.parentElement;
      while (parent && parent.scrollHeight <= parent.clientHeight) parent = parent.parentElement;
      if (parent) parent.scrollTop -= 200;
    });
    await dragOnto(page, row(page, 'Iron Cap'), row(page, 'Weapons'));
    await expect
      .poll(async () => (await stored(page))?.contents?.sections[g('weapons')])
      .toEqual([g('ash-mail'), g('iron-cap')]);
    // Out of the group of pages outside the menu.
    expect((await stored(page))?.contents?.sections['demo:section:pages']).not.toContain(
      g('ash-mail'),
    );

    // A page the site's menu names is refused by the group, and the app says why.
    await row(page, 'Field Notes').evaluate((element) => {
      element.scrollIntoView({ block: 'center' });
    });
    await dragOnto(page, row(page, 'Field Notes'), outside(page));
    await expect(page.getByText(/“Field Notes” is in the site’s own menu/)).toBeVisible();
    expect((await stored(page))?.contents?.sections['demo:section:basics']).toEqual([
      g('gear'),
      g('field-notes'),
    ]);
  });

  test('adds a new page under a page from its menu, opened to be written', async ({ page }) => {
    await edit(page, 'a plain cap', 'Iron Cap');
    const cap = row(page, 'Iron Cap');
    await cap.getByTestId('contents-more').click();
    await cap.getByTestId('contents-new-page-under').click();
    await expect(page.getByTestId('page-title')).toHaveValue('New page');
    await expect
      .poll(async () => (await stored(page))?.contents?.sections[g('iron-cap')]?.length)
      .toBe(1);
    // And under the page edited, from the button over the contents.
    await contents(page).getByTestId('contents-page').getByText('Ash Mail').click();
    await page.getByTestId('new-page-under').click();
    await expect
      .poll(async () => (await stored(page))?.contents?.sections[g('ash-mail')]?.length)
      .toBe(1);
  });
});

test.describe('on a phone', () => {
  test.use({ ...pixel });

  test('ticks pages and moves them together in the contents sheet', async ({ page }) => {
    await servePageTree(page);
    await page.goto('./');
    await page.getByTestId('guides-search').first().fill('helm of the warden');
    await page.getByTestId('guides-result').first().tap();
    await page.getByTestId('edit-page').tap();
    await page.getByTestId('page-editor').getByRole('button', { name: 'Contents' }).tap();
    await expect(contents(page)).toBeVisible();
    // On a touch screen the boxes are in view without a pointer over them.
    await expect(row(page, 'Warden Helm').getByTestId('contents-tick')).toHaveCSS('opacity', '1');
    await row(page, 'Warden Helm').getByTestId('contents-tick').tap();
    await row(page, 'Warden Boots').getByTestId('contents-tick').tap();
    await expect(page.getByTestId('contents-ticked-count')).toHaveText('2 pages ticked');
    await page.getByTestId('ticked-move').tap();
    await page
      .getByTestId('move-dialog')
      .getByTestId('move-choice')
      .filter({ hasText: 'Basics' })
      .tap();
    await expect
      .poll(async () => (await stored(page))?.contents?.sections['demo:section:basics'])
      .toEqual([g('gear'), g('field-notes'), g('warden-helm'), g('warden-boots')]);
  });
});
