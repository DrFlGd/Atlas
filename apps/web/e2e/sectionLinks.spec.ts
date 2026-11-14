import { devices, type Locator, type Page } from '@playwright/test';
import { collectErrors, storedSetting } from './helpers';
import { expect, test } from './layout';

/**
 * Sections of guide pages, in the standard layout, on the demo pack's
 * made-up wiki: "On this page" on a page with headings enough, a link to a
 * section of the page shown, of another page, and of another name of a
 * page (the manifest's `idSections`), Back after each jump, a section no
 * heading fits, and a link to a section written in the page editor's
 * Markdown view, kept through the text tools.
 */

test.use({ layout: 'standard' });

const body = (page: Page) => page.getByTestId('guides-body');
const shownPage = (page: Page) => page.getByTestId('guides-page');
const onThisPage = (page: Page) => page.getByTestId('on-this-page');
const heading = (page: Page, name: string) =>
  shownPage(page).locator('.guides-page-body').getByRole('heading', { name, exact: true });

async function openGuides(page: Page): Promise<void> {
  await page.goto('./');
  await page.getByTestId('section-guides').click();
  await expect(page.getByTestId('guides-screen')).toBeVisible();
}

async function openPage(page: Page, sections: string | string[], name: string): Promise<void> {
  for (const section of Array.isArray(sections) ? sections : [sections]) {
    await body(page).getByTestId('guides-section').filter({ hasText: section }).first().click();
  }
  await body(page).getByTestId('guides-page-link').filter({ hasText: name }).first().click();
  await expect(shownPage(page).locator('h1')).toHaveText(name);
}

/** How far below the top of the scrolled page an element stands, in pixels. */
async function belowTop(page: Page, element: Locator): Promise<number> {
  const [box, frame] = await Promise.all([element.boundingBox(), body(page).boundingBox()]);
  return (box?.y ?? Infinity) - (frame?.y ?? 0);
}

/**
 * The page shown was scrolled to the heading: it stands at the top, or as
 * near it as the page goes (a heading near its end stays lower, with the
 * page scrolled to its end), and in view.
 */
async function expectAtTop(page: Page, name: string): Promise<void> {
  await expect(heading(page, name)).toBeInViewport();
  await expect
    .poll(async () => {
      const below = await belowTop(page, heading(page, name));
      const atEnd = await body(page).evaluate(
        (el) => el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
      );
      return (below >= 0 && below < 40) || atEnd;
    })
    .toBe(true);
}

const scrollTop = (page: Page) => body(page).evaluate((el) => el.scrollTop);

test.describe('on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 640 } });

  test('lists a page’s headings, sub-headings in, and each jumps to its section', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openGuides(page);
    await openPage(page, 'Basics', 'Getting around');
    const list = onThisPage(page);
    await expect(list).toBeVisible();
    const toggle = list.getByTestId('on-this-page-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toContainText('On this page');
    const entries = list.getByTestId('on-this-page-entry');
    await expect(entries).toHaveText(['On foot', 'At night', 'By boat', 'By waystone']);
    // A sub-heading stands in under its heading.
    const indent = (entry: Locator) =>
      entry.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft));
    expect(await indent(entries.nth(1))).toBeGreaterThan(await indent(entries.nth(0)));
    expect(await indent(entries.nth(2))).toBe(await indent(entries.nth(0)));

    // A jump to a section, and Back to where the page was read.
    await entries.filter({ hasText: 'By waystone' }).click();
    await expectAtTop(page, 'By waystone');
    await expect(heading(page, 'By waystone')).toBeFocused();
    await page.getByTestId('guides-back').click();
    await expect(shownPage(page).locator('h1')).toHaveText('Getting around');
    await expect.poll(() => scrollTop(page)).toBe(0);
    await page.getByTestId('guides-forward').click();
    await expectAtTop(page, 'By waystone');

    // Folded and unfolded with the keyboard, then followed with it.
    await page.getByTestId('guides-back').click();
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(entries).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    await expect(entries.first()).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expectAtTop(page, 'By boat');

    // The same section again, after reading on: it is scrolled to again.
    await body(page).evaluate((el) => {
      el.scrollTop = 0;
    });
    await entries.filter({ hasText: 'By boat' }).click();
    await expectAtTop(page, 'By boat');
    expect(errors).toEqual([]);
  });

  test('a page with few headings has no list', async ({ page }) => {
    await openGuides(page);
    await openPage(page, 'The isle', 'Waystones');
    await expect(heading(page, 'Waking a waystone')).toBeVisible();
    await expect(onThisPage(page)).toHaveCount(0);
  });

  test('follows links to sections of the page shown, of another page and of another name', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openGuides(page);
    await openPage(page, 'Basics', 'Getting around');

    // A section of the page shown: it moves there, and Back returns.
    const walk = shownPage(page).locator('.app-link', { hasText: 'walk' });
    await expect(walk).toHaveAttribute('data-atlas-section', 'on-foot');
    await expect(walk).not.toHaveAttribute('title', /#/);
    await walk.scrollIntoViewIfNeeded();
    const before = await scrollTop(page);
    expect(before).toBeGreaterThan(0);
    await walk.click();
    await expectAtTop(page, 'On foot');
    // Far from the page's end, the heading stands at the very top.
    await expect.poll(() => belowTop(page, heading(page, 'On foot'))).toBeLessThan(40);
    await expect.poll(() => belowTop(page, heading(page, 'On foot'))).toBeGreaterThanOrEqual(0);
    await page.getByTestId('guides-back').click();
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(before - 2);
    await expect.poll(() => scrollTop(page)).toBeLessThan(before + 2);

    // A section of another page: it opens there.
    await shownPage(page).locator('.app-link', { hasText: 'Wake each one you pass' }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Waystones');
    await expectAtTop(page, 'Waking a waystone');
    await page.getByTestId('guides-back').click();
    await expect(shownPage(page).locator('h1')).toHaveText('Getting around');

    // Another name of a page that leads to a section of it, as a wiki forwards a name.
    await openGuides(page);
    await openPage(page, 'The isle', 'Regions');
    await shownPage(page).locator('.app-link', { hasText: 'by boat' }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Getting around');
    await expectAtTop(page, 'By boat');
    expect(errors).toEqual([]);
  });

  test('writes a link to a section in Markdown, keeps it through the text tools, and follows it', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openGuides(page);
    await openPage(page, 'Basics', 'Welcome to the Sundered Isle');
    await page.getByTestId('edit-page').click();
    await expect(page.getByTestId('page-editor')).toBeVisible();
    await page.getByTestId('mode-markdown').click();
    const markdown = page.getByTestId('markdown-text');
    await markdown.press('ControlOrMeta+End');
    const added =
      'Cross [by boat](demo:guide:wiki-travel "#By_boat"), or go [nowhere](demo:guide:wiki-travel "#no-such-part").';
    await markdown.pressSequentially(`\n\n${added}`);
    // The text tools keep the section, and say it where the link is pointed at.
    await page.getByTestId('mode-formatted').click();
    const link = page.getByTestId('paragraph-field').last().locator('a', { hasText: 'by boat' });
    await expect(link).toHaveAttribute('title', 'demo:guide:wiki-travel, at the section by-boat');
    await page.getByTestId('paragraph-field').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Safe travels.');
    await page.getByTestId('mode-markdown').click();
    await expect(markdown).toHaveValue(
      /"#By_boat"\), or go \[nowhere\]\(demo:guide:wiki-travel "#no-such-part"\)\. Safe travels\.$/,
    );
    await page.getByTestId('save-page').click();
    await expect(page.getByTestId('page-editor')).toHaveCount(0);
    await expect.poll(async () => storedSetting(page, 'ownPages:demo')).toContain('\\"#By_boat\\"');

    // Followed: the section the link names, written as the person wrote it.
    await shownPage(page).locator('.app-link', { hasText: 'by boat' }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Getting around');
    await expectAtTop(page, 'By boat');
    // A section no heading fits: the page at its top, and no error.
    await page.getByTestId('guides-back').click();
    await shownPage(page).locator('.app-link', { hasText: 'nowhere' }).click();
    await expect(shownPage(page).locator('h1')).toHaveText('Getting around');
    await expect.poll(() => scrollTop(page)).toBe(0);
    expect(errors).toEqual([]);
  });
});

test.describe('on a phone', () => {
  const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];
  test.use({ ...pixel });

  test('the list starts folded, unfolds with a tap, and a tap jumps', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await page.getByTestId('section-guides').tap();
    await body(page).getByTestId('guides-section').filter({ hasText: 'Basics' }).first().tap();
    await body(page).getByTestId('guides-page-link').filter({ hasText: 'Getting around' }).tap();
    await expect(shownPage(page).locator('h1')).toHaveText('Getting around');
    const toggle = page.getByTestId('on-this-page-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.tap();
    const entries = page.getByTestId('on-this-page-entry');
    await expect(entries).toHaveCount(4);
    // Usable with a finger, and inside the screen.
    const box = await entries.first().boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(40);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(pixel.viewport.width);
    await entries.filter({ hasText: 'By waystone' }).tap();
    await expectAtTop(page, 'By waystone');
    // It stays open, as the person left it.
    await page.getByTestId('guides-back').tap();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(errors).toEqual([]);
  });
});
