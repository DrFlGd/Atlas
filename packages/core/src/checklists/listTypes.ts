import type { ChecklistType } from '@atlas/schema';
import type { ChecklistEntry } from './checklists';

/**
 * What a list is, and so how the app shows it. A pack can say so with a
 * checklist's `type`; when it does not, the app works it out the way it
 * did before there were types (see {@link listType}).
 */

/** The ways to show a list: by area, by kind, and in its own order. */
export type ListView = 'area' | 'kind' | 'order';

/** How a list is shown, decided by its type (see {@link listShape}). */
export interface ListShape {
  readonly type: ChecklistType;
  /** The views offered, in the order they are listed; one view means no choice. */
  readonly views: readonly ListView[];
  /** The view a list opens in until another is chosen. */
  readonly defaultView: ListView;
  /** Followed step by step: shown in order with a next step, and listed under Routes. */
  readonly steps: boolean;
  /** What the figures count: places found, or entries done. */
  readonly doneWord: 'found' | 'done';
}

const ALL: readonly ListView[] = ['area', 'kind', 'order'];
const GROUPED: readonly ListView[] = ['area', 'kind'];
const AS_WRITTEN: readonly ListView[] = ['order'];

/** Whether any entry of a list has a place in the pack. */
export function hasPlaces(entry: ChecklistEntry): boolean {
  return entry.items.some((item) => item.places.length > 0);
}

/**
 * The type of a list: the pack's `type` when it has one. Otherwise, as
 * before types: a list of `kind: 'guide'` is a route, a list with no place
 * is plain, and any other list is a collection.
 */
export function listType(entry: ChecklistEntry): ChecklistType {
  const { type, kind } = entry.checklist;
  if (type) return type;
  if (kind === 'guide') return 'route';
  return hasPlaces(entry) ? 'collection' : 'plain';
}

/** Whether lists of a type are followed step by step: a route or a build. */
export function followsSteps(type: ChecklistType): boolean {
  return type === 'route' || type === 'build';
}

/**
 * How a list is shown:
 *
 * - A collection (and secrets, and photos for now) is grouped by area or
 *   by kind, and counts places found.
 * - A route is followed in order, with a next step, and can be grouped too.
 * - A build is followed in order only, with a next step.
 * - A plain list is shown as written: no choice of view, no next step.
 *
 * A list with no place has nothing to group: whatever its type, it is shown
 * in order only (a route or a build still with a next step), and counts
 * entries done.
 */
export function listShape(entry: ChecklistEntry): ListShape {
  const type = listType(entry);
  const places = hasPlaces(entry);
  const steps = followsSteps(type);
  let views: readonly ListView[];
  if (!places || type === 'build' || type === 'plain') views = AS_WRITTEN;
  else views = type === 'route' ? ALL : GROUPED;
  return {
    type,
    views,
    defaultView: views.includes('order') ? 'order' : views[0]!,
    steps,
    doneWord: steps || type === 'plain' || !places ? 'done' : 'found',
  };
}
