import {
  checklistTally,
  countFacets,
  filterChecklist,
  itemFacets,
  itemState,
  tallyStates,
  type ChecklistEntry,
  type ChecklistItemEntry,
  type ChecklistTally,
  type FacetCount,
  type ItemState,
} from '@atlas/core';
import { isOwnId, type GuideEntry } from '@atlas/schema';
import { memo, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { goToLocation, setHideDone } from '../state/actions';
import {
  checklistBack,
  checklistScreenTitle,
  openChecklist,
  openGuide,
  setItemDone,
  showItemPlace,
} from '../state/checklists';
import { numberFormat } from '../state/derived';
import { entryOfOwn, ownEntryById, useOwnLists } from '../state/ownLists';
import { useAtlas, type ChecklistPage, type LoadedGame } from '../state/store';
import { UiIcon } from './icons';
import { useFacetNames } from './facetNames';
import { MarkdownBody } from './MarkdownBody';
import { VirtualList } from './VirtualList';

/** Height of an item row before it is measured. */
const ROW_ESTIMATE = 64;
/** From this many items a checklist gets a search box. */
const SEARCH_FROM = 15;
/** Notes longer than this are shown a few lines at a time. */
const NOTE_CLAMP_CHARS = 220;
/** Places of a guide listed before "Show all". */
const PLACES_SHOWN = 30;

const INDEX: ChecklistPage = { kind: 'index' };

/**
 * The checklists and guides screen, in the left pane: the list of
 * checklists and guides, one checklist with its items, or one guide.
 */
export function ChecklistsPane({ visible }: { visible: boolean }) {
  const game = useAtlas((s) => s.game)!;
  const page = useAtlas((s) => s.checklistPages.at(-1) ?? INDEX);
  const key = page.kind === 'index' ? 'index' : `${page.kind}|${page.id}`;
  return (
    // A new page starts at the top.
    <div className="pane-body checklists" data-testid="checklists" key={key}>
      {page.kind === 'index' ? (
        <IndexPage game={game} />
      ) : page.kind === 'checklist' ? (
        <ChecklistView game={game} id={page.id} visible={visible} />
      ) : (
        <GuideView game={game} id={page.id} />
      )}
    </div>
  );
}

const isDoneIn = (found: ReadonlyMap<string, unknown>) => (id: string) => found.has(id);

/** Moves focus to a page's heading when the page replaced what had focus. */
function useFocusOnOpen(ref: React.RefObject<HTMLElement | null>, skip = false) {
  useEffect(() => {
    if (skip) return;
    const active = document.activeElement;
    const pane = ref.current?.closest('.side-pane');
    if (active === document.body || pane?.contains(active)) {
      ref.current?.focus({ preventScroll: true });
    }
    // Only when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function BackButton({ game }: { game: LoadedGame }) {
  const previous = useAtlas((s) => s.checklistPages.at(-2) ?? INDEX);
  const name =
    previous.kind === 'index'
      ? checklistScreenTitle(game).toLowerCase()
      : previous.kind === 'checklist'
        ? (game.checklists.checklist(previous.id)?.checklist.name ?? 'the checklist')
        : (game.checklists.guide(previous.id)?.title ?? 'the guide');
  return (
    <button type="button" className="back-button" onClick={checklistBack}>
      <span className="back-arrow" aria-hidden="true">
        <UiIcon name="chevron" size={14} />
      </span>
      Back to {previous.kind === 'index' ? `all ${name}` : name}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The list of checklists and guides

function IndexPage({ game }: { game: LoadedGame }) {
  const found = useAtlas((s) => s.found);
  const { checklists, guides } = game.checklists;
  const tallies = useMemo(() => {
    const isDone = isDoneIn(found);
    return new Map(checklists.map((entry) => [entry, checklistTally(entry, isDone)]));
  }, [checklists, found]);
  let done = 0;
  let total = 0;
  for (const t of tallies.values()) {
    done += t.done;
    total += t.total;
  }
  const lists = checklists.filter((c) => c.checklist.kind !== 'guide');
  // The person's own lists, to use here; they are made and changed in the standard layout.
  const ownLists = useOwnLists((s) => s.lists);
  const own = useMemo(() => ownLists.map((list) => entryOfOwn(game, list)), [ownLists, game]);
  const ownTallies = useMemo(() => {
    const isDone = isDoneIn(found);
    return new Map(own.map((entry) => [entry, checklistTally(entry, isDone)]));
  }, [own, found]);
  const guideLists = checklists.filter((c) => c.checklist.kind === 'guide');
  const link = (entry: ChecklistEntry) => (
    <li key={entry.checklist.id}>
      <ChecklistLink entry={entry} tally={tallies.get(entry)!} />
    </li>
  );

  return (
    <>
      {checklists.length > 1 ? (
        <p className="checklists-total" data-testid="checklists-total">
          {numberFormat.format(done)} of {numberFormat.format(total)} items found or done in{' '}
          {checklists.length} lists.
        </p>
      ) : null}
      {lists.length > 0 ? (
        <section className="section" aria-labelledby="checklists-heading">
          <h2 className="section-title" id="checklists-heading">
            Checklists
          </h2>
          <ul className="plain-list">{lists.map(link)}</ul>
        </section>
      ) : null}
      {own.length > 0 ? (
        <section className="section" aria-labelledby="own-lists-heading" data-testid="own-lists">
          <h2 className="section-title" id="own-lists-heading">
            Your own
          </h2>
          <ul className="plain-list">
            {own.map((entry) => (
              <li key={entry.checklist.id}>
                <ChecklistLink entry={entry} tally={ownTallies.get(entry)!} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {guideLists.length > 0 || guides.length > 0 ? (
        <section className="section" aria-labelledby="guides-heading">
          <h2 className="section-title" id="guides-heading">
            Guides
          </h2>
          <ul className="plain-list">
            {guideLists.map(link)}
            {guides.map((guide) => (
              <li key={guide.id}>
                <button
                  type="button"
                  className="list-link"
                  data-testid="guide-link"
                  onClick={() => {
                    openGuide(guide.id);
                  }}
                >
                  <span className="list-link-name">{guide.title}</span>
                  <span className="list-link-detail">{guideDetail(game, guide)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function guideDetail(game: LoadedGame, guide: GuideEntry): string {
  const places = new Set(guide.locationIds.filter((id) => game.pack.locations.has(id))).size;
  return places === 0
    ? 'Guide'
    : `Guide · ${places === 1 ? 'one location' : `${places} locations`}`;
}

function ChecklistLink({ entry, tally }: { entry: ChecklistEntry; tally: ChecklistTally }) {
  const figureId = useId();
  const { done, total } = tally;
  const complete = total > 0 && done === total;
  return (
    <button
      type="button"
      className="list-link"
      data-testid="checklist-link"
      data-checklist-id={entry.checklist.id}
      aria-describedby={figureId}
      onClick={() => {
        openChecklist(entry.checklist.id);
      }}
    >
      <span className="list-link-name">{entry.checklist.name}</span>
      <span
        className={complete ? 'count count-complete' : 'count'}
        id={figureId}
        data-testid="checklist-figure"
      >
        {numberFormat.format(done)}/{numberFormat.format(total)}
        <span className="visually-hidden"> found or done</span>
      </span>
      {entry.checklist.description ? (
        <span className="list-link-detail">{entry.checklist.description}</span>
      ) : null}
      <span className="meter meter-small" aria-hidden="true">
        <span className="meter-fill" style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// One checklist

function ChecklistView({ game, id, visible }: { game: LoadedGame; id: string; visible: boolean }) {
  // A pack's list, or one of the person's own (shown here as it is, to tick).
  useOwnLists((s) => s.lists);
  const entry = game.checklists.checklist(id) ?? ownEntryById(game, id);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focus = useAtlas((s) => s.itemFocus);
  useFocusOnOpen(
    headingRef,
    focus !== null && entry?.items.some((i) => i.item.id === focus.itemId),
  );
  if (!entry) {
    return (
      <>
        <BackButton game={game} />
        <p className="muted">This list is not in the pack.</p>
      </>
    );
  }
  return (
    <>
      <BackButton game={game} />
      {isOwnId(id) ? (
        <p className="muted small" data-testid="own-list-classic-note">
          Your own list. It can be changed in the standard layout.
        </p>
      ) : null}
      <ChecklistItems game={game} entry={entry} headingRef={headingRef} visible={visible} />
    </>
  );
}

type Row =
  | { kind: 'section'; key: string; title: string }
  | { kind: 'item'; key: string; entry: ChecklistItemEntry; state: ItemState };

const rowKey = (row: Row) => row.key;
const noneSet: ReadonlySet<string> = new Set();

function ChecklistItems({
  game,
  entry,
  headingRef,
  visible,
}: {
  game: LoadedGame;
  entry: ChecklistEntry;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  visible: boolean;
}) {
  const found = useAtlas((s) => s.found);
  const hideFound = useAtlas((s) => s.hideDone);
  const focus = useAtlas((s) => s.itemFocus);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [hiddenRegions, setHiddenRegions] = useState(noneSet);
  const [hiddenCategories, setHiddenCategories] = useState(noneSet);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Items ticked while "Hide found" is on stay until a filter changes, so
  // the checkbox just used does not vanish under the pointer.
  const [kept, setKept] = useState(noneSet);
  const searchId = useId();
  const filtersId = useId();
  const names = useFacetNames(game, entry);

  const facets = useMemo(
    () => entry.items.map((item) => itemFacets(item, game.pack)),
    [entry, game],
  );
  const states = useMemo(() => {
    const isDone = isDoneIn(found);
    return entry.items.map((item) => itemState(item, isDone));
  }, [entry, found]);
  // Optional steps do not count against the list.
  const { done, total } = useMemo(() => tallyStates(states), [states]);
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

  // An item asked for (from search, a link, or "show on map") is shown even
  // when a filter would leave it out. This adjusts state while rendering,
  // once per request.
  const [handledFocus, setHandledFocus] = useState(0);
  if (focus && focus.seq !== handledFocus) {
    setHandledFocus(focus.seq);
    if (entry.items.some((i) => i.item.id === focus.itemId) && !kept.has(focus.itemId)) {
      setKept(new Set([...kept, focus.itemId]));
    }
  }

  const rows = useMemo(() => {
    const indices = filterChecklist(
      facets,
      states,
      { query: deferredQuery, hideFound, hiddenRegions, hiddenCategories },
      (i) => kept.has(entry.items[i]!.item.id),
    );
    const list: Row[] = [];
    let section: string | undefined;
    for (const i of indices) {
      const item = entry.items[i]!;
      if (item.item.section !== section) {
        section = item.item.section;
        list.push({ kind: 'section', key: `section|${i}`, title: section ?? 'Other items' });
      }
      list.push({ kind: 'item', key: item.item.id, entry: item, state: states[i]! });
    }
    return list;
  }, [entry, facets, states, deferredQuery, hideFound, hiddenRegions, hiddenCategories, kept]);

  const reveal = useMemo(() => {
    if (!focus) return null;
    const index = rows.findIndex((r) => r.key === focus.itemId);
    return index < 0 ? null : { index, seq: focus.seq };
  }, [focus, rows]);
  // Focus moves to the item's checkbox once per request; showing the screen
  // again only scrolls back to it.
  const focusedSeq = useRef(0);
  const onRevealed = (row: HTMLElement, seq: number) => {
    if (focusedSeq.current === seq) return;
    focusedSeq.current = seq;
    row.querySelector('input')?.focus({ preventScroll: true });
  };

  const restart = () => {
    if (kept.size > 0) setKept(noneSet);
  };
  const hiddenCount = hiddenRegions.size + hiddenCategories.size;
  const searchable = entry.items.length >= SEARCH_FROM;
  const showRegions = regionCounts.length > 1;
  const showCategories = categoryCounts.length > 1;

  const renderRow = (row: Row) =>
    row.kind === 'section' ? (
      <h3 className="check-section">{row.title}</h3>
    ) : (
      <ItemRow entry={row.entry} state={row.state} names={names} />
    );

  return (
    <section aria-labelledby="checklist-title" className="checklist">
      <h2 className="checklist-title" id="checklist-title" tabIndex={-1} ref={headingRef}>
        {entry.checklist.name}
      </h2>
      {entry.checklist.description ? (
        <p className="checklist-description">{entry.checklist.description}</p>
      ) : null}
      <p className="checklist-progress" data-testid="checklist-progress">
        <span data-testid="checklist-done" data-done={done} data-total={total}>
          {numberFormat.format(done)} of {numberFormat.format(total)} found or done
        </span>
        <span className="meter meter-small" aria-hidden="true">
          <span className="meter-fill" style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
        </span>
      </p>

      <div className="checklist-controls">
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            checked={hideFound}
            onChange={(event) => {
              restart();
              setHideDone(event.target.checked);
            }}
          />
          <span className="switch-track" aria-hidden="true" />
          Hide found
        </label>
        {showRegions || showCategories ? (
          <button
            type="button"
            className="link-button"
            aria-expanded={filtersOpen}
            aria-controls={filtersId}
            onClick={() => {
              setFiltersOpen(!filtersOpen);
            }}
          >
            {filtersOpen ? 'Hide filters' : 'Filter by region and type'}
            {hiddenCount > 0 ? ` (${hiddenCount} off)` : ''}
          </button>
        ) : null}
        {searchable ? (
          <div className="checklist-filter">
            <label htmlFor={searchId} className="visually-hidden">
              Search this list
            </label>
            <input
              id={searchId}
              className="text-input"
              type="search"
              placeholder="Search this list"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                restart();
                setQuery(event.target.value);
              }}
            />
          </div>
        ) : null}
      </div>

      {filtersOpen ? (
        <div className="checklist-facets" id={filtersId} data-testid="checklist-facets">
          {showRegions ? (
            <FacetGroup
              legend="Regions"
              counts={regionCounts}
              hidden={hiddenRegions}
              name={names.region}
              group={names.severalMaps ? (key) => names.mapName(names.mapOf(key)) : undefined}
              onChange={(next) => {
                restart();
                setHiddenRegions(next);
              }}
            />
          ) : null}
          {showCategories ? (
            <FacetGroup
              legend="Types"
              counts={categoryCounts}
              hidden={hiddenCategories}
              name={names.category}
              onChange={(next) => {
                restart();
                setHiddenCategories(next);
              }}
            />
          ) : null}
        </div>
      ) : null}

      <p className="visually-hidden" role="status">
        {rows.length === 0
          ? ''
          : `${numberFormat.format(rows.filter((r) => r.kind === 'item').length)} items shown`}
      </p>
      {rows.length === 0 ? (
        <p className="muted">
          {entry.items.length === 0
            ? 'This list has no items.'
            : hideFound && !deferredQuery && hiddenCount === 0
              ? 'Every item is found or done.'
              : 'No items match the filters.'}
        </p>
      ) : (
        <VirtualList
          items={rows}
          getKey={rowKey}
          estimate={ROW_ESTIMATE}
          renderItem={renderRow}
          className="check-items"
          testId="check-items"
          visible={visible}
          reveal={reveal}
          onRevealed={onRevealed}
        />
      )}
    </section>
  );
}

/** Regions or categories of a checklist, each a checkbox with its found/total count. */
export function FacetGroup({
  legend,
  counts,
  hidden,
  name,
  group,
  onChange,
}: {
  legend: string;
  counts: readonly FacetCount[];
  hidden: ReadonlySet<string>;
  name: (key: string) => string;
  /** A heading the entry is listed under, such as its map. */
  group?: (key: string) => string;
  onChange: (hidden: ReadonlySet<string>) => void;
}) {
  return (
    <fieldset className="facet-group">
      <legend className="section-title">{legend}</legend>
      <div className="row-actions">
        <button
          type="button"
          className="link-button"
          onClick={() => {
            onChange(noneSet);
          }}
          aria-label={`Select all ${legend.toLowerCase()}`}
        >
          Select all
        </button>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            onChange(new Set(counts.map((c) => c.key)));
          }}
          aria-label={`Deselect all ${legend.toLowerCase()}`}
        >
          Deselect all
        </button>
      </div>
      <ul className="plain-list">
        {counts.map((count, index) => {
          const complete = count.found === count.total;
          const heading = group?.(count.key) ?? null;
          const previous = index > 0 ? (group?.(counts[index - 1]!.key) ?? null) : null;
          const newGroup = heading !== null && heading !== previous;
          return (
            <li key={count.key}>
              {newGroup ? <p className="facet-heading">{heading}</p> : null}
              <label className="tree-row tree-label" data-testid="facet">
                <input
                  type="checkbox"
                  checked={!hidden.has(count.key)}
                  onChange={(event) => {
                    const next = new Set(hidden);
                    if (event.target.checked) next.delete(count.key);
                    else next.add(count.key);
                    onChange(next);
                  }}
                />
                <span className="tree-name">{name(count.key)}</span>
                <span
                  className={complete ? 'count count-complete' : 'count'}
                  title={`${count.found} of ${count.total} found or done`}
                >
                  {numberFormat.format(count.found)}/{numberFormat.format(count.total)}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

const rowId = (itemId: string) => `check-${itemId}`;
type FacetNames = ReturnType<typeof useFacetNames>;

/**
 * One item: its tick, name, where it is (category, region, and map when the
 * list spans several), the place's own note, the item's note, and a way to
 * show it on the map. Re-renders only when its own state changes.
 */
const ItemRow = memo(
  function ItemRow({
    entry,
    state,
    names,
  }: {
    entry: ChecklistItemEntry;
    state: ItemState;
    names: FacetNames;
  }) {
    const game = useAtlas((s) => s.game)!;
    const { pack } = game;
    const { item } = entry;
    const inputId = useId();
    const metaId = useId();
    const placesId = useId();
    const checkboxRef = useRef<HTMLInputElement>(null);
    const [placesOpen, setPlacesOpen] = useState(false);
    const partial = !state.done && state.found > 0;
    useEffect(() => {
      if (checkboxRef.current) checkboxRef.current.indeterminate = partial;
    }, [partial]);

    const place = entry.places.length > 0 ? pack.locations.get(entry.places[0]!) : undefined;
    const meta: string[] = [];
    if (place) {
      meta.push(names.category(place.categoryId));
      if (place.regionId) meta.push(names.region(place.regionId));
      if (names.severalMaps || !place.regionId) meta.push(names.mapName(place.mapId));
    }
    if (entry.places.length > 1) meta.push(`${entry.places.length} locations`);
    if (!entry.ownMark && state.total > 1) meta.push(`${state.found} of ${state.total} found`);
    const entities = item.entityIds.flatMap(
      (id) => pack.data.entities.find((e) => e.id === id)?.name ?? [],
    );
    if (entities.length > 0) meta.push(`With ${entities.join(', ')}`);
    // The place's own note, as the details pane shows it. A guide shared by
    // many places is linked instead of repeated on every row.
    const guide = place?.guideId ? game.checklists.guide(place.guideId) : undefined;
    const ownNote = guide && !game.checklists.isListed(guide.id) ? guide : undefined;
    const sharedGuide = guide && game.checklists.isListed(guide.id) ? guide : undefined;

    return (
      <div
        className={state.done ? 'check-item check-item-done' : 'check-item'}
        id={rowId(item.id)}
        data-testid="check-item"
        data-item-id={item.id}
        data-done={state.done}
      >
        <input
          ref={checkboxRef}
          id={inputId}
          type="checkbox"
          className="check-box"
          checked={state.done}
          aria-describedby={meta.length > 0 ? metaId : undefined}
          onChange={(event) => {
            setItemDone(item.id, event.target.checked);
          }}
        />
        <div className="check-item-body">
          <div className="check-item-head">
            <label htmlFor={inputId} className="check-item-name">
              {item.name}
            </label>
            {entry.places.length === 1 ? (
              <button
                type="button"
                className="link-button check-item-go"
                aria-label={`Show ${item.name} on the map`}
                onClick={() => {
                  showItemPlace(item.id, entry.places[0]!);
                }}
              >
                Show on map
              </button>
            ) : null}
          </div>
          {meta.length > 0 ? (
            <p className="check-item-meta" id={metaId}>
              {meta.join(' · ')}
            </p>
          ) : null}
          {ownNote ? <NoteText source={ownNote.body} /> : null}
          {item.note ? <NoteText source={item.note} /> : null}
          {sharedGuide ? (
            <button
              type="button"
              className="link-button"
              onClick={() => {
                openGuide(sharedGuide.id);
              }}
            >
              Guide: {sharedGuide.title}
            </button>
          ) : null}
          {entry.places.length > 1 ? (
            <>
              <button
                type="button"
                className="link-button"
                aria-expanded={placesOpen}
                aria-controls={placesId}
                onClick={() => {
                  setPlacesOpen(!placesOpen);
                }}
              >
                {placesOpen ? 'Hide the locations' : `Show the ${entry.places.length} locations`}
              </button>
              {placesOpen ? (
                <ul className="place-list" id={placesId}>
                  {entry.places.map((locationId) => (
                    <li key={locationId}>
                      <PlaceButton
                        game={game}
                        locationId={locationId}
                        onGo={() => {
                          showItemPlace(item.id, locationId);
                        }}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    );
  },
  (a, b) =>
    a.entry === b.entry &&
    a.names === b.names &&
    a.state.done === b.state.done &&
    a.state.found === b.state.found &&
    a.state.total === b.state.total,
);

/** A note under an item: a few lines, with the rest a click away. */
export function NoteText({ source }: { source: string }) {
  const [open, setOpen] = useState(false);
  const long = source.length > NOTE_CLAMP_CHARS;
  return (
    <div className="check-item-note">
      <MarkdownBody
        source={source}
        className={long && !open ? 'guide-body note-clamped' : 'guide-body'}
      />
      {long ? (
        <button
          type="button"
          className="link-button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? 'Show less' : 'Show the whole note'}
        </button>
      ) : null}
    </div>
  );
}

/** A button that shows one location on the map, naming its map when that is not the one shown. */
function PlaceButton({
  game,
  locationId,
  onGo,
}: {
  game: LoadedGame;
  locationId: string;
  onGo: () => void;
}) {
  const found = useAtlas((s) => s.found.has(locationId));
  const mapId = useAtlas((s) => s.mapId);
  const location = game.pack.locations.get(locationId);
  if (!location) return null;
  const map = location.mapId !== mapId ? game.pack.maps.get(location.mapId) : undefined;
  return (
    <button
      type="button"
      className="place-button"
      aria-label={`Show ${location.name} on the map${map ? `, on ${map.name}` : ''}${found ? ', found' : ''}`}
      onClick={onGo}
    >
      <span className="place-name">{location.name}</span>
      {map ? <span className="muted"> · {map.name}</span> : null}
      {found ? <span className="found-tag">found</span> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// One guide

/** One guide page. The touch layout shows it with a header of its own, so without the back button. */
export function GuideView({
  game,
  id,
  back = true,
}: {
  game: LoadedGame;
  id: string;
  back?: boolean;
}) {
  const guide = game.checklists.guide(id);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [allPlaces, setAllPlaces] = useState(false);
  useFocusOnOpen(headingRef);
  const places = useMemo(
    () => [...new Set(guide?.locationIds ?? [])].filter((l) => game.pack.locations.has(l)),
    [game, guide],
  );
  if (!guide) {
    return (
      <>
        {back ? <BackButton game={game} /> : null}
        <p className="muted">This guide is not in the pack.</p>
      </>
    );
  }
  const shown = allPlaces ? places : places.slice(0, PLACES_SHOWN);
  return (
    <>
      {back ? <BackButton game={game} /> : null}
      <article className="guide-page" aria-labelledby="guide-page-title" data-testid="guide-page">
        <h2 className="checklist-title" id="guide-page-title" tabIndex={-1} ref={headingRef}>
          {guide.title}
        </h2>
        <MarkdownBody source={guide.body} className="guide-body" />
        {places.length > 0 ? (
          <section className="section guide-places" aria-labelledby="guide-places-heading">
            <h3 className="section-title" id="guide-places-heading">
              Locations in this guide
            </h3>
            <ul className="place-list">
              {shown.map((locationId) => (
                <li key={locationId}>
                  <PlaceButton
                    game={game}
                    locationId={locationId}
                    onGo={() => {
                      goToLocation(locationId);
                    }}
                  />
                </li>
              ))}
            </ul>
            {shown.length < places.length ? (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setAllPlaces(true);
                }}
              >
                Show all {numberFormat.format(places.length)} locations
              </button>
            ) : null}
          </section>
        ) : null}
      </article>
    </>
  );
}
