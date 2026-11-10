import type { Profile, ProgressRecord, UserPreset } from './records';

/** Records to write together. A record replaces any stored record with the same key. */
export interface WriteBatch {
  profiles?: readonly Profile[];
  progress?: readonly ProgressRecord[];
  presets?: readonly UserPreset[];
}

/** Every exportable record, tombstones included. */
export interface StoreSnapshot {
  profiles: Profile[];
  progress: ProgressRecord[];
  presets: UserPreset[];
}

export interface ListOptions {
  /** Include tombstones. Defaults to false. */
  includeDeleted?: boolean;
}

/**
 * Where user state lives. The app talks only to this interface, so the
 * storage backend (IndexedDB today, a sync service later) can be swapped
 * without touching the UI.
 *
 * Keys: profiles and presets by `id`, progress by `profileId` + `targetId`,
 * settings by `key`. Deleting is done by writing a tombstone
 * (`deleted: true`), never by removing a record.
 */
export interface ProgressStore {
  listProfiles(gameId?: string, options?: ListOptions): Promise<Profile[]>;
  /**
   * Progress rows of one profile. Resolving progress needs the tombstones
   * (see `resolveProgress`), so pass `includeDeleted: true` for that.
   */
  listProgress(profileId: string, options?: ListOptions): Promise<ProgressRecord[]>;
  listPresets(gameId: string, options?: ListOptions): Promise<UserPreset[]>;
  getSetting(key: string): Promise<unknown>;
  putSetting(key: string, value: unknown): Promise<void>;
  /** Writes every record in the batch atomically. */
  write(batch: WriteBatch): Promise<void>;
  /** Every profile, progress row and preset, tombstones included. */
  snapshot(): Promise<StoreSnapshot>;
  /** Releases the backend's resources. */
  close(): void;
}

export const live = <T extends { deleted: boolean }>(
  records: readonly T[],
  options?: ListOptions,
): T[] => (options?.includeDeleted ? [...records] : records.filter((r) => !r.deleted));
