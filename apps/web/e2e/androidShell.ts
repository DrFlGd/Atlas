import { expect, type Page } from '@playwright/test';

/**
 * A stand-in for the Android shell, for the page as the Android app runs
 * it. It answers `desktop_info` as the Android shell does (Maps without
 * folders, progress files through the system's screens, map pack files
 * copied into the app before they are imported; no import window, no
 * downloads), answers the commands the Android app has with made-up facts,
 * and refuses every desktop-only command, as the Android shell does. It
 * reads and writes no files: the copying, importing and `content://`
 * reading and writing are covered by the shell's own tests. The real
 * Android app is built in CI.
 */

interface Job {
  kind: 'import' | 'copy';
  packId: string;
  title: string;
  entriesDone: number;
  entriesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  cancelling: boolean;
}

export interface AndroidShell {
  calls: { command: string; args: Record<string, unknown> }[];
  /** What the next "Import map pack file…" picks; null closes the picker. */
  pick: { fileName: string; size: number | null } | null;
  /** The copy waits until this is false or it is cancelled. */
  hold: boolean;
  job: Job | null;
  /** Copies made so far, and those discarded. */
  copies: string[];
  discarded: string[];
  /** The demo pack is in the maps folder (after an import). */
  imported: boolean;
  /** Progress files saved through the save screen. */
  saved: { suggestedName: string; contents: string }[];
  /** What the next progress import opens; null closes the picker. */
  open: { name: string; contents: string } | null;
  /** One's own files the next map pack file import gives back. */
  importMine: { ownLists?: string; ownLocations?: string } | null;
}

/** Commands only the desktop shell has, or that need folders: never called on Android. */
export const DESKTOP_ONLY = [
  'library_open_pack',
  'library_add_folder',
  'library_remove_location',
  'library_choose_maps_folder',
  'library_apply_maps_folder',
  'library_reveal',
  'library_delete_images',
  'import_open',
  'packfile_options',
  'packfile_export',
  'packfile_pick',
  'map_picture_pick',
  'own_game_create',
  'own_game_add_map',
  'own_game_add_level',
  'own_game_progress',
  'own_game_cancel',
  'own_game_rename',
  'own_game_delete_map',
  'own_locations_read',
  'own_locations_write',
  'own_locations_delete',
  'own_pages_read',
  'own_pages_write',
  'own_pages_delete',
  'own_notes_read',
  'own_notes_write',
  'own_notes_delete',
];

export function installAndroidShell(desktopOnly: string[]) {
  const shell: AndroidShell = {
    calls: [],
    pick: null,
    hold: false,
    job: null,
    copies: [],
    discarded: [],
    imported: false,
    saved: [],
    open: null,
    importMine: null,
  };
  (window as unknown as { __androidShell: AndroidShell }).__androidShell = shell;
  const demoUrl = new URL('packs/demo/', window.location.href).href;
  const listing = () => ({
    mapsFolder: {
      path: '/data/user/0/dev.atlas.android/no_backup/Maps',
      isDefault: true,
      exists: true,
    },
    packs: shell.imported
      ? [
          {
            id: 'demo',
            title: 'Atlas demo world',
            url: demoUrl,
            origin: 'maps-folder',
            path: '/data/user/0/dev.atlas.android/no_backup/Maps/demo',
            packVersion: '1.0.0',
            // The Android shell lists no packs of its own: the demo comes
            // with the web build.
            bundled: false,
            imported: null,
          },
        ]
      : [],
    hidden: [],
    locations: [],
    busy: [],
  });
  const contents = {
    maps: 2,
    layers: 3,
    locations: 5000,
    categories: 6,
    regions: 4,
    checklists: 1,
    guides: 1,
  };
  const header = {
    format: 'atlas-pack-file',
    version: 1,
    packId: 'demo',
    title: 'Atlas demo world',
    packVersion: '1.0.0',
    detail: 'standard',
    exportedAt: '2026-11-11T09:30:00Z',
    exportedBy: { name: 'Atlas', version: '0.3.6', platform: 'windows' },
    pack: {
      id: 'demo',
      title: 'Atlas demo world',
      packVersion: '1.0.0',
      schemaVersion: 2,
      attribution: [],
    },
    source: { kind: 'app', pages: [] },
    contents,
    images: {
      detail: 'standard',
      files: 340,
      bytes: 2_040_000,
      layers: [
        {
          id: 'demo:layer:world',
          name: 'Surface',
          mapName: 'World',
          minZoom: 0,
          maxZoom: 4,
          levels: [0, 1, 2],
          files: 340,
          bytes: 2_040_000,
          complete: true,
          full: false,
          downloadable: true,
          downloadedAt: '2026-11-02T08:00:00.000Z',
        },
      ],
    },
    files: 348,
    bytes: 2_100_000,
  };
  /** Runs a job that counts up every 50 ms; it ends when done (and not held) or cancelled. */
  const run = <T>(kind: Job['kind'], total: number, done: () => T, cancelled: string) =>
    new Promise<T>((resolve, reject) => {
      shell.job = {
        kind,
        packId: 'demo',
        title: 'Atlas demo world',
        entriesDone: 0,
        entriesTotal: kind === 'copy' ? 0 : total,
        bytesDone: 0,
        bytesTotal: total * 100_000,
        cancelling: false,
      };
      let steps = 0;
      const timer = window.setInterval(() => {
        const job = shell.job!;
        if (job.cancelling) {
          window.clearInterval(timer);
          shell.job = null;
          // Tauri rejects with the command's error value, a string.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(cancelled);
          return;
        }
        steps = Math.min(total, steps + 2);
        if (kind === 'import') job.entriesDone = steps;
        job.bytesDone = steps * 100_000;
        if (steps === total && !shell.hold) {
          window.clearInterval(timer);
          shell.job = null;
          resolve(done());
        }
      }, 50);
    });
  const refuse = (message: string) =>
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    Promise.reject(message);
  const invoke = (command: string, args: Record<string, unknown> = {}) => {
    shell.calls.push({ command, args });
    if (desktopOnly.includes(command)) return refuse('This is not available on this device.');
    switch (command) {
      case 'desktop_info':
        return Promise.resolve({
          name: 'Atlas',
          version: '0.3.6',
          platform: 'android',
          downloads: false,
          folders: false,
          maps: true,
          progressFiles: true,
          imports: false,
          copyPickedFiles: true,
        });
      case 'library_list':
        return Promise.resolve(listing());
      case 'packfile_pick_copy':
        return Promise.resolve(
          shell.pick
            ? {
                ...shell.pick,
                packId: 'demo',
                title: 'Atlas demo world',
                roomNeeded: 2_100_000 * 2 + 64 * 1024 * 1024,
              }
            : null,
        );
      case 'packfile_copy_picked': {
        const name = shell.pick?.fileName ?? 'map-pack.atlaspack';
        return run(
          'copy',
          21,
          () => {
            const path = `/data/user/0/dev.atlas.android/cache/pack-files/${shell.copies.length + 1}/${name}`;
            shell.copies.push(path);
            return path;
          },
          'Cancelled. Nothing was imported.',
        );
      }
      case 'packfile_discard_copy':
        shell.discarded.push(args.path as string);
        return Promise.resolve(null);
      case 'packfile_inspect': {
        const path = args.path as string;
        return Promise.resolve({
          path,
          fileName: path.split('/').pop(),
          size: 2_100_000,
          header,
          installed: shell.imported
            ? {
                title: 'Atlas demo world',
                origin: 'maps-folder',
                folder: '/data/user/0/dev.atlas.android/no_backup/Maps/demo',
                details: null,
              }
            : null,
          replaces: shell.imported,
          blocked: null,
        });
      }
      case 'packfile_import':
        return run(
          'import',
          20,
          () => {
            shell.imported = true;
            return {
              packId: 'demo',
              title: 'Atlas demo world',
              replaced: args.replace as boolean,
              header,
              listing: listing(),
              ...(shell.importMine ?? {}),
            };
          },
          'Cancelled. Nothing was written.',
        );
      case 'packfile_progress':
        return Promise.resolve(shell.job ? { ...shell.job } : null);
      case 'packfile_cancel':
        if (shell.job) shell.job.cancelling = true;
        return Promise.resolve(null);
      case 'library_pack_details':
        if (!shell.imported) return refuse('That game is not in the list any more.');
        return Promise.resolve({
          pack: header.pack,
          source: header.source,
          contents,
          layers: [],
          detail: 'standard',
          imagesAt: '2026-11-02T08:00:00.000Z',
          archive: false,
          packFile: {
            importedAt: '2026-11-11T10:00:00Z',
            fileName: 'demo-standard.atlaspack',
            header,
          },
        });
      case 'library_images_info':
        return Promise.resolve({ files: 340, bytes: 2_040_000, downloading: false });
      case 'library_delete_pack':
        shell.imported = false;
        return Promise.resolve({ complete: true });
      case 'save_text_file':
        shell.saved.push({
          suggestedName: args.suggestedName as string,
          contents: args.contents as string,
        });
        // The name the save screen gave it.
        return Promise.resolve({ name: 'atlas-progress.json' });
      case 'open_text_file':
        return Promise.resolve(shell.open);
      default:
        return refuse(`Unknown command ${command}`);
    }
  };
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
}

export const androidShell = (page: Page) =>
  page.evaluate(() => (window as unknown as { __androidShell: AndroidShell }).__androidShell);

export const setShell = (page: Page, patch: Partial<AndroidShell>) =>
  page.evaluate((patch) => {
    Object.assign((window as unknown as { __androidShell: AndroidShell }).__androidShell, patch);
  }, patch);

/** The commands the page called, in order. */
export async function shellCalls(page: Page): Promise<string[]> {
  return (await androidShell(page)).calls.map((call) => call.command);
}

export async function expectNoDesktopOnlyCalls(page: Page): Promise<void> {
  const called = (await shellCalls(page)).filter((command) => DESKTOP_ONLY.includes(command));
  expect(called).toEqual([]);
}

/**
 * Opens the page as the Android app: the stand-in shell, and an importer
 * in config.json, as a desktop build could have (the Android app still
 * offers no "Add a map").
 */
export async function useAndroidShell(page: Page): Promise<void> {
  await page.route('**/config.json', async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      json: {
        ...config,
        importers: [
          {
            id: 'demo-maps',
            title: 'Demo map site',
            description: 'Reads the made-up demo map site.',
            version: '1.0.0',
            module: 'importers/demo-maps.js',
          },
        ],
      },
    });
  });
  await page.addInitScript(installAndroidShell, DESKTOP_ONLY);
}
