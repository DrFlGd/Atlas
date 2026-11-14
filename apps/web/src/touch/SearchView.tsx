import {
  checklistTally,
  GuideSearch,
  type NoteText,
  type SearchEntry,
  type SearchHit,
  type SearchKind,
} from '@atlas/core';
import { useDeferredValue, useEffect, useId, useMemo, useRef } from 'react';
import { GlyphBadge, UiIcon, type UiIconName } from '../components/icons';
import { VirtualList } from '../components/VirtualList';
import { goToLocation } from '../state/actions';
import { openChecklist, openChecklistItem, openGuide } from '../state/checklists';
import { numberFormat, useSummary } from '../state/derived';
import { guideSearchText } from '../markdown';
import { noteTextsOf, useNotesShown } from '../state/ownNotes';
import { useAtlas, type LoadedGame } from '../state/store';
import { orderHits } from './ordering';
import type { RecentRef } from './recent';
import {
  closeSearch,
  markFound,
  openSearch,
  rememberResult,
  setQuery,
  setScope,
  showOnlyKind,
  showSection,
  type SearchScope,
  useKeyHints,
  useTouch,
} from './state';
import { TickMark } from './widgets';

/** Results looked at for one query; more than any list needs. */
const LIMIT = 1000;
const ROW_HEIGHT = 64;

const SCOPES: { id: SearchScope; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'places', label: 'Locations' },
  { id: 'unfound', label: 'Not found yet' },
  { id: 'lists', label: 'Lists' },
];

const PLACE_KINDS: readonly SearchKind[] = ['location', 'entity'];

/** Where a match in a note of the person's own comes: after every match by name. */
const NOTE_SCORE = 10;

const noteSearches = new WeakMap<readonly NoteText[], GuideSearch>();

/** A search over the person's notes, each as a page of its location. */
function noteSearchOf(texts: readonly NoteText[]): GuideSearch {
  let search = noteSearches.get(texts);
  if (!search) {
    search = new GuideSearch(
      texts.map(({ locationId, text }) => ({
        id: locationId,
        title: '',
        body: text,
        locationIds: [locationId],
      })),
      guideSearchText,
    );
    noteSearches.set(texts, search);
  }
  return search;
}

/**
 * The locations whose note (of the person's own) has the words, and not
 * their name: each with the line of the note around them, by location.
 */
function noteHits(
  game: LoadedGame,
  texts: readonly NoteText[],
  query: string,
  named: readonly SearchHit[],
): { hits: SearchHit[]; lines: Map<string, string> } {
  const lines = new Map<string, string>();
  const hits: SearchHit[] = [];
  if (texts.length === 0) return { hits, lines };
  const byName = new Set(
    named.flatMap((hit) => (hit.entry.kind === 'location' ? [hit.entry.id] : [])),
  );
  for (const hit of noteSearchOf(texts).search(query, LIMIT)) {
    const id = hit.guide.id;
    const location = game.pack.locations.get(id);
    if (!location || byName.has(id) || lines.has(id)) continue;
    lines.set(id, hit.snippet);
    hits.push({
      entry: {
        kind: 'location',
        id,
        title: location.name,
        detail: '',
        mapId: location.mapId,
        locationIds: [id],
      },
      score: NOTE_SCORE,
    });
  }
  return { hits, lines };
}
const LIST_KINDS: readonly SearchKind[] = ['checklist', 'checkitem', 'guide'];

/** The last `/` key press that moved focus to a search field. */
let focusedRequest = 0;

/** Search on a phone: the whole screen, over the map. */
export function SearchScreen() {
  return (
    <div className="touch-search-screen" role="dialog" aria-label="Search">
      <SearchField />
      <SearchResults />
    </div>
  );
}

/**
 * The search field. On a phone it heads the search screen, with a way back
 * to the map; in the wide panel it sits at the top and opens search when
 * it takes focus.
 */
export function SearchField({ inPanel = false }: { inPanel?: boolean }) {
  const query = useTouch((s) => s.query);
  const open = useTouch((s) => s.search);
  const hasLists = useAtlas((s) => !(s.game?.checklists.isEmpty ?? true));
  const focusRequest = useTouch((s) => s.searchFocus);
  const hints = useKeyHints();
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const label = hasLists ? 'Search locations, lists and guides' : 'Search locations';

  // On a phone the field takes focus as the screen opens.
  useEffect(() => {
    if (!inPanel) inputRef.current?.focus();
  }, [inPanel]);

  // The `/` key, once per press, also when it brought the field.
  useEffect(() => {
    if (focusRequest === focusedRequest) return;
    focusedRequest = focusRequest;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  const close = () => {
    closeSearch();
    inputRef.current?.blur();
  };

  return (
    <div className={inPanel ? 'touch-search-head touch-search-head-panel' : 'touch-search-head'}>
      {inPanel ? null : (
        <button
          type="button"
          className="touch-icon-button"
          aria-label="Back to the map"
          data-testid="close-search"
          onClick={close}
        >
          <UiIcon name="back" size={22} strokeWidth={1.8} />
        </button>
      )}
      <div className={open ? 'touch-search-box touch-search-box-active' : 'touch-search-box'}>
        {inPanel ? <UiIcon name="search" size={20} /> : null}
        <label htmlFor={id} className="visually-hidden">
          {label}
        </label>
        <input
          ref={inputRef}
          id={id}
          className="touch-search-input"
          type="search"
          placeholder={hints ? `${label}  ( / )` : label}
          aria-keyshortcuts={hints ? '/' : undefined}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          data-testid="search-input"
          value={query}
          onFocus={() => {
            if (!open) openSearch();
          }}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              if (query) setQuery('');
              else close();
            } else if (event.key === 'Enter') {
              inputRef.current?.blur();
            }
          }}
        />
        {query || (inPanel && open) ? (
          <button
            type="button"
            className="touch-icon-button touch-icon-button-small"
            aria-label={query ? 'Clear the search' : 'Close search'}
            onClick={() => {
              if (query) {
                setQuery('');
                inputRef.current?.focus();
              } else close();
            }}
          >
            <UiIcon name="close" size={18} strokeWidth={1.8} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** What search shows under the field: chips and results, or, with nothing typed, recent results and the kinds. */
export function SearchResults() {
  const game = useAtlas((s) => s.game);
  const query = useTouch((s) => s.query);
  const deferred = useDeferredValue(query);
  if (!game) return null;
  return deferred.trim() ? <Results game={game} query={deferred} /> : <Browse game={game} />;
}

function Results({ game, query }: { game: LoadedGame; query: string }) {
  const scope = useTouch((s) => s.scope);
  const mapId = useAtlas((s) => s.mapId);
  const hasLists = !game.checklists.isEmpty;
  const shownNotes = useNotesShown(game);

  // Ordered once per query: the list does not move while the map does. The
  // locations found by a word of a note of the person's own come after those
  // found by name.
  const { hits, noteLines } = useMemo(() => {
    const center = useAtlas.getState().view?.center ?? null;
    const named = game.search.search(query, LIMIT);
    const notes = noteHits(game, noteTextsOf(game, shownNotes), query, named);
    return {
      hits: orderHits([...named, ...notes.hits], mapId, center, (id) =>
        game.pack.locations.get(id),
      ),
      noteLines: notes.lines,
    };
  }, [game, query, mapId, shownNotes]);

  // "Not found yet" is read when the scope or query changes, so a place
  // marked from its row stays in the list under the finger.
  const rows = useMemo(() => {
    const found = useAtlas.getState().found;
    return hits.filter(({ entry }) => {
      switch (scope) {
        case 'all':
          return true;
        case 'places':
          return PLACE_KINDS.includes(entry.kind);
        case 'unfound':
          return (
            entry.kind === 'location' && game.counter.isTrackable(entry.id) && !found.has(entry.id)
          );
        case 'lists':
          return LIST_KINDS.includes(entry.kind);
      }
    });
  }, [hits, scope, game]);

  const places = rows.some((r) => r.entry.kind === 'location');
  const count = rows.length >= LIMIT ? `More than ${numberFormat.format(LIMIT)}` : `${rows.length}`;
  return (
    <>
      <div className="touch-chips" role="group" aria-label="Show">
        {SCOPES.filter((s) => s.id !== 'lists' || hasLists).map((s) => (
          <button
            key={s.id}
            type="button"
            className="touch-chip"
            aria-pressed={s.id === scope}
            onClick={() => {
              setScope(s.id);
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="touch-search-summary" role="status" data-testid="search-summary">
        {rows.length === 0
          ? 'Nothing matches.'
          : `${count} result${rows.length === 1 ? '' : 's'}${places ? ', nearest to the middle of the map first' : ''}`}
      </p>
      <div className="touch-scroll touch-search-list" data-scroll-root>
        {rows.length > 0 ? (
          <VirtualList
            items={rows}
            getKey={hitKey}
            estimate={ROW_HEIGHT}
            renderItem={(hit) => (
              <ResultRow
                game={game}
                entry={hit.entry}
                note={hit.score === NOTE_SCORE ? noteLines.get(hit.entry.id) : undefined}
              />
            )}
            className="touch-result-list"
            testId="search-results"
            visible
          />
        ) : null}
      </div>
    </>
  );
}

const hitKey = (hit: SearchHit) => `${hit.entry.kind}|${hit.entry.id}`;

/** With nothing typed: what was chosen lately, and every kind on this map. */
function Browse({ game }: { game: LoadedGame }) {
  const recent = useTouch((s) => s.recent);
  const mapId = useAtlas((s) => s.mapId);
  const summary = useSummary();
  const entries = recent.flatMap((ref) => entryOf(game, ref) ?? []);
  const kinds = useMemo(() => {
    const present = new Set<string>();
    for (const location of game.pack.data.locations) {
      if (location.mapId === mapId) present.add(location.categoryId);
    }
    const groupOrder = new Map(game.pack.data.categoryGroups.map((g) => [g.id, g.order]));
    return game.pack.data.categories
      .filter((c) => present.has(c.id))
      .sort((a, b) => (groupOrder.get(a.groupId) ?? 0) - (groupOrder.get(b.groupId) ?? 0));
  }, [game, mapId]);
  return (
    <div className="touch-scroll touch-search-list" data-scroll-root>
      {entries.length > 0 ? (
        <section aria-labelledby="recent-heading">
          <h2 className="touch-group-title touch-group-title-row" id="recent-heading">
            Recent
          </h2>
          <ul className="touch-plain-list" data-testid="recent-results">
            {entries.map((entry) => (
              <li key={`${entry.kind}|${entry.id}`}>
                <ResultRow game={game} entry={entry} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="kinds-heading">
        <h2 className="touch-group-title touch-group-title-row" id="kinds-heading">
          Browse by type
        </h2>
        <ul className="touch-plain-list" data-testid="browse-kinds">
          {kinds.map((category) => {
            const tally = summary?.category(category.id, mapId);
            return (
              <li key={category.id}>
                <button
                  type="button"
                  className="touch-row touch-row-button"
                  onClick={() => {
                    closeSearch();
                    showOnlyKind(category.id);
                    showSection('map');
                  }}
                >
                  <GlyphBadge icon={category.icon} color={category.color} size={36} />
                  <span className="touch-row-text">
                    <span className="touch-row-title">{category.name}</span>
                  </span>
                  <span className="touch-figure">
                    {tally
                      ? tally.total > 0
                        ? `${numberFormat.format(tally.found)} / ${numberFormat.format(tally.total)}`
                        : numberFormat.format(tally.count)
                      : ''}
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
    </div>
  );
}

/** A result chosen earlier, as search would list it; null when the pack no longer has it. */
function entryOf(game: LoadedGame, ref: RecentRef): SearchEntry | null {
  const { pack, checklists } = game;
  const base = { kind: ref.kind, id: ref.id, detail: '', mapId: null };
  switch (ref.kind) {
    case 'location': {
      const location = pack.locations.get(ref.id);
      return location
        ? { ...base, title: location.name, mapId: location.mapId, locationIds: [location.id] }
        : null;
    }
    case 'entity': {
      const entity = pack.data.entities.find((e) => e.id === ref.id);
      if (!entity) return null;
      const locationIds = pack.data.locations
        .filter((l) => l.entityIds.includes(entity.id))
        .map((l) => l.id);
      return { ...base, title: entity.name, locationIds };
    }
    case 'guide': {
      const guide = checklists.guide(ref.id);
      return guide ? { ...base, title: guide.title, locationIds: [...guide.locationIds] } : null;
    }
    case 'checklist': {
      const list = checklists.checklist(ref.id);
      return list ? { ...base, title: list.checklist.name, locationIds: [] } : null;
    }
    case 'checkitem': {
      const item = checklists.item(ref.id);
      return item ? { ...base, title: item.item.name, locationIds: [...item.places] } : null;
    }
  }
}

/** Shows a result: a place on the map, a list or guide in Lists. */
function choose(game: LoadedGame, entry: SearchEntry): void {
  rememberResult(entry);
  closeSearch();
  if (entry.kind === 'checklist') openChecklist(entry.id);
  else if (entry.kind === 'checkitem') openChecklistItem(entry.id);
  else if (entry.kind === 'guide' && game.checklists.isListed(entry.id)) openGuide(entry.id);
  else if (entry.locationIds[0]) goToLocation(entry.locationIds[0]);
}

const KIND_ICON: Record<Exclude<SearchKind, 'location'>, UiIconName> = {
  entity: 'target',
  guide: 'details',
  checklist: 'checklist',
  checkitem: 'check',
};

/** One result: a place with its tick, or a list, an entry or a guide that opens in Lists. */
function ResultRow({
  game,
  entry,
  note,
}: {
  game: LoadedGame;
  entry: SearchEntry;
  /** The line of the person's note that has the words, for a location found by its note. */
  note?: string | undefined;
}) {
  if (entry.kind === 'location') return <PlaceRow game={game} entry={entry} note={note} />;
  const opens =
    entry.kind === 'checklist' ||
    entry.kind === 'checkitem' ||
    (entry.kind === 'guide' && game.checklists.isListed(entry.id));
  const reachable = opens || entry.locationIds.length > 0;
  return (
    <div className="touch-row" data-testid="search-result" data-kind={entry.kind}>
      <button
        type="button"
        className="touch-row-main"
        disabled={!reachable}
        onClick={() => {
          choose(game, entry);
        }}
      >
        <span className="touch-row-icon">
          <UiIcon name={KIND_ICON[entry.kind]} size={20} />
        </span>
        <span className="touch-row-text">
          <span className="touch-row-title">{entry.title}</span>
          <span className="touch-row-detail">
            <ListDetail game={game} entry={entry} />
            {reachable ? '' : ' · not on the map'}
          </span>
        </span>
      </button>
      <span className="touch-row-end" aria-hidden="true">
        {reachable ? <UiIcon name="chevron" size={18} strokeWidth={1.8} /> : null}
      </span>
    </div>
  );
}

function ListDetail({ game, entry }: { game: LoadedGame; entry: SearchEntry }) {
  const found = useAtlas((s) => (entry.kind === 'checklist' ? s.found : null));
  const { checklists } = game;
  switch (entry.kind) {
    case 'checklist': {
      const list = checklists.checklist(entry.id);
      if (!list || !found) return null;
      const tally = checklistTally(list, (id) => found.has(id));
      return (
        <>
          {list.checklist.kind === 'guide' ? 'Guide list' : 'Checklist'} ·{' '}
          {numberFormat.format(tally.done)} of {numberFormat.format(tally.total)} done
        </>
      );
    }
    case 'checkitem': {
      const list = checklists.checklistOf(entry.id);
      return <>Entry on the {list?.checklist.name ?? ''} checklist</>;
    }
    case 'guide': {
      const places = new Set(entry.locationIds).size;
      return (
        <>Guide{places > 0 ? ` · ${places === 1 ? 'one location' : `${places} locations`}` : ''}</>
      );
    }
    default:
      return <>{entry.detail}</>;
  }
}

function PlaceRow({
  game,
  entry,
  note,
}: {
  game: LoadedGame;
  entry: SearchEntry;
  note?: string | undefined;
}) {
  const found = useAtlas((s) => s.found.has(entry.id));
  const mapId = useAtlas((s) => s.mapId);
  const { pack } = game;
  const location = pack.locations.get(entry.id);
  if (!location) return null;
  const category = pack.categories.get(location.categoryId);
  const region = location.regionId ? pack.regions.get(location.regionId) : undefined;
  const otherMap = location.mapId !== mapId ? pack.maps.get(location.mapId)?.name : undefined;
  const trackable = game.counter.isTrackable(location.id);
  const detail =
    note !== undefined
      ? `My note: ${note}`
      : [category?.name, region?.name, otherMap, found ? 'found' : undefined]
          .filter(Boolean)
          .join(' · ');
  return (
    <div
      className={found ? 'touch-row touch-row-found' : 'touch-row'}
      data-testid="search-result"
      data-kind="location"
      data-found={found}
      data-by-note={note !== undefined ? '' : undefined}
    >
      <button
        type="button"
        className="touch-row-main"
        onClick={() => {
          choose(game, entry);
        }}
      >
        {category ? (
          <GlyphBadge icon={category.icon} color={category.color} size={36} muted={found} />
        ) : null}
        <span className="touch-row-text">
          <span className="touch-row-title">{location.name}</span>
          <span className="touch-row-detail">{detail}</span>
        </span>
      </button>
      {trackable ? (
        <button
          type="button"
          className="touch-tick-button"
          aria-pressed={found}
          aria-label={
            found ? `${location.name} is found. Mark not found` : `Mark ${location.name} found`
          }
          data-testid="result-tick"
          onClick={() => {
            markFound(location.id, !found);
          }}
        >
          <TickMark done={found} round />
        </button>
      ) : (
        <span className="touch-row-end" />
      )}
    </div>
  );
}
