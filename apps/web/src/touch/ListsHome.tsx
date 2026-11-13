import { checklistTally, type ChecklistEntry, type ChecklistTally } from '@atlas/core';
import { useMemo } from 'react';
import { UiIcon } from '../components/icons';
import { checklistScreenTitle, openChecklist, openGuide } from '../state/checklists';
import { numberFormat } from '../state/derived';
import { listedGuides } from '../state/guides';
import { useAtlas, type LoadedGame } from '../state/store';
import { ofText, percentOf } from './listText';
import {
  doneWord,
  everythingOf,
  isRoute,
  listById,
  useItemStates,
  useLists,
  useNextStep,
} from './listViews';
import { focusSearchField, setScope } from './state';
import { Meter } from './widgets';

/**
 * The lists of a game: the one to continue, the collections (every place
 * of the game first, then the pack's collections, secrets, photos and
 * plain lists), the routes (routes and builds, followed in order), and the
 * guides to read. A section with nothing in it is left out.
 */
export function ListsHome({ game }: { game: LoadedGame }) {
  const found = useAtlas((s) => s.found);
  const profile = useAtlas((s) => s.profiles.find((p) => p.id === s.profileId)?.name);
  const lastId = useLists((s) => s.lastListId);
  const { checklists } = game.checklists;
  const guides = listedGuides(game);
  const everything = everythingOf(game);
  const collections = useMemo(
    () => [
      ...(everything.items.length > 0 ? [everything] : []),
      ...checklists.filter((c) => !isRoute(c)),
    ],
    [everything, checklists],
  );
  const routes = useMemo(() => checklists.filter(isRoute), [checklists]);
  const tallies = useMemo(() => {
    const isDone = (id: string) => found.has(id);
    return new Map([...collections, ...routes].map((e) => [e, checklistTally(e, isDone)]));
  }, [collections, routes, found]);
  const last = lastId ? listById(game, lastId) : undefined;

  const listRow = (entry: ChecklistEntry) => (
    <li key={entry.checklist.id}>
      <ListLink entry={entry} tally={tallies.get(entry)!} />
    </li>
  );
  return (
    <div className="touch-page" data-testid="lists-home">
      <header className="touch-page-head">
        <div className="touch-page-head-text">
          <h1 className="touch-page-title">{checklistScreenTitle(game)}</h1>
          <p className="touch-page-figure">
            {game.pack.manifest.title}
            {profile ? ` · ${profile}` : ''}
          </p>
        </div>
        <button
          type="button"
          className="touch-icon-button"
          aria-label="Search lists and guides"
          data-testid="lists-search"
          onClick={() => {
            setScope('lists');
            focusSearchField();
          }}
        >
          <UiIcon name="search" size={22} strokeWidth={1.8} />
        </button>
      </header>
      <div className="touch-scroll touch-page-body touch-lists-home" data-scroll-root>
        {last ? <ContinueCard entry={last} /> : null}
        {collections.length > 0 ? (
          <section aria-labelledby="collections-heading">
            <h2 className="touch-group-title touch-lists-heading" id="collections-heading">
              Collections
            </h2>
            <ul className="touch-plain-list touch-list-cards">{collections.map(listRow)}</ul>
          </section>
        ) : null}
        {routes.length > 0 ? (
          <section aria-labelledby="routes-heading">
            <h2 className="touch-group-title touch-lists-heading" id="routes-heading">
              Routes
            </h2>
            <ul className="touch-plain-list touch-list-cards">{routes.map(listRow)}</ul>
          </section>
        ) : null}
        {guides.length > 0 ? (
          <section aria-labelledby="guides-heading">
            <h2 className="touch-group-title touch-lists-heading" id="guides-heading">
              Guides to read
            </h2>
            <ul className="touch-plain-list touch-list-cards">
              {guides.map((guide) => {
                const places = new Set(
                  guide.locationIds.filter((id) => game.pack.locations.has(id)),
                ).size;
                return (
                  <li key={guide.id}>
                    <button
                      type="button"
                      className="touch-list-card"
                      data-testid="guide-link"
                      onClick={() => {
                        openGuide(guide.id);
                      }}
                    >
                      <span className="touch-list-card-text">
                        <span className="touch-list-card-name">{guide.title}</span>
                        {places > 0 ? (
                          <span className="touch-figure">
                            {places === 1
                              ? 'One location'
                              : `${numberFormat.format(places)} locations`}
                          </span>
                        ) : null}
                      </span>
                      <UiIcon name="chevron" size={20} strokeWidth={1.8} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** One list: its name, how far it is, and a bar. */
function ListLink({ entry, tally }: { entry: ChecklistEntry; tally: ChecklistTally }) {
  const finished = tally.total > 0 && tally.done === tally.total;
  return (
    <button
      type="button"
      className="touch-list-card"
      data-testid="list-link"
      data-checklist-id={entry.checklist.id}
      onClick={() => {
        openChecklist(entry.checklist.id);
      }}
    >
      <span className="touch-list-card-text">
        <span className="touch-list-card-head">
          <span className="touch-list-card-name">{entry.checklist.name}</span>
          <span className="touch-figure" data-done={tally.done} data-total={tally.total}>
            {finished
              ? `All ${numberFormat.format(tally.total)} ${doneWord(entry)}`
              : `${ofText(tally.done, tally.total)} · ${percentOf(tally.done, tally.total)}%`}
          </span>
        </span>
        <Meter found={tally.done} total={tally.total} />
      </span>
      <UiIcon name="chevron" size={20} strokeWidth={1.8} />
    </button>
  );
}

/**
 * The list opened last: how far it is, a way back into it, and what is
 * next (a route's next step; for any other list, how much is left).
 */
function ContinueCard({ entry }: { entry: ChecklistEntry }) {
  const states = useItemStates(entry);
  const next = useNextStep(entry, states);
  const done = states.filter((s) => s.done).length;
  const total = states.length;
  const left = total - done;
  const [label, value] =
    left === 0
      ? ['All done', null]
      : next !== null
        ? ['Next up', entry.items[next]!.item.name]
        : [
            doneWord(entry) === 'found' ? 'Left to find' : 'Left to do',
            left === 1 ? 'One entry' : `${numberFormat.format(left)} entries`,
          ];
  return (
    <section className="touch-continue" aria-labelledby="continue-heading" data-testid="continue">
      <h2 className="touch-continue-kicker" id="continue-heading">
        Continue
      </h2>
      <div>
        <p className="touch-continue-name">{entry.checklist.name}</p>
        <p className="touch-continue-figure">
          {ofText(done, total)} {doneWord(entry)} · {percentOf(done, total)}%
        </p>
      </div>
      <Meter found={done} total={total} />
      <div className="touch-continue-row">
        <p className="touch-continue-next">
          <span className="touch-continue-label">{label}</span>
          {value ? <span className="touch-continue-step">{value}</span> : null}
        </p>
        <button
          type="button"
          className="touch-button touch-button-primary touch-continue-resume"
          data-testid="continue-resume"
          onClick={() => {
            openChecklist(entry.checklist.id);
          }}
        >
          Resume
        </button>
      </div>
    </section>
  );
}
