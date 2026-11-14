import {
  addThing,
  aliasedId,
  LocationNameIndex,
  newOwnId,
  stepOfThing,
  thingName,
  type BuildFinder,
  type BuildThing,
  type LoadedPack,
} from '@atlas/core';
import type { OwnList } from '@atlas/schema';
import { create } from 'zustand';
import { notify, saveSetting } from './actions';
import { linkedLocations } from './guideMatches';
import { guideAliases, guidesOf, hasMap, otherGuidesOf } from './guides';
import {
  canChangeOwnLists,
  createOwnList,
  ownListById,
  restoreOwnList,
  takenIds,
  updateOwnList,
  useOwnLists,
  type OwnListsState,
} from './ownLists';
import { progressStore } from './services';
import type { LoadedGame } from './store';

/**
 * The build planner of the game shown (see `planBuild.ts` in core): "Add
 * to build" from a wiki page, a row of a page's table, a location's card or
 * a result of the search, into a Build guide of the person's own lists.
 * Adding needs no list editor, so it works on a phone. The list last added
 * to is remembered on this device, per game, so the next thing goes there
 * with one press; the person can choose another.
 *
 * "Find on the map" reads only what is saved: the game's pages (and those
 * of the games read with it, as Guides shows them), the person's links
 * between pages and the map, and the map's location names, indexed once
 * per game.
 */

export interface BuildPlannerState {
  /** The game the remembered list is of. */
  gameId: string | null;
  /** The Build guide last added to, if it is still one. */
  listId: string | null;
}

export const useBuildPlanner = create<BuildPlannerState>()(() => ({
  gameId: null,
  listId: null,
}));

/** The key of the Build guide last added to, among the settings. */
const buildListSetting = (gameId: string) => `buildList:${gameId}`;

/** Reads the Build guide last added to in a game. */
export async function loadBuildPrefs(game: LoadedGame): Promise<void> {
  const gameId = game.pack.manifest.gameId;
  useBuildPlanner.setState({ gameId, listId: null });
  try {
    const value = await progressStore().getSetting(buildListSetting(gameId));
    if (useBuildPlanner.getState().gameId !== gameId) return;
    useBuildPlanner.setState({ listId: typeof value === 'string' ? value : null });
  } catch {
    // Nothing remembered: the next add asks.
  }
}

/** Remembers the Build guide to add to next. */
export function rememberBuildList(game: LoadedGame, listId: string): void {
  const gameId = game.pack.manifest.gameId;
  useBuildPlanner.setState({ gameId, listId });
  saveSetting(buildListSetting(gameId), listId);
}

/** The person's Build guides of the game shown. */
export function buildListsOf(state: OwnListsState = useOwnLists.getState()): OwnList[] {
  return state.lists.filter((list) => list.checklist.type === 'build');
}

/** The Build guide the next thing goes to, when one is remembered and still is one. */
export function rememberedBuildList(game: LoadedGame): OwnList | undefined {
  const { gameId, listId } = useBuildPlanner.getState();
  if (!listId || gameId !== game.pack.manifest.gameId) return undefined;
  const list = ownListById(listId);
  return list?.checklist.type === 'build' ? list : undefined;
}

/**
 * Whether "Add to build" is offered: a game with a map, whose lists are
 * read and can be changed here.
 */
export function canAddToBuild(game: LoadedGame | null, state: OwnListsState): boolean {
  return (
    game !== null &&
    hasMap(game) &&
    state.gameId === game.pack.manifest.gameId &&
    state.status === 'ready' &&
    state.readOnly === null
  );
}

// ---------------------------------------------------------------------------
// Adding

/** The page an id is in the game's Guides, through the ids pages had before; null when none. */
export function pageIdOf(game: LoadedGame, id: string): string | null {
  const { contents } = guidesOf(game);
  if (contents.guide(id)) return id;
  const current = game.pack.currentId(id);
  if (contents.guide(current)) return current;
  const aliases = guideAliases([game.pack, ...otherGuidesOf(game).map((other) => other.pack)]);
  const aliased = aliases ? aliasedId(aliases, id) : id;
  return contents.guide(aliased) ? aliased : null;
}

/** Whether two page ids are the same page of the game. */
function samePage(game: LoadedGame, a: string, b: string): boolean {
  return a === b || (pageIdOf(game, a) ?? a) === (pageIdOf(game, b) ?? b);
}

/** A new Build guide, to add to; null when lists cannot be changed now. */
export function newBuildList(game: LoadedGame, name: string): OwnList | null {
  return createOwnList(game, name.trim() || 'My build', 'build');
}

/**
 * Adds a thing to a Build guide as a step at its end, and says so, with
 * Undo; a thing that is in the list already is not added again, and that
 * is said. The list is remembered for the next thing.
 */
export function addToBuild(game: LoadedGame, listId: string, thing: BuildThing): boolean {
  const list = ownListById(listId);
  if (!list || !canChangeOwnLists()) {
    notify(useOwnLists.getState().readOnly ?? 'Your lists cannot be changed right now.', 'error');
    return false;
  }
  rememberBuildList(game, listId);
  const name = thingName(thing.name) || 'New step';
  const listName = list.checklist.name;
  if (stepOfThing(list, thing, (a, b) => samePage(game, a, b))) {
    notify(`“${name}” is in ${listName} already.`);
    return false;
  }
  const taken = takenIds(game);
  const stepId = newOwnId(game.pack.manifest.gameId, 'checkitem', taken);
  const after = updateOwnList(listId, (current) => addThing(current, thing, stepId));
  if (!after) return false;
  notify(`Added “${name}” to ${listName}.`, 'info', {
    action: {
      label: 'Undo',
      run: () => {
        const now = ownListById(listId);
        if (!now) return;
        restoreOwnList({ ...now, items: now.items.filter((item) => item.id !== stepId) });
        notify(`Took “${name}” out of ${listName}.`);
      },
    },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Finding

const namesByPack = new WeakMap<LoadedPack, LocationNameIndex>();

/** The map's location names, indexed once per game. */
export function locationNamesOf(game: LoadedGame): LocationNameIndex {
  let names = namesByPack.get(game.pack);
  if (!names) {
    names = new LocationNameIndex(game.pack.data.locations);
    namesByPack.set(game.pack, names);
  }
  return names;
}

/** What "Find on the map" reads of the game shown (see `planBuild.ts` in core). */
export function buildFinderOf(game: LoadedGame): BuildFinder {
  const { contents } = guidesOf(game);
  return {
    pageId: (id) => pageIdOf(game, id),
    pageBody: (id) => contents.guide(id)?.body,
    linkedLocations: (id) => linkedLocations(game, id),
    hasLocation: (id) => game.pack.locations.has(id),
    names: locationNamesOf(game),
  };
}
