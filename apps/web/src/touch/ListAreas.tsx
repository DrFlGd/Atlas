import {
  areaAt,
  areaTallies,
  nextArea,
  orderAreas,
  placesIn,
  type ChecklistEntry,
  type GroupTally,
  type ItemState,
} from '@atlas/core';
import { useMemo, useState } from 'react';
import { UiIcon } from '../components/icons';
import { numberFormat } from '../state/derived';
import { useAtlas, type LoadedGame } from '../state/store';
import { KindList, ShowChoice, type Show } from './ListGroups';
import { PageBack } from './ListRows';
import { ofText } from './listText';
import { areaName, areasOf, fitPlaces, openArea, useItemStates } from './listViews';
import { Meter, TickMark } from './widgets';

const NONE: readonly number[] = [];

/** The area the map is in when a view opens (see `areaAt`); it is read once, so rows do not move. */
function useAreaHere(game: LoadedGame): string | null {
  const [here] = useState(() => {
    const { mapId, view } = useAtlas.getState();
    return mapId && view ? areaAt(game.pack, mapId, view.center) : null;
  });
  return here;
}

/** A list's areas, in the order "By area" shows them (see `orderAreas`). */
function useOrderedAreas(
  game: LoadedGame,
  entry: ChecklistEntry,
  states: readonly ItemState[],
  here: string | null,
): GroupTally[] {
  return useMemo(
    () => orderAreas(areaTallies(areasOf(game, entry), states), here),
    [game, entry, states, here],
  );
}

/** "By area": one card per area, the map's own first, the finished ones last. */
export function AreasView({
  game,
  entry,
  states,
}: {
  game: LoadedGame;
  entry: ChecklistEntry;
  states: readonly ItemState[];
}) {
  const here = useAreaHere(game);
  const areas = useOrderedAreas(game, entry, states, here);
  return (
    <div className="touch-scroll touch-page-body touch-area-list" data-scroll-root>
      <ul className="touch-plain-list touch-list-cards" aria-label="Areas" data-testid="areas">
        {areas.map((area) => {
          const finished = area.total > 0 && area.found === area.total;
          const name = areaName(game, area.key);
          return (
            <li key={area.key}>
              <button
                type="button"
                className={[
                  'touch-list-card',
                  area.key === here ? 'touch-list-card-here' : '',
                  finished ? 'touch-list-card-finished' : '',
                ].join(' ')}
                data-testid="area-link"
                data-area={area.key}
                data-found={area.found}
                data-total={area.total}
                onClick={() => {
                  openArea(entry.checklist.id, area.key);
                }}
              >
                {finished ? <TickMark done round /> : null}
                <span className="touch-list-card-text">
                  <span className="touch-list-card-head">
                    <span className="touch-list-card-name">{name}</span>
                    {area.key === here ? (
                      <span className="touch-tag" data-testid="map-is-here">
                        Map is here
                      </span>
                    ) : null}
                    <span className="touch-figure">
                      {finished
                        ? `All ${numberFormat.format(area.total)} found`
                        : ofText(area.found, area.total)}
                    </span>
                  </span>
                  {finished ? null : <Meter found={area.found} total={area.total} />}
                </span>
                <UiIcon name="chevron" size={20} strokeWidth={1.8} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * One area of a list: its entries by kind, what is left to find first,
 * and the next area to go to. The map button fits the map to the area's
 * places.
 */
export function AreaScreen({
  game,
  entry,
  area,
}: {
  game: LoadedGame;
  entry: ChecklistEntry;
  area: string;
}) {
  const states = useItemStates(entry);
  const here = useAreaHere(game);
  const areas = useOrderedAreas(game, entry, states, here);
  const scope = areasOf(game, entry).items.get(area) ?? NONE;
  const [show, setShow] = useState<Show>('todo');
  let found = 0;
  for (const i of scope) if (states[i]!.done) found++;
  const total = scope.length;
  const name = areaName(game, area);
  const next = nextArea(areas, area);
  const places = useMemo(
    () => scope.flatMap((i) => placesIn(game.pack, entry.items[i]!.places, area)),
    [scope, game, entry, area],
  );
  return (
    <div className="touch-page touch-area-screen" data-testid="area-screen" data-area={area}>
      <header className="touch-page-head touch-page-head-back">
        <div className="touch-page-head-row">
          <PageBack />
          <div className="touch-page-head-text">
            <h1 className="touch-page-subtitle">{name}</h1>
            <p
              className="touch-page-figure"
              data-testid="area-done"
              data-done={found}
              data-total={total}
            >
              {entry.checklist.name} · {ofText(found, total)} found
            </p>
          </div>
          {places.length > 0 ? (
            <button
              type="button"
              className="touch-icon-button touch-accent-button"
              aria-label="Show this area on the map"
              data-testid="area-on-map"
              onClick={() => {
                fitPlaces(game, places);
              }}
            >
              <UiIcon name="map" size={22} />
            </button>
          ) : null}
        </div>
        <div
          className="touch-progressbar"
          role="progressbar"
          aria-label={`${name} found`}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={found}
        >
          <span
            className="touch-meter-fill"
            style={{ width: `${(found / Math.max(1, total)) * 100}%` }}
          />
        </div>
      </header>
      <ShowChoice left={total - found} show={show} onChange={setShow} />
      <KindList
        key={show}
        game={game}
        entry={entry}
        states={states}
        show={show}
        area={area}
        scope={scope}
      />
      {next ? (
        <button
          type="button"
          className="touch-pinned touch-next-area"
          data-testid="next-area"
          onClick={() => {
            openArea(entry.checklist.id, next.key, true);
          }}
        >
          <span className="touch-pinned-text">
            <span className="touch-pinned-label">Next area</span>
            <span className="touch-pinned-name">
              {areaName(game, next.key)} · {numberFormat.format(next.total - next.found)} to find
            </span>
          </span>
          <UiIcon name="chevron" size={22} strokeWidth={1.8} />
        </button>
      ) : null}
    </div>
  );
}
