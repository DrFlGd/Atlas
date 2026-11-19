import { describe, expect, it } from 'vitest';
import {
  downloadPercent,
  formatBytes,
  formatDuration,
  roughDuration,
} from './components/downloadFormat';
import {
  createBridge,
  desktop,
  eventListener,
  externalLink,
  packFolderOf,
  type Listing,
} from './desktop';

describe('desktop bridge', () => {
  it('is absent in a browser', () => {
    expect(desktop).toBeNull();
  });

  it('finds the pack folder on the pack protocol only', () => {
    expect(packFolderOf('atlas-pack://localhost/demo/')).toBe('demo');
    expect(packFolderOf('http://atlas-pack.localhost/my-game_2/')).toBe('my-game_2');
    expect(packFolderOf('http://localhost:5173/packs/demo/')).toBeNull();
    expect(packFolderOf('https://atlas-pack.localhost/demo/')).toBeNull();
    expect(packFolderOf('atlas-pack://localhost/demo/tiles/')).toBeNull();
    expect(packFolderOf('atlas-pack://localhost/../')).toBeNull();
  });

  it('keeps own lists and list files through the shell commands', async () => {
    const calls: [string, unknown][] = [];
    const bridge = createBridge((command, args) => {
      calls.push([command, args]);
      return Promise.resolve(null);
    });
    await bridge.ownLists.read('demo');
    await bridge.ownLists.write('demo', '{}');
    await bridge.ownLists.write('demo', '{}', '2026-11-13T10:00:00Z');
    await bridge.ownLists.delete('demo');
    await bridge.listFiles.save('Flame build.atlaslist', '{}');
    await bridge.listFiles.open();
    await bridge.guideLinks.read('demo');
    await bridge.guideLinks.write('demo', '{}', '2026-11-13T10:00:00Z');
    expect(calls).toEqual([
      ['own_lists_read', { gameId: 'demo' }],
      ['own_lists_write', { gameId: 'demo', contents: '{}', keepCopy: null }],
      ['own_lists_write', { gameId: 'demo', contents: '{}', keepCopy: '2026-11-13T10:00:00Z' }],
      ['own_lists_delete', { gameId: 'demo' }],
      ['list_file_save', { suggestedName: 'Flame build.atlaslist', contents: '{}' }],
      ['list_file_open', undefined],
      ['guide_links_read', { gameId: 'demo' }],
      ['guide_links_write', { gameId: 'demo', contents: '{}', keepCopy: '2026-11-13T10:00:00Z' }],
    ]);
  });

  it('makes games from pictures and keeps own locations through the shell commands', async () => {
    const calls: [string, unknown][] = [];
    const bridge = createBridge((command, args) => {
      calls.push([command, args]);
      return Promise.resolve(null);
    });
    await bridge.ownLocations.read('demo');
    await bridge.ownLocations.write('demo', '{}');
    await bridge.ownLocations.delete('demo');
    await bridge.ownPages.read('demo');
    await bridge.ownPages.write('demo', '{}', '2026-11-13T10:00:00Z');
    await bridge.ownPages.delete('demo');
    await bridge.ownNotes.read('demo');
    await bridge.ownNotes.write('demo', '{}', '2026-11-14T10:00:00Z');
    await bridge.ownNotes.delete('demo');
    await bridge.gameGroups.read();
    await bridge.gameGroups.write('{}');
    await bridge.gameGroups.write('{}', '2026-11-14T10:00:00Z');
    await bridge.ownGames.pickPicture();
    await bridge.ownGames.create('Cloud Isles', 'Harbour', '/pictures/harbour.png');
    await bridge.ownGames.addMap('cloud-isles', 'Caves', '/pictures/caves.webp');
    await bridge.ownGames.addLevel('cloud-isles', 'cloud-isles:map:caves', 'Deep', '/p/deep.jpg');
    await bridge.ownGames.progress();
    await bridge.ownGames.cancel();
    await bridge.ownGames.rename('cloud-isles', 'Cloud Isles II');
    await bridge.ownGames.deleteMap('cloud-isles', 'cloud-isles:map:caves');
    await bridge.packFiles.export('cloud-isles', 'full', undefined, true);
    await bridge.packFiles.export('cloud-isles', 'full');
    await bridge.packFiles.export('cloud-isles', 'full', undefined, false, false, true);
    expect(calls).toEqual([
      ['own_locations_read', { gameId: 'demo' }],
      ['own_locations_write', { gameId: 'demo', contents: '{}', keepCopy: null }],
      ['own_locations_delete', { gameId: 'demo' }],
      ['own_pages_read', { gameId: 'demo' }],
      ['own_pages_write', { gameId: 'demo', contents: '{}', keepCopy: '2026-11-13T10:00:00Z' }],
      ['own_pages_delete', { gameId: 'demo' }],
      ['own_notes_read', { gameId: 'demo' }],
      ['own_notes_write', { gameId: 'demo', contents: '{}', keepCopy: '2026-11-14T10:00:00Z' }],
      ['own_notes_delete', { gameId: 'demo' }],
      ['game_groups_read', undefined],
      ['game_groups_write', { contents: '{}', keepCopy: null }],
      ['game_groups_write', { contents: '{}', keepCopy: '2026-11-14T10:00:00Z' }],
      ['map_picture_pick', undefined],
      [
        'own_game_create',
        { title: 'Cloud Isles', mapName: 'Harbour', picture: '/pictures/harbour.png' },
      ],
      [
        'own_game_add_map',
        { gameId: 'cloud-isles', mapName: 'Caves', picture: '/pictures/caves.webp' },
      ],
      [
        'own_game_add_level',
        {
          gameId: 'cloud-isles',
          mapId: 'cloud-isles:map:caves',
          levelName: 'Deep',
          picture: '/p/deep.jpg',
        },
      ],
      ['own_game_progress', undefined],
      ['own_game_cancel', undefined],
      ['own_game_rename', { gameId: 'cloud-isles', title: 'Cloud Isles II' }],
      ['own_game_delete_map', { gameId: 'cloud-isles', mapId: 'cloud-isles:map:caves' }],
      [
        'packfile_export',
        {
          id: 'cloud-isles',
          detail: 'full',
          progress: null,
          includeMine: true,
          includePhotos: false,
          smallerPictures: false,
        },
      ],
      [
        'packfile_export',
        {
          id: 'cloud-isles',
          detail: 'full',
          progress: null,
          includeMine: false,
          includePhotos: false,
          smallerPictures: false,
        },
      ],
      [
        'packfile_export',
        {
          id: 'cloud-isles',
          detail: 'full',
          progress: null,
          includeMine: false,
          includePhotos: false,
          smallerPictures: true,
        },
      ],
    ]);
  });

  it('measures a picture with the shell commands of a build with downloads', async () => {
    const calls: [string, unknown][] = [];
    const bridge = createBridge((command, args) => {
      calls.push([command, args]);
      return Promise.resolve(null);
    });
    const request = {
      urlTemplate: 'https://tiles.example/{z}/{x}/{y}.png',
      zoom: 9,
      start: [3, 4],
    };
    await bridge.tiles.pictureTiles({ ...request, start: [3, 4], cachedOnly: true });
    await bridge.tiles.cancelPicture();
    expect(calls).toEqual([
      ['picture_tiles', { request: { ...request, cachedOnly: true } }],
      ['picture_cancel', undefined],
    ]);
  });

  it('reads a page for an importer with the shell command of a build with downloads', async () => {
    const calls: [string, unknown][] = [];
    const bridge = createBridge((command, args) => {
      calls.push([command, args]);
      return Promise.resolve(null);
    });
    await bridge.tiles.fetchPage('https://wiki.example.org/wiki/Start');
    expect(calls).toEqual([['import_fetch', { url: 'https://wiki.example.org/wiki/Start' }]]);
  });

  it('keeps packs up to date with the shell commands of a build with downloads', async () => {
    const calls: [string, unknown][] = [];
    const heard: string[] = [];
    const bridge = createBridge(
      (command, args) => {
        calls.push([command, args]);
        return Promise.resolve(null);
      },
      (event, handler) => {
        heard.push(event);
        handler({ serial: 1 });
        return Promise.resolve(() => undefined);
      },
    );
    await bridge.keptPacks.status();
    await bridge.keptPacks.chooseFolder();
    await bridge.keptPacks.set(true, 'weekly');
    await bridge.keptPacks.writeAll();
    await bridge.keptPacks.writeAgain('test-valley');
    await bridge.keptPacks.cancel();
    await bridge.keptPacks.reveal();
    expect(calls).toEqual([
      ['kept_packs_status', undefined],
      ['kept_packs_choose_folder', undefined],
      ['kept_packs_set', { choice: { on: true, schedule: 'weekly' } }],
      ['kept_packs_write_all', undefined],
      ['kept_packs_write_again', { id: 'test-valley' }],
      ['kept_packs_cancel', undefined],
      ['kept_packs_reveal', undefined],
    ]);
    const statuses: unknown[] = [];
    await bridge.events.keptPacksChanged((status) => statuses.push(status));
    expect(heard).toEqual(['kept-packs-changed']);
    expect(statuses).toEqual([{ serial: 1 }]);
  });

  it('calls the shell commands with their arguments', async () => {
    const calls: [string, unknown][] = [];
    const bridge = createBridge((command, args) => {
      calls.push([command, args]);
      return Promise.resolve(null);
    });
    await bridge.tiles.start('demo', 'standard');
    await bridge.tiles.pause('demo');
    await bridge.saveTextFile('a.json', '{}');
    await bridge.openExternal('https://example.com/');
    await bridge.tiles.setSettings({
      parallel: 2,
      pauseMs: 250,
      requestsPerMinute: null,
      kilobytesPerSecond: 500,
    });
    await bridge.library.reveal({ kind: 'pack', id: 'demo' });
    await bridge.library.applyMapsFolder(true);
    await bridge.library.importSources('demo', 'demo-maps');
    await bridge.library.importSourceList('demo', 'demo-maps');
    await bridge.library.importSource('demo', 'demo-maps', 'east-field');
    await bridge.library.styles('example-wiki');
    await bridge.library.keepStyles('example-wiki', {
      way: 'window',
      sheets: [{ text: '.box { float: right; }', mark: '22-x' }],
      leftOut: [{ address: 'https://files.example.net/a.css', reason: 'other-address' }],
    });
    await bridge.library.imagesInfo('my-game');
    await bridge.library.deleteImages('my-game');
    await bridge.library.deletePack('my-game');
    await bridge.importWindow.open('https://example.com/map', '() => 1');
    await bridge.importWindow.poll();
    await bridge.importWindow.open('https://example.com/map', '() => 1', {
      id: 'demo-maps',
      waitSeconds: 30,
    });
    await bridge.importWindow.open(
      'https://example.com/game',
      '() => 2',
      { id: 'demo-maps', waitSeconds: 30 },
      'game',
    );
    await bridge.importWindow.open(
      'https://example.com/map',
      '() => 1',
      { id: 'demo-maps', waitSeconds: 30 },
      'map',
      '(state) => ({ done: true })',
    );
    await bridge.importWindow.open(
      'https://wiki.example.org/wiki/A',
      '() => 3',
      { id: 'example-wiki', waitSeconds: 60 },
      'map',
      undefined,
      true,
    );
    await bridge.importWindow.navigate('https://wiki.example.org/wiki/B', '() => 3', {
      id: 'example-wiki',
      waitSeconds: 60,
    });
    await bridge.importWindow.runOnce('(marks) => ({ sheets: [] })', ['22-x']);
    await bridge.importWindow.report({ importerId: 'demo-maps', outcome: 'cancelled' });
    await bridge.activityLog.read();
    await bridge.library.reveal({ kind: 'log-folder' });
    await bridge.packFiles.pickCopy();
    await bridge.packFiles.copyPicked();
    await bridge.packFiles.discardCopy('/cache/pack-files/1/game.atlaspack');
    await bridge.saves.defaultFolder('witcher3');
    await bridge.saves.chooseFolder('witcher3');
    await bridge.saves.list('C:/Saves');
    await bridge.saves.watch('C:/Saves');
    await bridge.saves.watchStatus();
    await bridge.saves.unwatch();
    await bridge.saves.report({ file: 'QuickSave.sav', ok: true, matched: 2, marked: 1 });
    await bridge.gameFiles.folder('witcher3');
    await bridge.gameFiles.chooseFolder('witcher3');
    await bridge.gameFiles.forgetFolder('witcher3');
    await bridge.gameFiles.scan('witcher3');
    await bridge.gameFiles.report({ kind: 'match', saveTags: 3, saveTagsFound: 2, fits: {} });
    expect(calls).toEqual([
      ['tiles_start', { packId: 'demo', detail: 'standard' }],
      ['tiles_pause', { packId: 'demo' }],
      ['save_text_file', { suggestedName: 'a.json', contents: '{}' }],
      ['open_external', { url: 'https://example.com/' }],
      [
        'download_settings_set',
        {
          settings: { parallel: 2, pauseMs: 250, requestsPerMinute: null, kilobytesPerSecond: 500 },
        },
      ],
      ['library_reveal', { target: { kind: 'pack', id: 'demo' } }],
      ['library_apply_maps_folder', { movePacks: true }],
      ['library_import_sources', { packId: 'demo', importerId: 'demo-maps' }],
      ['library_import_source_list', { packId: 'demo', importerId: 'demo-maps' }],
      ['library_import_source', { packId: 'demo', importerId: 'demo-maps', key: 'east-field' }],
      ['library_styles', { packId: 'example-wiki' }],
      [
        'library_keep_styles',
        {
          packId: 'example-wiki',
          request: {
            way: 'window',
            sheets: [{ text: '.box { float: right; }', mark: '22-x' }],
            leftOut: [{ address: 'https://files.example.net/a.css', reason: 'other-address' }],
          },
        },
      ],
      ['library_images_info', { id: 'my-game' }],
      ['library_delete_images', { id: 'my-game' }],
      ['library_delete_pack', { id: 'my-game' }],
      ['import_open', { url: 'https://example.com/map', reader: '() => 1' }],
      ['import_poll', undefined],
      [
        'import_open',
        {
          url: 'https://example.com/map',
          reader: '() => 1',
          importerId: 'demo-maps',
          waitSeconds: 30,
        },
      ],
      [
        'import_open',
        {
          url: 'https://example.com/game',
          reader: '() => 2',
          importerId: 'demo-maps',
          waitSeconds: 30,
          purpose: 'game',
        },
      ],
      [
        'import_open',
        {
          url: 'https://example.com/map',
          reader: '() => 1',
          importerId: 'demo-maps',
          waitSeconds: 30,
          measure: '(state) => ({ done: true })',
        },
      ],
      [
        'import_open',
        {
          url: 'https://wiki.example.org/wiki/A',
          reader: '() => 3',
          importerId: 'example-wiki',
          waitSeconds: 60,
          keep: true,
        },
      ],
      [
        'import_navigate',
        {
          url: 'https://wiki.example.org/wiki/B',
          reader: '() => 3',
          importerId: 'example-wiki',
          waitSeconds: 60,
        },
      ],
      ['import_run_once', { script: '(marks) => ({ sheets: [] })', argument: ['22-x'] }],
      ['import_report', { report: { importerId: 'demo-maps', outcome: 'cancelled' } }],
      ['activity_log_read', undefined],
      ['library_reveal', { target: { kind: 'log-folder' } }],
      ['packfile_pick_copy', undefined],
      ['packfile_copy_picked', undefined],
      ['packfile_discard_copy', { path: '/cache/pack-files/1/game.atlaspack' }],
      ['saves_default_folder', { game: 'witcher3' }],
      ['saves_choose_folder', { game: 'witcher3' }],
      ['saves_list', { folder: 'C:/Saves' }],
      ['saves_watch', { path: 'C:/Saves' }],
      ['saves_watch_status', undefined],
      ['saves_unwatch', undefined],
      ['saves_report', { report: { file: 'QuickSave.sav', ok: true, matched: 2, marked: 1 } }],
      ['game_folder_get', { game: 'witcher3' }],
      ['game_folder_choose', { game: 'witcher3' }],
      ['game_folder_forget', { game: 'witcher3' }],
      ['game_files_scan', { game: 'witcher3' }],
      ['game_files_report', { report: { kind: 'match', saveTags: 3, saveTagsFound: 2, fits: {} } }],
    ]);
  });

  it('reads save files as bytes', async () => {
    const answers: unknown[] = [Uint8Array.of(1, 2).buffer, [3, 4], 'text'];
    const bridge = createBridge(() => Promise.resolve(answers.shift()));
    expect(await bridge.saves.read('a.sav')).toEqual(Uint8Array.of(1, 2));
    expect(await bridge.saves.screenshot('a.sav')).toEqual(Uint8Array.of(3, 4));
    await expect(bridge.saves.read('a.sav')).rejects.toThrow('not a file');
  });

  it('reads the game’s map files as bytes', async () => {
    const calls: unknown[] = [];
    const bridge = createBridge((command, args) => {
      calls.push([command, args]);
      return Promise.resolve(Uint8Array.of(0x43, 0x52, 0x32, 0x57).buffer);
    });
    expect(await bridge.gameFiles.read('witcher3', 4)).toEqual(
      Uint8Array.of(0x43, 0x52, 0x32, 0x57),
    );
    expect(calls).toEqual([['game_files_read', { game: 'witcher3', index: 4 }]]);
  });

  it('sends only links to other web sites outside', () => {
    expect(externalLink('https://example.com/guide', 'tauri://localhost/')).toBe(
      'https://example.com/guide',
    );
    expect(externalLink('http://example.com/', 'http://tauri.localhost/')).toBe(
      'http://example.com/',
    );
    expect(externalLink('http://tauri.localhost/#@1,2,3', 'http://tauri.localhost/')).toBeNull();
    expect(externalLink('#@1,2,3', 'tauri://localhost/')).toBeNull();
    expect(externalLink('mailto:someone@example.com', 'tauri://localhost/')).toBeNull();
    expect(externalLink('javascript:alert(1)', 'tauri://localhost/')).toBeNull();
    expect(externalLink('atlas-pack://localhost/demo/x', 'tauri://localhost/')).toBeNull();
  });

  it('turns command errors into Error objects', async () => {
    // Tauri rejects with the command's error value, here a string.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const bridge = createBridge(() => Promise.reject('This pack is not downloading.'));
    await expect(bridge.tiles.resume('demo')).rejects.toThrow('This pack is not downloading.');
  });
});

describe('pack files that arrive', () => {
  it('takes what opening pack files came to, and takes one off the list', async () => {
    const calls: [string, unknown][] = [];
    const bridge = createBridge((command, args) => {
      calls.push([command, args]);
      return Promise.resolve(command === 'library_take_opened' ? [] : null);
    });
    expect(await bridge.library.takeOpened()).toEqual([]);
    await bridge.library.forgetPackFile('/files/example.atlaspack');
    expect(calls).toEqual([
      ['library_take_opened', undefined],
      ['library_forget_pack_file', { path: '/files/example.atlaspack' }],
    ]);
  });

  it('takes nothing from a shell without the command', async () => {
    const bridge = createBridge(() => Promise.reject(new Error('Command not found.')));
    expect(await bridge.library.takeOpened()).toEqual([]);
  });

  it('takes nothing from an answer that is not a list, and only whole entries from one that is', async () => {
    const opened = {
      path: '/files/example.atlaspack',
      show: 'test-valley',
      remembered: true,
      problem: false,
      message: 'Showing Test Valley from example.atlaspack.',
    };
    for (const answer of [null, undefined, 'none', 3, { length: 1 }]) {
      const bridge = createBridge(() => Promise.resolve(answer));
      expect(await bridge.library.takeOpened()).toEqual([]);
    }
    const bridge = createBridge(() =>
      Promise.resolve([opened, null, 'text', { ...opened, show: 4 }, { path: '/files/x' }]),
    );
    expect(await bridge.library.takeOpened()).toEqual([opened]);
  });

  it('hears the two events of the shell, with their payload', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const stopped: string[] = [];
    const bridge = createBridge(
      () => Promise.resolve(null),
      (event, handler) => {
        handlers.set(event, handler);
        return Promise.resolve(() => {
          stopped.push(event);
        });
      },
    );
    const listings: Listing[] = [];
    let opened = 0;
    const stopChanged = await bridge.events.libraryChanged((listing) => listings.push(listing));
    const stopOpened = await bridge.events.packFileOpened(() => {
      opened += 1;
    });
    expect([...handlers.keys()]).toEqual(['library-changed', 'pack-file-opened']);
    const listing = { packs: [], serial: 4 } as unknown as Listing;
    handlers.get('library-changed')!(listing);
    handlers.get('pack-file-opened')!(null);
    expect(listings).toEqual([listing]);
    expect(opened).toBe(1);
    stopChanged();
    stopOpened();
    expect(stopped).toEqual(['library-changed', 'pack-file-opened']);
  });

  it('hears nothing without events, as in a browser', async () => {
    const bridge = createBridge(() => Promise.resolve(null));
    const stop = await bridge.events.libraryChanged(() => {
      throw new Error('Nothing comes without events.');
    });
    stop();
  });

  it('listens as the shell event plugin expects, and stops listening', async () => {
    const calls: [string, unknown][] = [];
    const callbacks: ((message: { event: string; id: number; payload: unknown }) => void)[] = [];
    const internals = {
      invoke: null,
      transformCallback(
        callback: (message: { event: string; id: number; payload: unknown }) => void,
      ) {
        // Tauri's own registers it on itself.
        expect(this).toBe(internals);
        callbacks.push(callback);
        return 41;
      },
    };
    const unregistered: [string, unknown][] = [];
    (globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (event: string, id: unknown) => unregistered.push([event, id]),
    };
    try {
      const listen = eventListener(internals, (command, args) => {
        calls.push([command, args]);
        return Promise.resolve(command === 'plugin:event|listen' ? 7 : null);
      });
      const payloads: unknown[] = [];
      const stop = await listen('library-changed', (payload) => payloads.push(payload));
      expect(calls).toEqual([
        ['plugin:event|listen', { event: 'library-changed', target: { kind: 'Any' }, handler: 41 }],
      ]);
      callbacks[0]!({ event: 'library-changed', id: 7, payload: { serial: 2 } });
      expect(payloads).toEqual([{ serial: 2 }]);
      stop();
      expect(unregistered).toEqual([['library-changed', 7]]);
      expect(calls[1]).toEqual(['plugin:event|unlisten', { event: 'library-changed', eventId: 7 }]);
    } finally {
      delete (globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
    }
  });

  it('hears nothing where the shell cannot register a callback', async () => {
    const listen = eventListener({}, () => Promise.reject(new Error('Not called.')));
    const stop = await listen('library-changed', () => undefined);
    stop();
  });
});

describe('download figures', () => {
  it('formats sizes, durations and percentages', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(48_000)).toBe('48 KB');
    expect(formatBytes(3_400_000)).toBe('3.4 MB');
    expect(formatBytes(2_100_000_000)).toBe('2.1 GB');
    expect(formatDuration(20)).toBe('less than a minute');
    expect(formatDuration(600)).toBe('10 min');
    expect(formatDuration(3 * 3600 + 120)).toBe('3 h 2 min');
    expect(formatDuration(50 * 3600)).toBe('2 days 2 h');
    expect(roughDuration(20)).toBe('less than a minute');
    expect(roughDuration(600)).toBe('about 10 min');
    expect(downloadPercent({ done: 1, total: 3 })).toBe(33);
    expect(downloadPercent({ done: 0, total: 0 })).toBe(100);
  });
});

describe('old folders', () => {
  it('lists, measures and removes old folders through their commands', async () => {
    const calls: [string, unknown][] = [];
    const bridge = createBridge((command, args) => {
      calls.push([command, args]);
      return Promise.resolve(null);
    });
    await bridge.library.oldFolders();
    await bridge.library.oldFolderSize('Test Valley');
    await bridge.library.removeOldFolders([{ folder: 'Test Valley', id: 'test-valley' }]);
    expect(calls).toEqual([
      ['library_old_folders', undefined],
      ['library_old_folder_size', { folder: 'Test Valley' }],
      ['library_remove_old_folders', { folders: [{ folder: 'Test Valley', id: 'test-valley' }] }],
    ]);
  });
});
