import { describe, expect, it } from 'vitest';
import type { Listing, OldFolder, OldFoldersRemoved } from '../desktop';
import { afterText, confirmText, namesText, removedText, sizeText } from './oldFolders';

const folder = (name: string, title: string, packFile: string | null = null): OldFolder => ({
  folder: name,
  path: `maps/${name}`,
  id: name,
  title,
  packFile,
});

describe('old folders', () => {
  it('name a few folders, and count the rest', () => {
    expect(namesText([])).toBe('');
    expect(namesText(['Test Valley'])).toBe('Test Valley');
    expect(namesText(['Test Valley', 'Example Game'])).toBe('Test Valley and Example Game');
    expect(namesText(['A', 'B', 'C', 'D', 'E', 'F'])).toBe('A, B, C, D, E and F');
    expect(namesText(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])).toBe('A, B, C, D, E and 3 more');
  });

  it('say a size as far as it is measured', () => {
    expect(sizeText(undefined)).toBe('measuring…');
    expect(sizeText({ bytes: 1_500_000, files: 3, complete: true })).toBe('1.5 MB');
    expect(sizeText({ bytes: 1_500_000, files: 3, complete: false })).toBe('at least 1.5 MB');
  });

  it('ask which folders go, how many and how much room they take', () => {
    const valley = folder('test-valley', 'Test Valley');
    const game = folder('example-game', 'Example Game');
    expect(confirmText([valley], {})).toBe(
      'Remove the folder of Test Valley from the maps folder? Its size is still being measured.',
    );
    expect(
      confirmText([valley], { 'test-valley': { bytes: 2_000_000, files: 4, complete: true } }),
    ).toBe('Remove the folder of Test Valley from the maps folder? It takes 2.0 MB.');
    expect(
      confirmText([valley, game], {
        'test-valley': { bytes: 2_000_000, files: 4, complete: true },
      }),
    ).toBe(
      'Remove 2 folders from the maps folder: Test Valley and Example Game? Together they take at least 2.0 MB; the size of 1 of them is still being measured.',
    );
    expect(
      confirmText([valley, game], {
        'test-valley': { bytes: 2_000_000, files: 4, complete: true },
        'example-game': { bytes: 3_000_000, files: 4, complete: false },
      }),
    ).toBe(
      'Remove 2 folders from the maps folder: Test Valley and Example Game? Together they take at least 5.0 MB.',
    );
  });

  it('say what becomes of the games', () => {
    const shown = folder('test-valley', 'Test Valley', 'packs/test-valley.atlaspack');
    const gone = folder('example-game', 'Example Game');
    expect(afterText([shown])).toBe('The game is then shown from its pack file.');
    expect(afterText([gone])).toBe(
      'No pack file of this game is there, so it is then no longer in the Library.',
    );
    expect(afterText([shown, shown])).toBe('Each game is then shown from its pack file.');
    expect(afterText([gone, gone])).toBe(
      'No pack file of these games is there, so they are then no longer in the Library.',
    );
    expect(afterText([shown, gone, gone])).toBe(
      '1 of them is then shown from its pack file; the other 2 are no longer in the Library.',
    );
    expect(afterText([shown, shown, gone])).toBe(
      '2 of them are then shown from their pack files; the other one is no longer in the Library.',
    );
  });

  it('say what a removal came to', () => {
    const listing = {} as Listing;
    const result = (removed: OldFoldersRemoved['removed']): OldFoldersRemoved => ({
      removed,
      listing,
    });
    const one = { folder: 'a', id: 'a', removed: true, complete: true, problem: null };
    expect(removedText(result([one]))).toBe('Removed 1 folder.');
    expect(removedText(result([one, { ...one, folder: 'b', complete: false }]))).toBe(
      'Removed 2 folders. Some files of one of them were in use; they are removed when Atlas next starts.',
    );
    expect(
      removedText(
        result([
          one,
          { ...one, folder: 'b', removed: false, problem: 'A download of this game is running.' },
        ]),
      ),
    ).toBe('Removed 1 folder. 1 folder was not removed. A download of this game is running.');
  });
});
