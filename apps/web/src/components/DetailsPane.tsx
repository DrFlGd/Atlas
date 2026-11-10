import { percent, pixelToWorld } from '@atlas/core';
import { useMemo } from 'react';
import { renderGuideMarkdown } from '../markdown';
import { goToLocation, toggleFound } from '../state/actions';
import { numberFormat, useSummary } from '../state/derived';
import { useAtlas } from '../state/store';
import { GlyphBadge, UiIcon } from './icons';

/** Right pane: the selected location, its found toggle and its guide entry. */
export function DetailsPane() {
  const game = useAtlas((s) => s.game);
  const selectedId = useAtlas((s) => s.selectedId);
  const location = selectedId ? game?.pack.locations.get(selectedId) : undefined;
  if (!game || !location) return <EmptyDetails />;
  return <LocationDetails key={location.id} locationId={location.id} />;
}

function EmptyDetails() {
  return (
    <div className="pane-body empty-details" data-testid="details-empty">
      <p>Select a marker on the map, or search for a place.</p>
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
        <dt>
          <kbd>Esc</kbd>
        </dt>
        <dd>Clear the selection</dd>
      </dl>
    </div>
  );
}

function LocationDetails({ locationId }: { locationId: string }) {
  const game = useAtlas((s) => s.game)!;
  const found = useAtlas((s) => s.found.get(locationId));
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
  const guideHtml = useMemo(() => (guide ? renderGuideMarkdown(guide.body) : ''), [guide]);
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
          <kbd>F</kbd>
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
          {/* markdown-it runs with raw HTML disabled, so this holds only renderer-made tags. */}
          <div className="guide-body" dangerouslySetInnerHTML={{ __html: guideHtml }} />
        </section>
      ) : null}
    </article>
  );
}
