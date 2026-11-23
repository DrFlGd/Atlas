import type { Page } from '@playwright/test';
import { collectErrors, openMap } from './helpers';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, realErrors, setUp } from './fakeShell';
import { reportMouse } from './touch';

/**
 * Renaming a single map or a level (`src/state/mapNames.ts`,
 * `src/components/RenameMap.tsx`, `src/library/MapNamesCard.tsx`): in the
 * maps menu and in the game's details in the Library, kept with the
 * person's own data of the game, and "Use the original name". The demo
 * game has two maps, the second with two levels.
 */

test.use({ layout: 'standard' });

const WORLD = 'demo:map:world';
const DEEP = 'demo:map:deep';

async function openMenu(page: Page) {
  await page.getByTestId('map-chip').click();
  await expect(page.getByTestId('maps-menu')).toBeVisible();
  return page.getByTestId('maps-menu');
}

async function rename(page: Page, name: string) {
  const dialog = page.getByTestId('rename-map-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('rename-map-input').fill(name);
  await page.getByTestId('rename-map-save').click();
  await expect(dialog).toHaveCount(0);
}

test('renames a map and a level in the maps menu, keeps the names, and goes back to the original', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openMap(page);
  let menu = await openMenu(page);
  await menu.locator(`[data-testid="rename-map"][data-id="${WORLD}"]`).click();
  await expect(page.getByTestId('rename-map-input')).toHaveValue('The Sundered Isle');
  await expect(page.getByTestId('rename-map-original')).toContainText(
    'The original name is The Sundered Isle.',
  );
  // Not renamed yet: nothing to go back to.
  await expect(page.getByTestId('rename-map-original-button')).toHaveCount(0);
  await rename(page, 'Home island');
  await expect(menu.getByText('Home island')).toBeVisible();
  await expect(page.getByTestId('map-chip')).toContainText('Home island');

  // A level of the other map.
  await menu.getByText('The Hollow Deep').click();
  menu = await openMenu(page);
  await menu.getByTestId('rename-level').first().click();
  await expect(page.getByTestId('rename-map-dialog').getByRole('heading')).toHaveText(
    'Rename the level',
  );
  await rename(page, 'Top tunnels');
  await expect(menu.getByText('Top tunnels')).toBeVisible();
  await page.keyboard.press('Escape');

  // The names are everywhere the maps are named: Progress lists the maps.
  await page.getByTestId('section-progress').click();
  await expect(page.getByTestId('progress-screen')).toContainText('Home island');

  // Kept with the game: a fresh start shows them.
  await page.reload();
  menu = await openMenu(page);
  await expect(menu.getByText('Home island')).toBeVisible();
  await expect(menu.getByText('Top tunnels')).toBeVisible();

  // Use the original name.
  await menu.locator(`[data-testid="rename-map"][data-id="${WORLD}"]`).click();
  await expect(page.getByTestId('rename-map-original')).toContainText(
    'The original name is The Sundered Isle.',
  );
  await page.getByTestId('rename-map-original-button').click();
  await expect(page.getByTestId('rename-map-dialog')).toHaveCount(0);
  await expect(menu.getByText('The Sundered Isle')).toBeVisible();
  await expect(menu.getByText('Home island')).toHaveCount(0);
  expect(realErrors(errors)).toEqual([]);
});

test('renames maps and levels in the game details of the Library', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page, DOWNLOADS_BUILD);
  await page.getByTestId('section-library').click();
  await page.locator('[data-testid="library-game"][data-pack="demo"]').click();
  const card = page.getByTestId('library-maps-card');
  await expect(card.getByRole('heading')).toHaveText('Maps and levels');
  await expect(card.getByTestId('map-names-map')).toHaveText([
    /The Sundered Isle/,
    /The Hollow Deep/,
    /Mossgate Keep/,
  ]);
  await expect(card.getByTestId('map-names-level')).toHaveText([
    /Upper galleries/,
    /Lower galleries/,
    /Caves/,
    /Ground floor/,
    /Upper floor/,
  ]);
  await card.locator(`[data-testid="rename-map"][data-id="${DEEP}"]`).click();
  await rename(page, 'The pit');
  const deep = card.locator(`[data-testid="map-names-map"][data-id="${DEEP}"]`);
  await expect(deep).toContainText('The pit');
  await expect(deep).toContainText('Original name: The Hollow Deep');

  // The map switcher of the game shown says it too.
  await page.getByTestId('section-map').click();
  const menu = await openMenu(page);
  await expect(menu.getByText('The pit')).toBeVisible();
  expect(realErrors(errors)).toEqual([]);
});

test.describe('for fingers on a handheld', () => {
  test.use({
    layout: null,
    viewport: { width: 1280, height: 800 },
    screen: { width: 1280, height: 800 },
    hasTouch: true,
    isMobile: false,
  });
  test.skip(DOWNLOADS_BUILD, 'The Steam Deck build is the app without downloads.');

  test('renames with a finger, each target 44 pixels', async ({ page }) => {
    const errors = collectErrors(page);
    await reportMouse(page);
    await setUp(page, false, { exit: true });
    await expect(page.locator('.touch')).toHaveAttribute('data-handheld', '');
    await page.getByTestId('map-chip').tap();
    const button = page
      .getByTestId('maps-menu')
      .locator(`[data-testid="rename-map"][data-id="${WORLD}"]`);
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await button.tap();
    const dialog = page.getByTestId('rename-map-dialog');
    // At the top, above the on-screen keyboard.
    expect((await dialog.boundingBox())!.y).toBeLessThan(40);
    await page.getByTestId('rename-map-input').fill('Shore');
    await page.getByTestId('rename-map-save').tap();
    await expect(page.getByTestId('map-chip')).toContainText('Shore');
    expect(realErrors(errors)).toEqual([]);
  });
});
