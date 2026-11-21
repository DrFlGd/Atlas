import { ownNameOf, renameMapOrLevel } from '@atlas/core';
import { writeOwnLocationsFile, type OwnName } from '@atlas/schema';
import { useEffect } from 'react';
import { create } from 'zustand';
import { notify } from './actions';
import {
  canChangeOwnLocations,
  ownLocationsBackend,
  parseOwnLocations,
  renameShownMapOrLevel,
  useOwnLocations,
} from './ownLocations';
import { useAtlas } from './store';

/**
 * A person's own names of the maps and levels of a game (issue: rename a
 * single map or a level). They are kept with the person's other own data
 * of the game, in its own locations file (see `ownLocations.ts` in the
 * schema package), never in the pack: reading the game again, updating it
 * or importing it over itself never loses them, and the pack's name is
 * there to go back to ("Use the original name").
 *
 * The game shown has them in its own locations (`state/ownLocations.ts`),
 * which put them in place of the pack's names wherever a map or a level is
 * named: the map switcher, the map's chip, lists, search, progress. For
 * another game (in the Library, or another source of the title shown) they
 * are read from its file here, and a rename there writes that file.
 */

interface MapNamesState {
  /** The names of games other than the one shown, by game id, once read. */
  byGame: Record<string, readonly OwnName[]>;
}

export const useMapNames = create<MapNamesState>()(() => ({ byGame: {} }));

const NO_NAMES: readonly OwnName[] = [];
const reading = new Map<string, Promise<void>>();

/** Reads the names of a game that is not the one shown, once until a rename. */
export function loadMapNames(gameId: string): Promise<void> {
  let known = reading.get(gameId);
  if (!known) {
    known = (async () => {
      let names: readonly OwnName[] = NO_NAMES;
      try {
        const text = await ownLocationsBackend().read(gameId);
        const parsed = text === null ? null : parseOwnLocations(gameId, text);
        if (parsed?.ok) names = parsed.own.names ?? NO_NAMES;
      } catch {
        // Unread names leave the pack's names in view.
      }
      useMapNames.setState((s) => ({ byGame: { ...s.byGame, [gameId]: names } }));
    })();
    reading.set(gameId, known);
  }
  return known;
}

/** Whether the own locations of the game shown are of this game and read. */
function shownHere(gameId: string): boolean {
  const own = useOwnLocations.getState();
  return own.gameId === gameId && own.status === 'ready';
}

/** The person's names of a game's maps and levels. */
export function useMapNamesOf(gameId: string | null): readonly OwnName[] {
  const shown = useOwnLocations((s) =>
    s.gameId === gameId && s.status === 'ready' ? (s.own.names ?? NO_NAMES) : null,
  );
  const other = useMapNames((s) => (gameId ? s.byGame[gameId] : undefined));
  const unread = gameId !== null && shown === null && other === undefined;
  useEffect(() => {
    if (unread) void loadMapNames(gameId);
  }, [unread, gameId]);
  return shown ?? other ?? NO_NAMES;
}

/** The name to show of a map or level: the person's, else the pack's. */
export function shownName(names: readonly OwnName[], id: string, packName: string): string {
  return ownNameOf({ names: [...names] }, id)?.name ?? packName;
}

/** What is renamed: a map or a level of a game, with the pack's name of it. */
export interface RenameTarget {
  gameId: string;
  id: string;
  kind: 'map' | 'level';
  /** The pack's name now: what "Use the original name" shows again. */
  original: string;
}

/**
 * Gives a map or a level the person's name, or takes it out (`name` null):
 * "Use the original name". For the game shown it is a change of its own
 * locations, which Undo takes back; for another game its file is written.
 * Null when done, or a sentence saying why not.
 */
export async function renameMapOrLevelOf(
  target: RenameTarget,
  name: string | null,
): Promise<string | null> {
  const wanted = name?.trim() ?? '';
  if (name !== null && wanted === '') return 'Give it a name, or use the original name.';
  if (shownHere(target.gameId)) {
    if (!canChangeOwnLocations()) {
      return (
        useOwnLocations.getState().readOnly ??
        'Your own data for this game cannot be changed now, so the name cannot be kept.'
      );
    }
    renameShownMapOrLevel(target.id, name, target.original);
    said(target, name);
    return null;
  }
  try {
    const backend = ownLocationsBackend();
    const before = await backend.read(target.gameId);
    const parsed = before === null ? null : parseOwnLocations(target.gameId, before);
    if (parsed && (!parsed.ok || parsed.newer)) {
      return 'Your own data for this game could not be read here, so the name was not changed.';
    }
    const own = parsed?.ok
      ? parsed.own
      : { categoryGroups: [], categories: [], regions: [], locations: [] };
    const next = renameMapOrLevel(own, target.id, name, target.original);
    if (next !== own) {
      await backend.write(target.gameId, writeOwnLocationsFile(target.gameId, next, new Date()));
    }
    reading.delete(target.gameId);
    useMapNames.setState((s) => ({
      byGame: { ...s.byGame, [target.gameId]: next.names ?? NO_NAMES },
    }));
    said(target, name);
    return null;
  } catch (error) {
    return `The name could not be kept: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function said(target: RenameTarget, name: string | null): void {
  const what = target.kind === 'map' ? 'map' : 'level';
  if (name === null || name.trim() === target.original.trim()) {
    notify(`The ${what} has its original name again: ${target.original}.`);
    return;
  }
  notify(`Renamed the ${what} ${name.trim()}.`, 'info', {
    action: {
      label: 'Use the original name',
      run: () => {
        void renameMapOrLevelOf(target, null).then((problem) => {
          if (problem) notify(problem, 'error');
        });
      },
    },
  });
}

/** A map of a game as its pack names it, with its levels when it has several. */
export interface MapAndLevels {
  id: string;
  name: string;
  levels: { id: string; name: string }[];
}

const mapsKnown = new Map<string, Promise<MapAndLevels[]>>();

/**
 * The maps and levels of a game as its pack names them, read from its own
 * files (its `maps.json` and `layers.json`), once per game until the
 * Library changes. Empty for a game of pages, or when they cannot be read.
 */
export function mapsAndLevelsAt(url: string): Promise<MapAndLevels[]> {
  let known = mapsKnown.get(url);
  if (!known) {
    known = (async () => {
      const json = async (name: string): Promise<unknown> => {
        try {
          const response = await fetch(new URL(name, url));
          return response.ok ? ((await response.json()) as unknown) : null;
        } catch {
          return null;
        }
      };
      const [maps, layers] = await Promise.all([json('maps.json'), json('layers.json')]);
      return mapsAndLevelsOf(maps, layers);
    })();
    mapsKnown.set(url, known);
  }
  return known;
}

/** The maps and their levels from a pack's maps and layers as read; exported for tests. */
export function mapsAndLevelsOf(maps: unknown, layers: unknown): MapAndLevels[] {
  const named = (value: unknown): { id: string; name: string; mapId?: string } | null => {
    const { id, name, mapId } = (value ?? {}) as { id?: unknown; name?: unknown; mapId?: unknown };
    return typeof id === 'string' && typeof name === 'string'
      ? { id, name, ...(typeof mapId === 'string' ? { mapId } : {}) }
      : null;
  };
  const levels = (Array.isArray(layers) ? layers : []).flatMap((value: unknown) => {
    const layer = named(value);
    return layer ? [layer] : [];
  });
  return (Array.isArray(maps) ? maps : []).flatMap((value: unknown) => {
    const map = named(value);
    if (!map) return [];
    const own = levels
      .filter((layer) => layer.mapId === map.id)
      .map((layer) => ({ id: layer.id, name: layer.name }));
    return [{ id: map.id, name: map.name, levels: own.length > 1 ? own : [] }];
  });
}

// A game read again may have other maps: the names of other games are read again when asked.
useAtlas.subscribe((state, before) => {
  if (state.library === before.library) return;
  reading.clear();
  mapsKnown.clear();
  useMapNames.setState({ byGame: {} });
});
