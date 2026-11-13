import { mulberry32 } from '@atlas/saves/match';
import { areaMapPinsFile, entityMapPinsFile, typicalSave, WORLD_PATHS } from '@atlas/saves/testing';
import type { Page } from '@playwright/test';
import { expect, test } from './layout';
import { collectErrors, expectOverallFound, mapStatus, reloadSaved, selectByName } from './helpers';

/**
 * Reading a game save in the browser: a small Witcher 3 pack served by the
 * test, and synthetic saves made by the test-only writer of @atlas/saves.
 * The map has a world transform, so no lining up is needed.
 */

const id = (kind: string, local: string) => `witcher3:${kind}:${local}`;
const MAP = id('map', 'velen');
const LAYER = id('layer', 'ground');

function location(
  local: string,
  name: string,
  x: number,
  y: number,
  category: string,
  flagId?: string,
) {
  return {
    id: id('loc', local),
    mapId: MAP,
    layerId: LAYER,
    x,
    y,
    categoryId: id('cat', category),
    regionId: null,
    name,
    entityIds: [],
    guideId: null,
    since: '1.0.0',
    ...(flagId ? { flagId } : {}),
  };
}

const PACK: Record<string, unknown> = {
  'manifest.json': {
    schemaVersion: 1,
    gameId: 'witcher3',
    title: 'The Witcher 3 test pack',
    packVersion: '1.0.0',
    gamePatch: '4.04',
    attribution: [],
    idMigrations: {},
  },
  // Pixels to world metres: 2 m a pixel, y up, the map's centre at the origin.
  'maps.json': [
    {
      id: MAP,
      name: 'Velen & Novigrad',
      width: 1024,
      height: 1024,
      worldTransform: { a: 2, b: 0, c: 0, d: -2, e: -1024, f: 1024 },
    },
  ],
  'layers.json': [
    {
      id: LAYER,
      mapId: MAP,
      name: 'Ground',
      tiles: { type: 'xyz', url: 'tiles/{z}/{x}/{y}.webp' },
      minZoom: 0,
      maxZoom: 2,
      tileSize: 256,
    },
  ],
  'categoryGroups.json': [{ id: id('catgroup', 'g'), name: 'Places', order: 0 }],
  'categories.json': [
    {
      id: id('cat', 'sign'),
      groupId: id('catgroup', 'g'),
      name: 'Signposts',
      icon: 'flag',
      color: '#c0a060',
      trackable: true,
      defaultVisible: true,
    },
    {
      id: id('cat', 'nest'),
      groupId: id('catgroup', 'g'),
      name: 'Monster Nests',
      icon: 'skull',
      color: '#c04040',
      trackable: true,
      defaultVisible: true,
    },
  ],
  // Each place names the game's tag for its map pin, as a pack with a table of tags would.
  'locations.json': [
    location('sign-a', 'Crossroads signpost', 512, 512, 'sign', 'sign_a'), // world (0, 0)
    location('sign-b', 'Mill signpost', 600, 512, 'sign', 'sign_b'), // world (176, 0)
    location('nest-a', 'Drowner nest', 300, 300, 'nest', 'nest_a'), // world (-424, 424)
    location('nest-b', 'Ghoul nest', 700, 700, 'nest', 'nest_b'), // world (376, -376)
  ],
};

/**
 * A save in Velen: the crossroads sign found and the drowner nest destroyed.
 * The ghoul nest is only discovered and the mill sign only known of.
 */
const VELEN_SAVE = typicalSave({
  world: WORLD_PATHS.novigrad,
  player: { x: 10, y: -20, yaw: 90 },
  facts: { q001_done: 1 },
  mapPins: {
    known: ['sign_b'],
    discovered: ['sign_a', 'nest_a', 'nest_b'],
    disabled: ['nest_a'],
  },
});

async function servePack(page: Page) {
  await page.route('**/config.json', (route) =>
    route.fulfill({
      json: { packs: [{ id: 'w3', url: 'packs/w3/', title: 'The Witcher 3 test pack' }] },
    }),
  );
  await page.route('**/packs/w3/**', (route) => {
    const name = new URL(route.request().url()).pathname.split('/packs/w3/')[1] ?? '';
    const body = PACK[name];
    return body === undefined
      ? route.fulfill({ status: 404, body: 'not found' })
      : route.fulfill({ json: body });
  });
}

async function openSave(page: Page, name: string, bytes: Uint8Array) {
  const dialog = page.getByTestId('save-dialog');
  if (!(await dialog.isVisible())) await page.getByTestId('save-button').click();
  await expect(dialog).toBeVisible();
  await page.getByTestId('save-file-input').setInputFiles({
    name,
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(bytes),
  });
}

test('a save marks places found, shows where the player stood, and never overrides marks made by hand', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await servePack(page);
  await page.goto('./');
  await expect(page.getByTestId('marker-count')).toHaveText('4');
  await expectOverallFound(page, 0);

  // Read a save.
  await openSave(page, 'ManualSave_1.sav', VELEN_SAVE);
  await expect(page.getByTestId('toast')).toHaveText(
    'Read ManualSave_1.sav: 2 locations marked found.',
  );
  await expectOverallFound(page, 2);
  // Read in the worker, not on the page.
  expect(workers.some((url) => url.includes('saveWorker'))).toBe(true);
  const dialog = page.getByTestId('save-dialog');
  await expect(dialog.getByTestId('save-world')).toHaveText('Velen and Novigrad');
  await expect(dialog.getByTestId('save-found')).toContainText('2 locations, 2 newly marked');
  await expect(dialog.getByTestId('save-categories')).toContainText('Signposts1');
  await expect(dialog.getByTestId('save-categories')).toContainText('Monster Nests1');
  await expect(dialog.getByTestId('save-lined-up')).toHaveText(
    'Lined up with the game world by the pack.',
  );

  // Where the player stood: world (10, -20) is pixel (517, 522).
  await dialog.getByTestId('save-show-me').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.atlas-player')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Where you last saved' })).toBeVisible();
  await expect
    .poll(async () => {
      const { x, y } = await mapStatus(page);
      return Math.abs(x - 517) + Math.abs(y - 522);
    })
    .toBeLessThan(3);
  await expect(page.getByTestId('show-me')).toBeVisible();

  // Unmarked by hand, it stays unmarked when the save is read again.
  await selectByName(page, 'Crossroads signpost');
  await expect(page.getByTestId('found-from-save')).toBeVisible();
  await page.keyboard.press('f');
  await expectOverallFound(page, 1);
  await expect(page.getByTestId('found-from-save')).toHaveCount(0);
  await openSave(page, 'ManualSave_1.sav', VELEN_SAVE);
  await expect(page.getByTestId('toast')).toHaveText('Read ManualSave_1.sav: nothing new to mark.');
  await expectOverallFound(page, 1);

  // Removing the marks made from saves leaves the marks made by hand; Z brings them back.
  await dialog.getByTestId('save-remove-marks').click();
  await dialog.getByTestId('save-remove-marks-confirm').click();
  await expectOverallFound(page, 0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.keyboard.press('z');
  await expectOverallFound(page, 1);

  // The link, the last read and the player's position stay after a reload.
  await reloadSaved(page);
  await expect(page.getByTestId('marker-count')).toHaveText('4');
  await expectOverallFound(page, 1);
  await expect(page.locator('.atlas-player')).toBeVisible();
  await page.getByTestId('save-button').click();
  await expect(dialog.getByTestId('save-link')).toContainText('ManualSave_1.sav');
  await expect(dialog.getByTestId('save-world')).toHaveText('Velen and Novigrad');

  expect(errors.filter((error) => !error.includes('Failed to load resource'))).toEqual([]);
});

test('a save of an unknown version is refused, and a world without a map is said so', async ({
  page,
}) => {
  await servePack(page);
  await page.goto('./');
  await expect(page.getByTestId('marker-count')).toHaveText('4');

  await openSave(page, 'Old.sav', typicalSave({ version: [54, 10, 162], player: { x: 0, y: 0 } }));
  await expect(page.getByTestId('save-error')).toContainText(
    'written by a game version Atlas cannot read yet',
  );
  await expectOverallFound(page, 0);

  await openSave(
    page,
    'AutoSave_2.sav',
    typicalSave({ world: WORLD_PATHS.skellige, player: { x: 5, y: 5, yaw: 0 } }),
  );
  await expect(page.getByTestId('toast')).toContainText('No map of this pack shows Skellige.');
  await expect(page.getByTestId('save-no-map')).toBeVisible();
  await expect(page.getByTestId('save-error')).toHaveCount(0);
  await expect(page.locator('.atlas-player')).toHaveCount(0);

  // Showing Skellige on the one map is the person's choice; without a transform for it there, it asks to be placed.
  const skellige = page
    .getByTestId('save-world-row')
    .filter({ hasText: 'Skellige' })
    .getByRole('combobox');
  await skellige.selectOption({ label: 'Velen & Novigrad' });
  await expect(page.getByTestId('save-no-map')).toHaveCount(0);
});

test('a save that marks nothing says why, without calling it a failure', async ({ page }) => {
  await servePack(page);
  await page.goto('./');
  await expect(page.getByTestId('marker-count')).toHaveText('4');
  const dialog = page.getByTestId('save-dialog');

  // A new game: nothing discovered yet.
  await openSave(
    page,
    'AutoSave_0.sav',
    typicalSave({
      version: [64, 27, 163],
      world: WORLD_PATHS.novigrad,
      player: { x: 0, y: 0, yaw: 0 },
    }),
  );
  await expect(page.getByTestId('toast')).toHaveText(
    'Read AutoSave_0.sav: nothing to mark. The save has not discovered any locations yet.',
  );
  await expect(dialog.getByTestId('save-why')).toContainText(
    'has not discovered or cleared any locations yet',
  );
  await expect(dialog.getByTestId('save-map-state')).toHaveText(
    'On the save’s own map: 0 locations discovered, 0 cleared, 0 known of.',
  );
  await expect(dialog.getByTestId('save-error')).toHaveCount(0);

  // Places the save names by tags this pack does not know.
  await openSave(
    page,
    'AutoSave_1.sav',
    typicalSave({
      player: { x: 0, y: 0, yaw: 0 },
      mapPins: { discovered: ['elsewhere_1', 'elsewhere_2'], disabled: ['elsewhere_2'] },
    }),
  );
  await expect(page.getByTestId('toast')).toHaveText(
    'Read AutoSave_1.sav: nothing to mark. The save names 2 discovered locations by the game’s own tags only, and Atlas has no table yet of where those are.',
  );
  await expect(dialog.getByTestId('save-why')).toContainText('Nothing is wrong with the save.');
  await expectOverallFound(page, 0);
  // Reading the game's own map places needs the desktop app.
  await expect(dialog.getByTestId('game-table-desktop-only')).toBeVisible();
  await expect(dialog.getByTestId('game-folder-choose')).toHaveCount(0);
});

test('placing yourself twice lines a map up when the pack cannot', async ({ page }) => {
  // The same pack without a world transform.
  const maps = PACK['maps.json'] as { worldTransform?: unknown }[];
  const without = { ...PACK, 'maps.json': maps.map(({ worldTransform: _t, ...map }) => map) };
  await page.route('**/config.json', (route) =>
    route.fulfill({
      json: { packs: [{ id: 'w3', url: 'packs/w3/', title: 'The Witcher 3 test pack' }] },
    }),
  );
  await page.route('**/packs/w3/**', (route) => {
    const name = new URL(route.request().url()).pathname.split('/packs/w3/')[1] ?? '';
    const body = (without as Record<string, unknown>)[name];
    return body === undefined
      ? route.fulfill({ status: 404, body: 'not found' })
      : route.fulfill({ json: body });
  });
  await page.goto('./');
  await expect(page.getByTestId('marker-count')).toHaveText('4');

  const place = async (file: string, world: { x: number; y: number }) => {
    await openSave(page, file, typicalSave({ player: { ...world, yaw: 0 } }));
    await expect(page.getByTestId('toast')).toContainText('place yourself on the map');
    await page.getByTestId('save-place-me').click();
    await expect(page.getByTestId('placing-notice')).toBeVisible();
    // Where the world point is on this map (2 m a pixel, y up, centred), in the window.
    const pixel = { x: (world.x + 1024) / 2, y: (1024 - world.y) / 2 };
    const point = await page.getByTestId('map').evaluate((element, target) => {
      // The map's own view: its centre and zoom, as the status reports them.
      const status = document.querySelector('[data-testid="map-status"]')!;
      const zoom = Number(status.getAttribute('data-zoom'));
      const cx = Number(status.getAttribute('data-center-x'));
      const cy = Number(status.getAttribute('data-center-y'));
      const scale = 2 ** (zoom - 2);
      const box = element.getBoundingClientRect();
      return {
        x: box.left + box.width / 2 + (target.x - cx) * scale,
        y: box.top + box.height / 2 + (target.y - cy) * scale,
      };
    }, pixel);
    await page.mouse.click(point.x, point.y);
    await expect(page.getByTestId('placing-notice')).toBeHidden();
  };

  await place('ManualSave_1.sav', { x: -300, y: 200 });
  await expect(page.getByTestId('toast')).toContainText('Spot saved.');
  await place('ManualSave_2.sav', { x: 400, y: -250 });
  await expect(page.getByTestId('toast')).toHaveText('The map is lined up with the game world.');
  await expect(page.locator('.atlas-player')).toBeVisible();
  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('save-lined-up')).toHaveText('Lined up from the spots you marked.');
});

interface FakeGameFile {
  path: string;
  bytes: number[];
  /** The shell cannot unpack it, for this reason. */
  fail?: string;
}

interface FakeSaves {
  folder: string;
  files: { name: string; modified: number; bytes: number[] }[];
  revision: number;
  calls: [string, Record<string, unknown>][];
  reports: Record<string, unknown>[];
  /** A made-up game folder and the map files in its bundles. */
  game?: { folder: string; chosen: boolean; files: FakeGameFile[] };
  gameReports: Record<string, unknown>[];
}

/** A stand-in for the desktop shell's save and game file commands, over made-up folders. */
function installFakeSaves(initial: {
  folder: string;
  files: FakeSaves['files'];
  game?: { folder: string; files: FakeGameFile[] };
}) {
  const state: FakeSaves = {
    ...initial,
    game: initial.game && { ...initial.game, chosen: false },
    revision: 0,
    calls: [],
    reports: [],
    gameReports: [],
  };
  (window as unknown as { __fakeSaves: FakeSaves }).__fakeSaves = state;
  const entry = (file: FakeSaves['files'][number]) => ({
    path: `${state.folder}\\${file.name}`,
    name: file.name,
    modified: file.modified,
    size: file.bytes.length,
    screenshot: false,
  });
  const newestFirst = () => [...state.files].sort((a, b) => b.modified - a.modified).map(entry);
  const folder = () => ({
    path: state.folder,
    name: 'gamesaves',
    exists: true,
    saves: newestFirst(),
  });
  const status = () => ({
    path: state.folder,
    newest: newestFirst()[0] ?? null,
    settled: state.revision > 0 ? (newestFirst()[0] ?? null) : null,
    revision: state.revision,
  });
  const invoke = (command: string, args: Record<string, unknown> = {}) => {
    state.calls.push([command, args]);
    switch (command) {
      case 'desktop_info':
        return Promise.resolve({
          name: 'Atlas',
          version: '0.0.0',
          platform: 'test',
          downloads: false,
        });
      case 'saves_default_folder':
      case 'saves_list':
        return Promise.resolve(folder());
      case 'saves_read': {
        const file = state.files.find((f) => `${state.folder}\\${f.name}` === args.path);
        return file
          ? Promise.resolve(Uint8Array.from(file.bytes).buffer)
          : // The shell rejects with a sentence, as Tauri does.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            Promise.reject('That save cannot be found.');
      }
      case 'saves_watch':
      case 'saves_watch_status':
        return Promise.resolve(status());
      case 'saves_unwatch':
        return Promise.resolve(null);
      case 'saves_report':
        state.reports.push(args.report as Record<string, unknown>);
        return Promise.resolve(null);
      case 'game_folder_get':
      case 'game_folder_choose': {
        const game = state.game;
        if (!game) return Promise.resolve(command === 'game_folder_get' ? {} : null);
        if (command === 'game_folder_choose') game.chosen = true;
        return Promise.resolve(
          game.chosen
            ? {
                path: game.folder,
                name: 'The Witcher 3',
                valid: true,
                stamp: 'x64:100:200',
                problem: null,
              }
            : { path: null, name: null, valid: false, stamp: null, problem: null },
        );
      }
      case 'game_files_scan':
        return Promise.resolve({
          stamp: 'x64:100:200',
          bundles: 3,
          entries: 1000,
          files: (state.game?.files ?? []).map((file, index) => ({
            index,
            path: file.path,
            size: file.bytes.length,
            compression: file.fail ? 'Doboz' : 'zlib',
          })),
          extensions: { w2em: 2, w2am: 1 },
          compressions: { zlib: 2, Doboz: 1 },
          layouts: { '2': 3 },
          duplicates: 0,
          outside: 0,
          unreadable: 0,
        });
      case 'game_files_read': {
        const file = state.game?.files[args.index as number];
        if (!file) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject('That file is not one Atlas found in the game.');
        }
        return file.fail
          ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            Promise.reject(file.fail)
          : Promise.resolve(Uint8Array.from(file.bytes).buffer);
      }
      case 'game_files_report':
        state.gameReports.push(args.report as Record<string, unknown>);
        return Promise.resolve(null);
      default:
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(`Unknown command ${command}`);
    }
  };
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
}

test('in the desktop app, the saves folder is linked and each new save is read as the game writes it', async ({
  page,
}) => {
  const folder = 'C:\\Users\\someone\\Documents\\The Witcher 3\\gamesaves';
  const first = typicalSave({
    player: { x: 10, y: -20, yaw: 0 },
    mapPins: { discovered: ['sign_a'] },
  });
  await servePack(page);
  await page.addInitScript(installFakeSaves, {
    folder,
    files: [{ name: 'AutoSave_1.sav', modified: 1000, bytes: [...first] }],
  });
  await page.goto('./');
  await expect(page.getByTestId('marker-count')).toHaveText('4');

  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('save-dialog')).toContainText(folder);
  await page.getByTestId('save-use-default').click();
  await expect(page.getByTestId('toast')).toHaveText(
    'Read AutoSave_1.sav: 1 location marked found.',
  );
  await expectOverallFound(page, 1);
  await expect(page.getByTestId('save-follow')).toBeChecked();
  await expect(page.getByTestId('save-link')).toContainText('gamesaves');

  // The game writes a new save: the drowner nest destroyed.
  await page.evaluate(
    (bytes) => {
      const state = (window as unknown as { __fakeSaves: FakeSaves }).__fakeSaves;
      state.files.push({ name: 'AutoSave_2.sav', modified: 2000, bytes });
      state.revision++;
    },
    // The crossroads sign and the drowner nest done.
    [...VELEN_SAVE],
  );
  await expect(page.getByTestId('toast')).toHaveText(
    'Read AutoSave_2.sav: 1 location marked found.',
    {
      timeout: 10_000,
    },
  );
  await expectOverallFound(page, 2);

  // The log gets file names, versions, world ids and counts only.
  const reports = await page.evaluate(
    () => (window as unknown as { __fakeSaves: FakeSaves }).__fakeSaves.reports,
  );
  expect(reports).toEqual([
    {
      file: 'AutoSave_1.sav',
      ok: true,
      version: 'save version 67, game version 29, format 164',
      world: 'novigrad',
      matched: 1,
      marked: 1,
    },
    {
      file: 'AutoSave_2.sav',
      ok: true,
      version: 'save version 67, game version 29, format 164',
      world: 'novigrad',
      matched: 2,
      marked: 1,
    },
  ]);

  // Following stops when switched off.
  await page.getByTestId('save-follow').uncheck();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __fakeSaves: FakeSaves }).__fakeSaves.calls.some(
          ([command]) => command === 'saves_unwatch',
        ),
      ),
    )
    .toBe(true);
});

test('in the desktop app, the game’s map places line the map up and place what the save names', async ({
  page,
}) => {
  // A made-up world: signposts and nests at random spots, none from the game.
  const random = mulberry32(11);
  const spot = () => ({
    x: Math.round((random() - 0.5) * 1800),
    y: Math.round((random() - 0.5) * 1800),
  });
  const signs = Array.from({ length: 30 }, (_, i) => ({
    name: `sign_${i}`,
    type: 'RoadSign',
    ...spot(),
  }));
  const nests = Array.from({ length: 8 }, (_, i) => ({
    name: `nest_${i}`,
    type: 'MonsterNest',
    ...spot(),
  }));
  // The pack's map has no world transform: 2 m a pixel, y up, centred, as the other tests.
  const toPixel = (p: { x: number; y: number }) => ({ x: (p.x + 1024) / 2, y: (1024 - p.y) / 2 });
  const maps = PACK['maps.json'] as { worldTransform?: unknown }[];
  const pack: Record<string, unknown> = {
    ...PACK,
    'maps.json': maps.map(({ worldTransform: _t, ...map }) => map),
    'locations.json': [
      ...signs.map((p) => {
        const at = toPixel(p);
        return location(`l-${p.name}`, 'Signpost', at.x, at.y, 'sign');
      }),
      ...nests.map((p) => {
        const at = toPixel(p);
        return location(`l-${p.name}`, 'Nest', at.x, at.y, 'nest');
      }),
    ],
  };
  await page.route('**/config.json', (route) =>
    route.fulfill({
      json: { packs: [{ id: 'w3', url: 'packs/w3/', title: 'The Witcher 3 test pack' }] },
    }),
  );
  await page.route('**/packs/w3/**', (route) => {
    const name = new URL(route.request().url()).pathname.split('/packs/w3/')[1] ?? '';
    const body = pack[name];
    return body === undefined
      ? route.fulfill({ status: 404, body: 'not found' })
      : route.fulfill({ json: body });
  });
  const save = typicalSave({
    world: WORLD_PATHS.novigrad,
    player: { x: 10, y: -20, yaw: 0 },
    mapPins: { discovered: ['sign_3', 'nest_1', 'nest_2'], disabled: ['nest_1'] },
  });
  await page.addInitScript(installFakeSaves, {
    folder: 'C:\\Users\\someone\\Documents\\The Witcher 3\\gamesaves',
    files: [{ name: 'AutoSave_1.sav', modified: 1000, bytes: [...save] }],
    game: {
      folder: 'C:\\Games\\The Witcher 3',
      files: [
        { path: 'game\\world.w2am', bytes: [...areaMapPinsFile([WORLD_PATHS.novigrad])] },
        {
          path: 'game\\hub_pins\\novigrad.w2em',
          bytes: [...entityMapPinsFile([...signs, ...nests])],
        },
        {
          path: 'game\\hub_pins\\the_spiral.w2em',
          bytes: [],
          fail: 'Could not read game\\hub_pins\\the_spiral.w2em (Doboz, in blob.bundle): it is packed with Doboz, a compression Atlas cannot read yet.',
        },
      ],
    },
  });
  await page.goto('./');
  await expect(page.getByTestId('marker-count')).toHaveText('38');

  await page.getByTestId('save-button').click();
  const table = page.getByTestId('game-table');
  await expect(table).toContainText('No game folder chosen yet.');
  await table.getByTestId('game-folder-choose').click();
  await expect(page.getByTestId('toast')).toHaveText('Read 38 map locations from the game.');
  await expect(table.getByTestId('game-table-counts')).toHaveText(
    '38 map locations read: Velen and Novigrad 38.',
  );
  await expect(table.getByTestId('game-folder')).toHaveText('C:\\Games\\The Witcher 3');

  // The save names a signpost discovered and a nest cleared: both placed, the map lined up.
  await page.getByTestId('save-use-default').click();
  await expect(page.getByTestId('toast')).toHaveText(
    'Read AutoSave_1.sav: 2 locations marked found.',
  );
  await expectOverallFound(page, 2);
  await expect(page.getByTestId('save-lined-up')).toHaveText(
    'Lined up from the game’s map locations (30 of 30 signposts fit).',
  );
  await page.getByTestId('save-show-me').click();
  await expect(page.locator('.atlas-player')).toBeVisible();

  // The log gets counts, world ids and pin types: no pin's name and no position.
  const reports = await page.evaluate(
    () => (window as unknown as { __fakeSaves: FakeSaves }).__fakeSaves.gameReports,
  );
  expect(reports[0]).toMatchObject({
    kind: 'table',
    files: 2,
    readFailed: 1,
    parsed: 2,
    failed: 0,
    worlds: { novigrad: { pins: 38, types: { RoadSign: 30, MonsterNest: 8 } } },
  });
  expect(reports.at(-1)).toMatchObject({
    kind: 'match',
    saveTags: 3,
    saveTagsFound: 3,
    fits: { novigrad: { kinds: 'first', inliers: 30, candidates: 30, places: 30, passed: true } },
  });
  const logged = JSON.stringify(reports);
  expect(logged).not.toMatch(/sign_|nest_/);
  for (const p of [...signs, ...nests]) expect(logged).not.toContain(`"x":${p.x}`);
});

test.describe('in the standard layout', () => {
  test.use({ layout: 'standard' });

  test('reads a save from the rail, and shows where the player stood', async ({ page }) => {
    const errors = collectErrors(page);
    await servePack(page);
    await page.goto('./');
    await expect(page.getByTestId('marker-count')).toHaveText('4');
    const found = page.getByTestId('progress-ring').first();
    await expect(found).toHaveAttribute('data-found', '0');

    // "Game save" is in the rail, beside the profile.
    const button = page.locator('.touch-rail').getByTestId('save-button');
    await expect(button).toHaveAttribute('title', 'Game save: read your progress from a save');
    await openSave(page, 'ManualSave_1.sav', VELEN_SAVE);
    await expect(page.getByTestId('toast')).toHaveText(
      'Read ManualSave_1.sav: 2 locations marked found.',
    );
    await expect(found).toHaveAttribute('data-found', '2');
    await expect(button).toHaveAttribute('title', 'Game save: linked');

    const dialog = page.getByTestId('save-dialog');
    await dialog.getByTestId('save-show-me').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('img', { name: 'Where you last saved' })).toBeVisible();
    await expect(page.getByTestId('show-me')).toBeVisible();

    // Esc closes the dialog, and only the dialog.
    await page.getByTestId('section-games').click();
    await page.getByTestId('save-row').click();
    await expect(dialog.getByTestId('save-link')).toContainText('ManualSave_1.sav');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('.touch')).toHaveAttribute('data-section', 'games');
    expect(errors.filter((error) => !error.includes('Failed to load resource'))).toEqual([]);
  });
});
