import type { SearchHit } from '@atlas/core';
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { goToLocation } from '../state/actions';
import { numberFormat } from '../state/derived';
import { useAtlas } from '../state/store';
import { GlyphBadge, UiIcon } from './icons';

const LIMIT = 50;
const KIND_LABEL = { location: 'Location', entity: 'Thing', guide: 'Guide' } as const;

/**
 * One search box over every location, entity and guide in the pack, across
 * all maps, as an ARIA combobox with a listbox of results. Choosing a result
 * flies the map to it and selects it.
 */
export function SearchBox() {
  const game = useAtlas((s) => s.game);
  const focusRequest = useAtlas((s) => s.searchFocus);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const deferred = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const { hits, total } = useMemo(() => {
    if (!game || !deferred.trim()) return { hits: [] as SearchHit[], total: 0 };
    const found = game.search.search(deferred, LIMIT);
    return {
      hits: found,
      total: found.length < LIMIT ? found.length : game.search.count(deferred),
    };
  }, [game, deferred]);

  useEffect(() => {
    if (focusRequest === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  const choose = (hit: SearchHit | undefined) => {
    const target = hit?.entry.locationIds[0];
    if (!target) return;
    goToLocation(target);
    setOpen(false);
    inputRef.current?.blur();
  };

  const expanded = open && query.trim() !== '';
  const activeHit = hits[Math.min(active, hits.length - 1)];

  return (
    <div className="search">
      <label className="visually-hidden" htmlFor={`${listId}-input`}>
        Search locations
      </label>
      <span className="search-icon">
        <UiIcon name="search" size={16} />
      </span>
      <input
        ref={inputRef}
        id={`${listId}-input`}
        className="search-input"
        type="search"
        placeholder="Search  ( / )"
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          expanded && activeHit ? `${listId}-${activeHit.entry.id}` : undefined
        }
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, hits.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            choose(activeHit);
          } else if (event.key === 'Escape') {
            if (query) setQuery('');
            else inputRef.current?.blur();
          }
        }}
      />
      {expanded ? (
        <div className="search-popup">
          <ul id={listId} role="listbox" aria-label="Search results" className="search-results">
            {hits.map((hit, index) => (
              <SearchResult
                key={hit.entry.id}
                id={`${listId}-${hit.entry.id}`}
                hit={hit}
                active={index === active}
                onChoose={() => {
                  choose(hit);
                }}
                onHover={() => {
                  setActive(index);
                }}
              />
            ))}
          </ul>
          <p className="search-summary" role="status">
            {total === 0
              ? 'No matches'
              : total > hits.length
                ? `Showing ${hits.length} of ${numberFormat.format(total)} matches`
                : `${total} match${total === 1 ? '' : 'es'}`}
          </p>
        </div>
      ) : null}
    </div>
  );
}

interface SearchResultProps {
  id: string;
  hit: SearchHit;
  active: boolean;
  onChoose: () => void;
  onHover: () => void;
}

function SearchResult({ id, hit, active, onChoose, onHover }: SearchResultProps) {
  const game = useAtlas((s) => s.game);
  const found = useAtlas((s) =>
    hit.entry.kind === 'location' ? s.found.has(hit.entry.id) : false,
  );
  const { entry } = hit;
  const location = entry.kind === 'location' ? game?.pack.locations.get(entry.id) : undefined;
  const category = location ? game?.pack.categories.get(location.categoryId) : undefined;
  const reachable = entry.locationIds.length > 0;
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={!reachable}
      className="search-result"
      // Keeps focus in the input so the list does not close before the click lands.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={onChoose}
      onMouseMove={onHover}
    >
      <span className="search-result-icon">
        {category ? (
          <GlyphBadge icon={category.icon} color={category.color} size={22} muted={found} />
        ) : (
          <span className="kind-tag">{KIND_LABEL[entry.kind]}</span>
        )}
      </span>
      <span className="search-result-text">
        <span className="search-result-title">
          {entry.title}
          {found ? <span className="found-tag">found</span> : null}
        </span>
        <span className="search-result-detail">
          {reachable ? entry.detail : `${entry.detail} · not on the map`}
        </span>
      </span>
    </li>
  );
}
