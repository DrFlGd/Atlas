import {
  ChecklistIndex,
  ProgressCounter,
  SearchIndex,
  buildExport,
  deletedProfile,
  duplicateProfile as duplicateProfileRecords,
  loadPack,
  nearestUnfound,
  newProfile,
  newUserPreset,
  overridesShowingOnly,
  planImport,
  progressRow,
  regionTarget,
  renamedProfile,
  resolveProgress,
  viewportSize,
  visibleCategoryIds,
  type ExportFile,
  type ExportSelection,
  type ImportMode,
  type ImportPlan,
  type PackEntry,
  type Profile,
  type ProgressChange,
  type ProgressRecord,
  type ProgressSource,
  type VisibilityOverrides,
} from '@atlas/core';
import { applyQueryOverrides, loadCatalog, loadRuntimeConfig } from '../config';
import { desktop } from '../desktop';
import { forgetRequestedUi, parseLayout, sessionStore, type Layout } from '../touch/uiMode';
import type { HashView } from '../viewHash';
import { catalogFrom } from './library';
import { loadMapImages } from './mapImages';
import { SETTINGS, clock, openProgressStore, progressStore } from './services';
import { packWithOwn, readOwnLocationsOf } from './ownLocations';
import { useAtlas, type AtlasState, type PaneName, type Theme, type UndoEntry } from './store';

const get = useAtlas.getState;
const set = useAtlas.setState;

/** Below this width the side panes become bottom sheets over the map. */
export const NARROW_QUERY = '(max-width: 899px)';
export const isNarrow = () => window.matchMedia(NARROW_QUERY).matches;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

let noticeSeq = 0;
/** Shows a notice. With `undo`, it reports a change that undo takes back (see `Notice`). */
export function notify(
  text: string,
  tone: 'info' | 'error' = 'info',
  options: { undo?: boolean; action?: { label: string; run: () => void } } = {},
): void {
  set({
    notice: {
      text,
      tone,
      seq: ++noticeSeq,
      ...(options.undo ? { undo: true } : {}),
      ...(options.action ? { action: options.action } : {}),
    },
  });
}

export function saveSetting(key: string, value: unknown): void {
  progressStore()
    .putSetting(key, value)
    .catch(() => {
      // Settings are conveniences; losing one is not worth interrupting the user.
    });
}

// ---------------------------------------------------------------------------
// Startup and packs

let loadToken = 0;

/** Reads the configuration and pack catalog, opens storage and loads the first pack. */
export async function boot(initialView: HashView | null): Promise<void> {
  try {
    const config = applyQueryOverrides(await loadRuntimeConfig(), window.location.search);
    const { store, persistent } = await openProgressStore();
    const savedTheme = await store.getSetting(SETTINGS.theme);
    const theme: Theme =
      savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : config.theme;
    const layout = parseLayout(await store.getSetting(SETTINGS.layout));
    const savedPanes = (await store.getSetting(SETTINGS.panes)) as
      Partial<Record<PaneName, boolean>> | undefined;
    const narrow = isNarrow();
    document.documentElement.dataset.theme = theme;
    set({
      config,
      theme,
      layout,
      persistent,
      panes: {
        filters: !narrow && (savedPanes?.filters ?? true),
        details: !narrow && (savedPanes?.details ?? true),
      },
    });
    let catalog = await loadCatalog(config);
    set({ bundledCatalog: catalog });
    if (desktop) {
      // The packs that come with the app, then those in the maps folder and
      // the folders the person added. Without a listing, the first ones only.
      const [app, listing] = await Promise.all([
        desktop.info().catch(() => null),
        desktop.library.list().catch((error: unknown) => {
          console.error(error);
          return null;
        }),
      ]);
      catalog = catalogFrom(catalog, listing);
      set({ app, library: listing });
    }
    set({ catalog });
    const savedPack = await store.getSetting(SETTINGS.activePack);
    const entry = catalog.find((p) => p.id === savedPack) ?? catalog[0]!;
    const loaded = await loadGame(entry, initialView);
    // A pack in a folder can be broken or gone; show another rather than stopping.
    const other = catalog.find((p) => p.id !== entry.id);
    if (!loaded && other) {
      const reason = get().status;
      await loadGame(other);
      notify(
        `Could not open ${entry.title}${reason.kind === 'error' ? `: ${reason.message}` : '.'} Showing ${other.title} instead.`,
        'error',
      );
    }
    if (!persistent) {
      notify(
        'This browser does not allow saving data, so progress lasts only until the page closes.',
        'error',
      );
    }
  } catch (error) {
    set({ status: { kind: 'error', message: errorText(error) } });
  }
}

/**
 * Loads a pack and the user state that belongs to its game. Returns whether
 * it was loaded. If it cannot be and another game is shown, that game stays
 * and the reason is shown as a notice.
 */
export async function loadGame(
  entry: PackEntry,
  initialView: HashView | null = null,
): Promise<boolean> {
  const token = ++loadToken;
  const previous = get().game;
  set({ status: { kind: 'loading' } });
  try {
    const store = progressStore();
    const read = await loadPack(entry.url);
    const gameId = read.manifest.gameId;
    // The person's own locations, types and areas, added to the game's.
    const mine = await readOwnLocationsOf(gameId);
    if (token !== loadToken) return false;
    const { pack, skipped: ownSkipped } = packWithOwn(read, mine.own);
    const counter = new ProgressCounter(pack);
    const search = new SearchIndex(pack);
    const checklists = new ChecklistIndex(pack, (id) => counter.isTrackable(id));

    let profiles = await store.listProfiles(gameId);
    if (profiles.length === 0) {
      const first = newProfile(gameId, 'Playthrough 1', clock());
      await store.write({ profiles: [first] });
      profiles = [first];
    }
    const savedProfile = await store.getSetting(SETTINGS.profile(gameId));
    const profile = profiles.find((p) => p.id === savedProfile) ?? sortProfiles(profiles)[0]!;
    const rows = await store.listProgress(profile.id, { includeDeleted: true });

    const filters = (await store.getSetting(SETTINGS.filters(gameId))) as
      { overrides?: VisibilityOverrides; hideFound?: boolean; hideDone?: boolean } | undefined;
    const userPresets = await store.listPresets(gameId);

    const place = (await store.getSetting(SETTINGS.place(gameId))) as
      { mapId?: string; layerId?: string } | undefined;
    const layer =
      (place?.layerId ? pack.layers.get(place.layerId) : undefined) ??
      pack.layersOf(pack.data.maps[0]?.id ?? '')[0];
    // A game with no map (guides and lists only) has no layer to show.
    if (!layer && pack.data.maps.length > 0) throw new Error('The pack has no map layers.');

    if (token !== loadToken) return false;
    const rowMap = new Map(rows.map((r) => [r.targetId, r]));
    set({
      status: { kind: 'ready' },
      game: { entry, pack, counter, search, checklists },
      mapId: layer?.mapId ?? null,
      layerId: layer?.id ?? null,
      selectedId: null,
      hover: null,
      tileStatus: null,
      fly: initialView ? { ...initialView, animate: false, seq: 1 } : null,
      overrides: filters?.overrides ?? {},
      hideFound: filters?.hideFound ?? false,
      hideDone: filters?.hideDone ?? false,
      leftTab: checklists.isEmpty ? 'filters' : get().leftTab,
      checklistPages: [],
      itemFocus: null,
      userPresets: sortByName(userPresets),
      profiles: sortProfiles(profiles),
      profileId: profile.id,
      rows: rowMap,
      found: resolveProgress([...rowMap.values()], pack.currentId),
      undo: [],
    });
    saveSetting(SETTINGS.activePack, entry.id);
    void loadMapImages(get().game!);
    if (mine.problem) notify(mine.problem, 'error');
    else if (ownSkipped > 0) {
      notify(
        ownSkipped === 1
          ? 'One of your locations or types is not shown: its map, level or type is not in this game any more.'
          : `${ownSkipped} of your locations and types are not shown: their map, level or type is not in this game any more.`,
        'error',
      );
    }
    return true;
  } catch (error) {
    if (token !== loadToken) return false;
    if (previous) {
      set({ status: { kind: 'ready' } });
      notify(`Could not open ${entry.title}: ${errorText(error)}`, 'error');
    } else {
      set({ status: { kind: 'error', message: errorText(error) } });
    }
    return false;
  }
}

export async function switchGame(id: string): Promise<void> {
  const entry = get().catalog.find((p) => p.id === id);
  if (entry && entry.id !== get().game?.entry.id) await loadGame(entry);
}

const sortByName = <T extends { name: string }>(items: T[]) =>
  [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
const sortProfiles = (profiles: Profile[]) =>
  [...profiles].sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));

// ---------------------------------------------------------------------------
// Maps, layers, selection and movement

/** Shows a map, on the given layer or its first one. */
export function showMap(mapId: string, layerId?: string): void {
  const { game } = get();
  if (!game) return;
  const layers = game.pack.layersOf(mapId);
  const layer = layers.find((l) => l.id === layerId) ?? layers[0];
  if (!layer || layer.id === get().layerId) return;
  const selected = get().selectedId;
  const keepSelection =
    selected !== null && game.pack.locations.get(selected)?.layerId === layer.id;
  set({ mapId, layerId: layer.id, hover: null, ...(keepSelection ? {} : { selectedId: null }) });
  saveSetting(SETTINGS.place(game.pack.manifest.gameId), { mapId, layerId: layer.id });
}

/** Selects a location (or nothing). On narrow screens a selection opens the details sheet. */
export function select(locationId: string | null): void {
  set({ selectedId: locationId });
  if (locationId && isNarrow()) setPane('details', true);
}

let flySeq = 1;

/** Switches to a location's layer if needed, selects it and moves the map to it. */
export function goToLocation(locationId: string): void {
  const { game } = get();
  const location = game?.pack.locations.get(locationId);
  if (!game || !location) return;
  const changesLayer = location.layerId !== get().layerId;
  if (changesLayer) showMap(location.mapId, location.layerId);
  const layer = game.pack.layers.get(location.layerId);
  const closeZoom = layer ? layer.maxZoom - 1 : undefined;
  const current = get().view?.zoom ?? 0;
  const zoom = closeZoom === undefined ? undefined : Math.max(current, closeZoom);
  // On narrow screens the details sheet covers the lower part of the map, so
  // aim below the location to show it in the upper part.
  let y = location.y;
  if (isNarrow() && layer) {
    const scale = 2 ** ((zoom ?? current) - layer.maxZoom);
    y += (window.innerHeight * 0.2) / scale;
  }
  set({
    fly: {
      x: location.x,
      y,
      ...(zoom === undefined ? {} : { zoom }),
      animate: !changesLayer,
      seq: ++flySeq,
    },
  });
  select(locationId);
}

/** Moves the map to a point on the layer shown, at the zoom given or the current one. */
export function moveMap(x: number, y: number, options: { zoom?: number; animate?: boolean } = {}) {
  const { zoom, animate = true } = options;
  set({ fly: { x, y, ...(zoom === undefined ? {} : { zoom }), animate, seq: ++flySeq } });
}

/** Shows a map (keeping the layer shown, if it is on that map) and moves to a point on it. */
export function goToPoint(mapId: string, x: number, y: number): void {
  const { game } = get();
  if (!game) return;
  const changesMap = get().mapId !== mapId;
  if (changesMap) showMap(mapId);
  const layer = game.pack.layers.get(get().layerId ?? '');
  if (layer?.mapId !== mapId) return;
  const zoom = Math.max(get().view?.zoom ?? 0, layer.maxZoom - 2);
  set({ fly: { x, y, zoom, animate: !changesMap, seq: ++flySeq } });
}

/**
 * Moves the map to a region: to its centre, or else the middle of its
 * outline, fitting the outline when it has one (see `regionTarget`). Switches
 * to the region's map first if another map is shown. On narrow screens the
 * filter sheet closes so the map can be seen.
 */
export function goToRegion(regionId: string): void {
  const { game, view, layerId } = get();
  const region = game?.pack.regions.get(regionId);
  if (!game || !region) return;
  // The map area keeps its size across maps; measure it on the layer shown now.
  const shown = layerId ? game.pack.layers.get(layerId) : undefined;
  const viewport =
    view && shown
      ? viewportSize(view, shown.maxZoom)
      : { width: window.innerWidth, height: window.innerHeight };
  const changesMap = region.mapId !== get().mapId;
  if (changesMap) showMap(region.mapId);
  const layer = game.pack.layers.get(get().layerId ?? '');
  if (layer?.mapId !== region.mapId) return;
  const target = regionTarget(region, layer, viewport);
  if (!target) return;
  set({ fly: { ...target, animate: !changesMap, seq: ++flySeq } });
  if (isNarrow()) setPane('filters', false);
}

/** Selects the nearest visible, trackable location not yet found, measured from the selection or the map centre. */
export function jumpToNearestUnfound(): void {
  const state = get();
  const { game, layerId } = state;
  if (!game || !layerId) return;
  const selected = state.selectedId ? game.pack.locations.get(state.selectedId) : undefined;
  const from = selected?.layerId === layerId ? selected : state.view?.center;
  if (!from) return;
  const target = nearestUnfound(game.pack, layerId, from, markerFilter(state), state.selectedId);
  if (target) goToLocation(target.id);
  else notify('Every visible marker on this layer is found.');
}

export function markerFilter(
  state: Pick<AtlasState, 'game' | 'overrides' | 'hideFound' | 'found' | 'listOnly'>,
) {
  const categories = state.game?.pack.data.categories ?? [];
  const found = state.found;
  return {
    visibleCategories: visibleCategoryIds(categories, state.overrides),
    hideFound: state.hideFound,
    isFound: (id: string) => found.has(id),
    only: state.listOnly,
  };
}

// ---------------------------------------------------------------------------
// Found tracking

async function writeProgress(rows: ProgressRecord[]): Promise<void> {
  try {
    await progressStore().write({ progress: rows });
  } catch (error) {
    notify(`Could not save progress: ${errorText(error)}`, 'error');
  }
}

/**
 * Sets or clears found marks (of locations, or the own marks of checklist
 * items) in the active profile, saved together. With `undo`, the change is
 * one entry that `Z` takes back as a whole. Changes that set a mark to what
 * it is already are skipped. Returns whether anything changed.
 */
export function applyProgress(
  changes: readonly ProgressChange[],
  undo: Pick<UndoEntry, 'undone' | 'selectId'> | null,
  source: ProgressSource = 'manual',
): boolean {
  const state = get();
  const { game, profileId } = state;
  if (!game || !profileId) return false;
  const now = clock();
  const touched = changes.filter((c) => state.found.has(c.targetId) !== c.found);
  if (touched.length === 0) return false;
  const rows = new Map(state.rows);
  const written = touched.map((c) => {
    const row = progressRow(profileId, c.targetId, c.found, now, source);
    rows.set(c.targetId, row);
    return row;
  });
  const entry: UndoEntry | null = undo && {
    profileId,
    changes: touched.map((c) => ({ targetId: c.targetId, wasFound: !c.found })),
    ...undo,
    ...(source === 'manual' ? {} : { source }),
  };
  set({
    rows,
    found: resolveProgress([...rows.values()], game.pack.currentId),
    undo: entry ? [...state.undo.slice(-99), entry] : state.undo,
  });
  void writeProgress(written);
  return true;
}

/**
 * Marks a location found or not. Only trackable categories can be marked.
 * Returns whether anything changed.
 */
export function setFound(locationId: string, found: boolean): boolean {
  const { game } = get();
  if (!game?.counter.isTrackable(locationId)) return false;
  const name = game.pack.locations.get(locationId)?.name ?? locationId;
  return applyProgress([{ targetId: locationId, found }], {
    undone: `Undone: ${name} is ${found ? 'not found' : 'found'} again.`,
    selectId: locationId,
  });
}

/** Flips the found state of a location (the selection by default). */
export function toggleFound(locationId = get().selectedId): void {
  const { game, found } = get();
  if (!locationId || !game) return;
  const location = game.pack.locations.get(locationId);
  if (!location) return;
  if (!game.counter.isTrackable(locationId)) {
    notify(`${game.pack.categories.get(location.categoryId)?.name ?? 'This type'} is not tracked.`);
    return;
  }
  const next = !found.has(locationId);
  setFound(locationId, next);
  notify(`${location.name}: ${next ? 'found' : 'not found'}.`, 'info', { undo: true });
}

/** Takes back the last found change, or checklist tick, in the active profile. */
export function undo(): void {
  const { undo: stack, profileId, game } = get();
  const last = stack.at(-1);
  if (!game || last?.profileId !== profileId) {
    notify('Nothing to undo.');
    return;
  }
  set({ undo: stack.slice(0, -1) });
  applyProgress(
    last.changes.map((c) => ({ targetId: c.targetId, found: c.wasFound })),
    null,
    last.source,
  );
  notify(last.undone);
  if (last.selectId) set({ selectedId: last.selectId });
}

// ---------------------------------------------------------------------------
// Filters and presets

function saveFilters(): void {
  const { game, overrides, hideFound, hideDone } = get();
  if (game) {
    saveSetting(SETTINGS.filters(game.pack.manifest.gameId), { overrides, hideFound, hideDone });
  }
}

export function setCategoriesVisible(categoryIds: readonly string[], visible: boolean): void {
  const overrides = { ...get().overrides };
  for (const id of categoryIds) overrides[id] = visible;
  set({ overrides });
  saveFilters();
}

export function setHideFound(hideFound: boolean): void {
  set({ hideFound });
  saveFilters();
}

/** Hides done items on the checklists screen. Kept per game with the filters. */
export function setHideDone(hideDone: boolean): void {
  set({ hideDone });
  saveFilters();
}

export function applyPreset(categoryIds: readonly string[]): void {
  const { game } = get();
  if (!game) return;
  set({ overrides: overridesShowingOnly(game.pack.data.categories, categoryIds) });
  saveFilters();
}

/** Puts back category choices as they were, such as before one kind was shown alone. */
export function setOverrides(overrides: VisibilityOverrides): void {
  set({ overrides });
  saveFilters();
}

export function resetFilters(): void {
  set({ overrides: {} });
  saveFilters();
}

export async function saveUserPreset(name: string): Promise<void> {
  const state = get();
  if (!state.game || !name.trim()) return;
  const gameId = state.game.pack.manifest.gameId;
  const ids = [...visibleCategoryIds(state.game.pack.data.categories, state.overrides)];
  const preset = newUserPreset(gameId, name, ids, clock());
  await progressStore().write({ presets: [preset] });
  set({ userPresets: sortByName([...get().userPresets, preset]) });
  notify(`Saved preset “${preset.name}”.`);
}

export async function deleteUserPreset(id: string): Promise<void> {
  const preset = get().userPresets.find((p) => p.id === id);
  if (!preset) return;
  await progressStore().write({ presets: [{ ...preset, deleted: true, updatedAt: clock() }] });
  set({ userPresets: get().userPresets.filter((p) => p.id !== id) });
  notify(`Deleted preset “${preset.name}”.`);
}

// ---------------------------------------------------------------------------
// Profiles

async function refreshProfiles(activeId?: string): Promise<void> {
  const { game } = get();
  if (!game) return;
  const store = progressStore();
  const gameId = game.pack.manifest.gameId;
  let profiles = sortProfiles(await store.listProfiles(gameId));
  if (profiles.length === 0) {
    const first = newProfile(gameId, 'Playthrough 1', clock());
    await store.write({ profiles: [first] });
    profiles = [first];
  }
  const wanted = activeId ?? get().profileId;
  const active = profiles.find((p) => p.id === wanted) ?? profiles[0]!;
  const rows = await store.listProgress(active.id, { includeDeleted: true });
  const rowMap = new Map(rows.map((r) => [r.targetId, r]));
  set({
    profiles,
    profileId: active.id,
    rows: rowMap,
    found: resolveProgress([...rowMap.values()], game.pack.currentId),
    undo: active.id === get().profileId ? get().undo : [],
  });
  saveSetting(SETTINGS.profile(gameId), active.id);
}

export async function switchProfile(id: string): Promise<void> {
  await refreshProfiles(id);
}

export async function createProfile(name: string): Promise<void> {
  const { game } = get();
  if (!game || !name.trim()) return;
  const profile = newProfile(game.pack.manifest.gameId, name, clock());
  await progressStore().write({ profiles: [profile] });
  await refreshProfiles(profile.id);
  notify(`Created profile “${profile.name}”.`);
}

export async function renameProfile(id: string, name: string): Promise<void> {
  const profile = get().profiles.find((p) => p.id === id);
  if (!profile || !name.trim() || name.trim() === profile.name) return;
  await progressStore().write({ profiles: [renamedProfile(profile, name, clock())] });
  await refreshProfiles();
}

export async function duplicateProfile(id: string): Promise<void> {
  const profile = get().profiles.find((p) => p.id === id);
  if (!profile) return;
  const store = progressStore();
  const rows = await store.listProgress(id);
  const batch = duplicateProfileRecords(profile, rows, `${profile.name} (copy)`, clock());
  await store.write(batch);
  await refreshProfiles(batch.profiles[0]!.id);
  notify(`Duplicated “${profile.name}”.`);
}

export async function deleteProfile(id: string): Promise<void> {
  const profile = get().profiles.find((p) => p.id === id);
  if (!profile) return;
  const store = progressStore();
  const rows = await store.listProgress(id);
  await store.write(deletedProfile(profile, rows, clock()));
  await refreshProfiles(id === get().profileId ? undefined : (get().profileId ?? undefined));
  notify(`Deleted profile “${profile.name}”.`);
}

// ---------------------------------------------------------------------------
// Export and import

export async function exportProgress(selection: ExportSelection): Promise<ExportFile> {
  return buildExport(await progressStore().snapshot(), selection, new Date());
}

export async function previewImport(file: ExportFile, mode: ImportMode): Promise<ImportPlan> {
  return planImport(await progressStore().snapshot(), file, mode, clock());
}

export async function applyImport(plan: ImportPlan): Promise<void> {
  const store = progressStore();
  await store.write(plan.batch);
  const userPresets = get().game ? await store.listPresets(get().game!.pack.manifest.gameId) : [];
  set({ userPresets: sortByName(userPresets) });
  await refreshProfiles();
}

// ---------------------------------------------------------------------------
// Interface

/** Applies a theme; the attribute is set at once so canvas drawing reads the new colours. */
export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  set({ theme });
  saveSetting(SETTINGS.theme, theme);
}

/**
 * Switches between the standard and the classic layout and remembers the
 * choice, as the theme is. A layout the address asked for in this session
 * gives way to the choice.
 */
export function setLayout(layout: Layout): void {
  forgetRequestedUi(sessionStore());
  const url = new URL(window.location.href);
  if (url.searchParams.has('ui')) {
    url.searchParams.delete('ui');
    window.history.replaceState(window.history.state, '', url);
  }
  set({ layout, uiRequest: null });
  saveSetting(SETTINGS.layout, layout);
}

/** Opens or closes a side pane. On narrow screens only one sheet is open at a time. */
export function setPane(name: PaneName, open: boolean): void {
  const narrow = isNarrow();
  const panes = { ...get().panes, [name]: open };
  if (narrow && open) panes[name === 'filters' ? 'details' : 'filters'] = false;
  set({ panes });
  if (!narrow) saveSetting(SETTINGS.panes, panes);
}

export function togglePane(name: PaneName): void {
  setPane(name, !get().panes[name]);
}

/** Closes both sheets when the window becomes narrow, and restores the saved panes when it widens. */
export async function onWidthClassChange(narrow: boolean): Promise<void> {
  if (narrow) {
    set({ panes: { filters: false, details: false } });
    return;
  }
  const saved = (await progressStore().getSetting(SETTINGS.panes)) as
    Partial<Record<PaneName, boolean>> | undefined;
  set({ panes: { filters: saved?.filters ?? true, details: saved?.details ?? true } });
}

export function focusSearch(): void {
  set({ searchFocus: get().searchFocus + 1 });
}

export function setProfileDialogOpen(open: boolean): void {
  set({ profileDialogOpen: open });
}
