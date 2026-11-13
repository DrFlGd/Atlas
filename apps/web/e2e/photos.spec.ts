import { mkdir, readFile } from 'node:fs/promises';
import { devices, expect, test, type Locator, type Page } from '@playwright/test';
import {
  collectErrors,
  demoLocations,
  mapStatus,
  openMap,
  reloadSaved,
  selectByName,
} from './helpers';
import { choosePlace, mapSettled } from './touch';

/**
 * Photos of locations and of list entries, on the demo game: a photo on a
 * location card in both layouts, opened large; a spoiler photo blurred
 * until asked for; the Photo guide "Views of the isle" as cards grouped by
 * area; and one's own photos added to a step of a list and to a location
 * of one's own, found again after a reload and carried by a list file.
 */

const STANDARD = './?ui=standard';
/** Where the screenshots go: ATLAS_PHOTO_SHOTS, or beside the other test results. */
const SHOTS = process.env.ATLAS_PHOTO_SHOTS ?? 'test-results/photos';

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

/** Waits until a photo has loaded and shows something. */
async function expectLoaded(photo: Locator): Promise<void> {
  const img = photo.locator('img');
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
}

/** A small screenshot of the page, as a picked PNG file. */
async function screenshotFile(page: Page, name: string) {
  const buffer = await page.screenshot({ clip: { x: 0, y: 0, width: 320, height: 200 } });
  return { name, mimeType: 'image/png', buffer };
}

/** A point of the map shown well away from every marker, in screen pixels. */
async function emptyPoint(page: Page): Promise<{ x: number; y: number }> {
  await mapSettled(page);
  const places = await demoLocations(page.request);
  const box = (await page.getByTestId('map').boundingBox())!;
  const view = await mapStatus(page);
  const scale = 2 ** (5 - view.zoom);
  const points = places
    .filter((p) => p.layerId === view.layer)
    .map((p) => ({
      x: box.x + box.width / 2 + (p.x - view.x) / scale,
      y: box.y + box.height / 2 + (p.y - view.y) / scale,
    }));
  for (let gy = 0.3; gy <= 0.8; gy += 0.05) {
    for (let gx = 0.2; gx <= 0.6; gx += 0.04) {
      const x = box.x + box.width * gx;
      const y = box.y + box.height * gy;
      if (points.every((p) => Math.hypot(p.x - x, p.y - y) > 30)) return { x, y };
    }
  }
  throw new Error('No empty point on the map');
}

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

test.describe('on a computer', () => {
  test.use({ deviceScaleFactor: 2 });

  test('a photo on the location card, opened large; a spoiler stays blurred until asked', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openMap(page, STANDARD);
    await choosePlace(page, 'Thornwood waystone 1');
    const sheet = page.getByTestId('place-sheet');
    const photo = sheet.getByTestId('photo-strip').getByTestId('photo');
    await expect(photo).toHaveCount(1);
    await expectLoaded(photo);
    await expect(photo.locator('img')).toHaveAttribute('alt', 'The waystone from the road');
    // The photo comes first on the card, before the rest of the details.
    const order = await sheet.evaluate((element) => {
      const photos = element.querySelector('[data-testid="photo-strip"]');
      const wiki = element.querySelector('[data-testid="from-the-wiki"]');
      return {
        hasWiki: wiki !== null,
        before:
          photos !== null &&
          (wiki === null ||
            (photos.compareDocumentPosition(wiki) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0),
      };
    });
    expect(order.before).toBe(true);
    await page.screenshot({ path: `${SHOTS}/1-location-card.png` });

    // A click opens it large; Escape closes it.
    await photo.getByRole('button', { name: 'Open The waystone from the road' }).click();
    const viewer = page.getByTestId('photo-viewer');
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('figcaption')).toContainText('The waystone from the road');
    await page.screenshot({ path: `${SHOTS}/2-opened.png` });
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();

    // A spoiler: blurred, and only shown when asked; then a click opens it.
    await choosePlace(page, 'Saltmarsh Wilds waystone 2');
    const spoiler = page.getByTestId('place-sheet').getByTestId('photo');
    await expect(spoiler).toHaveAttribute('data-spoiler', 'hidden');
    await expect(spoiler).toContainText('Spoiler · show photo');
    await expect(spoiler.locator('img')).toHaveAttribute('alt', '');
    const filter = () =>
      spoiler.locator('img').evaluate((element) => getComputedStyle(element).filter);
    expect(await filter()).toContain('blur');
    await page.screenshot({ path: `${SHOTS}/3-spoiler-blurred.png` });
    await spoiler.getByRole('button', { name: 'Spoiler photo: show it' }).click();
    await expect(spoiler).toHaveAttribute('data-spoiler', 'shown');
    await expect(viewer).toBeHidden();
    await expect.poll(filter).not.toContain('blur');
    await spoiler.getByRole('button', { name: 'Open The waystone after the climb' }).click();
    await expect(viewer).toBeVisible();
    await viewer.getByRole('button', { name: 'Close photo' }).click();
    await expect(viewer).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('in the classic layout, the details show the photo', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page, './?ui=classic');
    await selectByName(page, 'Saltmarsh Wilds waystone 3');
    const photo = page.getByTestId('photo-strip').getByTestId('photo');
    await expectLoaded(photo);
    await expect(photo.locator('img')).toHaveAttribute('alt', 'The waystone at night');
    expect(errors).toEqual([]);
  });

  test('the Photo guide shows each entry as a card, grouped by area', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page, STANDARD);
    await page.getByTestId('section-lists').click();
    await page.getByTestId('list-link').filter({ hasText: 'Views of the isle' }).click();
    const screen = page.getByTestId('checklist-screen');
    await expect(screen).toHaveAttribute('data-view', 'cards');
    const cards = screen.getByTestId('photo-card');
    await expect(cards).toHaveCount(6);
    // The two parts of the isle, each with its heading.
    const groups = screen.getByTestId('photo-cards-group');
    await expect(groups).toHaveCount(2);
    expect((await groups.allTextContents()).sort()).toEqual(['Eastreach', 'Westreach']);
    const card = cards.filter({ hasText: 'The broken tower at dusk' });
    await expect(card.locator('.photo-card-where')).toHaveText('Saltmarsh Wilds');
    await expect(card.getByTestId('photo-card-note')).not.toBeEmpty();
    await expectLoaded(card.getByTestId('photo'));
    // The wreck is a spoiler: blurred on its card.
    const wreck = cards.filter({ hasText: 'The wreck below the cliffs' });
    await expect(wreck.getByTestId('photo')).toHaveAttribute('data-spoiler', 'hidden');
    await page.screenshot({ path: `${SHOTS}/4-photo-guide.png` });

    // Ticked from its card.
    await card.getByTestId('entry-tick').click();
    await expect(card).toHaveAttribute('data-done', 'true');
    // Its name shows the location on the map.
    await card.getByTestId('entry-show').click();
    await expect(page.getByTestId('selected-name')).toHaveText('Sunken shrine 1');
    expect(errors).toEqual([]);
  });

  test('an own photo on a step: added, a spoiler, kept after a reload, and in a list file', async ({
    page,
  }, testInfo) => {
    const errors = collectErrors(page);
    await openMap(page, STANDARD);
    await page.getByTestId('section-lists').click();
    await page.getByTestId('new-own-list').click();
    await page.getByTestId('own-list-name').fill('My lookouts');
    await page.getByTestId('template-photos').click();
    await page.getByTestId('template-start').click();
    await expect(page.getByTestId('list-editor')).toBeVisible();
    if ((await page.getByTestId('add-panel').count()) === 0) {
      await page.getByTestId('editor-add').click();
    }
    await page.getByTestId('add-tab-search').click();
    await page.getByTestId('add-search-input').fill('Duskmoor waystone 4');
    await page.getByRole('button', { name: 'Add Duskmoor waystone 4', exact: true }).click();
    const row = page.getByTestId('editor-rows').getByTestId('editor-row').first();
    await row.locator('.editor-row-main').click();

    // "Add a photo" beside the note's other buttons; the browser asks for a file.
    const add = page.getByTestId('add-photo');
    await expect(add).toHaveText('Add a photo');
    const choosing = page.waitForEvent('filechooser');
    await add.click();
    const chooser = await choosing;
    expect(chooser.isMultiple()).toBe(false);
    await chooser.setFiles(await screenshotFile(page, 'lookout.png'));
    const photos = page.getByTestId('editor-photos').getByTestId('editor-photo');
    await expect(photos).toHaveCount(1);
    await expectLoaded(photos.first().getByTestId('photo'));
    await photos.first().getByTestId('photo-spoiler').check();
    await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
    await page.screenshot({ path: `${SHOTS}/5-add-a-photo.png` });

    // After a reload the photo is there, under its entry, blurred as a spoiler.
    await reloadSaved(page);
    await page.getByTestId('section-lists').click();
    await page.getByTestId('list-link').filter({ hasText: 'My lookouts' }).first().click();
    const screen = page.getByTestId('checklist-screen');
    const card = screen.getByTestId('photo-card').first();
    await expect(card).toContainText('Duskmoor waystone 4');
    const shown = card.getByTestId('photo');
    await expect(shown).toHaveAttribute('data-spoiler', 'hidden');
    await shown.getByRole('button', { name: 'Spoiler photo: show it' }).click();
    await expectLoaded(shown);

    // A list file carries the photo, and importing it brings it back.
    await page.getByTestId('edit-own-list').click();
    await page.getByTestId('list-menu').click();
    const downloading = page.waitForEvent('download');
    await page.getByTestId('menu-export').click();
    const file = testInfo.outputPath('lookouts.atlaslist');
    await (await downloading).saveAs(file);
    const json = JSON.parse(await readFile(file, 'utf8')) as {
      list: { pictures: { id: string; file: string }[]; items: { photos: unknown[] }[] };
      pictureFiles: { file: string; data: string }[];
    };
    expect(json.list.pictures).toHaveLength(1);
    expect(json.list.pictures[0]!.id).toMatch(/^demo:picture:own\./);
    expect(json.list.pictures[0]!.file).toMatch(/^pictures\/own\.[a-z0-9]+\.(webp|jpg|png)$/);
    expect(json.list.items[0]!.photos).toEqual([
      { picture: json.list.pictures[0]!.id, spoiler: true },
    ]);
    expect(json.pictureFiles).toHaveLength(1);
    expect(json.pictureFiles[0]!.file).toBe(json.list.pictures[0]!.file);
    expect(json.pictureFiles[0]!.data.length).toBeGreaterThan(100);

    await page.getByTestId('editor-done').click();
    await page.getByTestId('lists-back').click();
    const choosingList = page.waitForEvent('filechooser');
    await page.getByTestId('import-own-list').click();
    await (await choosingList).setFiles(file);
    await expect(page.getByTestId('toast')).toContainText('with its photo');
    const links = page.getByTestId('own-lists').getByTestId('list-link');
    await expect(links.filter({ hasText: 'My lookouts' })).toHaveCount(2);
    await links.filter({ hasText: 'My lookouts' }).nth(1).click();
    const copy = page.getByTestId('checklist-screen').getByTestId('photo-card').first();
    await copy.getByRole('button', { name: 'Spoiler photo: show it' }).click();
    await expectLoaded(copy.getByTestId('photo'));
    expect(errors).toEqual([]);
  });

  test('an own photo on a location of one’s own, kept after a reload', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page, STANDARD);
    await page.getByTestId('edit-locations').click();
    const point = await emptyPoint(page);
    await page.mouse.click(point.x, point.y);
    const name = page.getByTestId('location-name');
    await expect(name).toBeFocused();
    await name.fill('Quiet cove');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('locations-save-state')).toHaveAttribute('data-state', 'saved');

    const choosing = page.waitForEvent('filechooser');
    await page.getByTestId('location-panel').getByTestId('add-photo').click();
    await (await choosing).setFiles(await screenshotFile(page, 'cove.png'));
    const photos = page.getByTestId('location-panel').getByTestId('editor-photo');
    await expect(photos).toHaveCount(1);
    await expectLoaded(photos.first().getByTestId('photo'));
    await expect(page.getByTestId('locations-save-state')).toHaveAttribute('data-state', 'saved');
    await page.getByTestId('locations-done').click();

    await reloadSaved(page);
    await choosePlace(page, 'Quiet cove');
    const photo = page.getByTestId('place-sheet').getByTestId('photo');
    await expectLoaded(photo);
    await expect(photo.locator('img')).toHaveAttribute('alt', 'Photo of Quiet cove');
    expect(errors).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use(pixel);

  test('the Photo guide cards and a location card with a photo', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page, './?ui=touch');
    await page.getByTestId('section-lists').click();
    await page.getByTestId('list-link').filter({ hasText: 'Views of the isle' }).click();
    const screen = page.getByTestId('checklist-screen');
    await expect(screen).toHaveAttribute('data-view', 'cards');
    await expectLoaded(screen.getByTestId('photo-card').first().getByTestId('photo'));
    // One card a row, as wide as the screen allows, with no sideways scroll.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/6-photo-guide-phone.png` });
    expect(errors).toEqual([]);
  });
});
