import { overridesShowingOnly, type SearchEntry, type VisibilityOverrides } from '@atlas/core';
import { create } from 'zustand';
import { canKeepScreenOn, keepScreenOn } from '../androidBars';
import { notify, saveSetting, setFound, setOverrides } from '../state/actions';
import { SETTINGS, progressStore } from '../state/services';
import { useAtlas, type LoadedGame } from '../state/store';
import type { Section } from './backStack';
import type { Arrangement } from './layout';
import { parseRecent, withRecent, type RecentRef } from './recent';

/**
 * The touch layout's own state: which section is shown and which sheet is
 * open. Everything else (the map, the selection, filters, progress,
 * checklists) is the app's store, changed through its actions.
 */

export type SearchScope = 'all' | 'places' | 'unfound' | 'lists';

/** One kind shown alone from its chip, and the choices to go back to. */
export interface Solo {
  categoryId: string;
  /** The category choices before the kind was shown alone. */
  before: VisibilityOverrides;
  /** The choices that show the kind alone; once they change, the chip lets go. */
  applied: VisibilityOverrides;
}

export interface TouchState {
  /** How the layout is arranged for the window (see `layout.ts`). */
  arrangement: Arrangement;
  section: Section;
  /** Search is open: full screen on a phone, in the panel on a wide screen. */
  search: boolean;
  query: string;
  scope: SearchScope;
  /** The filters sheet (compact only; the wide panel shows the filters anyway). */
  filters: boolean;
  /** The list of maps and levels. */
  mapsMenu: boolean;
  /** The place sheet is pulled up to show everything. */
  placeExpanded: boolean;
  solo: Solo | null;
  /** Results chosen earlier in this game, latest first. */
  recent: RecentRef[];
  keepScreenOn: boolean;
  /** Whether this device can keep the screen on at all. */
  screenOnOffered: boolean;
}

export const useTouch = create<TouchState>()(() => ({
  arrangement: 'compact',
  section: 'map',
  search: false,
  query: '',
  scope: 'all',
  filters: false,
  mapsMenu: false,
  placeExpanded: false,
  solo: null,
  recent: [],
  keepScreenOn: true,
  screenOnOffered: false,
}));

const get = useTouch.getState;
const set = useTouch.setState;

export function showSection(section: Section): void {
  set({ section, search: false, filters: false, mapsMenu: false });
}

export function openSearch(): void {
  set({ search: true, filters: false, mapsMenu: false });
}

/** Closes search and forgets what was typed. */
export function closeSearch(): void {
  set({ search: false, query: '' });
}

export function setQuery(query: string): void {
  set({ query });
}

export function setScope(scope: SearchScope): void {
  set({ scope });
}

export function setFiltersOpen(open: boolean): void {
  set({ filters: open, ...(open ? { mapsMenu: false, search: false } : {}) });
}

export function setMapsMenuOpen(open: boolean): void {
  set({ mapsMenu: open });
}

export function setPlaceExpanded(expanded: boolean): void {
  set({ placeExpanded: expanded });
}

// ---------------------------------------------------------------------------
// Marking places

/**
 * Marks a place found or not from the touch layout, and says so with an
 * Undo button. Places of a kind that is not tracked cannot be marked.
 */
export function markFound(locationId: string, found: boolean): boolean {
  const { game } = useAtlas.getState();
  const location = game?.pack.locations.get(locationId);
  if (!game || !location) return false;
  if (!game.counter.isTrackable(locationId)) {
    const kind = game.pack.categories.get(location.categoryId)?.name ?? 'This kind';
    notify(`${kind} is not tracked.`);
    return false;
  }
  if (!setFound(locationId, found)) return false;
  notify(found ? 'Marked found' : 'Marked not found', 'info', { undo: true });
  return true;
}

/** Press and hold on a marker: flips it at once, with a short buzz where the device has one. */
export function markFromHold(locationId: string): void {
  const found = useAtlas.getState().found.has(locationId);
  if (markFound(locationId, !found)) {
    try {
      if ('vibrate' in navigator) navigator.vibrate(30);
    } catch {
      // Some browsers refuse; the notice still says what happened.
    }
  }
}

// ---------------------------------------------------------------------------
// One kind alone

const sameOverrides = (a: VisibilityOverrides, b: VisibilityOverrides) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
};

/** The kind shown alone from its chip, while the filters are still as that left them. */
export function soloKind(state: Pick<TouchState, 'solo'>, overrides: VisibilityOverrides) {
  return state.solo && sameOverrides(state.solo.applied, overrides) ? state.solo.categoryId : null;
}

/**
 * Shows only one kind on the map; asked again for the same kind, puts the
 * filters back as they were before.
 */
export function toggleSolo(categoryId: string): void {
  const { game, overrides } = useAtlas.getState();
  if (!game) return;
  const active = soloKind(get(), overrides);
  if (active === categoryId) {
    setOverrides(get().solo!.before);
    set({ solo: null });
    return;
  }
  const before = active ? get().solo!.before : overrides;
  const applied = overridesShowingOnly(game.pack.data.categories, [categoryId]);
  setOverrides(applied);
  set({ solo: { categoryId, before, applied } });
}

/** Shows one kind alone (from "Browse by kind"), keeping how to go back. */
export function showOnlyKind(categoryId: string): void {
  if (soloKind(get(), useAtlas.getState().overrides) !== categoryId) toggleSolo(categoryId);
}

// ---------------------------------------------------------------------------
// Recent results

/** Reads the results chosen earlier in this game. */
export async function loadRecent(game: LoadedGame): Promise<void> {
  try {
    const stored = await progressStore().getSetting(
      SETTINGS.recentSearches(game.pack.manifest.gameId),
    );
    if (useAtlas.getState().game === game) set({ recent: parseRecent(stored) });
  } catch {
    set({ recent: [] });
  }
}

export function rememberResult(entry: Pick<SearchEntry, 'kind' | 'id'>): void {
  const { game } = useAtlas.getState();
  if (!game) return;
  const recent = withRecent(get().recent, { kind: entry.kind, id: entry.id });
  set({ recent });
  saveSetting(SETTINGS.recentSearches(game.pack.manifest.gameId), recent);
}

// ---------------------------------------------------------------------------
// Keeping the screen on

/** Reads the setting (on unless turned off) and applies it. */
export async function loadKeepScreenOn(): Promise<void> {
  let on = true;
  try {
    on = (await progressStore().getSetting(SETTINGS.keepScreenOn)) !== false;
  } catch {
    // The default stands.
  }
  set({ keepScreenOn: on, screenOnOffered: canKeepScreenOn() });
  keepScreenOn(on);
}

export function setKeepScreenOn(on: boolean): void {
  set({ keepScreenOn: on });
  keepScreenOn(on);
  saveSetting(SETTINGS.keepScreenOn, on);
}
