import { itemState, pixelToWorld } from '@atlas/core';
import { useEffect, useRef } from 'react';
import { GlyphBadge, UiIcon } from '../components/icons';
import { MarkdownBody } from '../components/MarkdownBody';
import { goToLocation, jumpToNearestUnfound, notify, select } from '../state/actions';
import { openChecklistItem, openGuide, showItemPlace } from '../state/checklists';
import { numberFormat, useSummary } from '../state/derived';
import { useAtlas, type LoadedGame } from '../state/store';
import { nextOnList } from './ordering';
import { markFound, setPlaceExpanded, useTouch } from './state';

/** How far a finger moves the sheet's head before it counts as a swipe. */
const SWIPE = 40;

/**
 * The selected place: a sheet over the bottom of the map on a phone, a
 * card at the bottom right of the map on a wide screen. Its short state
 * says what and where the place is and has the two things done most:
 * mark it found, and go to the next one. Pulled up (or on a wide screen
 * always), it shows the rest.
 */
export function PlaceSheet({ wide }: { wide: boolean }) {
  const game = useAtlas((s) => s.game);
  const selectedId = useAtlas((s) => s.selectedId);
  const location = selectedId ? game?.pack.locations.get(selectedId) : undefined;
  if (!game || !location) return null;
  return <Place key={location.id} game={game} locationId={location.id} wide={wide} />;
}

function Place({
  game,
  locationId,
  wide,
}: {
  game: LoadedGame;
  locationId: string;
  wide: boolean;
}) {
  const found = useAtlas((s) => s.found.has(locationId));
  const expanded = useTouch((s) => s.placeExpanded);
  const summary = useSummary();
  const { pack } = game;
  const location = pack.locations.get(locationId)!;
  const category = pack.categories.get(location.categoryId);
  const region = location.regionId ? pack.regions.get(location.regionId) : undefined;
  const trackable = game.counter.isTrackable(locationId);
  const tally = summary
    ? region
      ? summary.region(region.id)
      : summary.map(location.mapId)
    : undefined;
  const where = region?.name ?? pack.maps.get(location.mapId)?.name ?? '';
  const swipe = useRef<{ id: number; y: number } | null>(null);
  const sheet = useRef<HTMLElement>(null);
  // The toast sits above the sheet, so the sheet says how tall it is.
  useEffect(() => {
    const node = sheet.current;
    const root = node?.closest<HTMLElement>('.touch');
    if (!node || !root || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      root.style.setProperty('--touch-sheet-h', `${Math.round(node.offsetHeight)}px`);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--touch-sheet-h');
    };
  }, []);
  const close = () => {
    select(null);
  };
  const open = wide || expanded;

  return (
    <section
      ref={sheet}
      className={wide ? 'place-sheet place-card' : 'place-sheet'}
      aria-label="Selected place"
      data-testid="place-sheet"
      data-expanded={open}
    >
      <div
        className="place-grip-area"
        onPointerDown={(event) => {
          if (wide) return;
          swipe.current = { id: event.pointerId, y: event.clientY };
        }}
        onPointerUp={(event) => {
          const start = swipe.current;
          swipe.current = null;
          if (start?.id !== event.pointerId) return;
          const dy = event.clientY - start.y;
          if (dy < -SWIPE) setPlaceExpanded(true);
          else if (dy > SWIPE) {
            if (expanded) setPlaceExpanded(false);
            else close();
          }
        }}
        onPointerCancel={() => {
          swipe.current = null;
        }}
      >
        {wide ? null : <div className="place-grip" aria-hidden="true" />}
        <header className="place-head">
          {category ? (
            <GlyphBadge icon={category.icon} color={category.color} size={46} muted={found} />
          ) : null}
          <div className="place-title-block">
            <p className="place-kind">{category?.name}</p>
            <h2 className="place-title" data-testid="selected-name">
              {location.name}
            </h2>
            <p className="place-where" data-testid="place-where">
              {where}
              {tally && tally.total > 0
                ? ` · ${numberFormat.format(tally.found)} of ${numberFormat.format(tally.total)} found here`
                : ''}
            </p>
          </div>
          <button
            type="button"
            className="touch-round-button"
            aria-label="Close"
            data-testid="close-place"
            onClick={close}
          >
            <UiIcon name="close" size={18} strokeWidth={1.8} />
          </button>
        </header>
      </div>
      <PlaceActions game={game} locationId={locationId} trackable={trackable} found={found} />
      {wide ? null : (
        <button
          type="button"
          className="place-details-row"
          aria-expanded={expanded}
          aria-controls="place-details"
          data-testid="place-details-row"
          onClick={() => {
            setPlaceExpanded(!expanded);
          }}
        >
          <UiIcon name="details" size={20} />
          <span className="place-details-row-text">
            <DetailsSummary game={game} locationId={locationId} />
          </span>
          <UiIcon name={expanded ? 'chevronDown' : 'chevronUp'} size={18} strokeWidth={1.8} />
        </button>
      )}
      {open ? <PlaceDetails game={game} locationId={locationId} wide={wide} /> : null}
    </section>
  );
}

/** Mark found, and the next place: the next entry of the list that is open, or the nearest. */
function PlaceActions({
  game,
  locationId,
  trackable,
  found,
}: {
  game: LoadedGame;
  locationId: string;
  trackable: boolean;
  found: boolean;
}) {
  const page = useAtlas((s) => s.checklistPages.at(-1));
  const list = page?.kind === 'checklist' ? game.checklists.checklist(page.id) : undefined;
  const listItem = list?.items.find((i) => i.places.includes(locationId));
  // The next button leads once there is nothing to mark here.
  const nextLeads = !trackable || found;
  const next = listItem ? (
    <button
      type="button"
      className={nextLeads ? 'place-action place-action-primary' : 'place-action'}
      data-testid="next-on-list"
      onClick={() => {
        const isDone = (id: string) => useAtlas.getState().found.has(id);
        const target = nextOnList(list!, listItem.item.id, isDone);
        if (target) showItemPlace(target.itemId, target.locationId);
        else notify(`Every entry on ${list!.checklist.name} with a place is done.`);
      }}
    >
      Next on this list
      <UiIcon name="chevron" size={18} strokeWidth={2} />
    </button>
  ) : (
    <button
      type="button"
      className={nextLeads ? 'place-action place-action-primary' : 'place-action'}
      data-testid="next-nearest"
      onClick={jumpToNearestUnfound}
    >
      Next nearest
      <UiIcon name="chevron" size={18} strokeWidth={1.8} />
    </button>
  );
  return (
    <div className="place-actions">
      {trackable ? (
        <button
          type="button"
          className={
            found ? 'place-action place-action-found' : 'place-action place-action-primary'
          }
          aria-pressed={found}
          data-testid="mark-found"
          onClick={() => {
            markFound(locationId, !found);
          }}
        >
          <UiIcon name="check" size={22} strokeWidth={2.2} />
          {found ? 'Found' : 'Mark found'}
        </button>
      ) : null}
      {next}
    </div>
  );
}

/** "Guide: … · on 2 checklists": what pulling the sheet up shows. */
function DetailsSummary({ game, locationId }: { game: LoadedGame; locationId: string }) {
  const { pack, checklists } = game;
  const location = pack.locations.get(locationId)!;
  const guide = location.guideId ? checklists.guide(location.guideId) : undefined;
  const items = checklists.itemsAt(locationId);
  const lists = new Set(items.map((i) => checklists.checklistOf(i.item.id)?.checklist.id)).size;
  const guides = checklists.guidesAt(locationId).filter((g) => g.id !== guide?.id).length;
  const more = [
    lists > 0 ? `on ${lists === 1 ? '1 checklist' : `${lists} checklists`}` : null,
    guides > 0 ? `in ${guides === 1 ? '1 guide' : `${guides} guides`}` : null,
  ].filter((part) => part !== null);
  return (
    <>
      {guide ? `Guide: ${guide.title}` : 'Details'}
      {more.length > 0 ? <span className="muted"> · {more.join(', ')}</span> : null}
    </>
  );
}

/** Everything about the place: its note or guide, its lists, what it relates to, where it is. */
function PlaceDetails({
  game,
  locationId,
  wide,
}: {
  game: LoadedGame;
  locationId: string;
  wide: boolean;
}) {
  const found = useAtlas((s) => s.found);
  const fromSave = useAtlas((s) => s.found.get(locationId)?.source === 'save');
  const { pack, checklists } = game;
  const location = pack.locations.get(locationId)!;
  const map = pack.maps.get(location.mapId);
  const layer = pack.layers.get(location.layerId);
  const region = location.regionId ? pack.regions.get(location.regionId) : undefined;
  const parent = region?.parentId ? pack.regions.get(region.parentId) : undefined;
  const guide = location.guideId ? checklists.guide(location.guideId) : undefined;
  const entities = location.entityIds.flatMap(
    (id) => pack.data.entities.find((e) => e.id === id)?.name ?? [],
  );
  const items = checklists.itemsAt(locationId);
  const guides = checklists.guidesAt(locationId).filter((g) => g.id !== guide?.id);
  const world = map?.worldTransform ? pixelToWorld(location, map.worldTransform) : undefined;
  const levels = map ? pack.layersOf(map.id).length > 1 : false;
  const isDone = (id: string) => found.has(id);

  return (
    <div className="place-details" id="place-details" data-testid="place-details">
      {fromSave ? <p className="touch-note">Marked found from a game save.</p> : null}
      {guide ? (
        <section className="place-guide" aria-label={guide.title}>
          <h3 className="place-guide-title">{guide.title}</h3>
          <MarkdownBody
            source={guide.body}
            className={wide ? 'guide-body place-guide-body-short' : 'guide-body'}
          />
        </section>
      ) : null}
      {items.length > 0 || guides.length > 0 ? (
        <ul className="touch-plain-list place-lists" data-testid="place-lists">
          {items.map((entry) => {
            const list = checklists.checklistOf(entry.item.id);
            const done = itemState(entry, isDone).done;
            return (
              <li key={entry.item.id}>
                <button
                  type="button"
                  className="place-list-row"
                  onClick={() => {
                    openChecklistItem(entry.item.id);
                  }}
                >
                  <UiIcon name="checklist" size={20} />
                  <span className="place-list-row-text">
                    <span>{entry.item.name}</span>
                    <span className="muted small-text">
                      On the checklist {list?.checklist.name}
                      {done ? ' · done' : ''}
                    </span>
                  </span>
                  <UiIcon name="chevron" size={18} strokeWidth={1.8} />
                </button>
              </li>
            );
          })}
          {guides.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                className="place-list-row"
                onClick={() => {
                  openGuide(g.id);
                }}
              >
                <UiIcon name="details" size={20} />
                <span className="place-list-row-text">
                  <span>{g.title}</span>
                  <span className="muted small-text">Guide</span>
                </span>
                <UiIcon name="chevron" size={18} strokeWidth={1.8} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="place-facts">
        <dt>Region</dt>
        <dd>
          {region ? (
            <>
              {region.name}
              {parent ? <span className="muted">, {parent.name}</span> : null}
            </>
          ) : (
            <span className="muted">None</span>
          )}
        </dd>
        <dt>Map</dt>
        <dd>
          {map?.name}
          {levels && layer ? <span className="muted"> · {layer.name}</span> : null}
        </dd>
        {world ? (
          <>
            <dt>Coordinates</dt>
            <dd className="mono">
              {Math.round(world.x)}, {Math.round(world.y)}
            </dd>
          </>
        ) : null}
        {entities.length > 0 ? (
          <>
            <dt>Related</dt>
            <dd>{entities.join(', ')}</dd>
          </>
        ) : null}
      </dl>
      <button
        type="button"
        className="touch-text-button"
        onClick={() => {
          goToLocation(locationId);
        }}
      >
        <UiIcon name="target" size={18} />
        Centre on map
      </button>
    </div>
  );
}
