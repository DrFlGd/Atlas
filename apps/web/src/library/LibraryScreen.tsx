import { useEffect } from 'react';
import { AddBox, AddFlow } from '../components/AddFlow';
import { UiIcon } from '../components/icons';
import { downloadsOffered, importsOffered } from '../features';
import {
  gameKind,
  KIND_LABEL,
  loadAllGameFacts,
  statusLine,
  useGameFacts,
} from '../state/gameFacts';
import { stopRun, updateAll, useImport } from '../state/importing';
import {
  closeLibraryWindow,
  openLibraryGame,
  openSettings,
  setMoreOpen,
  showLibraryAdd,
  useLibrary,
  useOpenGameId,
} from '../state/libraryView';
import { ownGamesOffered } from '../state/ownGames';
import { useAtlas } from '../state/store';
import { NewGameButton } from '../touch/OwnGames';
import { GamePane } from './GamePane';
import { SettingsScreen } from './SettingsScreen';
import { useUpdatable } from './updatable';
import '../styles/library.css';

/**
 * The Library, in the desktop app: the games on this computer on the
 * left, each with what it is and one line on its state, and the box to
 * add a map or a wiki; on the right the game open (see `GamePane.tsx`),
 * the steps of adding, or (in the classic layout) the settings. A strip
 * at the bottom follows pages being read. In the standard layout it is a
 * section of its own (`section`); in the classic layout it fills the
 * window (`window`), with Settings and Close.
 */
export function LibraryScreen({ mode }: { mode: 'section' | 'window' }) {
  const pane = useLibrary((s) => s.pane);
  const openId = useOpenGameId();
  const updatable = useUpdatable();
  const catalog = useAtlas((s) => s.catalog);
  const library = useAtlas((s) => s.library);

  useEffect(() => {
    void loadAllGameFacts();
  }, [catalog, library]);

  // Esc closes the More menu first, then (over the whole window) the Library.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('dialog[open]')) return;
      if (useLibrary.getState().more) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setMoreOpen(false);
      } else if (mode === 'window') {
        closeLibraryWindow();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [mode]);

  return (
    <div
      className={mode === 'window' ? 'library library-window' : 'library'}
      data-testid="library"
      data-pane={pane}
      role={mode === 'window' ? 'dialog' : undefined}
      aria-modal={mode === 'window' ? true : undefined}
      aria-label="Library"
    >
      <div className="library-columns">
        <aside className="library-side" aria-label="Games">
          <header className="library-side-head">
            <h1 className="library-heading">Library</h1>
            {mode === 'window' ? (
              <span className="library-side-tools">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Settings"
                  title="Settings: where maps are saved, other folders, download speed and the activity log"
                  aria-pressed={pane === 'settings'}
                  data-testid="library-settings"
                  onClick={openSettings}
                >
                  <UiIcon name="settings" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close the Library"
                  title="Close the Library and go back to the map"
                  data-testid="library-close"
                  onClick={closeLibraryWindow}
                >
                  <UiIcon name="close" />
                </button>
              </span>
            ) : null}
          </header>
          <div className="library-side-body touch-scroll" data-scroll-root>
            <AddArea />
            <GameList openId={pane === 'game' ? openId : null} />
            <SideTools updatable={updatable.size > 0} />
          </div>
        </aside>
        <main className="library-main">
          {pane === 'add' ? (
            <AddFlow />
          ) : pane === 'settings' ? (
            <SettingsScreen general={false} />
          ) : openId ? (
            <GamePane key={openId} id={openId} updatable={updatable.has(openId)} />
          ) : (
            <p className="muted library-empty">Choose a game on the left.</p>
          )}
        </main>
      </div>
      <LibraryStrip />
    </div>
  );
}

/** "Add a map or a wiki", where this app has importers. */
function AddArea() {
  const importers = useAtlas((s) => s.config?.importers.length ?? 0);
  const imports = useAtlas(importsOffered);
  if (importers === 0 || !imports) return null;
  return <AddBox />;
}

/** The games on this computer, each with its type and one line on its state. */
function GameList({ openId }: { openId: string | null }) {
  const catalog = useAtlas((s) => s.catalog);
  const packs = useAtlas((s) => s.library?.packs);
  const shown = useAtlas((s) => s.game?.entry.id ?? null);
  const downloads = useAtlas(downloadsOffered);
  const facts = useGameFacts((s) => s.byId);
  return (
    <section className="library-list-section" aria-labelledby="library-games-heading">
      <h2 className="library-group-title" id="library-games-heading">
        Games on this computer
      </h2>
      <ul className="library-list" data-testid="library-list">
        {catalog.map((entry) => {
          const listed = packs?.find((p) => p.id === entry.id);
          const own = facts[entry.id];
          const kind = gameKind(listed, own?.details ?? null);
          const line = statusLine({
            kind,
            facts: own,
            jobs: { images: own?.images?.job ?? null, photos: own?.photos?.job ?? null },
            downloads: __ATLAS_DOWNLOADS__ && downloads,
            wikiPages:
              kind === 'wiki' && own?.details
                ? { read: own.details.contents.guides, listed: null }
                : null,
          });
          return (
            <li key={entry.id}>
              <button
                type="button"
                className="library-row"
                aria-current={entry.id === openId ? 'true' : undefined}
                data-testid="library-game"
                data-pack={entry.id}
                onClick={() => {
                  openLibraryGame(entry.id);
                }}
              >
                <span className="library-row-top">
                  <span className="library-row-title">{entry.title}</span>
                  {entry.id === shown ? <span className="badge badge-done">Shown</span> : null}
                </span>
                <span className="library-row-line">
                  <span className={`library-kind library-kind-${kind}`}>{KIND_LABEL[kind]}</span>
                  {line.text ? (
                    <span
                      className={`library-status library-status-${line.tone}`}
                      data-testid="library-status"
                    >
                      {line.text}
                    </span>
                  ) : null}
                </span>
                {line.progress !== undefined ? (
                  <span className="meter meter-small" aria-hidden="true">
                    <span className="meter-fill" style={{ width: `${line.progress * 100}%` }} />
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Under the list: checking every game for changes, and making a game of one's own. */
function SideTools({ updatable }: { updatable: boolean }) {
  const canMake = useAtlas(ownGamesOffered);
  if (!updatable && !canMake) return null;
  return (
    <div className="library-side-tools-block">
      {updatable ? (
        <>
          <button
            type="button"
            className="button button-block"
            data-testid="update-all"
            onClick={() => void updateAll()}
          >
            Check every game for changes…
          </button>
          <p className="muted small">
            Lists the games added from web pages, all ticked. Their pages are read only after you
            press Check, one at a time.
          </p>
        </>
      ) : null}
      {canMake ? <NewGameButton /> : null}
    </div>
  );
}

/**
 * The strip at the bottom of the Library: the pages being read now, with
 * Stop, and a way back to them. Map image and photo jobs show on their
 * games' cards and lines.
 */
function LibraryStrip() {
  const phase = useImport((s) => s.phase);
  const pane = useLibrary((s) => s.pane);
  if ((phase.kind !== 'run' && phase.kind !== 'listing') || phase.run.status !== 'running') {
    return null;
  }
  const pages = phase.run.pages;
  const done = pages.filter(
    (page) =>
      page.state.kind !== 'waiting' &&
      page.state.kind !== 'open' &&
      page.state.kind !== 'converting',
  ).length;
  const total = pages.length;
  return (
    <footer className="library-strip" data-testid="library-strip" aria-label="Now">
      <span className="library-strip-now">
        <strong>Now:</strong> reading page {Math.min(done + 1, total)} of {total}
        {phase.run.stopRequested ? ', stopping after this page' : ''}
      </span>
      <span className="meter meter-small library-strip-meter" aria-hidden="true">
        <span className="meter-fill" style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
      </span>
      {pane !== 'add' ? (
        <button type="button" className="button button-small" onClick={showLibraryAdd}>
          See the pages
        </button>
      ) : null}
      <button
        type="button"
        className="button button-small"
        data-testid="library-strip-stop"
        disabled={phase.run.stopRequested}
        title="Stops after the page that is open now; what was read is kept"
        onClick={stopRun}
      >
        Stop
      </button>
    </footer>
  );
}
