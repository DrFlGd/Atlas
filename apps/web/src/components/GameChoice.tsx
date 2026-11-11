import { useId, type ReactNode } from 'react';
import { MAP_KIND } from '@atlas/importer-api';
import { numberFormat } from '../state/derived';
import {
  chosenPages,
  filterGames,
  overCap,
  pagesLeft,
  planPick,
  type Choice,
  type ChoicePage,
  type GamePick,
} from '../state/gameChoice';
import {
  confirmChoice,
  confirmUpdateGames,
  readPickedGames,
  resetImport,
  setCatalogueQuery,
  stopRun,
  toggleCatalogueGame,
  toggleChoice,
  toggleUpdateGame,
  updateCatalogue,
  type ImportPhase,
  type ListingPurpose,
} from '../state/importing';
import { MAX_RUN_ADDRESSES, stopReasonText, type RunState } from '../state/importRun';
import { localDate } from './packFileText';

/**
 * The steps of Add a map that come before pages are added: reading game
 * pages or a site's list of games, ticking games, and ticking pages.
 */

const plural = (count: number, one: string, many: string) =>
  `${numberFormat.format(count)} ${count === 1 ? one : many}`;

const LISTING_HEAD: Record<ListingPurpose, (count: number) => string> = {
  game: () => 'Reading the list of the game’s pages…',
  update: (count) =>
    count === 1
      ? 'Reading the game page, to see which maps it lists now…'
      : `Reading ${count} game pages, one at a time, to see which maps they list now…`,
  catalogue: () => 'Reading the list of games…',
  'catalogue-games': (count) =>
    count === 1
      ? 'Reading the game page of the game you ticked…'
      : `Reading the game pages of ${count} games, one at a time…`,
};

/** Game pages or a list of games being read, one at a time. */
export function Listing({
  run,
  purpose,
  PageState,
}: {
  run: RunState;
  purpose: ListingPurpose;
  PageState: (props: { state: RunState['pages'][number]['state'] }) => ReactNode;
}) {
  const running = run.status === 'running';
  return (
    <section
      className="dialog-section"
      aria-busy={running}
      data-testid="add-map-listing"
      data-purpose={purpose}
      data-status={run.status}
    >
      <p role="status">
        <strong>{LISTING_HEAD[purpose](run.pages.length)}</strong>{' '}
        {running && run.pausing ? (
          <span className="muted">Opening the next page in a moment.</span>
        ) : null}
      </p>
      <p className="muted small">
        Each page opens in a window of its own. If it asks you to sign in or to confirm you are a
        person, do that there. Nothing is added until you have chosen what to add.
      </p>
      {run.stopReason && run.stopReason !== 'cancelled' ? (
        <p className="download-note" data-testid="add-map-stopped">
          {stopReasonText(run.stopReason)}
        </p>
      ) : null}
      {running && run.stopRequested ? (
        <p className="download-note" data-testid="add-map-stopping">
          This app stops after the page that is open now. To stop at once, close the page window.
        </p>
      ) : null}
      <ol className="add-map-run-list">
        {run.pages.map((page) => (
          <li key={page.url} data-testid="add-map-listing-page" data-state={page.state.kind}>
            <span className="add-map-url">{page.url}</span>
            <PageState state={page.state} />
          </li>
        ))}
      </ol>
      {running && run.pages.length > 1 ? (
        <div className="row-actions">
          <button
            type="button"
            className="button"
            data-testid="add-map-stop"
            disabled={run.stopRequested}
            onClick={() => {
              stopRun();
            }}
          >
            Stop
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** A site's list of games: search it and tick the games to add. */
export function CataloguePick({ pick }: { pick: GamePick }) {
  const searchId = useId();
  const shown = filterGames(pick.games, pick.query);
  const plan = planPick(pick);
  const ticked = pick.ticked.length;
  const reading = plan.games.filter((game) => !game.direct).length;
  return (
    <section className="dialog-section" data-testid="add-map-catalogue">
      <p>
        <strong>
          {plural(pick.games.length, 'game', 'games')} on {pick.importerTitle}.
        </strong>{' '}
        Tick the games to add. This app then opens the game page of each, one at a time, and lists
        their maps for you to choose from.
      </p>
      {pick.keptFrom !== null ? (
        <p className="muted small" data-testid="add-map-catalogue-kept">
          This is the list as this app read it on {localDate(pick.keptFrom)}. Games the site added
          since then are not in it.{' '}
          <button
            type="button"
            className="link-button"
            data-testid="add-map-catalogue-update"
            onClick={() => void updateCatalogue()}
          >
            Update the list
          </button>
        </p>
      ) : null}
      <label htmlFor={searchId} className="field-label">
        Find a game
      </label>
      <input
        id={searchId}
        type="search"
        className="text-input"
        autoComplete="off"
        spellCheck={false}
        placeholder="Name of a game"
        data-testid="add-map-catalogue-search"
        value={pick.query}
        autoFocus
        onChange={(event) => {
          setCatalogueQuery(event.target.value);
        }}
      />
      {shown.length === 0 ? (
        <p className="muted small" data-testid="add-map-catalogue-none">
          No game matches “{pick.query}”.
        </p>
      ) : (
        <ul className="add-map-pick-list" data-testid="add-map-catalogue-list">
          {shown.map((game) => {
            const id = `${searchId}-${game.id}`;
            return (
              <li key={game.id} data-testid="add-map-catalogue-game" data-game={game.id}>
                <label htmlFor={id} className="checkbox-row">
                  <input
                    id={id}
                    type="checkbox"
                    checked={pick.ticked.includes(game.id)}
                    onChange={() => {
                      toggleCatalogueGame(game.id);
                    }}
                  />
                  <span>{game.name}</span>
                </label>
                {game.added ? <span className="badge badge-done">In your maps folder</span> : null}
                {game.direct ? <span className="muted small">One map</span> : null}
              </li>
            );
          })}
        </ul>
      )}
      {plan.leftOut.length > 0 ? (
        <p className="download-note" role="alert" data-testid="add-map-catalogue-cap">
          This app opens at most {MAX_RUN_ADDRESSES} pages at a time
          {pick.keptFrom === null ? ', and the list of games was one of them' : ''}. Each game needs
          its game page and at least one map, so only the first{' '}
          {plural(plan.games.length, 'ticked game fits', 'ticked games fit')} in this go. These are
          left for afterwards: {plan.leftOut.map((game) => game.name).join(', ')}.
        </p>
      ) : null}
      <div className="row-actions wrap">
        <button
          type="button"
          className="button button-primary"
          data-testid="add-map-catalogue-confirm"
          disabled={plan.games.length === 0}
          onClick={() => void readPickedGames()}
        >
          {ticked === 0
            ? 'Tick the games to add'
            : reading === 0
              ? `List the maps of ${plural(plan.games.length, 'game', 'games')}`
              : `Read ${plural(reading, 'game page', 'game pages')}`}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            resetImport();
          }}
        >
          Back
        </button>
      </div>
    </section>
  );
}

/** "Update all…": the games to update, all ticked, before anything opens. */
export function UpdateGames({ phase }: { phase: Extract<ImportPhase, { kind: 'update-games' }> }) {
  const baseId = useId();
  const ticked = phase.games.filter((game) => phase.ticked.includes(game.packId));
  const reading = ticked.filter((game) => game.address !== null).length;
  if (phase.games.length === 0) {
    return (
      <section className="dialog-section" data-testid="add-map-update-games">
        <p role="status">
          <strong>There is nothing to update.</strong> No game in your maps folder was added from
          web pages that this app can read.
        </p>
        <div className="row-actions">
          <button
            type="button"
            className="button"
            onClick={() => {
              resetImport();
            }}
          >
            Back
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="dialog-section" data-testid="add-map-update-games">
      <p>
        <strong>Update games from their site.</strong> This app opens the game page of each ticked
        game, one at a time, and then lists its maps, new ones included, for you to choose which to
        refresh or add. Nothing is changed until you have chosen.
      </p>
      <ul className="add-map-pick-list">
        {phase.games.map((game) => {
          const id = `${baseId}-${game.packId}`;
          return (
            <li key={game.packId} data-testid="add-map-update-game" data-pack={game.packId}>
              <label htmlFor={id} className="checkbox-row">
                <input
                  id={id}
                  type="checkbox"
                  checked={phase.ticked.includes(game.packId)}
                  onChange={() => {
                    toggleUpdateGame(game.packId);
                  }}
                />
                <span>{game.title}</span>
              </label>
              <span className="muted small">
                {game.address
                  ? `Reads its game page on ${game.importerTitle}.`
                  : `${game.importerTitle} gives no game page for it, so the ${plural(game.recorded.length, 'page', 'pages')} it was made from are listed.`}
              </span>
            </li>
          );
        })}
      </ul>
      {reading > pagesLeft(0) - 1 ? (
        <p className="download-note" role="alert">
          That is {plural(reading, 'game page', 'game pages')}, and this app opens at most{' '}
          {MAX_RUN_ADDRESSES} pages at a time. Untick some games and update them afterwards.
        </p>
      ) : null}
      <div className="row-actions wrap">
        <button
          type="button"
          className="button button-primary"
          data-testid="add-map-update-confirm"
          disabled={ticked.length === 0 || reading > pagesLeft(0) - 1}
          onClick={() => void confirmUpdateGames()}
        >
          {reading === 0
            ? `List the maps of ${plural(ticked.length, 'game', 'games')}`
            : `Read ${plural(reading, 'game page', 'game pages')}`}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            resetImport();
          }}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

/** The state of a page in the choice, in words. */
function pageNote(page: ChoicePage): { text: string; tone: 'new' | 'added' | 'off' } {
  if (!page.supported) return { text: 'Not supported yet', tone: 'off' };
  if (page.added) {
    return {
      text: page.unlisted
        ? 'Already added (will be refreshed); its game page no longer lists it'
        : 'Already added (will be refreshed)',
      tone: 'added',
    };
  }
  return { text: 'New', tone: 'new' };
}

/** What a kind of page is called in the list. */
const kindLabel = (kind: string) => (kind === MAP_KIND ? 'Map' : kind);

/** The pages of one or more games, with tick boxes. */
export function ChoosePages({ choice }: { choice: Choice }) {
  const baseId = useId();
  const chosen = chosenPages(choice);
  const maps = chosen.length;
  const over = overCap(choice);
  const allMaps = choice.games.every((game) =>
    game.pages.every((page) => !page.checked || page.kind === MAP_KIND),
  );
  const noun = allMaps ? ['map', 'maps'] : ['page', 'pages'];
  const verb = choice.mode === 'update' ? 'Update' : 'Add';
  return (
    <section className="dialog-section" data-testid="add-map-choose" data-mode={choice.mode}>
      <p>
        <strong>
          {choice.mode === 'update'
            ? 'Choose the maps to refresh or add.'
            : choice.games.length === 1
              ? `Choose what to add from ${choice.games[0]!.title}.`
              : 'Choose what to add.'}
        </strong>{' '}
        Everything this app can add is ticked to start with, maps first. Pages it cannot add yet are
        listed so you know they are there.
      </p>
      {choice.capped > 0 ? (
        <p className="download-note" data-testid="add-map-choose-capped">
          This app opens at most {MAX_RUN_ADDRESSES} pages at a time
          {choice.opened > 0
            ? `, and ${plural(choice.opened, 'page was', 'pages were')} opened already to read the lists`
            : ''}
          , so {plural(choice.capped, 'page was', 'pages were')} left unticked. Add them afterwards.
        </p>
      ) : null}
      {choice.leftOut.length > 0 ? (
        <p className="download-note" data-testid="add-map-choose-left-out">
          These games did not fit in this go, so their game pages were not read:{' '}
          {choice.leftOut.join(', ')}. Add them afterwards.
        </p>
      ) : null}
      {choice.games.map((game) => (
        <fieldset
          key={game.key}
          className="add-map-choice-game"
          data-testid="add-map-choose-game"
          data-game={game.key}
          data-source={game.source}
        >
          <legend>
            <strong>{game.title}</strong>
          </legend>
          {game.note ? <p className="muted small">{game.note}</p> : null}
          {game.pages.length === 0 ? (
            <p className="muted small">There are no pages to choose from.</p>
          ) : (
            <ul className="add-map-pick-list">
              {game.pages.map((page, index) => {
                const id = `${baseId}-${game.key}-${index}`;
                const note = pageNote(page);
                const group = page.group && page.group !== game.pages[index - 1]?.group;
                return (
                  <li
                    key={page.url}
                    data-testid="add-map-choose-page"
                    data-kind={page.kind}
                    data-state={note.tone}
                    data-url={page.url}
                  >
                    {group ? (
                      <span className="add-map-choice-group small">{page.group}</span>
                    ) : null}
                    <label htmlFor={id} className="checkbox-row">
                      <input
                        id={id}
                        type="checkbox"
                        checked={page.checked}
                        disabled={!page.supported}
                        onChange={() => {
                          toggleChoice(game.key, page.url);
                        }}
                      />
                      <span>{page.title}</span>
                    </label>
                    <span className="muted small">
                      {kindLabel(page.kind)} ·{' '}
                      <span className={note.tone === 'new' ? 'badge' : undefined}>{note.text}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      ))}
      {over ? (
        <p className="download-error" role="alert" data-testid="add-map-choose-over">
          {over}
        </p>
      ) : null}
      <div className="row-actions wrap">
        <button
          type="button"
          className="button button-primary"
          data-testid="add-map-choose-confirm"
          disabled={maps === 0 || over !== null}
          onClick={() => void confirmChoice()}
        >
          {maps === 0
            ? `Tick the ${noun[1]} to ${verb.toLowerCase()}`
            : `${verb} ${plural(maps, noun[0]!, noun[1]!)}`}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            resetImport();
          }}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
