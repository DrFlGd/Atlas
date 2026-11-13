import type { ContentsEntry, GuideHit } from '@atlas/core';
import type { GuideEntry, GuideSource, Section } from '@atlas/schema';
import { parseId } from '@atlas/schema';
import { keepOwnVersion, pageChange, revertPage } from '@atlas/core';
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { UiIcon } from '../components/icons';
import { MarkdownBody } from '../components/MarkdownBody';
import { useGuideLinks } from '../state/guideLinks';
import { canLinkPages, linkedTargets, locationsText, targetText } from '../state/guideMatches';
import { guidesOf, hasMap } from '../state/guides';
import { canChangeOwnPages, changeContents, useOwnPages } from '../state/ownPages';
import { useAtlas, type LoadedGame } from '../state/store';
import { GuideLinksReview } from './GuideLinksReview';
import { GuidesFromGames } from './GuidesFromGames';
import { showPageOnMap } from './listViews';
import {
  canGoBack,
  canGoForward,
  currentPlace,
  openPlace,
  readerBack,
  readerForward,
  rememberScroll,
  useReader,
  type ReaderPlace,
} from './reader';
import { openPageEditor, packPage, usePageEditor } from './pages/pageEditorState';
import { useTouch } from './state';
import '../styles/guides.css';

/**
 * Guides: a game's guides read as pages, as a wiki is read. The contents
 * (sections that hold sections and pages, in the source's order), each
 * page with its credit, links between pages that stay in the app, Back
 * and Forward that return to where each place was scrolled to, and a
 * search over the pages' titles and text.
 *
 * Wide, the contents stay beside the page; compact (a phone), the contents
 * are a place of their own, as the pages are.
 */
const PageEditor = lazy(() => import('./pages/PageEditor'));

export function GuidesScreen({ wide }: { wide: boolean }) {
  const game = useAtlas((s) => s.game);
  const editing = usePageEditor((s) => s.open);
  // The person's own pages and changes change what is shown.
  useOwnPages((s) => s.own);
  if (!game) return null;
  if (editing) {
    return (
      <div
        className={`guides ${wide ? 'guides-wide' : 'guides-compact'} guides-editing`}
        data-testid="guides-screen"
      >
        <Suspense fallback={<p className="touch-empty">Opening the editor…</p>}>
          <PageEditor wide={wide} />
        </Suspense>
      </div>
    );
  }
  return (
    <div
      className={wide ? 'guides guides-wide' : 'guides guides-compact'}
      data-testid="guides-screen"
    >
      {wide ? (
        <aside className="guides-side" aria-label="Contents">
          <SearchField game={game} />
          <nav className="guides-tree touch-scroll" aria-label="Contents" data-scroll-root>
            <ContentsTree game={game} />
          </nav>
        </aside>
      ) : null}
      <Reader game={game} wide={wide} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The reader

function Reader({ game, wide }: { game: LoadedGame; wide: boolean }) {
  const reader = useReader();
  // Pages of other games, and the links, change what is shown.
  useGuideLinks((s) => s.others);
  const place = currentPlace(reader);
  const body = useRef<HTMLDivElement>(null);
  const { contents } = guidesOf(game);

  // Each place opens where it was scrolled to when it was left.
  const scroll = reader.visits[reader.at]?.scroll ?? 0;
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = scroll;
    // Only when the place changes, not while it is scrolled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader.at, reader.visits.length, place]);

  const frame = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      if (body.current) rememberScroll(body.current.scrollTop);
    });
  };

  const title = placeTitle(game, place);
  return (
    <section className="guides-reader" aria-label={title}>
      <header className="guides-head">
        <button
          type="button"
          className="touch-icon-button"
          aria-label="Back"
          title="Back"
          data-testid="guides-back"
          disabled={!canGoBack(reader)}
          onClick={readerBack}
        >
          <UiIcon name="back" size={20} />
        </button>
        <button
          type="button"
          className="touch-icon-button"
          aria-label="Forward"
          title="Forward"
          data-testid="guides-forward"
          disabled={!canGoForward(reader)}
          onClick={readerForward}
        >
          <UiIcon name="forward" size={20} />
        </button>
        <Breadcrumbs game={game} place={place} />
        {wide ? null : (
          <button
            type="button"
            className="touch-icon-button"
            aria-label="Contents"
            title="Contents"
            data-testid="guides-contents-button"
            onClick={() => {
              openPlace({ kind: 'contents', sectionId: null });
            }}
          >
            <UiIcon name="book" size={20} />
          </button>
        )}
      </header>
      <div
        ref={body}
        className="guides-body touch-scroll"
        data-scroll-root
        data-testid="guides-body"
        onScroll={onScroll}
      >
        <div className="guides-column">
          {!wide && (place.kind === 'search' || (place.kind === 'contents' && !place.sectionId)) ? (
            <SearchField game={game} />
          ) : null}
          {place.kind === 'page' ? (
            <Page game={game} guide={contents.guide(place.guideId)} />
          ) : place.kind === 'links' ? (
            <GuideLinksReview game={game} />
          ) : place.kind === 'search' ? (
            <SearchResults game={game} query={place.query} />
          ) : (
            <ContentsPlace game={game} sectionId={place.sectionId} />
          )}
        </div>
      </div>
    </section>
  );
}

const LINKS_TITLE = 'Link pages to the map';

function placeTitle(game: LoadedGame, place: ReaderPlace): string {
  const { contents } = guidesOf(game);
  switch (place.kind) {
    case 'page':
      return contents.guide(place.guideId)?.title ?? 'Page';
    case 'search':
      return 'Search';
    case 'links':
      return LINKS_TITLE;
    case 'contents':
      return place.sectionId
        ? (contents.section(place.sectionId)?.title ?? 'Contents')
        : 'Contents';
  }
}

/** Where the place is in the contents: Contents › Section › … */
function Breadcrumbs({ game, place }: { game: LoadedGame; place: ReaderPlace }) {
  const { contents } = guidesOf(game);
  const path: Section[] =
    place.kind === 'page'
      ? contents.pathTo(place.guideId)
      : place.kind === 'contents' && place.sectionId
        ? contents.pathTo(place.sectionId)
        : [];
  const atTop = place.kind === 'contents' && place.sectionId === null;
  // A section or a search shows itself last; a page's title is under the bar.
  const here =
    place.kind === 'search'
      ? 'Search'
      : place.kind === 'links'
        ? LINKS_TITLE
        : place.kind === 'contents' && place.sectionId
          ? (contents.section(place.sectionId)?.title ?? null)
          : null;
  return (
    <nav className="guides-crumbs" aria-label="Where this is">
      {atTop ? (
        <span className="guides-crumb guides-crumb-here">Contents</span>
      ) : (
        <button
          type="button"
          className="guides-crumb"
          onClick={() => {
            openPlace({ kind: 'contents', sectionId: null });
          }}
        >
          Contents
        </button>
      )}
      {path.map((section) => (
        <span key={section.id} className="guides-crumb-part">
          <span className="guides-crumb-sep" aria-hidden="true">
            ›
          </span>
          <button
            type="button"
            className="guides-crumb"
            onClick={() => {
              openPlace({ kind: 'contents', sectionId: section.id });
            }}
          >
            {section.title}
          </button>
        </span>
      ))}
      {here ? (
        <span className="guides-crumb-part">
          <span className="guides-crumb-sep" aria-hidden="true">
            ›
          </span>
          <span className="guides-crumb guides-crumb-here" aria-current="page">
            {here}
          </span>
        </span>
      ) : null}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Contents

function ContentsPlace({ game, sectionId }: { game: LoadedGame; sectionId: string | null }) {
  const { contents } = guidesOf(game);
  const section = sectionId ? contents.section(sectionId) : undefined;
  const entries = section ? contents.items(section.id) : contents.top();
  return (
    <div className="guides-contents" data-testid="guides-contents">
      <h1 className="guides-title">{section ? section.title : game.pack.manifest.title}</h1>
      {section ? null : <p className="guides-lead">Contents</p>}
      {!section ? <EditPagesButton label="Edit the pages" guideId={null} /> : null}
      {!section && canLinkPages(game) ? (
        <button
          type="button"
          className="touch-button guides-link-button"
          data-testid="open-guide-links"
          onClick={() => {
            openPlace({ kind: 'links' });
          }}
        >
          <UiIcon name="pin" size={18} strokeWidth={1.8} />
          {LINKS_TITLE}
        </button>
      ) : null}
      {entries.length === 0 ? <p className="touch-empty">Nothing here yet.</p> : null}
      <EntryList entries={entries} />
      {!section && hasMap(game) ? <GuidesFromGames game={game} /> : null}
    </div>
  );
}

function EntryList({ entries }: { entries: readonly ContentsEntry[] }) {
  return (
    <ul className="touch-plain-list guides-entries">
      {entries.map((entry) =>
        entry.kind === 'section' ? (
          <li key={entry.section.id}>
            <button
              type="button"
              className="guides-entry guides-entry-section"
              data-testid="guides-section"
              onClick={() => {
                openPlace({ kind: 'contents', sectionId: entry.section.id });
              }}
            >
              <UiIcon name="folder" size={20} />
              <span className="guides-entry-name">{entry.section.title}</span>
              <span className="touch-figure">
                {entry.pages === 1 ? '1 page' : `${entry.pages} pages`}
              </span>
              <UiIcon name="chevron" size={16} />
            </button>
          </li>
        ) : (
          <li key={entry.guide.id}>
            <button
              type="button"
              className="guides-entry"
              data-testid="guides-page-link"
              onClick={() => {
                openPlace({ kind: 'page', guideId: entry.guide.id });
              }}
            >
              <UiIcon name="book" size={20} />
              <span className="guides-entry-name">{entry.guide.title}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

/** The contents beside the page (wide): the way to the place shown is open. */
function ContentsTree({ game }: { game: LoadedGame }) {
  const place = useReader(currentPlace);
  const { contents } = guidesOf(game);
  const open = useMemo(() => {
    const ids = new Set<string>();
    if (place.kind === 'page') for (const s of contents.pathTo(place.guideId)) ids.add(s.id);
    if (place.kind === 'contents' && place.sectionId) {
      for (const s of contents.pathTo(place.sectionId)) ids.add(s.id);
      ids.add(place.sectionId);
    }
    return ids;
  }, [contents, place]);
  return <TreeLevel game={game} entries={contents.top()} open={open} place={place} depth={0} />;
}

function TreeLevel({
  game,
  entries,
  open,
  place,
  depth,
}: {
  game: LoadedGame;
  entries: readonly ContentsEntry[];
  open: ReadonlySet<string>;
  place: ReaderPlace;
  depth: number;
}) {
  const { contents } = guidesOf(game);
  return (
    <ul className="touch-plain-list guides-tree-level">
      {entries.map((entry) => {
        if (entry.kind === 'page') {
          const current = place.kind === 'page' && place.guideId === entry.guide.id;
          return (
            <li key={entry.guide.id}>
              <button
                type="button"
                className="guides-tree-row"
                style={{ paddingLeft: 12 + depth * 14 }}
                aria-current={current ? 'page' : undefined}
                onClick={() => {
                  openPlace({ kind: 'page', guideId: entry.guide.id });
                }}
              >
                {entry.guide.title}
              </button>
            </li>
          );
        }
        const id = entry.section.id;
        const expanded = open.has(id);
        const current = place.kind === 'contents' && place.sectionId === id;
        return (
          <li key={id}>
            <button
              type="button"
              className="guides-tree-row guides-tree-section"
              style={{ paddingLeft: 4 + depth * 14 }}
              aria-expanded={expanded}
              aria-current={current ? 'page' : undefined}
              onClick={() => {
                openPlace({ kind: 'contents', sectionId: id });
              }}
            >
              <UiIcon name={expanded ? 'chevronDown' : 'chevron'} size={14} strokeWidth={2} />
              {entry.section.title}
            </button>
            {expanded ? (
              <TreeLevel
                game={game}
                entries={contents.items(id)}
                open={open}
                place={place}
                depth={depth + 1}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// A page

/** "Edit the page" (or the pages): the page editor, where pages can be changed here. */
function EditPagesButton({ label, guideId }: { label: string; guideId: string | null }) {
  const status = useOwnPages((s) => s.status);
  if (status !== 'ready') return null;
  return (
    <button
      type="button"
      className="touch-button guides-edit-button"
      data-testid={guideId ? 'edit-page' : 'edit-pages'}
      onClick={() => {
        openPageEditor(guideId);
      }}
    >
      <UiIcon name="pencil" size={18} />
      {label}
    </button>
  );
}

function Page({ game, guide }: { game: LoadedGame; guide: GuideEntry | undefined }) {
  const own = useOwnPages((s) => s.own);
  const [showWiki, setShowWiki] = useState(false);
  if (!guide) return <p className="touch-empty">This page is not in this game any more.</p>;
  const pack = packPage(game, guide.id);
  const change = pageChange(
    pack,
    own.pages.find((p) => p.id === guide.id),
  );
  const shown = showWiki && pack ? pack : guide;
  return (
    <article className="guides-page" data-testid="guides-page" data-guide={guide.id}>
      <div className="guides-page-head">
        <h1 className="guides-title">{shown.title}</h1>
        {/* A page of another game read with this one is changed in that game. */}
        {parseId(guide.id)?.gameId === game.pack.manifest.gameId ? (
          <EditPagesButton label="Edit the page" guideId={guide.id} />
        ) : null}
      </div>
      {change.wikiChanged && pack ? (
        <WikiChanged
          guideId={guide.id}
          showsWiki={change.showsWiki}
          showing={showWiki}
          onShow={setShowWiki}
          onDone={() => {
            setShowWiki(false);
          }}
        />
      ) : null}
      {guide.source && hasMap(game) ? <OnTheMap game={game} guide={guide} /> : null}
      <MarkdownBody source={shown.body} className="guide-body guides-page-body" page />
      {change.changed && !showWiki ? (
        <p className="guides-changed" data-testid="changed-by-you">
          Changed by you. Your changes are kept apart from the wiki’s text.
        </p>
      ) : change.own ? (
        <p className="guides-changed">A page of your own.</p>
      ) : null}
      {guide.source ? <Credit source={guide.source} title={guide.title} /> : null}
    </article>
  );
}

/**
 * The wiki changed a page the person changed: said, with its new version
 * to see, and the choice of keeping theirs or taking the wiki's.
 */
function WikiChanged({
  guideId,
  showsWiki,
  showing,
  onShow,
  onDone,
}: {
  guideId: string;
  showsWiki: boolean;
  showing: boolean;
  onShow: (show: boolean) => void;
  onDone: () => void;
}) {
  const game = useAtlas((s) => s.game);
  const canChange = useOwnPages((s) => canChangeOwnPages(s));
  const [confirm, setConfirm] = useState(false);
  const pack = game ? packPage(game, guideId) : undefined;
  if (!pack) return null;
  return (
    <div className="guides-wiki-changed" role="status" data-testid="wiki-changed">
      <p>
        {showsWiki
          ? 'The wiki changed this page since you changed it, so its new version is shown, as you chose. Your version is kept.'
          : 'The wiki changed this page since you changed it. Your version is shown.'}
      </p>
      <div className="guides-wiki-actions">
        {showsWiki ? null : (
          <button
            type="button"
            className="touch-button"
            data-testid="see-wiki-new"
            onClick={() => {
              onShow(!showing);
            }}
          >
            {showing ? 'Show my version' : 'See the wiki’s new version'}
          </button>
        )}
        <button
          type="button"
          className="touch-button"
          disabled={!canChange}
          data-testid="keep-my-version"
          onClick={() => {
            changeContents(
              (own) => keepOwnVersion(own, pack, new Date()),
              showsWiki ? 'Your version is shown again' : 'Kept your version',
            );
            onDone();
          }}
        >
          {showsWiki ? 'Use my version' : 'Keep my version'}
        </button>
        {showsWiki ? null : (
          <button
            type="button"
            className="touch-button"
            disabled={!canChange}
            data-testid="take-wiki-version"
            onClick={() => {
              setConfirm(true);
            }}
          >
            Take the wiki’s version
          </button>
        )}
      </div>
      {confirm ? (
        <TakeWikiDialog
          onClose={() => {
            setConfirm(false);
          }}
          onTake={() => {
            changeContents(
              (own) => revertPage(own, guideId, new Date()),
              'Took the wiki’s version of the page',
            );
            onDone();
          }}
        />
      ) : null}
    </div>
  );
}

function TakeWikiDialog({ onClose, onTake }: { onClose: () => void; onTake: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="own-dialog own-dialog-small"
      aria-label="Take the wiki’s version?"
      data-testid="take-wiki-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="own-dialog-body">
        <h2 className="own-dialog-title">Take the wiki’s version?</h2>
        <p className="own-dialog-line">
          Your changes to this page’s title and text go, and the wiki’s new version is shown.
        </p>
        <footer className="own-dialog-foot">
          <span className="own-space" />
          <button type="button" className="own-pill-button" autoFocus onClick={onClose}>
            Keep mine
          </button>
          <button
            type="button"
            className="own-pill-button own-pill-danger"
            data-testid="confirm-take-wiki"
            onClick={() => {
              onClose();
              onTake();
            }}
          >
            Take the wiki’s version
          </button>
        </footer>
      </div>
    </dialog>
  );
}

/**
 * What a page is linked to on the map ("On the map: 44 locations"), with
 * "Show on the map"; or, for a page not linked yet, the way to link it.
 */
function OnTheMap({ game, guide }: { game: LoadedGame; guide: GuideEntry }) {
  const choice = useGuideLinks((s) =>
    s.gameId === game.pack.manifest.gameId ? s.links.choices[guide.id] : undefined,
  );
  const targets = linkedTargets(game, choice);
  if (choice?.state !== 'linked' || targets.length === 0) {
    if (choice?.state === 'skipped') return null;
    return (
      <p className="guides-on-map guides-on-map-none" data-testid="guides-on-map">
        Not linked to the map.{' '}
        <button
          type="button"
          className="guides-inline-button"
          onClick={() => {
            openPlace({ kind: 'links' });
          }}
        >
          {LINKS_TITLE}
        </button>
      </p>
    );
  }
  const count = new Set(targets.flatMap((t) => t.locations)).size;
  return (
    <div className="guides-on-map" data-testid="guides-on-map">
      <p className="guides-on-map-text">
        <UiIcon name="pin" size={18} strokeWidth={1.8} />
        <span>
          <strong>On the map: {locationsText(count)}</strong>
          <span className="muted"> · {targets.map(targetText).join(', ')}</span>
        </span>
      </p>
      {count > 0 ? (
        <button
          type="button"
          className="touch-button guides-on-map-button"
          data-testid="show-page-on-map"
          onClick={() => {
            showPageOnMap(game, guide.id, guide.title);
          }}
        >
          <UiIcon name="map" size={18} />
          Show on the map
        </button>
      ) : null}
    </div>
  );
}

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** When a page was read, as a date in words; the text as written when it is not a date. */
function readDate(text: string): string {
  const time = Date.parse(text);
  return Number.isNaN(time) ? text : dateFormat.format(time);
}

/** The credit under a page: the site, its licence, the original page, when it was read. */
function Credit({ source, title }: { source: GuideSource; title: string }) {
  return (
    <footer className="guides-credit" data-testid="guides-credit">
      <p>
        From{' '}
        <a href={source.url} target="_blank" rel="noopener noreferrer">
          “{title}” on {source.site}
        </a>
        , read {readDate(source.readAt)}
        {source.adapted ? ', adapted' : ''}.
      </p>
      <p>
        Licence:{' '}
        {source.license.url ? (
          <a href={source.license.url} target="_blank" rel="noopener noreferrer">
            {source.license.name}
          </a>
        ) : (
          source.license.name
        )}
        {source.credit ? <> · {source.credit}</> : null}
      </p>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Search

function SearchField({ game }: { game: LoadedGame }) {
  const place = useReader(currentPlace);
  const shown = place.kind === 'search' ? place.query : '';
  const [text, setText] = useState(shown);
  const [followed, setFollowed] = useState(shown);
  const input = useRef<HTMLInputElement>(null);
  // Back and Forward change the search shown: the field follows.
  if (followed !== shown) {
    setFollowed(shown);
    setText(shown);
  }
  // The `/` key, in a game with no map.
  const focus = useTouch((s) => s.searchFocus);
  useEffect(() => {
    if (focus > 0) input.current?.focus();
  }, [focus]);
  return (
    <div className="guides-search" role="search">
      <UiIcon name="search" size={18} />
      <input
        ref={input}
        type="search"
        className="guides-search-input"
        placeholder={`Search the pages of ${game.pack.manifest.title}`}
        aria-label="Search the pages"
        data-testid="guides-search"
        value={text}
        onChange={(event) => {
          const query = event.target.value;
          setText(query);
          if (query.trim()) openPlace({ kind: 'search', query });
          else if (currentPlace().kind === 'search') readerBack();
        }}
      />
    </div>
  );
}

function SearchResults({ game, query }: { game: LoadedGame; query: string }) {
  const hits = useMemo(() => guidesOf(game).search.search(query, 100), [game, query]);
  return (
    <div className="guides-results" data-testid="guides-results">
      <h1 className="guides-title">Search</h1>
      <p className="guides-lead" aria-live="polite">
        {hits.length === 0
          ? `No page has “${query.trim()}”.`
          : `${hits.length === 100 ? 'The first 100' : hits.length} page${hits.length === 1 ? '' : 's'} with “${query.trim()}”`}
      </p>
      <ul className="touch-plain-list guides-entries">
        {hits.map((hit) => (
          <li key={hit.guide.id}>
            <button
              type="button"
              className="guides-entry guides-result"
              data-testid="guides-result"
              onClick={() => {
                openPlace({ kind: 'page', guideId: hit.guide.id });
              }}
            >
              <span className="guides-result-title">{hit.guide.title}</span>
              {hit.snippet ? <Snippet hit={hit} /> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A line of the page's text, the query's words marked. */
function Snippet({ hit }: { hit: GuideHit }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  hit.marks.forEach(([start, end], i) => {
    if (start > at) parts.push(hit.snippet.slice(at, start));
    parts.push(<mark key={i}>{hit.snippet.slice(start, end)}</mark>);
    at = end;
  });
  parts.push(hit.snippet.slice(at));
  return <span className="guides-result-line">{parts}</span>;
}
