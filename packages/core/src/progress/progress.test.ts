import { describe, expect, it } from 'vitest';
import { makeTestPack } from '../testing/packs';
import { ProgressCounter, percent } from './counters';
import { progressRow, resolveProgress } from './resolve';

describe('checklist marks', () => {
  it('resolve like found marks but never count as found locations', () => {
    const pack = makeTestPack();
    const counter = new ProgressCounter(pack);
    const resolved = resolveProgress([
      progressRow('p', 'demo:loc:0001', true, 1),
      progressRow('p', 'demo:checkitem:moss', true, 2),
      progressRow('p', 'demo:checkitem:step', true, 3),
      progressRow('p', 'demo:checkitem:step', false, 4),
    ]);
    expect([...resolved.keys()]).toEqual(['demo:loc:0001', 'demo:checkitem:moss']);
    expect(counter.isTrackable('demo:checkitem:moss')).toBe(false);
    const summary = counter.summarize(resolved.keys());
    expect(summary.pack.found).toBe(1);
    expect(summary.category('demo:cat:herb').found).toBe(1);
  });
});

describe('resolveProgress', () => {
  it('keeps live rows and drops tombstones', () => {
    const resolved = resolveProgress([
      progressRow('p', 'demo:loc:0001', true, 1),
      progressRow('p', 'demo:loc:0002', true, 1),
      progressRow('p', 'demo:loc:0002', false, 2),
    ]);
    expect([...resolved.keys()]).toEqual(['demo:loc:0001']);
    expect(resolved.get('demo:loc:0001')).toEqual({
      state: 'found',
      updatedAt: 1,
      source: 'manual',
    });
  });

  it('applies id migrations when reading', () => {
    const pack = makeTestPack();
    // The fixture migrates demo:loc:old-1 to demo:loc:0001.
    const resolved = resolveProgress([progressRow('p', 'demo:loc:old-1', true, 5)], pack.currentId);
    expect([...resolved.keys()]).toEqual(['demo:loc:0001']);
  });

  it('lets the newest row win when an old and a new id meet', () => {
    const pack = makeTestPack();
    const oldFound = progressRow('p', 'demo:loc:old-1', true, 5);
    const newUnmarked = progressRow('p', 'demo:loc:0001', false, 6);
    expect(resolveProgress([oldFound, newUnmarked], pack.currentId).size).toBe(0);
    expect(resolveProgress([newUnmarked, oldFound], pack.currentId).size).toBe(0);
    const newerOld = progressRow('p', 'demo:loc:old-1', true, 7);
    expect(resolveProgress([newUnmarked, newerOld], pack.currentId).size).toBe(1);
  });

  it('breaks timestamp ties towards the current id', () => {
    const pack = makeTestPack();
    const rows = [
      progressRow('p', 'demo:loc:old-1', true, 5),
      progressRow('p', 'demo:loc:0001', false, 5),
    ];
    expect(resolveProgress(rows, pack.currentId).size).toBe(0);
    expect(resolveProgress([...rows].reverse(), pack.currentId).size).toBe(0);
  });
});

describe('ProgressCounter', () => {
  const pack = makeTestPack();
  const counter = new ProgressCounter(pack);

  it('counts totals per map, layer, category, group, region and pack', () => {
    const summary = counter.summarize([]);
    // Trackable: 0001, 0002, 0003 on the world map; 0005, 0006 in the caves. 0004 is a camp.
    expect(summary.pack).toEqual({ found: 0, total: 5, count: 6 });
    expect(summary.map('demo:map:world')).toEqual({ found: 0, total: 3, count: 4 });
    expect(summary.map('demo:map:caves')).toEqual({ found: 0, total: 2, count: 2 });
    expect(summary.layer('demo:layer:lower')).toEqual({ found: 0, total: 1, count: 1 });
    expect(summary.category('demo:cat:herb', 'demo:map:world').total).toBe(2);
    expect(summary.category('demo:cat:herb').total).toBe(3);
    expect(summary.category('demo:cat:camp', 'demo:map:world')).toEqual({
      found: 0,
      total: 0,
      count: 1,
    });
    expect(summary.group('demo:catgroup:collect', 'demo:map:world').total).toBe(3);
    expect(summary.group('demo:catgroup:places').count).toBe(1);
    // North contains 0001 directly and 0003 through its sub-region North East.
    expect(summary.region('demo:region:north').total).toBe(2);
    expect(summary.region('demo:region:north-east').total).toBe(1);
    expect(summary.region('demo:region:nowhere')).toEqual({ found: 0, total: 0, count: 0 });
  });

  it('counts found locations and ignores untrackable or unknown ids', () => {
    const summary = counter.summarize([
      'demo:loc:0003',
      'demo:loc:0006',
      'demo:loc:0004',
      'demo:loc:nope',
    ]);
    expect(summary.pack.found).toBe(2);
    expect(summary.map('demo:map:world').found).toBe(1);
    expect(summary.map('demo:map:caves').found).toBe(1);
    expect(summary.region('demo:region:north').found).toBe(1);
    expect(summary.region('demo:region:north-east').found).toBe(1);
    expect(summary.category('demo:cat:chest').found).toBe(1);
    expect(summary.category('demo:cat:chest', 'demo:map:caves').found).toBe(0);
    expect(summary.category('demo:cat:camp', 'demo:map:world').found).toBe(0);
    expect(summary.group('demo:catgroup:collect').found).toBe(2);
  });

  it('knows which locations are trackable', () => {
    expect(counter.isTrackable('demo:loc:0001')).toBe(true);
    expect(counter.isTrackable('demo:loc:0004')).toBe(false);
    expect(counter.isTrackable('demo:loc:missing')).toBe(false);
  });

  it('formats a floored percentage', () => {
    expect(percent({ found: 0, total: 0, count: 0 })).toBe(0);
    expect(percent({ found: 199, total: 200, count: 200 })).toBe(99);
    expect(percent({ found: 200, total: 200, count: 200 })).toBe(100);
  });
});
