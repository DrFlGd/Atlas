import {
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
  renamedProfile,
  resolveProgress,
  visibleCategoryIds,
  type ExportFile,
  type ExportSelection,
  type ImportMode,
  type ImportPlan,
  type PackEntry,
  type Profile,
  type ProgressRecord,
  type VisibilityOverrides,
} from '@atlas/core';
import { applyQueryOverrides, loadCatalog, loadRuntimeConfig } from '../config';
import type { HashView } from '../viewHash';
import { loadDownloads } from './downloads';
import { SETTINGS, clock, openProgressStore, progressStore } from './services';
import { useAtlas, type AtlasState, type PaneName, type Theme } from './store';

const get = useAtlas.getState;
const set = useAtlas.setState;

/** Below this width the side panes become bottom sheets over the map. */
export const NARROW_QUERY = '(max-width: 899px)';
export const isNarrow = () => window.matchMedia(NARROW_QUERY).matches;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

let noticeSeq = 0;
export function notify(text: string, tone: 'info' | 'error' = 'info'): void {
  set({ notice: { text, tone, seq: ++noticeSeq } });
}

function saveSetting(key: string, value: unknown): void {
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
    const savedPanes = (await store.getSetting(SETTINGS.panes)) as
      Partial<Record<PaneName, boolean>> | undefined;
    const narrow = isNarrow();
    document.documentElement.dataset.theme = theme;
    set({
      config,
      theme,
      persistent,
      panes: {
        filters: !narrow && (savedPanes?.filters ?? true),
        details: !narrow && (savedPanes?.details ?? true),
      },
    });
    const catalog = await loadCatalog(config);
    set({ catalog });
    const savedPack = await store.getSetting(SETTINGS.activePack);
    const entry = catalog.find((p) => p.id === savedPack) ?? catalog[0]!;
    await loadGame(entry, initialView);
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

/** Loads a pack and the user state that belongs to its game. */
export async function loadGame(
  entry: PackEntry,
  initialView: HashView | null = null,
): Promise<void> {
  const token = ++loadToken;
  set({ status: { kind: 'loading' } });
  try {
    const store = progressStore();
    const pack = await loadPack(entry.url);
    const gameId = pack.manifest.gameId;
    const counter = new ProgressCounter(pack);
    const search = new SearchIndex(pack);

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
      { overrides?: VisibilityOverrides; hideFound?: boolean } | undefined;
    const userPresets = await store.listPresets(gameId);

    const place = (await store.getSetting(SETTINGS.place(gameId))) as
      { mapId?: string; layerId?: string } | undefined;
    const layer =
      (place?.layerId ? pack.layers.get(place.layerId) : undefined) ??
      pack.layersOf(pack.data.maps[0]?.id ?? '')[0];
    if (!layer) throw new Error('The pack has no map layers.');

    if (token !== loadToken) return;
    const rowMap = new Map(rows.map((r) => [r.targetId, r]));
    set({
      status: { kind: 'ready' },
      game: { entry, pack, counter, search },
      mapId: layer.mapId,
      layerId: layer.id,
      selectedId: null,
      hover: null,
      tileStatus: null,
      fly: initialView ? { ...initialView, animate: false, seq: 1 } : null,
      overrides: filters?.overrides ?? {},
      hideFound: filters?.hideFound ?? false,
      userPresets: sortByName(userPresets),
      profiles: sortProfiles(profiles),
      profileId: profile.id,
      rows: rowMap,
      found: resolveProgress([...rowMap.values()], pack.currentId),
      undo: [],
    });
    saveSetting(SETTINGS.activePack, entry.id);
    void loadDownloads(get().game!);
  } catch (error) {
    if (token === loadToken) set({ status: { kind: 'error', message: errorText(error) } });
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
  state: Pick<AtlasState, 'game' | 'overrides' | 'hideFound' | 'found'>,
) {
  const categories = state.game?.pack.data.categories ?? [];
  const found = state.found;
  return {
    visibleCategories: visibleCategoryIds(categories, state.overrides),
    hideFound: state.hideFound,
    isFound: (id: string) => found.has(id),
  };
}

// ---------------------------------------------------------------------------
// Found tracking

async function writeProgress(row: ProgressRecord): Promise<void> {
  try {
    await progressStore().write({ progress: [row] });
  } catch (error) {
    notify(`Could not save progress: ${errorText(error)}`, 'error');
  }
}

/**
 * Marks a location found or not. Only trackable categories can be marked.
 * Returns whether anything changed.
 */
export function setFound(
  locationId: string,
  found: boolean,
  options: { undoable?: boolean } = {},
): boolean {
  const state = get();
  const { game, profileId } = state;
  if (!game || !profileId || !game.counter.isTrackable(locationId)) return false;
  const wasFound = state.found.has(locationId);
  if (wasFound === found) return false;
  const row = progressRow(profileId, locationId, found, clock());
  const rows = new Map(state.rows);
  rows.set(locationId, row);
  set({
    rows,
    found: resolveProgress([...rows.values()], game.pack.currentId),
    undo:
      options.undoable === false
        ? state.undo
        : [...state.undo.slice(-99), { profileId, targetId: locationId, wasFound }],
  });
  void writeProgress(row);
  return true;
}

/** Flips the found state of a location (the selection by default). */
export function toggleFound(locationId = get().selectedId): void {
  const { game, found } = get();
  if (!locationId || !game) return;
  const location = game.pack.locations.get(locationId);
  if (!location) return;
  if (!game.counter.isTrackable(locationId)) {
    notify(
      `${game.pack.categories.get(location.categoryId)?.name ?? 'This category'} is not tracked.`,
    );
    return;
  }
  const next = !found.has(locationId);
  setFound(locationId, next);
  notify(`${location.name}: ${next ? 'found' : 'not found'}. Press Z to undo.`);
}

/** Takes back the last found change in the active profile. */
export function undo(): void {
  const { undo: stack, profileId, game } = get();
  const last = stack.at(-1);
  if (!game || last?.profileId !== profileId) {
    notify('Nothing to undo.');
    return;
  }
  set({ undo: stack.slice(0, -1) });
  setFound(last.targetId, last.wasFound, { undoable: false });
  const name = game.pack.locations.get(last.targetId)?.name ?? last.targetId;
  notify(`Undone: ${name} is ${last.wasFound ? 'found' : 'not found'} again.`);
  set({ selectedId: last.targetId });
}

// ---------------------------------------------------------------------------
// Filters and presets

function saveFilters(): void {
  const { game, overrides, hideFound } = get();
  if (game) saveSetting(SETTINGS.filters(game.pack.manifest.gameId), { overrides, hideFound });
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

export function applyPreset(categoryIds: readonly string[]): void {
  const { game } = get();
  if (!game) return;
  set({ overrides: overridesShowingOnly(game.pack.data.categories, categoryIds) });
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
