import { Dexie, type DexieOptions, type EntityTable } from 'dexie';
import type { Profile, ProgressRecord, SettingRecord, UserPreset } from './records';
import { live, type ProgressStore } from './store';

/** The default IndexedDB database name. */
export const DEFAULT_DATABASE_NAME = 'atlas';

type AtlasDatabase = Dexie & {
  profiles: EntityTable<Profile, 'id'>;
  progress: Dexie.Table<ProgressRecord, [string, string]>;
  presets: EntityTable<UserPreset, 'id'>;
  settings: EntityTable<SettingRecord, 'key'>;
};

function openDatabase(name: string, options?: DexieOptions): AtlasDatabase {
  const db = new Dexie(name, options) as AtlasDatabase;
  // Version 1. Later phases add tables (notes, custom markers) in new
  // versions; existing tables keep their keys.
  db.version(1).stores({
    profiles: 'id, gameId',
    progress: '[profileId+targetId], profileId',
    presets: 'id, gameId',
    settings: 'key',
  });
  return db;
}

/**
 * A {@link ProgressStore} kept in IndexedDB through Dexie. `options` passes
 * an `indexedDB` implementation for environments without one (tests).
 */
export function createDexieStore(
  name: string = DEFAULT_DATABASE_NAME,
  options?: DexieOptions,
): ProgressStore {
  const db = openDatabase(name, options);

  return {
    async listProfiles(gameId, listOptions) {
      const rows =
        gameId === undefined
          ? await db.profiles.toArray()
          : await db.profiles.where('gameId').equals(gameId).toArray();
      return live(rows, listOptions);
    },
    async listProgress(profileId, listOptions) {
      return live(await db.progress.where('profileId').equals(profileId).toArray(), listOptions);
    },
    async listPresets(gameId, listOptions) {
      return live(await db.presets.where('gameId').equals(gameId).toArray(), listOptions);
    },
    async getSetting(key) {
      return (await db.settings.get(key))?.value;
    },
    async putSetting(key, value) {
      await db.settings.put({ key, value, updatedAt: Date.now() });
    },
    async listSettings(prefix) {
      const rows = await db.settings.where('key').startsWith(prefix).toArray();
      return rows.map(({ key, value }) => ({ key, value }));
    },
    async putSettings(entries) {
      if (entries.length === 0) return;
      const updatedAt = Date.now();
      await db.settings.bulkPut(entries.map(({ key, value }) => ({ key, value, updatedAt })));
    },
    async write(batch) {
      await db.transaction('rw', [db.profiles, db.progress, db.presets], async () => {
        if (batch.profiles?.length) await db.profiles.bulkPut([...batch.profiles]);
        if (batch.progress?.length) await db.progress.bulkPut([...batch.progress]);
        if (batch.presets?.length) await db.presets.bulkPut([...batch.presets]);
      });
    },
    async snapshot() {
      return db.transaction('r', [db.profiles, db.progress, db.presets], async () => ({
        profiles: await db.profiles.toArray(),
        progress: await db.progress.toArray(),
        presets: await db.presets.toArray(),
      }));
    },
    close() {
      db.close();
    },
  };
}
