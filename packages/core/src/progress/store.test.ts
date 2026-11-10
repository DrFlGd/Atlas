import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createDexieStore } from './dexieStore';
import { createMemoryStore } from './memoryStore';
import { createClock, randomId } from './records';
import {
  deletedProfile,
  duplicateProfile,
  newProfile,
  newUserPreset,
  progressRow,
  renamedProfile,
} from './resolve';
import type { ProgressStore } from './store';

const backends: [string, () => ProgressStore][] = [
  ['memory', () => createMemoryStore()],
  [
    'dexie',
    () => createDexieStore(`test-${randomId()}`, { indexedDB: new IDBFactory(), IDBKeyRange }),
  ],
];

describe.each(backends)('%s store', (_name, create) => {
  it('stores profiles per game and hides tombstones unless asked', async () => {
    const store = create();
    const a = newProfile('demo', 'First', 10, 'a');
    const b = newProfile('other', 'Second', 11, 'b');
    await store.write({ profiles: [a, b] });
    expect(await store.listProfiles('demo')).toEqual([a]);
    expect((await store.listProfiles()).map((p) => p.id).sort()).toEqual(['a', 'b']);

    await store.write({ profiles: [renamedProfile(a, 'Renamed', 20)] });
    expect((await store.listProfiles('demo'))[0]?.name).toBe('Renamed');

    const removed = deletedProfile(a, [], 30);
    await store.write(removed);
    expect(await store.listProfiles('demo')).toEqual([]);
    expect(await store.listProfiles('demo', { includeDeleted: true })).toHaveLength(1);
    store.close();
  });

  it('keys progress by profile and target, last write wins', async () => {
    const store = create();
    await store.write({
      progress: [
        progressRow('p1', 'demo:loc:0001', true, 1),
        progressRow('p1', 'demo:loc:0002', true, 2),
        progressRow('p2', 'demo:loc:0001', true, 3),
      ],
    });
    await store.write({ progress: [progressRow('p1', 'demo:loc:0001', false, 4)] });
    expect((await store.listProgress('p1')).map((r) => r.targetId)).toEqual(['demo:loc:0002']);
    expect(await store.listProgress('p1', { includeDeleted: true })).toHaveLength(2);
    expect(await store.listProgress('p2')).toHaveLength(1);
    store.close();
  });

  it('stores presets, settings and returns a full snapshot', async () => {
    const store = create();
    const preset = newUserPreset('demo', 'Mine', ['demo:cat:herb'], 5, 'x');
    await store.write({
      presets: [preset, { ...newUserPreset('demo', 'Gone', [], 6, 'y'), deleted: true }],
    });
    expect(await store.listPresets('demo')).toEqual([preset]);
    expect(await store.listPresets('other')).toEqual([]);

    await store.putSetting('filters:demo', { hideFound: true });
    expect(await store.getSetting('filters:demo')).toEqual({ hideFound: true });
    expect(await store.getSetting('missing')).toBeUndefined();

    await store.write({
      profiles: [newProfile('demo', 'P', 1, 'p')],
      progress: [progressRow('p', 'demo:loc:0001', true, 2)],
    });
    const snapshot = await store.snapshot();
    expect(snapshot.profiles).toHaveLength(1);
    expect(snapshot.progress).toHaveLength(1);
    expect(snapshot.presets).toHaveLength(2);
    store.close();
  });

  it('returns copies, not live references', async () => {
    const store = create();
    const profile = newProfile('demo', 'P', 1, 'p');
    await store.write({ profiles: [profile] });
    const [read] = await store.listProfiles('demo');
    read!.name = 'changed';
    expect((await store.listProfiles('demo'))[0]?.name).toBe('P');
    store.close();
  });
});

describe('dexie store', () => {
  it('keeps data across connections to the same database', async () => {
    const indexedDB = new IDBFactory();
    const first = createDexieStore('persist', { indexedDB, IDBKeyRange });
    await first.write({ profiles: [newProfile('demo', 'Kept', 1, 'k')] });
    first.close();
    const second = createDexieStore('persist', { indexedDB, IDBKeyRange });
    expect((await second.listProfiles('demo'))[0]?.name).toBe('Kept');
    second.close();
  });
});

describe('profile helpers', () => {
  it('duplicates live progress into a new profile', () => {
    const source = newProfile('demo', 'Main', 1, 'main');
    const rows = [
      progressRow('main', 'demo:loc:0001', true, 2),
      progressRow('main', 'demo:loc:0002', false, 3),
      progressRow('other', 'demo:loc:0003', true, 4),
    ];
    const copy = duplicateProfile(source, rows, 'Copy', 10, 'copy');
    expect(copy.profiles[0]).toMatchObject({
      id: 'copy',
      gameId: 'demo',
      name: 'Copy',
      createdAt: 10,
    });
    expect(copy.progress).toEqual([{ ...rows[0], profileId: 'copy', updatedAt: 10 }]);
  });

  it('tombstones a profile and its live progress', () => {
    const profile = newProfile('demo', 'Main', 1, 'main');
    const rows = [
      progressRow('main', 'demo:loc:0001', true, 2),
      progressRow('main', 'demo:loc:0002', false, 3),
    ];
    const batch = deletedProfile(profile, rows, 9);
    expect(batch.profiles[0]).toMatchObject({ deleted: true, updatedAt: 9 });
    expect(batch.progress).toEqual([{ ...rows[0], deleted: true, updatedAt: 9 }]);
  });

  it('makes random ids and a strictly increasing clock', () => {
    expect(randomId()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomId()).not.toBe(randomId());
    const clock = createClock(() => 100);
    expect([clock(), clock(), clock()]).toEqual([100, 101, 102]);
  });
});
