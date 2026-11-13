import {
  countFacets,
  filterChecklist,
  itemFacets,
  type ChecklistEntry,
  type ItemFacets,
  type ItemState,
} from '@atlas/core';
import { useDeferredValue, useId, useMemo, useState } from 'react';
import { FacetGroup } from '../components/ChecklistsPane';
import { useFacetNames } from '../components/facetNames';
import type { LoadedGame } from '../state/store';

/** From this many entries a list gets a search field, as in the classic layout. */
const SEARCH_FROM = 15;
const NO_KEYS: ReadonlySet<string> = new Set();

const facetsByEntry = new WeakMap<ChecklistEntry, ItemFacets[]>();

/** The search field and the region and category filters of a long list, and what they let through. */
export function useListTools(
  game: LoadedGame,
  entry: ChecklistEntry,
  states: readonly ItemState[],
) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [hiddenRegions, setHiddenRegions] = useState(NO_KEYS);
  const [hiddenCategories, setHiddenCategories] = useState(NO_KEYS);
  const [facetsOpen, setFacetsOpen] = useState(false);
  const names = useFacetNames(game, entry);
  const facetsId = useId();
  const searchId = useId();
  const facets = useMemo(() => {
    let list = facetsByEntry.get(entry);
    if (!list) {
      list = entry.items.map((item) => itemFacets(item, game.pack));
      facetsByEntry.set(entry, list);
    }
    return list;
  }, [entry, game]);
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
  const narrowed =
    deferredQuery.trim() !== '' || hiddenRegions.size > 0 || hiddenCategories.size > 0;
  const only = useMemo(
    () =>
      narrowed
        ? filterChecklist(facets, states, {
            query: deferredQuery,
            hideFound: false,
            hiddenRegions,
            hiddenCategories,
          })
        : undefined,
    // Which entries match does not depend on what is found.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [narrowed, facets, deferredQuery, hiddenRegions, hiddenCategories],
  );
  const searchable = entry.items.length >= SEARCH_FROM;
  const showRegions = regionCounts.length > 1;
  const showCategories = categoryCounts.length > 1;
  const hiddenCount = hiddenRegions.size + hiddenCategories.size;
  const element =
    searchable || showRegions || showCategories ? (
      <>
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
              {facetsOpen ? 'Hide filters' : 'Filter by region and type'}
              {hiddenCount > 0 ? ` (${hiddenCount} off)` : ''}
            </button>
          ) : null}
        </div>
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
                legend="Types"
                counts={categoryCounts}
                hidden={hiddenCategories}
                name={names.category}
                onChange={setHiddenCategories}
              />
            ) : null}
          </div>
        ) : null}
      </>
    ) : null;
  return { element, only };
}
