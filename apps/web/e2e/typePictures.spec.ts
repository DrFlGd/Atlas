import { expect, test, type Page } from '@playwright/test';
import { setUp } from './fakeShell';
import { collectErrors, demoLocations, openLibraryGame, waitForTiles } from './helpers';

/**
 * The icons of the map a game was read from: a type of the demo pack given
 * a picture of its own here (a made-up drawing, never a site's icon), drawn
 * on the map and in the filters while the game uses the map's icons, and
 * with Atlas's own icon once the person turns that off in the Library.
 */

const TYPE = 'demo:cat:waystone';
const PICTURE = 'demo:picture:t-made-up';
/** A made-up icon: a violet disc with a white diamond, 32 pixels. */
const MADE_UP_ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAmklEQVR42t2X2w2AMAhFGcIhnMFRnMWVnUG/TIxpC6XApd6k3+fEPrwQdWZd9qu1yCNvwLGdzWUqI4VyMhD4kIQFuCQCg4slPOGshNWeq89EBLz6FSLhRQmtwBOIwDdqAQv4kESvABdXAWlcBHrzPwH4FqQ4hC7XEP4QTfsUT/1HrPYBaCGBV7IUpTRFLU8xmKQYzVIMpxHj+Q0n9Wb5Zm+ouwAAAABJRU5ErkJggg==',
  'base64',
);

/** Serves the demo pack with one type drawn with the made-up icon, kept for one's own use. */
async function withTypePicture(page: Page): Promise<void> {
  await page.route('**/packs/demo/categories.json', async (route) => {
    const types = (await (await route.fetch()).json()) as { id: string }[];
    await route.fulfill({
      json: types.map((type) => (type.id === TYPE ? { ...type, picture: PICTURE } : type)),
    });
  });
  await page.route('**/packs/demo/pictures.json', async (route) => {
    const answer = await route.fetch();
    const pictures = answer.ok() ? ((await answer.json()) as unknown[]) : [];
    await route.fulfill({
      json: [...pictures, { id: PICTURE, file: 'pictures/t-made-up.png', shareable: false }],
    });
  });
  await page.route('**/packs/demo/pictures/t-made-up.png', (route) =>
    route.fulfill({ body: MADE_UP_ICON, contentType: 'image/png' }),
  );
}

/** Opens the map at a place given in the address (a new page load, not a change of its hash). */
async function showNear(page: Page, near: string): Promise<void> {
  await page.goto(near);
  await page.reload();
  await expect(page.locator('.atlas-marker-canvas')).toHaveAttribute('data-draw-ms', /\d/);
  // An app that downloads opens on the Library: the map is a press away.
  if (await page.getByTestId('library').isVisible()) await page.getByTestId('section-map').click();
  await expect(page.getByTestId('library')).toBeHidden();
  await waitForTiles(page);
}

const drawnPictures = (page: Page) =>
  page.locator('.atlas-marker-canvas').getAttribute('data-drawn-pictures');

test('a type drawn with the map’s own icon, and with Atlas’s again when turned off', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await withTypePicture(page);
  // Close to a waystone, where markers stand alone.
  const waystone = (await demoLocations(page.request)).find(
    (l) => l.categoryId === TYPE && l.layerId === 'demo:layer:surface',
  )!;
  const near = `./#@${Math.round(waystone.x)},${Math.round(waystone.y)},5`;
  // The desktop app, whose Library offers the choice.
  await setUp(page);
  await showNear(page, near);
  // In the filters, the type's badge is the picture.
  const pictures = page.locator('.glyph-badge-picture');
  await expect(pictures).toHaveCount(1);
  await expect.poll(async () => Number(await drawnPictures(page))).toBeGreaterThan(0);

  await openLibraryGame(page, 'demo');
  const card = page.getByTestId('library-icons-card');
  await expect(card).toContainText('1 type of this game is drawn with the icon of the map');
  const use = card.getByTestId('library-icons-use');
  await expect(use).toBeChecked();
  // Not a game of a site's map: nothing to download here.
  await expect(card.getByTestId('library-icons-get')).toHaveCount(0);
  await use.uncheck();
  await expect(card).toContainText('Every type of this game is drawn with Atlas’s own icons.');

  await showNear(page, near);
  await expect(page.getByText('Waystone', { exact: true }).first()).toBeVisible();
  await expect(pictures).toHaveCount(0);
  await expect.poll(() => drawnPictures(page)).toBe('0');
  expect(errors).toEqual([]);
});
