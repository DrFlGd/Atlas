import { afterDraw, focusFirstIn, type PadHost } from '../controller';
import { select } from '../state/actions';
import {
  closeSearch,
  homeSection,
  setFiltersOpen,
  setKeysOpen,
  showSection,
  useTouch,
} from './state';

/**
 * What the controller does its own way in the standard layout (see
 * `PadHost` in `controller.ts`): a location opens in its card, the types
 * and filters are in the panel beside the map (wide) or a sheet (compact),
 * Menu opens Settings (its own section in the desktop app, else under
 * Games), and View the guide of keys and controller.
 */
export const TOUCH_PAD_HOST: PadHost = {
  open: (locationId) => {
    select(locationId);
  },
  focusCard: () => {
    // The card's own action first: Mark found.
    focusFirstIn('.place-sheet', '[data-testid="mark-found"]');
  },
  filters: () => {
    const { arrangement, section } = useTouch.getState();
    if (arrangement === 'wide') {
      if (section !== 'map') showSection('map');
      closeSearch();
      afterDraw(() => {
        focusFirstIn('[data-testid="filters-panel"]');
      });
      return;
    }
    setFiltersOpen(true);
    afterDraw(() => {
      focusFirstIn('[data-testid="filters-sheet"]');
    });
  },
  menu: () => {
    const settings = document.querySelector('[data-testid="section-settings"]')
      ? 'settings'
      : 'games';
    const { section } = useTouch.getState();
    if (section === settings) {
      showSection(homeSection());
      return;
    }
    showSection(settings);
    afterDraw(() => {
      const where =
        settings === 'settings'
          ? '[data-testid="settings-screen"] .library-settings-body'
          : '.touch-settings';
      if (settings === 'games') {
        document.querySelector('.touch-settings')?.scrollIntoView({ block: 'start' });
      }
      focusFirstIn(where);
    });
  },
  keysGuide: () => {
    setKeysOpen(!useTouch.getState().keysOpen);
  },
};
