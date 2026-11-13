import { writeOwnLocationsFile } from '@atlas/schema';
import { removeOwnOfMap } from '@atlas/core';
import { desktop, type CutJobProgress, type OwnGameChanged, type PickedPicture } from '../desktop';
import { loadGame, notify, showMap } from './actions';
import { applyListing } from './library';
import {
  forgetOwnOfMap,
  ownLocationsBackend,
  parseOwnLocations,
  useOwnLocations,
} from './ownLocations';
import { useAtlas } from './store';

/**
 * Games made in the desktop app from pictures (see `owngame.rs` in the
 * shell): a new game from its name and its first map's picture, more maps
 * and levels, renaming the game and deleting one of its maps. The shell
 * cuts the picture into the map's tiles; this module runs its commands and
 * shows what was made.
 */

const get = useAtlas.getState;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether this app can make games from pictures: the desktop apps, with the maps folder. */
export function ownGamesOffered(state = get()): boolean {
  return desktop !== null && state.app?.ownGames === true && state.app.folders !== false;
}

/** Whether a game was made in this app (so maps can be added to it, and it can be renamed). */
export function madeInApp(gameId: string, state = get()): boolean {
  return state.library?.packs.find((pack) => pack.id === gameId)?.madeInApp === true;
}

/** Asks for a picture for a map; null when the dialog was closed. */
export function pickMapPicture(): Promise<PickedPicture | null> {
  return desktop!.ownGames.pickPicture();
}

export function cutProgress(): Promise<CutJobProgress | null> {
  return desktop!.ownGames.progress();
}

export function cancelCut(): Promise<void> {
  return desktop!.ownGames.cancel();
}

/** Takes in what a change gave back and shows what it made: the game, on its new map. */
async function show(changed: OwnGameChanged, open: boolean): Promise<void> {
  applyListing(changed.listing);
  const added = changed.added;
  const gameId = added?.gameId;
  const shown = get().game?.entry.id;
  const entry = get().catalog.find((pack) => pack.id === (gameId ?? shown));
  if (!entry || (!open && entry.id !== shown)) return;
  const loaded = await loadGame(entry);
  if (loaded && added) showMap(added.mapId, added.layerId);
}

/** Makes a new game from its name and its first map's picture, and shows it. */
export async function createOwnGame(
  title: string,
  mapName: string,
  picture: string,
): Promise<OwnGameChanged> {
  const changed = await desktop!.ownGames.create(title, mapName, picture);
  await show(changed, true);
  return changed;
}

/** Adds a map to a game made in the app, and shows it. */
export async function addOwnMap(
  gameId: string,
  mapName: string,
  picture: string,
): Promise<OwnGameChanged> {
  const changed = await desktop!.ownGames.addMap(gameId, mapName, picture);
  await show(changed, true);
  return changed;
}

/** Adds a level to a map of a game made in the app, and shows it. */
export async function addOwnLevel(
  gameId: string,
  mapId: string,
  levelName: string,
  picture: string,
): Promise<OwnGameChanged> {
  const changed = await desktop!.ownGames.addLevel(gameId, mapId, levelName, picture);
  await show(changed, true);
  return changed;
}

/** Renames a game made in the app. Returns an error to show, or null. */
export async function renameOwnGame(gameId: string, title: string): Promise<string | null> {
  try {
    const changed = await desktop!.ownGames.rename(gameId, title);
    await show(changed, false);
    notify(`Renamed the game to ${title.trim()}.`);
    return null;
  } catch (error) {
    return errorText(error);
  }
}

/**
 * Deletes a map of a game made in the app, with its levels' map images,
 * and the person's own locations and areas on it. Returns an error to show,
 * or null.
 */
export async function deleteOwnMap(
  gameId: string,
  mapId: string,
  mapName: string,
): Promise<string | null> {
  let changed: OwnGameChanged;
  try {
    changed = await desktop!.ownGames.deleteMap(gameId, mapId);
  } catch (error) {
    return errorText(error);
  }
  try {
    await forgetOwnOn(gameId, mapId);
  } catch (error) {
    console.error(error);
  }
  await show(changed, false);
  notify(`Deleted the map ${mapName}.`);
  return null;
}

/** Forgets the person's own locations and areas on a map that was deleted. */
async function forgetOwnOn(gameId: string, mapId: string): Promise<void> {
  if (useOwnLocations.getState().gameId === gameId) {
    forgetOwnOfMap(mapId);
    return;
  }
  const backend = ownLocationsBackend();
  const text = await backend.read(gameId);
  if (text === null) return;
  const parsed = parseOwnLocations(gameId, text);
  if (!parsed.ok || parsed.newer) return;
  const next = removeOwnOfMap(parsed.own, mapId);
  if (
    next.locations.length === parsed.own.locations.length &&
    next.regions.length === parsed.own.regions.length
  ) {
    return;
  }
  await backend.write(gameId, writeOwnLocationsFile(gameId, next, new Date()));
}
