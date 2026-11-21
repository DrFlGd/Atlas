import { useEffect, useState } from 'react';
import { UiIcon } from '../components/icons';
import { RenameMapButton } from '../components/RenameMap';
import {
  mapsAndLevelsAt,
  mapsAndLevelsOf,
  shownName,
  useMapNamesOf,
  type MapAndLevels,
} from '../state/mapNames';
import { packAsRead } from '../state/ownLocations';
import { useAtlas } from '../state/store';

/** Up to this many maps, the list is open at first. */
const OPEN_UP_TO = 8;

/**
 * "Maps and levels" in a game's details in the Library: each map, and each
 * level of a map with several, by the name shown for it, with "Rename…"
 * beside it (see `state/mapNames.ts`). A name the person gave says the
 * original name under it.
 */
export function MapNamesCard({ id }: { id: string }) {
  const entry = useAtlas((s) => s.catalog.find((e) => e.id === id));
  const shownData = useAtlas((s) => (s.game?.entry.id === id ? packAsRead(id) : null));
  const library = useAtlas((s) => s.library);
  const [read, setRead] = useState<MapAndLevels[] | null>(null);
  const names = useMapNamesOf(id);
  const url = entry?.url ?? null;
  useEffect(() => {
    if (!url) return;
    let current = true;
    void mapsAndLevelsAt(url).then((maps) => {
      if (current) setRead(maps);
    });
    return () => {
      current = false;
    };
  }, [url, library]);
  const maps = shownData ? mapsAndLevelsOf(shownData.maps, shownData.layers) : read;
  if (!maps || maps.length === 0) return null;
  const levels = maps.reduce((sum, map) => sum + map.levels.length, 0);
  const row = (target: { id: string; name: string }, kind: 'map' | 'level') => {
    const name = shownName(names, target.id, target.name);
    return (
      <div className="map-names-row" data-testid={`map-names-${kind}`} data-id={target.id}>
        <span className="map-names-text">
          <span className="map-names-name">{name}</span>
          {name !== target.name ? (
            <span className="muted small map-names-original">Original name: {target.name}</span>
          ) : null}
        </span>
        <RenameMapButton
          target={{ gameId: id, id: target.id, kind, original: target.name }}
          name={name}
          className="button button-small rename-map-button"
          withText
        />
      </div>
    );
  };
  return (
    <section className="library-card" aria-label="Maps and levels" data-testid="library-maps-card">
      <h2 className="library-card-title">
        <span className="library-card-icon">
          <UiIcon name="layers" size={18} />
        </span>
        {levels > 0 ? 'Maps and levels' : 'Maps'}
      </h2>
      <p className="library-card-state">
        Rename a {levels > 0 ? 'map or a level' : 'map'} to call it what you like. Your names are
        kept with your own data for this game, so reading it again or updating it keeps them, and
        Use the original name gives the source&apos;s name back.
      </p>
      <details className="map-names" open={maps.length <= OPEN_UP_TO}>
        <summary data-testid="map-names-toggle">
          {maps.length === 1 ? '1 map' : `${maps.length} maps`}
          {levels > 0 ? `, ${levels === 1 ? '1 level' : `${levels} levels`}` : ''}
        </summary>
        <ul className="map-names-list">
          {maps.map((map) => (
            <li key={map.id}>
              {row(map, 'map')}
              {map.levels.length > 0 ? (
                <ul className="map-names-levels">
                  {map.levels.map((level) => (
                    <li key={level.id}>{row(level, 'level')}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
