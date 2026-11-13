import { describe, expect, it } from 'vitest';
import type { DownloadSnapshot } from '../desktop';
import { followPagePictures, wantPagePictures } from './pagePictures';

const snapshot = (state: DownloadSnapshot['state'], statusRevision: number): DownloadSnapshot =>
  ({ packId: 'wiki', state, statusRevision }) as DownloadSnapshot;

/** A stand-in for the shell's photo download: each start runs through `course`. */
function photos(courses: (DownloadSnapshot | null)[][], refuseStart: number[] = []) {
  let run = -1;
  let step = 0;
  const calls: string[] = [];
  return {
    calls,
    photosStart(): Promise<DownloadSnapshot> {
      calls.push('start');
      run += 1;
      step = 0;
      if (refuseStart.includes(run)) return Promise.reject(new Error('already downloading'));
      return Promise.resolve(courses[run]![step++]!);
    },
    photosSnapshot(): Promise<DownloadSnapshot | null> {
      calls.push('look');
      const course = courses[run] ?? [];
      return Promise.resolve(course[Math.min(step++, course.length - 1)] ?? null);
    },
  };
}

const noWait = () => Promise.resolve();

describe('the pictures of pages just added', () => {
  it('starts the download and shows each picture as it is saved, until it is over', async () => {
    const shell = photos([
      [snapshot('running', 0), snapshot('running', 1), snapshot('running', 1), snapshot('done', 2)],
    ]);
    let shown = 0;
    wantPagePictures('wiki');
    await followPagePictures('wiki', shell, noWait, () => shown++);
    expect(shell.calls).toEqual(['start', 'look', 'look', 'look']);
    // Twice while it ran (the count went up twice), and once at the end.
    expect(shown).toBe(3);
  });

  it('does nothing for a pack nobody asked for', async () => {
    const shell = photos([[snapshot('done', 0)]]);
    await followPagePictures('other', shell, noWait, () => undefined);
    expect(shell.calls).toEqual([]);
  });

  it('fetches what pages added meanwhile list, when the download under way is over', async () => {
    const shell = photos([[snapshot('running', 0), snapshot('done', 1)], [snapshot('done', 2)]]);
    wantPagePictures('wiki');
    let asked = false;
    await followPagePictures(
      'wiki',
      shell,
      () => {
        // A page is added while the first download runs.
        if (!asked) wantPagePictures('wiki');
        asked = true;
        return Promise.resolve();
      },
      () => undefined,
    );
    expect(shell.calls).toEqual(['start', 'look', 'start']);
  });

  it('waits for a download already under way, then starts once more for the new pages', async () => {
    const shell = photos(
      [[snapshot('running', 4), snapshot('done', 5)], [snapshot('done', 6)]],
      [0],
    );
    wantPagePictures('wiki');
    await followPagePictures('wiki', shell, noWait, () => undefined);
    expect(shell.calls).toEqual(['start', 'look', 'look', 'start']);
  });

  it('leaves a paused or stopped download, and a pack with nothing to fetch, alone', async () => {
    for (const state of ['paused', 'stopped'] as const) {
      const shell = photos([[snapshot(state, 1)]], [0]);
      wantPagePictures('wiki');
      await followPagePictures('wiki', shell, noWait, () => undefined);
      expect(shell.calls).toEqual(['start', 'look']);
    }
    const none = photos([[null]], [0]);
    wantPagePictures('wiki');
    await followPagePictures('wiki', none, noWait, () => undefined);
    expect(none.calls).toEqual(['start', 'look']);
  });
});
