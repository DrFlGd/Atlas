import { outlineOf, rowId, templateName, type ChecklistEntry } from '@atlas/core';
import type { Location, OwnList, Region } from '@atlas/schema';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { UiIcon } from '../../components/icons';
import { numberFormat } from '../../state/derived';
import { entryOfOwn, useOwnLists } from '../../state/ownLists';
import { useAtlas, type LoadedGame } from '../../state/store';
import {
  addBlankStep,
  addEntrySteps,
  addHeading,
  addLocationSteps,
  closePanel,
  setAddTab,
  setPicked,
  stepNumber,
  useEditor,
  type AddTab,
} from './editorState';
import { locationDetail, useLocationHits } from './locations';

const TABS: readonly { id: AddTab; name: string }[] = [
  { id: 'map', name: 'Map' },
  { id: 'type', name: 'A type' },
  { id: 'search', name: 'Search' },
  { id: 'list', name: 'A list' },
  { id: 'blank', name: 'Blank' },
];

/** At most this many entries of another list are offered at once (the filter finds the rest). */
const LIST_LIMIT = 200;

/**
 * "Add to <list>": the ways to add steps, after the open step (or at the
 * end). A tap on the map adds a location whatever the tab; "A type" adds
 * every location of some types in an area, nearest first; "Search" finds
 * locations by name; "A list" copies entries of another list; "Blank"
 * adds a step with only a name, or a heading.
 */
export function AddPanel({ game, list }: { game: LoadedGame; list: OwnList }) {
  const tab = useEditor((s) => s.addTab);
  const open = useEditor((s) => s.open);
  const titleId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const number = stepNumber(list, open);
  const where =
    number > 0
      ? `after step ${number}`
      : open && outlineOf(list).some((row) => rowId(row) === open)
        ? 'under the open heading'
        : 'at the end';

  const onTabKey = (event: KeyboardEvent, index: number) => {
    const by = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!by) return;
    event.preventDefault();
    const next = (index + by + TABS.length) % TABS.length;
    setAddTab(TABS[next]!.id);
    tabRefs.current[next]?.focus();
  };

  return (
    <aside className="editor-side" aria-labelledby={titleId} data-testid="add-panel">
      <header className="editor-side-head">
        <h2 id={titleId} className="editor-side-title" tabIndex={-1}>
          Add to {list.checklist.name}
        </h2>
        <button
          type="button"
          className="touch-icon-button editor-side-icon"
          aria-label="Close Add"
          onClick={closePanel}
        >
          <UiIcon name="close" size={22} strokeWidth={1.8} />
        </button>
      </header>
      <div className="editor-tabs" role="tablist" aria-label="Add from">
        {TABS.map((t, index) => (
          <button
            key={t.id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`add-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="add-tab-panel"
            tabIndex={tab === t.id ? 0 : -1}
            className="editor-tab"
            data-testid={`add-tab-${t.id}`}
            onClick={() => {
              setAddTab(t.id);
            }}
            onKeyDown={(event) => {
              onTabKey(event, index);
            }}
          >
            {t.name}
          </button>
        ))}
      </div>
      <div
        className="editor-side-tab"
        role="tabpanel"
        id="add-tab-panel"
        aria-labelledby={`add-tab-${tab}`}
      >
        {tab === 'map' ? (
          <div className="editor-side-body">
            <p className="editor-side-line editor-side-lead">
              Tap a location on the map to add it {where}.
            </p>
            <p className="editor-side-line">
              Each tap adds one step and opens it. A location that is in the list already opens its
              step.
            </p>
          </div>
        ) : tab === 'type' ? (
          <TypeTab game={game} list={list} where={where} />
        ) : tab === 'search' ? (
          <SearchTab game={game} list={list} where={where} />
        ) : tab === 'list' ? (
          <ListTab game={game} list={list} where={where} />
        ) : (
          <BlankTab where={where} />
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// A type

/** Whether a location is in a region, or in one of its sub-regions. */
function inRegion(game: LoadedGame, location: Location, regionId: string): boolean {
  let id: string | null = location.regionId;
  for (let depth = 0; id && depth < 32; depth++) {
    if (id === regionId) return true;
    id = game.pack.regions.get(id)?.parentId ?? null;
  }
  return false;
}

/** The regions of a map as a tree, each with how deep it is. */
function regionsOf(game: LoadedGame, mapId: string): { region: Region; depth: number }[] {
  const regions = [...game.pack.regions.values()].filter((r) => r.mapId === mapId);
  const children = new Map<string | null, Region[]>();
  for (const region of regions) {
    const parent =
      region.parentId && regions.some((r) => r.id === region.parentId) ? region.parentId : null;
    const list = children.get(parent);
    if (list) list.push(region);
    else children.set(parent, [region]);
  }
  const out: { region: Region; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const region of children.get(parent) ?? []) {
      out.push({ region, depth });
      if (depth < 8) walk(region.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

const ALL = '';

function TypeTab({ game, list, where }: { game: LoadedGame; list: OwnList; where: string }) {
  const mapId = useAtlas((s) => s.mapId) ?? game.pack.maps.keys().next().value ?? '';
  const open = useEditor((s) => s.open);
  const areaId = useId();
  const typesId = useId();
  const regions = useMemo(() => regionsOf(game, mapId), [game, mapId]);
  // The area of the open step, when it is on this map.
  const [area, setArea] = useState(() => {
    const item = list.items.find((i) => i.id === open);
    const location = item?.locationIds
      .map((id) => game.pack.locations.get(id))
      .find((l) => l !== undefined);
    if (location?.mapId !== mapId) return ALL;
    return location.regionId && game.pack.regions.has(location.regionId) ? location.regionId : ALL;
  });
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const inList = useMemo(() => new Set(list.items.flatMap((i) => i.locationIds)), [list]);

  const types = useMemo(() => {
    const byType = new Map<string, Location[]>();
    for (const layer of game.pack.layersOf(mapId)) {
      for (const location of game.pack.locationsOn(layer.id)) {
        if (area !== ALL && !inRegion(game, location, area)) continue;
        const ofType = byType.get(location.categoryId);
        if (ofType) ofType.push(location);
        else byType.set(location.categoryId, [location]);
      }
    }
    return [...game.pack.categories.values()]
      .filter((category) => byType.has(category.id))
      .map((category) => {
        const locations = byType.get(category.id)!;
        const already = locations.filter((l) => inList.has(l.id)).length;
        return { category, locations, already };
      });
  }, [game, mapId, area, inList]);

  // The ticked types' new locations, drawn on the map until they are added.
  const picked = useMemo(
    () =>
      types
        .filter((t) => ticked.has(t.category.id))
        .flatMap((t) => t.locations.filter((l) => !inList.has(l.id)).map((l) => l.id)),
    [types, ticked, inList],
  );
  useEffect(() => {
    setPicked(picked);
  }, [picked]);
  useEffect(
    () => () => {
      setPicked([]);
    },
    [],
  );

  const mapName = game.pack.maps.get(mapId)?.name ?? 'this map';
  const areaName = area === ALL ? mapName : (game.pack.regions.get(area)?.name ?? mapName);

  return (
    <>
      <div className="editor-side-body editor-side-scroll">
        <div className="own-field">
          <label htmlFor={areaId} className="own-label">
            Area
          </label>
          <div className="editor-select-wrap">
            <select
              id={areaId}
              className="own-input editor-select"
              value={area}
              data-testid="add-type-area"
              onChange={(event) => {
                setArea(event.target.value);
                setTicked(new Set());
              }}
            >
              <option value={ALL}>All of {mapName}</option>
              {regions.map(({ region, depth }) => (
                <option key={region.id} value={region.id}>
                  {' '.repeat(depth)}
                  {region.name}
                </option>
              ))}
            </select>
            <UiIcon name="chevronDown" size={18} strokeWidth={1.8} />
          </div>
        </div>
        <div id={typesId} className="own-label">
          Types of location
        </div>
        {types.length === 0 ? (
          <p className="editor-side-line">No locations in {areaName}.</p>
        ) : (
          <ul className="touch-plain-list editor-types" aria-labelledby={typesId}>
            {types.map(({ category, locations, already }) => {
              const fresh = locations.length - already;
              const checked = ticked.has(category.id);
              const line =
                fresh === 0
                  ? locations.length === 1
                    ? 'It is in the list already'
                    : 'All are in the list already'
                  : already === 0
                    ? locations.length === 1
                      ? 'It is new'
                      : locations.length === 2
                        ? 'Both are new'
                        : `All ${numberFormat.format(locations.length)} are new`
                    : `${numberFormat.format(already)} ${already === 1 ? 'is' : 'are'} already in the list`;
              return (
                <li key={category.id}>
                  <label
                    className={checked ? 'editor-type editor-type-on' : 'editor-type'}
                    data-testid="add-type-row"
                  >
                    <input
                      type="checkbox"
                      className="editor-check"
                      checked={checked}
                      disabled={fresh === 0}
                      onChange={() => {
                        const next = new Set(ticked);
                        if (checked) next.delete(category.id);
                        else next.add(category.id);
                        setTicked(next);
                      }}
                    />
                    <span
                      className="editor-type-dot"
                      style={{ background: category.color }}
                      aria-hidden="true"
                    />
                    <span className="editor-type-text">
                      <span className="editor-type-name">{category.name}</span>
                      <span className="editor-type-line">{line}</span>
                    </span>
                    <span className="editor-type-count">
                      {numberFormat.format(locations.length)}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <footer className="editor-side-foot editor-side-foot-add">
        <p className="editor-side-line">
          They go in {where}, nearest first. Locations already in the list are left out.
        </p>
        <button
          type="button"
          className="own-pill-button own-pill-primary editor-add-button"
          data-testid="add-type-submit"
          disabled={picked.length === 0}
          onClick={() => {
            addLocationSteps(picked);
            setTicked(new Set());
          }}
        >
          {picked.length === 0
            ? 'Add locations'
            : picked.length === 1
              ? 'Add 1 location'
              : `Add ${numberFormat.format(picked.length)} locations`}
        </button>
      </footer>
    </>
  );
}

// ---------------------------------------------------------------------------
// Search

function SearchTab({ game, list, where }: { game: LoadedGame; list: OwnList; where: string }) {
  const [query, setQuery] = useState('');
  const hits = useLocationHits(game, query, 20);
  const inList = useMemo(() => new Set(list.items.flatMap((i) => i.locationIds)), [list]);
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <div className="editor-side-body editor-side-scroll">
      <div className="own-field">
        <label htmlFor={inputId} className="own-label">
          Find a location by name
        </label>
        <input
          ref={input}
          id={inputId}
          className="own-input"
          type="search"
          autoComplete="off"
          value={query}
          data-testid="add-search-input"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </div>
      <p className="editor-side-line">Each one goes in {where}.</p>
      {hits.length > 0 ? (
        <ul className="touch-plain-list editor-finder-hits" aria-label="Locations">
          {hits.map((hit) => {
            const already = inList.has(hit.id);
            return (
              <li key={hit.id} className="editor-hit-row">
                <span className="editor-hit-text">
                  <span className="editor-location-name">{hit.title}</span>
                  <span className="editor-location-detail">{locationDetail(game, hit.id)}</span>
                </span>
                {already ? (
                  <span className="editor-chip">In the list</span>
                ) : (
                  <button
                    type="button"
                    className="own-pill-button editor-hit-add"
                    aria-label={`Add ${hit.title}`}
                    data-testid="add-search-hit"
                    onClick={() => {
                      addLocationSteps([hit.id]);
                    }}
                  >
                    Add
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : query.trim() ? (
        <p className="editor-side-line">No location is called that.</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A list

function ListTab({ game, list, where }: { game: LoadedGame; list: OwnList; where: string }) {
  const own = useOwnLists((s) => s.lists);
  const sources = useMemo(() => {
    const out: { id: string; label: string; entry: () => ChecklistEntry }[] = [];
    for (const entry of game.checklists.checklists) {
      out.push({ id: entry.checklist.id, label: entry.checklist.name, entry: () => entry });
    }
    for (const other of own) {
      if (other.checklist.id === list.checklist.id) continue;
      out.push({
        id: other.checklist.id,
        label: `${other.checklist.name} (yours, ${templateName(other.checklist.type ?? 'collection').toLowerCase()})`,
        entry: () => entryOfOwn(game, other),
      });
    }
    return out;
  }, [game, own, list.checklist.id]);
  const [sourceId, setSourceId] = useState(() => sources[0]?.id ?? '');
  const [filter, setFilter] = useState('');
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const selectId = useId();
  const filterId = useId();
  const source = sources.find((s) => s.id === sourceId);
  const entry = useMemo(() => source?.entry(), [source]);
  const shown = useMemo(() => {
    const items = entry?.items ?? [];
    const text = filter.trim().toLowerCase();
    return (text ? items.filter((i) => i.item.name.toLowerCase().includes(text)) : items).slice(
      0,
      LIST_LIMIT,
    );
  }, [entry, filter]);

  if (sources.length === 0) {
    return (
      <div className="editor-side-body">
        <p className="editor-side-line">There is no other list to add from.</p>
      </div>
    );
  }
  const chosen = (entry?.items ?? []).filter((i) => ticked.has(i.item.id));
  const allShown = shown.length > 0 && shown.every((i) => ticked.has(i.item.id));
  return (
    <>
      <div className="editor-side-body editor-side-scroll">
        <div className="own-field">
          <label htmlFor={selectId} className="own-label">
            List
          </label>
          <div className="editor-select-wrap">
            <select
              id={selectId}
              className="own-input editor-select"
              value={sourceId}
              data-testid="add-list-source"
              onChange={(event) => {
                setSourceId(event.target.value);
                setTicked(new Set());
                setFilter('');
              }}
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <UiIcon name="chevronDown" size={18} strokeWidth={1.8} />
          </div>
        </div>
        <div className="own-field">
          <label htmlFor={filterId} className="own-label">
            Only entries called
          </label>
          <input
            id={filterId}
            className="own-input"
            type="search"
            autoComplete="off"
            value={filter}
            data-testid="add-list-filter"
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
        </div>
        <button
          type="button"
          className="own-text-button"
          disabled={shown.length === 0}
          onClick={() => {
            const next = new Set(ticked);
            for (const i of shown) {
              if (allShown) next.delete(i.item.id);
              else next.add(i.item.id);
            }
            setTicked(next);
          }}
        >
          {allShown ? 'Untick these' : 'Tick all of these'}
        </button>
        <ul className="touch-plain-list editor-types" aria-label="Entries">
          {shown.map(({ item }) => {
            const checked = ticked.has(item.id);
            return (
              <li key={item.id}>
                <label
                  className={checked ? 'editor-type editor-type-on' : 'editor-type'}
                  data-testid="add-list-row"
                >
                  <input
                    type="checkbox"
                    className="editor-check"
                    checked={checked}
                    onChange={() => {
                      const next = new Set(ticked);
                      if (checked) next.delete(item.id);
                      else next.add(item.id);
                      setTicked(next);
                    }}
                  />
                  <span className="editor-type-text">
                    <span className="editor-type-name">{item.name}</span>
                    <span className="editor-type-line">
                      {item.locationIds[0] && game.pack.locations.has(item.locationIds[0])
                        ? locationDetail(game, item.locationIds[0])
                        : 'No location'}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {(entry?.items.length ?? 0) > shown.length && !filter.trim() ? (
          <p className="editor-side-line">
            The first {numberFormat.format(LIST_LIMIT)} are shown. Type part of a name to find
            others.
          </p>
        ) : null}
      </div>
      <footer className="editor-side-foot editor-side-foot-add">
        <p className="editor-side-line">They go in {where}, in the list’s order, as copies.</p>
        <button
          type="button"
          className="own-pill-button own-pill-primary editor-add-button"
          data-testid="add-list-submit"
          disabled={chosen.length === 0}
          onClick={() => {
            addEntrySteps(
              chosen.map(({ item }) => ({
                name: item.name,
                locationIds: item.locationIds,
                ...(item.note ? { note: item.note } : {}),
              })),
            );
            setTicked(new Set());
          }}
        >
          {chosen.length === 0
            ? 'Add steps'
            : chosen.length === 1
              ? 'Add 1 step'
              : `Add ${numberFormat.format(chosen.length)} steps`}
        </button>
      </footer>
    </>
  );
}

// ---------------------------------------------------------------------------
// Blank

function BlankTab({ where }: { where: string }) {
  const [name, setName] = useState('');
  const inputId = useId();
  return (
    <div className="editor-side-body">
      <form
        className="own-field"
        onSubmit={(event) => {
          event.preventDefault();
          addBlankStep(name);
          setName('');
        }}
      >
        <label htmlFor={inputId} className="own-label">
          A step with no location
        </label>
        <input
          id={inputId}
          className="own-input"
          type="text"
          autoComplete="off"
          placeholder="Such as: Talk to the smith"
          value={name}
          maxLength={200}
          data-testid="add-blank-name"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <p className="editor-side-line">It goes in {where}, and is ticked by hand.</p>
        <button
          type="submit"
          className="own-pill-button own-pill-primary editor-add-button"
          data-testid="add-blank-submit"
        >
          Add step
        </button>
      </form>
      <div className="own-field editor-blank-heading">
        <div className="own-label">A heading</div>
        <p className="editor-side-line">
          Headings split the list into parts. The steps under a heading go with it.
        </p>
        <button
          type="button"
          className="own-pill-button editor-add-button"
          data-testid="add-blank-heading"
          onClick={addHeading}
        >
          <UiIcon name="heading" size={18} strokeWidth={1.8} />
          Add a heading
        </button>
      </div>
    </div>
  );
}
