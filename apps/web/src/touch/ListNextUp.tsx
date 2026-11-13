import { areaOfPlace, type ChecklistEntry } from '@atlas/core';
import { UiIcon } from '../components/icons';
import { setEntryDone, showItemPlace } from '../state/checklists';
import { numberFormat } from '../state/derived';
import { useAtlas, type LoadedGame } from '../state/store';
import { entryNote } from './listText';
import {
  areaName,
  centreOn,
  openListOf,
  skipStep,
  useItemStates,
  useLists,
  useNextStep,
} from './listViews';
import { useKeyHints, useTouch } from './state';
import { KeyHint } from './widgets';

/** The next step, pinned above the bar on a phone: its name, a way to see it, and Done. */
export function NextUpBar({ entry, next }: { entry: ChecklistEntry; next: number }) {
  const item = entry.items[next]!;
  const place = item.places[0];
  return (
    <section className="touch-pinned touch-next-up" aria-label="Next up" data-testid="next-up">
      <span className="touch-pinned-text">
        <span className="touch-pinned-label">Next up · step {numberFormat.format(next + 1)}</span>
        <span className="touch-pinned-name" data-testid="next-up-name">
          {item.item.name}
        </span>
      </span>
      {place ? (
        <button
          type="button"
          className="touch-round-button touch-next-show"
          aria-label="Show the next step on the map"
          data-testid="next-up-show"
          onClick={() => {
            showItemPlace(item.item.id, place);
          }}
        >
          <UiIcon name="pin" size={22} />
        </button>
      ) : null}
      <DoneButton entry={entry} next={next} />
    </section>
  );
}

function DoneButton({ entry, next }: { entry: ChecklistEntry; next: number }) {
  const hints = useKeyHints();
  return (
    <button
      type="button"
      className="touch-done-button"
      aria-keyshortcuts={hints ? 'F' : undefined}
      data-testid="next-up-done"
      onClick={() => {
        setEntryDone(entry.items[next]!, true);
      }}
    >
      <UiIcon name="check" size={22} strokeWidth={2.2} />
      Done
      <KeyHint k="F" />
    </button>
  );
}

/**
 * On a wide screen, the next step of the list shown in order, as a card on
 * the map: what and where it is, Done, and "Skip for now". While a place
 * is selected, its card is shown there instead, with "Next on this list".
 */
export function NextUpCard() {
  const game = useAtlas((s) => s.game);
  const entry = useAtlas(openListOf);
  const page = useAtlas((s) => s.checklistPages.at(-1));
  const section = useTouch((s) => s.section);
  const view = useLists((s) => s.frameView);
  const placeShown = useAtlas((s) => s.selectedId !== null);
  if (!game || !entry || section !== 'lists' || placeShown) return null;
  if (page?.kind !== 'checklist' || page.area !== undefined) return null;
  if (view?.listId !== entry.checklist.id || view.view !== 'order') return null;
  return <NextCard game={game} entry={entry} />;
}

function NextCard({ game, entry }: { game: LoadedGame; entry: ChecklistEntry }) {
  const states = useItemStates(entry);
  const next = useNextStep(entry, states);
  const hints = useKeyHints();
  if (next === null) return null;
  const item = entry.items[next]!;
  const first = item.places[0] ? game.pack.locations.get(item.places[0]) : undefined;
  const kind = first ? game.pack.categories.get(first.categoryId)?.name : undefined;
  const where = first ? areaName(game, areaOfPlace(game.pack, first)) : undefined;
  const region = first?.regionId ? game.pack.regions.get(first.regionId)?.name : where;
  const note = entryNote(game, item);
  return (
    <section className="touch-next-card" aria-label="Next up" data-testid="next-up-card">
      <div className="touch-next-card-head">
        <div className="touch-next-card-text">
          <p className="touch-continue-kicker">
            Next up · step {numberFormat.format(next + 1)} of {numberFormat.format(states.length)}
          </p>
          <h2 className="touch-next-card-name" data-testid="next-up-name">
            {item.item.name}
          </h2>
          {kind || region ? (
            <p className="touch-next-card-where">{[kind, region].filter(Boolean).join(' · ')}</p>
          ) : null}
        </div>
        {first ? (
          <button
            type="button"
            className="touch-round-button"
            aria-label="Show the next step on the map"
            data-testid="next-up-show"
            onClick={() => {
              // The map goes there; the card stays, rather than the place's.
              centreOn(game, first.id);
            }}
          >
            <UiIcon name="pin" size={20} />
          </button>
        ) : null}
      </div>
      {note ? <p className="touch-next-card-note">{note}</p> : null}
      <div className="touch-next-card-actions">
        <DoneButton entry={entry} next={next} />
        <button
          type="button"
          className="place-action"
          aria-keyshortcuts={hints ? 'N' : undefined}
          data-testid="next-up-skip"
          onClick={() => {
            skipStep(entry, next);
          }}
        >
          Skip for now
          <KeyHint k="N" />
        </button>
      </div>
      {hints ? (
        <p className="touch-next-card-keys">
          With a keyboard: F marks it done, N goes to the next step.
        </p>
      ) : null}
    </section>
  );
}
