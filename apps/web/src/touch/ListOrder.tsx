import {
  EVERYTHING_ID,
  NO_AREA,
  areaOfPlace,
  itemState,
  nextStep,
  orderRows,
  plainNote,
  type ChecklistEntry,
  type ItemState,
  type OrderRow,
} from '@atlas/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { UiIcon } from '../components/icons';
import { VirtualList } from '../components/VirtualList';
import { select } from '../state/actions';
import { setEntryDone } from '../state/checklists';
import { numberFormat } from '../state/derived';
import { useAtlas, type LoadedGame } from '../state/store';
import { NextUpBar } from './ListNextUp';
import { EntryRow, GroupHeader } from './ListRows';
import { entryWhere, ROW_HEIGHT } from './listText';
import { useListTools } from './ListTools';
import {
  areaName,
  areasOf,
  centreOn,
  everythingOf,
  openArea,
  setOrderKeys,
  skipStep,
  stagesOf,
  useLists,
} from './listViews';
import { useTouch } from './state';
import { TickMark } from './widgets';

const rowKey = (row: OrderRow) => {
  switch (row.kind) {
    case 'stage':
      return `stage|${row.stage}`;
    case 'here':
      return 'here';
    case 'run':
      return `run|${row.from}`;
    case 'item':
      return `item|${row.index}`;
  }
};

/**
 * "In order": the list's own order in stages (its sections), the step to
 * do next highlighted, the done steps before it folded into one row, and a
 * way to the rest of the area of that step. On a phone, "Next up" is pinned
 * at the bottom; on a wide screen it is a card on the map (`NextUpCard`).
 */
export function OrderView({
  game,
  entry,
  states,
  next,
}: {
  game: LoadedGame;
  entry: ChecklistEntry;
  states: readonly ItemState[];
  next: number | null;
}) {
  const wide = useTouch((s) => s.arrangement === 'wide');
  const focus = useAtlas((s) => s.itemFocus);
  const stages = stagesOf(entry);
  const [stageOpen, setStageOpen] = useState<ReadonlyMap<number, boolean>>(new Map());
  // "Show" opens the folded steps until the next step changes.
  const [runShownFor, setRunShownFor] = useState<number | null>(null);
  const tools = useListTools(game, entry, states);
  const rows = useMemo(
    () =>
      orderRows(states, stages, {
        highlight: next,
        stageOpen,
        runShown: runShownFor !== null && runShownFor === next,
        only: tools.only,
      }),
    [states, stages, next, stageOpen, runShownFor, tools.only],
  );
  useOrderKeys(entry, next);

  // A step asked for (from outside, or shown from here) is brought into
  // view; otherwise the next step is, whenever it changes.
  const [focusAtStart] = useState(() => (focus?.open ? 0 : (focus?.seq ?? 0)));
  const reveal = useMemo(() => {
    if (focus && focus.seq > focusAtStart) {
      const index = rows.findIndex(
        (r) => r.kind === 'item' && entry.items[r.index]!.item.id === focus.itemId,
      );
      if (index >= 0) return { index, seq: focus.seq };
    }
    if (next === null) return null;
    const index = rows.findIndex((r) => r.kind === 'item' && r.index === next);
    return index < 0 ? null : { index, seq: -1 - next };
  }, [focus, focusAtStart, rows, entry, next]);

  return (
    <>
      {tools.element}
      <div className="touch-scroll touch-check-list" data-scroll-root>
        {rows.length === 0 ? (
          <p className="touch-empty">
            {entry.items.length === 0
              ? 'This list has no entries.'
              : 'No entries match the filters.'}
          </p>
        ) : (
          <VirtualList
            items={rows}
            getKey={rowKey}
            estimate={ROW_HEIGHT}
            renderItem={(row) => {
              switch (row.kind) {
                case 'stage': {
                  const stage = stages[row.stage]!;
                  const finished = row.done === row.total;
                  return (
                    <GroupHeader
                      title={stage.title ?? ''}
                      found={row.done}
                      total={row.total}
                      open={row.open}
                      testId="stage"
                      badge={
                        finished ? (
                          <TickMark done round />
                        ) : (
                          <span className="touch-stage-number" aria-hidden="true">
                            {stage.number}
                          </span>
                        )
                      }
                      onToggle={() => {
                        setStageOpen(new Map(stageOpen).set(row.stage, !row.open));
                      }}
                    />
                  );
                }
                case 'here':
                  return <WhileHere game={game} entry={entry} next={next} />;
                case 'run':
                  return (
                    <button
                      type="button"
                      className="touch-run-row"
                      data-testid="done-run"
                      onClick={() => {
                        setRunShownFor(next);
                      }}
                    >
                      <UiIcon name="check" size={18} strokeWidth={2} />
                      <span className="touch-run-text">
                        Steps {numberFormat.format(row.from + 1)} to{' '}
                        {numberFormat.format(row.to + 1)} are done
                      </span>
                      <span className="touch-run-show">Show</span>
                    </button>
                  );
                case 'item': {
                  const item = entry.items[row.index]!;
                  const isNext = row.index === next;
                  return (
                    <EntryRow
                      game={game}
                      entry={item}
                      state={states[row.index]!}
                      detail={stepDetail(game, item, states[row.index]!, row.index)}
                      more
                      next={isNext}
                      note={isNext && item.item.note ? plainNote(item.item.note) : undefined}
                    />
                  );
                }
              }
            }}
            className="touch-entry-list"
            testId="check-items"
            visible
            reveal={reveal}
          />
        )}
      </div>
      {!wide && next !== null ? <NextUpBar entry={entry} next={next} /> : null}
    </>
  );
}

/** "Step 10 · Chest · Duskmoor". */
function stepDetail(
  game: LoadedGame,
  item: ChecklistEntry['items'][number],
  state: ItemState,
  index: number,
): string {
  const first = item.places.length > 0 ? game.pack.locations.get(item.places[0]!) : undefined;
  const kind = first ? game.pack.categories.get(first.categoryId)?.name : undefined;
  return [
    `Step ${numberFormat.format(index + 1)}`,
    kind,
    entryWhere(game, item, state, item.places[0]),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** F and N while this view is shown: the next step done, and on to the one after. */
function useOrderKeys(entry: ChecklistEntry, next: number | null) {
  const current = useRef({ entry, next });
  useEffect(() => {
    current.current = { entry, next };
  });
  useEffect(() => {
    setOrderKeys({
      done: () => {
        const { entry: list, next: index } = current.current;
        if (index === null) return false;
        const item = list.items[index]!;
        // Another place is selected: F marks that one, as everywhere.
        const selected = useAtlas.getState().selectedId;
        if (selected !== null && !item.places.includes(selected)) return false;
        setEntryDone(item, true);
        return true;
      },
      next: () => {
        const { entry: list, next: index } = current.current;
        if (index === null) return false;
        skipStep(list, index);
        showNextOnMap(list);
        return true;
      },
    });
    return () => {
      setOrderKeys(null);
    };
  }, []);
}

/**
 * On a wide screen, after N: the map goes to the step "In order" points at
 * now, and its card shows in place of a selected place's.
 */
function showNextOnMap(entry: ChecklistEntry): void {
  const { found, game } = useAtlas.getState();
  if (!game || useTouch.getState().arrangement !== 'wide') return;
  const isDone = (id: string) => found.has(id);
  const from = useLists.getState().orderFrom;
  const start = from?.listId === entry.checklist.id ? from.from : 0;
  const index = nextStep(
    entry.items.map((item) => itemState(item, isDone)),
    start,
  );
  const item = index === null ? undefined : entry.items[index];
  const place = item?.places.find((id) => !isDone(id)) ?? item?.places[0];
  select(null);
  if (place) centreOn(game, place);
}

/** "While you are here: 12 more to find in Duskmoor", for the area of the next step. */
function WhileHere({
  game,
  entry,
  next,
}: {
  game: LoadedGame;
  entry: ChecklistEntry;
  next: number | null;
}) {
  const found = useAtlas((s) => s.found);
  const item = next === null ? undefined : entry.items[next];
  const first = item?.places[0] ? game.pack.locations.get(item.places[0]) : undefined;
  const area = first ? areaOfPlace(game.pack, first) : NO_AREA;
  const left = useMemo(() => {
    if (area === NO_AREA || !item) return 0;
    const everything = everythingOf(game);
    const own = new Set(item.places);
    let count = 0;
    for (const i of areasOf(game, everything).items.get(area) ?? []) {
      const id = everything.items[i]!.item.id;
      if (!found.has(id) && !own.has(id)) count++;
    }
    return count;
  }, [game, area, item, found]);
  if (left === 0) return null;
  return (
    <button
      type="button"
      className="touch-here-link"
      data-testid="while-here"
      onClick={() => {
        openArea(EVERYTHING_ID, area);
      }}
    >
      <span>
        While you are here: {numberFormat.format(left)} more to find in {areaName(game, area)}
      </span>
      <UiIcon name="chevron" size={18} strokeWidth={1.8} />
    </button>
  );
}
