import { typeLookOf, type TypeLookFields } from '@atlas/core';
import { isOwnId, type Category } from '@atlas/schema';
import { notify } from './actions';
import { canChangeOwnLocations, changeTypeLook, packAsRead, useOwnLocations } from './ownLocations';
import { useAtlas } from './store';

/**
 * The person's colour and icon of a type of the game shown (the issue:
 * some icons blend into the map's colours). Any type can be given another
 * colour and icon, from the filters ("Types on this map", the palette
 * button beside a type) or from Edit locations:
 *
 * - a type of the pack keeps its own in the pack; the person's choice is
 *   kept with their own data of the game, in its own locations file (as
 *   `typeLooks`, see `ownLocations.ts` in the schema package), never in
 *   the pack, so a newer version of the pack with the same types keeps
 *   it, and "Back to the pack's own" takes it out;
 * - a type of the person's own is changed in place.
 *
 * The game shown is made with them (`withTypeLooks` in the core package,
 * through `mergeOwnLocations`), so the map, the 3D view, the filters,
 * search, cards and lists all show the type as chosen; the marker
 * sprites are kept by colour and icon, so a change draws anew. Undo in
 * Edit locations takes a change back like any other of the person's own.
 */

/** What the colour and icon dialog shows of a type. */
export interface TypeLookTarget {
  /** The type as it is shown now: with the person's colour and icon. */
  shown: Category;
  /** The type as the pack has it; null for a type of the person's own. */
  original: Category | null;
  /** Whether the person gave this type of the pack a colour or an icon of their own. */
  changed: boolean;
}

/** The type of the game shown as the colour and icon dialog shows it; null when there is none. */
export function useTypeLookTarget(id: string): TypeLookTarget | null {
  const game = useAtlas((s) => s.game);
  const look = useOwnLocations((s) => typeLookOf(s.own, id));
  const shown = game?.pack.categories.get(id);
  if (!game || !shown) return null;
  if (isOwnId(id)) return { shown, original: null, changed: false };
  const original =
    packAsRead(game.pack.manifest.gameId)?.categories.find((c) => c.id === id) ?? shown;
  return { shown, original, changed: look !== undefined };
}

/** Why the colour and icon of a type cannot be changed now, or null when they can. */
export function typeLookBlocked(): string | null {
  if (canChangeOwnLocations()) return null;
  const { readOnly, error } = useOwnLocations.getState();
  return (
    readOnly ??
    error ??
    'Your own data for this game cannot be changed now, so a colour or an icon cannot be kept.'
  );
}

/**
 * Gives a type of the game shown the colour and icon chosen, or takes them
 * out (`look` null): "Back to the pack's own". Null when done, or a
 * sentence saying why not.
 */
export function chooseTypeLook(id: string, look: TypeLookFields | null): string | null {
  const blocked = typeLookBlocked();
  if (blocked) return blocked;
  const type = useAtlas.getState().game?.pack.categories.get(id);
  if (!type) return 'This type is not in the game shown.';
  if (!changeTypeLook(id, look)) return null;
  const own = isOwnId(id);
  // The pack's own colour and icon chosen by hand is the pack's own again.
  if (!own && typeLookOf(useOwnLocations.getState().own, id) === undefined) {
    notify(`“${type.name}” has the pack’s colour and icon again.`);
  } else if (own) {
    notify(`“${type.name}” has the colour and icon you chose.`);
  } else {
    notify(`“${type.name}” has the colour and icon you chose.`, 'info', {
      action: {
        label: 'Back to the pack’s own',
        run: () => {
          const problem = chooseTypeLook(id, null);
          if (problem) notify(problem, 'error');
        },
      },
    });
  }
  return null;
}
