import { useEffect, useState } from 'react';
import { importsOffered } from '../features';
import { updatableGames } from '../state/importing';
import { useAtlas } from '../state/store';

/** The ids of the games that "Check the site for changes" can read again; none without importers. */
export function useUpdatable(): ReadonlySet<string> {
  const library = useAtlas((s) => s.library);
  const imports = useAtlas(importsOffered);
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!imports) return;
    let live = true;
    updatableGames().then(
      (games) => {
        if (live) setIds(new Set(games.map((game) => game.packId)));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [library, imports]);
  return ids;
}
