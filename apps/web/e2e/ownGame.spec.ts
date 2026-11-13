import type { Page, Route } from '@playwright/test';
import { expect, test } from './layout';
import { collectErrors, libraryMore } from './helpers';

/**
 * A game of one's own in the desktop app: "New game…" on the Games screen
 * (a name, the first map's name and a picture, cut with Cancel and then
 * made), Edit locations on it, "Add map…", "Rename…", "Delete map…", and
 * deleting the game, which offers to delete one's own locations too. A
 * stand-in shell answers the commands; the game's files are served by the
 * test. The cutting itself is covered by the shell's own tests.
 */

test.use({ layout: 'standard' });

/** A plain PNG map image (256 by 256, one colour). */
const TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEAAQMAAABmvDolAAAAA1BMVEUoQFi7dDVDAAAAH0lEQVRo3u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAvg0hAAABmmDh1QAAAABJRU5ErkJggg==',
  'base64',
);

interface Game {
  title: string;
  maps: { id: string; name: string; width: number; height: number }[];
  layers: Record<string, unknown>[];
}

const layerOf = (local: string, name: string) => ({
  id: `cloud-isles:layer:${local}`,
  mapId: `cloud-isles:map:${local}`,
  name,
  tiles: { type: 'xyz', url: `tiles/${local}/{z}/{x}/{y}.png` },
  minZoom: 0,
  maxZoom: 4,
  tileSize: 256,
});

/** Serves the game the stand-in shell made, as the shell's pack protocol would. */
async function serveGame(page: Page, game: Game): Promise<void> {
  await page.route('**/own-packs/cloud-isles/**', (route: Route) => {
    const file = new URL(route.request().url()).pathname.split('/own-packs/cloud-isles/')[1]!;
    if (file.startsWith('tiles/')) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: TILE });
    }
    const json = (value: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', json: value });
    switch (file) {
      case 'manifest.json':
        return json({
          schemaVersion: 2,
          gameId: 'cloud-isles',
          title: game.title,
          packVersion: '1.0.0',
          gamePatch: 'any',
          attribution: [],
          idMigrations: {},
          created: '2026-11-13T09:00:00Z',
          updated: '2026-11-13T09:00:00Z',
          writtenBy: { name: 'Atlas', version: '0.0.0' },
          madeInApp: true,
        });
      case 'maps.json':
        return json(game.maps);
      case 'layers.json':
        return json(game.layers);
      case 'categoryGroups.json':
      case 'categories.json':
      case 'locations.json':
        return json([]);
      default:
        return route.fulfill({ status: 404, body: '' });
    }
  });
}

interface OwnShell {
  /** The game is in the maps folder. */
  made: boolean;
  title: string;
  /** What the next "Choose a picture…" picks. */
  pictures: unknown[];
  job: {
    kind: string;
    name: string;
    reading: boolean;
    tilesDone: number;
    tilesTotal: number;
    cancelling: boolean;
  } | null;
  /** The cut waits while this is true. */
  hold: boolean;
  calls: { command: string; args: Record<string, unknown> }[];
  files: Record<string, string>;
  unknown: string[];
}

function installOwnShell() {
  const shell: OwnShell = {
    made: false,
    title: '',
    pictures: [],
    job: null,
    hold: false,
    calls: [],
    files: {},
    unknown: [],
  };
  (window as unknown as { __ownShell: OwnShell }).__ownShell = shell;
  const url = new URL('own-packs/cloud-isles/', window.location.href).href;
  const listing = () => ({
    mapsFolder: { path: '/home/test/Atlas/Maps', isDefault: true, exists: true },
    packs: shell.made
      ? [
          {
            id: 'cloud-isles',
            title: shell.title,
            url,
            origin: 'maps-folder',
            path: '/home/test/Atlas/Maps/cloud-isles',
            packVersion: '1.0.0',
            bundled: false,
            imported: null,
            madeInApp: true,
          },
        ]
      : [],
    hidden: [],
    locations: [],
    busy: [],
  });
  /** A cut that counts up; it ends when done (and not held) or cancelled. */
  const cut = <T>(kind: string, name: string, total: number, done: () => T) =>
    new Promise<T>((resolve, reject) => {
      shell.job = { kind, name, reading: true, tilesDone: 0, tilesTotal: total, cancelling: false };
      const timer = window.setInterval(() => {
        const job = shell.job!;
        if (job.cancelling) {
          window.clearInterval(timer);
          shell.job = null;
          // Tauri rejects with the command's error value, a string.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject('Cancelled. Nothing was made.');
          return;
        }
        job.reading = false;
        if (shell.hold) return;
        job.tilesDone = Math.min(total, job.tilesDone + 40);
        if (job.tilesDone === total) {
          window.clearInterval(timer);
          shell.job = null;
          resolve(done());
        }
      }, 50);
    });
  const fileKey = (kind: string, args: Record<string, unknown>) => `${kind}:${String(args.gameId)}`;
  const invoke = (command: string, args: Record<string, unknown> = {}) => {
    shell.calls.push({ command, args });
    switch (command) {
      case 'desktop_info':
        return Promise.resolve({
          name: 'Atlas',
          version: '0.0.0',
          platform: 'linux',
          downloads: false,
          folders: true,
          maps: true,
          progressFiles: true,
          imports: false,
          copyPickedFiles: false,
          ownListFiles: true,
          ownLocationFiles: true,
          ownGames: true,
        });
      case 'library_list':
        return Promise.resolve(listing());
      case 'map_picture_pick':
        return Promise.resolve(shell.pictures.shift() ?? null);
      case 'own_game_create':
        return cut('game', args.title as string, 680, () => {
          shell.made = true;
          shell.title = (args.title as string).trim();
          return {
            added: {
              gameId: 'cloud-isles',
              mapId: 'cloud-isles:map:harbour',
              layerId: 'cloud-isles:layer:harbour',
            },
            listing: listing(),
          };
        });
      case 'own_game_add_map':
        return cut('map', args.mapName as string, 120, () => ({
          added: {
            gameId: 'cloud-isles',
            mapId: 'cloud-isles:map:sea-caves',
            layerId: 'cloud-isles:layer:sea-caves',
          },
          listing: listing(),
        }));
      case 'own_game_progress':
        return Promise.resolve(shell.job ? { ...shell.job } : null);
      case 'own_game_cancel':
        if (shell.job) shell.job.cancelling = true;
        return Promise.resolve(null);
      case 'own_game_rename':
        shell.title = (args.title as string).trim();
        return Promise.resolve({ added: null, listing: listing() });
      case 'own_game_delete_map':
        return Promise.resolve({ added: null, listing: listing() });
      case 'own_lists_read':
        return Promise.resolve(shell.files[fileKey('lists', args)] ?? null);
      case 'own_lists_write':
        shell.files[fileKey('lists', args)] = args.contents as string;
        return Promise.resolve(null);
      case 'own_locations_read':
        return Promise.resolve(shell.files[fileKey('locations', args)] ?? null);
      case 'own_locations_write':
        shell.files[fileKey('locations', args)] = args.contents as string;
        return Promise.resolve(null);
      case 'own_locations_delete':
      case 'own_lists_delete': {
        const key = fileKey(command === 'own_lists_delete' ? 'lists' : 'locations', args);
        const had = key in shell.files;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete shell.files[key];
        return Promise.resolve(had);
      }
      case 'library_images_info':
        return Promise.resolve({ bytes: 4_200_000, files: 341, downloading: false });
      case 'library_delete_pack':
        shell.made = false;
        return Promise.resolve({ deleted: true, bytes: 4_200_000, files: 348 });
      default:
        shell.unknown.push(command);
        return Promise.resolve(null);
    }
  };
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
}

const ownShell = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ownShell: OwnShell }).__ownShell);

const setShell = (page: Page, patch: Partial<OwnShell>) =>
  page.evaluate((patch) => {
    Object.assign((window as unknown as { __ownShell: OwnShell }).__ownShell, patch);
  }, patch);

const picture = (name: string, width: number, height: number, problem: string | null) => ({
  path: `/home/test/Pictures/${name}`,
  fileName: name,
  width,
  height,
  format: 'png',
  bytes: Math.round((width * height) / 3),
  levels: problem ? 0 : 5,
  tiles: problem ? 0 : 680,
  problem,
});

test('New game from a picture, Edit locations on it, add a map, rename, delete', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const game: Game = {
    title: 'Cloud Isles',
    maps: [{ id: 'cloud-isles:map:harbour', name: 'Harbour', width: 4096, height: 3072 }],
    layers: [layerOf('harbour', 'Main level')],
  };
  await serveGame(page, game);
  await page.addInitScript(installOwnShell);
  await page.goto('./');
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');

  // New game, in the Library.
  await page.getByTestId('section-library').click();
  await page.getByTestId('new-game').click();
  const dialog = page.getByTestId('picture-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('new-game-name')).toBeFocused();
  await page.getByTestId('new-game-name').fill('Cloud Isles');
  await page.getByTestId('new-map-name').fill('Harbour');

  // A picture too large is refused, with why.
  await setShell(page, {
    pictures: [
      picture(
        'whole-world.png',
        30_000,
        20_000,
        'This picture is 30,000 × 20,000 pixels (600 million pixels), too large for Atlas to cut into a map on this computer. It takes pictures of up to 268 million pixels (16,384 × 16,384) and 20,000 pixels a side: make it smaller in an image editor first.',
      ),
      picture('harbour.png', 4096, 3072, null),
    ],
  });
  await page.getByTestId('choose-picture').click();
  await expect(page.getByTestId('picture-problem')).toContainText('too large');
  await expect(page.getByTestId('picture-make')).toBeDisabled();
  await page.getByTestId('choose-picture').click();
  await expect(page.getByTestId('picture-chosen')).toContainText('harbour.png');
  await expect(page.getByTestId('picture-chosen')).toContainText('4,096 × 3,072 pixels');
  await expect(page.getByTestId('picture-chosen')).toContainText('680 map images');

  // Cut, then cancelled: nothing is made.
  await setShell(page, { hold: true });
  await page.getByTestId('picture-make').click();
  await expect(page.getByTestId('cut-progress')).toContainText('Cutting the map: 0 of 680');
  await page.getByTestId('cut-cancel').click();
  await expect(page.getByTestId('picture-dialog-problem')).toHaveText(
    'Cancelled. Nothing was made.',
  );
  expect((await ownShell(page)).made).toBe(false);

  // Made: the game is shown, on its map.
  await setShell(page, { hold: false });
  await page.getByTestId('picture-make').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('marker-count')).toHaveText('0');
  const listRow = page.locator('[data-testid="library-game"][data-pack="cloud-isles"]');
  await expect(listRow).toContainText('Shown');
  await expect(listRow).toContainText('Made here');
  const row = page.getByTestId('library-game-pane');
  await expect(row).toHaveAttribute('data-pack', 'cloud-isles');
  await expect(row).toContainText('Made in this app');
  const create = (await ownShell(page)).calls.filter((c) => c.command === 'own_game_create');
  expect(create.at(-1)!.args).toEqual({
    title: 'Cloud Isles',
    mapName: 'Harbour',
    picture: '/home/test/Pictures/harbour.png',
  });

  // Edit locations on it: the first location gets a type of one's own.
  await page.getByTestId('section-map').click();
  await page.getByTestId('edit-locations').click();
  const box = (await page.getByTestId('map').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByTestId('location-name').fill('Lighthouse');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('marker-count')).toHaveText('1');
  await expect(page.getByTestId('own-type-row')).toContainText('Location');
  await expect(page.getByTestId('locations-save-state')).toHaveAttribute('data-state', 'saved');
  const saved = JSON.parse((await ownShell(page)).files['locations:cloud-isles']!) as {
    format: string;
    locations: { name: string; categoryId: string }[];
    categories: { id: string; name: string }[];
  };
  expect(saved.format).toBe('atlas-own-locations');
  expect(saved.locations).toEqual([expect.objectContaining({ name: 'Lighthouse' })]);
  expect(saved.categories).toEqual([expect.objectContaining({ name: 'Location' })]);
  await page.getByTestId('locations-done').click();

  // Add map.
  await page.getByTestId('section-library').click();
  game.maps.push({ id: 'cloud-isles:map:sea-caves', name: 'Sea caves', width: 4096, height: 4096 });
  game.layers.push(layerOf('sea-caves', 'Main level'));
  await setShell(page, { pictures: [picture('caves.png', 4096, 4096, null)] });
  await row.getByTestId('add-map').click();
  await expect(page.getByTestId('new-map-name')).toBeFocused();
  await page.getByTestId('new-map-name').fill('Sea caves');
  await page.getByTestId('choose-picture').click();
  await page.getByTestId('picture-make').click();
  await expect(page.getByTestId('picture-dialog')).toHaveCount(0);
  await expect(page.getByTestId('map-status')).toHaveAttribute(
    'data-layer',
    'cloud-isles:layer:sea-caves',
  );

  // Rename.
  game.title = 'Cloud Isles of Ash';
  await row.getByTestId('rename-game').click();
  await page.getByTestId('rename-game-input').fill('Cloud Isles of Ash');
  await page.getByTestId('rename-game-save').click();
  await expect(row).toContainText('Cloud Isles of Ash');

  // Delete a map, after asking which.
  await row.getByTestId('delete-map').click();
  await page.getByTestId('delete-map-choice').selectOption({ label: 'Sea caves' });
  game.maps.pop();
  game.layers.pop();
  await page.getByTestId('confirm-delete-map').click();
  await expect(page.getByTestId('delete-map-confirm')).toHaveCount(0);
  const deleted = (await ownShell(page)).calls.filter((c) => c.command === 'own_game_delete_map');
  expect(deleted.at(-1)!.args).toEqual({
    gameId: 'cloud-isles',
    mapId: 'cloud-isles:map:sea-caves',
  });

  // Deleting the game offers to delete one's own locations and types too.
  await libraryMore(page, 'delete-pack');
  await page.getByTestId('delete-pack-locations').check();
  await page.getByTestId('confirm-delete-pack').click();
  await expect(listRow).toHaveCount(0);
  expect((await ownShell(page)).files['locations:cloud-isles']).toBeUndefined();
  // Optional pack files the stand-in does not serve are the only 404s.
  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
});
