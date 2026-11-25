import type { Page } from '@playwright/test';
import { collectErrors, demoLocations, openMap, storedSetting } from './helpers';
import { expect, test } from './layout';

/**
 * The colour and icon of a type of the pack (`src/state/typeLooks.ts`,
 * `src/components/TypeLook.tsx`): the palette button beside a type in the
 * filters opens a dialog; the colour chosen draws the type's markers on the
 * map and its badge in the filters, it is kept on the device with the
 * person's own data of the game (never in the pack), and "Back to the
 * pack's own" brings the pack's back. In both layouts.
 */

const WAYSTONE = 'demo:cat:waystone';
const SETTING = 'ownLocations:demo';
/** A colour no type of the demo pack has, easy to find on the map. */
const MAGENTA = '#ff00ff';

/** How many pixels of the markers drawn now are magenta. */
function magentaPixels(page: Page): Promise<number> {
  return page.locator('.atlas-marker-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! > 225 && data[i + 1]! < 40 && data[i + 2]! > 225 && data[i + 3]! > 200) count++;
    }
    return count;
  });
}

/** The map near a waystone, where its markers stand alone. */
async function nearWaystone(page: Page): Promise<string> {
  const waystone = (await demoLocations(page.request)).find(
    (l) => l.categoryId === WAYSTONE && l.layerId === 'demo:layer:surface',
  )!;
  return `./#@${Math.round(waystone.x)},${Math.round(waystone.y)},4`;
}

const badgeFill = (page: Page, scope: string) =>
  page.locator(`${scope} .glyph-badge circle`).first().getAttribute('fill');

async function storedLooks(page: Page): Promise<unknown> {
  const text = (await storedSetting(page, SETTING)) as string | undefined;
  return text ? (JSON.parse(text) as { typeLooks?: unknown }).typeLooks : undefined;
}

test.describe('in the standard layout', () => {
  test.use({ layout: 'standard' });

  test('a type of the pack gets another colour and icon, kept, and the pack’s own again', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openMap(page, await nearWaystone(page));
    const panel = page.getByTestId('filters-panel');
    await expect(panel).toBeVisible();
    const row = `[data-testid="filters-panel"] [data-testid="kind-switch"][data-category="${WAYSTONE}"]`;
    const before = await badgeFill(page, row);
    expect(before).toBe('#4fc3f7');
    await expect.poll(() => magentaPixels(page)).toBe(0);

    await panel.locator(`[data-testid="type-look"][data-category="${WAYSTONE}"]`).click();
    const dialog = page.getByTestId('type-look-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('type-look-original')).toContainText(
      'The pack’s own colour and icon',
    );
    // Not changed yet: nothing to go back to.
    await expect(dialog.getByTestId('type-look-reset')).toHaveCount(0);
    await dialog.getByTestId('type-any-colour').fill(MAGENTA);
    await dialog.getByRole('radio', { name: 'Eye' }).check({ force: true });
    await expect(dialog.locator('[data-testid="type-look-preview"] circle')).toHaveAttribute(
      'fill',
      MAGENTA,
    );
    await dialog.getByTestId('type-look-save').click();
    await expect(dialog).toHaveCount(0);

    // The badge in the filters and the markers on the map have the colour chosen.
    await expect.poll(() => badgeFill(page, row)).toBe(MAGENTA);
    await expect.poll(() => magentaPixels(page)).toBeGreaterThan(50);
    // Kept with the person's own data of the game, only what differs from the pack.
    await expect
      .poll(() => storedLooks(page))
      .toEqual([{ id: WAYSTONE, color: MAGENTA, icon: 'eye' }]);

    // A fresh start shows it still.
    await page.reload();
    await expect(page.locator('.atlas-marker-canvas')).toHaveAttribute('data-draw-ms', /\d/);
    await expect.poll(() => badgeFill(page, row)).toBe(MAGENTA);
    await expect.poll(() => magentaPixels(page)).toBeGreaterThan(50);

    // Back to the pack's own.
    await panel.locator(`[data-testid="type-look"][data-category="${WAYSTONE}"]`).click();
    await expect(dialog.getByTestId('type-any-colour')).toHaveValue(MAGENTA);
    await dialog.getByTestId('type-look-reset').click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => badgeFill(page, row)).toBe(before);
    await expect.poll(() => magentaPixels(page)).toBe(0);
    await expect.poll(() => storedLooks(page)).toBeUndefined();
    expect(errors).toEqual([]);
  });
});

test('in the classic layout, the palette beside a type changes its badge, and back', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openMap(page, await nearWaystone(page));
  const row = `[data-testid="category-${WAYSTONE}"]`;
  await expect(page.locator(row)).toBeVisible();
  const before = await badgeFill(page, row);
  await page
    .getByTestId('category-tree')
    .locator(`[data-testid="type-look"][data-category="${WAYSTONE}"]`)
    .click();
  const dialog = page.getByTestId('type-look-dialog');
  await dialog.getByRole('radio', { name: 'Colour 2 of 12' }).check({ force: true });
  await dialog.getByTestId('type-look-save').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => badgeFill(page, row)).toBe('#d64545');
  await page
    .getByTestId('category-tree')
    .locator(`[data-testid="type-look"][data-category="${WAYSTONE}"]`)
    .click();
  await dialog.getByTestId('type-look-reset').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => badgeFill(page, row)).toBe(before);
  expect(errors).toEqual([]);
});
