import {
  NO_KIND,
  itemState,
  kindGroups,
  nearestFirst,
  type ChecklistEntry,
  type ItemState,
} from '@atlas/core';
import { useMemo, useState } from 'react';
import { VirtualList } from '../components/VirtualList';
import { numberFormat } from '../state/derived';
import { useAtlas, type LoadedGame } from '../state/store';
import { EntryRow, GroupHeader } from './ListRows';
import { entryNote, ROW_HEIGHT } from './listText';

/** What a grouped view shows: what is left to find, or everything. */
export type Show = 'todo' | 'all';

/** "To find · N" or "All", and how the entries are ordered. */
export function ShowChoice({
  left,
  show,
  onChange,
}: {
  left: number;
  show: Show;
  onChange: (show: Show) => void;
}) {
  return (
    <div className="touch-chips touch-show-choice" role="group" aria-label="Show">
      <button
        type="button"
        className="touch-chip"
        aria-pressed={show === 'todo'}
        data-testid="show-todo"
        onClick={() => {
          onChange('todo');
        }}
      >
        To find · {numberFormat.format(left)}
      </button>
      <button
        type="button"
        className="touch-chip"
        aria-pressed={show === 'all'}
        data-testid="show-all"
        onClick={() => {
          onChange('all');
        }}
      >
        All
      </button>
      <span className="touch-show-note">Nearest first</span>
    </div>
  );
}

type Row =
  | { kind: 'group'; key: string; group: string; indices: readonly number[]; open: boolean }
  | { kind: 'item'; key: string; index: number };

const rowKey = (row: Row) => row.key;

/**
 * Entries grouped by kind under headings that open and close, nearest to
 * the middle of the map first in each kind (as search orders places), for
 * the whole list or one area of it. Which entries "To find" shows, and
 * where the map was, are read when the view opens, so an entry ticked here
 * stays under the finger and the order does not move with the map.
 */
export function KindList({
  game,
  entry,
  states,
  show,
  area,
  scope,
  more = false,
}: {
  game: LoadedGame;
  entry: ChecklistEntry;
  states: readonly ItemState[];
  show: Show;
  /** The area shown, if one is. */
  area?: string;
  /** The entries to group, in list order; all of them by default. */
  scope?: readonly number[];
  /** Offer each entry's note, guide and places under it. */
  more?: boolean;
}) {
  const focus = useAtlas((s) => s.itemFocus);
  const [start] = useState(() => {
    const { mapId, view, found } = useAtlas.getState();
    const isDone = (id: string) => found.has(id);
    const doneAtStart = new Set<number>();
    for (const item of entry.items) if (itemState(item, isDone).done) doneAtStart.add(item.index);
    return { mapId, center: view?.center ?? null, doneAtStart };
  });
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(new Map());

  const groups = useMemo(() => {
    const all = scope ?? entry.items.map((i) => i.index);
    return kindGroups(entry, game.pack, all, area).map((g) => ({
      key: g.key,
      indices: nearestFirst(entry, game.pack, g.indices, start.mapId, start.center, area),
    }));
  }, [entry, game, scope, area, start]);

  // The entry asked for or shown last, if it is in this list.
  const focusIndex = useMemo(
    () => (focus ? entry.items.findIndex((i) => i.item.id === focus.itemId) : -1),
    [focus, entry],
  );

  const rows = useMemo(() => {
    const list: Row[] = [];
    for (const group of groups) {
      const items =
        show === 'todo' ? group.indices.filter((i) => !start.doneAtStart.has(i)) : group.indices;
      if (items.length === 0) continue;
      // A kind with nothing left to find starts closed, unless the entry asked for is in it.
      const open =
        opened.get(group.key) ??
        ((focusIndex >= 0 && items.includes(focusIndex)) ||
          items.some((i) => !start.doneAtStart.has(i)));
      list.push({
        kind: 'group',
        key: `kind|${group.key}`,
        group: group.key,
        indices: group.indices,
        open,
      });
      if (!open) continue;
      for (const index of items) {
        list.push({ kind: 'item', key: `${group.key}|${entry.items[index]!.item.id}`, index });
      }
    }
    return list;
  }, [groups, show, opened, start, entry, focusIndex]);

  const reveal = useMemo(() => {
    if (!focus) return null;
    const index = rows.findIndex(
      (r) => r.kind === 'item' && entry.items[r.index]!.item.id === focus.itemId,
    );
    return index < 0 ? null : { index, seq: focus.seq };
  }, [focus, rows, entry]);

  return (
    <div className="touch-scroll touch-check-list" data-scroll-root>
      {rows.length === 0 ? (
        <p className="touch-empty">
          {scope?.length === 0
            ? 'No entries match the filters.'
            : show === 'todo'
              ? 'Everything here is found.'
              : 'Nothing here.'}
        </p>
      ) : (
        <VirtualList
          items={rows}
          getKey={rowKey}
          estimate={ROW_HEIGHT}
          renderItem={(row) => {
            if (row.kind === 'item') {
              const item = entry.items[row.index]!;
              return (
                <EntryRow
                  game={game}
                  entry={item}
                  state={states[row.index]!}
                  detail={entryNote(game, item) ?? (area === undefined ? undefined : '')}
                  more={more}
                  area={area}
                />
              );
            }
            const category = game.pack.categories.get(row.group);
            let found = 0;
            for (const i of row.indices) if (states[i]!.done) found++;
            return (
              <GroupHeader
                title={row.group === NO_KIND ? 'Not on the map' : (category?.name ?? row.group)}
                color={category?.color}
                found={found}
                total={row.indices.length}
                open={row.open}
                testId="kind-group"
                onToggle={() => {
                  setOpened(new Map(opened).set(row.group, !row.open));
                }}
              />
            );
          }}
          className="touch-entry-list"
          testId="check-items"
          visible
          reveal={reveal}
        />
      )}
    </div>
  );
}
