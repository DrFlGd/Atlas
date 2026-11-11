import { describe, expect, it } from 'vitest';
import { ALL_ENTRIES, displayTime, filterEntries, logText, parseLogLine } from './activityLog';

const lines = [
  '2026-11-11T09:12:03.123Z [Atlas 0.3.1] app info: Atlas 0.3.1 started on windows',
  '2026-11-11T09:12:04.000Z [Atlas Importer 0.3.1] download warn: HTTP 503 for https://tiles.example.com/1/0/0.png',
  '2026-11-11T09:12:05.000Z [Atlas 0.3.1] download error: Stopped: the server refused access (HTTP 403) | body: <Error>',
  '2026-11-11T09:12:06.000Z [Atlas 0.3.1] library info: Maps library: shown: demo',
  'a line from somewhere else <b>bold</b>',
];

describe('activity log', () => {
  it('parses lines in the log format and keeps others as text', () => {
    const entry = parseLogLine(lines[1] ?? '');
    expect(entry).toEqual({
      line: lines[1],
      time: '2026-11-11T09:12:04.000Z',
      app: 'Atlas Importer 0.3.1',
      area: 'download',
      level: 'warn',
      message: 'HTTP 503 for https://tiles.example.com/1/0/0.png',
    });
    const other = parseLogLine(lines[4] ?? '');
    expect(other.area).toBeNull();
    expect(other.message).toBe('a line from somewhere else <b>bold</b>');
    expect(parseLogLine('2026-11-11T09:12:04.000Z [Atlas 0.3.1] secret info: x').area).toBeNull();
  });

  it('filters by area and by lowest level', () => {
    const entries = lines.map(parseLogLine);
    expect(filterEntries(entries, ALL_ENTRIES)).toHaveLength(5);
    expect(filterEntries(entries, { area: 'download', level: 'info' })).toHaveLength(2);
    expect(filterEntries(entries, { area: 'all', level: 'warn' }).map((e) => e.level)).toEqual([
      'warn',
      'error',
    ]);
    expect(filterEntries(entries, { area: 'download', level: 'error' })).toHaveLength(1);
    expect(filterEntries(entries, { area: 'import', level: 'info' })).toHaveLength(0);
  });

  it('copies the lines exactly as written', () => {
    const entries = filterEntries(lines.map(parseLogLine), { area: 'download', level: 'info' });
    expect(logText(entries)).toBe(`${lines[1]}\n${lines[2]}\n`);
    expect(logText([])).toBe('');
    expect(displayTime('2026-11-11T09:12:04.000Z')).toBe('2026-11-11 09:12:04 UTC');
  });
});
