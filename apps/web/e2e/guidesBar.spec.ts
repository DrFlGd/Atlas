import type { Page } from '@playwright/test';
import { collectErrors, reloadSaved, storedSetting } from './helpers';
import { expect, test } from './layout';
import { pageTreeGuides, pageTreeSections, servePageTree } from './pageTreePack';

/**
 * The contents beside a page in Guides folds away and comes back, on the
 * made-up wiki of `pageTreePack.ts`: from the button at the top of the
 * bar, the button that takes its place beside "Home", or the key B.
 * Folded, the page takes the width as for a wiki with no menu, and nothing
 * is lost: the place read in the page, the tree as it was unfolded, the
 * listing of a page the menu names twice. The choice is kept on this
 * device. A narrow window shows the contents as before, with no bar to fold.
 */

test.use({ layout: 'standard' });

const shownPage = (page: Page) => page.getByTestId('guides-page');
const screen = (page: Page) => page.getByTestId('guides-screen');
const bar = (page: Page) => page.getByTestId('guides-bar');
const hide = (page: Page) => page.getByTestId('guides-bar-hide');
const show = (page: Page) => page.getByTestId('guides-bar-show');
const body = (page: Page) => page.getByTestId('guides-body');
const crumbs = (page: Page) => page.locator('.guides-crumbs');
const heading = (page: Page, name: string) =>
  bar(page).locator('.guides-tree-section').filter({ hasText: name });

/** The line as words, steps parted by "›". */
const line = (...steps: string[]) =>
  new RegExp(`^${steps.map((step) => step.replace(/\s+/g, '\\s*')).join('\\s*›\\s*')}$`);

/** The width of the page area and of the whole of Guides. */
const widths = (page: Page) =>
  page.evaluate(() => ({
    reader: document.querySelector('.guides-reader')!.clientWidth,
    screen: document.querySelector('[data-testid="guides-screen"]')!.clientWidth,
  }));

/** The made-up wiki, Armor leading a section of its own that also lists Warden Plate (listed under Basics too). */
async function serveWithLeadPages(page: Page): Promise<void> {
  await servePageTree(page);
  await page.route('**/packs/tree/sections.json', (route) => {
    const sections = pageTreeSections() as { id: string; title: string; items: string[] }[];
    const byId = (id: string) => sections.find((section) => section.id === `demo:section:${id}`)!;
    byId('equipment').items = ['demo:section:armor', 'demo:guide:weapons'];
    byId('basics').items = ['demo:guide:gear', 'demo:guide:warden-plate'];
    sections.unshift({
      id: 'demo:section:armor',
      title: 'Armor',
      items: ['demo:guide:armor', 'demo:guide:warden-plate', 'demo:guide:ash-mail'],
    });
    return route.fulfill({ json: sections });
  });
}

/** Sixty paragraphs, each long enough to take several lines, numbered. */
const LONG_TEXT = Array.from(
  { length: 60 },
  (_, i) =>
    `Paragraph ${i + 1}. ` +
    'The creatures of the made-up isle walk the marsh at dusk and the caves at dawn, '.repeat(6),
).join('\n\n');

/** The paragraph of the page at the top of the page area, by its number. */
const paragraphAtTop = (page: Page) =>
  body(page).evaluate((root) => {
    const top = root.getBoundingClientRect().top + 8;
    const shown = [...root.querySelectorAll('.guides-page-body p')].find((p) => {
      const box = p.getBoundingClientRect();
      return box.top <= top && box.bottom > top;
    });
    return shown?.textContent.match(/^Paragraph (\d+)/u)?.[1] ?? null;
  });

test.describe('on a desktop', () => {
  test('folds the bar away and brings it back, the focus on the button each time', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await serveWithLeadPages(page);
    await page.goto('./');
    await expect(screen(page)).toHaveAttribute('data-bar', 'open');
    await expect(show(page)).toHaveCount(0);

    // Armor, its pages folded by hand.
    await heading(page, 'Equipment').click();
    await heading(page, 'Armor').click();
    await expect(shownPage(page).locator('h1')).toHaveText('Armor');
    await heading(page, 'Armor').click();
    await expect(heading(page, 'Armor')).toHaveAttribute('aria-expanded', 'false');
    const here = bar(page).locator('[data-here]');
    await expect(here).toHaveText('Armor');
    const unfolded = await bar(page)
      .locator('.guides-tree-section')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-expanded')));

    // The button at the top of the bar, named, with its key.
    const barId = await bar(page).getAttribute('id');
    expect(barId).toBeTruthy();
    await expect(hide(page)).toHaveAccessibleName('Hide the contents');
    await expect(hide(page)).toHaveAttribute('title', 'Hide the contents (B)');
    await expect(hide(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(hide(page)).toHaveAttribute('aria-controls', barId!);
    await expect(hide(page)).toHaveAttribute('aria-keyshortcuts', 'B');
    const before = await widths(page);
    expect(before.reader).toBeLessThan(before.screen);
    await hide(page).focus();
    await page.keyboard.press('Enter');

    // Folded: the page takes the width, the head holds what the bar did, and the button to bring it back has the focus.
    await expect(screen(page)).toHaveAttribute('data-bar', 'folded');
    await expect(bar(page)).toBeHidden();
    await expect(bar(page)).toHaveAttribute('hidden', '');
    const folded = await widths(page);
    expect(folded.reader).toBe(folded.screen);
    await expect(show(page)).toBeFocused();
    await expect(show(page)).toBeInViewport();
    await expect(show(page)).toHaveAccessibleName('Show the contents');
    await expect(show(page)).toHaveAttribute('title', 'Show the contents (B)');
    await expect(show(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(show(page)).toHaveAttribute('aria-controls', barId!);
    // Beside Home, before the line.
    const homeBox = (await page.getByTestId('guides-home-button').boundingBox())!;
    const showBox = (await show(page).boundingBox())!;
    const lineBox = (await crumbs(page).boundingBox())!;
    expect(showBox.x).toBeGreaterThan(homeBox.x);
    expect(showBox.x).toBeLessThan(lineBox.x);
    const tools = page.getByTestId('guides-head-tools');
    await expect(tools.getByTestId('guides-search')).toBeVisible();
    await expect(tools.getByTestId('guides-all-pages')).toBeVisible();
    // The page and the line stay as they were; Tab does not reach into the folded bar.
    await expect(shownPage(page).locator('h1')).toHaveText('Armor');
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Equipment', 'Armor'));
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(
          (id) => document.getElementById(id)!.contains(document.activeElement),
          barId!,
        ),
      ).toBe(false);
    }

    // Back: the button that folds it has the focus, the tree as it was, the row of the page in view.
    await show(page).click();
    await expect(screen(page)).toHaveAttribute('data-bar', 'open');
    await expect(bar(page)).toBeVisible();
    await expect(hide(page)).toBeFocused();
    await expect(show(page)).toHaveCount(0);
    await expect(page.getByTestId('guides-head-tools')).toHaveCount(0);
    expect(
      await bar(page)
        .locator('.guides-tree-section')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-expanded'))),
    ).toEqual(unfolded);
    await expect(heading(page, 'Armor')).toHaveAttribute('aria-expanded', 'false');
    await expect(here).toHaveText('Armor');
    await expect(here).toBeInViewport();
    expect((await widths(page)).reader).toBe(before.reader);

    // A page the menu names twice, opened at its second listing: still there after a fold.
    await heading(page, 'Basics').click();
    await bar(page)
      .getByTestId('guides-tree-page')
      .getByText('Warden Plate', { exact: true })
      .click();
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Basics', 'Warden Plate'));
    const basics = heading(page, 'Basics').locator('xpath=..');
    await expect(basics.locator('[data-here]')).toHaveText('Warden Plate');
    await hide(page).click();
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Basics', 'Warden Plate'));
    await show(page).click();
    await expect(crumbs(page)).toHaveText(line('Example Wiki', 'Basics', 'Warden Plate'));
    await expect(basics.locator('[data-here]')).toHaveText('Warden Plate');
    await expect(here).toHaveCount(1);
    await expect(here).toBeInViewport();
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });

  test('keeps the place read in the page, though its lines are wider', async ({ page }) => {
    await servePageTree(page);
    await page.route('**/packs/tree/guides.json', (route) =>
      route.fulfill({
        json: pageTreeGuides().map((guide) =>
          guide.id === 'demo:guide:bestiary' ? { ...guide, body: LONG_TEXT } : guide,
        ),
      }),
    );
    await page.goto('./');
    await heading(page, 'The world').click();
    await bar(page).getByTestId('guides-tree-page').getByText('Bestiary', { exact: true }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Bestiary');
    // As wide as the window: the lines of the page are wider without the bar.
    await page.getByTestId('guides-width').click();
    await page.getByTestId('guides-width-full').click();
    await expect(page.getByTestId('guides-width')).toHaveAttribute('data-width', 'full');
    await body(page).evaluate((root) => {
      // As in a browser that does not keep the place by itself when the lines change (WebKit).
      root.style.overflowAnchor = 'none';
      root.scrollTop = 2400;
    });
    const read = await paragraphAtTop(page);
    expect(read).not.toBeNull();
    const height = await body(page).evaluate((root) => root.scrollHeight);

    await hide(page).click();
    await expect(screen(page)).toHaveAttribute('data-bar', 'folded');
    // The page is shorter, its lines wider; the paragraph read is still at the top.
    expect(await body(page).evaluate((root) => root.scrollHeight)).toBeLessThan(height);
    expect(await paragraphAtTop(page)).toBe(read);
    await show(page).click();
    await expect(screen(page)).toHaveAttribute('data-bar', 'open');
    expect(await paragraphAtTop(page)).toBe(read);
    // Back and Forward return to where it was read.
    await page.getByTestId('guides-home-button').click();
    await expect(page.getByTestId('guides-home')).toBeVisible();
    await page.getByTestId('guides-back').click();
    await expect(shownPage(page).locator('h1')).toHaveText('Bestiary');
    expect(await paragraphAtTop(page)).toBe(read);
  });

  test('folds and brings back the bar with the key B, and keeps the choice', async ({ page }) => {
    const errors = collectErrors(page);
    await servePageTree(page);
    await page.goto('./');
    await expect(screen(page)).toHaveAttribute('data-bar', 'open');
    // Not while typing.
    const search = bar(page).getByTestId('guides-search');
    await search.fill('ore');
    await search.press('b');
    await expect(search).toHaveValue('oreb');
    await expect(screen(page)).toHaveAttribute('data-bar', 'open');
    await search.fill('');
    await search.blur();

    // Read on: the key folds the bar, and the focus stays where it was.
    await page.keyboard.press('b');
    await expect(screen(page)).toHaveAttribute('data-bar', 'folded');
    await expect(bar(page)).toBeHidden();
    await expect(show(page)).not.toBeFocused();
    expect(await storedSetting(page, 'guidesBar')).toBe(false);

    // Kept: folded after a restart, for this game and any other.
    await reloadSaved(page);
    await expect(screen(page)).toHaveAttribute('data-bar', 'folded');
    await expect(bar(page)).toBeHidden();
    await expect(show(page)).toBeVisible();
    const folded = await widths(page);
    expect(folded.reader).toBe(folded.screen);

    // B again: back, and kept so.
    await page.keyboard.press('B');
    await expect(screen(page)).toHaveAttribute('data-bar', 'open');
    await expect(bar(page)).toBeVisible();
    await expect.poll(() => storedSetting(page, 'guidesBar')).toBe(true);
    await reloadSaved(page);
    await expect(screen(page)).toHaveAttribute('data-bar', 'open');
    await expect(bar(page)).toBeVisible();

    // Focus on the button: the key moves it to the other button, as a press does.
    await hide(page).focus();
    await page.keyboard.press('b');
    await expect(show(page)).toBeFocused();
    await page.keyboard.press('b');
    await expect(hide(page)).toBeFocused();
    // Not with a key held with it.
    await page.keyboard.press('Control+b');
    await expect(screen(page)).toHaveAttribute('data-bar', 'open');
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });

  test('changes nothing on a narrow window, where the contents is a screen of its own', async ({
    page,
  }) => {
    await servePageTree(page);
    await page.goto('./');
    await hide(page).click();
    await expect(screen(page)).toHaveAttribute('data-bar', 'folded');

    await page.setViewportSize({ width: 412, height: 860 });
    await expect(screen(page)).not.toHaveAttribute('data-bar');
    await expect(bar(page)).toHaveCount(0);
    await expect(hide(page)).toHaveCount(0);
    await expect(show(page)).toHaveCount(0);
    await expect(page.getByTestId('guides-head-tools')).toHaveCount(0);
    // The key does nothing here.
    await page.keyboard.press('b');
    await expect(screen(page)).not.toHaveAttribute('data-bar');
    // The Contents button opens the menu, as before.
    const contents = page.getByTestId('guides-contents-button');
    await expect(contents).toHaveAccessibleName('Contents');
    await contents.click();
    await expect(page.getByTestId('guides-contents').getByTestId('guides-section')).toHaveText([
      /Equipment/,
      /The world/,
      /Things/,
      /Basics/,
    ]);

    // Wide again: folded, as chosen.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(screen(page)).toHaveAttribute('data-bar', 'folded');
    await expect(show(page)).toBeVisible();
  });

  test('has no button to fold for a wiki with no menu', async ({ page }) => {
    await servePageTree(page, { menu: false });
    await page.goto('./');
    await expect(screen(page)).toHaveAttribute('data-menu', 'false');
    await expect(screen(page)).not.toHaveAttribute('data-bar');
    await expect(hide(page)).toHaveCount(0);
    await expect(show(page)).toHaveCount(0);
    await page.keyboard.press('b');
    await expect(show(page)).toHaveCount(0);
  });
});
