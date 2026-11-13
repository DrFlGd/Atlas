import type { Checklist, ChecklistItem, GuideEntry } from '@atlas/schema';
import type { LoadedPack } from '../pack/loadedPack';

/**
 * Checklists and guides of a pack, arranged for the app.
 *
 * The rules for when an item is done:
 *
 * - An item that names at least one location that can be marked found (a
 *   location in a trackable category) is done when every such location is
 *   found. Its locations in categories that are not tracked are places to
 *   show on the map only. It has no mark of its own: its state is always
 *   derived from the found marks, so the map and the checklist cannot
 *   disagree.
 * - Any other item (a step, a quest stage, or an item whose places cannot be
 *   marked) has a done mark of its own, stored like a found mark under the
 *   item's id.
 *
 * Ticking an item marks its locations that are not found yet as found.
 * Unticking it marks all of its locations not found. Both are one change
 * that one undo takes back (see {@link tickChanges}).
 */

/** Whether a target (a location id, or an item id for an item's own mark) is found or done. */
export type IsDone = (targetId: string) => boolean;

/** One found mark to set or clear. */
export interface ProgressChange {
  targetId: string;
  found: boolean;
}

export interface ChecklistItemEntry {
  readonly item: ChecklistItem;
  /** Position within its checklist, in order. */
  readonly index: number;
  /** Locations of the item that can be marked found. The item is done when all of them are. */
  readonly targets: readonly string[];
  /** Every location of the item that is in the pack, for showing on the map. */
  readonly places: readonly string[];
  /** The item has a done mark of its own, because no location of it can be marked found. */
  readonly ownMark: boolean;
}

export interface ChecklistEntry {
  readonly checklist: Checklist;
  /** Items in order. */
  readonly items: readonly ChecklistItemEntry[];
}

/** How far one item is: `found` of its `total` targets (1 for an item with its own mark). */
export interface ItemState {
  done: boolean;
  found: number;
  total: number;
  /**
   * An optional step (the item's `optional`): "Next up" passes over it, and
   * it does not count against the list being done (see {@link tallyStates}).
   */
  optional?: boolean;
}

/** Done items of a checklist, or of several. */
export interface ChecklistTally {
  done: number;
  total: number;
}

export function itemState(entry: ChecklistItemEntry, isDone: IsDone): ItemState {
  const optional = entry.item.optional === true ? { optional: true } : {};
  if (entry.ownMark) {
    const done = isDone(entry.item.id);
    return { done, found: done ? 1 : 0, total: 1, ...optional };
  }
  let found = 0;
  for (const id of entry.targets) if (isDone(id)) found++;
  return { done: found === entry.targets.length, found, total: entry.targets.length, ...optional };
}

/**
 * Done and all entries, of the ones that count: an optional step does not
 * count against the list being done, so it is left out of both.
 */
export function tallyStates(
  states: readonly Pick<ItemState, 'done' | 'optional'>[],
): ChecklistTally {
  let done = 0;
  let total = 0;
  for (const state of states) {
    if (state.optional) continue;
    total++;
    if (state.done) done++;
  }
  return { done, total };
}

export function checklistTally(entry: ChecklistEntry, isDone: IsDone): ChecklistTally {
  return tallyStates(entry.items.map((item) => itemState(item, isDone)));
}

/**
 * The found marks to write when an item is ticked (`done` true) or unticked.
 *
 * Ticking marks the item's locations that are not found yet as found, and
 * leaves the found ones alone. Unticking marks every one of its locations
 * not found, including those that were found on the map before the item was
 * ticked: the rule does not depend on how a location came to be found, so
 * it is the same every time, and one undo restores them all. An item with
 * its own mark sets or clears that mark. Returns no changes when the item
 * is already in the requested state.
 */
export function tickChanges(
  entry: ChecklistItemEntry,
  done: boolean,
  isDone: IsDone,
): ProgressChange[] {
  if (entry.ownMark) {
    return isDone(entry.item.id) === done ? [] : [{ targetId: entry.item.id, found: done }];
  }
  return entry.targets
    .filter((id) => isDone(id) !== done)
    .map((targetId) => ({ targetId, found: done }));
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * The checklists of a pack with their items in order, and the guides that
 * are not the note of a single location, built once when a pack loads.
 */
export class ChecklistIndex {
  /** Checklists in order. */
  readonly checklists: readonly ChecklistEntry[];
  /**
   * Guides that are not the note of exactly one location (a walkthrough, a
   * chapter, a guide shared by many places), in order.
   */
  readonly guides: readonly GuideEntry[];

  private readonly checklistById = new Map<string, ChecklistEntry>();
  private readonly itemById = new Map<string, ChecklistItemEntry>();
  private readonly checklistOfItem = new Map<string, ChecklistEntry>();
  private readonly guideById = new Map<string, GuideEntry>();
  private readonly standalone = new Set<string>();
  private readonly itemsByLocation = new Map<string, ChecklistItemEntry[]>();
  private readonly guidesByLocation = new Map<string, GuideEntry[]>();

  constructor(pack: LoadedPack, isTrackable: (locationId: string) => boolean) {
    const itemsOf = new Map<string, ChecklistItem[]>();
    for (const item of pack.data.checklistItems) {
      const list = itemsOf.get(item.checklistId);
      if (list) list.push(item);
      else itemsOf.set(item.checklistId, [item]);
    }
    const byOrder = <T extends { order: number; name: string }>(a: T, b: T) =>
      a.order - b.order || collator.compare(a.name, b.name);

    this.checklists = [...pack.data.checklists].sort(byOrder).map((checklist) => {
      const items = (itemsOf.get(checklist.id) ?? []).sort(byOrder).map((item, index) => {
        const places = unique(item.locationIds.filter((id) => pack.locations.has(id)));
        const targets = places.filter(isTrackable);
        return { item, index, places, targets, ownMark: targets.length === 0 };
      });
      const entry = { checklist, items };
      this.checklistById.set(checklist.id, entry);
      for (const item of items) {
        this.itemById.set(item.item.id, item);
        this.checklistOfItem.set(item.item.id, entry);
        for (const place of item.places) push(this.itemsByLocation, place, item);
      }
      return entry;
    });

    // A guide is a location's note when exactly one location is tied to it,
    // by the guide's own list or by the location's `guideId`.
    const guideLocations = new Map<string, Set<string>>();
    for (const guide of pack.data.guides) guideLocations.set(guide.id, new Set(guide.locationIds));
    for (const location of pack.data.locations) {
      if (location.guideId) guideLocations.get(location.guideId)?.add(location.id);
    }
    for (const guide of pack.data.guides) {
      this.guideById.set(guide.id, guide);
      if (guideLocations.get(guide.id)!.size !== 1) this.standalone.add(guide.id);
    }
    this.guides = pack.data.guides
      .filter((guide) => this.standalone.has(guide.id))
      .sort(
        (a, b) =>
          (a.order ?? Infinity) - (b.order ?? Infinity) ||
          // Two guides without an order compare as NaN above; fall through to the title.
          collator.compare(a.title, b.title),
      );
    for (const guide of this.guides) {
      for (const locationId of unique(guide.locationIds)) {
        push(this.guidesByLocation, locationId, guide);
      }
    }
  }

  /** Whether the pack has nothing to show on the checklists and guides screen. */
  get isEmpty(): boolean {
    return this.checklists.length === 0 && this.guides.length === 0;
  }

  checklist(id: string): ChecklistEntry | undefined {
    return this.checklistById.get(id);
  }

  item(id: string): ChecklistItemEntry | undefined {
    return this.itemById.get(id);
  }

  /** The checklist an item belongs to. */
  checklistOf(itemId: string): ChecklistEntry | undefined {
    return this.checklistOfItem.get(itemId);
  }

  /** Any guide of the pack, listed or not. */
  guide(id: string): GuideEntry | undefined {
    return this.guideById.get(id);
  }

  /** Whether a guide is listed on its own, rather than being one location's note. */
  isListed(guideId: string): boolean {
    return this.standalone.has(guideId);
  }

  /** Checklist items that name a location. */
  itemsAt(locationId: string): readonly ChecklistItemEntry[] {
    return this.itemsByLocation.get(locationId) ?? [];
  }

  /** Listed guides whose own list names a location. */
  guidesAt(locationId: string): readonly GuideEntry[] {
    return this.guidesByLocation.get(locationId) ?? [];
  }

  /** Done items across every checklist. */
  tally(isDone: IsDone): ChecklistTally {
    let done = 0;
    let total = 0;
    for (const entry of this.checklists) {
      const t = checklistTally(entry, isDone);
      done += t.done;
      total += t.total;
    }
    return { done, total };
  }
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function push<T>(index: Map<string, T[]>, key: string, value: T): void {
  const list = index.get(key);
  if (list) list.push(value);
  else index.set(key, [value]);
}
