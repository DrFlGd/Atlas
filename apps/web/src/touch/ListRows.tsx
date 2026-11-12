import { placesIn, type ChecklistItemEntry, type ItemState } from '@atlas/core';
import { memo, useId, useState } from 'react';
import { NoteText } from '../components/ChecklistsPane';
import { UiIcon } from '../components/icons';
import { checklistBack, openGuide, setEntryDone, showItemPlace } from '../state/checklists';
import { useAtlas, type ChecklistPage, type LoadedGame } from '../state/store';
import { entryWhere, ofText } from './listText';
import { areaName, listById } from './listViews';
import { useTouch } from './state';
import { TickMark } from './widgets';

const INDEX: ChecklistPage = { kind: 'index' };

interface EntryRowProps {
  game: LoadedGame;
  entry: ChecklistItemEntry;
  state: ItemState;
  /** The second line; by default, where the entry is. */
  detail?: string;
  /** Offer to open the entry's note, guide and places under it (the list in order). */
  more?: boolean;
  /** Only the places in this area are shown from the row (an area of a list). */
  area?: string;
  /** The step "In order" points at. */
  next?: boolean;
  /** A note shown under the row at once (the next step's). */
  note?: string;
}

/**
 * One entry of a list: its tick, its name and a second line, and a way to
 * show it on the map. In order, a button opens its note, guide and places
 * under it.
 */
export const EntryRow = memo(
  function EntryRow({ game, entry, state, detail, more = false, area, next, note }: EntryRowProps) {
    const { pack } = game;
    const { item } = entry;
    const wide = useTouch((s) => s.arrangement === 'wide');
    const [open, setOpen] = useState(false);
    const moreId = useId();
    const places = area === undefined ? entry.places : placesIn(pack, entry.places, area);
    const shown = useAtlas((s) => s.selectedId !== null && places.includes(s.selectedId));
    const placeId = useAtlas((s) => places.find((id) => !s.found.has(id)) ?? places[0]);
    const place = placeId ? pack.locations.get(placeId) : undefined;
    const second = [
      detail ?? entryWhere(game, entry, state, placeId),
      shown ? 'shown on the map' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const first = entry.places.length > 0 ? pack.locations.get(entry.places[0]!) : undefined;
    const guide = first?.guideId ? game.checklists.guide(first.guideId) : undefined;
    const ownNote = guide && !game.checklists.isListed(guide.id) ? guide : undefined;
    const sharedGuide = guide && game.checklists.isListed(guide.id) ? guide : undefined;
    const hasMore =
      more &&
      (ownNote !== undefined ||
        Boolean(item.note) ||
        sharedGuide !== undefined ||
        entry.places.length > 1);
    const show = () => {
      if (placeId) showItemPlace(item.id, placeId);
    };
    const text = (
      <>
        <span className="touch-entry-name">
          {next ? <span className="visually-hidden">Next up: </span> : null}
          {item.name}
        </span>
        {second ? <span className="touch-entry-where">{second}</span> : null}
      </>
    );
    return (
      <div
        className={[
          'touch-entry',
          state.done ? 'touch-entry-done' : '',
          shown ? 'touch-entry-shown' : '',
          next ? 'touch-entry-next' : '',
          open ? 'touch-entry-open' : '',
        ].join(' ')}
        data-testid="check-item"
        data-item-id={item.id}
        data-done={state.done}
        data-next={next ? 'true' : undefined}
      >
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
            className="touch-entry-body"
            aria-current={shown ? 'true' : undefined}
            data-testid="entry-show"
            onClick={show}
          >
            {text}
          </button>
        ) : (
          <div className="touch-entry-body">{text}</div>
        )}
        {hasMore ? (
          <button
            type="button"
            className="touch-tick-button touch-entry-more"
            aria-label={open ? `Less about ${item.name}` : `More about ${item.name}`}
            aria-expanded={open}
            aria-controls={moreId}
            data-testid="entry-more"
            onClick={() => {
              setOpen(!open);
            }}
          >
            <UiIcon name={open ? 'chevronUp' : 'chevronDown'} size={20} strokeWidth={1.8} />
          </button>
        ) : null}
        {placeId && !wide ? (
          <button
            type="button"
            className="touch-tick-button touch-entry-pin"
            aria-label={`Show ${place?.name ?? item.name} on the map`}
            data-testid="entry-pin"
            onClick={show}
          >
            <UiIcon name="pin" size={22} />
          </button>
        ) : null}
        {note && !open ? (
          <p className="touch-entry-note" data-testid="entry-note">
            <UiIcon name="details" size={16} />
            <span>{note}</span>
          </p>
        ) : null}
        {open ? (
          <div className="touch-entry-more-body" id={moreId} data-testid="entry-more-body">
            {ownNote ? <NoteText source={ownNote.body} /> : null}
            {item.note ? <NoteText source={item.note} /> : null}
            {sharedGuide ? (
              <button
                type="button"
                className="touch-text-button"
                onClick={() => {
                  openGuide(sharedGuide.id);
                }}
              >
                Guide: {sharedGuide.title}
              </button>
            ) : null}
            {entry.places.length > 1 ? (
              <ul className="touch-plain-list touch-entry-places">
                {entry.places.map((locationId) => {
                  const location = pack.locations.get(locationId);
                  const map = location ? pack.maps.get(location.mapId) : undefined;
                  return (
                    <li key={locationId}>
                      <button
                        type="button"
                        className="touch-text-button"
                        onClick={() => {
                          showItemPlace(item.id, locationId);
                        }}
                      >
                        <UiIcon name="pin" size={16} />
                        {location?.name ?? locationId}
                        {map && pack.data.maps.length > 1 ? (
                          <span className="muted"> · {map.name}</span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  },
  (a, b) =>
    a.entry === b.entry &&
    a.game === b.game &&
    a.detail === b.detail &&
    a.more === b.more &&
    a.area === b.area &&
    a.next === b.next &&
    a.note === b.note &&
    a.state.done === b.state.done &&
    a.state.found === b.state.found &&
    a.state.total === b.state.total,
);

/** The heading of a group of entries (a kind, a stage) that opens and closes it. */
export function GroupHeader({
  title,
  found,
  total,
  open,
  onToggle,
  color,
  badge,
  testId,
}: {
  title: string;
  found: number;
  total: number;
  open: boolean;
  onToggle: () => void;
  /** A dot of the kind's colour. */
  color?: string;
  /** What comes before the title: a stage's number, or its tick once finished. */
  badge?: React.ReactNode;
  testId?: string;
}) {
  const finished = total > 0 && found === total;
  return (
    <h3 className="touch-fold-title">
      <button
        type="button"
        className={finished ? 'touch-fold touch-fold-finished' : 'touch-fold'}
        aria-expanded={open}
        data-testid={testId}
        onClick={onToggle}
      >
        {color ? (
          <span className="touch-fold-dot" style={{ background: color }} aria-hidden="true" />
        ) : null}
        {badge}
        <span className="touch-fold-name">{title}</span>
        <span className="touch-figure">{ofText(found, total)}</span>
        <UiIcon name={open ? 'chevronUp' : 'chevronDown'} size={18} strokeWidth={1.8} />
      </button>
    </h3>
  );
}

/** Back to the page before: a list, a guide, or all lists. */
export function PageBack() {
  const game = useAtlas((s) => s.game)!;
  const previous = useAtlas((s) => s.checklistPages.at(-2) ?? INDEX);
  return (
    <button
      type="button"
      className="touch-icon-button"
      aria-label={backLabel(game, previous)}
      data-testid="lists-back"
      onClick={checklistBack}
    >
      <UiIcon name="back" size={22} strokeWidth={1.8} />
    </button>
  );
}

function backLabel(game: LoadedGame, previous: ChecklistPage): string {
  if (previous.kind === 'checklist') {
    const name = listById(game, previous.id)?.checklist.name ?? 'the list';
    if (previous.area === undefined) return `Back to ${name}`;
    return `Back to ${areaName(game, previous.area)}`;
  }
  if (previous.kind === 'guide') {
    return `Back to ${game.checklists.guide(previous.id)?.title ?? 'the guide'}`;
  }
  return 'Back to all lists';
}
