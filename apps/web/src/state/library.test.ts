import { describe, expect, it } from 'vitest';
import type { ListedPack, Listing } from '../desktop';
import { catalogFrom, goneText, olderListing, openedOutcome } from './library';

const listed = (id: string, title: string, extra: Partial<ListedPack> = {}): ListedPack => ({
  id,
  title,
  url: `atlas-pack://localhost/${id}/`,
  origin: 'maps-folder',
  path: `/maps/${id}`,
  packVersion: '1.0.0',
  bundled: false,
  imported: null,
  ...extra,
});

const listing = (packs: ListedPack[]): Listing => ({
  mapsFolder: { path: '/maps', isDefault: true, exists: true },
  packs,
  hidden: [],
  locations: [],
  busy: [],
});

describe('catalogFrom', () => {
  const bundled = [
    { id: 'demo', url: 'atlas-pack://localhost/demo/', title: 'Demo' },
    { id: 'big', url: 'atlas-pack://localhost/big/', title: 'Big game' },
  ];

  it('keeps the bundled packs without a listing', () => {
    expect(catalogFrom(bundled, null)).toEqual(bundled);
  });

  it('lists bundled packs first, then the others by title', () => {
    const catalog = catalogFrom(
      bundled,
      listing([
        listed('zeta', 'Zeta'),
        listed('big', 'Big game (installed)', { bundled: true }),
        listed('alpha', 'Alpha', { origin: 'location', path: '/usb/alpha' }),
      ]),
    );
    expect(catalog.map((p) => [p.id, p.title])).toEqual([
      ['demo', 'Demo'],
      ['big', 'Big game (installed)'],
      ['alpha', 'Alpha'],
      ['zeta', 'Zeta'],
    ]);
    // Only the fields a pack entry has.
    expect(Object.keys(catalog[2]!).sort()).toEqual(['id', 'title', 'url']);
  });
});

describe('listings that arrive', () => {
  const numbered = (serial: number | undefined): Listing => ({ ...listing([]), serial });

  it('leaves out one older than the listing taken, and never one without a number', () => {
    expect(olderListing(numbered(2), numbered(3))).toBe(true);
    expect(olderListing(numbered(3), numbered(3))).toBe(false);
    expect(olderListing(numbered(4), numbered(3))).toBe(false);
    expect(olderListing(numbered(undefined), numbered(3))).toBe(false);
    expect(olderListing(numbered(1), numbered(undefined))).toBe(false);
    expect(olderListing(numbered(1), null)).toBe(false);
  });
});

describe('what is said when the game shown went', () => {
  const file = listed('example-game', 'Example Game', {
    origin: 'opened-file',
    path: '/files/example.atlaspack',
    packFile: true,
  });

  it('for a pack file that cannot be found', () => {
    expect(goneText('Example Game', file, listing([]), 'Demo')).toBe(
      'The pack file of Example Game cannot be found any more. It may have been moved, renamed or deleted, or be on a drive that is not connected, so Example Game is not shown.',
    );
  });

  it('for a pack file that can no longer be read, with the reason', () => {
    const now = {
      ...listing([]),
      unreadable: [{ path: '/files/example.atlaspack', reason: 'Its contents are damaged.' }],
    };
    expect(goneText('Example Game', file, now, 'Demo')).toBe(
      'The pack file of Example Game can no longer be read, so it is not shown. Its contents are damaged.',
    );
  });

  it('for a game in a folder', () => {
    expect(
      goneText('Example Game', listed('example-game', 'Example Game'), listing([]), 'Demo'),
    ).toBe('Example Game is no longer available, so Demo is shown.');
    expect(goneText('Example Game', undefined, listing([]), 'Demo')).toBe(
      'Example Game is no longer available, so Demo is shown.',
    );
  });
});

describe('what opening pack files from the file manager came to', () => {
  const opened = (show: string | null, message: string, problem = false) => ({
    path: '/files/example.atlaspack',
    show,
    remembered: true,
    problem,
    message,
  });

  it('is nothing when none was opened', () => {
    expect(openedOutcome([])).toBeNull();
  });

  it('shows the last one and says how many came before it', () => {
    expect(openedOutcome([opened('a', 'A.')])).toEqual({ show: 'a', text: 'A.', problem: false });
    expect(
      openedOutcome([opened('a', 'A.'), opened('b', 'B.'), opened(null, 'C went wrong.', true)]),
    ).toEqual({
      show: null,
      text: 'C went wrong. 2 more pack files were opened before it.',
      problem: true,
    });
  });
});
