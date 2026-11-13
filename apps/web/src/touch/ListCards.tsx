import {
  NO_AREA,
  areaOfPlace,
  type ChecklistEntry,
  type ChecklistItemEntry,
  type ItemState,
} from '@atlas/core';
import { memo } from 'react';
import { UiIcon } from '../components/icons';
import { PhotoTile } from '../components/Photos';
import { setEntryDone, showItemPlace } from '../state/checklists';
import { useAtlas, type LoadedGame } from '../state/store';
import { entryNote, entryWhere } from './listText';
import { areaName, areasOf } from './listViews';
import { TickMark } from './widgets';

/** A group of cards: an area of a map, or the entries with no location. */
interface CardGroup {
  key: string;
  mapId: string | null;
  title: string;
  items: number[];
}

/**
 * The entries in groups: by the area of each entry's first location, in
 * the order the areas come in, and the entries with no location last.
 */
function groupsOf(game: LoadedGame, entry: ChecklistEntry): CardGroup[] {
  const { pack } = game;
  const order = areasOf(game, entry).keys;
  const byArea = new Map<string, CardGroup>();
  for (const key of order) {
    const region = key === NO_AREA ? undefined : pack.regions.get(key);
    byArea.set(key, {
      key,
      mapId: region?.mapId ?? null,
      title: areaName(game, key),
      items: [],
    });
  }
  for (const item of entry.items) {
    const first = item.places.length > 0 ? pack.locations.get(item.places[0]!) : undefined;
    const key = first ? areaOfPlace(pack, first) : NO_AREA;
    let group = byArea.get(key);
    if (!group) {
      group = { key, mapId: null, title: areaName(game, key), items: [] };
      byArea.set(key, group);
    }
    if (group.mapId === null && first) group.mapId = first.mapId;
    group.items.push(item.index);
  }
  return [...byArea.values()].filter((group) => group.items.length > 0);
}

/**
 * The Photo guide's view: a card for every entry, its photo first, then
 * its name, where it is and its note, grouped by area, and by map when the
 * list spans more than one.
 */
export function CardsView({
  game,
  entry,
  states,
}: {
  game: LoadedGame;
  entry: ChecklistEntry;
  states: readonly ItemState[];
}) {
  const groups = groupsOf(game, entry);
  const maps = new Set(groups.map((group) => group.mapId).filter((id) => id !== null));
  const byMap = maps.size > 1;
  const grouped = groups.length > 1 || byMap;
  return (
    <div className="photo-card-groups" data-testid="photo-cards">
      {groups.map((group, at) => {
        const mapHead =
          byMap && (at === 0 || group.mapId !== groups[at - 1]!.mapId) ? (
            <h3 className="photo-cards-map" data-testid="photo-cards-map">
              {group.mapId ? (game.pack.maps.get(group.mapId)?.name ?? 'Map') : 'No location'}
            </h3>
          ) : null;
        return (
          <section key={group.key} aria-label={grouped ? group.title : entry.checklist.name}>
            {mapHead}
            {grouped ? (
              <h4 className="photo-cards-group" data-testid="photo-cards-group">
                {group.title}
              </h4>
            ) : null}
            <div className="photo-cards">
              {group.items.map((index) => (
                <PhotoCard
                  key={entry.items[index]!.item.id}
                  game={game}
                  entry={entry.items[index]!}
                  state={states[index]!}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** One entry as a card. */
const PhotoCard = memo(
  function PhotoCard({
    game,
    entry,
    state,
  }: {
    game: LoadedGame;
    entry: ChecklistItemEntry;
    state: ItemState;
  }) {
    const { pack } = game;
    const { item } = entry;
    const placeId = useAtlas((s) => entry.places.find((id) => !s.found.has(id)) ?? entry.places[0]);
    const first = entry.places.length > 0 ? pack.locations.get(entry.places[0]!) : undefined;
    const photo = item.photos?.[0] ?? first?.photos?.[0];
    const where = entryWhere(game, entry, state, placeId);
    const note = entryNote(game, entry);
    const text = (
      <>
        <span className="photo-card-name">{item.name}</span>
        {where ? <span className="photo-card-where">{where}</span> : null}
      </>
    );
    return (
      <article
        className="photo-card"
        data-testid="photo-card"
        data-item-id={item.id}
        data-done={state.done}
        aria-label={item.name}
      >
        {photo ? (
          <PhotoTile game={game} photo={photo} size="cover" name={item.name} />
        ) : (
          <div className="photo-card-none" aria-hidden="true">
            <UiIcon name="image" size={28} />
          </div>
        )}
        <div className="photo-card-body">
          <button
            type="button"
            role="checkbox"
            aria-checked={state.done}
            aria-label={item.name}
            className="touch-tick-button"
            data-testid="entry-tick"
            onClick={() => {
              setEntryDone(entry, !state.done);
            }}
          >
            <TickMark done={state.done} />
          </button>
          {placeId ? (
            <button
              type="button"
              className="photo-card-text"
              data-testid="entry-show"
              onClick={() => {
                showItemPlace(item.id, placeId);
              }}
            >
              {text}
            </button>
          ) : (
            <div className="photo-card-text">{text}</div>
          )}
          {note ? (
            <p className="photo-card-note" data-testid="photo-card-note">
              {note}
            </p>
          ) : null}
        </div>
      </article>
    );
  },
  (a, b) =>
    a.entry === b.entry &&
    a.game === b.game &&
    a.state.done === b.state.done &&
    a.state.found === b.state.found &&
    a.state.total === b.state.total,
);
