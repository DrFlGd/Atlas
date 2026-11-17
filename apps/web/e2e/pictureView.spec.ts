import { devices, type Locator, type Page } from '@playwright/test';
import { collectErrors, openGuidesSection } from './helpers';
import { expect, test } from './layout';
import { back } from './touch';

/**
 * The larger view of a picture in the text of a page
 * (components/PictureViewer.tsx): the demo pack's made-up wiki, its
 * Regions page served with pictures of every sort. The demo's waystone
 * picture is 640 by 400 pixels.
 */

test.use({ layout: 'standard' });

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

const shownPage = (page: Page) => page.getByTestId('guides-page');
const viewer = (page: Page) => page.getByTestId('photo-viewer');
const viewed = (page: Page) => page.getByTestId('photo-viewer-picture');

/** The tooltips of a picture that opens large, and of one that moves (pictureLarge.ts). */
const LARGE_TIP = 'Press to see this picture larger.';
const MOVING_TIP = 'This picture moves. Press to see it larger and play it from its start.';

/** The box with a corner mark around a picture of the page. */
const markOf = (picture: Locator) => picture.locator('xpath=ancestor::span[@class="picture-box"]');

/** How the corner mark of the picture box at or around `element` is drawn. */
function mark(element: Locator) {
  return element.evaluate((node) => {
    const box = node.closest('.picture-box') ?? node.querySelector('.picture-box') ?? node;
    const style = getComputedStyle(box, '::after');
    return {
      display: style.content === 'none' ? 'none' : style.display,
      width: style.width,
      height: style.height,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      right: style.right,
      bottom: style.bottom,
    };
  });
}

/** Black or white: the colour in the middle of an element as shown, read from a screenshot of it. */
async function colourOf(page: Page, element: Locator): Promise<string> {
  const shot = (await element.screenshot({ animations: 'allow' })).toString('base64');
  const reader = await page.context().newPage();
  try {
    const red = await reader.evaluate(async (png) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(img, 0, 0);
      return context.getImageData(img.width >> 1, img.height >> 1, 1, 1).data[0]!;
    }, shot);
    return red < 64 ? 'black' : red > 192 ? 'white' : `grey ${red}`;
  } finally {
    await reader.close();
  }
}

/** A page with a picture shown smaller than its file, an icon in a line, a linked icon and a hidden picture. */
const PICTURES = [
  'The old stone: ![a waystone](demo:picture:wiki-waystone "=320").',
  '',
  'A badge ![a small waystone](demo:picture:wiki-waystone "=24x15") in a line, and one that leads to [![Wolves](demo:picture:wiki-waystone "=24x15")](demo:guide:wiki-wolves).',
  '',
  'Under the lake: ||![the sunken waystone](demo:picture:wiki-waystone "=200")||',
].join('\n');

/** Serves the demo pack with the Regions page's text as `body`, and the pictures list changed by `pictures`. */
async function serveRegions(
  page: Page,
  body: string,
  pictures?: (list: Record<string, unknown>[]) => Record<string, unknown>[],
): Promise<void> {
  await page.route('**/packs/demo/guides.json', async (route) => {
    const response = await route.fetch();
    const all = (await response.json()) as { id: string; body: string }[];
    await route.fulfill({
      response,
      json: all.map((guide) =>
        guide.id === 'demo:guide:wiki-regions' ? { ...guide, body } : guide,
      ),
    });
  });
  if (pictures) {
    await page.route('**/packs/demo/pictures.json', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: pictures((await response.json()) as Record<string, unknown>[]),
      });
    });
  }
}

async function openRegions(page: Page): Promise<void> {
  await page.goto('./');
  await page.getByTestId('section-guides').click();
  await expect(page.getByTestId('guides-screen')).toBeVisible();
  await openGuidesSection(page, 'The isle');
  await page.getByTestId('guides-page-link').filter({ hasText: 'Regions' }).first().click();
  await expect(shownPage(page).locator('h1')).toHaveText('Regions');
}

test.describe('on a desktop', () => {
  test('opens a picture larger than shown, closes it every way, and leaves a linked one a link', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await serveRegions(page, PICTURES);
    await openRegions(page);
    const pictures = shownPage(page).locator('.guide-picture img');
    await expect(pictures).toHaveCount(4);
    const large = pictures.nth(0);
    const icon = pictures.nth(1);
    const linked = pictures.nth(2);
    await expect(large).toHaveAttribute('data-opens-large', '');
    await expect(large).toHaveAttribute('role', 'button');
    await expect(icon).toHaveAttribute('data-opens-large', '');
    // A picture that is a link is a link, as before.
    await expect(linked).not.toHaveAttribute('data-opens-large');

    // Pressed: over everything, fitted to the window, with its caption and size.
    await large.click();
    await expect(viewer(page)).toBeVisible();
    await expect(viewer(page)).toHaveAttribute('aria-label', /A woken waystone/);
    await expect(viewed(page)).toHaveAttribute('src', /pictures\/wiki-waystone\.png$/);
    await expect(viewer(page).locator('figcaption')).toContainText('A woken waystone');
    await expect(page.getByTestId('photo-viewer-size')).toContainText('640 × 400 pixels');
    await expect(viewer(page).getByRole('button', { name: 'Close picture' })).toBeFocused();
    // 640 by 400 fits a window of 1280 by 800: enlarged, with nothing more at real size.
    const box = await viewed(page).boundingBox();
    expect(box!.height).toBeGreaterThan(400);
    expect(box!.height).toBeLessThanOrEqual(800 - 120);
    expect(Math.round((box!.width / box!.height) * 100)).toBe(160);
    await expect(page.getByTestId('photo-viewer-zoom')).toHaveCount(0);
    // Escape closes it, and the focus is back on the picture.
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toBeHidden();
    await expect(large).toBeFocused();

    // From the keyboard; closed with its button.
    await page.keyboard.press('Enter');
    await expect(viewer(page)).toBeVisible();
    await viewer(page).getByRole('button', { name: 'Close picture' }).click();
    await expect(viewer(page)).toBeHidden();
    await expect(large).toBeFocused();

    // The icon in the line of text, named by its tooltip; a press beside it closes it.
    await icon.click();
    await expect(viewer(page)).toHaveAttribute('aria-label', 'A woken waystone');
    await page.mouse.click(4, 400);
    await expect(viewer(page)).toBeHidden();

    // Android's Back closes it, before going back a page.
    await icon.click();
    await expect(viewer(page)).toBeVisible();
    expect(await back(page)).toBe(true);
    await expect(viewer(page)).toBeHidden();
    await expect(shownPage(page).locator('h1')).toHaveText('Regions');

    // A hidden picture: the first press shows it, a later press opens it.
    await expect(pictures.nth(3)).toBeHidden();
    await shownPage(page).getByRole('button', { name: 'Show hidden text' }).click();
    await expect(pictures.nth(3)).toBeVisible();
    await expect(viewer(page)).toBeHidden();
    await expect(pictures.nth(3)).toHaveAttribute('data-opens-large', '');
    await pictures.nth(3).click();
    await expect(viewer(page)).toBeVisible();
    await page.keyboard.press('Escape');

    // The linked icon follows its link and opens nothing.
    await linked.click();
    await expect(shownPage(page).locator('h1')).toHaveText('Wolves');
    await expect(viewer(page)).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('marks a picture that opens large in its corner, and a press on the mark opens it', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await serveRegions(
      page,
      `${PICTURES}\n\nFar off: ![a far waystone](demo:picture:wiki-waystone "=80").`,
    );
    await openRegions(page);
    const pictures = shownPage(page).locator('.guide-picture img');
    await expect(pictures).toHaveCount(5);
    const large = pictures.nth(0);
    const icon = pictures.nth(1);
    const linked = pictures.nth(2);
    const far = pictures.nth(4);
    await expect(large).toHaveAttribute('data-opens-large', '');
    await expect(markOf(large)).toHaveAttribute('data-mark', 'large');
    await expect(large).toHaveAttribute('title', LARGE_TIP);
    // A screen reader hears what it shows, that it is a button, and what a press does.
    await expect(large).toHaveAccessibleName('a waystone');
    await expect(large).toHaveAccessibleDescription(LARGE_TIP);
    // The box is the picture's own size: nothing moves.
    const shown = await large.boundingBox();
    expect(shown).toMatchObject({ width: 320, height: 200 });
    expect(await markOf(large).boundingBox()).toEqual(shown);
    expect(await mark(large)).toEqual({
      display: 'block',
      width: '24px',
      height: '24px',
      opacity: '0.85',
      pointerEvents: 'none',
      right: '6px',
      bottom: '6px',
    });
    // Stronger on hover and on keyboard focus.
    await large.hover();
    await expect.poll(async () => (await mark(large)).opacity).toBe('1');
    await page.mouse.move(4, 400);
    await expect.poll(async () => (await mark(large)).opacity).toBe('0.85');
    await large.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(large).toBeFocused();
    await expect.poll(async () => (await mark(large)).opacity).toBe('1');
    // A press on the mark is a press on the picture.
    await page.mouse.click(shown!.x + shown!.width - 18, shown!.y + shown!.height - 18);
    await expect(viewer(page)).toBeVisible();
    await expect(viewed(page)).toHaveAttribute('src', /pictures\/wiki-waystone\.png$/);
    // Its tooltip is not taken for what it shows.
    await expect(viewer(page)).toHaveAttribute('aria-label', /^A woken waystone/);
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toBeHidden();

    // An icon in a line of text, and a picture under 96 pixels wide, open large with no mark.
    await expect(icon).toHaveAttribute('data-opens-large', '');
    await expect(markOf(icon)).toHaveCount(0);
    await expect(icon).toHaveAttribute('title', 'A woken waystone');
    await expect(far).toHaveAttribute('data-opens-large', '');
    await expect(markOf(far)).toHaveCount(0);
    await expect(far).toHaveAttribute('title', LARGE_TIP);
    await far.click();
    await expect(viewer(page)).toBeVisible();
    await page.keyboard.press('Escape');
    // A picture that is a link has none.
    await expect(markOf(linked)).toHaveCount(0);
    await expect(linked).not.toHaveAttribute('title', LARGE_TIP);

    // A hidden picture has its mark once shown.
    await shownPage(page).getByRole('button', { name: 'Show hidden text' }).click();
    await expect(markOf(pictures.nth(3))).toHaveAttribute('data-mark', 'large');
    expect(errors).toEqual([]);
  });

  test('shows a picture’s copy for pages on the page and its file in the larger view', async ({
    page,
  }) => {
    await serveRegions(
      page,
      'The old stone: ![a waystone](demo:picture:wiki-waystone "=320").',
      (list) =>
        list.map((picture) =>
          picture.id === 'demo:picture:wiki-waystone'
            ? { ...picture, pageCopy: { file: 'pictures/wiki-waystone.page.png', width: 640 } }
            : picture,
        ),
    );
    // The copy is the same drawing here; what matters is which file is asked for where.
    await page.route('**/packs/demo/pictures/wiki-waystone.page.png', async (route) =>
      route.fulfill({
        response: await route.fetch({
          url: route.request().url().replace('wiki-waystone.page.png', 'wiki-waystone.png'),
        }),
      }),
    );
    await openRegions(page);
    const picture = shownPage(page).locator('.guide-picture img');
    await expect(picture).toHaveAttribute('src', /pictures\/wiki-waystone\.page\.png$/);
    await expect(picture).toHaveAttribute('data-opens-large', '');
    await picture.click();
    await expect(viewed(page)).toHaveAttribute('src', /pictures\/wiki-waystone\.png$/);
    await page.keyboard.press('Escape');
  });

  test('shows the file on the page when its copy for pages is not there', async ({ page }) => {
    await serveRegions(
      page,
      'The old stone: ![a waystone](demo:picture:wiki-waystone "=320").',
      (list) =>
        list.map((picture) =>
          picture.id === 'demo:picture:wiki-waystone'
            ? { ...picture, pageCopy: { file: 'pictures/wiki-waystone.page.png', width: 640 } }
            : picture,
        ),
    );
    await page.route('**/packs/demo/pictures/wiki-waystone.page.png', (route) =>
      route.fulfill({ status: 404, body: 'not found' }),
    );
    await openRegions(page);
    const picture = shownPage(page).locator('.guide-picture img');
    await expect(picture).toHaveAttribute('src', /pictures\/wiki-waystone\.png$/);
    await expect(shownPage(page).locator('.guide-picture[data-missing]')).toHaveCount(0);
    await expect(picture).toHaveAttribute('data-opens-large', '');
  });
});

/**
 * A GIF of `frames` pictures of 1 × 1 pixel, black then white, each shown
 * `delay` hundredths of a second: one that moves when more than one. It
 * has no looping extension, so it plays once and stops on its last.
 */
function gif(frames: number, delay = 50): Buffer {
  const picture = (colour: number) => [
    ...[0x21, 0xf9, 4, 0, delay, 0, 0, 0],
    ...[0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, colour, 1, 0],
  ];
  return Buffer.from([
    ...Array.from('GIF89a', (c) => c.charCodeAt(0)),
    ...[1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff],
    ...Array.from({ length: frames }, (_, i) => picture(i % 2 ? 0x4c : 0x44)).flat(),
    0x3b,
  ]);
}

test.describe('a picture that moves', () => {
  /** The Regions page with a GIF that moves, kept at full size, and one that does not. */
  async function serveMoving(page: Page) {
    await serveRegions(
      page,
      'A torch: ![a torch that flickers](demo:picture:torch "=96").\n\nA lamp: ![a lamp](demo:picture:lamp "=96").',
      (list) => [
        ...list,
        {
          id: 'demo:picture:torch',
          file: 'pictures/torch.gif',
          shareable: true,
          pageCopy: { file: 'pictures/torch.page.gif', width: 96 },
        },
        { id: 'demo:picture:lamp', file: 'pictures/lamp.gif', shareable: true },
      ],
    );
    const fulfil = (body: Buffer) => ({ headers: { 'content-type': 'image/gif' }, body });
    await page.route('**/packs/demo/pictures/torch.gif', (route) => route.fulfill(fulfil(gif(3))));
    await page.route('**/packs/demo/pictures/lamp.gif', (route) => route.fulfill(fulfil(gif(1))));
    // A GIF that moves has no copy for pages: the page shows its file at its size.
    await page.route('**/packs/demo/pictures/torch.page.gif', (route) =>
      route.fulfill({ status: 404, body: 'not found' }),
    );
  }

  test('moves on the page at the size the page gives it', async ({ page }) => {
    const errors = collectErrors(page);
    await serveMoving(page);
    await openRegions(page);
    // A picture that moves opens large whatever its size: a button.
    const torch = shownPage(page).getByRole('button', { name: 'a torch that flickers' });
    await expect(torch).toHaveAttribute('src', /pictures\/torch\.gif$/);
    await expect(torch).toHaveAttribute('width', '96');
    await expect
      .poll(() => torch.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    await expect(torch).toBeVisible();
    // Without the system's setting, nothing holds it still.
    await expect(shownPage(page).getByRole('button', { name: /^Play/ })).toHaveCount(0);
    // Its corner mark says it plays, and its tooltip what a press does.
    await expect(torch).toHaveAttribute('data-moves', 'stops');
    await expect(markOf(torch)).toHaveAttribute('data-mark', 'moving');
    await expect(torch).toHaveAttribute('title', MOVING_TIP);
    await expect(torch).toHaveAccessibleDescription(MOVING_TIP);
    expect(await mark(torch)).toMatchObject({ display: 'block', width: '40px' });
    // The lamp does not move, and its file is no larger than shown: as before.
    const lamp = shownPage(page).getByRole('img', { name: 'a lamp' });
    await expect(lamp).not.toHaveAttribute('data-opens-large');
    await expect(lamp).not.toHaveAttribute('title');
    await expect(markOf(lamp)).toHaveCount(0);
    // Pressed, it plays in the larger view from its own bytes, read once.
    await torch.click();
    await expect(viewed(page)).toHaveAttribute('src', /^blob:/);
    await expect(page.getByTestId('photo-viewer-size')).toContainText('1 × 1 pixels');
    await page.keyboard.press('Escape');
    expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
  });

  test('is shown still with a Play button when the system asks for less motion', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await serveMoving(page);
    await openRegions(page);
    const play = shownPage(page).getByRole('button', {
      name: 'Play the moving picture: a torch that flickers',
    });
    await expect(play).toBeVisible();
    await expect(play).toHaveText('Play');
    const frame = shownPage(page).locator('.moving-picture');
    await expect(frame).toHaveAttribute('data-still', '');
    await expect(frame.locator('canvas')).toHaveCount(1);
    await expect(frame.locator('img')).toBeHidden();
    // While it is still, the Play button is what it offers: no corner mark.
    const box = shownPage(page).locator('.picture-box');
    await expect(box).toHaveAttribute('data-mark', 'moving');
    await expect(box.locator('.moving-picture')).toHaveCount(1);
    expect((await mark(frame)).display).toBe('none');
    // The lamp does not move: no button on it.
    await expect(shownPage(page).getByRole('button', { name: /^Play/ })).toHaveCount(1);
    await expect(shownPage(page).getByRole('img', { name: 'a lamp' })).toBeVisible();
    // By keyboard: it plays, and the button goes.
    await play.focus();
    await page.keyboard.press('Enter');
    await expect(play).toHaveCount(0);
    await expect(frame).not.toHaveAttribute('data-still');
    await expect(frame.locator('canvas')).toHaveCount(0);
    const torch = shownPage(page).getByRole('button', {
      name: 'a torch that flickers',
      exact: true,
    });
    await expect(torch).toBeVisible();
    // Played, it has its corner mark, and a press opens it large.
    expect((await mark(frame)).display).toBe('block');
    await torch.click();
    await expect(viewed(page)).toHaveAttribute('src', /^blob:/);
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toBeHidden();
    expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
  });

  test('plays again from its start in the larger view once it has stopped on the page', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await serveRegions(
      page,
      'A beacon: ![a beacon that flashes once](demo:picture:beacon "=160").',
      (list) => [
        ...list,
        { id: 'demo:picture:beacon', file: 'pictures/beacon.gif', shareable: true },
      ],
    );
    let asked = 0;
    await page.route('**/packs/demo/pictures/beacon.gif', (route) => {
      asked += 1;
      return route.fulfill({ headers: { 'content-type': 'image/gif' }, body: gif(2, 150) });
    });
    await openRegions(page);
    const beacon = shownPage(page).getByRole('button', { name: 'a beacon that flashes once' });
    await expect(beacon).toHaveAttribute('data-moves', 'stops');
    // Black for a second and a half, then white, where it stops.
    await expect.poll(() => colourOf(page, beacon), { timeout: 8000 }).toBe('white');
    await beacon.click();
    await expect(viewed(page)).toHaveAttribute('src', /^blob:/);
    const first = await viewed(page).getAttribute('src');
    await expect.poll(() => colourOf(page, viewed(page))).toBe('black');
    await expect.poll(() => colourOf(page, viewed(page)), { timeout: 8000 }).toBe('white');
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toBeHidden();
    // Its address is let go when the view closes.
    await expect
      .poll(() =>
        page.evaluate(
          (address) =>
            fetch(address!).then(
              () => 'read',
              () => 'gone',
            ),
          first,
        ),
      )
      .toBe('gone');
    // Opened again: from its start again, from a new address.
    await beacon.press('Enter');
    await expect(viewed(page)).toHaveAttribute('src', /^blob:/);
    expect(await viewed(page).getAttribute('src')).not.toBe(first);
    await expect.poll(() => colourOf(page, viewed(page))).toBe('black');
    await page.keyboard.press('Escape');
    // Its file was read twice in all: shown on the page, and read once for its motion.
    expect(asked).toBe(2);
    // The one error is the test's own read of the address let go.
    expect(errors.filter((e) => !e.includes('ERR_FILE_NOT_FOUND'))).toEqual([]);
  });

  test('with less motion, is read once, held still, and plays in the larger view when opened', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await serveRegions(
      page,
      'A beacon: ![a beacon that flashes once](demo:picture:beacon "=160").',
      (list) => [
        ...list,
        { id: 'demo:picture:beacon', file: 'pictures/beacon.gif', shareable: true },
      ],
    );
    let asked = 0;
    await page.route('**/packs/demo/pictures/beacon.gif', (route) => {
      asked += 1;
      return route.fulfill({ headers: { 'content-type': 'image/gif' }, body: gif(2, 150) });
    });
    await openRegions(page);
    const play = shownPage(page).getByRole('button', {
      name: 'Play the moving picture: a beacon that flashes once',
    });
    await expect(play).toBeVisible();
    const still = shownPage(page).locator('.moving-picture-still');
    expect((await mark(still)).display).toBe('none');
    // Still on its first picture.
    await page.waitForTimeout(1800);
    expect(await colourOf(page, still)).toBe('black');
    // Shown on the page, then read once, for its motion and its first picture alike.
    expect(asked).toBe(2);
    await play.click();
    const beacon = shownPage(page).getByRole('button', {
      name: 'a beacon that flashes once',
      exact: true,
    });
    expect((await mark(beacon)).display).toBe('block');
    // The larger view plays it, as it did before the corner marks.
    await beacon.click();
    await expect(viewed(page)).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => colourOf(page, viewed(page))).toBe('black');
    await expect.poll(() => colourOf(page, viewed(page)), { timeout: 8000 }).toBe('white');
    await page.keyboard.press('Escape');
    // Play shows the page's picture again from its file; the larger view reads nothing.
    expect(asked).toBe(3);
    expect(errors).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ ...pixel });

  test('fits a picture wider than the screen, and shows it at real size to be moved around', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await serveRegions(page, PICTURES);
    await openRegions(page);
    // Its corner mark shows on a touch screen too, with no hover.
    await expect(markOf(shownPage(page).locator('.guide-picture img').first())).toHaveAttribute(
      'data-mark',
      'large',
    );
    expect((await mark(shownPage(page).locator('.picture-box').first())).display).toBe('block');
    await shownPage(page).locator('.guide-picture img').first().tap();
    await expect(viewer(page)).toBeVisible();
    const fitted = await viewed(page).boundingBox();
    expect(fitted!.width).toBeLessThanOrEqual(412 - 24);
    // At real size: one pixel of the file to one pixel of the page.
    const zoom = page.getByTestId('photo-viewer-zoom');
    await expect(zoom).toHaveAttribute('aria-pressed', 'false');
    await viewed(page).tap();
    await expect(zoom).toHaveAttribute('aria-pressed', 'true');
    await expect(viewer(page).locator('figure')).toHaveAttribute('data-zoom', 'real');
    const real = await viewed(page).evaluate((img: HTMLImageElement) => img.clientWidth);
    expect(real).toBe(640);
    const stage = page.getByTestId('photo-viewer-stage');
    const before = await stage.evaluate((el) => el.scrollLeft);
    expect(await stage.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // Dragged sideways, it moves; the end of a drag is no press.
    const at = await stage.boundingBox();
    const y = at!.y + at!.height / 2;
    await page.mouse.move(at!.x + 300, y);
    await page.mouse.down();
    await page.mouse.move(at!.x + 250, y, { steps: 4 });
    await page.mouse.move(at!.x + 200, y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => stage.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);
    await expect(zoom).toHaveAttribute('aria-pressed', 'true');
    // The arrow keys move it too.
    const dragged = await stage.evaluate((el) => el.scrollLeft);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => stage.evaluate((el) => el.scrollLeft)).toBeLessThan(dragged);
    // Back to fitted with the button; the page does not scroll sideways.
    await zoom.tap();
    await expect(zoom).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      412,
    );
    expect(await back(page)).toBe(true);
    await expect(viewer(page)).toBeHidden();
    expect(errors).toEqual([]);
  });
});
