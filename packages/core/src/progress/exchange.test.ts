import { describe, expect, it } from 'vitest';
import { buildExport, exportFileName, parseExport, planImport, type ExportFile } from './exchange';
import { createMemoryStore } from './memoryStore';
import { newProfile, newUserPreset, progressRow, resolveProgress } from './resolve';
import type { StoreSnapshot } from './store';

const NOW = new Date('2026-11-10T12:00:00.000Z');

function localState(): StoreSnapshot {
  return {
    profiles: [
      newProfile('demo', 'Main run', 1, 'main'),
      newProfile('demo', 'Second', 1, 'second'),
      newProfile('other', 'Elsewhere', 1, 'else'),
      { ...newProfile('demo', 'Gone', 1, 'gone'), deleted: true, updatedAt: 2 },
    ],
    progress: [
      progressRow('main', 'demo:loc:0001', true, 10),
      progressRow('main', 'demo:loc:0002', true, 11),
      progressRow('main', 'demo:loc:0003', false, 12),
      progressRow('second', 'demo:loc:0001', true, 13),
      progressRow('else', 'other:loc:1', true, 14),
    ],
    presets: [
      newUserPreset('demo', 'Herbs', ['demo:cat:herb'], 20, 'herbs'),
      newUserPreset('other', 'Other', [], 21, 'other-preset'),
    ],
  };
}

const roundTrip = (file: ExportFile) => {
  const parsed = parseExport(JSON.stringify(file));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.file;
};

describe('buildExport', () => {
  it('exports one profile with its rows, tombstones included, and its game presets', () => {
    const file = buildExport(localState(), { scope: 'profile', profileId: 'main' }, NOW);
    expect(file).toMatchObject({
      format: 'atlas-progress',
      version: 1,
      scope: 'profile',
      exportedAt: NOW.toISOString(),
    });
    expect(file.profiles.map((p) => p.id)).toEqual(['main']);
    expect(file.progress).toHaveLength(3);
    expect(file.presets.map((p) => p.id)).toEqual(['herbs']);
    expect(exportFileName(file)).toBe('atlas-demo-main-run-2026-11-10.json');
  });

  it('exports every live profile', () => {
    const file = buildExport(localState(), { scope: 'all' }, NOW);
    expect(file.profiles.map((p) => p.id).sort()).toEqual(['else', 'main', 'second']);
    expect(file.progress).toHaveLength(5);
    expect(file.presets).toHaveLength(2);
    expect(exportFileName(file)).toBe('atlas-all-profiles-2026-11-10.json');
  });

  it('refuses to export a missing profile', () => {
    expect(() => buildExport(localState(), { scope: 'profile', profileId: 'gone' }, NOW)).toThrow();
  });
});

describe('parseExport', () => {
  it('round-trips an export', () => {
    const file = buildExport(localState(), { scope: 'all' }, NOW);
    expect(roundTrip(file)).toEqual(file);
  });

  it('explains what is wrong with a bad file', () => {
    expect(parseExport('{ nope')).toEqual({ ok: false, error: 'The file is not valid JSON.' });
    expect(parseExport('{"format":"x"}')).toEqual({
      ok: false,
      error: 'The file is not an Atlas progress export.',
    });
    const unsupported = parseExport('{"format":"atlas-progress","version":9}');
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.error).toContain('version 9');

    const file = buildExport(localState(), { scope: 'profile', profileId: 'main' }, NOW);
    const orphan = {
      ...file,
      progress: [...file.progress, progressRow('stranger', 'demo:loc:0001', true, 1)],
    };
    const result = parseExport(JSON.stringify(orphan));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown profile stranger');

    const badId = { ...file, progress: [{ ...file.progress[0], targetId: 'not an id' }] };
    expect(parseExport(JSON.stringify(badId)).ok).toBe(false);
  });
});

describe('planImport, merge', () => {
  it('changes nothing when importing the same data', () => {
    const local = localState();
    const file = buildExport(local, { scope: 'all' }, NOW);
    expect(planImport(local, file, 'merge', 99).changed).toEqual({
      profiles: 0,
      progress: 0,
      presets: 0,
    });
  });

  it('keeps the newer side of each record, carrying deletions', () => {
    const local = localState();
    const file = buildExport(local, { scope: 'profile', profileId: 'main' }, NOW);
    file.progress = [
      progressRow('main', 'demo:loc:0001', false, 50), // newer tombstone: un-marks
      progressRow('main', 'demo:loc:0002', false, 5), // older tombstone: ignored
      progressRow('main', 'demo:loc:0009', true, 60), // new row
    ];
    const plan = planImport(local, file, 'merge', 99);
    expect(plan.batch.progress.map((r) => r.targetId)).toEqual(['demo:loc:0001', 'demo:loc:0009']);
    expect(plan.batch.profiles).toEqual([]);
  });

  it('adds profiles the device does not have', () => {
    const file = buildExport(localState(), { scope: 'profile', profileId: 'main' }, NOW);
    const plan = planImport({ profiles: [], progress: [], presets: [] }, file, 'merge', 99);
    expect(plan.changed).toEqual({ profiles: 1, progress: 3, presets: 1 });
  });
});

describe('planImport, replace', () => {
  it('makes a single profile match the file and leaves other profiles alone', async () => {
    const local = localState();
    const file = buildExport(local, { scope: 'profile', profileId: 'main' }, NOW);
    file.progress = [progressRow('main', 'demo:loc:0005', true, 3)];
    const plan = planImport(local, file, 'replace', 1000);

    const store = createMemoryStore(local);
    await store.write(plan.batch);
    const main = resolveProgress(await store.listProgress('main', { includeDeleted: true }));
    expect([...main.keys()]).toEqual(['demo:loc:0005']);
    expect(main.get('demo:loc:0005')?.updatedAt).toBe(1000);
    expect(await store.listProgress('second')).toHaveLength(1);
    expect((await store.listProfiles()).length).toBe(3);
  });

  it('replaces every profile and preset of the games in a whole-device export', async () => {
    const local = localState();
    const otherDevice: StoreSnapshot = {
      profiles: [newProfile('demo', 'Laptop run', 5, 'laptop')],
      progress: [progressRow('laptop', 'demo:loc:0007', true, 6)],
      presets: [],
    };
    const file = buildExport(otherDevice, { scope: 'all' }, NOW);
    const plan = planImport(local, file, 'replace', 1000);
    const store = createMemoryStore(local);
    await store.write(plan.batch);

    expect((await store.listProfiles('demo')).map((p) => p.id)).toEqual(['laptop']);
    expect(await store.listProgress('main')).toEqual([]);
    expect(await store.listPresets('demo')).toEqual([]);
    // Games not in the file are untouched.
    expect(await store.listProfiles('other')).toHaveLength(1);
    expect(await store.listPresets('other')).toHaveLength(1);
  });

  it('round-trips export and replace-import into an empty store', async () => {
    const source = createMemoryStore(localState());
    const file = roundTrip(buildExport(await source.snapshot(), { scope: 'all' }, NOW));
    const target = createMemoryStore();
    await target.write(planImport(await target.snapshot(), file, 'replace', 5000).batch);
    for (const id of ['main', 'second', 'else']) {
      const before = resolveProgress(await source.listProgress(id, { includeDeleted: true }));
      const after = resolveProgress(await target.listProgress(id, { includeDeleted: true }));
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    }
  });
});
