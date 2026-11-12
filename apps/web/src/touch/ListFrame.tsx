import { stageOf, type ChecklistEntry, type ItemState } from '@atlas/core';
import { useEffect, useState } from 'react';
import { useAtlas, type LoadedGame } from '../state/store';
import { AreasView } from './ListAreas';
import { KindList, ShowChoice, type Show } from './ListGroups';
import { OrderView } from './ListOrder';
import { PageBack } from './ListRows';
import { ofText, percentOf } from './listText';
import {
  chooseView,
  doneWord,
  placesOf,
  setOnlyOnMap,
  stagesOf,
  useItemStates,
  useListView,
  useLists,
  useNextStep,
  type ListView,
} from './listViews';
import { SwitchTrack } from './widgets';

const VIEWS: { id: ListView; label: string }[] = [
  { id: 'area', label: 'By area' },
  { id: 'kind', label: 'By kind' },
  { id: 'order', label: 'In order' },
];

/**
 * One list: its name and how far it is, the choice of view (by area, by
 * kind, in order), whether it is alone on the map, and the view. Every view
 * reads the same items and found marks.
 */
export function ListFrame({ game, entry }: { game: LoadedGame; entry: ChecklistEntry }) {
  const chosen = useListView(entry);
  const focus = useAtlas((s) => s.itemFocus);
  const states = useItemStates(entry);
  const next = useNextStep(entry, states);
  // An item asked for from search, a place or a link is shown in order, this time.
  const asked = (f: typeof focus) =>
    f?.open === true && entry.items.some((i) => i.item.id === f.itemId);
  const [ordered, setOrdered] = useState(() => asked(focus));
  const [seen, setSeen] = useState(focus?.seq);
  if (focus?.seq !== seen) {
    setSeen(focus?.seq);
    if (asked(focus)) setOrdered(true);
  }
  // Once shown, the request is answered: coming back to the list later keeps its view.
  useEffect(() => {
    if (focus?.open) useAtlas.setState({ itemFocus: { itemId: focus.itemId, seq: focus.seq } });
  }, [focus]);
  const view = ordered ? 'order' : chosen;
  useEffect(() => {
    useLists.setState({ frameView: { listId: entry.checklist.id, view } });
    return () => {
      useLists.setState({ frameView: null });
    };
  }, [entry, view]);

  const done = states.filter((s) => s.done).length;
  const total = states.length;
  const stages = stagesOf(entry);
  const titled = stages.filter((s) => s.title !== null);
  const stage = next === null ? undefined : stageOf(stages, next);
  const name = entry.checklist.name;
  return (
    <div className="touch-page" data-testid="checklist-screen" data-view={view}>
      <header className="touch-page-head touch-page-head-back">
        <div className="touch-page-head-row">
          <PageBack />
          <div className="touch-page-head-text">
            <h1 className="touch-page-subtitle">{name}</h1>
            <p
              className="touch-page-figure"
              data-testid="checklist-done"
              data-done={done}
              data-total={total}
            >
              {ofText(done, total)} {doneWord(entry)} · {percentOf(done, total)}%
              {view === 'order' && stage?.title && titled.length > 1
                ? ` · Stage ${stage.number} of ${titled.length}`
                : ''}
            </p>
          </div>
        </div>
        <div
          className="touch-progressbar"
          role="progressbar"
          aria-label={`${name} ${doneWord(entry)}`}
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
      <div
        className="touch-segmented touch-view-switch"
        role="group"
        aria-label="How to show this list"
      >
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className="touch-segment"
            aria-pressed={v.id === view}
            data-testid={`view-${v.id}`}
            onClick={() => {
              setOrdered(false);
              chooseView(entry.checklist.id, v.id);
            }}
          >
            {v.label}
          </button>
        ))}
      </div>
      <OnlySwitch entry={entry} />
      {view === 'area' ? (
        <AreasView game={game} entry={entry} states={states} />
      ) : view === 'kind' ? (
        <KindView game={game} entry={entry} states={states} left={total - done} />
      ) : (
        <OrderView game={game} entry={entry} states={states} next={next} />
      )}
    </div>
  );
}

/** "Only this list on the map", for a list that has places. */
export function OnlySwitch({ entry }: { entry: ChecklistEntry }) {
  const on = useLists((s) => s.onlyOnMap);
  if (placesOf(entry).size === 0) return null;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className="touch-list-only"
      data-testid="list-only-switch"
      onClick={() => {
        setOnlyOnMap(!on);
      }}
    >
      <span className="touch-switch-label">Only this list on the map</span>
      <SwitchTrack on={on} />
    </button>
  );
}

/** The whole list by kind. */
function KindView({
  game,
  entry,
  states,
  left,
}: {
  game: LoadedGame;
  entry: ChecklistEntry;
  states: readonly ItemState[];
  left: number;
}) {
  const [show, setShow] = useState<Show>('todo');
  return (
    <>
      <ShowChoice left={left} show={show} onChange={setShow} />
      <KindList key={show} game={game} entry={entry} states={states} show={show} />
    </>
  );
}
