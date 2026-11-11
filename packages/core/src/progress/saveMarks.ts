import type { ProgressRecord } from './records';
import { latestRows } from './resolve';

/**
 * Found marks that come from reading a game save (`source: 'save'`).
 *
 * Marks made by hand always win: reading a save only adds marks, and never
 * to a target the person marked or unmarked themselves. Taking the marks
 * made from saves away leaves every mark made by hand as it is.
 */

/**
 * Of the targets a save shows done (current ids), the ones to mark found
 * now: those not found yet and not marked or unmarked by hand.
 */
export function targetsToMarkFromSave(
  rows: readonly ProgressRecord[],
  targetIds: Iterable<string>,
  currentId: (id: string) => string = (id) => id,
): string[] {
  const latest = latestRows(rows, currentId);
  const marks: string[] = [];
  const seen = new Set<string>();
  for (const id of targetIds) {
    const target = currentId(id);
    if (seen.has(target)) continue;
    seen.add(target);
    const row = latest.get(target);
    if (row && (row.source === 'manual' || !row.deleted)) continue;
    marks.push(target);
  }
  return marks;
}

/** The targets (current ids) that are found because a save said so. */
export function targetsMarkedFromSaves(
  rows: readonly ProgressRecord[],
  currentId: (id: string) => string = (id) => id,
): string[] {
  const marks: string[] = [];
  for (const [target, row] of latestRows(rows, currentId)) {
    if (!row.deleted && row.source === 'save') marks.push(target);
  }
  return marks;
}
