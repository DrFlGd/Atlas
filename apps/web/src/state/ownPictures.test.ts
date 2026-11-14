import { describe, expect, it } from 'vitest';
import { pictureTypeOf, picturesInFile } from './ownPictures';

/** Own photos: what a file's bytes are, and the photos an own file names. */

const picture = {
  id: 'demo:picture:own.p1',
  file: 'pictures/own.p1.png',
  shareable: true,
};

describe('own photos', () => {
  it('knows a photo by its first bytes, and nothing else', () => {
    expect(pictureTypeOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(pictureTypeOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('image/png');
    const webp = new Uint8Array([
      ...[0x52, 0x49, 0x46, 0x46],
      ...[0x10, 0, 0, 0],
      ...[0x57, 0x45, 0x42, 0x50],
      ...[0x56, 0x50, 0x38, 0x20],
    ]);
    expect(pictureTypeOf(webp)).toBe('image/webp');
    expect(pictureTypeOf(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBeNull();
    expect(pictureTypeOf(new Uint8Array([]))).toBeNull();
  });

  it('reads the photos an own lists or locations file names, and none from anything else', () => {
    const lists = JSON.stringify({
      format: 'atlas-own-lists',
      version: 1,
      gameId: 'demo',
      updatedAt: '2026-11-12T09:00:00.000Z',
      lists: [
        {
          checklist: { id: 'demo:checklist:own.l', name: 'Mine', order: 0 },
          items: [
            {
              id: 'demo:checkitem:own.i',
              checklistId: 'demo:checklist:own.l',
              name: 'A step',
              order: 0,
              locationIds: [],
              entityIds: [],
              photos: [{ picture: picture.id }],
            },
          ],
          headings: [],
          pictures: [picture],
          createdAt: '2026-11-12T09:00:00.000Z',
          updatedAt: '2026-11-12T09:00:00.000Z',
        },
      ],
    });
    expect(picturesInFile(lists, 'lists')).toEqual([picture]);
    const locations = JSON.stringify({
      format: 'atlas-own-locations',
      version: 1,
      gameId: 'demo',
      updatedAt: '2026-11-12T09:00:00.000Z',
      categoryGroups: [],
      categories: [],
      regions: [],
      locations: [],
      pictures: [picture],
    });
    expect(picturesInFile(locations, 'locations')).toEqual([picture]);
    expect(picturesInFile(null, 'lists')).toEqual([]);
    expect(picturesInFile('not json', 'locations')).toEqual([]);
    expect(picturesInFile(lists, 'locations')).toEqual([]);
    // The photos of one's notes, as the game is deleted with them.
    const notes = JSON.stringify({
      format: 'atlas-own-notes',
      version: 1,
      gameId: 'demo',
      updatedAt: '2026-11-14T10:00:00.000Z',
      notes: {
        'demo:loc:1': {
          text: '',
          name: 'Old well',
          photos: [{ picture: picture.id }],
          updatedAt: '2026-11-14T10:00:00.000Z',
        },
      },
      pictures: [picture],
    });
    expect(picturesInFile(notes, 'notes')).toEqual([picture]);
    expect(picturesInFile(notes, 'lists')).toEqual([]);
  });
});
