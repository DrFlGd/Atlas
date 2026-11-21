import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { followAppLink } from '../state/checklists';
import { ENTRY_LIST_MAX, showEntryLocations } from '../state/mapEntries';
import { useAtlas } from '../state/store';
import { UiIcon } from './icons';

/** An entry of a page with several locations, and where its mark is. */
export interface EntryMenuAt {
  ids: readonly string[];
  label: string;
  anchor: DOMRect;
  /** The mark, to take the focus back to when the list closes. */
  mark: HTMLElement;
}

/**
 * The locations of an entry of a page that has several: a short list, each
 * one shown on the map when pressed, and "Show all on the map". It closes
 * with Escape, a press outside it, or when one is chosen.
 */
export function EntryMenu({ at, onClose }: { at: EntryMenuAt; onClose: () => void }) {
  const game = useAtlas((s) => s.game);
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const close = (focusMark = true) => {
    onClose();
    if (focusMark) at.mark.focus();
  };
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const margin = 8;
    const left = Math.min(
      Math.max(margin, at.anchor.left - 12),
      window.innerWidth - width - margin,
    );
    const below = at.anchor.bottom + 6;
    const top =
      below + height > window.innerHeight - margin
        ? Math.max(margin, at.anchor.top - height - 6)
        : below;
    setPlace({ left, top });
    // Not scrolled to: the list is placed over the page, by its mark.
    menu.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, [at]);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  });
  if (!game) return null;
  const locations = at.ids.flatMap((id) => game.pack.locations.get(id) ?? []);
  const severalMaps = new Set(locations.map((l) => l.mapId)).size > 1;
  return (
    <div
      ref={ref}
      className="entry-menu"
      role="dialog"
      aria-label={`${at.label} on the map`}
      data-testid="entry-menu"
      style={
        place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: 'hidden' }
      }
    >
      <p className="entry-menu-title">
        {at.label} · {locations.length} locations
      </p>
      <ul className="entry-menu-list">
        {locations.slice(0, ENTRY_LIST_MAX).map((location) => (
          <li key={location.id}>
            <button
              type="button"
              className="entry-menu-item"
              data-testid="entry-menu-location"
              onClick={() => {
                close(false);
                followAppLink(location.id);
              }}
            >
              <UiIcon name="pin" size={16} strokeWidth={1.8} />
              <span>
                {location.name}
                {severalMaps ? (
                  <span className="muted"> · {game.pack.maps.get(location.mapId)?.name}</span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {locations.length > ENTRY_LIST_MAX ? (
        <p className="entry-menu-more muted">And {locations.length - ENTRY_LIST_MAX} more.</p>
      ) : null}
      <button
        type="button"
        className="entry-menu-all"
        data-testid="entry-menu-all"
        onClick={() => {
          close(false);
          showEntryLocations(
            locations.map((l) => l.id),
            at.label,
          );
        }}
      >
        <UiIcon name="map" size={16} strokeWidth={1.8} />
        Show all {locations.length} on the map
      </button>
    </div>
  );
}
