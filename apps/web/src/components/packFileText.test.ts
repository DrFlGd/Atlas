import { describe, expect, it } from 'vitest';
import type { PackDetails, PackFileHeader } from '../desktop';
import {
  compareVersions,
  compareWithInstalled,
  contentsText,
  freshnessText,
  imagesDownloadedAt,
  imagesText,
  installedImagesText,
  photosHint,
  sourceText,
} from './packFileText';

const contents = {
  maps: 2,
  layers: 3,
  locations: 120,
  categories: 4,
  regions: 1,
  checklists: 1,
  guides: 0,
};

function header(patch: Partial<PackFileHeader> = {}): PackFileHeader {
  return {
    format: 'atlas-pack-file',
    version: 1,
    packId: 'test-valley',
    title: 'Test Valley',
    packVersion: '1.2.0',
    detail: 'standard',
    exportedAt: '2026-11-10T21:30:00Z',
    exportedBy: { name: 'Atlas', version: '0.4.0', platform: 'linux' },
    pack: {
      id: 'test-valley',
      title: 'Test Valley',
      packVersion: '1.2.0',
      schemaVersion: 2,
      attribution: [],
    },
    source: {
      kind: 'web-pages',
      importer: { id: 'demo-maps', title: 'Demo map site' },
      pages: [{ url: 'https://maps.example.com/demo-maps/test-valley/east-field' }],
      newestPageAt: '2026-11-01T10:00:00.000Z',
      oldestPageAt: '2026-11-01T10:00:00.000Z',
    },
    contents,
    images: {
      detail: 'standard',
      files: 1234,
      bytes: 5_000_000,
      layers: [
        {
          id: 'test-valley:layer:east',
          name: 'Surface',
          mapName: 'East Field',
          minZoom: 0,
          maxZoom: 4,
          levels: [0, 1, 2],
          files: 1000,
          bytes: 4_000_000,
          complete: true,
          full: false,
          downloadable: true,
          downloadedAt: '2026-11-02T08:00:00.000Z',
        },
        {
          id: 'test-valley:layer:west',
          name: 'Surface',
          mapName: 'West Ridge',
          minZoom: 0,
          maxZoom: 4,
          levels: [0, 1, 2],
          files: 234,
          bytes: 1_000_000,
          complete: true,
          full: false,
          downloadable: true,
          downloadedAt: '2026-11-03T08:00:00.000Z',
        },
      ],
    },
    files: 1240,
    bytes: 5_100_000,
    ...patch,
  };
}

function installed(patch: Partial<PackDetails> = {}): PackDetails {
  const file = header();
  return {
    pack: file.pack,
    source: file.source,
    contents,
    layers: [
      {
        id: 'test-valley:layer:east',
        name: 'Surface',
        mapName: 'East Field',
        minZoom: 0,
        maxZoom: 4,
        downloadable: true,
        levels: [0, 1, 2, 3, 4],
        downloadedAt: '2026-11-02T08:00:00.000Z',
      },
    ],
    detail: 'full',
    imagesAt: '2026-11-02T08:00:00.000Z',
    archive: false,
    packFile: null,
    ...patch,
  };
}

const iso = (date: string) => `[${date}]`;

describe('which is newer, a map pack file or the installed game', () => {
  it('goes by when the pages were read first', () => {
    const file = header({ source: { ...header().source, newestPageAt: '2026-11-05T10:00:00Z' } });
    const freshness = compareWithInstalled(file, installed());
    expect(freshness).toMatchObject({ verdict: 'file-newer', basis: 'pages' });
    expect(freshnessText(freshness, iso)).toBe(
      'This file is newer: its data was read from the game’s pages on [2026-11-05T10:00:00Z], the installed game’s on [2026-11-01T10:00:00.000Z].',
    );

    // A newer version does not outweigh older pages.
    const older = header({
      packVersion: '9.0.0',
      source: { ...header().source, newestPageAt: '2026-10-01T10:00:00Z' },
    });
    const verdict = compareWithInstalled(older, installed());
    expect(verdict).toMatchObject({ verdict: 'installed-newer', basis: 'pages' });
    expect(freshnessText(verdict, iso)).toMatch(/^The installed game is newer: its data was read/);
  });

  it('then by pack version', () => {
    const file = header({ packVersion: '1.10.0' });
    const freshness = compareWithInstalled(file, installed());
    expect(freshness).toMatchObject({ verdict: 'file-newer', basis: 'version' });
    expect(freshnessText(freshness, iso)).toBe(
      'This file is newer: it is version 1.10.0 of the game’s pack, the installed game has version 1.2.0.',
    );
    expect(
      freshnessText(compareWithInstalled(header({ packVersion: '1.1.9' }), installed()), iso),
    ).toBe(
      'The installed game is newer: it is version 1.2.0 of the game’s pack, this file has version 1.1.9.',
    );
  });

  it('says when both hold the same data', () => {
    expect(compareWithInstalled(header(), installed())).toEqual({
      verdict: 'same',
      basis: 'same-data',
    });
    const record = {
      importedAt: '2026-11-11T09:00:00Z',
      fileName: 'a.atlaspack',
      header: header(),
    };
    const same = compareWithInstalled(header(), installed({ packFile: record }));
    expect(freshnessText(same)).toBe('The installed game was imported from this same file.');
  });

  it('then by when the file was made, against the installed game’s own dates', () => {
    const bare = { kind: 'app' as const };
    const file = header({ source: bare, exportedAt: '2026-11-04T00:00:00Z' });
    const newer = compareWithInstalled(file, installed({ source: bare }));
    expect(newer).toMatchObject({
      verdict: 'file-newer',
      basis: 'dates',
      installed: '2026-11-02T08:00:00.000Z',
    });
    expect(freshnessText(newer, iso)).toBe(
      'This file is probably newer: it was made on [2026-11-04T00:00:00Z], after the installed game last changed ([2026-11-02T08:00:00.000Z]).',
    );
    const older = compareWithInstalled(
      header({ source: bare, exportedAt: '2026-10-01T00:00:00Z' }),
      installed({ source: bare }),
    );
    expect(freshnessText(older, iso)).toBe(
      'The installed game is probably newer: it last changed on [2026-11-02T08:00:00.000Z], after this file was made ([2026-10-01T00:00:00Z]).',
    );
  });

  it('never guesses a date that is not recorded', () => {
    const bare = { kind: 'unknown' as const };
    const freshness = compareWithInstalled(
      header({ source: bare }),
      installed({ source: bare, imagesAt: null }),
    );
    expect(freshness).toEqual({ verdict: 'unknown' });
    expect(freshnessText(freshness)).toMatch(/cannot tell which is newer/);
  });

  it('orders versions by number', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.0.0-beta', '2.0.0')).toBe(0);
    expect(compareVersions('0.9', '0.9.1')).toBe(-1);
  });
});

describe('map pack file facts in words', () => {
  it('says where the data came from', () => {
    expect(sourceText(header().source)).toBe('Read from 1 web page with Demo map site.');
    expect(sourceText({ kind: 'app' })).toBe('Comes with the Atlas app.');
    expect(sourceText({ kind: 'unknown' })).toBe('Where its data came from is not recorded.');
  });

  it('says how many downloaded photos a file would carry, and to keep such a file', () => {
    expect(photosHint(1, '80 KB')).toMatch(
      /^The 1 photo downloaded for your own use \(.+, 80 KB\)/,
    );
    expect(photosHint(3081, '212 MB')).toContain('The 3,081 photos downloaded');
    expect(photosHint(2, '1 MB')).toContain('Keep a file with them to yourself');
  });

  it('counts the contents and the map images', () => {
    expect(contentsText(contents)).toBe('2 maps, 120 locations, 1 checklist');
    expect(imagesText(header())).toBe('1,234 map images at standard detail.');
    expect(imagesDownloadedAt(header())).toBe('2026-11-03T08:00:00.000Z');
  });

  it('describes an installed game’s map images', () => {
    expect(installedImagesText(installed())).toBe('Downloaded at full detail.');
    expect(installedImagesText(installed({ archive: true }))).toMatch(/one archive file/);
    expect(installedImagesText(installed({ detail: null }))).toBe('Partly downloaded.');
    expect(
      installedImagesText(
        installed({ detail: null, layers: [{ ...installed().layers[0]!, downloadable: false }] }),
      ),
    ).toBe('They come with the game’s pack.');
  });
});
