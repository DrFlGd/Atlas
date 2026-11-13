import { stageOf, tallyStates, type ChecklistEntry, type ItemState } from '@atlas/core';
import { isOwnId } from '@atlas/schema';
import { useEffect, useMemo, useState } from 'react';
import { UiIcon } from '../components/icons';
import { useAtlas, type LoadedGame } from '../state/store';
import { useCanEdit } from './editor/canEdit';
import { startEditing, useEditor } from './editor/editorState';
import { AreasView } from './ListAreas';
import { CardsView } from './ListCards';
import { KindList, ShowChoice, type Show } from './ListGroups';
import { useListTools } from './ListTools';
import { OrderView } from './ListOrder';
import { PageBack } from './ListRows';
import { ofText, percentOf } from './listText';
import {
  chooseView,
  doneWord,
  placesOf,
  setOnlyOnMap,
  shapeOf,
  stagesOf,
  useItemStates,
  useListView,
  useLists,
  useNextStep,
  viewsOf,
  type ListView,
} from './listViews';
import { useTouch } from './state';
import { SwitchTrack } from './widgets';

const VIEWS: { id: ListView; label: string }[] = [
  { id: 'cards', label: 'Cards' },
  { id: 'area', label: 'By area' },
  { id: 'kind', label: 'By type' },
  { id: 'order', label: 'In order' },
];

/**
 * One list: its name and how far it is, the choice among the views it
 * offers (see `viewsOf`), whether it is alone on the map, and the view.
 * Every view reads the same items and found marks.
 */
export function ListFrame({ game, entry }: { game: LoadedGame; entry: ChecklistEntry }) {
  const chosen = useListView(entry);
  const canEdit = useCanEdit();
  const room = useTouch((s) => s.editorRoom);
  const previewing = useEditor((s) => s.listId !== null);
  const focus = useAtlas((s) => s.itemFocus);
  const states = useItemStates(entry);
  const next = useNextStep(entry, states);
  const views = viewsOf(entry);
  // An item asked for from search, a place or a link is shown, this time,
  // in a view that has every entry: in order, or by kind with none left out.
  const asked = (f: typeof focus) =>
    f?.open === true && entry.items.some((i) => i.item.id === f.itemId) ? f.seq : null;
  const [askedSeq, setAskedSeq] = useState(() => asked(focus));
  const [seen, setSeen] = useState(focus?.seq);
  if (focus?.seq !== seen) {
    setSeen(focus?.seq);
    const seq = asked(focus);
    if (seq !== null) setAskedSeq(seq);
  }
  // Once shown, the request is answered: coming back to the list later keeps its view.
  useEffect(() => {
    if (focus?.open) useAtlas.setState({ itemFocus: { itemId: focus.itemId, seq: focus.seq } });
  }, [focus]);
  const view = askedSeq === null ? chosen : views.includes('order') ? 'order' : 'kind';
  useEffect(() => {
    useLists.setState({ frameView: { listId: entry.checklist.id, view } });
    return () => {
      useLists.setState({ frameView: null });
    };
  }, [entry, view]);

  const { done, total } = tallyStates(states);
  const stages = stagesOf(entry);
  const titled = stages.filter((s) => s.title !== null);
  const stage = next === null ? undefined : stageOf(stages, next);
  const name = entry.checklist.name;
  const own = isOwnId(entry.checklist.id);
  return (
    <div
      className="touch-page"
      data-testid="checklist-screen"
      data-view={view}
      data-list-type={shapeOf(entry).type}
    >
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
          {own && canEdit && !previewing ? (
            <button
              type="button"
              className="own-edit-button"
              data-testid="edit-own-list"
              onClick={() => {
                startEditing(entry.checklist.id);
              }}
            >
              <UiIcon name="pencil" size={18} strokeWidth={1.8} />
              Edit
            </button>
          ) : null}
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
      {own && !room ? (
        <p className="touch-note own-phone-note own-frame-note" data-testid="own-lists-phone-note">
          This list can be changed on a wider screen: a tablet on its side, or a computer.
        </p>
      ) : null}
      {views.length > 1 ? (
        <div
          className="touch-segmented touch-view-switch"
          role="group"
          aria-label="How to show this list"
        >
          {VIEWS.filter((v) => views.includes(v.id)).map((v) => (
            <button
              key={v.id}
              type="button"
              className="touch-segment"
              aria-pressed={v.id === view}
              data-testid={`view-${v.id}`}
              onClick={() => {
                setAskedSeq(null);
                chooseView(entry.checklist.id, v.id);
              }}
            >
              {v.label}
            </button>
          ))}
        </div>
      ) : null}
      <OnlySwitch entry={entry} />
      {view === 'cards' ? (
        <CardsView game={game} entry={entry} states={states} />
      ) : view === 'area' ? (
        <AreasView game={game} entry={entry} states={states} />
      ) : view === 'kind' ? (
        <KindView
          key={askedSeq ?? 'chosen'}
          game={game}
          entry={entry}
          states={states}
          all={askedSeq !== null}
        />
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

/**
 * The whole list by kind, with the search field and the filters of a long
 * list: the view of a collection that has every entry.
 */
function KindView({
  game,
  entry,
  states,
  all,
}: {
  game: LoadedGame;
  entry: ChecklistEntry;
  states: readonly ItemState[];
  /** Start with nothing left out (an entry was asked for, and may be found already). */
  all: boolean;
}) {
  const [show, setShow] = useState<Show>(all ? 'all' : 'todo');
  const tools = useListTools(game, entry, states);
  const left = useMemo(() => {
    let count = 0;
    if (tools.only) {
      for (const i of tools.only) if (!states[i]!.done) count++;
    } else {
      for (const state of states) if (!state.done) count++;
    }
    return count;
  }, [tools.only, states]);
  return (
    <>
      {tools.element}
      <ShowChoice left={left} show={show} onChange={setShow} />
      <KindList
        key={show}
        game={game}
        entry={entry}
        states={states}
        show={show}
        scope={tools.only}
        more
      />
    </>
  );
}
