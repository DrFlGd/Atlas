import { GuideContents, GuideSearch, guidesTogether, type LoadedPack } from '@atlas/core';
import type { GuideEntry, Picture } from '@atlas/schema';
import type { GuidePicture } from '../markdown';
import { guideSearchText } from '../markdown';
import { useGuideLinks, useGuideGamesOffered, type OtherGuides } from './guideLinks';
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

const known = new WeakMap<LoadedPack, { others: readonly OtherGuides[]; guides: GameGuides }>();
const NO_OTHERS: readonly OtherGuides[] = [];

/**
 * The other games whose guides are read with this game's (see
 * `guideLinks.ts`): none until the game's links are read.
 */
export function otherGuidesOf(game: LoadedGame): readonly OtherGuides[] {
  const links = useGuideLinks.getState();
  return links.gameId === game.pack.manifest.gameId ? links.others : NO_OTHERS;
}

const pictureOfPack = (pack: LoadedPack, picture: Picture): [string, GuidePicture] => [
  picture.id,
  {
    url: pack.resolveUrl(picture.file),
    ...(picture.caption ? { caption: picture.caption } : {}),
    ...(picture.credit ? { credit: picture.credit } : {}),
    ...(picture.width && picture.height ? { width: picture.width, height: picture.height } : {}),
  },
];

export function guidesOf(game: LoadedGame): GameGuides {
  const others = otherGuidesOf(game);
  const cached = known.get(game.pack);
  if (cached?.others === others) return cached.guides;
  const contents = new GuideContents(
    guidesTogether(
      game.pack,
      others.map((other) => ({
        gameId: other.gameId,
        title: other.title,
        data: other.pack.data,
      })),
    ),
  );
  // Each picture from its own pack's folder.
  const pictures = new Map([
    ...(game.pack.data.pictures ?? []).map((picture) => pictureOfPack(game.pack, picture)),
    ...others.flatMap((other) =>
      (other.pack.data.pictures ?? []).map((picture) => pictureOfPack(other.pack, picture)),
    ),
  ]);
  // Read with the renderer itself, so hidden text is never found or quoted.
  const guides: GameGuides = {
    contents,
    search: new GuideSearch(contents.browsable ? contents.pages() : [], guideSearchText),
    pictures,
  };
  known.set(game.pack, { others, guides });
  return guides;
}

/**
 * Whether the Guides section is there: the game's guides can be read as
 * pages, or (a game with a map) other games on this device have pages to
 * read with it. Follows the guides of other games as they load.
 */
export function useGuidesSection(game: LoadedGame | null): boolean {
  useGuideLinks((s) => s.others);
  const offered = useGuideGamesOffered(
    (s) => game !== null && s.gameId === game.pack.manifest.gameId && s.offered,
  );
  return hasGuidePages(game) || (offered && hasMap(game));
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
