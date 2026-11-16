import type {
  ContentsEntry,
  ContentsHeading,
  ContentsStep,
  GuideContents,
  GuideHit,
  LandingGroup,
  LandingTile,
} from '@atlas/core';
import type { GuideEntry, GuideSource } from '@atlas/schema';
import { NO_LICENCE_RECORDED, licenseBasisOf, parseId } from '@atlas/schema';
import {
  entryIdOf,
  entryTitleOf,
  findSection,
  headingStepId,
  keepOwnVersion,
  madeLanding,
  pageChange,
  revertPage,
} from '@atlas/core';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { create } from 'zustand';
import { UiIcon } from '../components/icons';
import { MarkdownBody } from '../components/MarkdownBody';
import { guideHeadings } from '../markdown';
import { useGuideLinks } from '../state/guideLinks';
import { canLinkPages, linkedTargets, locationsText, targetText } from '../state/guideMatches';
import { useTitleOf } from '../state/gameGroups';
import { guidesOf, hasMap, pictureOf } from '../state/guides';
import { canChangeOwnPages, changeContents, useOwnPages } from '../state/ownPages';
import { useAtlas, type LoadedGame } from '../state/store';
import { AddToBuildBar, AddToBuildButton } from './AddToBuild';
import { useAddToBuild } from './buildChoice';
import { GuideLinksReview } from './GuideLinksReview';
import { GuidesFromGames, TitleMaps } from './GuidesFromGames';
import { showPageOnMap } from './listViews';
import {
  arrivedAtSection,
  canGoBack,
  canGoForward,
  currentPlace,
  openPlace,
  readerBack,
  readerBackTo,
  readerForward,
  rememberScroll,
  useReader,
  waitsForSection,
  wayCame,
  type OpenedBy,
  type ReaderPlace,
  type WayStep,
} from './reader';
import { openPageEditor, packPage, usePageEditor } from './pages/pageEditorState';
import { useTouch } from './state';
import '../styles/guides.css';
import '../styles/landing.css';

/**
 * Guides: a game's guides read as pages, as a wiki is read. The contents
 * (sections that hold sections and pages, in the source's order), each
 * page with its credit, links between pages that stay in the app, Back
 * and Forward that return to where each place was scrolled to, and a
 * search over the pages' titles and text.
 *
 * Wide, the contents stay beside the page, a tree open to the page shown;
 * compact (a phone), the contents are a place of their own, as the pages
 * are, and a page lists the pages under it at its foot. Above the page,
 * the way to it: every section and page it is under, each a link; or,
 * when the reader walked to it from page to page, the way they came.
 *
 * A page with a few headings lists them at its top, "On this page", each
 * a link to its section; a link to a section of a page opens the page
 * there (see `reader.ts`).
 *
 * The guides open on a landing page, named after the game: the wiki's own
 * home page when the pack has one (`homePage`), else one made from the top
 * of the contents, its sections as groups of tiles. The game's name leads
 * back to it from the top of the contents and the start of the way above
 * every page. "Contents" names only the list a phone opens from its button.
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
            <TreeHome game={game} />
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

  // Each place opens where it was scrolled to when it was left; a page
  // opened at a section, at that section's heading (its top when no
  // heading fits).
  const scroll = reader.visits[reader.at]?.scroll ?? 0;
  const toSection = waitsForSection(reader);
  useLayoutEffect(() => {
    const root = body.current;
    if (!root) return;
    if (toSection) {
      const heading =
        place.kind === 'page' && place.section ? headingOf(root, place.section) : null;
      root.scrollTop = heading ? offsetIn(root, heading) - SECTION_MARGIN : 0;
      if (heading) {
        // Read on from the heading, also with the keyboard.
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
      arrivedAtSection(root.scrollTop);
      return;
    }
    root.scrollTop = scroll;
    // Only when the place changes, not while it is scrolled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader.at, reader.visits.length, place, toSection]);

  const frame = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      if (body.current) rememberScroll(body.current.scrollTop);
    });
  };

  const name = useGameName(game);
  const atHome = isLanding(game, place);
  const title = placeTitle(game, place, name);
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
        <Breadcrumbs game={game} place={place} name={name} way={wayCame(reader)} />
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
          {!wide &&
          (atHome || place.kind === 'search' || (place.kind === 'contents' && !place.sectionId)) ? (
            <SearchField game={game} />
          ) : null}
          {atHome ? (
            <Landing game={game} wide={wide} name={name} />
          ) : place.kind === 'page' ? (
            <Page game={game} guide={contents.guide(place.guideId)} wide={wide} />
          ) : place.kind === 'links' ? (
            <GuideLinksReview game={game} />
          ) : place.kind === 'search' ? (
            <SearchResults game={game} query={place.query} />
          ) : (
            <ContentsPlace
              game={game}
              sectionId={place.kind === 'contents' ? place.sectionId : null}
              name={name}
            />
          )}
        </div>
      </div>
    </section>
  );
}

const LINKS_TITLE = 'Link pages to the map';

/** The room left above a heading scrolled to. */
const SECTION_MARGIN = 12;

/** The heading of the page shown that a section names, or null when none fits or it is hidden. */
function headingOf(root: HTMLElement, section: string): HTMLElement | null {
  const headings = [
    ...root.querySelectorAll<HTMLElement>('.guides-page-body [data-section]'),
  ].filter((heading) => /^H[1-6]$/u.test(heading.tagName));
  const index = findSection(
    section,
    headings.map((heading) => heading.dataset.section ?? ''),
  );
  const heading = index >= 0 ? headings[index]! : null;
  return heading && !heading.closest('[hidden]') ? heading : null;
}

/** How far down a scrolled element an element inside it stands. */
function offsetIn(root: HTMLElement, element: HTMLElement): number {
  return element.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
}

/**
 * The name the guides of a game go by: the title it is shown under with
 * other games (see `gameGroups.ts`), else its own.
 */
function useGameName(game: LoadedGame): string {
  const group = useTitleOf(game.pack.manifest.gameId);
  return group?.title ?? game.pack.manifest.title;
}

/** Whether a place is the landing page: itself, or the home page opened by a link. */
function isLanding(game: LoadedGame, place: ReaderPlace): boolean {
  return (
    place.kind === 'home' ||
    (place.kind === 'page' && guidesOf(game).contents.isHomePage(place.guideId))
  );
}

function placeTitle(game: LoadedGame, place: ReaderPlace, name: string): string {
  const { contents } = guidesOf(game);
  if (isLanding(game, place)) return name;
  switch (place.kind) {
    case 'home':
      return name;
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

/**
 * Where the place is in the contents: the game's name (the landing page) ›
 * Section › Page › … › the place itself. The game's name opens the
 * landing page, a section its contents, a page the page.
 *
 * A page the reader walked to from page to page (see `reader.ts`) shows
 * the way they came instead: the game's name, the contents path of the
 * page the walk started on (none when it started on the landing page),
 * each page walked, and the page itself. A page walked through goes back
 * to it, as Back pressed that many times would. When a page on the way is
 * also on the contents path of the page it started on, the contents path
 * is left out, so no page is named twice.
 */
function Breadcrumbs({
  game,
  place,
  name,
  way,
}: {
  game: LoadedGame;
  place: ReaderPlace;
  name: string;
  way: readonly WayStep[];
}) {
  const { contents } = guidesOf(game);
  const line = useRef<HTMLElement>(null);
  const atHome = isLanding(game, place);
  // The pages walked, from the page the walk started on; none from the landing page.
  const walked =
    atHome || place.kind !== 'page'
      ? []
      : way.flatMap((step) =>
          step.place.kind === 'page' && !isLanding(game, step.place)
            ? [{ at: step.at, guideId: step.place.guideId }]
            : [],
        );
  const startedOn = way[0]?.place;
  const fromPage = walked.length > 0 && startedOn?.kind === 'page' && walked[0]!.at === way[0]!.at;
  let path: ContentsStep[] = atHome
    ? []
    : place.kind === 'page'
      ? contents.trail(fromPage ? walked[0]!.guideId : place.guideId)
      : place.kind === 'contents' && place.sectionId
        ? contents.trail(place.sectionId)
        : [];
  if (way.length > 0 && place.kind === 'page') {
    if (!fromPage) path = [];
    const named = new Set([place.guideId, ...walked.map((step) => step.guideId)]);
    if (path.some((step) => step.kind === 'page' && named.has(step.guide.id))) path = [];
  }
  const here = atHome
    ? null
    : place.kind === 'search'
      ? 'Search'
      : place.kind === 'links'
        ? LINKS_TITLE
        : place.kind === 'page'
          ? (contents.guide(place.guideId)?.title ?? null)
          : place.kind === 'contents' && place.sectionId
            ? (contents.section(place.sectionId)?.title ?? null)
            : place.kind === 'contents'
              ? // The list a phone opens from its "Contents" button.
                'Contents'
              : null;
  // A long way scrolls sideways, its end (the place itself) in view.
  useLayoutEffect(() => {
    const element = line.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [place, path.length, walked.length]);
  const separator = (
    <span className="guides-crumb-sep" aria-hidden="true">
      ›
    </span>
  );
  return (
    <nav ref={line} className="guides-crumbs" aria-label="Where this is">
      {atHome ? (
        <span
          className="guides-crumb guides-crumb-here"
          aria-current="page"
          data-testid="guides-crumb-game"
        >
          {name}
        </span>
      ) : (
        <button
          type="button"
          className="guides-crumb"
          data-testid="guides-crumb-game"
          onClick={() => {
            openPlace({ kind: 'home' });
          }}
        >
          {name}
        </button>
      )}
      {path.map((step) => (
        <span key={entryIdOf(step)} className="guides-crumb-part">
          {separator}
          <button
            type="button"
            className="guides-crumb"
            data-testid="guides-crumb"
            data-kind={step.kind}
            onClick={() => {
              openPlace(placeOf(step));
            }}
          >
            {entryTitleOf(step)}
          </button>
        </span>
      ))}
      {walked.length > 0 ? (
        <span
          className="guides-crumb-way"
          role="group"
          aria-label="The way you came"
          title="The way you came"
          data-testid="guides-crumb-way"
        >
          {walked.map((step) => (
            <span key={step.at} className="guides-crumb-part">
              {separator}
              <button
                type="button"
                className="guides-crumb guides-crumb-walked"
                data-testid="guides-crumb-walked"
                onClick={() => {
                  readerBackTo(step.at);
                }}
              >
                {contents.guide(step.guideId)?.title ?? 'Page'}
              </button>
            </span>
          ))}
        </span>
      ) : null}
      {here ? (
        <span className="guides-crumb-part">
          {separator}
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

/**
 * A section's contents; or, with none, the top of the contents as a list,
 * headed with the game's name: what a phone opens from its "Contents"
 * button, the home page first when there is one.
 */
function ContentsPlace({
  game,
  sectionId,
  name,
}: {
  game: LoadedGame;
  sectionId: string | null;
  name: string;
}) {
  const { contents } = guidesOf(game);
  const section = sectionId ? contents.section(sectionId) : undefined;
  const entries = section ? contents.items(section.id) : contents.top();
  const home = section ? null : contents.homePage();
  return (
    <div className="guides-contents" data-testid="guides-contents">
      <h1 className="guides-title">{section ? section.title : name}</h1>
      {!section ? <EditPagesButton label="Edit the pages" guideId={null} /> : null}
      {home ? (
        <ul className="touch-plain-list guides-entries guides-entries-home">
          <li>
            <button
              type="button"
              className="guides-entry guides-entry-home"
              data-testid="guides-home-link"
              onClick={() => {
                openPlace({ kind: 'home' });
              }}
            >
              <UiIcon name="home" size={20} />
              <span className="guides-entry-name">Home page</span>
              <UiIcon name="chevron" size={16} />
            </button>
          </li>
        </ul>
      ) : null}
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
      <EntryList contents={contents} entries={entries} />
      {!section && hasMap(game) ? <GuidesFromGames game={game} /> : null}
      {!section && !hasMap(game) ? <TitleMaps game={game} /> : null}
    </div>
  );
}

/** How many entries of one list are shown at first, and how many more each press shows. */
const ROWS_AT_ONCE = 200;

/** A button under a long list that shows its next rows. */
function MoreRows({
  left,
  onMore,
  className,
}: {
  left: number;
  onMore: () => void;
  className: string;
}) {
  if (left <= 0) return null;
  return (
    <li>
      <button type="button" className={className} data-testid="guides-more-rows" onClick={onMore}>
        {left > ROWS_AT_ONCE
          ? `Show ${ROWS_AT_ONCE} more of ${left.toLocaleString('en')}`
          : `Show the other ${left === 1 ? 'one' : left.toLocaleString('en')}`}
      </button>
    </li>
  );
}

/**
 * A list of sections and pages. `by` says how a page is opened from it:
 * walked to from the page shown (the pages under it), or afresh (the
 * contents).
 */
function EntryList({
  contents,
  entries,
  by = 'fresh',
}: {
  contents: GuideContents;
  entries: readonly ContentsEntry[];
  by?: OpenedBy;
}) {
  const [count, setCount] = useState(ROWS_AT_ONCE);
  return (
    <ul className="touch-plain-list guides-entries">
      {entries.slice(0, count).map((entry) =>
        entry.kind === 'heading' ? (
          // A heading of a list page: its words, which open the page there, over what it holds.
          <li key={entry.heading.id} className="guides-entry-group">
            <button
              type="button"
              className="guides-entry guides-entry-heading"
              data-testid="guides-heading-link"
              onClick={() => {
                openPlace(placeOf(entry), by);
              }}
            >
              <UiIcon name="heading" size={20} />
              <span className="guides-entry-name">{entry.heading.title}</span>
              <span className="touch-figure">{pagesText(entry.pages)}</span>
            </button>
            <EntryList contents={contents} entries={contents.items(entry.heading.id)} by={by} />
          </li>
        ) : entry.kind === 'section' ? (
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
              <span className="touch-figure">{pagesText(entry.pages)}</span>
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
                openPlace({ kind: 'page', guideId: entry.guide.id }, by);
              }}
            >
              <UiIcon name="book" size={20} />
              <span className="guides-entry-name">{entry.guide.title}</span>
              {entry.pages > 0 ? (
                <span className="touch-figure">{`${pagesText(entry.pages)} under it`}</span>
              ) : null}
            </button>
          </li>
        ),
      )}
      <MoreRows
        left={entries.length - count}
        className="guides-entry guides-more"
        onMore={() => {
          setCount(count + ROWS_AT_ONCE);
        }}
      />
    </ul>
  );
}

const pagesText = (count: number) =>
  count === 1 ? '1 page' : `${count.toLocaleString('en')} pages`;

/**
 * Where an entry or a step of the contents opens: a section its contents,
 * a page the page, a heading of a list page that page at the heading.
 */
function placeOf(entry: ContentsEntry | ContentsStep): ReaderPlace {
  if (entry.kind === 'section') return { kind: 'contents', sectionId: entry.section.id };
  if (entry.kind === 'heading') {
    return { kind: 'page', guideId: entry.heading.guide.id, section: entry.heading.section };
  }
  return { kind: 'page', guideId: entry.guide.id };
}

/** The heading of a list page shown as a level that a place is at, if any. */
function headingAt(contents: GuideContents, place: ReaderPlace): ContentsHeading | undefined {
  if (place.kind !== 'page' || !place.section) return undefined;
  return contents.heading(headingStepId(place.guideId, place.section));
}

/**
 * The contents beside the page (wide): a tree open to the place shown,
 * with the entries around it. A section opens its contents when pressed;
 * a page opens the page, and a page with pages under it has a button of
 * its own to show or hide them. The way to a new place opens again.
 */
function ContentsTree({ game }: { game: LoadedGame }) {
  const place = useReader(currentPlace);
  const { contents } = guidesOf(game);
  const root = useRef<HTMLDivElement>(null);
  const onPath = useMemo(() => {
    const ids = new Set<string>();
    // A list page opened at a heading shown as a level: the way to that level.
    const id =
      place.kind === 'page'
        ? (headingAt(contents, place)?.id ?? place.guideId)
        : place.kind === 'contents'
          ? place.sectionId
          : null;
    if (id) {
      for (const step of contents.trail(id)) ids.add(entryIdOf(step));
      ids.add(id);
    }
    return ids;
  }, [contents, place]);
  // What the person folded or unfolded; the way to a new place opens again.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [followed, setFollowed] = useState(onPath);
  if (followed !== onPath) {
    setFollowed(onPath);
    setToggled(new Map([...toggled].filter(([id]) => !onPath.has(id))));
  }
  const tree: TreeState = {
    game,
    place,
    onPath,
    isOpen: (id) => toggled.get(id) ?? onPath.has(id),
    toggle: (id, open) => {
      setToggled(new Map(toggled).set(id, open));
    },
  };
  // The place shown is in view.
  useEffect(() => {
    root.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [onPath]);
  return (
    <div ref={root}>
      <TreeLevel tree={tree} entries={contents.top()} depth={0} />
    </div>
  );
}

/** At the top of the contents beside the page: the game's name, which opens the landing page. */
function TreeHome({ game }: { game: LoadedGame }) {
  const place = useReader(currentPlace);
  const name = useGameName(game);
  const here = isLanding(game, place);
  return (
    <button
      type="button"
      className="guides-tree-row guides-tree-home"
      aria-current={here ? 'page' : undefined}
      data-testid="guides-tree-home"
      onClick={() => {
        openPlace({ kind: 'home' });
      }}
    >
      <UiIcon name="home" size={16} />
      <span>{name}</span>
    </button>
  );
}

interface TreeState {
  game: LoadedGame;
  place: ReaderPlace;
  /** The sections and pages on the way to the place shown, and the place. */
  onPath: ReadonlySet<string>;
  isOpen: (id: string) => boolean;
  toggle: (id: string, open: boolean) => void;
}

function TreeLevel({
  tree,
  entries,
  depth,
  id,
}: {
  tree: TreeState;
  entries: readonly ContentsEntry[];
  depth: number;
  id?: string;
}) {
  const { contents } = guidesOf(tree.game);
  const [count, setCount] = useState(ROWS_AT_ONCE);
  // Long lists show their rows a few hundred at a time, always as far as the way to the place shown.
  const onWay = entries.findIndex((entry) => tree.onPath.has(entryIdOf(entry)));
  const shown = Math.max(count, Math.ceil((onWay + 1) / ROWS_AT_ONCE) * ROWS_AT_ONCE);
  const indent = (extra: number) => ({ paddingLeft: extra + depth * 14 });
  return (
    <ul id={id} className="touch-plain-list guides-tree-level">
      {entries.slice(0, shown).map((entry) => {
        if (entry.kind !== 'section') {
          return <TreePage key={entryIdOf(entry)} tree={tree} entry={entry} depth={depth} />;
        }
        const sectionId = entry.section.id;
        const expanded = tree.isOpen(sectionId);
        const current = tree.place.kind === 'contents' && tree.place.sectionId === sectionId;
        return (
          <li key={sectionId}>
            <button
              type="button"
              className="guides-tree-row guides-tree-section"
              style={indent(4)}
              aria-expanded={expanded}
              aria-current={current ? 'page' : undefined}
              onClick={() => {
                openPlace({ kind: 'contents', sectionId });
              }}
            >
              <UiIcon name={expanded ? 'chevronDown' : 'chevron'} size={14} strokeWidth={2} />
              {entry.section.title}
            </button>
            {expanded ? (
              <TreeLevel tree={tree} entries={contents.items(sectionId)} depth={depth + 1} />
            ) : null}
          </li>
        );
      })}
      <MoreRows
        left={entries.length - shown}
        className="guides-tree-row guides-tree-more"
        onMore={() => {
          setCount(shown + ROWS_AT_ONCE);
        }}
      />
    </ul>
  );
}

/**
 * A page in the tree, or a heading of a list page shown as a level (which
 * opens that page at the heading); one with pages under it can show or
 * hide them.
 */
function TreePage({
  tree,
  entry,
  depth,
}: {
  tree: TreeState;
  entry: Exclude<ContentsEntry, { kind: 'section' }>;
  depth: number;
}) {
  const { contents } = guidesOf(tree.game);
  const listId = useId();
  const id = entryIdOf(entry);
  const heading = entry.kind === 'heading';
  const at = headingAt(contents, tree.place);
  const current = heading
    ? at?.id === id
    : tree.place.kind === 'page' && tree.place.guideId === id && !at;
  const holds = entry.pages > 0 && contents.itemCount(id) > 0;
  const open = holds && tree.isOpen(id);
  const title = entryTitleOf(entry);
  return (
    <li>
      <div className="guides-tree-page" style={{ paddingLeft: depth * 14 }}>
        {holds ? (
          <button
            type="button"
            className="guides-tree-toggle"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-label={
              open ? `Hide the pages under “${title}”` : `Show the pages under “${title}”`
            }
            title={open ? 'Hide the pages under it' : 'Show the pages under it'}
            data-testid="guides-tree-toggle"
            onClick={() => {
              tree.toggle(id, !open);
            }}
          >
            <UiIcon name={open ? 'chevronDown' : 'chevron'} size={14} strokeWidth={2} />
          </button>
        ) : (
          <span className="guides-tree-spacer" aria-hidden="true" />
        )}
        <button
          type="button"
          className={`guides-tree-row guides-tree-page-name${heading ? ' guides-tree-heading' : ''}`}
          aria-current={current ? 'page' : undefined}
          data-testid={heading ? 'guides-tree-heading' : 'guides-tree-page'}
          onClick={() => {
            if (holds) tree.toggle(id, true);
            openPlace(placeOf(entry));
          }}
        >
          {title}
        </button>
      </div>
      {open ? (
        <TreeLevel tree={tree} entries={contents.items(id)} depth={depth + 1} id={listId} />
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The landing page

/**
 * The landing page: the wiki's own home page, read as any page and
 * editable as one; or, for guides with no home page, one made from the
 * top of the contents (see `landing.ts` in the core package), which is no
 * stored page. Below either, what the top of the contents offers: linking
 * the pages to the map, and guides of other games.
 */
function Landing({ game, wide, name }: { game: LoadedGame; wide: boolean; name: string }) {
  const { contents } = guidesOf(game);
  const home = contents.homePage();
  if (!home) return <MadeLanding game={game} name={name} />;
  return (
    <div className="guides-landing" data-testid="guides-home" data-landing="page">
      <Page game={game} guide={home} wide={wide} home={name} />
      <LandingFoot game={game} />
    </div>
  );
}

/** Under the landing page: linking the pages to the map, and guides of other games. */
function LandingFoot({ game }: { game: LoadedGame }) {
  return (
    <>
      {canLinkPages(game) ? (
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
      {hasMap(game) ? <GuidesFromGames game={game} /> : <TitleMaps game={game} />}
    </>
  );
}

/** The landing page made from the top of the contents: each section a group of tiles. */
function MadeLanding({ game, name }: { game: LoadedGame; name: string }) {
  const { contents } = guidesOf(game);
  const groups = useMemo(() => madeLanding(contents), [contents]);
  const pages = contents.pages();
  // Pages read from a site whose own home page was not kept with them.
  const fromSite = pages.some((page) => page.source !== undefined);
  return (
    <div
      className="guides-landing guides-landing-made"
      data-testid="guides-home"
      data-landing="made"
    >
      <h1 className="guides-title">{name}</h1>
      <p className="guides-lead">{pagesText(pages.length)}</p>
      <EditPagesButton label="Edit the pages" guideId={null} />
      {groups.length === 0 ? <p className="touch-empty">Nothing here yet.</p> : null}
      {groups.map((group, index) => (
        <LandingGroupView
          key={group.section?.id ?? `pages-${index}`}
          game={game}
          group={group}
          name={name}
        />
      ))}
      {fromSite ? (
        <p className="guides-landing-note" data-testid="guides-landing-note">
          The site’s own home page has not been read, so this page is made from the contents. Read
          the home page, and it is shown here.
        </p>
      ) : null}
      <LandingFoot game={game} />
    </div>
  );
}

/** A section of the made landing page and its tiles; or the pages at the top of the contents. */
function LandingGroupView({
  game,
  group,
  name,
}: {
  game: LoadedGame;
  group: LandingGroup;
  name: string;
}) {
  const { section } = group;
  const withPictures = group.tiles.some((tile) => tile.picture !== null);
  const openGroup = () => {
    openPlace(
      section ? { kind: 'contents', sectionId: section.id } : { kind: 'contents', sectionId: null },
    );
  };
  return (
    <section
      className="guides-landing-group"
      aria-label={section ? section.title : `Pages of ${name}`}
      data-testid="guides-landing-group"
    >
      {section ? (
        <h2 className="guides-landing-heading">
          <button
            type="button"
            className="guides-landing-section"
            data-testid="guides-landing-section"
            onClick={openGroup}
          >
            <span>{section.title}</span>
            <UiIcon name="chevron" size={16} strokeWidth={2} />
          </button>
          <span className="touch-figure">{pagesText(group.pages)}</span>
        </h2>
      ) : null}
      <ul
        className={`touch-plain-list guides-tiles${withPictures ? ' guides-tiles-pictures' : ''}`}
      >
        {group.tiles.map((tile) => (
          <li key={entryIdOf(tile.entry)}>
            <Tile game={game} tile={tile} withPicture={withPictures} />
          </li>
        ))}
      </ul>
      {group.more > 0 ? (
        <button
          type="button"
          className="guides-inline-button guides-landing-more"
          data-testid="guides-landing-more"
          onClick={openGroup}
        >
          {section
            ? `All ${(group.tiles.length + group.more).toLocaleString('en')} in “${section.title}”`
            : `and ${group.more.toLocaleString('en')} more`}
        </button>
      ) : null}
    </section>
  );
}

/** A section or a page on the made landing page: its picture, when a group has pictures, and its name. */
function Tile({
  game,
  tile,
  withPicture,
}: {
  game: LoadedGame;
  tile: LandingTile;
  withPicture: boolean;
}) {
  const { entry } = tile;
  // A section, or a heading of a list page: a group of pages.
  const section = entry.kind !== 'page';
  const title = entryTitleOf(entry);
  const count = section
    ? pagesText(entry.pages)
    : entry.pages > 0
      ? `${pagesText(entry.pages)} under it`
      : null;
  return (
    <button
      type="button"
      className="guides-tile"
      data-testid="guides-tile"
      data-kind={entry.kind}
      onClick={() => {
        openPlace(placeOf(entry), 'walk');
      }}
    >
      {withPicture ? (
        <TilePicture game={game} id={tile.picture} icon={section ? 'folder' : 'book'} />
      ) : null}
      <span className="guides-tile-name">
        {withPicture ? null : <UiIcon name={section ? 'folder' : 'book'} size={18} />}
        <span>{title}</span>
      </span>
      {count ? <span className="touch-figure guides-tile-count">{count}</span> : null}
    </button>
  );
}

/** A tile's picture, or its icon where it has none or its file cannot be shown. */
function TilePicture({
  game,
  id,
  icon,
}: {
  game: LoadedGame;
  id: string | null;
  icon: 'folder' | 'book';
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const picture = id ? pictureOf(game, id) : null;
  if (!picture || failed === picture.url) {
    return (
      <span className="guides-tile-picture guides-tile-none" aria-hidden="true">
        <UiIcon name={icon} size={28} />
      </span>
    );
  }
  return (
    <span className="guides-tile-picture">
      <img
        src={picture.url}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => {
          setFailed(picture.url);
        }}
      />
    </span>
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

function Page({
  game,
  guide,
  wide,
  home,
}: {
  game: LoadedGame;
  guide: GuideEntry | undefined;
  wide: boolean;
  /**
   * The game's name, for the home page shown as the landing page: its
   * heading, with nothing of a page in the contents (the way to the map,
   * building, the pages under it, what else links to it).
   */
  home?: string;
}) {
  const own = useOwnPages((s) => s.own);
  const [showWiki, setShowWiki] = useState(false);
  const build = useAddToBuild(game);
  if (!guide) return <p className="touch-empty">This page is not in this game any more.</p>;
  const pack = packPage(game, guide.id);
  const change = pageChange(
    pack,
    own.pages.find((p) => p.id === guide.id),
  );
  const shown = showWiki && pack ? pack : guide;
  return (
    <article
      className="guides-page"
      data-testid="guides-page"
      data-guide={guide.id}
      data-home={home !== undefined ? 'true' : undefined}
    >
      <div className="guides-page-head">
        <h1 className="guides-title">{home ?? shown.title}</h1>
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
      {home === undefined ? (
        <AddToBuildBar build={build} thing={{ name: guide.title, guideId: guide.id }} />
      ) : null}
      {guide.source && hasMap(game) && home === undefined ? (
        <OnTheMap game={game} guide={guide} />
      ) : null}
      <OnThisPage guideId={guide.id} body={shown.body} wide={wide} />
      <MarkdownBody
        source={shown.body}
        className="guide-body guides-page-body"
        page
        onAddRow={
          build.offered
            ? (row, button) => {
                build.add(row, button);
              }
            : undefined
        }
      />
      {build.dialog}
      {change.changed && !showWiki ? (
        <p className="guides-changed" data-testid="changed-by-you">
          Changed by you. Your changes are kept apart from the wiki’s text.
        </p>
      ) : change.own ? (
        <p className="guides-changed">A page of your own.</p>
      ) : null}
      {wide || home !== undefined ? null : <PagesUnder game={game} guideId={guide.id} />}
      {home === undefined ? <AlsoLinkedFrom key={guide.id} game={game} guideId={guide.id} /> : null}
      {guide.source ? <Credit source={guide.source} title={guide.title} /> : null}
    </article>
  );
}

/** A page lists its headings when it has at least this many shown. */
export const ON_THIS_PAGE_FROM = 3;

/** How far in a heading is listed under the one above it, at most. */
const MOST_INDENT = 3;

/**
 * Whether "On this page" is open, as the person last chose for the layout
 * while the app is open: at first open beside the contents (wide) and
 * folded on a phone, where it would push the page down.
 */
const useOnThisPage = create<{ wide: boolean | null; compact: boolean | null }>()(() => ({
  wide: null,
  compact: null,
}));

/**
 * "On this page": the page's headings, sub-headings in under their
 * heading, each a link to its section, in place of a wiki's own box of
 * contents. On a page with {@link ON_THIS_PAGE_FROM} headings or more;
 * headings inside hidden text are left out until it is shown.
 */
function OnThisPage({ guideId, body, wide }: { guideId: string; body: string; wide: boolean }) {
  const listId = useId();
  const layout = wide ? 'wide' : 'compact';
  const chosen = useOnThisPage((s) => s[layout]);
  const open = chosen ?? wide;
  const headings = useMemo(
    () => guideHeadings(body).filter((heading) => !heading.hidden && heading.words !== ''),
    [body],
  );
  if (headings.length < ON_THIS_PAGE_FROM) return null;
  const top = Math.min(...headings.map((heading) => heading.level));
  return (
    <nav className="guides-toc" aria-label="On this page" data-testid="on-this-page">
      <button
        type="button"
        className="guides-toc-toggle"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        data-testid="on-this-page-toggle"
        onClick={() => {
          useOnThisPage.setState({ [layout]: !open });
        }}
      >
        <UiIcon name={open ? 'chevronDown' : 'chevron'} size={14} strokeWidth={2} />
        <span className="guides-toc-title">On this page</span>
        <span className="touch-figure">{headings.length}</span>
      </button>
      {open ? (
        <ul id={listId} className="touch-plain-list guides-toc-list">
          {headings.map((heading) => (
            <li key={heading.name}>
              <button
                type="button"
                className="guides-tree-row guides-toc-row"
                style={{ paddingLeft: 10 + Math.min(heading.level - top, MOST_INDENT) * 14 }}
                data-testid="on-this-page-entry"
                data-target-section={heading.name}
                onClick={() => {
                  openPlace({ kind: 'page', guideId, section: heading.name });
                }}
              >
                {heading.words}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </nav>
  );
}

/** On a phone, where the contents is not beside the page: the pages under this one. */
function PagesUnder({ game, guideId }: { game: LoadedGame; guideId: string }) {
  const { contents } = guidesOf(game);
  const entries = contents.items(guideId);
  if (entries.length === 0) return null;
  return (
    <section className="guides-under" aria-label="Pages under this page" data-testid="pages-under">
      <h2 className="guides-under-title">Pages under this page</h2>
      <EntryList key={guideId} contents={contents} entries={entries} by="walk" />
    </section>
  );
}

/** How many pages "Also linked from" names before "and n more". */
const LINKED_FROM_SHOWN = 12;

/**
 * The other pages that link to this one, but the page it is under (which
 * the way above the page shows): a page linked from many has one home in
 * the contents, and these.
 */
function AlsoLinkedFrom({ game, guideId }: { game: LoadedGame; guideId: string }) {
  const { contents } = guidesOf(game);
  const from = useMemo(() => contents.linkedFrom(guideId), [contents, guideId]);
  const [count, setCount] = useState(LINKED_FROM_SHOWN);
  if (from.length === 0) return null;
  const left = from.length - count;
  return (
    <nav className="guides-also" aria-label="Also linked from" data-testid="also-linked-from">
      <h2 className="guides-also-title">Also linked from</h2>
      <ul className="touch-plain-list guides-also-list">
        {from.slice(0, count).map((page) => (
          <li key={page.id}>
            <button
              type="button"
              className="guides-inline-button"
              data-testid="also-linked-page"
              onClick={() => {
                openPlace({ kind: 'page', guideId: page.id }, 'walk');
              }}
            >
              {page.title}
            </button>
          </li>
        ))}
        {left > 0 ? (
          <li>
            <button
              type="button"
              className="guides-inline-button guides-also-more"
              data-testid="also-linked-more"
              onClick={() => {
                setCount(count + ROWS_AT_ONCE);
              }}
            >
              {`and ${left.toLocaleString('en')} more`}
            </button>
          </li>
        ) : null}
      </ul>
    </nav>
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

/**
 * The credit under a page: the site, its licence, the original page, when
 * it was read. A licence the person filled in shows their words, linked to
 * its terms when they gave the address, with who gave it, when and their
 * note; a page with no licence recorded says so.
 */
function Credit({ source, title }: { source: GuideSource; title: string }) {
  const basis = licenseBasisOf(source);
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
      <p data-testid="guides-licence" data-basis={basis}>
        {basis === 'none' ? (
          NO_LICENCE_RECORDED
        ) : (
          <>
            Licence:{' '}
            {source.license.url ? (
              <a href={source.license.url} target="_blank" rel="noopener noreferrer">
                {source.license.name}
              </a>
            ) : (
              source.license.name
            )}
            {basis === 'confirmed' ? ' (confirmed by you: the page states no licence)' : ''}
            {basis === 'permission' ? ' (filled in by you: the page states no licence)' : ''}
            {source.licenseGivenBy ? `, given by ${source.licenseGivenBy}` : ''}
            {source.licenseGivenOn ? ` on ${readDate(source.licenseGivenOn)}` : ''}
          </>
        )}
        {source.credit ? <> · {source.credit}</> : null}
      </p>
      {source.licenseNote ? (
        <p data-testid="guides-licence-note">Note: {source.licenseNote}</p>
      ) : null}
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
          <li key={hit.guide.id} className="guides-result-row" data-testid="guides-result-row">
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
            <AddToBuildButton
              game={game}
              thing={{ name: hit.guide.title, guideId: hit.guide.id }}
              small
            />
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
