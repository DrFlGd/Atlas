import { expect, test, type Page } from '@playwright/test';
import { DOWNLOADS_BUILD, mock, setUp } from './fakeShell';
import { makeCbz, makePdf } from './guidebookFiles';
import { collectErrors, openLibraryGame } from './helpers';

/**
 * Guidebooks: published guides a person has as one file, a PDF or a CBZ,
 * in a pack of guidebooks of their own (pack format 8). The fake shell
 * lists a pack of guidebooks of the demo game, which joins it by its
 * title, and one of a game not here, which is an entry of its own; the
 * pack protocol serves their files in parts, as the shell does. The PDF
 * and the CBZ are made by the test (`guidebookFiles.ts`).
 */

const PACK = 'guidebooks-demo';
const OWN = 'guidebooks-hollow-marsh';
const base = (id: string) => `http://atlas-pack.localhost/${id}/`;

const PDF = makePdf(
  [
    ['Marsh Field Guide', 'Herons of the fen'],
    ['Reed beds', 'The bittern hides here'],
    ['Herons again', 'A grey heron by the water'],
    ['Last page', 'Read more on the web'],
  ],
  [
    ['Birds of the fen', 1],
    ['Reed beds', 2],
    ['The end', 4],
  ],
  [
    { page: 1, to: 3 },
    { page: 4, to: 'https://fen.example/more' },
  ],
);
const CBZ = makeCbz(['pages/p10.png', 'pages/p2.png', 'pages/p1.png']);

const guidebookList = (title: string, guidebooks: Record<string, unknown>[]) =>
  JSON.stringify({ format: 'atlas-guidebooks', version: 1, game: { title }, guidebooks });

const manifest = (id: string, title: string) =>
  JSON.stringify({
    schemaVersion: 2,
    gameId: id,
    title,
    packVersion: '1.0.0',
    gamePatch: 'any',
    attribution: [],
    idMigrations: {},
    created: '2026-11-01T10:00:00Z',
    updated: '2026-11-01T10:00:00Z',
    writtenBy: { name: 'Atlas', version: '0.25.0' },
  });

const SERVED = {
  [PACK]: {
    'manifest.json': manifest(PACK, 'Atlas demo world'),
    'guidebooks.json': guidebookList('Atlas demo world', [
      {
        file: 'guidebooks/marsh-field-guide.pdf',
        title: 'Marsh Field Guide',
        pages: 4,
        bytes: PDF.length,
      },
      {
        file: 'guidebooks/fen-sketches.cbz',
        title: 'Fen Sketches',
        pages: 3,
        bytes: CBZ.length,
        text: 'guidebooks/fen-sketches.text.json',
      },
    ]),
    'guidebooks/marsh-field-guide.pdf': PDF,
    'guidebooks/fen-sketches.cbz': CBZ,
    'guidebooks/fen-sketches.text.json': JSON.stringify({
      format: 'atlas-guidebook-text',
      version: 1,
      pages: [{ page: 2, text: 'A sketch of a spoonbill in the shallows' }],
    }),
  },
  [OWN]: {
    'manifest.json': manifest(OWN, 'Hollow Marsh'),
    'guidebooks.json': guidebookList('Hollow Marsh', [
      {
        file: 'guidebooks/hollow-marsh.pdf',
        title: 'Hollow Marsh Atlas',
        pages: 4,
        bytes: PDF.length,
      },
    ]),
    'guidebooks/hollow-marsh.pdf': PDF,
  },
  '_picked/token-1': { 'guidebook.pdf': PDF },
};

const listed = (id: string, title: string, byAtlas: boolean) => ({
  id,
  title,
  url: base(id),
  guidebooks: true,
  ...(byAtlas ? { guidebooksByAtlas: true } : {}),
  packFile: true,
  origin: 'packs-folder',
  path: `/packs/${title} guidebooks.atlaspack`,
});

async function start(page: Page, packs = [listed(PACK, 'Atlas demo world', true)]) {
  await setUp(page, DOWNLOADS_BUILD, { listed: packs, served: SERVED });
}

const reader = (page: Page) => page.getByTestId('guidebook-reader');

async function openGuides(page: Page) {
  await page.getByTestId('section-guides').click();
  await expect(page.getByTestId('guides-screen')).toBeVisible();
}

async function openGuidebook(page: Page, title: string) {
  await page.getByTestId('guidebook-open').filter({ hasText: title }).click();
  await expect(reader(page)).toBeVisible();
  await expect(reader(page).getByTestId('guidebook-title')).toHaveText(title);
}

/** The pages drawn in the reader. */
const drawn = (page: Page) => reader(page).locator('canvas[data-drawn="true"]');

test.describe('guidebooks', () => {
  test('a guidebook opens from Guides, turns its pages, zooms and lists its contents', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await start(page);
    await openGuides(page);
    const list = page.getByTestId('guidebooks');
    await expect(list.getByTestId('guidebook-row')).toHaveCount(2);
    await expect(list.getByTestId('guidebook-facts').first()).toHaveText(
      /^PDF, 4 pages, \d+(\.\d)? KB$/,
    );

    await openGuidebook(page, 'Marsh Field Guide');
    await expect(reader(page).getByTestId('guidebook-pages')).toHaveText('of 4');
    await expect(drawn(page).first()).toBeVisible();
    await expect(reader(page)).toHaveAttribute('data-page', '1');

    // Zoom: the buttons, then fit to the page.
    const zoom = reader(page).getByTestId('guidebook-zoom');
    const before = await zoom.textContent();
    await reader(page).getByTestId('guidebook-zoom-in').click();
    await expect(zoom).not.toHaveText(before ?? '');
    await expect(reader(page).getByTestId('guidebook-fit-width')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await reader(page).getByTestId('guidebook-fit-page').click();
    await expect(reader(page).getByTestId('guidebook-fit-page')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Ctrl and the wheel zoom too.
    const fitted = await zoom.textContent();
    await reader(page).getByTestId('guidebook-view').hover();
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -300);
    await page.keyboard.up('Control');
    await expect(zoom).not.toHaveText(fitted ?? '');

    // Page by page.
    await reader(page).getByTestId('guidebook-page-by-page').click();
    await reader(page).getByTestId('guidebook-next').click();
    await expect(reader(page)).toHaveAttribute('data-page', '2');
    await expect(reader(page).getByTestId('guidebook-page-view')).toHaveCount(1);

    // The PDF's contents, and Back to the page before the jump.
    await reader(page).getByTestId('guidebook-contents-button').click();
    const contents = reader(page).getByTestId('guidebook-contents');
    await expect(contents.getByTestId('guidebook-contents-item')).toHaveText([
      /Birds of the fen\s*1/,
      /Reed beds\s*2/,
      /The end\s*4/,
    ]);
    await contents.getByTestId('guidebook-contents-item').filter({ hasText: 'The end' }).click();
    await expect(reader(page)).toHaveAttribute('data-page', '4');
    // A link to a web page is an ordinary link, which the app opens in the browser.
    await expect(reader(page).locator('a.gb-link')).toHaveAttribute(
      'href',
      'https://fen.example/more',
    );
    await reader(page).getByTestId('guidebook-back').click();
    await expect(reader(page)).toHaveAttribute('data-page', '2');

    // A page typed.
    await reader(page).getByTestId('guidebook-page').fill('3');
    await reader(page).getByTestId('guidebook-page').press('Enter');
    await expect(reader(page)).toHaveAttribute('data-page', '3');

    // Closed and opened again, it is where it was left.
    await page.keyboard.press('Escape');
    await expect(reader(page)).toBeHidden();
    await openGuidebook(page, 'Marsh Field Guide');
    await expect(reader(page)).toHaveAttribute('data-page', '3');
    await expect(reader(page)).toHaveAttribute('data-mode', 'page');
    // A link to another page of the guidebook goes there.
    await reader(page).getByTestId('guidebook-page').fill('1');
    await reader(page).getByTestId('guidebook-page').press('Enter');
    await reader(page).getByRole('button', { name: 'Go to page 3' }).click();
    await expect(reader(page)).toHaveAttribute('data-page', '3');
    expect(errors).toEqual([]);
  });

  test('search finds pages in the reader, in Guides and in the map’s search', async ({ page }) => {
    const errors = collectErrors(page);
    await start(page);
    await openGuides(page);
    await openGuidebook(page, 'Marsh Field Guide');
    await reader(page).getByTestId('guidebook-scrolling').click();

    // The PDF's text is read once, for search, and kept on this device.
    await reader(page).getByTestId('guidebook-find-button').click();
    await reader(page).getByTestId('guidebook-find').fill('heron');
    const state = reader(page).getByTestId('guidebook-find-state');
    await expect(state).toHaveText('2 pages have “heron”.');
    await expect(reader(page).getByTestId('guidebook-found-page')).toHaveCount(2);
    await reader(page).getByTestId('guidebook-find-next').click();
    await expect(reader(page)).toHaveAttribute('data-page', '3');
    // The words found are marked on the page, where its text says they are.
    await expect(
      reader(page).locator('[data-page="3"] [data-testid="guidebook-mark"]').first(),
    ).toBeVisible();
    await reader(page).getByTestId('guidebook-find-previous').click();
    await expect(reader(page)).toHaveAttribute('data-page', '1');
    await reader(page).getByTestId('guidebook-close').click();

    // In Guides: a page of a guidebook beside the pages of the guides.
    await page.getByTestId('guides-search').fill('bittern');
    const results = page.getByTestId('guidebook-results');
    await expect(results.getByTestId('guidebook-result')).toHaveText([/Marsh Field Guide, page 2/]);
    // The text of a CBZ comes from its pack.
    await page.getByTestId('guides-search').fill('spoonbill');
    await expect(results.getByTestId('guidebook-result')).toHaveText([/Fen Sketches, page 2/]);
    await results.getByTestId('guidebook-result').click();
    await expect(reader(page)).toHaveAttribute('data-page', '2');
    await expect(reader(page).getByTestId('guidebook-find')).toHaveValue('spoonbill');
    await page.keyboard.press('Escape');
    await expect(reader(page)).toBeHidden();

    // In the map's search, beside guides and locations.
    await page.getByTestId('section-map').click();
    await page.getByTestId('search-input').fill('bittern');
    await expect(page.getByTestId('guidebook-results').getByTestId('guidebook-result')).toHaveText([
      /Marsh Field Guide, page 2/,
    ]);
    expect(errors).toEqual([]);
  });

  test('a CBZ shows its pictures in the order of their names', async ({ page }) => {
    const errors = collectErrors(page);
    await start(page);
    await openGuides(page);
    await openGuidebook(page, 'Fen Sketches');
    await expect(reader(page).getByTestId('guidebook-pages')).toHaveText('of 3');
    await expect(reader(page).getByTestId('guidebook-contents-button')).toHaveCount(0);
    await reader(page).getByTestId('guidebook-page-by-page').click();
    const picture = reader(page).locator('img.gb-picture');
    await expect(picture).toHaveAttribute('alt', 'Page 1');
    // p1, p2, p10: the third is the narrowest of the pictures made, the first made.
    await reader(page).getByTestId('guidebook-next').click();
    await reader(page).getByTestId('guidebook-next').click();
    await expect(picture).toHaveAttribute('alt', 'Page 3');
    await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(40);
    await reader(page).getByTestId('guidebook-zoom-out').click();
    await expect(reader(page).getByTestId('guidebook-fit-width')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(errors).toEqual([]);
  });

  test('a pack of guidebooks of a game not here is an entry of its own', async ({ page }) => {
    const errors = collectErrors(page);
    await start(page, [listed(PACK, 'Atlas demo world', true), listed(OWN, 'Hollow Marsh', false)]);
    await openLibraryGame(page, OWN);
    const pane = page.getByTestId('library-game-pane');
    await expect(pane.getByTestId('library-facts')).toContainText('Guidebooks');
    await expect(pane.getByTestId('library-guidebooks-card')).toContainText('Hollow Marsh Atlas');
    // Atlas did not write it: it cannot be changed here.
    await expect(pane.getByTestId('guidebook-remove')).toHaveCount(0);
    await page.getByTestId('library-show').click();
    await expect(page.getByTestId('guides-screen')).toBeVisible();
    await expect(page.getByTestId('guidebook-row')).toHaveText([/Hollow Marsh Atlas/]);
    // The demo game's pack joins it by title: it is not listed apart.
    await openLibraryGame(page, 'demo');
    await expect(page.locator(`[data-testid="library-game"][data-pack="${PACK}"]`)).toHaveCount(0);
    // A pack of guidebooks holds no map files, which load as none.
    expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
  });

  test('a guidebook is added from a file, and removed after asking', async ({ page }) => {
    const errors = collectErrors(page);
    await start(page);
    await page.evaluate(
      ({ length, pack }) => {
        const shell = (
          window as unknown as {
            __mockShell: {
              guidebooks: { pick: unknown; added: unknown };
            };
          }
        ).__mockShell;
        shell.guidebooks.pick = {
          token: 'token-1',
          url: 'http://atlas-pack.localhost/_picked/token-1/guidebook.pdf',
          fileName: 'Marsh Field Guide (second printing).pdf',
          title: 'Marsh Field Guide (second printing)',
          type: 'pdf',
          bytes: length,
          pages: 4,
        };
        shell.guidebooks.added = pack;
      },
      { length: PDF.length, pack: listed(PACK, 'Atlas demo world', true) },
    );
    await openGuides(page);
    await page.getByTestId('add-guidebook').click();
    const dialog = page.getByTestId('add-guidebook-dialog');
    await expect(dialog.getByTestId('guidebook-title-input')).toHaveValue(
      'Marsh Field Guide (second printing)',
    );
    await dialog.getByTestId('guidebook-title-input').fill('Marsh Field Guide, second printing');
    await dialog.getByTestId('confirm-add-guidebook').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('was added to the guidebooks of Atlas demo world')).toBeVisible();
    const calls = (await mock(page)).guidebooks.calls;
    const add = calls.find((call) => call.command === 'guidebook_add');
    const request = add?.args.request as {
      gameId: string;
      gameTitle: string;
      token: string;
      title: string;
      pages: number;
      text: string[];
    };
    // The pack Atlas wrote for the game is added to; the PDF's text was read here.
    expect(request).toMatchObject({
      gameId: PACK,
      gameTitle: 'Atlas demo world',
      token: 'token-1',
      title: 'Marsh Field Guide, second printing',
      pages: 4,
    });
    expect(request.text).toHaveLength(4);
    expect(request.text[1]).toContain('bittern');

    await page.getByTestId('guidebook-remove').first().click();
    const ask = page.getByTestId('remove-guidebook-dialog');
    await expect(ask).toContainText('Remove this guidebook?');
    await ask.getByTestId('confirm-remove-guidebook').click();
    await expect(ask).toBeHidden();
    const remove = (await mock(page)).guidebooks.calls.find(
      (call) => call.command === 'guidebook_remove',
    );
    expect(remove?.args).toEqual({ packId: PACK, file: 'guidebooks/marsh-field-guide.pdf' });
    expect(errors).toEqual([]);
  });
});
