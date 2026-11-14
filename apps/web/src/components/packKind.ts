import { useEffect, useState } from 'react';
import { gameKind, loadGameFacts, useGameFacts, type GameKind } from '../state/gameFacts';
import { wikiSiteOf, type WikiSite } from '../state/importing';
import { useAtlas } from '../state/store';

/**
 * What a pack is, for the confirmations of deleting it or starting it
 * again: a wiki, maps or a game made here, and for a wiki, the site this
 * app forgets with it. Read from this computer only.
 */

/** What a pack is, from its details, read when not known yet. */
export function usePackKind(id: string): GameKind {
  const listed = useAtlas((s) => s.library?.packs.find((p) => p.id === id));
  const details = useGameFacts((s) => s.byId[id]?.details ?? null);
  const known = useGameFacts((s) => s.byId[id] !== undefined);
  useEffect(() => {
    if (!known) void loadGameFacts(id);
  }, [id, known]);
  return gameKind(listed, details);
}

/** The site of a wiki, as deleting it forgets it: undefined while looked up, null when none. */
export function useWikiSite(id: string, kind: GameKind): WikiSite | null | undefined {
  const [site, setSite] = useState<{ id: string; site: WikiSite | null } | null>(null);
  useEffect(() => {
    if (kind !== 'wiki') return;
    let current = true;
    void wikiSiteOf(id)
      .catch(() => null)
      .then((found) => {
        if (current) setSite({ id, site: found });
      });
    return () => {
      current = false;
    };
  }, [id, kind]);
  if (kind !== 'wiki') return null;
  return site?.id === id ? site.site : undefined;
}
