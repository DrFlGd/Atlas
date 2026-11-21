import { useEffect, useId, type ReactNode } from 'react';
import { numberFormat } from '../state/derived';
import {
  closeGames,
  continueKeptSession,
  forgetKeptSession,
  gamesLeft,
  isLeft,
  leavePlan,
  loadKeptSession,
  roomFor,
  sessionTotals,
  setSessionSystem,
  startGames,
  stopGames,
  unmatched,
  useGameSession,
  type GameResult,
  type GameSession,
  type SessionGame,
} from '../state/gameSession';
import { openLibraryGame } from '../state/libraryView';
import { formatBytes } from './downloadFormat';

/**
 * Adding the games of a site's list one after another (see
 * `state/gameSession.ts`): the plan with what is known before anything is
 * read, the session going, what it came to, and a session stopped before
 * to continue.
 */

const plural = (count: number, one: string, many: string) =>
  `${numberFormat.format(count)} ${count === 1 ? one : many}`;

/** What the list says of a game before it is read, in a few words. */
function knownOf(game: SessionGame): string {
  const parts = [
    game.maps !== undefined ? plural(game.maps, 'map', 'maps') : null,
    game.bytes !== undefined ? `about ${formatBytes(game.bytes)}` : null,
    game.system ?? null,
  ].filter((part): part is string => part !== null);
  return parts.join(', ');
}

/** The plan: the games ticked, what they need, the system to file them under, and Start. */
export function GamesPlan() {
  const session = useGameSession((s) => s.session);
  const free = useGameSession((s) => s.free);
  const systemId = useId();
  if (!session) return null;
  const left = gamesLeft(session);
  // Continued: some games were dealt with, or stopped half-way.
  const done = Object.keys(session.results).length;
  const totals = sessionTotals(left);
  const fits = roomFor(totals, free);
  const ownSystems = left.filter((game) => game.system).length;
  return (
    <section className="dialog-section" data-testid="games-plan">
      <p>
        <strong>
          {done > 0
            ? `${plural(left.length, 'game', 'games')} left to add from ${session.site}, of ${numberFormat.format(session.games.length)}.`
            : `Add ${plural(left.length, 'game', 'games')} from ${session.site}, one at a time.`}
        </strong>{' '}
        This app reads the game page of each game, then adds every map of it that is not in your
        maps folder yet, one page at a time, with the pause the site’s rules file asks for between
        pages. It stops at once if the site refuses a page, and you can stop it whenever you like;
        the games left are kept, to continue later.
      </p>
      <ul className="add-map-pick-list games-plan-list" data-testid="games-plan-list">
        {left.map((game) => {
          const known = knownOf(game);
          return (
            <li key={game.id} data-testid="games-plan-game" data-game={game.id}>
              <span>{game.name}</span>
              {known ? <span className="muted small">{known}</span> : null}
              {game.direct ? <span className="muted small">One map</span> : null}
            </li>
          );
        })}
      </ul>
      <div className="games-plan-facts" data-testid="games-plan-totals">
        <p>
          {totals.mapsUnknown === totals.games
            ? 'The list does not say how many maps the games have; each game page says it once read.'
            : `${plural(totals.maps, 'map', 'maps')}${
                totals.mapsUnknown > 0
                  ? `, and the list does not say how many maps ${plural(totals.mapsUnknown, 'other game has', 'other games have')}`
                  : ''
              }.`}
        </p>
        <p data-testid="games-plan-space">
          {totals.bytesUnknown === totals.games
            ? 'The list does not say how much room the games take, so it is not known before they are read.'
            : `They need about ${formatBytes(totals.bytes)}${
                totals.bytesUnknown > 0
                  ? `, and more for ${plural(totals.bytesUnknown, 'game', 'games')} whose size the list does not give`
                  : ''
              }.`}{' '}
          {free === undefined
            ? 'Asking how much room is free…'
            : free === null
              ? 'How much room is free on the drive of your maps folder is not known.'
              : `${formatBytes(free)} is free on the drive of your maps folder.`}
        </p>
        {!fits ? (
          <p className="download-error" role="alert" data-testid="games-plan-no-room">
            The games need more room than is free. Make room, or tick fewer games.
          </p>
        ) : null}
      </div>
      <label htmlFor={systemId} className="field-label">
        System
      </label>
      <input
        id={systemId}
        className="text-input"
        autoComplete="off"
        maxLength={80}
        placeholder="Such as the console the games are for"
        data-testid="games-plan-system"
        value={session.system}
        onChange={(event) => {
          setSessionSystem(event.target.value);
        }}
      />
      <p className="muted small">
        Each game added is filed under this system in the Library (its System tag)
        {ownSystems > 0
          ? `, except ${plural(ownSystems, 'game', 'games')} the list names a system of its own for`
          : ''}
        . A game you gave a system already keeps yours. Leave it empty to file none.
      </p>
      <p className="muted small">
        A game with the same title as one in your maps folder is shown with it under one title. When
        several games here have that title, or none, it is added as a game of its own, and the end
        of the session lists it for you to put together by hand.
      </p>
      <div className="row-actions wrap">
        <button
          type="button"
          className="button button-primary"
          data-testid="games-plan-start"
          disabled={left.length === 0 || !fits}
          onClick={() => void startGames()}
        >
          {done > 0
            ? `Continue: ${plural(left.length, 'game', 'games')}`
            : `Add ${plural(left.length, 'game', 'games')}`}
        </button>
        <button type="button" className="button" data-testid="games-plan-back" onClick={leavePlan}>
          Back
        </button>
      </div>
    </section>
  );
}

/** One game in the session's list: what came of it, or that it is being read or waits. */
function GameRow({
  game,
  session,
  current,
}: {
  game: SessionGame;
  session: GameSession;
  current: string | null;
}) {
  const result = session.results[game.id];
  const state =
    game.id === current
      ? 'reading'
      : result && !isLeft(session, game.id)
        ? result.kind
        : result
          ? 'partial'
          : 'left';
  return (
    <li data-testid="games-game" data-game={game.id} data-state={state}>
      <span>{game.name}</span>
      <span className="muted small">{resultText(result, game.id === current)}</span>
    </li>
  );
}

function resultText(result: GameResult | undefined, reading: boolean): string {
  if (reading) return 'Being read now.';
  if (!result) return 'Left to add.';
  switch (result.kind) {
    case 'added': {
      const parts = [
        result.partial
          ? `${plural(result.added, 'page', 'pages')} added before it stopped; the rest is left.`
          : `${plural(result.added, 'page', 'pages')} added.`,
      ];
      if (result.failed > 0)
        parts.push(`${plural(result.failed, 'page', 'pages')} could not be added.`);
      if (result.system) parts.push(`Filed under ${result.system}.`);
      if (result.match?.kind === 'joined')
        parts.push(`Shown under one title: ${result.match.title}.`);
      return parts.join(' ');
    }
    case 'nothing':
      return result.message;
    case 'failed':
      return `Not added: ${result.message}`;
  }
}

/** While games are added: how far it is, the game being read, and Stop. */
export function GamesGoing() {
  const session = useGameSession((s) => s.session);
  const current = useGameSession((s) => s.current);
  const nextAt = useGameSession((s) => s.nextAt);
  const stopAsked = useGameSession((s) => s.stopAsked);
  if (!session) return null;
  const done = session.games.length - gamesLeft(session).length;
  return (
    <section className="dialog-section" aria-busy="true" data-testid="games-going">
      <SessionHead session={session} done={done} current={current} />
      {nextAt !== null ? (
        <p className="muted" role="status" data-testid="games-pause">
          Waiting between two pages, as the site’s rules file asks.
        </p>
      ) : null}
      <StopGames stopAsked={stopAsked} />
      <ol className="add-map-run-list" data-testid="games-list">
        {session.games.map((game) => (
          <GameRow key={game.id} game={game} session={session} current={current} />
        ))}
      </ol>
    </section>
  );
}

function SessionHead({
  session,
  done,
  current,
}: {
  session: GameSession;
  done: number;
  current: string | null;
}) {
  const name = session.games.find((game) => game.id === current)?.name;
  return (
    <p role="status">
      <strong>
        Adding {plural(session.games.length, 'game', 'games')} from {session.site}, one at a time:{' '}
        {numberFormat.format(done)} of {numberFormat.format(session.games.length)} done.
      </strong>{' '}
      {name ? <span className="muted">Now: {name}.</span> : null}
    </p>
  );
}

function StopGames({ stopAsked }: { stopAsked: boolean }) {
  return stopAsked ? (
    <p className="download-note" data-testid="games-stopping">
      This app stops after the page that is open now. The games left are kept, to continue later.
    </p>
  ) : (
    <div className="row-actions">
      <button type="button" className="button" data-testid="games-stop" onClick={stopGames}>
        Stop adding games
      </button>
    </div>
  );
}

/**
 * Above the steps of one game (its game page read, its pages added) while
 * games are added one after another: which game of how many, and Stop.
 */
export function GamesBar() {
  const going = useGameSession((s) => s.going);
  const session = useGameSession((s) => s.session);
  const current = useGameSession((s) => s.current);
  const stopAsked = useGameSession((s) => s.stopAsked);
  if (!going || !session) return null;
  const done = session.games.length - gamesLeft(session).length;
  return (
    <div className="dialog-section games-bar" data-testid="games-bar">
      <SessionHead session={session} done={done} current={current} />
      <StopGames stopAsked={stopAsked} />
    </div>
  );
}

/** What the session came to: each game, why it stopped, and the games not matched by title. */
export function GamesDone() {
  const session = useGameSession((s) => s.session);
  if (!session) return null;
  const results = session.games.map((game) => session.results[game.id]);
  const added = results.filter((result) => result?.kind === 'added' && !result.partial).length;
  const left = gamesLeft(session).length;
  const notMatched = unmatched(session);
  return (
    <section className="dialog-section" data-testid="games-done">
      <p role="status" data-testid="games-summary">
        <strong>
          {plural(added, 'game', 'games')} added from {session.site}
          {left > 0 ? `, ${plural(left, 'game', 'games')} left` : ''}.
        </strong>
      </p>
      {session.stopped ? (
        <p className="download-note" data-testid="games-stopped">
          {session.stopped}
          {left > 0
            ? ' Continue from the steps of adding (Add a map or a wiki), where the games left are kept.'
            : ''}
        </p>
      ) : null}
      <ol className="add-map-run-list" data-testid="games-list">
        {session.games.map((game) => (
          <GameRow key={game.id} game={game} session={session} current={null} />
        ))}
      </ol>
      {notMatched.length > 0 ? (
        <div data-testid="games-unmatched">
          <p>
            <strong>
              {notMatched.length === 1
                ? 'One game could not be matched with a game in your maps folder.'
                : `${numberFormat.format(notMatched.length)} games could not be matched with a game in your maps folder.`}
            </strong>{' '}
            Each is a game of its own. To show one with another game under one title, open it and
            choose Show with another game under one title.
          </p>
          <ul className="add-map-pick-list">
            {notMatched.map(({ game, result }) => (
              <li key={game.id} data-testid="games-unmatched-game" data-game={result.packId}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    openLibraryGame(result.packId);
                  }}
                >
                  {result.title}
                </button>
                <span className="muted small">{matchText(result)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="row-actions">
        <button type="button" className="button" data-testid="games-close" onClick={closeGames}>
          Add more
        </button>
      </div>
    </section>
  );
}

function matchText(result: Extract<GameResult, { kind: 'added' }>): ReactNode {
  switch (result.match?.kind) {
    case 'unsure':
      return `${plural(result.match.others.length, 'game', 'games')} here, shown apart, have this title, so this app did not choose.`;
    case 'failed':
      return result.match.message;
    default:
      return 'No game here has this title.';
  }
}

/** Before anything is added: a session stopped before, with the games left, to continue or forget. */
export function KeptGames() {
  const kept = useGameSession((s) => s.kept);
  const going = useGameSession((s) => s.going);
  useEffect(() => {
    void loadKeptSession();
  }, []);
  if (!kept || going) return null;
  const left = gamesLeft(kept);
  return (
    <div className="add-map-browse" data-testid="games-kept">
      <p>
        <strong>
          {plural(left.length, 'game', 'games')} from {kept.site} left to add.
        </strong>{' '}
        <span className="muted small">
          {kept.stopped ?? 'Adding them stopped before the end.'} Continue shows them before
          anything is read.
        </span>
      </p>
      <div className="row-actions wrap">
        <button
          type="button"
          className="button"
          data-testid="games-kept-continue"
          onClick={() => void continueKeptSession()}
        >
          Continue
        </button>
        <button
          type="button"
          className="button"
          data-testid="games-kept-forget"
          onClick={forgetKeptSession}
        >
          Forget them
        </button>
      </div>
    </div>
  );
}
