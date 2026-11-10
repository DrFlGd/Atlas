import { describe, expect, it } from 'vitest';
import type { ListedPack, Listing } from '../desktop';
import { catalogFrom } from './library';

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
