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
    await bridge.importWindow.open('https://example.com/map', '() => 1');
    await bridge.importWindow.poll();
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
      ['import_open', { url: 'https://example.com/map', reader: '() => 1' }],
      ['import_poll', undefined],
    ]);
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
