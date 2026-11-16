import { devices, type Locator, type Page } from '@playwright/test';
import { collectErrors, openGuidesSection, storedSetting } from './helpers';
import { expect, test } from './layout';

/**
 * Layout forms of a page (blocks side by side, cards, a row, columns and a
 * centred block), on the demo wiki's "Isle portal": as the page shows them
 * wide and on a phone, in both themes, and in the page editor. With
 * ATLAS_FORMS_SHOTS set to a folder, the tests also keep screenshots there.
 */

test.use({ layout: 'standard' });

const PORTAL = 'demo:guide:wiki-portal';
const SHOTS = process.env.ATLAS_FORMS_SHOTS;
const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

const shownPage = (page: Page) => page.getByTestId('guides-page');

async function inTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.route('**/config.json', async (route) => {
    const config = (await (await route.fetch()).json()) as Record<string, unknown>;
    return route.fulfill({ json: { ...config, theme } });
  });
}

async function openPortal(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await inTheme(page, theme);
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.getByTestId('section-guides').click();
  await expect(page.getByTestId('guides-screen')).toBeVisible();
  await openGuidesSection(page, 'Basics');
  await page
    .getByTestId('guides-body')
    .getByTestId('guides-page-link')
    .filter({ hasText: 'Isle portal' })
    .first()
    .click();
  await expect(shownPage(page).locator('h1')).toHaveText('Isle portal');
  // Its pictures are shown.
  await expect
    .poll(() =>
      shownPage(page)
        .locator('.guide-tiles img')
        .evaluateAll((imgs) => imgs.every((img) => (img as HTMLImageElement).naturalWidth > 0)),
    )
    .toBe(true);
}

async function packBody(page: Page, id: string): Promise<string> {
  const response = await page.request.get('./packs/demo/guides.json');
  const guides = (await response.json()) as { id: string; body: string }[];
  return guides.find((guide) => guide.id === id)!.body;
}

async function shot(target: Page | Locator, name: string): Promise<void> {
  if (!SHOTS) return;
  await target.screenshot({
    path: `${SHOTS.replace(/\/$/, '')}/${name}.png`,
    animations: 'disabled',
  });
}

const box = async (locator: Locator) => (await locator.boundingBox())!;

test.describe('on a desktop', () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 1500 } });

  for (const theme of ['dark', 'light'] as const) {
    test(`shows every form of the portal in the ${theme} theme`, async ({ page }) => {
      const errors = collectErrors(page);
      await openPortal(page, theme);
      const body = shownPage(page);
      // No marker line shows.
      await expect(body).not.toContainText(':::');

      // A narrow menu beside a wide text, about a quarter of the width.
      const outer = body.locator('.guide-side').first();
      const [menu, text] = [
        outer.locator(':scope > .guide-side-block').nth(0),
        outer.locator(':scope > .guide-side-block').nth(1),
      ];
      const [menuBox, textBox] = [await box(menu), await box(text)];
      expect(Math.abs(menuBox.y - textBox.y)).toBeLessThan(2);
      expect(textBox.x).toBeGreaterThan(menuBox.x + menuBox.width);
      expect(textBox.width / menuBox.width).toBeGreaterThan(2.5);
      expect(textBox.width / menuBox.width).toBeLessThan(3.5);

      // Cards with a title bar that is a heading of the page.
      const cards = body.locator('.guide-card');
      await expect(cards).toHaveCount(3);
      await expect(cards.first().locator('h3.guide-card-title')).toHaveText('Find your way');
      const toc = page.getByTestId('on-this-page-entry');
      await expect(toc).toHaveText([
        'Find your way',
        'Latest finds',
        'Tip of the day',
        'Foes and gear',
        'Locations to visit',
      ]);
      // The two cards side by side.
      const [news, tip] = [await box(cards.nth(1)), await box(cards.nth(2))];
      expect(Math.abs(news.y - tip.y)).toBeLessThan(2);
      expect(tip.x).toBeGreaterThan(news.x + news.width);
      // The card's frame and title bar stand out from the page, in this theme.
      const colours = await cards.first().evaluate((card) => {
        const title = card.querySelector('.guide-card-title')!;
        return {
          border: getComputedStyle(card).borderTopColor,
          card: getComputedStyle(card).backgroundColor,
          title: getComputedStyle(title).backgroundColor,
        };
      });
      expect(colours.title).not.toBe(colours.card);
      expect(colours.border).not.toBe('rgba(0, 0, 0, 0)');

      // Tiles, a row of small pictures on one line, three columns, centred lines.
      await expect(body.locator('.guide-tiles > li')).toHaveCount(2);
      const row = body.locator('.guide-row ul');
      await expect(row).toHaveClass('guide-row-pictures');
      const items = row.locator('li');
      await expect(items).toHaveCount(4);
      const tops = await items.evaluateAll((lis) =>
        lis.map((li) => li.getBoundingClientRect().top),
      );
      // Items on one line, wrapping to another where the line is full.
      expect(Math.round(tops[1]!)).toBe(Math.round(tops[0]!));
      expect(new Set(tops.map(Math.round)).size).toBeLessThanOrEqual(2);
      const columns = body.locator('.guide-columns');
      expect(await columns.evaluate((el) => getComputedStyle(el).columnCount)).toBe('3');
      // Three columns side by side, in fact.
      const lefts = await columns
        .locator('li')
        .evaluateAll((lis) => lis.map((li) => Math.round(li.getBoundingClientRect().left)));
      expect(new Set(lefts).size).toBe(3);
      await expect(body.locator('.guide-centred').first()).toHaveCSS('text-align', 'center');

      // Hidden text in a card waits to be asked for; links to a section work.
      await expect(cards.nth(2).locator('.hidden-text')).toBeHidden();
      await cards.nth(2).getByRole('button', { name: 'Show hidden text' }).click();
      await expect(cards.nth(2).locator('.hidden-text')).toBeVisible();
      await shot(body, `portal-desktop-${theme}`);

      await cards.nth(1).getByRole('button', { name: 'how to cross' }).click();
      await expect(shownPage(page).locator('h1')).toHaveText('Getting around');
      await expect(shownPage(page).locator('[data-section="by-boat"]')).toBeFocused();
      expect(errors).toEqual([]);
    });
  }
});

test.describe('on a phone', () => {
  test.use({ ...pixel });

  test('folds every form to one column in reading order', async ({ page }) => {
    const errors = collectErrors(page);
    await openPortal(page, 'dark');
    const body = shownPage(page);
    const outer = body.locator('.guide-side').first();
    const [menu, text] = [
      await box(outer.locator(':scope > .guide-side-block').nth(0)),
      await box(outer.locator(':scope > .guide-side-block').nth(1)),
    ];
    expect(text.y).toBeGreaterThan(menu.y + menu.height - 1);
    expect(Math.abs(text.x - menu.x)).toBeLessThan(2);
    const cards = body.locator('.guide-card');
    const [news, tip] = [await box(cards.nth(1)), await box(cards.nth(2))];
    expect(tip.y).toBeGreaterThan(news.y + news.height - 1);
    expect(
      await body.locator('.guide-columns').evaluate((el) => getComputedStyle(el).columnCount),
    ).toBe('auto');
    // Nothing is wider than the page.
    const overflow = await body.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // The whole page, at the phone's width.
    await page.setViewportSize({ width: pixel.viewport.width, height: 1500 });
    await shot(page, 'portal-phone-dark');
    expect(errors).toEqual([]);
  });
});

test.describe('in the page editor', () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 1500 } });

  test('shows the forms as frames, makes, changes and takes them apart, with Undo', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openPortal(page, 'dark');
    const original = await packBody(page, PORTAL);
    await page.getByTestId('edit-page').click();
    await expect(page.getByTestId('page-blocks')).toBeVisible();

    const forms = page.getByTestId('page-form');
    await expect(forms).toHaveCount(9);
    await expect(page.getByRole('region', { name: 'Card' })).toHaveCount(3);
    // The card's title is edited where it stands, in its title bar.
    await expect(forms.nth(1).getByTestId('heading-field').first()).toHaveText('Find your way');

    // Markdown shows the marker lines, byte for byte, and back.
    await page.getByTestId('mode-markdown').click();
    const markdown = page.getByTestId('markdown-text');
    await expect(markdown).toHaveValue(original);
    await shot(page, 'editor-markdown');
    await page.getByTestId('mode-formatted').click();

    // The Layout menu.
    await page.getByTestId('paragraph-field').filter({ hasText: 'Welcome to the portal' }).click();
    await page.getByTestId('tool-layout').click();
    const menu = page.getByRole('menu', { name: 'Layout' });
    await expect(menu.getByRole('group', { name: 'Around the part being edited' })).toBeVisible();
    await expect(
      menu.getByRole('group', { name: 'New and empty' }).getByRole('menuitem'),
    ).toHaveText(['Side by side', 'Card', 'Row', 'Columns', 'Centred']);
    await shot(page, 'editor-layout-menu');
    await menu
      .getByRole('group', { name: 'Around the part being edited' })
      .getByRole('menuitem', { name: 'Card' })
      .click();
    await expect(forms).toHaveCount(10);

    // Widths of the menu and the text, by a preset.
    await page.getByRole('combobox', { name: 'Widths' }).first().selectOption('1:2');
    await page.getByTestId('mode-markdown').click();
    let text = await markdown.inputValue();
    expect(text).toContain('::: side 1:2\n');
    expect(text).toContain('::: centred\n\n::: card\n\n**Welcome to the portal');
    await page.getByTestId('mode-formatted').click();

    // Columns, a block added and taken away, a form taken apart.
    const columns = page.locator('[data-testid="page-form"][data-form="columns"]');
    await columns.getByRole('combobox', { name: 'Columns' }).selectOption('2');
    const inner = page.locator('[data-testid="page-form"][data-form="side"]').nth(1);
    await inner.getByRole('button', { name: 'Add a block' }).click();
    await page.keyboard.type('A third block.');
    const parts = inner.locator(':scope > .pe-form-parts > [data-testid="form-part"]');
    await expect(parts).toHaveCount(3);
    await inner.getByRole('button', { name: 'Remove block 3' }).click();
    await expect(parts).toHaveCount(2);
    await page
      .locator('[data-testid="page-form"][data-form="row"]')
      .getByRole('button', { name: /Take the row layout apart/ })
      .click();
    await page.getByTestId('mode-markdown').click();
    text = await markdown.inputValue();
    expect(text).toContain('::: columns 2\n');
    expect(text).not.toContain('::: row');
    expect(text).toContain('keep moving.||\n\n::: end\n\nA third block.\n\n::: end');

    // Undo, step by step, back to the pack's text.
    await page.getByTestId('mode-formatted').click();
    for (let i = 0; i < 8 && (await page.getByTestId('tool-undo').isEnabled()); i++) {
      await page.getByTestId('tool-undo').click();
    }
    await page.getByTestId('mode-markdown').click();
    await expect(markdown).toHaveValue(original);
    await page.getByTestId('mode-formatted').click();

    // Saved changed, the page shows the change.
    await page.getByTestId('form-shares').first().selectOption('1:1');
    await page.getByTestId('save-page').click();
    await expect(page.getByTestId('page-editor')).toHaveCount(0);
    await expect
      .poll(async () => {
        const text = await storedSetting(page, 'ownPages:demo');
        if (typeof text !== 'string') return null;
        return (JSON.parse(text) as { pages: { body?: string }[] }).pages[0]?.body ?? null;
      })
      .toBe(original.replace('::: side 1:3', '::: side'));
    const blocks = shownPage(page)
      .locator('.guide-side')
      .first()
      .locator(':scope > .guide-side-block');
    const [a, b] = [await box(blocks.nth(0)), await box(blocks.nth(1))];
    expect(Math.abs(a.width - b.width)).toBeLessThan(2);
    expect(errors).toEqual([]);
  });

  test('reaches the layout tools with the keyboard, each named', async ({ page }) => {
    await openPortal(page, 'light');
    await page.getByTestId('edit-page').click();
    const outer = page.getByTestId('page-form').first();
    const bar = page.getByRole('toolbar', { name: 'Side by side: layout tools' }).first();
    await expect(bar.getByRole('combobox', { name: 'Widths' })).toBeVisible();
    await expect(
      bar.getByRole('button', { name: 'Move the side by side layout up' }),
    ).toBeDisabled();
    await expect(
      bar.getByRole('button', { name: 'Take the side by side layout apart, keeping its text' }),
    ).toBeEnabled();
    await expect(outer.getByRole('group', { name: 'Block 1 of 2' }).first()).toBeVisible();
    await bar.getByRole('combobox', { name: 'Widths' }).focus();
    await page.keyboard.press('Tab');
    await expect(bar.getByRole('button', { name: 'Add a block' })).toBeFocused();
  });
});
