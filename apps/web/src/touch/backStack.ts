/**
 * What the Android Back button closes next in the touch layout. Each press
 * closes one thing, the one on top: an open dialog, then a place sheet that
 * was pulled up, then the map chooser, search, the filters or the place
 * sheet, then what is open in the list editor and the editor itself,
 * then a checklist or guide page (back to the list of lists), then the
 * page read before in Guides, then a section other than the map (back
 * to the map, or to Guides in a game with no map). Only when nothing is
 * left does Back leave the app.
 */

export type Section = 'map' | 'lists' | 'progress' | 'games' | 'guides';

/** What can be open, as the person sees it now. */
export interface BackState {
  /** A dialog (profiles, a pack file import, the activity log). */
  dialog: boolean;
  /** The place sheet, pulled up to show everything. */
  placeExpanded: boolean;
  /** The list of maps and levels. */
  mapsMenu: boolean;
  search: boolean;
  /** The filters sheet. */
  filters: boolean;
  /** A place is selected and its sheet or card can be seen. */
  place: boolean;
  section: Section;
  /** Lists shows a checklist or a guide rather than the list of them. */
  listsPage: boolean;
  /** Guides can go back to a place read before. */
  guidesBack?: boolean;
  /** The section Back ends on: the map, or Guides in a game with no map. */
  home?: Section;
  /**
   * The list editor, when it is open: choosing a location on the map, a
   * step (or Add) open beside the map, Preview, or just the editor.
   */
  editor?: 'picking' | 'panel' | 'preview' | 'open' | null;
}

export type BackStep =
  | 'dialog'
  | 'collapse-place'
  | 'maps-menu'
  | 'search'
  | 'filters'
  | 'place'
  | 'lists-page'
  | 'guides-back'
  | 'to-map'
  | 'editor-picking'
  | 'editor-panel'
  | 'editor-preview'
  | 'editor-leave';

/** The thing Back closes, or null when Back should leave the app. */
export function backStep(state: BackState): BackStep | null {
  if (state.dialog) return 'dialog';
  if (state.place && state.placeExpanded) return 'collapse-place';
  if (state.mapsMenu) return 'maps-menu';
  if (state.search) return 'search';
  if (state.filters) return 'filters';
  if (state.place) return 'place';
  // In the editor, Back closes one thing of it at a time, then the editor
  // (to the list, as it will be used).
  if (state.editor === 'picking') return 'editor-picking';
  if (state.editor === 'panel') return 'editor-panel';
  if (state.editor === 'preview') return 'editor-preview';
  if (state.editor === 'open') return 'editor-leave';
  if (state.section === 'lists' && state.listsPage) return 'lists-page';
  if (state.section === 'guides' && state.guidesBack) return 'guides-back';
  if (state.section !== (state.home ?? 'map')) return 'to-map';
  return null;
}
