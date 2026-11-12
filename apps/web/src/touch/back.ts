import { moveMap, select } from '../state/actions';
import { checklistBack } from '../state/checklists';
import { useAtlas } from '../state/store';
import { backStep } from './backStack';
import { revealShift, type Rect } from './ordering';
import {
  closeSearch,
  setFiltersOpen,
  setMapsMenuOpen,
  setPlaceExpanded,
  showSection,
  useTouch,
} from './state';

/** Closes the thing on top (see `backStep`); false when nothing is left to close. */
export function handleBack(): boolean {
  const touch = useTouch.getState();
  const atlas = useAtlas.getState();
  const dialogs = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')];
  const wide = touch.arrangement === 'wide';
  const page = atlas.checklistPages.at(-1);
  const step = backStep({
    dialog: dialogs.length > 0,
    placeExpanded: touch.placeExpanded,
    mapsMenu: touch.mapsMenu,
    search: touch.search,
    filters: touch.filters,
    place:
      atlas.selectedId !== null &&
      (wide || (touch.section === 'map' && !touch.search && !touch.filters)),
    section: touch.section,
    listsPage: page !== undefined && page.kind !== 'index',
  });
  switch (step) {
    case 'dialog': {
      const dialog = dialogs.at(-1)!;
      // As Escape would: a dialog that is busy may refuse.
      const cancel = new Event('cancel', { cancelable: true });
      if (dialog.dispatchEvent(cancel)) dialog.close();
      return true;
    }
    case 'collapse-place':
      setPlaceExpanded(false);
      return true;
    case 'maps-menu':
      setMapsMenuOpen(false);
      return true;
    case 'search':
      closeSearch();
      return true;
    case 'filters':
      setFiltersOpen(false);
      return true;
    case 'place':
      select(null);
      return true;
    case 'lists-page':
      checklistBack();
      return true;
    case 'to-map':
      showSection('map');
      return true;
    case null:
      return false;
  }
}

/** How long the map has to stay still before it counts as stopped. */
const SETTLE_MS = 250;
let settle: number | undefined;
/** The map is being moved by `revealSelection` itself. */
let revealing = false;

/**
 * After the map was sent to the selected place: once the map has stopped,
 * moves it if the place ended up under the sheet or card.
 */
export function revealWhenSettled(): void {
  if (revealing) {
    revealing = false;
    return;
  }
  window.clearTimeout(settle);
  settle = window.setTimeout(() => {
    settle = undefined;
    // Only when the map went to the selected place, not to a region or a point.
    const { game, selectedId, fly } = useAtlas.getState();
    const location = selectedId ? game?.pack.locations.get(selectedId) : undefined;
    if (location && fly && Math.abs(fly.x - location.x) < 1) revealSelection();
  }, SETTLE_MS);
}

/** The map moved: a wait for it to stop starts again. */
export function mapMoved(): void {
  if (settle !== undefined) revealWhenSettled();
}

/**
 * After a tap picked a marker: once the sheet or card is drawn, moves the
 * map if the marker is under it or under the controls at the top.
 */
export function revealSelection() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const { game, selectedId, view } = useAtlas.getState();
      const location = selectedId ? game?.pack.locations.get(selectedId) : undefined;
      const pane = document.querySelector('.touch-map .map-pane');
      if (!location || !view || !pane) return;
      const map = pane.getBoundingClientRect();
      const scale = (view.bounds.maxX - view.bounds.minX) / Math.max(1, map.width);
      const point = {
        x: map.left + (location.x - view.bounds.minX) / scale,
        y: map.top + (location.y - view.bounds.minY) / scale,
      };
      const top = document.querySelector('.touch-map-top')?.getBoundingClientRect().bottom;
      const free: Rect = {
        left: map.left,
        right: map.right,
        top: top ?? map.top,
        bottom: map.bottom,
      };
      const sheet = document.querySelector('.place-sheet')?.getBoundingClientRect();
      const bar = document.querySelector('.touch-bar')?.getBoundingClientRect();
      const covered = [sheet, bar].filter((r): r is DOMRect => r !== undefined);
      const shift = revealShift(point, free, covered, 28);
      if (!shift) return;
      revealing = true;
      moveMap(view.center.x + shift.x * scale, view.center.y + shift.y * scale);
    });
  });
}
