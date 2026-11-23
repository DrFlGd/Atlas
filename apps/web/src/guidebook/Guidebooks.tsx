import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { UiIcon } from '../components/icons';
import { useAtlas, type LoadedGame } from '../state/store';
import { guidebookFacts, sizeWords, type GuidebookHit } from '../state/guidebookData';
import {
  addGuidebook,
  askToRemoveGuidebook,
  cancelAddingGuidebook,
  followGuidebooks,
  guidebookChangesOffered,
  loadGuidebookTexts,
  openGuidebook,
  removeGuidebook,
  startAddingGuidebook,
  useGameGuidebooks,
  useGuidebookHits,
  useGuidebooks,
} from '../state/guidebooks';
import { numberFormat } from '../state/derived';
import { isIssue, issueName } from '../state/magazineData';
import { useMagazineHits } from '../state/magazines';
import { IssuesOfGame, MagazineLayer } from './Magazines';
import '../styles/editor.css';
import '../styles/guidebooks.css';

/**
 * Guidebooks where the app shows them (see `state/guidebooks.ts`): the
 * list of a game's guidebooks, in Guides and in the Library; the pages of
 * guidebooks a search found; "Add a guidebook…" and "Remove this
 * guidebook…"; and, over everything, the reader, which is loaded with
 * pdf.js only when a guidebook is opened.
 */

const GuidebookReader = lazy(() => import('./GuidebookReader'));

/** What is over the whole app: the reader, and the dialogs to add and remove a guidebook. */
export function GuidebookLayer() {
  const open = useGuidebooks((s) => s.open !== null);
  const adding = useGuidebooks((s) => s.adding !== null);
  const removing = useGuidebooks((s) => s.removing !== null);
  const library = useAtlas((s) => s.library !== null);
  // The lists of the packs of guidebooks, read with each listing.
  useEffect(() => (library ? followGuidebooks() : undefined), [library]);
  // The text of the shown game's guidebooks, for search.
  const gameId = useAtlas((s) => s.game?.entry.id ?? null);
  const guidebooks = useGameGuidebooks(gameId);
  useEffect(() => {
    if (guidebooks.length > 0) void loadGuidebookTexts(guidebooks);
  }, [guidebooks]);
  return (
    <>
      {/* The shelf of magazines first, so the reader opened from it is over it. */}
      <MagazineLayer />
      {open ? (
        <Suspense fallback={null}>
          <GuidebookReader />
        </Suspense>
      ) : null}
      {adding ? <AddGuidebookDialog /> : null}
      {removing ? <RemoveGuidebookDialog /> : null}
    </>
  );
}

/**
 * A game's guidebooks: each one's title and what it is ("PDF, 212 pages,
 * 148 MB"), opened where it was left; on a desktop, "Add a guidebook…"
 * and, for those Atlas wrote, "Remove…".
 */
export function GuidebookList({
  gameId,
  gameTitle,
  heading = 'Guidebooks',
  alone = false,
}: {
  gameId: string;
  gameTitle: string;
  /** null: the card it is in names it. */
  heading?: string | null;
  /** The guidebooks are all the game has to read: they fill the screen. */
  alone?: boolean;
}) {
  const guidebooks = useGameGuidebooks(gameId);
  const changes = useAtlas(guidebookChangesOffered);
  const busy = useGuidebooks((s) => s.busy);
  if (guidebooks.length === 0 && !changes) return null;
  return (
    <section
      className={alone ? 'guidebooks guidebooks-alone' : 'guidebooks'}
      aria-label={heading ?? 'Guidebooks'}
      data-testid="guidebooks"
    >
      {heading !== null ? <h2 className="guidebooks-title">{heading}</h2> : null}
      {guidebooks.length === 0 && heading === null ? null : guidebooks.length === 0 ? (
        <p className="guidebooks-lead">
          A guidebook is a published guide you have as one file, a PDF or a CBZ. Add one to read it
          here.
        </p>
      ) : (
        <ul className="guidebooks-list">
          {guidebooks.map((guidebook) => (
            <li key={guidebook.key} className="guidebook-row" data-testid="guidebook-row">
              <button
                type="button"
                className="guidebook-open"
                data-testid="guidebook-open"
                onClick={() => {
                  openGuidebook(guidebook);
                }}
              >
                <UiIcon name="book" size={22} />
                <span className="guidebook-text">
                  <span className="guidebook-name">{guidebook.title}</span>
                  <span className="guidebook-facts" data-testid="guidebook-facts">
                    {guidebookFacts(guidebook)}
                  </span>
                </span>
              </button>
              {changes && guidebook.byAtlas ? (
                <button
                  type="button"
                  className="touch-icon-button touch-icon-button-small"
                  aria-label={`Remove ${guidebook.title}…`}
                  title="Remove this guidebook…"
                  data-testid="guidebook-remove"
                  onClick={() => {
                    askToRemoveGuidebook(guidebook);
                  }}
                >
                  <UiIcon name="trash" size={18} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {changes ? (
        <div className="guidebooks-actions">
          <button
            type="button"
            className="own-pill-button"
            disabled={busy}
            data-testid="add-guidebook"
            onClick={() => {
              void startAddingGuidebook(gameId, gameTitle);
            }}
          >
            <UiIcon name="plus" size={18} />
            Add a guidebook…
          </button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Guides of a game that has only guidebooks to read (a pack of guidebooks
 * that joins no game opens on them), or only issues of magazines that
 * cover it: their lists, and search in their text.
 */
export function GuidebooksAlone({
  game,
  wide,
  children,
}: {
  game: LoadedGame;
  wide: boolean;
  /** What follows them: for a game with a map, the guides of other games to read with it. */
  children?: React.ReactNode;
}) {
  const [query, setQuery] = useState('');
  const hits = useGuidebookHits(game.entry.id, query);
  const magazineHits = useMagazineHits(game.entry.id, query);
  const guidebooks = useGameGuidebooks(game.entry.id).length > 0;
  const words = guidebooks ? 'the guidebooks' : 'the magazines';
  return (
    <div
      className={`guides ${wide ? 'guides-wide' : 'guides-compact'} guides-no-menu`}
      data-testid="guides-screen"
    >
      <div className="guidebooks guidebooks-alone" data-scroll-root>
        <h1 className="guides-title">{game.pack.manifest.title}</h1>
        <div className="guides-search" role="search">
          <UiIcon name="search" size={18} />
          <input
            type="search"
            className="guides-search-input"
            placeholder={`Search ${words}`}
            aria-label={`Search ${words}`}
            data-testid="guidebooks-search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        {query.trim() ? (
          hits.length > 0 || magazineHits.length > 0 ? (
            <>
              <GuidebookResults hits={hits} query={query} />
              <GuidebookResults hits={magazineHits} query={query} heading="In magazines" />
            </>
          ) : (
            <p className="guidebooks-lead" role="status">
              No page of {words} has “{query.trim()}”.
            </p>
          )
        ) : null}
        <GuidebookList gameId={game.entry.id} gameTitle={game.pack.manifest.title} />
        <IssuesOfGame gameId={game.entry.id} />
        {children}
      </div>
    </div>
  );
}

/**
 * Results of a search in a game's guidebooks, or in the pages about it in
 * the issues of magazines that cover it: each page found, which opens the
 * reader there.
 */
export function GuidebookResults({
  hits,
  query,
  compact = false,
  heading = 'In guidebooks',
}: {
  hits: readonly GuidebookHit[];
  query: string;
  /** Fewer, in the search of the map. */
  compact?: boolean;
  heading?: 'In guidebooks' | 'In magazines';
}) {
  if (hits.length === 0) return null;
  const shown = compact ? hits.slice(0, 5) : hits;
  const magazines = heading === 'In magazines';
  return (
    <section
      className="guidebook-results"
      aria-label={heading}
      data-testid={magazines ? 'magazine-results' : 'guidebook-results'}
    >
      <h2 className="touch-group-title">{heading}</h2>
      <ul className="touch-plain-list guides-entries">
        {shown.map((hit) => (
          <li key={`${hit.guidebook.key}|${hit.page}`} className="guides-result-row">
            <button
              type="button"
              className="guides-entry guides-result"
              data-testid={magazines ? 'magazine-result' : 'guidebook-result'}
              onClick={() => {
                openGuidebook(hit.guidebook, hit.page, query);
              }}
            >
              <span className="guides-result-title">
                {isIssue(hit.guidebook) ? issueName(hit.guidebook) : hit.guidebook.title}, page{' '}
                {numberFormat.format(hit.page)}
              </span>
              <span className="guides-result-line">
                <Marked hit={hit} />
              </span>
            </button>
          </li>
        ))}
      </ul>
      {hits.length > shown.length ? (
        <p className="guidebooks-lead">
          {numberFormat.format(hits.length - shown.length)} more{' '}
          {hits.length - shown.length === 1 ? 'page' : 'pages'} in{' '}
          {magazines ? 'magazines. Find in an issue' : 'guidebooks. Find in a guidebook'} lists them
          all.
        </p>
      ) : null}
    </section>
  );
}

function Marked({ hit }: { hit: GuidebookHit }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  hit.marks.forEach(([start, end], i) => {
    if (start > at) parts.push(hit.snippet.slice(at, start));
    parts.push(<mark key={i}>{hit.snippet.slice(start, end)}</mark>);
    at = end;
  });
  parts.push(hit.snippet.slice(at));
  return <>{parts}</>;
}

/** A dialog shown modal while it is on the page. */
function useModal(ref: React.RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [ref]);
}

/** "Add a guidebook…": the title, then reading the PDF's text and writing the pack. */
function AddGuidebookDialog() {
  const adding = useGuidebooks((s) => s.adding);
  const [title, setTitle] = useState(adding?.picked.title ?? '');
  const ref = useRef<HTMLDialogElement>(null);
  useModal(ref);
  if (!adding) return null;
  const { picked, phase } = adding;
  const working = phase !== 'title';
  const trimmed = title.trim();
  const tooLong = Array.from(trimmed).length > 200;
  return (
    <dialog
      ref={ref}
      className="own-dialog own-dialog-small"
      aria-label="Add a guidebook"
      data-testid="add-guidebook-dialog"
      onCancel={(event) => {
        // Esc, and the Android app's Back.
        event.preventDefault();
        cancelAddingGuidebook();
      }}
    >
      <form
        className="own-dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          if (!working && trimmed && !tooLong) void addGuidebook(trimmed);
        }}
      >
        <h2 className="own-dialog-title">Add a guidebook</h2>
        <p className="own-dialog-line">
          {picked.fileName}: {picked.type === 'pdf' ? 'PDF' : 'CBZ'}
          {picked.pages ? `, ${numberFormat.format(picked.pages)} pages` : ''},{' '}
          {sizeWords(picked.bytes)}. It is added to the guidebooks of {adding.gameTitle}, in a pack
          file of its own in the packs folder. The file you picked is copied and stays as it is.
        </p>
        <label className="own-field">
          <span className="own-label">Title</span>
          <input
            className="own-input"
            value={title}
            maxLength={400}
            disabled={working}
            autoFocus
            data-testid="guidebook-title-input"
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        </label>
        {tooLong ? <p className="own-problem">A title can be at most 200 characters.</p> : null}
        {phase === 'reading' ? (
          <p className="own-dialog-line" role="status" data-testid="guidebook-add-state">
            Reading the text of its pages for search
            {adding.total > 0
              ? `: ${numberFormat.format(adding.done)} of ${numberFormat.format(adding.total)}`
              : ''}
            …
          </p>
        ) : phase === 'writing' ? (
          <p className="own-dialog-line" role="status" data-testid="guidebook-add-state">
            Writing the pack file…
          </p>
        ) : null}
        {adding.error ? (
          <p className="own-problem" role="alert" data-testid="guidebook-add-problem">
            {adding.error}
          </p>
        ) : null}
        <footer className="own-dialog-foot">
          <span className="own-space" />
          <button
            type="button"
            className="own-pill-button"
            disabled={phase === 'writing'}
            onClick={cancelAddingGuidebook}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="own-pill-button own-pill-primary"
            disabled={working || !trimmed || tooLong}
            data-testid="confirm-add-guidebook"
          >
            Add the guidebook
          </button>
        </footer>
      </form>
    </dialog>
  );
}

/** "Remove this guidebook…": asks first. */
function RemoveGuidebookDialog() {
  const removing = useGuidebooks((s) => s.removing);
  const busy = useGuidebooks((s) => s.busy);
  const ref = useRef<HTMLDialogElement>(null);
  useModal(ref);
  if (!removing) return null;
  return (
    <dialog
      ref={ref}
      className="own-dialog own-dialog-small"
      aria-label="Remove this guidebook?"
      data-testid="remove-guidebook-dialog"
      onCancel={(event) => {
        event.preventDefault();
        askToRemoveGuidebook(null);
      }}
    >
      <div className="own-dialog-body">
        <h2 className="own-dialog-title">Remove this guidebook?</h2>
        <p className="own-dialog-line">
          {removing.title} is taken out of its pack file in the packs folder, and its file is no
          longer read here. The file you added it from is not changed.
        </p>
        <footer className="own-dialog-foot">
          <span className="own-space" />
          <button
            type="button"
            className="own-pill-button"
            autoFocus
            onClick={() => {
              askToRemoveGuidebook(null);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="own-pill-button own-pill-danger"
            disabled={busy}
            data-testid="confirm-remove-guidebook"
            onClick={() => {
              void removeGuidebook();
            }}
          >
            Remove the guidebook
          </button>
        </footer>
      </div>
    </dialog>
  );
}
