import { tickChanges, type ChecklistItemEntry } from '@atlas/core';
import { parseId } from '@atlas/schema';
import { applyProgress, goToLocation, goToRegion, notify, setPane, showMap } from './actions';
import { pictureOf } from './guides';
import { useAtlas, type ChecklistPage, type LeftTab, type LoadedGame } from './store';

const get = useAtlas.getState;
const set = useAtlas.setState;

/** The name of the checklists screen for a pack: what it holds. */
export function checklistScreenTitle(game: LoadedGame): string {
  const { checklists, guides } = game.checklists;
  const lists = checklists.filter((c) => c.checklist.kind !== 'guide').length;
  const guideCount = checklists.length - lists + guides.length;
  if (lists > 0 && guideCount > 0) return 'Checklists and guides';
  return guideCount > 0 ? 'Guides' : 'Checklists';
}

/** Shows the left pane on a tab. */
export function showLeftTab(tab: LeftTab): void {
  const { game } = get();
  const next = tab === 'checklists' && game?.checklists.isEmpty ? 'filters' : tab;
  set({ leftTab: next });
  setPane('filters', true);
}

/** Opens the left pane on a tab, or closes it when it already shows that tab. */
export function toggleLeftTab(tab: LeftTab): void {
  const { panes, leftTab, game } = get();
  if (tab === 'checklists' && game?.checklists.isEmpty) {
    notify('This game has no checklists or guides.');
    return;
  }
  if (panes.filters && leftTab === tab) setPane('filters', false);
  else showLeftTab(tab);
}

const samePage = (a: ChecklistPage | undefined, b: ChecklistPage) =>
  a?.kind === b.kind &&
  (a.kind === 'index' ||
    (b.kind !== 'index' &&
      a.id === b.id &&
      (a.kind === 'checklist' ? a.area : undefined) ===
        (b.kind === 'checklist' ? b.area : undefined)));

/** Shows a page of the checklists screen; Back returns to the page shown before. */
export function openChecklistPage(page: ChecklistPage): void {
  const pages = get().checklistPages;
  if (page.kind === 'index') set({ checklistPages: [] });
  else if (!samePage(pages.at(-1), page)) set({ checklistPages: [...pages.slice(-19), page] });
  showLeftTab('checklists');
}

export function openChecklist(id: string): void {
  openChecklistPage({ kind: 'checklist', id });
}

let focusSeq = 0;

/** Opens an item's checklist and brings the item into view. */
export function openChecklistItem(itemId: string): void {
  const checklist = get().game?.checklists.checklistOf(itemId);
  if (!checklist) return;
  openChecklistPage({ kind: 'checklist', id: checklist.checklist.id });
  set({ itemFocus: { itemId, seq: ++focusSeq, open: true } });
}

/**
 * Where a layout reads a guide as a page instead (the standard layout's
 * Guides section): returns whether it opened it there.
 */
let guideReader: ((id: string) => boolean) | null = null;

export function setGuideReader(reader: ((id: string) => boolean) | null): void {
  guideReader = reader;
}

export function openGuide(id: string): void {
  if (guideReader?.(id)) return;
  openChecklistPage({ kind: 'guide', id });
}

export function checklistBack(): void {
  set({ checklistPages: get().checklistPages.slice(0, -1) });
}

/**
 * Ticks or unticks a checklist item (see `tickChanges` for the rule) as one
 * change that `Z` takes back, and says what changed.
 */
export function setItemDone(itemId: string, done: boolean): void {
  const entry = get().game?.checklists.item(itemId);
  if (entry) setEntryDone(entry, done);
}

/**
 * Ticks or unticks an item of any list, the pack's own or one made by the
 * app (such as every place of the game), as {@link setItemDone} does.
 */
export function setEntryDone(entry: ChecklistItemEntry, done: boolean): void {
  const { game, found } = get();
  if (!game) return;
  const changes = tickChanges(entry, done, (id) => found.has(id));
  const name = entry.item.name;
  if (!applyProgress(changes, { undone: `Undone: “${name}” is as it was.`, selectId: null })) {
    return;
  }
  const places = entry.ownMark
    ? ''
    : ` ${changes.length === 1 ? 'One location' : `${changes.length} locations`} marked ${done ? 'found' : 'not found'}.`;
  notify(`“${name}”: ${done ? 'done' : 'not done'}.${places}`, 'info', { undo: true });
}

/** Shows a location of a checklist item on the map, remembering the item for when the screen is shown again. */
export function showItemPlace(itemId: string, locationId: string): void {
  set({ itemFocus: { itemId, seq: ++focusSeq } });
  goToLocation(locationId);
}

/** What an in-app link to a content id does, or null when it cannot be followed. */
export type AppLinkKind = 'location' | 'region' | 'map' | 'checklist' | 'item' | 'guide';

/**
 * The kind of thing an in-app link points at, if the pack has it. Ids from
 * an earlier pack version are followed through the pack's id migrations.
 */
export function appLinkKind(game: LoadedGame, rawId: string): AppLinkKind | null {
  const { pack, checklists } = game;
  const id = pack.currentId(rawId);
  switch (parseId(id)?.kind) {
    case 'loc':
      return pack.locations.has(id) ? 'location' : null;
    case 'region':
      return pack.regions.has(id) ? 'region' : null;
    case 'map':
      return pack.maps.has(id) && pack.layersOf(id).length > 0 ? 'map' : null;
    case 'checklist':
      return checklists.checklist(id) ? 'checklist' : null;
    case 'checkitem':
      return checklists.item(id) ? 'item' : null;
    case 'guide':
      return checklists.guide(id) ? 'guide' : null;
    default:
      return null;
  }
}

/**
 * Follows an in-app link: a location is shown on the map (switching map if
 * needed), a region or map is shown, and a checklist, item or guide opens on
 * the checklists screen.
 */
export function followAppLink(rawId: string): void {
  const { game } = get();
  if (!game) return;
  const id = game.pack.currentId(rawId);
  switch (appLinkKind(game, id)) {
    case 'location':
      goToLocation(id);
      break;
    case 'region':
      goToRegion(id);
      break;
    case 'map':
      showMap(id);
      break;
    case 'checklist':
      openChecklist(id);
      break;
    case 'item':
      openChecklistItem(id);
      break;
    case 'guide':
      openGuide(id);
      break;
    case null:
      break;
  }
}

/** Markdown options for a pack: which in-app links can be followed, and its pictures. */
export function markdownOptionsFor(game: LoadedGame) {
  return {
    isAppTarget: (id: string) => appLinkKind(game, id) !== null,
    picture: (id: string) => pictureOf(game, id),
  };
}
