import { anyIdSchema, gameIdSchema, idOf } from '@atlas/schema';
import { z } from 'zod';

/**
 * User state records. Every record carries `updatedAt` (milliseconds since
 * the epoch) and a `deleted` tombstone instead of being removed, so two
 * copies of the same data can be merged record by record: the newer
 * `updatedAt` wins, whether it is a change or a deletion.
 */

const timestamp = z.number().int().nonnegative();
const recordId = z.string().min(1).max(128);

/** A playthrough of one game, with its own progress. */
export const profileSchema = z.object({
  id: recordId,
  gameId: gameIdSchema,
  name: z.string().trim().min(1).max(80),
  createdAt: timestamp,
  updatedAt: timestamp,
  deleted: z.boolean(),
});

/** Where a progress record came from: the user, a save-file import, or a memory reader. */
export const progressSourceSchema = z.enum(['manual', 'save', 'memory']);

/**
 * What is known about a target: `found` means found for a location and done
 * for a checklist item. A deleted record means "not done".
 */
export const progressStateSchema = z.enum(['found']);

/**
 * The state of one pack content id in one profile: a location marked found,
 * or a checklist item with a done mark of its own (an item that names no
 * location that can be marked found; see `ChecklistIndex`). Checklist marks
 * need no table or export format of their own: they are rows like any other,
 * so profiles, undo, duplication, deletion, export and import carry them,
 * and the found counters ignore them because they count locations only.
 */
export const progressRecordSchema = z.object({
  profileId: recordId,
  /** Stable content id from the pack, such as `demo:loc:0412` or `demo:checkitem:step-3`. */
  targetId: anyIdSchema,
  state: progressStateSchema,
  updatedAt: timestamp,
  deleted: z.boolean(),
  source: progressSourceSchema,
});

/** A filter set the user saved for one game. */
export const userPresetSchema = z.object({
  id: recordId,
  gameId: gameIdSchema,
  name: z.string().trim().min(1).max(80),
  categoryIds: z.array(idOf('cat')),
  updatedAt: timestamp,
  deleted: z.boolean(),
});

/** A device-local setting; never exported. */
export interface SettingRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

export type Profile = z.infer<typeof profileSchema>;
export type ProgressSource = z.infer<typeof progressSourceSchema>;
export type ProgressState = z.infer<typeof progressStateSchema>;
export type ProgressRecord = z.infer<typeof progressRecordSchema>;
export type UserPreset = z.infer<typeof userPresetSchema>;

/** The key that identifies a progress record. */
export function progressKey(record: Pick<ProgressRecord, 'profileId' | 'targetId'>): string {
  return `${record.profileId}\u0000${record.targetId}`;
}

/**
 * A random record id. Uses `getRandomValues`, which, unlike `randomUUID`,
 * also works on plain-HTTP origins.
 */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A clock for `updatedAt` values that never repeats or goes backwards within
 * one session, so two quick edits of the same record keep their order.
 */
export function createClock(now: () => number = Date.now): () => number {
  let last = 0;
  return () => {
    last = Math.max(now(), last + 1);
    return last;
  };
}
