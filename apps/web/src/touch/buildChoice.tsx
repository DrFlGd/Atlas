import type { BuildThing } from '@atlas/core';
import { useState } from 'react';
import {
  addToBuild,
  canAddToBuild,
  rememberedBuildList,
  useBuildPlanner,
} from '../state/buildPlanner';
import { useOwnLists } from '../state/ownLists';
import type { LoadedGame } from '../state/store';
import { BuildListDialog } from './BuildListDialog';

/**
 * "Add to build": a thing (a wiki page, a row of a page's table, a
 * location, a result of the search) added as a step at the end of a Build
 * guide of the person's own (see `buildPlanner.ts`). The first time, it
 * asks which Build guide, or starts a new one; after that the same list is
 * used with one press, and "Change" chooses another. It needs no list
 * editor, so it works at any size.
 */
export function useAddToBuild(game: LoadedGame | null) {
  const offered = useOwnLists((s) => canAddToBuild(game, s));
  // The list remembered, and the lists, change what is offered.
  useBuildPlanner((s) => s.listId);
  useOwnLists((s) => s.lists);
  const [asking, setAsking] = useState<{
    thing: BuildThing | null;
    from: HTMLElement | null;
  } | null>(null);
  const target = game && offered ? rememberedBuildList(game) : undefined;
  const add = (thing: BuildThing, from: HTMLElement | null = null) => {
    if (!game || !offered) return;
    const list = rememberedBuildList(game);
    if (list) addToBuild(game, list.checklist.id, thing);
    else setAsking({ thing, from });
  };
  const choose = (from: HTMLElement | null = null) => {
    setAsking({ thing: null, from });
  };
  const dialog =
    asking && game ? (
      <BuildListDialog
        game={game}
        thing={asking.thing}
        onClose={() => {
          const { from } = asking;
          setAsking(null);
          if (from?.isConnected) from.focus();
        }}
      />
    ) : null;
  return { offered, target, add, choose, dialog };
}
