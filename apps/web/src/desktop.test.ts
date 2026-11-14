import { describe, expect, it } from 'vitest';
import {
  downloadPercent,
  formatBytes,
  formatDuration,
  roughDuration,
} from './components/downloadFormat';
import { createBridge, desktop, externalLink, packFolderOf } from './desktop';

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
