import type { SearchKind } from '@atlas/core';

/** A search result chosen earlier, kept per game on this device. */
export interface RecentRef {
  kind: SearchKind;
  id: string;
}

/** How many chosen results are kept. */
export const RECENT_LIMIT = 6;

const KINDS: readonly SearchKind[] = ['location', 'entity', 'guide', 'checklist', 'checkitem'];

/** The list with `ref` first, without an earlier copy of it, at most `limit` long. */
export function withRecent(
  list: readonly RecentRef[],
  ref: RecentRef,
  limit = RECENT_LIMIT,
): RecentRef[] {
  return [ref, ...list.filter((r) => r.kind !== ref.kind || r.id !== ref.id)].slice(0, limit);
}

/** Reads a stored list, dropping anything that is not a result reference. */
export function parseRecent(value: unknown): RecentRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is RecentRef =>
        typeof item === 'object' &&
        item !== null &&
        KINDS.includes((item as RecentRef).kind) &&
        typeof (item as RecentRef).id === 'string',
    )
    .map(({ kind, id }) => ({ kind, id }))
    .slice(0, RECENT_LIMIT);
}
