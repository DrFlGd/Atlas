import { devices, expect, test, type Page } from '@playwright/test';
import { useAndroidShell } from './androidShell';
import { DOWNLOADS_BUILD, setUp } from './fakeShell';
import { collectErrors, openMap } from './helpers';
import { GAZETTE, LISTED, magazineFiles, MONTHLY } from './magazineFiles';
import { back } from './touch';

/**
 * Magazines: the issues of a magazine title, in a pack of their own that
 * another app writes (pack format 10). The fake shell lists two packs of
 * magazines whose issues cover the demo world, by its title and by its id;
 * the pack protocol serves their files in parts. Atlas lists them on the
 * shelf of magazines, with the games they cover in Guides and the Library,
 * and finds the pages about a game in its search. The files are made by
 * the test (`magazineFiles.ts`).
 */

let served: Record<string, Record<string, Buffer | string>> = {};

test.beforeAll(async ({ browser }) => {
  served = await magazineFiles(browser);
});

async function start(page: Page) {
  await setUp(page, DOWNLOADS_BUILD, { listed: LISTED, served });
}

const reader = (page: Page) => page.getByTestId('guidebook-reader');
const shelf = (page: Page) => page.getByTestId('magazine-shelf');

async function openShelfFromLibrary(page: Page) {
  await page.getByTestId('section-library').click();
  await page.getByTestId('library').locator('.library-side').getByTestId('open-magazines').click();
  await expect(shelf(page)).toBeVisible();
}

test.describe('magazines', () => {
  test('the shelf lists the titles, then an issue’s covers by date, and opens one in the reader', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await start(page);
    await openShelfFromLibrary(page);
    // Every title, by title, each with what it holds.
    const titles = shelf(page).getByTestId('magazine-title');
    await expect(titles).toHaveText([
      /Fen Gazette.*1 issue, December 2025/,
      /Marsh Monthly.*Reed Press · 3 issues, March 2026 to May 2026/,
    ]);
    // A pack of magazines is no game.
    await expect(page.locator(`[data-testid="library-game"][data-pack="${MONTHLY}"]`)).toHaveCount(
      0,
    );

    await titles.filter({ hasText: 'Marsh Monthly' }).click();
    await expect(shelf(page)).toHaveAttribute('data-view', 'issues');
    await expect(shelf(page).getByTestId('magazine-shelf-title')).toHaveText('Marsh Monthly');
    // Newest first, with covers where the pack has them.
    const issues = shelf(page).getByTestId('magazine-issue');
    await expect(issues).toHaveText([
      /Issue 42.*May 2026 · 4 pages/,
      /Issue 41.*April 2026 · 6 pages/,
      /Issue 40.*March 2026 · 3 pages/,
    ]);
    await expect(shelf(page).getByTestId('magazine-cover')).toHaveCount(2);
    await expect
      .poll(() =>
        shelf(page)
          .getByTestId('magazine-cover')
          .first()
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(480);

    // An issue opens in the reader, its contents the games it covers.
    await issues.filter({ hasText: 'Issue 41' }).click();
    await expect(reader(page)).toBeVisible();
    await expect(reader(page)).toHaveAttribute('data-kind', 'issue');
    await expect(reader(page).getByTestId('guidebook-title')).toHaveText('Marsh Monthly, Issue 41');
    await expect(reader(page)).toHaveAttribute('data-page', '1');
    await reader(page).getByTestId('guidebook-contents-button').click();
    const games = reader(page).getByTestId('issue-game');
    await expect(games).toHaveText([
      /Atlas Demo World\s*pages 3–4/,
      /Hollow Marsh \(Desk\)\s*page 5/,
    ]);
    // The PDF's own contents follow.
    await expect(reader(page).getByTestId('guidebook-contents-item')).toHaveCount(3);
    await games.filter({ hasText: 'Hollow Marsh' }).click();
    await expect(reader(page)).toHaveAttribute('data-page', '5');
    // Find in the issue, from the pack's text.
    await reader(page).getByTestId('guidebook-find-button').click();
    await reader(page).getByTestId('guidebook-find').fill('waystone');
    await expect(reader(page).getByTestId('guidebook-find-state')).toHaveText(
      '2 pages have “waystone”.',
    );

    // Closed, the shelf is still there; opened again, the issue is where it was left.
    await reader(page).getByTestId('guidebook-close').click();
    await expect(reader(page)).toBeHidden();
    await expect(shelf(page)).toBeVisible();
    await issues.filter({ hasText: 'Issue 41' }).click();
    await expect(reader(page)).toHaveAttribute('data-page', '5');
    await page.keyboard.press('Escape');
    await expect(reader(page)).toBeHidden();

    // A CBZ issue shows its pictures.
    await issues.filter({ hasText: 'Issue 42' }).click();
    await expect(reader(page)).toHaveAttribute('data-type', 'cbz');
    await expect(reader(page).locator('img.gb-picture').first()).toBeVisible();
    await page.keyboard.press('Escape');

    // Esc goes back to every title, then closes the shelf.
    await page.keyboard.press('Escape');
    await expect(shelf(page)).toHaveAttribute('data-view', 'titles');
    await page.keyboard.press('Escape');
    await expect(shelf(page)).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('a game’s guides list the issues about it, which open at its first page', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await start(page);
    await page.getByTestId('section-guides').click();
    const list = page.getByTestId('in-magazines');
    // By the game's id, by its title in any case, and by its title with no system named.
    await expect(list.getByTestId('magazine-coverage-row')).toHaveText([
      /Marsh Monthly, Issue 42\s*May 2026 · pages 2–3/,
      /Marsh Monthly, Issue 41\s*April 2026 · pages 3–4/,
      /Fen Gazette, Issue 7\s*December 2025 · page 2/,
    ]);
    await list.getByTestId('magazine-coverage-open').filter({ hasText: 'Issue 41' }).click();
    await expect(reader(page)).toHaveAttribute('data-page', '3');
    await page.keyboard.press('Escape');
    await expect(reader(page)).toBeHidden();
    // All magazines, from there.
    await list.getByTestId('all-magazines').click();
    await expect(shelf(page)).toBeVisible();
    await page.keyboard.press('Escape');

    // In the Library, the game's pane has them too.
    await page.getByTestId('section-library').click();
    await page.locator('[data-testid="library-game"][data-pack="demo"]').click();
    await expect(
      page.getByTestId('library-magazines-card').getByTestId('magazine-coverage-row'),
    ).toHaveCount(3);
    expect(errors).toEqual([]);
  });

  test('search finds the pages about the game, in Guides and in the map’s search', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await start(page);
    await page.getByTestId('section-guides').click();
    await expect(page.getByTestId('in-magazines')).toBeVisible();

    // "waystone" is on page 3 of Issue 41, about the game, and page 6, which is not.
    await page.getByTestId('guides-search').fill('waystone');
    const results = page.getByTestId('magazine-results').getByTestId('magazine-result');
    await expect(results).toHaveText([
      /Marsh Monthly, Issue 41, page 3/,
      /Fen Gazette, Issue 7, page 2/,
    ]);
    await results.first().click();
    await expect(reader(page)).toHaveAttribute('data-page', '3');
    await expect(reader(page).getByTestId('guidebook-find')).toHaveValue('waystone');
    await page.keyboard.press('Escape');
    await expect(reader(page)).toBeHidden();

    // The text of a CBZ issue comes from its pack.
    await page.getByTestId('guides-search').fill('relic shard');
    await expect(results).toHaveText([/Marsh Monthly, Issue 42, page 2/]);

    await page.getByTestId('section-map').click();
    await page.getByTestId('search-input').fill('sealed doors');
    await expect(page.getByTestId('magazine-results').getByTestId('magazine-result')).toHaveText([
      /Marsh Monthly, Issue 42, page 2/,
    ]);
    expect(errors).toEqual([]);
  });

  test('a narrow window shows the shelf in one column', async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await start(page);
    await page.getByTestId('section-library').click();
    await page
      .getByTestId('library')
      .locator('.library-side')
      .getByTestId('open-magazines')
      .click();
    await shelf(page).getByTestId('magazine-title').filter({ hasText: 'Marsh Monthly' }).click();
    const issues = shelf(page).getByTestId('magazine-issue');
    await expect(issues).toHaveCount(3);
    // Two covers side by side, inside the window.
    const [first, second] = await Promise.all([
      issues.nth(0).boundingBox(),
      issues.nth(1).boundingBox(),
    ]);
    expect(first!.y).toBe(second!.y);
    expect(second!.x + second!.width).toBeLessThanOrEqual(390);
    await expect(shelf(page).getByTestId('magazine-shelf-back')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('magazines in the Android app', () => {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['Pixel 7'];
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent });

  test('Games opens the shelf, and Back goes back a step at a time', async ({ page }) => {
    const errors = collectErrors(page);
    await useAndroidShell(page);
    await page.addInitScript((more) => {
      (window as unknown as { __androidShell: { more: unknown[] } }).__androidShell.more = more;
    }, LISTED);
    await page.route('http://atlas-pack.localhost/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const [, id = '', ...rest] = path.split('/');
      const file = served[id]?.[rest.join('/')];
      await (file === undefined
        ? route.fulfill({ status: 404, body: 'not found' })
        : route.fulfill({
            headers: { 'access-control-allow-origin': '*' },
            body: typeof file === 'string' ? Buffer.from(file) : file,
          }));
    });
    await openMap(page);
    await page.getByTestId('section-games').click();
    await page.getByTestId('games-screen').getByTestId('open-magazines').click();
    await expect(shelf(page).getByTestId('magazine-title')).toHaveCount(2);
    await shelf(page).getByTestId('magazine-title').filter({ hasText: 'Fen Gazette' }).click();
    await shelf(page).getByTestId('magazine-issue').click();
    await expect(reader(page)).toBeVisible();
    // Back closes the reader, then goes to every title, then closes the shelf.
    expect(await back(page)).toBe(true);
    await expect(reader(page)).toBeHidden();
    expect(await back(page)).toBe(true);
    await expect(shelf(page)).toHaveAttribute('data-view', 'titles');
    expect(await back(page)).toBe(true);
    await expect(shelf(page)).toBeHidden();
    // Its packs are not games.
    await expect(page.locator(`[data-testid="game-row"][data-pack="${GAZETTE}"]`)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('magazines for fingers on a Steam Deck', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true });

  test('the shelf’s targets are large enough for fingers', async ({ page }) => {
    const errors = collectErrors(page);
    await start(page);
    await page.getByTestId('section-settings').click();
    await page.getByTestId('controls-touch').click();
    await expect(page.locator('.touch')).toHaveAttribute('data-input', 'touch');
    await page.getByTestId('section-library').click();
    await page
      .getByTestId('library')
      .locator('.library-side')
      .getByTestId('open-magazines')
      .click();
    await shelf(page).getByTestId('magazine-title').filter({ hasText: 'Marsh Monthly' }).click();
    for (const id of ['magazine-shelf-back', 'magazine-shelf-close']) {
      const box = await shelf(page).getByTestId(id).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    const card = await shelf(page).getByTestId('magazine-issue').first().boundingBox();
    expect(card!.height).toBeGreaterThanOrEqual(44);
    expect(errors).toEqual([]);
  });
});
