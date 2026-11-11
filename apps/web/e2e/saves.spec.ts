import { typicalSave, WORLD_PATHS } from '@atlas/saves/testing';
import { expect, test, type Page } from '@playwright/test';
import { collectErrors, expectOverallFound, mapStatus, selectByName } from './helpers';

/**
 * Reading a game save in the browser: a small Witcher 3 pack served by the
 * test, and synthetic saves made by the test-only writer of @atlas/saves.
 * The map has a world transform, so no lining up is needed.
 */

const id = (kind: string, local: string) => `witcher3:${kind}:${local}`;
const MAP = id('map', 'velen');
const LAYER = id('layer', 'ground');

function location(local: string, name: string, x: number, y: number, category: string) {
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
  'locations.json': [
    location('sign-a', 'Crossroads signpost', 512, 512, 'sign'), // world (0, 0)
    location('sign-b', 'Mill signpost', 600, 512, 'sign'), // world (176, 0)
    location('nest-a', 'Drowner nest', 300, 300, 'nest'), // world (-424, 424)
    location('nest-b', 'Ghoul nest', 700, 700, 'nest'), // world (376, -376)
  ],
};

/** A save in Velen: the crossroads sign found and the drowner nest destroyed. */
const VELEN_SAVE = typicalSave({
  world: WORLD_PATHS.novigrad,
  player: { x: 10, y: -20, yaw: 90 },
  facts: { q001_done: 1 },
  pins: {
    [WORLD_PATHS.novigrad]: [
      { name: 'sign_a', type: 'RoadSign', x: 3, y: 4, discovered: true },
      { name: 'sign_b', type: 'RoadSign', x: 176, y: 0, discovered: false },
      { name: 'nest_a', type: 'MonsterNestDisabled', x: -420, y: 424 },
      { name: 'nest_b', type: 'MonsterNest', x: 376, y: -376, discovered: true },
    ],
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
    'Read ManualSave_1.sav: 2 places marked found.',
  );
  await expectOverallFound(page, 2);
  // Read in the worker, not on the page.
  expect(workers.some((url) => url.includes('saveWorker'))).toBe(true);
  const dialog = page.getByTestId('save-dialog');
  await expect(dialog.getByTestId('save-world')).toHaveText('Velen and Novigrad');
  await expect(dialog.getByTestId('save-found')).toContainText('2 places, 2 newly marked');
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
  await page.reload();
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

interface FakeSaves {
  folder: string;
  files: { name: string; modified: number; bytes: number[] }[];
  revision: number;
  calls: [string, Record<string, unknown>][];
  reports: Record<string, unknown>[];
}

/** A stand-in for the desktop shell's save commands, over a made-up saves folder. */
function installFakeSaves(initial: { folder: string; files: FakeSaves['files'] }) {
  const state: FakeSaves = { ...initial, revision: 0, calls: [], reports: [] };
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
    pins: {
      [WORLD_PATHS.novigrad]: [{ name: 'sign_a', type: 'RoadSign', x: 3, y: 4, discovered: true }],
    },
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
  await expect(page.getByTestId('toast')).toHaveText('Read AutoSave_1.sav: 1 place marked found.');
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
  await expect(page.getByTestId('toast')).toHaveText('Read AutoSave_2.sav: 1 place marked found.', {
    timeout: 10_000,
  });
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
