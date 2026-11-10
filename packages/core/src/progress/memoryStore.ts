import { progressKey, type Profile, type ProgressRecord, type UserPreset } from './records';
import { live, type ProgressStore, type StoreSnapshot, type WriteBatch } from './store';

/**
 * A {@link ProgressStore} that keeps everything in memory. Used in tests and
 * as the fallback when the browser offers no IndexedDB (for example some
 * private windows); nothing survives a reload.
 */
export function createMemoryStore(initial?: Partial<StoreSnapshot>): ProgressStore {
  const profiles = new Map<string, Profile>();
  const progress = new Map<string, ProgressRecord>();
  const presets = new Map<string, UserPreset>();
  const settings = new Map<string, unknown>();
  const clone = <T>(value: T): T => structuredClone(value);

  const apply = (batch: WriteBatch) => {
    for (const p of batch.profiles ?? []) profiles.set(p.id, clone(p));
    for (const r of batch.progress ?? []) progress.set(progressKey(r), clone(r));
    for (const p of batch.presets ?? []) presets.set(p.id, clone(p));
  };
  apply(initial ?? {});

  return {
    listProfiles(gameId, options) {
      const all = [...profiles.values()].filter((p) => gameId === undefined || p.gameId === gameId);
      return Promise.resolve(clone(live(all, options)));
    },
    listProgress(profileId, options) {
      const rows = [...progress.values()].filter((r) => r.profileId === profileId);
      return Promise.resolve(clone(live(rows, options)));
    },
    listPresets(gameId, options) {
      const all = [...presets.values()].filter((p) => p.gameId === gameId);
      return Promise.resolve(clone(live(all, options)));
    },
    getSetting(key) {
      return Promise.resolve(clone(settings.get(key)));
    },
    putSetting(key, value) {
      settings.set(key, clone(value));
      return Promise.resolve();
    },
    write(batch) {
      apply(batch);
      return Promise.resolve();
    },
    snapshot() {
      return Promise.resolve(
        clone({
          profiles: [...profiles.values()],
          progress: [...progress.values()],
          presets: [...presets.values()],
        }),
      );
    },
    close() {
      // Nothing to release.
    },
  };
}
