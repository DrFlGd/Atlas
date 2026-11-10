import { packDataSchema, MANIFEST_FILE, PACK_COLLECTIONS, COLLECTION_NAMES } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { packFiles, unrecognisedMessage } from './importing';

describe('import messages', () => {
  it('explains addresses that cannot be imported', () => {
    expect(unrecognisedMessage('ftp://example.com/map', ['Demo'])).toMatch(/starting with https/);
    expect(unrecognisedMessage('https://example.com/map', [])).toMatch(/has no importers/);
    expect(unrecognisedMessage('https://example.com/map', ['Demo', 'Other'])).toBe(
      'None of the importers in this app recognises that address. It can add maps from: Demo, Other.',
    );
  });
});

describe('packFiles', () => {
  it('writes every pack file as JSON that reads back as the same pack', () => {
    const pack = packDataSchema.parse({
      manifest: {
        schemaVersion: 1,
        gameId: 'tiny',
        title: 'Tiny',
        packVersion: '1.0.0',
        gamePatch: '1',
        attribution: [],
        idMigrations: {},
      },
      maps: [],
      layers: [],
      regions: [],
      categoryGroups: [],
      categories: [],
      locations: [],
      entities: [],
      checklists: [],
      checklistItems: [],
      guides: [],
      links: [],
      presets: [],
    });
    const files = packFiles(pack);
    expect(Object.keys(files).sort()).toEqual(
      [MANIFEST_FILE, ...COLLECTION_NAMES.map((name) => PACK_COLLECTIONS[name].file)].sort(),
    );
    const back = Object.fromEntries([
      ['manifest', JSON.parse(files[MANIFEST_FILE]!) as unknown],
      ...COLLECTION_NAMES.map((name) => [
        name,
        JSON.parse(files[PACK_COLLECTIONS[name].file]!) as unknown,
      ]),
    ]) as unknown;
    expect(packDataSchema.parse(back)).toEqual(pack);
  });
});
