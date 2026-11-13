import {
  EVERYTHING_ID,
  NO_AREA,
  everythingList,
  itemState,
  listAreas,
  listShape,
  listStages,
  nextStep,
  regionTarget,
  viewportSize,
  type ChecklistEntry,
  type ItemState,
  type ListAreas,
  type ListShape,
  type ListView,
  type Stage,
} from '@atlas/core';
import { useMemo } from 'react';
import { create } from 'zustand';
import { moveMap, saveSetting, showMap } from '../state/actions';
import { openChecklistPage } from '../state/checklists';
import { SETTINGS, progressStore } from '../state/services';
import { useAtlas, type LoadedGame } from '../state/store';

/**
 * What the standard layout's Lists keeps about lists: the view each was
 * last shown in, the one opened last, and whether an open list is shown
 * alone on the map. Kept per game on this device, in the settings, as
 * conveniences; nothing here is progress.
 */

/** The three ways to show a list (see `listShape`). */
export type { ListView };

const VIEWS: readonly ListView[] = ['area', 'kind', 'order'];

interface ListsState {
  /** The view each list was last shown in, by list id. */
  views: Readonly<Record<string, ListView>>;
  /** The list opened last in this game, or null. */
  lastListId: string | null;
  /** Show an open list alone on the map. */
  onlyOnMap: boolean;
  /**
   * Where "In order" looks for the next step from, after "Skip for now",
   * for one list. Not kept: a new visit starts from the top.
   */
  orderFrom: { listId: string; from: number } | null;
  /** The list on screen and the view it is shown in, while one is. */
  frameView: { listId: string; view: ListView } | null;
}

export const useLists = create<ListsState>()(() => ({
  views: {},
  lastListId: null,
  onlyOnMap: true,
  orderFrom: null,
  frameView: null,
}));

// ---------------------------------------------------------------------------
// The lists of a game

const everythingByPack = new WeakMap<LoadedGame['pack'], ChecklistEntry>();

/** Every trackable place of the game as one list, made once per pack. */
export function everythingOf(game: LoadedGame): ChecklistEntry {
  let entry = everythingByPack.get(game.pack);
  if (!entry) {
    entry = everythingList(game.pack, (id) => game.counter.isTrackable(id));
    everythingByPack.set(game.pack, entry);
  }
  return entry;
}

/** A list by id: one of the pack's, or Everything. */
export function listById(game: LoadedGame, id: string): ChecklistEntry | undefined {
  return id === EVERYTHING_ID ? everythingOf(game) : game.checklists.checklist(id);
}

/** The name of an area of a list: its top-level region, or "No area". */
export function areaName(game: LoadedGame, area: string): string {
  return area === NO_AREA ? 'No area' : (game.pack.regions.get(area)?.name ?? 'No area');
}

function cached<K extends object, V>(make: (key: K) => V): (key: K) => V {
  const cache = new WeakMap<K, V>();
  return (key) => {
    let value = cache.get(key);
    if (value === undefined) {
      value = make(key);
      cache.set(key, value);
    }
    return value;
  };
}

/** How a list is shown: its type, views, default view and steps (see `listShape`). */
export const shapeOf = cached((entry: ChecklistEntry): ListShape => listShape(entry));

/**
 * A list meant to be followed step by step (a route or a build, see
 * `listShape`): the only kind of list that has a next step, and that is
 * listed under Routes.
 */
export const isRoute = (entry: ChecklistEntry) => shapeOf(entry).steps;

/** Every place of a list's items, to show the list alone on the map. */
export const placesOf = cached((entry: ChecklistEntry): ReadonlySet<string> => {
  const places = new Set<string>();
  for (const item of entry.items) for (const id of item.places) places.add(id);
  return places;
});

/** A list's stages (see `listStages`). */
export const stagesOf = cached((entry: ChecklistEntry): Stage[] => listStages(entry));

const areasByPack = new WeakMap<LoadedGame['pack'], WeakMap<ChecklistEntry, ListAreas>>();

/** A list's items by area, worked out once per list. */
export function areasOf(game: LoadedGame, entry: ChecklistEntry): ListAreas {
  let byEntry = areasByPack.get(game.pack);
  if (!byEntry) {
    byEntry = new WeakMap();
    areasByPack.set(game.pack, byEntry);
  }
  let areas = byEntry.get(entry);
  if (!areas) {
    areas = listAreas(entry, game.pack);
    byEntry.set(entry, areas);
  }
  return areas;
}

/** What a list's figures count: places found, or (a route, a list of things to do) entries done. */
export function doneWord(entry: ChecklistEntry): 'found' | 'done' {
  return shapeOf(entry).doneWord;
}

/**
 * The views a list offers. What the list is decides (see `listShape`): a
 * route is followed in order, and can be grouped as well; a build is
 * followed in order only; a collection is grouped by area or by kind, and
 * is not offered in order. A plain list, or a list with no place at all, is
 * shown as it is written, with no choice.
 */
export function viewsOf(entry: ChecklistEntry): readonly ListView[] {
  return shapeOf(entry).views;
}

/** The view a list opens in until one is chosen: in order for a route, by area for a collection. */
export function defaultView(entry: ChecklistEntry): ListView {
  return shapeOf(entry).defaultView;
}

/** The view a list is shown in: the one chosen last if the list offers it, or its default. */
export function useListView(entry: ChecklistEntry): ListView {
  return useLists((s) => {
    const chosen = s.views[entry.checklist.id];
    return chosen !== undefined && viewsOf(entry).includes(chosen) ? chosen : defaultView(entry);
  });
}

/** The state of each item of a list, worked out again when progress changes. */
export function useItemStates(entry: ChecklistEntry): ItemState[] {
  const found = useAtlas((s) => s.found);
  return useMemo(() => {
    const isDone = (id: string) => found.has(id);
    return entry.items.map((item) => itemState(item, isDone));
  }, [entry, found]);
}

/**
 * The step a route or a build points at (see `nextStep`): null when every
 * step is done, and for any list that is not followed step by step.
 */
export function useNextStep(entry: ChecklistEntry, states: readonly ItemState[]): number | null {
  const from = useLists((s) => (s.orderFrom?.listId === entry.checklist.id ? s.orderFrom.from : 0));
  const route = isRoute(entry);
  return useMemo(() => (route ? nextStep(states, from) : null), [route, states, from]);
}

/** "Skip for now": the step after `index` becomes the next one, without marking anything. */
export function skipStep(entry: ChecklistEntry, index: number): void {
  useLists.setState({ orderFrom: { listId: entry.checklist.id, from: index + 1 } });
}

// ---------------------------------------------------------------------------
// Kept on this device

let loadedGame: LoadedGame | null = null;

function parseViews(value: unknown): Record<string, ListView> {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, ListView] =>
      VIEWS.includes(entry[1] as ListView),
    ),
  );
}

/** Reads what is kept about the lists of a game. */
export async function loadListPrefs(game: LoadedGame): Promise<void> {
  loadedGame = game;
  const gameId = game.pack.manifest.gameId;
  useLists.setState({ views: {}, lastListId: null, orderFrom: null });
  try {
    const store = progressStore();
    const [views, last, only] = await Promise.all([
      store.getSetting(SETTINGS.listViews(gameId)),
      store.getSetting(SETTINGS.lastList(gameId)),
      store.getSetting(SETTINGS.listOnlyOnMap),
    ]);
    if (loadedGame !== game) return;
    useLists.setState({
      views: parseViews(views),
      lastListId: typeof last === 'string' && listById(game, last) ? last : null,
      onlyOnMap: typeof only === 'boolean' ? only : true,
    });
  } catch {
    // The defaults stand.
  }
}

/** Shows a list in a view, and keeps that for the next time it opens. */
export function chooseView(listId: string, view: ListView): void {
  const game = useAtlas.getState().game;
  const views = { ...useLists.getState().views, [listId]: view };
  useLists.setState({ views });
  if (game) saveSetting(SETTINGS.listViews(game.pack.manifest.gameId), views);
}

export function setOnlyOnMap(on: boolean): void {
  useLists.setState({ onlyOnMap: on });
  saveSetting(SETTINGS.listOnlyOnMap, on);
}

// ---------------------------------------------------------------------------
// Following the open list

/** The list the Lists section has open (in any view, or one of its areas), if any. */
export function openListOf(
  state: ReturnType<typeof useAtlas.getState>,
): ChecklistEntry | undefined {
  const page = state.checklistPages.at(-1);
  return state.game && page?.kind === 'checklist' ? listById(state.game, page.id) : undefined;
}

/**
 * Keeps up with the list that is open: it is remembered as the one to
 * continue, and, while "Only this list on the map" is on, its places are
 * the only ones on the map (the filters stay as they are, see `listOnly`).
 */
export function followOpenList(): void {
  const atlas = useAtlas.getState();
  const lists = useLists.getState();
  const entry = openListOf(atlas);
  if (entry && atlas.game && lists.lastListId !== entry.checklist.id) {
    useLists.setState({ lastListId: entry.checklist.id });
    saveSetting(SETTINGS.lastList(atlas.game.pack.manifest.gameId), entry.checklist.id);
  }
  if (entry?.checklist.id !== lists.orderFrom?.listId && lists.orderFrom) {
    useLists.setState({ orderFrom: null });
  }
  const places = entry ? placesOf(entry) : null;
  const only = lists.onlyOnMap && places && places.size > 0 ? places : null;
  if (atlas.listOnly !== only) useAtlas.setState({ listOnly: only });
}

/** Opens one area of a list; `replace` swaps the area shown for it, so Back still leads to the list. */
export function openArea(listId: string, area: string, replace = false): void {
  const pages = useAtlas.getState().checklistPages;
  const top = pages.at(-1);
  if (replace && top?.kind === 'checklist' && top.area !== undefined) {
    useAtlas.setState({
      checklistPages: [...pages.slice(0, -1), { kind: 'checklist', id: listId, area }],
    });
    return;
  }
  openChecklistPage({ kind: 'checklist', id: listId, area });
}

// ---------------------------------------------------------------------------
// The map

/**
 * Moves the map to show a set of places: on the layer shown when some are
 * on it, else on the layer that has the most of them, fitting them all.
 */
export function fitPlaces(game: LoadedGame, ids: readonly string[]): void {
  const { layerId, view } = useAtlas.getState();
  const byLayer = new Map<string, { x: number; y: number }[]>();
  for (const id of ids) {
    const location = game.pack.locations.get(id);
    if (!location) continue;
    const list = byLayer.get(location.layerId);
    if (list) list.push(location);
    else byLayer.set(location.layerId, [location]);
  }
  let target = layerId && byLayer.has(layerId) ? layerId : null;
  if (!target) {
    let most = 0;
    for (const [id, points] of byLayer) {
      if (points.length > most) {
        most = points.length;
        target = id;
      }
    }
  }
  const layer = target ? game.pack.layers.get(target) : undefined;
  if (!layer) return;
  const shown = layerId ? game.pack.layers.get(layerId) : undefined;
  const viewport =
    view && shown
      ? viewportSize(view, shown.maxZoom)
      : { width: window.innerWidth, height: window.innerHeight };
  const points = byLayer.get(layer.id)!;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const fit = regionTarget(
    {
      polygon: [
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY],
      ],
    },
    layer,
    viewport,
  );
  if (!fit) return;
  const changes = layer.id !== layerId;
  if (changes) showMap(layer.mapId, layer.id);
  // One place: as close as showing a place goes.
  const zoom = points.length === 1 ? Math.max(fit.zoom, layer.maxZoom - 1) : fit.zoom;
  moveMap(fit.x, fit.y, { zoom, animate: !changes });
}

/** Moves the map to a place, closer if it is far out, without selecting it. */
export function centreOn(game: LoadedGame, locationId: string): void {
  const location = game.pack.locations.get(locationId);
  const layer = location ? game.pack.layers.get(location.layerId) : undefined;
  if (!location || !layer) return;
  const changes = layer.id !== useAtlas.getState().layerId;
  if (changes) showMap(layer.mapId, layer.id);
  const zoom = Math.max(useAtlas.getState().view?.zoom ?? 0, layer.maxZoom - 1);
  moveMap(location.x, location.y, { zoom, animate: !changes });
}

// ---------------------------------------------------------------------------
// Keys

/** What F and N do while a list is shown in order (see `TouchShell`); each returns whether it acted. */
export interface OrderKeys {
  done: () => boolean;
  next: () => boolean;
}

let orderKeys: OrderKeys | null = null;

/** Set by the "In order" view while it is shown; null gives the keys back. */
export function setOrderKeys(keys: OrderKeys | null): void {
  orderKeys = keys;
}

export function orderKeyDone(): boolean {
  return orderKeys?.done() ?? false;
}

export function orderKeyNext(): boolean {
  return orderKeys?.next() ?? false;
}
