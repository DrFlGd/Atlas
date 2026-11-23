import { useEffect, useRef } from 'react';
import { UiIcon } from '../components/icons';
import { numberFormat } from '../state/derived';
import { loadGuidebookTexts, openGuidebook, useGuidebooks } from '../state/guidebooks';
import {
  dateWords,
  magazineFacts,
  pagesWords,
  type Issue,
  type Magazine,
} from '../state/magazineData';
import {
  closeShelf,
  followMagazines,
  openShelf,
  useGameCoverage,
  useHasMagazines,
  useMagazineList,
  useMagazines,
} from '../state/magazines';
import { useAtlas } from '../state/store';
import '../styles/guidebooks.css';
import '../styles/magazines.css';

/**
 * Magazines where the app shows them (see `state/magazines.ts`): the
 * shelf, over the whole window, which lists the magazine titles on this
 * device and then one title's issues by date with their covers; "In
 * magazines" with a game's guides, each issue that covers the game with
 * the pages about it; and the button that opens the shelf, in the Library
 * and in Games. An issue opens in the guidebook reader.
 */

/** What follows the shell's listings, and the shelf when it is open. */
export function MagazineLayer() {
  const library = useAtlas((s) => s.library !== null);
  const shelf = useMagazines((s) => s.shelf !== null);
  // The lists of the packs of magazines, read with each listing.
  useEffect(() => (library ? followMagazines() : undefined), [library]);
  // The text of the issues that cover the shown game, for search.
  const gameId = useAtlas((s) => s.game?.entry.id ?? null);
  const coverage = useGameCoverage(gameId);
  useEffect(() => {
    if (coverage.length > 0) void loadGuidebookTexts(coverage.map(({ issue }) => issue));
  }, [coverage]);
  return shelf ? <Shelf /> : null;
}

/** "Magazines": opens the shelf; shown only when there are magazines on this device. */
export function MagazinesButton({ variant }: { variant: 'touch' | 'library' | 'pill' }) {
  const has = useHasMagazines();
  if (!has) return null;
  const className =
    variant === 'touch'
      ? 'touch-button touch-button-block'
      : variant === 'library'
        ? 'button button-block'
        : 'own-pill-button';
  return (
    <button
      type="button"
      className={className}
      data-testid={variant === 'pill' ? 'all-magazines' : 'open-magazines'}
      onClick={() => {
        openShelf();
      }}
    >
      <UiIcon name="library" size={variant === 'library' ? 16 : 20} />
      {variant === 'pill' ? 'All magazines' : 'Magazines'}
    </button>
  );
}

/**
 * "In magazines": each issue that covers a game, newest first, with the
 * pages about it. Pressing one opens the reader at the first of them.
 */
export function IssuesOfGame({
  gameId,
  heading = 'In magazines',
}: {
  gameId: string;
  /** null: the card it is in names it. */
  heading?: string | null;
}) {
  const coverage = useGameCoverage(gameId);
  if (coverage.length === 0) return null;
  return (
    <section
      className="guidebooks magazine-coverage"
      aria-label="In magazines"
      data-testid="in-magazines"
    >
      {heading !== null ? <h2 className="guidebooks-title">{heading}</h2> : null}
      <ul className="guidebooks-list">
        {coverage.map(({ issue, pages }) => (
          <li key={issue.key} className="guidebook-row" data-testid="magazine-coverage-row">
            <button
              type="button"
              className="guidebook-open"
              data-testid="magazine-coverage-open"
              onClick={() => {
                openGuidebook(issue, pages[0]?.[0] ?? 1);
              }}
            >
              <Cover issue={issue} size="small" />
              <span className="guidebook-text">
                <span className="guidebook-name">
                  {issue.issue.magazine}, {issue.title}
                </span>
                <span className="guidebook-facts" data-testid="magazine-coverage-pages">
                  {[dateWords(issue.issue.date), pagesWords(pages)].filter(Boolean).join(' · ')}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="guidebooks-actions">
        <MagazinesButton variant="pill" />
      </div>
    </section>
  );
}

/** A modal dialog while it is on the page. */
function useModal(ref: React.RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [ref]);
}

/**
 * The shelf of magazines, over the whole window: every magazine title,
 * then the issues of the one chosen. Esc and the Android app's Back go
 * from a title's issues to every title, then close it.
 */
function Shelf() {
  const ref = useRef<HTMLDialogElement>(null);
  useModal(ref);
  const packId = useMagazines((s) => s.shelf?.packId ?? null);
  const magazines = useMagazineList();
  const lists = useMagazines((s) => s.lists);
  const loading = Object.values(lists).some((l) => l.status === 'loading');
  const problems = Object.values(lists).flatMap((l) =>
    l.status === 'error' && l.error ? [l.error] : [],
  );
  // One title only: its issues are the shelf.
  const only = magazines.length === 1 ? magazines[0] : undefined;
  const chosen = magazines.find((magazine) => magazine.packId === packId) ?? only ?? null;
  const back = chosen !== null && only === undefined;
  return (
    <dialog
      ref={ref}
      className="mz-shelf"
      aria-label={chosen ? chosen.title : 'Magazines'}
      data-testid="magazine-shelf"
      data-view={chosen ? 'issues' : 'titles'}
      onCancel={(event) => {
        event.preventDefault();
        if (back) openShelf(null);
        else closeShelf();
      }}
    >
      <header className="mz-bar">
        {back ? (
          <button
            type="button"
            className="gb-button"
            data-testid="magazine-shelf-back"
            onClick={() => {
              openShelf(null);
            }}
          >
            <UiIcon name="back" size={18} />
            Magazines
          </button>
        ) : null}
        <div className="gb-heading">
          <h1 className="gb-title" data-testid="magazine-shelf-title">
            {chosen ? chosen.title : 'Magazines'}
          </h1>
          <p className="gb-facts">
            {chosen
              ? [chosen.publisher, magazineFacts(chosen)].filter(Boolean).join(' · ')
              : `${numberFormat.format(magazines.length)} ${magazines.length === 1 ? 'magazine' : 'magazines'} on this device`}
          </p>
        </div>
        <button
          type="button"
          className="gb-icon-button"
          aria-label="Close the magazines"
          title="Close the magazines (Esc)"
          data-testid="magazine-shelf-close"
          onClick={closeShelf}
        >
          <UiIcon name="close" size={20} />
        </button>
      </header>
      <div className="mz-body" data-scroll-root>
        {chosen ? (
          <IssueGrid magazine={chosen} />
        ) : magazines.length > 0 ? (
          <TitleList magazines={magazines} />
        ) : (
          <p className="gb-wait" role="status">
            {loading ? 'Reading the magazines…' : 'There are no magazines on this device.'}
          </p>
        )}
        {problems.map((problem) => (
          <p key={problem} className="gb-problem" role="alert">
            {problem}
          </p>
        ))}
      </div>
    </dialog>
  );
}

/** Every magazine title, each with the cover of its newest issue. */
function TitleList({ magazines }: { magazines: readonly Magazine[] }) {
  return (
    <ul className="mz-grid" aria-label="Magazines">
      {magazines.map((magazine) => {
        const newest = magazine.issues[0];
        return (
          <li key={magazine.packId}>
            <button
              type="button"
              className="mz-card"
              data-testid="magazine-title"
              onClick={() => {
                openShelf(magazine.packId);
              }}
            >
              {newest ? <Cover issue={newest} size="large" /> : null}
              <span className="mz-card-text">
                <span className="mz-card-title">{magazine.title}</span>
                <span className="mz-card-facts">
                  {[magazine.publisher, magazineFacts(magazine)].filter(Boolean).join(' · ')}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** One title's issues, newest first, each opened where it was left. */
function IssueGrid({ magazine }: { magazine: Magazine }) {
  const reading = useGuidebooks((s) => s.open?.guidebook.key ?? null);
  return (
    <ul className="mz-grid" aria-label={`Issues of ${magazine.title}`}>
      {magazine.issues.map((issue) => (
        <li key={issue.key}>
          <button
            type="button"
            className="mz-card"
            data-testid="magazine-issue"
            aria-current={reading === issue.key ? 'true' : undefined}
            onClick={() => {
              openGuidebook(issue);
            }}
          >
            <Cover issue={issue} size="large" />
            <span className="mz-card-text">
              <span className="mz-card-title">{issue.title}</span>
              <span className="mz-card-facts">
                {[
                  dateWords(issue.issue.date),
                  `${numberFormat.format(issue.pages)} ${issue.pages === 1 ? 'page' : 'pages'}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** An issue's cover, or, without one, a plain card with its number or title. */
function Cover({ issue, size }: { issue: Issue; size: 'small' | 'large' }) {
  const className = size === 'small' ? 'mz-cover mz-cover-small' : 'mz-cover';
  if (issue.issue.coverUrl) {
    return (
      <img
        className={className}
        src={issue.issue.coverUrl}
        alt=""
        loading="lazy"
        decoding="async"
        data-testid="magazine-cover"
      />
    );
  }
  return (
    <span className={`${className} mz-cover-none`} aria-hidden="true">
      {issue.issue.number !== null ? numberFormat.format(issue.issue.number) : issue.title}
    </span>
  );
}
