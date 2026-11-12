import {
  checklistTally,
  countFacets,
  filterChecklist,
  itemFacets,
  itemState,
  type ChecklistEntry,
  type ChecklistItemEntry,
  type ItemState,
} from '@atlas/core';
import { memo, useDeferredValue, useId, useMemo, useState } from 'react';
import { FacetGroup, GuideView, NoteText } from '../components/ChecklistsPane';
import { useFacetNames } from '../components/facetNames';
import { UiIcon } from '../components/icons';
import { VirtualList } from '../components/VirtualList';
import {
  checklistBack,
  checklistScreenTitle,
  openChecklist,
  openGuide,
  setItemDone,
  showItemPlace,
} from '../state/checklists';
import { numberFormat } from '../state/derived';
import { useAtlas, type ChecklistPage, type LoadedGame } from '../state/store';
import { useTouch } from './state';
import { GroupTitle, Meter, TickMark } from './widgets';

const INDEX: ChecklistPage = { kind: 'index' };
const ROW_HEIGHT = 64;

/** Lists: the game's checklists and guides, one checklist, or one guide. */
export function ListsScreen() {
  const game = useAtlas((s) => s.game)!;
  const page = useAtlas((s) => s.checklistPages.at(-1) ?? INDEX);
  if (page.kind === 'checklist') return <ChecklistScreen key={page.id} game={game} id={page.id} />;
  if (page.kind === 'guide') return <GuideScreen key={page.id} game={game} id={page.id} />;
  return <ListsIndex game={game} />;
}

function ListsIndex({ game }: { game: LoadedGame }) {
  const found = useAtlas((s) => s.found);
  const { checklists, guides } = game.checklists;
  const lists = checklists.filter((c) => c.checklist.kind !== 'guide');
  const guideLists = checklists.filter((c) => c.checklist.kind === 'guide');
  const isDone = (id: string) => found.has(id);
  const listRow = (entry: ChecklistEntry) => {
    const tally = checklistTally(entry, isDone);
    return (
      <li key={entry.checklist.id}>
        <button
          type="button"
          className="touch-progress-row"
          data-testid="list-link"
          data-checklist-id={entry.checklist.id}
          onClick={() => {
            openChecklist(entry.checklist.id);
          }}
        >
          <span className="touch-progress-row-head">
            <span className="touch-progress-row-name">{entry.checklist.name}</span>
            <span className="touch-figure">
              {numberFormat.format(tally.done)} of {numberFormat.format(tally.total)} done
            </span>
          </span>
          <Meter found={tally.done} total={tally.total} />
        </button>
      </li>
    );
  };
  return (
    <div className="touch-page">
      <header className="touch-page-head">
        <h1 className="touch-page-title">{checklistScreenTitle(game)}</h1>
      </header>
      <div className="touch-scroll touch-page-body" data-scroll-root>
        {lists.length > 0 ? (
          <section aria-labelledby="lists-heading">
            <GroupTitle id="lists-heading">Checklists</GroupTitle>
            <ul className="touch-plain-list">{lists.map(listRow)}</ul>
          </section>
        ) : null}
        {guideLists.length > 0 || guides.length > 0 ? (
          <section aria-labelledby="guides-heading">
            <GroupTitle id="guides-heading">Guides</GroupTitle>
            <ul className="touch-plain-list">
              {guideLists.map(listRow)}
              {guides.map((guide) => {
                const places = new Set(
                  guide.locationIds.filter((id) => game.pack.locations.has(id)),
                ).size;
                return (
                  <li key={guide.id}>
                    <button
                      type="button"
                      className="touch-row touch-row-button"
                      data-testid="guide-link"
                      onClick={() => {
                        openGuide(guide.id);
                      }}
                    >
                      <span className="touch-row-icon">
                        <UiIcon name="details" size={20} />
                      </span>
                      <span className="touch-row-text">
                        <span className="touch-row-title">{guide.title}</span>
                        <span className="touch-row-detail">
                          Guide
                          {places > 0
                            ? ` · ${places === 1 ? 'one place' : `${numberFormat.format(places)} places`}`
                            : ''}
                        </span>
                      </span>
                      <span className="touch-row-end">
                        <UiIcon name="chevron" size={18} strokeWidth={1.8} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function PageBack({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="touch-icon-button"
      aria-label={label}
      data-testid="lists-back"
      onClick={checklistBack}
    >
      <UiIcon name="back" size={22} strokeWidth={1.8} />
    </button>
  );
}

function backLabel(game: LoadedGame, previous: ChecklistPage): string {
  if (previous.kind === 'checklist') {
    return `Back to ${game.checklists.checklist(previous.id)?.checklist.name ?? 'the checklist'}`;
  }
  if (previous.kind === 'guide') {
    return `Back to ${game.checklists.guide(previous.id)?.title ?? 'the guide'}`;
  }
  return 'Back to all lists';
}

type Filter = 'all' | 'todo' | 'done';

type Row =
  | { kind: 'section'; key: string; title: string }
  | { kind: 'item'; key: string; entry: ChecklistItemEntry };

const rowKey = (row: Row) => row.key;

/** From this many entries a checklist gets a search field, as in the classic layout. */
const SEARCH_FROM = 15;
const NO_KEYS: ReadonlySet<string> = new Set();

/** One checklist: how far it is, All / To do / Done, and its entries with their ticks. */
function ChecklistScreen({ game, id }: { game: LoadedGame; id: string }) {
  const entry = game.checklists.checklist(id);
  const previous = useAtlas((s) => s.checklistPages.at(-2) ?? INDEX);
  if (!entry) {
    return (
      <div className="touch-page">
        <header className="touch-page-head touch-page-head-back">
          <PageBack label={backLabel(game, previous)} />
        </header>
        <p className="touch-empty">This list is not in the pack.</p>
      </div>
    );
  }
  return <ChecklistBody game={game} entry={entry} previous={previous} />;
}

function ChecklistBody({
  game,
  entry,
  previous,
}: {
  game: LoadedGame;
  entry: ChecklistEntry;
  previous: ChecklistPage;
}) {
  const found = useAtlas((s) => s.found);
  const focus = useAtlas((s) => s.itemFocus);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [hiddenRegions, setHiddenRegions] = useState(NO_KEYS);
  const [hiddenCategories, setHiddenCategories] = useState(NO_KEYS);
  const [facetsOpen, setFacetsOpen] = useState(false);
  const names = useFacetNames(game, entry);
  const facetsId = useId();
  const searchId = useId();
  const facets = useMemo(
    () => entry.items.map((item) => itemFacets(item, game.pack)),
    [entry, game],
  );
  const states = useMemo(() => {
    const isDone = (target: string) => found.has(target);
    return entry.items.map((item) => itemState(item, isDone));
  }, [entry, found]);
  const done = states.filter((s) => s.done).length;
  const regionCounts = useMemo(
    () => countFacets(facets, states, 'regions').sort((a, b) => names.compareRegions(a.key, b.key)),
    [facets, states, names],
  );
  const categoryCounts = useMemo(
    () =>
      countFacets(facets, states, 'categories').sort((a, b) =>
        names.compareCategories(a.key, b.key),
      ),
    [facets, states, names],
  );

  // Which entries a filter shows is read when the filter changes, so an
  // entry ticked under "To do" stays under the finger until then.
  const rows = useMemo(() => {
    const isDone = (target: string) => useAtlas.getState().found.has(target);
    const now = entry.items.map((item) => itemState(item, isDone));
    const shown = filterChecklist(facets, now, {
      query: deferredQuery,
      hideFound: false,
      hiddenRegions,
      hiddenCategories,
    });
    const list: Row[] = [];
    let section: string | undefined;
    for (const index of shown) {
      const item = entry.items[index]!;
      const state = now[index]!;
      if ((filter === 'todo' && state.done) || (filter === 'done' && !state.done)) continue;
      if (item.item.section !== section) {
        section = item.item.section;
        if (section) list.push({ kind: 'section', key: `section|${item.index}`, title: section });
      }
      list.push({ kind: 'item', key: item.item.id, entry: item });
    }
    return list;
  }, [entry, facets, filter, deferredQuery, hiddenRegions, hiddenCategories]);

  const reveal = useMemo(() => {
    if (!focus) return null;
    const index = rows.findIndex((r) => r.key === focus.itemId);
    return index < 0 ? null : { index, seq: focus.seq };
  }, [focus, rows]);

  const total = entry.items.length;
  const value = total === 0 ? 0 : Math.floor((done / total) * 100);
  const searchable = total >= SEARCH_FROM;
  const showRegions = regionCounts.length > 1;
  const showCategories = categoryCounts.length > 1;
  const hiddenCount = hiddenRegions.size + hiddenCategories.size;
  const narrowed = deferredQuery.trim() !== '' || hiddenCount > 0;
  const chips: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'todo', label: `To do · ${numberFormat.format(total - done)}` },
    { id: 'done', label: `Done · ${numberFormat.format(done)}` },
  ];
  return (
    <div className="touch-page" data-testid="checklist-screen">
      <header className="touch-page-head touch-page-head-back">
        <div className="touch-page-head-row">
          <PageBack label={backLabel(game, previous)} />
          <div className="touch-page-head-text">
            <h1 className="touch-page-subtitle">{entry.checklist.name}</h1>
            <p
              className="touch-page-figure"
              data-testid="checklist-done"
              data-done={done}
              data-total={total}
            >
              {numberFormat.format(done)} of {numberFormat.format(total)} done · {value}%
            </p>
          </div>
        </div>
        <div
          className="touch-progressbar"
          role="progressbar"
          aria-label={`${entry.checklist.name} done`}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
        >
          <span
            className="touch-meter-fill"
            style={{ width: `${(done / Math.max(1, total)) * 100}%` }}
          />
        </div>
      </header>
      <div className="touch-chips" role="group" aria-label="Show">
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className="touch-chip"
            aria-pressed={chip.id === filter}
            onClick={() => {
              setFilter(chip.id);
            }}
          >
            {chip.label}
          </button>
        ))}
      </div>
      {searchable || showRegions || showCategories ? (
        <div className="touch-list-tools">
          {searchable ? (
            <div className="touch-list-search">
              <label htmlFor={searchId} className="visually-hidden">
                Search this list
              </label>
              <input
                id={searchId}
                className="touch-text-input"
                type="search"
                placeholder="Search this list"
                autoComplete="off"
                spellCheck={false}
                data-testid="list-search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && query) {
                    event.preventDefault();
                    setQuery('');
                  }
                }}
              />
            </div>
          ) : null}
          {showRegions || showCategories ? (
            <button
              type="button"
              className="touch-text-button"
              aria-expanded={facetsOpen}
              aria-controls={facetsId}
              data-testid="list-facets-toggle"
              onClick={() => {
                setFacetsOpen(!facetsOpen);
              }}
            >
              {facetsOpen ? 'Hide filters' : 'Filter by region and category'}
              {hiddenCount > 0 ? ` (${hiddenCount} off)` : ''}
            </button>
          ) : null}
        </div>
      ) : null}
      {facetsOpen ? (
        <div className="touch-list-facets" id={facetsId} data-testid="checklist-facets">
          {showRegions ? (
            <FacetGroup
              legend="Regions"
              counts={regionCounts}
              hidden={hiddenRegions}
              name={names.region}
              group={names.severalMaps ? (key) => names.mapName(names.mapOf(key)) : undefined}
              onChange={setHiddenRegions}
            />
          ) : null}
          {showCategories ? (
            <FacetGroup
              legend="Categories"
              counts={categoryCounts}
              hidden={hiddenCategories}
              name={names.category}
              onChange={setHiddenCategories}
            />
          ) : null}
        </div>
      ) : null}
      <div className="touch-scroll touch-check-list" data-scroll-root>
        {rows.length === 0 ? (
          <p className="touch-empty">
            {total === 0
              ? 'This list has no entries.'
              : narrowed
                ? 'No entries match the filters.'
                : filter === 'todo'
                  ? 'Every entry is done.'
                  : 'Nothing is done yet.'}
          </p>
        ) : (
          <VirtualList
            items={rows}
            getKey={rowKey}
            estimate={ROW_HEIGHT}
            renderItem={(row) =>
              row.kind === 'section' ? (
                <h2 className="touch-group-title touch-group-title-row">{row.title}</h2>
              ) : (
                <EntryRow game={game} entry={row.entry} state={states[row.entry.index]!} />
              )
            }
            className="touch-entry-list"
            testId="check-items"
            visible
            reveal={reveal}
          />
        )}
      </div>
    </div>
  );
}

/**
 * One entry: its tick, its name and where it is, and a way to show it on
 * the map. Where it has more (a note, a guide, several places), a button
 * opens that under it.
 */
const EntryRow = memo(
  function EntryRow({
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
    const wide = useTouch((s) => s.arrangement === 'wide');
    const [more, setMore] = useState(false);
    const moreId = useId();
    const shown = useAtlas((s) => s.selectedId !== null && entry.places.includes(s.selectedId));
    const placeId = useAtlas((s) => entry.places.find((id) => !s.found.has(id)) ?? entry.places[0]);
    const place = placeId ? pack.locations.get(placeId) : undefined;
    const region = place?.regionId ? pack.regions.get(place.regionId) : undefined;
    const where = [
      region?.name ?? (place ? pack.maps.get(place.mapId)?.name : undefined),
      entry.places.length > 1 ? `${entry.places.length} places` : undefined,
      !entry.ownMark && state.total > 1 && !state.done
        ? `${state.found} of ${state.total} found`
        : undefined,
      shown ? 'shown on the map' : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    // What the classic list shows under an entry: the first place's own
    // note (a guide shared by many places is linked instead), the entry's
    // note, and each of its places.
    const first = entry.places.length > 0 ? pack.locations.get(entry.places[0]!) : undefined;
    const guide = first?.guideId ? game.checklists.guide(first.guideId) : undefined;
    const ownNote = guide && !game.checklists.isListed(guide.id) ? guide : undefined;
    const sharedGuide = guide && game.checklists.isListed(guide.id) ? guide : undefined;
    const hasMore =
      ownNote !== undefined ||
      Boolean(item.note) ||
      sharedGuide !== undefined ||
      entry.places.length > 1;
    const show = () => {
      if (placeId) showItemPlace(item.id, placeId);
    };
    const text = (
      <>
        <span className="touch-entry-name">{item.name}</span>
        {where ? <span className="touch-entry-where">{where}</span> : null}
      </>
    );
    return (
      <div
        className={[
          'touch-entry',
          state.done ? 'touch-entry-done' : '',
          shown ? 'touch-entry-shown' : '',
          more ? 'touch-entry-open' : '',
        ].join(' ')}
        data-testid="check-item"
        data-item-id={item.id}
        data-done={state.done}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={state.done}
          aria-label={item.name}
          className="touch-tick-button"
          data-testid="entry-tick"
          onClick={() => {
            setItemDone(item.id, !state.done);
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
            aria-label={more ? `Less about ${item.name}` : `More about ${item.name}`}
            aria-expanded={more}
            aria-controls={moreId}
            data-testid="entry-more"
            onClick={() => {
              setMore(!more);
            }}
          >
            <UiIcon name={more ? 'chevronUp' : 'chevronDown'} size={20} strokeWidth={1.8} />
          </button>
        ) : null}
        {placeId && !wide ? (
          <button
            type="button"
            className="touch-tick-button touch-entry-pin"
            aria-label={`Show ${place?.name ?? item.name} on the map`}
            onClick={show}
          >
            <UiIcon name="pin" size={22} />
          </button>
        ) : null}
        {more ? (
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
    a.state.done === b.state.done &&
    a.state.found === b.state.found &&
    a.state.total === b.state.total,
);

/** One guide, as the guide pages show it. */
function GuideScreen({ game, id }: { game: LoadedGame; id: string }) {
  const previous = useAtlas((s) => s.checklistPages.at(-2) ?? INDEX);
  return (
    <div className="touch-page" data-testid="guide-screen">
      <header className="touch-page-head touch-page-head-back">
        <div className="touch-page-head-row">
          <PageBack label={backLabel(game, previous)} />
          <p className="touch-page-kicker">Guide</p>
        </div>
      </header>
      <div className="touch-scroll touch-page-body touch-guide" data-scroll-root>
        <GuideView game={game} id={id} back={false} />
      </div>
    </div>
  );
}
