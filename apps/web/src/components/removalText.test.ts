import { describe, expect, it } from 'vitest';
import {
  deleteImagesDetails,
  deleteImagesResult,
  deletePackDetails,
  deletePackResult,
  imagesAmount,
  plainError,
} from './removalText';

describe('delete confirmations', () => {
  it('says how many images and roughly how large', () => {
    expect(imagesAmount({ files: 1, bytes: 0 })).toBe('1 map image');
    expect(imagesAmount({ files: 1234, bytes: 45_600_000 })).toBe('1,234 map images (about 46 MB)');
  });

  it('says what deleting a pack removes, and that a download is stopped first', () => {
    expect(deletePackDetails('My Game', null)).toEqual([
      'This removes My Game from the maps folder, with its places, checklists and its downloaded map images. This cannot be undone.',
    ]);
    expect(
      deletePackDetails('My Game', { files: 320, bytes: 2_500_000, downloading: true }),
    ).toEqual([
      'This removes My Game from the maps folder, with its places, checklists and its 320 map images (about 2.5 MB). This cannot be undone.',
      'Its map images are downloading right now. The download is stopped first.',
    ]);
    expect(deletePackDetails('My Game', { files: 0, bytes: 0, downloading: false })[0]).toContain(
      'everything else in its folder',
    );
  });

  it('reports a deleted pack, and files left for the next start', () => {
    expect(deletePackResult('My Game', { complete: true }, false)).toBe(
      'Deleted My Game. Your progress is kept in case you add it again.',
    );
    expect(deletePackResult('My Game', { complete: true }, true)).toBe(
      'Deleted My Game and your progress for it.',
    );
    expect(deletePackResult('My Game', { complete: false }, false)).toMatch(
      /in use by another program, so Atlas removes them the next time it starts\.$/,
    );
  });

  it('says what deleting images removes and what stays', () => {
    expect(deleteImagesDetails('My Game', null)).toEqual(['Counting the downloaded map images…']);
    expect(deleteImagesDetails('My Game', { files: 0, bytes: 0, downloading: false })).toEqual([
      'There are no downloaded map images of My Game to delete.',
    ]);
    const lines = deleteImagesDetails('My Game', {
      files: 12,
      bytes: 840_000,
      downloading: true,
    });
    expect(lines).toEqual([
      'This removes 12 map images (about 840 KB) of My Game from this computer.',
      'My Game itself stays, with its places, checklists and your found marks. You can download the images again later.',
      'The download that is running is stopped first.',
    ]);
    expect(deleteImagesDetails('My Game', { files: 0, bytes: 0, downloading: true })[0]).toBe(
      'A download of My Game has started, but no map images are saved yet.',
    );
  });

  it('reports deleted images, and images still in use', () => {
    expect(deleteImagesResult('My Game', { files: 12, bytes: 840_000, left: 0 })).toBe(
      'Deleted 12 map images (about 840 KB) of My Game.',
    );
    expect(deleteImagesResult('My Game', { files: 0, bytes: 0, left: 0 })).toBe(
      'No map images of My Game needed deleting.',
    );
    expect(deleteImagesResult('My Game', { files: 10, bytes: 1000, left: 1 })).toMatch(
      /1 map image was in use by another program and is still there\./,
    );
    expect(deleteImagesResult('My Game', { files: 10, bytes: 1000, left: 3 })).toMatch(
      /3 map images were in use/,
    );
  });

  it('keeps plain messages and replaces raw system errors', () => {
    const plain = 'Another Atlas window or app is working on this map’s files right now.';
    expect(plainError(new Error(plain), 'delete My Game')).toBe(plain);
    expect(
      plainError(
        new Error('Could not lock the pack folder: Access is denied. (os error 5)'),
        'delete My Game',
      ),
    ).toMatch(/^Atlas could not delete My Game\. Some of its files may be in use/);
    expect(plainError('', 'delete My Game')).toMatch(/^Atlas could not delete My Game/);
  });
});
