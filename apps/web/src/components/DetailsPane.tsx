import { itemState, percent, pixelToWorld } from '@atlas/core';
import { keyboardHintsOffered } from '../features';
import { goToLocation, toggleFound } from '../state/actions';
import { checklistScreenTitle, openChecklistItem, openGuide } from '../state/checklists';
import { numberFormat, useSummary } from '../state/derived';
import { useAtlas, type LoadedGame } from '../state/store';
import { GlyphBadge, UiIcon } from './icons';
import { MarkdownBody } from './MarkdownBody';

/** Right pane: the selected location, its found toggle and its guide entry. */
export function DetailsPane() {
  const game = useAtlas((s) => s.game);
  const selectedId = useAtlas((s) => s.selectedId);
  const location = selectedId ? game?.pack.locations.get(selectedId) : undefined;
  if (!game || !location) return <EmptyDetails />;
  return <LocationDetails key={location.id} locationId={location.id} />;
}

function EmptyDetails() {
  const game = useAtlas((s) => s.game);
  const checklists = game && !game.checklists.isEmpty ? checklistScreenTitle(game) : null;
  const keyHints = useAtlas(keyboardHintsOffered);
  return (
    <div className="pane-body empty-details" data-testid="details-empty">
      <p>Select a marker on the map, or search for a place.</p>
      {keyHints ? <Shortcuts checklists={checklists} /> : null}
    </div>
  );
}

/** The keys that work anywhere, where there is a keyboard. */
function Shortcuts({ checklists }: { checklists: string | null }) {
  return (
    <>
      <h2 className="section-title">Keyboard</h2>
      <dl className="shortcuts">
        <dt>
          <kbd>/</kbd>
        </dt>
        <dd>Search</dd>
        <dt>
          <kbd>N</kbd>
        </dt>
        <dd>Nearest marker not yet found</dd>
        <dt>
          <kbd>F</kbd>
        </dt>
        <dd>Mark the selection found</dd>
        <dt>
          <kbd>Z</kbd>
        </dt>
        <dd>Undo</dd>
        {checklists ? (
          <>
            <dt>
              <kbd>C</kbd>
            </dt>
            <dd>{checklists}</dd>
          </>
        ) : null}
        <dt>
          <kbd>Esc</kbd>
        </dt>
        <dd>Clear the selection</dd>
      </dl>
    </>
  );
}

function LocationDetails({ locationId }: { locationId: string }) {
  const game = useAtlas((s) => s.game)!;
  const found = useAtlas((s) => s.found.get(locationId));
  const keyHints = useAtlas(keyboardHintsOffered);
  const summary = useSummary();
  const { pack } = game;
  const location = pack.locations.get(locationId)!;
  const category = pack.categories.get(location.categoryId);
  const map = pack.maps.get(location.mapId);
  const layer = pack.layers.get(location.layerId);
  const region = location.regionId ? pack.regions.get(location.regionId) : undefined;
  const parentRegion = region?.parentId ? pack.regions.get(region.parentId) : undefined;
  const guide = location.guideId
    ? pack.data.guides.find((g) => g.id === location.guideId)
    : undefined;
  const entities = location.entityIds.flatMap(
    (id) => pack.data.entities.find((e) => e.id === id) ?? [],
  );
  const trackable = category?.trackable ?? false;
  const regionTally = region && summary ? summary.region(region.id) : undefined;
  const world = map?.worldTransform ? pixelToWorld(location, map.worldTransform) : undefined;
  const multiLayer = map ? pack.layersOf(map.id).length > 1 : false;

  return (
    <article className="pane-body details" aria-labelledby="details-title" data-testid="details">
      <header className="details-head">
        {category ? (
          <GlyphBadge
            icon={category.icon}
            color={category.color}
            size={34}
            muted={Boolean(found)}
          />
        ) : null}
        <div>
          <p className="details-category">{category?.name}</p>
          <h2 className="details-title" id="details-title" data-testid="selected-name">
            {location.name}
          </h2>
        </div>
      </header>

      {trackable ? (
        <button
          type="button"
          className={found ? 'found-toggle found-toggle-on' : 'found-toggle'}
          aria-pressed={Boolean(found)}
          data-testid="found-toggle"
          onClick={() => {
            toggleFound(location.id);
          }}
        >
          <UiIcon name={found ? 'check' : 'target'} />
          <span>{found ? 'Found' : 'Mark found'}</span>
          {keyHints ? <kbd>F</kbd> : null}
        </button>
      ) : (
        <p className="muted small">This category is not tracked.</p>
      )}

      <dl className="facts">
        <dt>Region</dt>
        <dd>
          {region ? (
            <>
              {region.name}
              {parentRegion ? <span className="muted">, {parentRegion.name}</span> : null}
            </>
          ) : (
            <span className="muted">None</span>
          )}
        </dd>
        {regionTally && regionTally.total > 0 ? (
          <>
            <dt>Region progress</dt>
            <dd>
              {numberFormat.format(regionTally.found)}/{numberFormat.format(regionTally.total)}{' '}
              <span className="muted">({percent(regionTally)}%)</span>
            </dd>
          </>
        ) : null}
        <dt>Map</dt>
        <dd>
          {map?.name}
          {multiLayer && layer ? <span className="muted"> · {layer.name}</span> : null}
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
            <dd>{entities.map((e) => e.name).join(', ')}</dd>
          </>
        ) : null}
      </dl>

      <button
        type="button"
        className="link-button"
        onClick={() => {
          goToLocation(location.id);
        }}
      >
        Centre on map
      </button>

      {guide ? (
        <section className="guide" aria-labelledby="guide-title">
          <h3 className="guide-title" id="guide-title">
            {guide.title}
          </h3>
          <MarkdownBody source={guide.body} className="guide-body" />
        </section>
      ) : null}

      <AlsoIn game={game} locationId={location.id} ownGuideId={guide?.id ?? null} />
    </article>
  );
}

/**
 * The checklist items that name a location, and the listed guides that
 * mention it, each a button that opens it on the checklists screen.
 */
function AlsoIn({
  game,
  locationId,
  ownGuideId,
}: {
  game: LoadedGame;
  locationId: string;
  ownGuideId: string | null;
}) {
  const found = useAtlas((s) => s.found);
  const items = game.checklists.itemsAt(locationId);
  const guides = game.checklists.guidesAt(locationId).filter((g) => g.id !== ownGuideId);
  if (items.length === 0 && guides.length === 0) return null;
  return (
    <section className="also-in" aria-labelledby="also-in-title" data-testid="also-in">
      <h3 className="section-title" id="also-in-title">
        On checklists and in guides
      </h3>
      <ul className="plain-list">
        {items.map((entry) => {
          const checklist = game.checklists.checklistOf(entry.item.id)!;
          const done = itemState(entry, (id) => found.has(id)).done;
          return (
            <li key={entry.item.id}>
              <button
                type="button"
                className="list-link"
                onClick={() => {
                  openChecklistItem(entry.item.id);
                }}
              >
                <span className="list-link-name">{entry.item.name}</span>
                {done ? <span className="found-tag">done</span> : null}
                <span className="list-link-detail">Checklist: {checklist.checklist.name}</span>
              </button>
            </li>
          );
        })}
        {guides.map((guide) => (
          <li key={guide.id}>
            <button
              type="button"
              className="list-link"
              onClick={() => {
                openGuide(guide.id);
              }}
            >
              <span className="list-link-name">{guide.title}</span>
              <span className="list-link-detail">Guide</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
