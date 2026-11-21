import { regionTarget } from '@atlas/core';
import type { LoadedPack } from '@atlas/core';
import { create } from 'zustand';
import type { MapEntryOptions } from '../markdownEntries';
import { goToLocation, moveMap, notify, showMap } from './actions';
import { guidesOf } from './guides';
import { useGuideLinks } from './guideLinks';
import { linkedTargets } from './guideMatches';
import { canChangeOwnLocations, useOwnLocations } from './ownLocations';
import { useAtlas, type LoadedGame } from './store';
import { linkPageAt } from './wikiSearch';

/**
 * Entries of a wiki page on the map (see `markdownEntries.ts`), and an
 * entry put on the map.
 *
 * - The locations of a page are those the pack gives it (`locationIds`)
 *   and those it is linked to by a location of its own or a location name
 *   (see `guideLinks.ts`); a page linked to a whole type or region is about
 *   many things, not one entry on the map, and counts for none.
 * - A plain name is an entry only when one location of the game, and no
 *   other, has exactly that name (letters' case aside).
 * - "Put it on the map": the person presses the map where the entry is and
 *   chooses its type, in Edit locations; the new location is their own,
 *   named after the entry, and linked to the entry's page (or the page the
 *   entry is on), so the page shows on its card under From the wiki.
 */

/** The most locations an entry's list shows before "Show all on the map". */
export const ENTRY_LIST_MAX = 8;

interface NameIndex {
  byName: Map<string, string | null>;
}

const namesByPack = new WeakMap<LoadedPack, NameIndex>();

const nameKey = (name: string) => name.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');

/** The one location of a pack with a name, by the name; null for a name several share. */
function nameIndex(pack: LoadedPack): NameIndex {
  let index = namesByPack.get(pack);
  if (!index) {
    const byName = new Map<string, string | null>();
    for (const location of pack.data.locations) {
      const key = nameKey(location.name);
      byName.set(key, byName.has(key) ? null : location.id);
    }
    index = { byName };
    namesByPack.set(pack, index);
  }
  return index;
}

/** The location of the game with exactly this name, when no other has it. */
export function locationNamed(game: LoadedGame, name: string): string | null {
  return nameIndex(game.pack).byName.get(nameKey(name)) ?? null;
}

/** The locations a page stands for on the map of the game shown, each once. */
export function pageLocations(game: LoadedGame, guideId: string): string[] {
  const ids = new Set<string>();
  const guide = guidesOf(game).contents.guide(guideId);
  for (const id of guide?.locationIds ?? []) {
    if (game.pack.locations.has(id)) ids.add(id);
  }
  const links = useGuideLinks.getState();
  if (links.gameId === game.pack.manifest.gameId) {
    for (const info of linkedTargets(game, links.links.choices[guideId])) {
      if (info.what === 'location' || info.what === 'name') {
        for (const id of info.locations) ids.add(id);
      }
    }
  }
  return [...ids];
}

/** What makes an entry of a page one on the map, for the game shown. */
export function mapEntryOptions(game: LoadedGame, adding: boolean): MapEntryOptions {
  return {
    pageLocations: (guideId) => pageLocations(game, guideId),
    nameLocation: (name) => locationNamed(game, name),
    isLocation: (id) => game.pack.locations.has(game.pack.currentId(id)),
    ...(adding ? { adding: true } : {}),
  };
}

/** The locations of a mark's entry. */
export function entryLocations(game: LoadedGame, kind: string, id: string): string[] {
  if (kind === 'page') return pageLocations(game, id);
  const current = game.pack.currentId(id);
  return game.pack.locations.has(current) ? [current] : [];
}

/**
 * Shows several locations on the map: on the map most of them are on,
 * fitted into view. The first is selected when there is one alone.
 */
export function showLocationsOnMap(ids: readonly string[]): void {
  const { game } = useAtlas.getState();
  if (!game) return;
  const locations = ids.flatMap((id) => game.pack.locations.get(id) ?? []);
  if (locations.length === 0) return;
  if (locations.length === 1) {
    goToLocation(locations[0]!.id);
    return;
  }
  const count = new Map<string, number>();
  for (const l of locations) count.set(l.layerId, (count.get(l.layerId) ?? 0) + 1);
  const layerId = [...count].sort((a, b) => b[1] - a[1])[0]![0];
  const layer = game.pack.layers.get(layerId);
  if (!layer) return;
  const on = locations.filter((l) => l.layerId === layerId);
  showMap(layer.mapId, layerId);
  const xs = on.map((l) => l.x);
  const ys = on.map((l) => l.y);
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  // A margin around them, so none stands on the edge.
  const pad = Math.max(maxX - minX, maxY - minY, 64) * 0.15;
  const polygon: [number, number][] = [
    [minX - pad, minY - pad],
    [maxX + pad, minY - pad],
    [maxX + pad, maxY + pad],
    [minX - pad, maxY + pad],
  ];
  const map = document.querySelector('[data-testid="map"]');
  const viewport = map
    ? { width: map.clientWidth, height: map.clientHeight }
    : { width: window.innerWidth, height: window.innerHeight };
  const target = regionTarget({ polygon }, layer, viewport);
  if (!target) return;
  useAtlas.setState({ selectedId: null });
  moveMap(target.x, target.y, { zoom: target.zoom });
  if (on.length < locations.length) {
    notify(
      `${locations.length - on.length} of them ${locations.length - on.length === 1 ? 'is' : 'are'} on another map.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Putting an entry on the map

/** An entry waiting to be put on the map: its words, and the page it is linked to. */
export interface PendingEntry {
  name: string;
  guideId: string;
}

export interface MapEntriesState {
  /** The entry waiting for a press on the map. */
  pending: PendingEntry | null;
  /** Whether pages mark the entries not on the map, to put them there. */
  adding: boolean;
  /** Whether the layout shown can put entries on the map. */
  canPut: boolean;
}

export const useMapEntries = create<MapEntriesState>()(() => ({
  pending: null,
  adding: false,
  canPut: false,
}));

/** Why entries cannot be put on the map now, or null when they can. */
export function whyNoEntryAdding(): string | null {
  if (!canChangeOwnLocations()) {
    return (
      useOwnLocations.getState().readOnly ??
      'Your own locations cannot be changed now. Try again in a moment.'
    );
  }
  return null;
}

/** Turns the marks that put entries on the map on or off. */
export function setEntryAdding(on: boolean): void {
  useMapEntries.setState({ adding: on });
}

/** Starts putting an entry on the map: Edit locations, waiting for a press on the map. */
export function startEntry(entry: PendingEntry, startEditing: () => void): boolean {
  const why = whyNoEntryAdding();
  if (why) {
    notify(why, 'error');
    return false;
  }
  useMapEntries.setState({ pending: entry });
  startEditing();
  return true;
}

/** Stops waiting for an entry to be put on the map. */
export function cancelEntry(): void {
  if (useMapEntries.getState().pending) useMapEntries.setState({ pending: null });
}

/**
 * Links a new location of the person's own to the page of the entry that
 * waited, and says so. Returns whether it did.
 */
export function linkNewLocation(locationId: string): boolean {
  const { pending } = useMapEntries.getState();
  const { game } = useAtlas.getState();
  if (!pending || !game) return false;
  useMapEntries.setState({ pending: null });
  const why = linkPageAt(game, pending.guideId, locationId, 'location');
  const title = guidesOf(game).contents.guide(pending.guideId)?.title ?? 'the page';
  if (why) notify(why, 'error');
  else notify(`“${pending.name}” is on the map, linked to “${title}”.`);
  return why === null;
}

// ---------------------------------------------------------------------------
// What the layout shown does with an entry

/** How the layout shown shows several locations, and puts an entry on the map where it can. */
export interface EntryActions {
  showAll: (ids: readonly string[], label: string) => void;
  /** Null where entries cannot be put on the map (no room for Edit locations). */
  putOnMap: ((entry: PendingEntry) => void) | null;
}

const DEFAULT_ACTIONS: EntryActions = {
  showAll: (ids) => {
    showLocationsOnMap(ids);
  },
  putOnMap: null,
};

let actions: EntryActions = DEFAULT_ACTIONS;

/** Says what the layout shown does with entries; null goes back to the plain way. */
export function provideEntryActions(given: EntryActions | null): void {
  actions = given ?? DEFAULT_ACTIONS;
  const canPut = actions.putOnMap !== null;
  useMapEntries.setState((s) => ({ canPut, adding: canPut && s.adding }));
}

/** Shows an entry's locations: one alone selected on the map, several together. */
export function showEntryLocations(ids: readonly string[], label: string): void {
  actions.showAll(ids, label);
}

/** Puts an entry on the map, where the layout can. */
export function putEntryOnMap(entry: PendingEntry): void {
  actions.putOnMap?.(entry);
}
