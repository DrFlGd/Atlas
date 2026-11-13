import { create } from 'zustand';

/**
 * "Show on the map" from a guide page: the locations the page is linked to
 * are the only ones on the map, as an open list's are with "Only this
 * list" (see `followOpenList` and `showPageOnMap` in `listViews.ts`), until
 * the chip over the map is pressed, a list is opened or another game is
 * shown. Nothing here is kept.
 */
export interface GuideOnMap {
  gameId: string | null;
  guideId: string | null;
  title: string;
  places: ReadonlySet<string> | null;
}

export const useGuideOnMap = create<GuideOnMap>()(() => ({
  gameId: null,
  guideId: null,
  title: '',
  places: null,
}));

/** The page's locations to show alone, while they are of the game shown. */
export function pagePlacesShown(gameId: string | undefined): ReadonlySet<string> | null {
  const shown = useGuideOnMap.getState();
  return shown.places && shown.gameId === gameId ? shown.places : null;
}
