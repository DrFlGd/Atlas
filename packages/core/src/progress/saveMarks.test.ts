import { describe, expect, it } from 'vitest';
import { makeTestPack } from '../testing/packs';
import { progressRow, resolveProgress } from './resolve';
import { targetsMarkedFromSaves, targetsToMarkFromSave } from './saveMarks';

describe('marks from a save', () => {
  it('marks only targets that are not found and not set by hand', () => {
    const rows = [
      progressRow('p', 'a', true, 1), // found by hand
      progressRow('p', 'b', true, 1),
      progressRow('p', 'b', false, 2), // unmarked by hand
      progressRow('p', 'c', true, 3, 'save'), // found from a save already
      progressRow('p', 'd', false, 4, 'save'), // a save mark taken away
      progressRow('p', 'e', true, 5, 'memory'),
    ];
    expect(targetsToMarkFromSave(rows, ['a', 'b', 'c', 'd', 'e', 'f', 'f'])).toEqual(['d', 'f']);
  });

  it('lets a later mark by hand win over a mark from a save', () => {
    const rows = [progressRow('p', 'a', true, 1, 'save'), progressRow('p', 'a', false, 2)];
    expect(targetsToMarkFromSave(rows, ['a'])).toEqual([]);
    expect(targetsMarkedFromSaves(rows)).toEqual([]);
  });

  it('follows id migrations', () => {
    const pack = makeTestPack();
    // The fixture migrates demo:loc:old-1 to demo:loc:0001.
    const rows = [progressRow('p', 'demo:loc:old-1', false, 5)];
    expect(targetsToMarkFromSave(rows, ['demo:loc:0001'], pack.currentId)).toEqual([]);
    expect(targetsToMarkFromSave([], ['demo:loc:old-1'], pack.currentId)).toEqual([
      'demo:loc:0001',
    ]);
    const fromSave = [progressRow('p', 'demo:loc:old-1', true, 5, 'save')];
    expect(targetsMarkedFromSaves(fromSave, pack.currentId)).toEqual(['demo:loc:0001']);
  });

  it('finds the marks made from saves, and only those', () => {
    const rows = [
      progressRow('p', 'a', true, 1),
      progressRow('p', 'b', true, 2, 'save'),
      progressRow('p', 'c', true, 3, 'save'),
      progressRow('p', 'c', false, 4, 'save'),
      progressRow('p', 'd', true, 5, 'memory'),
    ];
    expect(targetsMarkedFromSaves(rows)).toEqual(['b']);
    // Taking them away leaves the marks made by hand.
    const removed = [...rows, progressRow('p', 'b', false, 6, 'save')];
    expect([...resolveProgress(removed).keys()].sort()).toEqual(['a', 'd']);
  });
});
