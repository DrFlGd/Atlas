import { GuideContents, GuideSearch, type LoadedPack } from '@atlas/core';
import type { GuideEntry } from '@atlas/schema';
import type { GuidePicture } from '../markdown';
import { guideSearchText } from '../markdown';
import type { LoadedGame } from './store';

/**
 * A game's guides as pages to read (the standard layout's Guides section):
 * its contents, a search over the pages' titles and text, and its pictures.
 * Worked out once per pack, when first asked for.
 */
export interface GameGuides {
  contents: GuideContents;
  search: GuideSearch;
  pictures: ReadonlyMap<string, GuidePicture>;
}

const known = new WeakMap<LoadedPack, GameGuides>();

export function guidesOf(game: LoadedGame): GameGuides {
  let guides = known.get(game.pack);
  if (!guides) {
    const contents = new GuideContents(game.pack);
    const pictures = new Map(
      (game.pack.data.pictures ?? []).map((picture) => [
        picture.id,
        {
          url: game.pack.resolveUrl(picture.file),
          ...(picture.caption ? { caption: picture.caption } : {}),
          ...(picture.credit ? { credit: picture.credit } : {}),
          ...(picture.width && picture.height
            ? { width: picture.width, height: picture.height }
            : {}),
        },
      ]),
    );
    // Read with the renderer itself, so hidden text is never found or quoted.
    guides = {
      contents,
      search: new GuideSearch(contents.browsable ? contents.pages() : [], guideSearchText),
      pictures,
    };
    known.set(game.pack, guides);
  }
  return guides;
}

/** Whether a game has a map: a game of guides and lists only has none. */
export function hasMap(game: LoadedGame | null): boolean {
  return (game?.pack.data.maps.length ?? 0) > 0;
}

/** Whether a game's guides can be read as pages, in a Guides section. */
export function hasGuidePages(game: LoadedGame | null): boolean {
  return game !== null && guidesOf(game).contents.browsable;
}

/** The picture of a game with this id, as a guide shows it, or null. */
export function pictureOf(game: LoadedGame, id: string): GuidePicture | null {
  return guidesOf(game).pictures.get(game.pack.currentId(id)) ?? null;
}

/**
 * The guides the Lists section offers to read: those the Guides section
 * does not show as pages (walkthroughs of the lists, say).
 */
export function listedGuides(game: LoadedGame): readonly GuideEntry[] {
  const { contents } = guidesOf(game);
  const { guides } = game.checklists;
  return contents.browsable ? guides.filter((g) => !contents.isPage(g.id)) : guides;
}

/** Whether a game has anything for the Lists section: a list, or a guide not read in Guides. */
export function hasListsSection(game: LoadedGame | null): boolean {
  return game !== null && (game.checklists.checklists.length > 0 || listedGuides(game).length > 0);
}
