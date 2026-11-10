import { z } from 'zod';
import {
  profileSchema,
  progressKey,
  progressRecordSchema,
  userPresetSchema,
  type Profile,
  type ProgressRecord,
  type UserPreset,
} from './records';
import type { StoreSnapshot, WriteBatch } from './store';

/**
 * The export file: one JSON document holding one profile or every profile,
 * with progress rows (tombstones included, so a merge can carry deletions)
 * and the user's presets for the games involved.
 */
export const EXPORT_FORMAT = 'atlas-progress';
export const EXPORT_VERSION = 1;

export const exportFileSchema = z
  .object({
    format: z.literal(EXPORT_FORMAT),
    version: z.literal(EXPORT_VERSION),
    exportedAt: z.iso.datetime(),
    /** `profile`: one profile; `all`: every profile on the device. */
    scope: z.enum(['profile', 'all']),
    profiles: z.array(profileSchema),
    progress: z.array(progressRecordSchema),
    presets: z.array(userPresetSchema),
  })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    file.profiles.forEach((profile, i) => {
      if (ids.has(profile.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['profiles', i, 'id'],
          message: `duplicate profile ${profile.id}`,
        });
      }
      ids.add(profile.id);
    });
    if (file.scope === 'profile' && file.profiles.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['profiles'],
        message: 'a profile export holds exactly one profile',
      });
    }
    file.progress.forEach((row, i) => {
      if (!ids.has(row.profileId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['progress', i, 'profileId'],
          message: `unknown profile ${row.profileId}`,
        });
      }
    });
  });

export type ExportFile = z.infer<typeof exportFileSchema>;

export type ExportSelection = { scope: 'profile'; profileId: string } | { scope: 'all' };

/** Builds an export file from a store snapshot. Deleted profiles are left out. */
export function buildExport(
  snapshot: StoreSnapshot,
  selection: ExportSelection,
  now: Date,
): ExportFile {
  const profiles = snapshot.profiles.filter(
    (p) => !p.deleted && (selection.scope === 'all' || p.id === selection.profileId),
  );
  if (selection.scope === 'profile' && profiles.length === 0) {
    throw new Error(`No profile ${selection.profileId} to export`);
  }
  const profileIds = new Set(profiles.map((p) => p.id));
  const gameIds = new Set(profiles.map((p) => p.gameId));
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    scope: selection.scope,
    profiles,
    progress: snapshot.progress.filter((r) => profileIds.has(r.profileId)),
    presets: snapshot.presets.filter((p) => gameIds.has(p.gameId)),
  };
}

export type ParseResult = { ok: true; file: ExportFile } | { ok: false; error: string };

/** Parses and validates the text of an export file. */
export function parseExport(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not valid JSON.' };
  }
  const format = (raw as { format?: unknown } | null)?.format;
  if (format !== EXPORT_FORMAT) {
    return { ok: false, error: 'The file is not an Atlas progress export.' };
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== EXPORT_VERSION) {
    return { ok: false, error: `Export version ${JSON.stringify(version)} is not supported.` };
  }
  const result = exportFileSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
    return { ok: false, error: `The file is not a valid export:\n${lines.join('\n')}` };
  }
  return { ok: true, file: result.data };
}

export type ImportMode = 'merge' | 'replace';

export interface ImportPlan {
  batch: Required<WriteBatch>;
  /** Live profiles in the file, for showing what the import touches. */
  profiles: Profile[];
  /** Number of records that change. */
  changed: { profiles: number; progress: number; presets: number };
}

/**
 * Works out what an import writes.
 *
 * Merge keeps, record by record, whichever of the local and imported copies
 * is newer, so importing the same file twice changes nothing and deletions
 * travel as tombstones.
 *
 * Replace makes the imported data the truth: each imported profile's
 * progress becomes exactly what the file holds, and records written get
 * `now` as their time so they win later merges. A whole-device export
 * (`scope: 'all'`) also removes local profiles and presets of the same games
 * that the file does not contain; a single-profile export leaves other
 * profiles alone and merges presets.
 */
export function planImport(
  local: StoreSnapshot,
  file: ExportFile,
  mode: ImportMode,
  now: number,
): ImportPlan {
  return mode === 'merge' ? planMerge(local, file) : planReplace(local, file, now);
}

function newerThan<T extends { updatedAt: number }>(incoming: T, existing: T | undefined): boolean {
  return existing === undefined || incoming.updatedAt > existing.updatedAt;
}

function planMerge(local: StoreSnapshot, file: ExportFile): ImportPlan {
  const profiles = new Map(local.profiles.map((p) => [p.id, p]));
  const progress = new Map(local.progress.map((r) => [progressKey(r), r]));
  const presets = new Map(local.presets.map((p) => [p.id, p]));
  const batch = {
    profiles: file.profiles.filter((p) => newerThan(p, profiles.get(p.id))),
    progress: file.progress.filter((r) => newerThan(r, progress.get(progressKey(r)))),
    presets: file.presets.filter((p) => newerThan(p, presets.get(p.id))),
  };
  return summarize(batch, file);
}

function planReplace(local: StoreSnapshot, file: ExportFile, now: number): ImportPlan {
  const stamp = <T extends { updatedAt: number }>(record: T): T => ({ ...record, updatedAt: now });
  const tombstone = <T extends { updatedAt: number; deleted: boolean }>(record: T): T => ({
    ...record,
    deleted: true,
    updatedAt: now,
  });

  const fileProfileIds = new Set(file.profiles.map((p) => p.id));
  const gameIds = new Set(file.profiles.map((p) => p.gameId));
  const removedProfiles =
    file.scope === 'all'
      ? local.profiles.filter(
          (p) => !p.deleted && gameIds.has(p.gameId) && !fileProfileIds.has(p.id),
        )
      : [];
  const removedProfileIds = new Set(removedProfiles.map((p) => p.id));

  const fileProgressKeys = new Set(file.progress.map(progressKey));
  const progress: ProgressRecord[] = [
    ...file.progress.map(stamp),
    ...local.progress
      .filter(
        (r) =>
          !r.deleted &&
          ((fileProfileIds.has(r.profileId) && !fileProgressKeys.has(progressKey(r))) ||
            removedProfileIds.has(r.profileId)),
      )
      .map(tombstone),
  ];

  let presets: UserPreset[];
  if (file.scope === 'all') {
    const filePresetIds = new Set(file.presets.map((p) => p.id));
    presets = [
      ...file.presets.map(stamp),
      ...local.presets
        .filter((p) => !p.deleted && gameIds.has(p.gameId) && !filePresetIds.has(p.id))
        .map(tombstone),
    ];
  } else {
    const localPresets = new Map(local.presets.map((p) => [p.id, p]));
    presets = file.presets.filter((p) => newerThan(p, localPresets.get(p.id)));
  }

  const batch = {
    profiles: [...file.profiles.map(stamp), ...removedProfiles.map(tombstone)],
    progress,
    presets,
  };
  return summarize(batch, file);
}

function summarize(batch: Required<WriteBatch>, file: ExportFile): ImportPlan {
  return {
    batch: {
      profiles: [...batch.profiles],
      progress: [...batch.progress],
      presets: [...batch.presets],
    },
    profiles: file.profiles.filter((p) => !p.deleted),
    changed: {
      profiles: batch.profiles.length,
      progress: batch.progress.length,
      presets: batch.presets.length,
    },
  };
}

/** A file name for an export, such as `atlas-demo-playthrough-1-2026-11-10.json`. */
export function exportFileName(file: ExportFile): string {
  const date = file.exportedAt.slice(0, 10);
  if (file.scope === 'all') return `atlas-all-profiles-${date}.json`;
  const profile = file.profiles[0];
  const slug = (text: string) =>
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'profile';
  return `atlas-${profile?.gameId ?? 'game'}-${slug(profile?.name ?? '')}-${date}.json`;
}
