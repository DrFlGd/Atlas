import { Dexie } from 'dexie';
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

describe('stores written by earlier versions', () => {
  it('opens a database written by Atlas 0.3.3 as is, and keeps checklist marks beside found marks', async () => {
    const indexedDB = new IDBFactory();
    // The database as Atlas 0.3.3 created it: Dexie version 1, these tables and keys.
    const legacy = new Dexie('legacy', { indexedDB, IDBKeyRange });
    legacy.version(1).stores({
      profiles: 'id, gameId',
      progress: '[profileId+targetId], profileId',
      presets: 'id, gameId',
      settings: 'key',
    });
    await legacy.table('profiles').put(newProfile('demo', 'Old run', 1, 'old'));
    await legacy.table('progress').put(progressRow('old', 'demo:loc:0001', true, 2));
    await legacy.table('settings').put({ key: 'theme', value: 'light', updatedAt: 3 });
    legacy.close();

    const store = createDexieStore('legacy', { indexedDB, IDBKeyRange });
    expect((await store.listProfiles('demo'))[0]?.name).toBe('Old run');
    expect(await store.getSetting('theme')).toBe('light');
    // A checklist step's own done mark is a progress row keyed by the item's id.
    await store.write({ progress: [progressRow('old', 'demo:checkitem:step-1', true, 4)] });
    const rows = await store.listProgress('old');
    expect(rows.map((r) => r.targetId).sort()).toEqual(['demo:checkitem:step-1', 'demo:loc:0001']);
    expect((await store.snapshot()).progress).toHaveLength(2);
    store.close();

    // No upgrade was needed: the database is still at the version 0.3.3 wrote.
    const reopened = new Dexie('legacy', { indexedDB, IDBKeyRange });
    await reopened.open();
    expect(reopened.verno).toBe(1);
    reopened.close();
  });
});

describe('profile helpers', () => {
  it('duplicates live progress into a new profile', () => {
    const source = newProfile('demo', 'Main', 1, 'main');
    const rows = [
      progressRow('main', 'demo:loc:0001', true, 2),
      progressRow('main', 'demo:loc:0002', false, 3),
      progressRow('other', 'demo:loc:0003', true, 4),
      progressRow('main', 'demo:checkitem:step-1', true, 5),
    ];
    const copy = duplicateProfile(source, rows, 'Copy', 10, 'copy');
    expect(copy.profiles[0]).toMatchObject({
      id: 'copy',
      gameId: 'demo',
      name: 'Copy',
      createdAt: 10,
    });
    // Checklist marks are progress rows too, so they are copied with the found marks.
    expect(copy.progress).toEqual([
      { ...rows[0], profileId: 'copy', updatedAt: 10 },
      { ...rows[3], profileId: 'copy', updatedAt: 10 },
    ]);
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
