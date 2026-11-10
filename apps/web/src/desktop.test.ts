import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, downloadPercent } from './components/downloadFormat';
import { createBridge, desktop, packFolderOf } from './desktop';

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
    expect(calls).toEqual([
      ['tiles_start', { packId: 'demo', detail: 'standard' }],
      ['tiles_pause', { packId: 'demo' }],
      ['save_text_file', { suggestedName: 'a.json', contents: '{}' }],
      ['open_external', { url: 'https://example.com/' }],
    ]);
  });

  it('turns command errors into Error objects', async () => {
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
    expect(downloadPercent({ done: 1, total: 3 })).toBe(33);
    expect(downloadPercent({ done: 0, total: 0 })).toBe(100);
  });
});
