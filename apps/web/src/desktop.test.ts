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
    await bridge.importWindow.report({ importerId: 'demo-maps', outcome: 'cancelled' });
    await bridge.activityLog.read();
    await bridge.library.reveal({ kind: 'log-folder' });
    await bridge.saves.defaultFolder('witcher3');
    await bridge.saves.chooseFolder('witcher3');
    await bridge.saves.list('C:/Saves');
    await bridge.saves.watch('C:/Saves');
    await bridge.saves.watchStatus();
    await bridge.saves.unwatch();
    await bridge.saves.report({ file: 'QuickSave.sav', ok: true, matched: 2, marked: 1 });
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
      ['import_report', { report: { importerId: 'demo-maps', outcome: 'cancelled' } }],
      ['activity_log_read', undefined],
      ['library_reveal', { target: { kind: 'log-folder' } }],
      ['saves_default_folder', { game: 'witcher3' }],
      ['saves_choose_folder', { game: 'witcher3' }],
      ['saves_list', { folder: 'C:/Saves' }],
      ['saves_watch', { path: 'C:/Saves' }],
      ['saves_watch_status', undefined],
      ['saves_unwatch', undefined],
      ['saves_report', { report: { file: 'QuickSave.sav', ok: true, matched: 2, marked: 1 } }],
    ]);
  });

  it('reads save files as bytes', async () => {
    const answers: unknown[] = [Uint8Array.of(1, 2).buffer, [3, 4], 'text'];
    const bridge = createBridge(() => Promise.resolve(answers.shift()));
    expect(await bridge.saves.read('a.sav')).toEqual(Uint8Array.of(1, 2));
    expect(await bridge.saves.screenshot('a.sav')).toEqual(Uint8Array.of(3, 4));
    await expect(bridge.saves.read('a.sav')).rejects.toThrow('not a file');
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
