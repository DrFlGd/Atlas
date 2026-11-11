import {
  randomId,
  type Profile,
  type ProgressRecord,
  type ProgressSource,
  type ProgressState,
  type UserPreset,
} from './records';
import type { WriteBatch } from './store';

/** The effective state of one target after merging all rows that refer to it. */
export interface TargetProgress {
  state: ProgressState;
  updatedAt: number;
  source: ProgressSource;
}

/**
 * Turns a profile's stored rows into the current state per target.
 *
 * `currentId` maps ids from older pack versions to the id that replaces them
 * (the manifest's `idMigrations`), so progress saved under an old id counts
 * for its replacement. When several rows end up on one target, the newest
 * wins; a tombstone that wins means "not done", so un-marking a migrated
 * target does not need to touch the row stored under the old id.
 */
export function resolveProgress(
  rows: readonly ProgressRecord[],
  currentId: (id: string) => string = (id) => id,
): Map<string, TargetProgress> {
  const resolved = new Map<string, TargetProgress>();
  for (const [target, row] of latestRows(rows, currentId)) {
    if (!row.deleted) {
      resolved.set(target, { state: row.state, updatedAt: row.updatedAt, source: row.source });
    }
  }
  return resolved;
}

/**
 * The row that decides each target's state, tombstones included, by
 * current target id (see {@link resolveProgress}).
 */
export function latestRows(
  rows: readonly ProgressRecord[],
  currentId: (id: string) => string = (id) => id,
): Map<string, ProgressRecord> {
  const winners = new Map<string, ProgressRecord>();
  for (const row of rows) {
    const target = currentId(row.targetId);
    const best = winners.get(target);
    if (!best || isNewer(row, best, target)) winners.set(target, row);
  }
  return winners;
}

/** Newer timestamp wins; on a tie, the row stored under the current id, then a tombstone. */
function isNewer(row: ProgressRecord, best: ProgressRecord, target: string): boolean {
  if (row.updatedAt !== best.updatedAt) return row.updatedAt > best.updatedAt;
  const rowCurrent = row.targetId === target;
  const bestCurrent = best.targetId === target;
  if (rowCurrent !== bestCurrent) return rowCurrent;
  return row.deleted && !best.deleted;
}

/** A progress row that marks a target found, or un-marks it with a tombstone. */
export function progressRow(
  profileId: string,
  targetId: string,
  found: boolean,
  updatedAt: number,
  source: ProgressSource = 'manual',
): ProgressRecord {
  return { profileId, targetId, state: 'found', updatedAt, deleted: !found, source };
}

export function newProfile(gameId: string, name: string, now: number, id = randomId()): Profile {
  return { id, gameId, name: name.trim(), createdAt: now, updatedAt: now, deleted: false };
}

export function renamedProfile(profile: Profile, name: string, now: number): Profile {
  return { ...profile, name: name.trim(), updatedAt: now };
}

/** A new profile holding a copy of another profile's live progress. */
export function duplicateProfile(
  source: Profile,
  rows: readonly ProgressRecord[],
  name: string,
  now: number,
  id = randomId(),
): Required<Pick<WriteBatch, 'profiles' | 'progress'>> {
  const profile = newProfile(source.gameId, name, now, id);
  const progress = rows
    .filter((row) => row.profileId === source.id && !row.deleted)
    .map((row) => ({ ...row, profileId: id, updatedAt: now }));
  return { profiles: [profile], progress };
}

/** Tombstones for a profile and all of its progress. */
export function deletedProfile(
  profile: Profile,
  rows: readonly ProgressRecord[],
  now: number,
): Required<Pick<WriteBatch, 'profiles' | 'progress'>> {
  return {
    profiles: [{ ...profile, deleted: true, updatedAt: now }],
    progress: rows
      .filter((row) => row.profileId === profile.id && !row.deleted)
      .map((row) => ({ ...row, deleted: true, updatedAt: now })),
  };
}

export function newUserPreset(
  gameId: string,
  name: string,
  categoryIds: readonly string[],
  now: number,
  id = randomId(),
): UserPreset {
  return {
    id,
    gameId,
    name: name.trim(),
    categoryIds: [...categoryIds],
    updatedAt: now,
    deleted: false,
  };
}
