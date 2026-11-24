import { mkdir } from 'node:fs/promises';
import { expect, test } from './layout';
import { DOWNLOADS_BUILD, mock, realErrors, setMock, setUp } from './fakeShell';
import { collectErrors } from './helpers';

/**
 * "Make a 3D map from game files", against a stand-in for the desktop
 * shell (`fakeShell.ts`): a made-up importer of a made-up engine's files
 * surveys a made-up folder the person picks, lists its levels to tick,
 * asks for the "For personal use" box, and builds each ticked level with
 * the app's builder (the stand-in answers for it). Every name, file and
 * number is made up.
 */

test.skip(!DOWNLOADS_BUILD, 'Game files are read only in a build with downloads.');

const SHOTS = process.env.ATLAS_GAME_FILES_SHOTS ?? 'test-results/game-files';
// Pictures for people to look at are taken at twice the size.
if (process.env.ATLAS_GAME_FILES_SHOTS) test.use({ deviceScaleFactor: 2 });

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

/** A made-up importer: a game's levels are `levels/*.lvl`, its name in `game.txt`. */
const IMPORTER = String.raw`
const model = () => {
  const json = new TextEncoder().encode('{"asset":{"version":"2.0"}}  ');
  const out = new Uint8Array(20 + json.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, json.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  return out;
};
const levelsOf = async (folder) =>
  (await folder.list('levels'))
    .filter((e) => !e.folder && e.name.endsWith('.lvl'))
    .map((e) => e.name.slice(0, -4));
export default {
  apiVersion: 1,
  id: 'made-up-engine',
  title: 'Made-up engine files',
  description: 'Reads the files of games of a made-up engine.',
  version: '1.0.0',
  matches: () => false,
  convert: async () => ({ ok: false, message: 'Not a page.' }),
  gameFiles: {
    kinds: [
      {
        id: 'made-up-engine',
        title: 'Made-up engine games',
        description: 'Games of the made-up engine. Choose the folder the game is installed in.',
      },
    ],
    async survey(kind, folder) {
      const top = await folder.list('');
      if (!top.some((e) => e.name === 'game.txt')) {
        return { ok: false, message: 'This folder holds no game of the made-up engine.' };
      }
      const title = new TextDecoder().decode(await folder.read('game.txt')).trim();
      const levels = await levelsOf(folder);
      return {
        ok: true,
        game: { id: 'made-up-quest', title },
        maps: levels.map((id, n) => ({
          id,
          name: id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
          group: n < 2 ? 'Chapter 1' : 'Chapter 2',
        })),
        notes: ['Props are not made yet: each map shows the level’s walls, floors and terrain.'],
      };
    },
    async build(kind, folder, maps, context) {
      const packId = 'made-up-quest-game-files';
      const id = (k, local) => packId + ':' + k + ':' + local;
      const made = [];
      const layers = [];
      const builds = [];
      for (const [n, map] of maps.entries()) {
        if (context.cancelled()) break;
        context.progress({ done: n, total: maps.length, text: map + ': building the 3D map' });
        const bytes = await folder.read('levels/' + map + '.lvl');
        if (bytes.length === 0) continue;
        const built = await context.sceneModel({
          model: model(),
          folder: map,
          axes: ['+x', '+y', '+z'],
          scale: 0.5,
          textures: 'keep',
        });
        if (!built.ok) return { ok: false, message: built.message };
        made.push({
          id: id('map', map),
          name: map,
          width: built.width,
          height: built.height,
          worldTransform: built.worldTransform,
          scene: built.scene,
        });
        layers.push(
          ...built.layers.map((layer) => ({
            id: id('layer', map + '.' + layer.id),
            mapId: id('map', map),
            name: 'Map',
            tiles: { type: 'xyz', url: layer.url },
            minZoom: layer.minZoom,
            maxZoom: layer.maxZoom,
            tileSize: layer.tileSize,
          })),
        );
        builds.push({ build: built.build, folder: map });
        context.progress({ done: n + 1, total: maps.length, text: map + ': made' });
      }
      if (made.length === 0) return { ok: false, message: 'No level was made.' };
      return {
        ok: true,
        packId,
        sourceKey: 'made-up-engine-made-up-quest',
        mapId: made[0].id,
        site: 'Game files',
        pack: {
          manifest: {
            schemaVersion: 1,
            gameId: packId,
            title: 'Made Up Quest',
            packVersion: '1.0.0',
            gamePatch: 'unknown',
            attribution: [{ name: 'Made from the game’s own files', license: 'For personal use' }],
            idMigrations: {},
          },
          maps: made,
          layers,
          regions: [],
          categoryGroups: [],
          categories: [],
          locations: [],
          entities: [],
          checklists: [],
          checklistItems: [],
          guides: [],
          links: [],
          presets: [],
        },
        summary: {
          game: 'Made Up Quest',
          map: made.length + ' levels',
          maps: made.length,
          locations: 0,
          mapLocations: 0,
          categories: 0,
          refreshed: false,
          leftOut: ['“ruined_tower”: 2 textures were not found in the game’s files, so their surfaces are drawn grey.'],
        },
        sceneBuilds: builds,
      };
    },
  },
};
`;

const FOLDER = {
  name: 'Made Up Quest',
  files: {
    'game.txt': 'Made Up Quest\n',
    'levels/ruined_tower.lvl': 'made-up level',
    'levels/sunken_hall.lvl': 'made-up level',
    'levels/the_long_road.lvl': 'made-up level',
    'readme.txt': 'A made-up game.',
  },
};

test('makes 3D maps from a game’s files: the folder picked, levels ticked, personal use confirmed', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await setUp(page, true, {
    importers: [{ id: 'made-up-engine', title: 'Made-up engine files', source: IMPORTER }],
  });
  await page.getByTestId('add-map-button').click();
  const start = page.getByTestId('game-files-start');
  await expect(start).toContainText('Make a 3D map from game files');
  await page.screenshot({ path: `${SHOTS}/1-button.png` });

  // One kind of game: straight to the folder.
  await start.click();
  const steps = page.getByTestId('game-files');
  await expect(steps).toHaveAttribute('data-step', 'folder');
  await expect(steps).toContainText('Made-up engine games.');
  await expect(steps).toContainText('This app only reads it');

  // The dialog closed: nothing happens.
  await page.getByTestId('game-files-pick').click();
  await expect(steps).toHaveAttribute('data-step', 'folder');

  // A folder that is not a game: a plain sentence, and the folder can be picked again.
  await setMock(page, {
    gameFolder: { pick: { name: 'Pictures', files: { 'a.png': 'x' } }, buildMs: 0, calls: [] },
  });
  await page.getByTestId('game-files-pick').click();
  await expect(page.getByTestId('game-files-error')).toContainText(
    'This folder holds no game of the made-up engine.',
  );
  await page.screenshot({ path: `${SHOTS}/2-folder.png` });

  await setMock(page, { gameFolder: { pick: FOLDER, buildMs: 1500, calls: [] } });
  await page.getByTestId('game-files-pick').click();
  await expect(steps).toHaveAttribute('data-step', 'maps');
  await expect(steps).toContainText('Made Up Quest, in Made Up Quest: 3 maps.');
  await expect(page.getByTestId('game-files-map')).toHaveCount(3);
  await expect(steps).toContainText('Props are not made yet');
  // Nothing is made until a level is ticked and personal use is confirmed.
  const build = page.getByTestId('game-files-build');
  await expect(build).toBeDisabled();
  await page.getByTestId('game-files-tick-all').click();
  await expect(build).toHaveText('Make 3 maps');
  await expect(build).toBeDisabled();
  await page
    .getByTestId('game-files-map')
    .filter({ hasText: 'The long road' })
    .getByRole('checkbox')
    .uncheck();
  await page.getByTestId('game-files-personal').check();
  await expect(build).toHaveText('Make 2 maps');
  await expect(build).toBeEnabled();
  await expect(page.getByTestId('game-files-licence')).toContainText('For personal use.');
  await page.screenshot({ path: `${SHOTS}/3-levels.png` });

  await build.click();
  await expect(page.getByTestId('game-files-building')).toBeVisible();
  await expect(page.getByTestId('game-files-progress')).toContainText('building the 3D map');
  await page.screenshot({ path: `${SHOTS}/4-building.png` });

  await expect(page.getByTestId('game-files-done')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('game-files-done')).toContainText(
    'Made Up Quest: 2 maps were made and saved.',
  );
  await expect(page.getByTestId('game-files-done')).toContainText('2 textures were not found');
  await page.screenshot({ path: `${SHOTS}/5-done.png` });

  // The folder was read, never written; it is let go once the maps are made.
  const calls = (await mock(page)).gameFolder.calls;
  expect(calls.filter((c) => c.startsWith('import_build_scene'))).toEqual([
    'import_build_scene ruined_tower',
    'import_build_scene sunken_hall',
  ]);
  expect(calls).toContain('import_folder_close');
  expect(calls.some((c) => c === 'import_folder_read levels/the_long_road.lvl')).toBe(false);
  // The game is saved with the others, as any import is.
  expect((await mock(page)).events.filter((e) => e.what === 'save')).toEqual([
    expect.objectContaining({ url: 'game-files:made-up-engine/made-up-quest' }),
  ]);
  expect(realErrors(errors)).toEqual([]);
});
