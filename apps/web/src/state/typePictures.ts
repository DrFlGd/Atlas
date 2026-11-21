import type { LoadedPack } from '@atlas/core';
import type { Category, Picture } from '@atlas/schema';
import { create } from 'zustand';
import { progressStore, SETTINGS } from './services';
import { useAtlas, type LoadedGame } from './store';

/**
 * The icons of the map a game was read from: a type of its pack may name a
 * picture of its own (`picture` in `categories.json`), kept for the
 * person's own use and downloaded with the location photos. Where the
 * person uses this map's icons (a choice per game, on unless they turned
 * it off: when the game is added, or in the Library), the map, the filters,
 * the lists and the cards draw a type with its picture; wherever its file
 * is not there (not downloaded yet, or not readable), with Atlas's own
 * icon, as they do with the choice off.
 */

interface TypePicturesState {
  /** The game the choice below is of. */
  gameId: string | null;
  /** Whether that game's types are drawn with their own pictures. */
  on: boolean;
}

export const useTypePictures = create<TypePicturesState>()(() => ({ gameId: null, on: true }));

const get = useTypePictures.getState;
const set = useTypePictures.setState;

/** Reads a game's choice; on when there is none or it cannot be read. */
export async function readTypePicturesChoice(gameId: string): Promise<boolean> {
  try {
    return (await progressStore().getSetting(SETTINGS.typePictures(gameId))) !== false;
  } catch {
    return true;
  }
}

/** Keeps a game's choice; the game shown draws its types at once. */
export async function chooseTypePictures(gameId: string, on: boolean): Promise<void> {
  if (get().gameId === gameId) set({ on });
  try {
    await progressStore().putSetting(SETTINGS.typePictures(gameId), on);
  } catch {
    // Kept for this session only.
  }
}

/** Reads the choice of the game shown, whenever another game is shown. */
function follow(gameId: string | null): void {
  if (gameId === get().gameId) return;
  set({ gameId, on: true });
  if (gameId === null) return;
  void readTypePicturesChoice(gameId).then((on) => {
    if (get().gameId === gameId) set({ on });
  });
}

/** The game shown, by its id; none while a game is still being read. */
const shownGameId = (game: LoadedGame | null): string | null =>
  (game as Partial<LoadedGame> | null)?.pack?.manifest.gameId ?? null;

follow(shownGameId(useAtlas.getState().game));
useAtlas.subscribe((state) => {
  follow(shownGameId(state.game));
});

const picturesByPack = new WeakMap<LoadedPack, ReadonlyMap<string, Picture>>();

/** A pack's pictures by id. */
function picturesOf(pack: LoadedPack): ReadonlyMap<string, Picture> {
  let pictures = picturesByPack.get(pack);
  if (!pictures) {
    pictures = new Map((pack.data.pictures ?? []).map((picture) => [picture.id, picture]));
    picturesByPack.set(pack, pictures);
  }
  return pictures;
}

/** How many types of a game have a picture of their own. */
export function typePictureCount(game: LoadedGame): number {
  return game.pack.data.categories.filter((category) => category.picture !== undefined).length;
}

/**
 * The address of a type's own picture where it is drawn with it: a type
 * that has one, of the game shown, whose choice is on. Null otherwise. The
 * file may not be there yet; whatever draws it falls back to the icon.
 */
export function typePictureUrl(
  game: LoadedGame | null,
  category: Pick<Category, 'picture'> | undefined,
  on: boolean = get().on && get().gameId === game?.pack.manifest.gameId,
): string | null {
  if (!game || !on || !category?.picture) return null;
  const picture = picturesOf(game.pack).get(category.picture);
  return picture ? game.pack.resolveUrl(picture.file) : null;
}

/** The picture a type is drawn with, for a badge: null for Atlas's own icon. */
export function useTypePicture(categoryId: string | undefined): string | null {
  const game = useAtlas((s) => s.game);
  const on = useTypePictures((s) => s.on && s.gameId === game?.pack.manifest.gameId);
  if (!categoryId || !game) return null;
  return typePictureUrl(game, game.pack.categories.get(categoryId), on);
}
