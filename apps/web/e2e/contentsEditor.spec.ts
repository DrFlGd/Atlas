import { devices, type Page } from '@playwright/test';
import { collectErrors, storedSetting } from './helpers';
import { expect, test } from './layout';
import { servePageTree } from './pageTreePack';

/**
 * The tools of the contents beside the page edited that make levels of
 * pages and fill them, on the made-up wiki of `pageTreePack.ts`: pages
 * ticked and moved together, a new level made of them with a list of them
 * in its text, a page told to file the pages it lists (and the app let
 * decide again), a list of the pages under a page put in its text, and a
 * level made of a page's heading made a page of one's own.
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
    // The way to the page edited is open: Armor › Warden Plate › its three pieces.
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
    // Under Armor, where Ash Mail was, holding the two.
    await expect(row(page, 'Light armour')).toBeVisible();
    await page.getByTestId('cancel-edit').click();
    await openBySearch(page, 'a plain cap', 'Iron Cap');
    await expect(page.locator('.guides-crumbs')).toHaveText(
      /Equipment\s*›\s*Armor\s*›\s*Light armour\s*›\s*Iron Cap/,
    );
  });

  test('files the pages a page lists when told to, and lets the app decide again', async ({
    page,
  }) => {
    await edit(page, 'notes from the field', 'Field Notes');
    const notes = row(page, 'Field Notes');
    await expect(notes.getByTestId('contents-fold')).toHaveCount(0);
    await notes.getByTestId('contents-more').click();
    await notes.getByTestId('contents-file-listed').click();
    await expect
      .poll(async () => (await stored(page))?.listPages)
      .toEqual({
        [g('field-notes')]: true,
      });
    await expect(notes.getByTestId('contents-say')).toHaveText('Files its list');
    await unfold(page, 'Field Notes');
    await expect(row(page, 'Old Map')).toBeVisible();
    await expect(row(page, 'Torn Page')).toBeVisible();
    // The menu says which is in force, and takes it back.
    await notes.getByTestId('contents-more').click();
    await expect(notes.getByTestId('contents-file-listed')).toHaveAttribute('aria-checked', 'true');
    await expect(notes.getByTestId('contents-file-none')).toHaveAttribute('aria-checked', 'false');
    await notes.getByTestId('contents-file-auto').click();
    await expect.poll(async () => (await stored(page))?.listPages).toBeUndefined();
    await expect(notes.getByTestId('contents-fold')).toHaveCount(0);
    await expect(notes.getByTestId('contents-say')).toHaveCount(0);
  });

  test('puts a list of the pages under a page in its text, as links', async ({ page }) => {
    await edit(page, 'heavy plate worn by the wardens', 'Warden Plate');
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

  test('shows the levels of a list page’s headings, and makes one a page of one’s own', async ({
    page,
  }) => {
    await edit(page, 'all the gear of the isle', 'Gear');
    await unfold(page, 'Gear');
    const levels = contents(page).getByTestId('contents-level');
    await expect(levels).toHaveText([/Weapons/, /Charms/]);
    // No handle: they come from the page's headings.
    await expect(levels.first().getByTestId('contents-handle')).toHaveCount(0);
    const charms = levels.filter({ hasText: 'Charms' });
    await charms.getByTestId('contents-more').click();
    await charms.getByTestId('contents-level-own').click();
    await expect(levels).toHaveText([/Weapons/]);
    await expect(row(page, 'Charms')).toBeVisible();
    await expect(row(page, 'Charms').getByTestId('contents-tag')).toHaveText('Yours');
    await expect
      .poll(async () => {
        const own = await stored(page);
        const made = own?.pages.find((p) => p.title === 'Charms');
        return made ? own?.contents?.sections[made.id] : undefined;
      })
      .toEqual([g('bone-charm'), g('tin-charm'), g('reed-charm')]);
  });
});

/** Drags a row by its handle onto the middle of another row. */
async function dragOnto(page: Page, from: ReturnType<typeof row>, onto: ReturnType<typeof row>) {
  const handle = await from.getByTestId('contents-handle').boundingBox();
  const target = await onto.boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
}

test.describe('dragging and new pages', () => {
  test('drags the ticked pages together, and nothing onto a level', async ({ page }) => {
    await edit(page, 'light mail from the ash', 'Ash Mail');
    await row(page, 'Ash Mail').getByTestId('contents-tick').click();
    await row(page, 'Iron Cap').getByTestId('contents-tick').click();
    await dragOnto(page, row(page, 'Iron Cap'), row(page, 'Weapons'));
    await expect
      .poll(async () => (await stored(page))?.contents?.sections[g('weapons')])
      .toEqual([g('longblade'), g('short-bow'), g('hand-axe'), g('ash-mail'), g('iron-cap')]);

    // A level comes from a page's headings: a page dropped on it is refused, and says why.
    await contents(page).getByTestId('contents-page').getByText('Gear', { exact: true }).click();
    await unfold(page, 'Gear');
    const charms = contents(page).getByTestId('contents-level').filter({ hasText: 'Charms' });
    await dragOnto(page, row(page, 'Field Notes'), charms);
    await expect(page.getByText(/comes from the headings of “Gear”/)).toBeVisible();
    await expect
      .poll(async () => (await stored(page))?.contents?.sections[g('gear')])
      .toBeUndefined();
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
    await page.getByTestId('guides-search').first().fill('heavy plate');
    await page.getByTestId('guides-result').first().tap();
    await page.getByTestId('edit-page').tap();
    await page.getByTestId('page-editor').getByRole('button', { name: 'Contents' }).tap();
    await expect(contents(page)).toBeVisible();
    await unfold(page, 'Warden Plate');
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
