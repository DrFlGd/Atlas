import { beforeEach, describe, expect, it } from 'vitest';
import type { KeptPackRow, KeptPacksStatus } from '../desktop';
import {
  resetKeptPacks,
  rowDetails,
  statusLine,
  takeKeptPacks,
  useKeptPacks,
  writingText,
} from './keptPacks';
import { useAtlas } from './store';

const row = (state: KeptPackRow['state'], more: Partial<KeptPackRow> = {}): KeptPackRow => ({
  id: 'test-valley',
  title: 'Test Valley',
  state,
  path: null,
  writtenAt: null,
  reason: null,
  extraCopies: [],
  ...more,
});

const status = (more: Partial<KeptPacksStatus> = {}): KeptPacksStatus => ({
  on: true,
  folder: 'Maps and Guides',
  folderIsDefault: false,
  folderChosen: true,
  schedule: 'start',
  running: false,
  writing: null,
  lastCheckAt: null,
  problem: null,
  notice: null,
  games: [],
  serial: 1,
  ...more,
});

describe('kept packs', () => {
  beforeEach(() => {
    resetKeptPacks();
    useAtlas.setState({ notice: null });
  });

  it('say the state in one line', () => {
    expect(statusLine(status({ on: false }))).toBe('Off. No pack files are written.');
    expect(statusLine(status())).toBe('The folder is checked in a moment.');
    expect(statusLine(status({ running: true }))).toBe('Looking through the folder…');
    expect(statusLine(status({ problem: 'The folder cannot be found.' }))).toBe(
      'The folder cannot be found.',
    );
    expect(
      statusLine(
        status({
          games: [
            row('up-to-date'),
            row('up-to-date', { id: 'example-game' }),
            row('not-in-folder', { id: 'example-site' }),
            row('left-out', { id: 'other' }),
          ],
        }),
      ),
    ).toBe('2 up to date, 1 not in the folder.');
    expect(
      statusLine(status({ lastCheckAt: '2026-11-12T10:00:00Z', games: [row('left-out')] })),
    ).toMatch(
      /^No map read from a site on this computer, made in Atlas here or made by Map Maker has a pack to keep\. Last checked /,
    );
  });

  it('say which pack is being written', () => {
    expect(writingText(null)).toBeNull();
    expect(writingText(status())).toBeNull();
    const writing = {
      id: 'test-valley',
      title: 'Test Valley',
      phase: 'writing' as const,
      bytesDone: 500_000,
      bytesTotal: 2_000_000,
      number: 1,
      count: 2,
    };
    expect(writingText(status({ running: true, writing }))).toBe(
      'Writing the pack file of Test Valley (1 of 2), 25% of 2.0 MB.',
    );
    expect(
      writingText(status({ running: true, writing: { ...writing, phase: 'checking', count: 1 } })),
    ).toBe('Checking the pack file of Test Valley, 25%.');
    expect(statusLine(status({ running: true, writing }))).toMatch(/^Writing the pack file/);
  });

  it('say where a pack lies, or why it was not written', () => {
    expect(
      rowDetails(row('up-to-date', { path: 'Maps and Guides/Test Valley.atlaspack' })),
    ).toEqual(['In Maps and Guides/Test Valley.atlaspack.']);
    expect(
      rowDetails(
        row('not-in-folder', {
          path: 'Test Valley.atlaspack',
          reason: 'It is not written again unless you ask.',
        }),
      ),
    ).toEqual(['It was in Test Valley.atlaspack.', 'It is not written again unless you ask.']);
    expect(rowDetails(row('left-out', { reason: 'It comes with the app.' }))).toEqual([
      'It comes with the app.',
    ]);
    expect(rowDetails(row('up-to-date', { extraCopies: ['a.atlaspack', 'b.atlaspack'] }))).toEqual([
      '2 other copies are in the folder and left as they are: a.atlaspack, b.atlaspack.',
    ]);
  });

  it('take only newer states, and show each notice once', () => {
    takeKeptPacks(
      status({ serial: 5, notice: { serial: 4, text: 'The folder cannot be found.' } }),
    );
    expect(useAtlas.getState().notice?.text).toBe('The folder cannot be found.');
    expect(useAtlas.getState().notice?.tone).toBe('error');
    useAtlas.setState({ notice: null });
    takeKeptPacks(status({ serial: 3, on: false }));
    expect(useKeptPacks.getState().status?.serial).toBe(5);
    takeKeptPacks(
      status({ serial: 6, notice: { serial: 4, text: 'The folder cannot be found.' } }),
    );
    expect(useAtlas.getState().notice).toBeNull();
    expect(useKeptPacks.getState().status?.serial).toBe(6);
    // An answer that is not a state is left out.
    takeKeptPacks(null);
    takeKeptPacks({} as KeptPacksStatus);
    expect(useKeptPacks.getState().status?.serial).toBe(6);
  });
});
