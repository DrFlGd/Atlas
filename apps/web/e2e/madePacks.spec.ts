import type { Page, Route } from '@playwright/test';
import { expect, test } from './layout';
import { collectErrors } from './helpers';

/**
 * Maps made here becoming pack files, in the desktop app without
 * downloads: the wording of "New map from a picture…", "Write the pack
 * file" (one confirmation, then the map read from its file; a newer file
 * there replaced only on Replace), "Open for editing" and "Close without
 * writing", and the offer of the maker's own things a pack file carries,
 * added with an import's merge or not wanted. A stand-in shell answers the
 * commands; writing, checking and unpacking the file are covered by the
 * shell's own tests (`src-tauri/src/madepack/tests.rs`).
 */

test.use({ layout: 'standard' });

/** A plain PNG map image (256 by 256, one colour). */
const TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEAAQMAAABmvDolAAAAA1BMVEUoQFi7dDVDAAAAH0lEQVRo3u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAvg0hAAABmmDh1QAAAABJRU5ErkJggg==',
  'base64',
);

/** Serves the map "Ruined Keep", from its folder or its pack file alike. */
async function serveMap(page: Page): Promise<void> {
  await page.route('**/made-packs/ruined-keep/**', async (route: Route) => {
    const file = new URL(route.request().url()).pathname.split('/made-packs/ruined-keep/')[1]!;
    if (file.startsWith('tiles/')) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: TILE });
    }
    const json = (value: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', json: value });
    switch (file) {
      case 'manifest.json':
        return json({
          schemaVersion: 2,
          gameId: 'ruined-keep',
          title: 'Ruined Keep',
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
        return json([
          { id: 'ruined-keep:map:courtyard', name: 'Courtyard', width: 4096, height: 3072 },
        ]);
      case 'layers.json':
        return json([
          {
            id: 'ruined-keep:layer:courtyard',
            mapId: 'ruined-keep:map:courtyard',
            name: 'Main level',
            tiles: { type: 'xyz', url: 'tiles/courtyard/{z}/{x}/{y}.png' },
            minZoom: 0,
            maxZoom: 4,
            tileSize: 256,
          },
        ]);
      case 'categoryGroups.json':
      case 'categories.json':
      case 'locations.json':
        return json([]);
      default:
        return route.fulfill({ status: 404, body: '' });
    }
  });
}

/** Where the map is read from: the folder made here, its pack file, or a folder opened for editing. */
type Kept = 'folder' | 'file' | 'editing';

interface MadeShell {
  kept: Kept;
  /** The next plan of a write says a newer file is there. */
  newer: boolean;
  /** The own things the pack file offers, by version; null for none. */
  offer: { exportedAt: string; locations: number; lists: number } | null;
  calls: { command: string; args: Record<string, unknown> }[];
  files: Record<string, string>;
  unknown: string[];
}

function installMadeShell() {
  const shell: MadeShell = {
    kept: 'folder',
    newer: false,
    offer: null,
    calls: [],
    files: {},
    unknown: [],
  };
  (window as unknown as { __madeShell: MadeShell }).__madeShell = shell;
  const url = new URL('made-packs/ruined-keep/', window.location.href).href;
  const FILE = '/home/test/Atlas/Packs/Ruined Keep.atlaspack';
  const listing = () => ({
    mapsFolder: { path: '/home/test/Atlas/Maps', isDefault: true, exists: true },
    packs: [
      {
        id: 'ruined-keep',
        title: 'Ruined Keep',
        url,
        origin: shell.kept === 'file' ? 'packs-folder' : 'maps-folder',
        path: shell.kept === 'file' ? FILE : '/home/test/Atlas/Maps/ruined-keep',
        packVersion: '1.0.0',
        bundled: false,
        imported: null,
        madeInApp: true,
        ...(shell.kept === 'file'
          ? { packFile: true, fileVersion: { changed: 1, made: 2 } }
          : { madeHere: true }),
        ...(shell.kept === 'editing'
          ? { editing: { path: FILE, fileName: 'Ruined Keep.atlaspack' } }
          : {}),
      },
    ],
    hidden: [],
    locations: [],
    busy: [],
  });
  const header = (exportedAt: string) => ({
    format: 'atlas-pack-file',
    version: 7,
    packId: 'ruined-keep',
    title: 'Ruined Keep',
    packVersion: '1.0.0',
    detail: 'full',
    exportedAt,
    exportedBy: { name: 'Atlas', version: '0.0.0' },
    pack: { id: 'ruined-keep', title: 'Ruined Keep', packVersion: '1.0.0', attribution: [] },
    source: {},
    contents: {
      maps: 1,
      layers: 1,
      locations: 0,
      categories: 0,
      regions: 0,
      checklists: 0,
      guides: 0,
    },
    images: { detail: 'full', files: 1, bytes: 10, layers: [] },
    files: 5,
    bytes: 100,
  });
  const ownLocations = (names: string[]) =>
    JSON.stringify({
      format: 'atlas-own-locations',
      version: 1,
      gameId: 'ruined-keep',
      updatedAt: '2026-11-12T09:00:00Z',
      categoryGroups: [{ id: 'ruined-keep:catgroup:own.mine', name: 'My types', order: 9 }],
      categories: [
        {
          id: 'ruined-keep:cat:own.gate',
          groupId: 'ruined-keep:catgroup:own.mine',
          name: 'Gate',
        },
      ],
      regions: [],
      locations: names.map((name, n) => ({
        id: `ruined-keep:loc:own.${n}`,
        mapId: 'ruined-keep:map:courtyard',
        layerId: 'ruined-keep:layer:courtyard',
        x: 10 + n,
        y: 20,
        categoryId: 'ruined-keep:cat:own.gate',
        regionId: null,
        name,
      })),
    });
  const imported = (exportedAt: string, own: string | null) => ({
    packId: 'ruined-keep',
    title: 'Ruined Keep',
    replaced: false,
    header: header(exportedAt),
    listing: listing(),
    ownLocations: own,
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
      case 'made_pack_plan':
        return Promise.resolve({
          id: 'ruined-keep',
          title: 'Ruined Keep',
          folder: '/home/test/Atlas/Maps/ruined-keep',
          target: FILE,
          fileName: 'Ruined Keep.atlaspack',
          targetFolder: '/home/test/Atlas/Packs',
          replaces: shell.kept === 'editing',
          openedFrom: shell.kept === 'editing',
          newer: shell.newer
            ? 'The pack file Ruined Keep.atlaspack is newer than the one this map was opened from: it was written 2026-11-14T10:00:00Z, after the map was opened. Replacing it loses what was changed in it since.'
            : null,
          removesFolder: true,
          mine: { lists: 0, locations: 3, types: 1, areas: 0 },
        });
      case 'made_pack_write':
        if (shell.newer && args.replaceNewer !== true) {
          // Tauri rejects with the command's error value, a string.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject('A newer file is there. Choose Replace to write over it.');
        }
        shell.kept = 'file';
        shell.newer = false;
        return Promise.resolve({
          id: 'ruined-keep',
          path: FILE,
          fileName: 'Ruined Keep.atlaspack',
          size: 4_200_000,
          header: header('2026-11-14T09:00:00Z'),
          folderRemoved: true,
          folderComplete: true,
          note: null,
          listing: listing(),
        });
      case 'made_pack_open_plan':
        return Promise.resolve({
          id: 'ruined-keep',
          title: 'Ruined Keep',
          path: FILE,
          fileName: 'Ruined Keep.atlaspack',
          folder: '/home/test/Atlas/Maps/ruined-keep',
          mine: null,
        });
      case 'made_pack_open':
        shell.kept = 'editing';
        return Promise.resolve(imported('2026-11-14T09:00:00Z', null));
      case 'made_pack_close':
        shell.kept = 'file';
        return Promise.resolve(listing());
      case 'made_pack_mine_offer':
        return Promise.resolve(
          shell.kept === 'file' && shell.offer
            ? {
                id: 'ruined-keep',
                title: 'Ruined Keep',
                path: FILE,
                exportedAt: shell.offer.exportedAt,
                facts: {
                  lists: shell.offer.lists,
                  locations: shell.offer.locations,
                  types: 1,
                  areas: 0,
                },
              }
            : null,
        );
      case 'made_pack_mine_take':
        return Promise.resolve(
          imported(args.exportedAt as string, ownLocations(['North gate', 'Well', 'Tower'])),
        );
      case 'made_pack_mine_choose':
        shell.offer = null;
        return Promise.resolve(null);
      case 'packfile_progress':
        return Promise.resolve(null);
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
      default:
        shell.unknown.push(command);
        return Promise.resolve(null);
    }
  };
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
}

const madeShell = (page: Page) =>
  page.evaluate(() => (window as unknown as { __madeShell: MadeShell }).__madeShell);

const setShell = (page: Page, patch: Partial<MadeShell>) =>
  page.evaluate((patch) => {
    Object.assign((window as unknown as { __madeShell: MadeShell }).__madeShell, patch);
  }, patch);

const callsOf = async (page: Page, command: string) =>
  (await madeShell(page)).calls.filter((call) => call.command === command);

test('a map made here: its wording, Write the pack file, Open for editing and Close without writing', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await serveMap(page);
  await page.addInitScript(installMadeShell);
  await page.goto('./');
  await page.getByTestId('section-library').click();

  // The person makes a map for a game, never a game.
  await expect(page.getByTestId('new-game')).toHaveText('New map from a picture…');
  await page.getByTestId('new-game').click();
  const dialog = page.getByTestId('picture-dialog');
  await expect(dialog.getByRole('heading')).toHaveText('New map for a game');
  await expect(dialog).toContainText('The game it is for');
  await expect(dialog.getByTestId('picture-make')).toHaveText('Make map');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);

  // Its pane: Write the pack file, after one confirmation.
  const listRow = page.locator('[data-testid="library-game"][data-pack="ruined-keep"]');
  await listRow.click();
  const pane = page.getByTestId('library-game-pane');
  await expect(pane).toHaveAttribute('data-pack', 'ruined-keep');
  const own = page.getByTestId('library-own-card');
  await expect(own).toContainText('Your map');
  await expect(own).toContainText('Write the pack file makes it one pack file');
  await own.getByTestId('write-pack-file').click();
  const confirm = page.getByTestId('write-pack-confirm');
  await expect(confirm).toContainText('Write the pack file of Ruined Keep?');
  await expect(confirm).toContainText(
    'Writes Ruined Keep as the new pack file Ruined Keep.atlaspack in /home/test/Atlas/Packs',
  );
  await expect(confirm).toContainText('Your own 3 locations and 1 type of the map go in the file');
  await expect(confirm).toContainText('checked whole');
  await expect(confirm).toContainText('If anything fails, nothing is removed');
  // Cancel writes nothing.
  await confirm.getByTestId('write-pack-cancel').click();
  await expect(confirm).toHaveCount(0);
  expect(await callsOf(page, 'made_pack_write')).toEqual([]);

  await own.getByTestId('write-pack-file').click();
  await page.getByTestId('write-pack-go').click();
  await expect(page.getByTestId('toast')).toContainText(
    'Wrote the pack file Ruined Keep.atlaspack. Atlas reads the map from it now.',
  );
  expect((await callsOf(page, 'made_pack_write')).at(-1)!.args).toEqual({
    id: 'ruined-keep',
    replaceNewer: false,
  });

  // Read from its pack file now: Open for editing is offered, nothing that changes it.
  await expect(page.getByTestId('library-origin')).toHaveText(
    'Made in Atlas, read from its pack file',
  );
  await expect(own).toHaveCount(0);
  const fileCard = page.getByTestId('library-made-file-card');
  await expect(fileCard).toContainText('never changes the file by itself');
  await page.getByTestId('library-more').click();
  await expect(page.getByTestId('pack-file-note')).toContainText(
    'Open for editing unpacks it into a folder where you can change it.',
  );
  await expect(page.getByTestId('library-more-menu').getByTestId('delete-pack')).toHaveCount(0);
  await page.getByTestId('library-more-menu').getByTestId('open-editing').click();
  const opening = page.getByTestId('open-editing-confirm');
  await expect(opening).toContainText('Open Ruined Keep for editing?');
  await expect(opening).toContainText(
    'The pack file stays as it is until you press Write the pack file.',
  );
  await opening.getByTestId('open-editing-go').click();
  await expect(page.getByTestId('toast')).toContainText('Opened the map for editing.');

  // Open for editing: one line says so; Close without writing replaces Delete.
  await expect(page.getByTestId('library-editing')).toHaveText(
    'This map is open for editing from its pack file Ruined Keep.atlaspack. Write the pack file finishes it.',
  );
  await page.getByTestId('library-more').click();
  await expect(page.getByTestId('library-more-menu').getByTestId('delete-pack')).toHaveCount(0);
  await page.getByTestId('library-more-menu').getByTestId('close-editing').click();
  const closing = page.getByTestId('close-editing-confirm');
  await expect(closing).toContainText('The pack file Ruined Keep.atlaspack stays as it was');
  await closing.getByTestId('close-editing-go').click();
  await expect(page.getByTestId('toast')).toContainText('Closed the map without writing.');
  await expect(fileCard).toBeVisible();
  expect(await callsOf(page, 'made_pack_close')).toHaveLength(1);

  // Opened again, and a newer file arrived meanwhile: only Replace writes over it.
  await fileCard.getByTestId('open-editing').click();
  await page.getByTestId('open-editing-go').click();
  await expect(page.getByTestId('library-editing')).toBeVisible();
  await setShell(page, { newer: true });
  await page.getByTestId('library-own-card').getByTestId('write-pack-file').click();
  const again = page.getByTestId('write-pack-confirm');
  await expect(again).toContainText('over the pack file it was opened from, Ruined Keep.atlaspack');
  await expect(again.getByTestId('write-pack-newer')).toContainText('is newer than the one');
  await expect(again.getByTestId('write-pack-go')).toHaveCount(0);
  await again.getByTestId('write-pack-replace').click();
  await expect(again).toHaveCount(0);
  expect((await callsOf(page, 'made_pack_write')).at(-1)!.args).toEqual({
    id: 'ruined-keep',
    replaceNewer: true,
  });
  // Every command of maps made here is answered.
  expect((await madeShell(page)).unknown.filter((c) => c.startsWith('made_pack'))).toEqual([]);
  // Optional pack files the stand-in does not serve are the only 404s.
  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
});

test('the maker’s own things a pack file carries are offered, added or not wanted', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await serveMap(page);
  await page.addInitScript(installMadeShell);
  await page.addInitScript(() => {
    Object.assign((window as unknown as { __madeShell: MadeShell }).__madeShell, {
      kept: 'file',
      offer: { exportedAt: '2026-11-14T09:00:00Z', locations: 3, lists: 0 },
    });
  });
  await page.goto('./');
  await page.getByTestId('section-library').click();
  await page.locator('[data-testid="library-game"][data-pack="ruined-keep"]').click();

  const offer = page.getByTestId('mine-offer');
  await expect(offer).toContainText(
    'This pack file carries 3 locations and 1 type made with the map.',
  );
  // Never taken by itself.
  expect(await callsOf(page, 'made_pack_mine_take')).toEqual([]);
  await offer.getByTestId('mine-offer-add').click();
  await expect(page.getByTestId('toast')).toContainText('from the pack file to yours.');
  await expect(offer).toHaveCount(0);
  expect((await callsOf(page, 'made_pack_mine_take')).at(-1)!.args).toEqual({
    id: 'ruined-keep',
    exportedAt: '2026-11-14T09:00:00Z',
  });
  expect((await callsOf(page, 'made_pack_mine_choose')).at(-1)!.args).toEqual({
    id: 'ruined-keep',
    exportedAt: '2026-11-14T09:00:00Z',
    added: true,
  });
  // Added through an import's merge, into the person's own locations.
  const saved = JSON.parse((await madeShell(page)).files['locations:ruined-keep']!) as {
    locations: { name: string }[];
  };
  expect(saved.locations.map((location) => location.name).sort()).toEqual([
    'North gate',
    'Tower',
    'Well',
  ]);

  // Another version of the file: offered again; not wanted, it is not offered again.
  await setShell(page, { offer: { exportedAt: '2026-11-15T09:00:00Z', locations: 5, lists: 2 } });
  await page.getByTestId('section-map').click();
  await page.getByTestId('section-library').click();
  await page.locator('[data-testid="library-game"][data-pack="ruined-keep"]').click();
  await expect(offer).toContainText('This pack file carries 2 lists, 5 locations and 1 type');
  await offer.getByTestId('mine-offer-dismiss').click();
  await expect(offer).toHaveCount(0);
  expect((await callsOf(page, 'made_pack_mine_choose')).at(-1)!.args).toEqual({
    id: 'ruined-keep',
    exportedAt: '2026-11-15T09:00:00Z',
    added: false,
  });
  expect(await callsOf(page, 'made_pack_mine_take')).toHaveLength(1);
  // Every command of maps made here is answered.
  expect((await madeShell(page)).unknown.filter((c) => c.startsWith('made_pack'))).toEqual([]);
  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
});
