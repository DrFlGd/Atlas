import type {
  ContentsEntry,
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
  keepOwnVersion,
  madeLanding,
  pageChange,
  pagesAToZ,
  revertPage,
  routeTypeName,
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
  type RefObject,
} from 'react';
import { create } from 'zustand';
import { UiIcon } from '../components/icons';
import { MarkdownBody } from '../components/MarkdownBody';
import { guideHeadings } from '../markdown';
import { useGuideLinks } from '../state/guideLinks';
import { canLinkPages, linkedTargets, locationsText, targetText } from '../state/guideMatches';
import { guidesOf, hasGuidePages, hasMap, pictureOf } from '../state/guides';
import { useGameGuidebooks, useGuidebookHits } from '../state/guidebooks';
import { GuidebookList, GuidebookResults, GuidebooksAlone } from '../guidebook/Guidebooks';
import {
  isSourceHome,
  madeLandingOf,
  menuWayIn,
  pathIn,
  readingOrder,
  sourceOfEntry,
  sourcePages,
} from '../state/guideSources';
import { canChangeOwnPages, changeContents, pageWidthOf, useOwnPages } from '../state/ownPages';
import { useAtlas, type LoadedGame } from '../state/store';
import { AddToBuildBar, AddToBuildButton } from './AddToBuild';
import { useAddToBuild } from './buildChoice';
import { GuideLinksReview } from './GuideLinksReview';
import { BAR_KEY, setGuidesBarOpen, useGuidesBar } from './guidesBar';
import { GuidesFromGames, TitleMaps } from './GuidesFromGames';
import { ContinueReading, PreviousNext, SourceSwitcher } from './GuideSources';
import { typingOrDialog, withKey } from './keys';
import { PageWidthMenu } from './PageWidthMenu';
import { showPageOnMap } from './listViews';
import {
  arrivedAtSection,
  canGoBack,
  canGoForward,
  currentMenuWay,
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
import { sequenceOf, useFollowSource, useSourceView, type SourceView } from './sourceView';
import { showSection, useKeyHints, useTouch } from './state';
import { openRoute, useGameRoutes } from '../state/routes';
import '../styles/guides.css';
import '../styles/landing.css';

/**
 * Guides: a game's guides read as pages, as a wiki is read. The contents
 * (sections that hold sections and pages, in the source's order), each
 * page with its credit, links between pages that stay in the app, Back
 * and Forward that return to where each place was scrolled to, and a
 * search over the pages' titles and text.
 *
 * Wide, the bar stays beside the page: the source's own menu (its pack's
 * sections, and what the person placed by hand), a tree open to the page
 * shown, with "All pages" at its foot; compact (a phone), the menu is a
 * place of its own, as the pages are, and a page lists the pages put
 * under it by hand at its foot. The app never files a page under another
 * by reading pages: a page the source's menu does not name is outside the
 * menu, and "All pages" (every page of the source, from A to Z) is the way
 * to it. A source with nothing for the bar has none: the page takes the
 * width, the head of the reader holds the search, the switcher of sources
 * and "All pages", and a phone's "Contents" button opens "All pages".
 *
 * The person can fold the bar away, from the button at its top or the key
 * B, and bring it back from the button beside "Home" (see `guidesBar.ts`):
 * folded, the page takes the width as with no menu, and nothing of the bar
 * is lost (the tree as it was unfolded, the listing the place shown is at).
 *
 * Above the page, the way to it: for a page in the menu, every section and
 * page it is under, each a link; for a page outside it, the pages the
 * source files it under (`filedUnder`), when it says; or, when the reader
 * walked to it from page to page, the way they came. Beside Back and
 * Forward, "Home" (and the key H) opens the landing page.
 *
 * A page with a few headings lists them at its top, "On this page", each
 * a link to its section; a link to a section of a page opens the page
 * there (see `reader.ts`).
 *
 * The guides open on a landing page, named after the game: the wiki's own
 * home page when the pack has one (`homePage`), else one made from the top
 * of the contents, its sections as groups of tiles. The game's name leads
 * back to it from the top of the bar and the start of the way above every
 * page. "Contents" names only the list a phone opens from its button. With
 * no home page and no menu, the landing page is "All pages".
 *
 * A game's pages may come from several sources (its own, and other games
 * read with it, see `GuideSources.tsx`): a switcher at the top chooses the
 * one whose contents, landing page and way above a page are shown. Search
 * looks in all of them, and a link opens a page of any of them.
 */
const PageEditor = lazy(() => import('./pages/PageEditor'));

export function GuidesScreen({ wide }: { wide: boolean }) {
  const game = useAtlas((s) => s.game);
  const editing = usePageEditor((s) => s.open);
  // The person's own pages and changes change what is shown.
  useOwnPages((s) => s.own);
  const guidebooks = useGameGuidebooks(game?.entry.id);
  if (!game) return null;
  // A game whose guidebooks are all it has to read.
  if (!editing && !hasGuidePages(game) && guidebooks.length > 0) {
    return (
      <GuidebooksAlone game={game} wide={wide}>
        {hasMap(game) ? <GuidesFromGames game={game} /> : null}
      </GuidebooksAlone>
    );
  }
  if (!editing) return <GuidesShown game={game} wide={wide} />;
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

/** The pages of a game being read: the contents beside them when wide, and the reader. */
function GuidesShown({ game, wide }: { game: LoadedGame; wide: boolean }) {
  const view = useSourceView(game);
  useFollowSource(game, view);
  useHomeKey(view);
  const menu = hasMenu(game, view);
  const root = useRef<HTMLDivElement>(null);
  const bar = useBarFold(wide && menu, root);
  // The switcher of sources leads the bar when there is one; else the search does.
  const switcher = view.sources.length > 1 && view.shown !== undefined;
  return (
    <div
      ref={root}
      className={`guides ${wide ? 'guides-wide' : 'guides-compact'}${menu ? '' : ' guides-no-menu'}`}
      data-testid="guides-screen"
      data-menu={menu ? 'true' : 'false'}
      data-bar={bar.offered ? (bar.beside ? 'open' : 'folded') : undefined}
    >
      {bar.offered ? (
        <aside
          id={bar.id}
          className="guides-side"
          aria-label="Contents"
          data-testid="guides-bar"
          data-arrived={bar.arrived ? 'true' : undefined}
          hidden={!bar.beside}
        >
          <div className="guides-side-top">
            {switcher ? <SourceSwitcher game={game} view={view} /> : <SearchField />}
            <BarButton bar={bar} />
          </div>
          {switcher ? <SearchField /> : null}
          <nav className="guides-tree touch-scroll" aria-label="Contents" data-scroll-root>
            <TreeHome game={game} view={view} />
            <ContentsTree game={game} view={view} shown={bar.beside} />
          </nav>
          <AllPagesRow game={game} view={view} />
        </aside>
      ) : wide ? null : (
        <SourceSwitcher game={game} view={view} />
      )}
      <Reader game={game} wide={wide} view={view} menu={menu} bar={bar} />
    </div>
  );
}

/** The bar beside the page, which the person can fold away and bring back. */
interface BarFold {
  /** Whether there is a bar to fold: wide, for a source with a menu. */
  offered: boolean;
  /** Whether the bar is beside the page: offered, and not folded away. */
  beside: boolean;
  /** The bar's id, for the buttons that fold it and bring it back. */
  id: string;
  /** The person folded or brought back the bar since Guides was shown: it comes back in view gently. */
  arrived: boolean;
  /** Folds the bar (`false`) or brings it back, from a button: the focus goes to the other one. */
  change: (open: boolean) => void;
}

/**
 * The bar beside the page, folded away or not as the person chose (see
 * `guidesBar.ts`). Folding it, or bringing it back, keeps the place read
 * in the page where it was, though its lines are now wider or narrower;
 * from a button, the focus goes to the button that undoes it. The key B
 * does the same; the focus moves only when it was on a button of the two,
 * or in the bar folded away.
 */
function useBarFold(offered: boolean, root: RefObject<HTMLDivElement | null>): BarFold {
  const chosen = useGuidesBar((s) => s.open);
  const beside = offered && chosen;
  const id = useId();
  const [arrived, setArrived] = useState(false);
  // What to do once the bar is folded or back: the place read, and where the focus goes.
  const next = useRef<{ mark: ReadingMark | null; focus: boolean } | null>(null);
  const bodyOf = () => root.current?.querySelector<HTMLElement>('.guides-body') ?? null;
  const change = (open: boolean, focus = true) => {
    const body = bodyOf();
    next.current = { mark: body ? readingMark(body) : null, focus };
    setArrived(true);
    setGuidesBarOpen(open);
  };
  useLayoutEffect(() => {
    const step = next.current;
    next.current = null;
    if (!step) return;
    const body = bodyOf();
    if (body && step.mark) backToMark(body, step.mark);
    if (step.focus) document.getElementById(buttonId(id, beside))?.focus();
    // Only when the bar folds or comes back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beside]);
  const latest = useRef(change);
  useLayoutEffect(() => {
    latest.current = change;
  });
  useEffect(() => {
    if (!offered) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (event.key.toLowerCase() !== BAR_KEY.toLowerCase() || typingOrDialog(event)) return;
      event.preventDefault();
      const focused = document.activeElement;
      const onButton =
        focused !== null &&
        (focused.id === buttonId(id, true) || focused.id === buttonId(id, false));
      const inBar = focused !== null && (document.getElementById(id)?.contains(focused) ?? false);
      latest.current(!useGuidesBar.getState().open, onButton || inBar);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [offered, id]);
  return { offered, beside, id, arrived, change };
}

/** The id of the button that folds the bar (`true`, at its top) or brings it back. */
function buttonId(barId: string, fold: boolean): string {
  return `${barId}-${fold ? 'hide' : 'show'}`;
}

/** At the top of the bar: the button that folds it away. */
function BarButton({ bar }: { bar: BarFold }) {
  const hints = useKeyHints();
  return (
    <button
      id={buttonId(bar.id, true)}
      type="button"
      className="touch-icon-button touch-icon-button-small guides-side-fold"
      aria-label={HIDE_BAR}
      title={withKey(HIDE_BAR, BAR_KEY, hints)}
      aria-keyshortcuts={BAR_KEY}
      aria-expanded="true"
      aria-controls={bar.id}
      data-testid="guides-bar-hide"
      onClick={() => {
        bar.change(false);
      }}
    >
      <UiIcon name="contentsHide" size={20} />
    </button>
  );
}

/** Beside "Home", while the bar is folded away: the button that brings it back. */
function ShowBarButton({ bar }: { bar: BarFold }) {
  const hints = useKeyHints();
  return (
    <button
      id={buttonId(bar.id, false)}
      type="button"
      className="touch-icon-button"
      aria-label={SHOW_BAR}
      title={withKey(SHOW_BAR, BAR_KEY, hints)}
      aria-keyshortcuts={BAR_KEY}
      aria-expanded="false"
      aria-controls={bar.id}
      data-testid="guides-bar-show"
      onClick={() => {
        bar.change(true);
      }}
    >
      <UiIcon name="contentsShow" size={20} />
    </button>
  );
}

const HIDE_BAR = 'Hide the contents';
const SHOW_BAR = 'Show the contents';

/** A place read in the page: a letter at the top of the page area, and how far below its top it stands. */
interface ReadingMark {
  at: Range | Element;
  offset: number;
}

/** The top of a letter, or of an element, in the window. */
function topOf(at: Range | Element): number | null {
  const box = at instanceof Range ? at.getClientRects()[0] : at.getBoundingClientRect();
  return box ? box.top : null;
}

/**
 * The letter at the top of the page area (or the element there, where the
 * browser cannot tell the letter), to find it again once the lines are
 * wider or narrower. None at the very top of the page, which stays there.
 */
function readingMark(body: HTMLElement): ReadingMark | null {
  if (body.scrollTop <= 0) return null;
  const column = body.firstElementChild;
  if (!column) return null;
  const box = body.getBoundingClientRect();
  const lines = column.getBoundingClientRect();
  const x = lines.left + Math.min(48, lines.width / 3);
  const y = box.top + 8;
  let at: Range | Element | null = null;
  // Not in every browser yet: the element there serves where it is not.
  const caret = 'caretPositionFromPoint' in document ? document.caretPositionFromPoint(x, y) : null;
  const node = caret?.offsetNode;
  if (caret && node?.nodeType === Node.TEXT_NODE && column.contains(node)) {
    const range = document.createRange();
    const start = Math.min(caret.offset, (node.textContent ?? '').length - 1);
    if (start >= 0) {
      range.setStart(node, start);
      range.setEnd(node, start + 1);
      at = range;
    }
  }
  if (!at) {
    const element = document.elementFromPoint(x, y);
    if (element && element !== column && column.contains(element)) at = element;
  }
  const top = at ? topOf(at) : null;
  return at && top !== null ? { at, offset: top - box.top } : null;
}

/** Scrolls the page area so the place read stands where it stood. */
function backToMark(body: HTMLElement, mark: ReadingMark): void {
  const top = topOf(mark.at);
  if (top === null) return;
  body.scrollTop += top - body.getBoundingClientRect().top - mark.offset;
}

/** Whether the source shown has a menu, anything for the bar: else Guides shows no bar. */
function hasMenu(game: LoadedGame, view: SourceView): boolean {
  return view.shown ? view.shown.menu : guidesOf(game).contents.top().length > 0;
}

/** Every page of the source shown, in its menu or not: what "All pages" lists. */
function pagesOfSource(game: LoadedGame, view: SourceView): readonly GuideEntry[] {
  return view.shown ? sourcePages(game, view.shown) : guidesOf(game).contents.pages();
}

/** The key that opens the landing page of the source shown, as "Home" does. */
const HOME_KEY = 'h';

/** H opens the landing page, but while typing, in a dialog, or with a key held with it. */
function useHomeKey(view: SourceView) {
  const source = view.shown?.gameId;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (event.key.toLowerCase() !== HOME_KEY || typingOrDialog(event)) return;
      event.preventDefault();
      openPlace(source ? { kind: 'home', source } : { kind: 'home' });
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [source]);
}

/** "Home", beside Back and Forward: the landing page of the source shown. */
function HomeButton({ game, view }: { game: LoadedGame; view: SourceView }) {
  const place = useReader(currentPlace);
  const hints = useKeyHints();
  const here =
    place.kind === 'home' || (place.kind === 'page' && isSourceHome(game, place.guideId));
  return (
    <button
      type="button"
      className="touch-icon-button"
      aria-label="Home"
      title={withKey('Home', 'H', hints)}
      aria-keyshortcuts="H"
      aria-current={here ? 'page' : undefined}
      data-testid="guides-home-button"
      onClick={() => {
        openPlace(homeOf(view));
      }}
    >
      <UiIcon name="home" size={20} />
    </button>
  );
}

/** "All pages" of the source shown, as a place: Back and Forward show it of that source. */
function allOf(view: SourceView): ReaderPlace {
  return view.shown ? { kind: 'all', source: view.shown.gameId } : { kind: 'all' };
}

/** At the foot of the bar: "All pages", with how many, which opens them from A to Z. */
function AllPagesRow({ game, view }: { game: LoadedGame; view: SourceView }) {
  const place = useReader(currentPlace);
  const count = pagesOfSource(game, view).length;
  return (
    <div className="guides-all-foot">
      <button
        type="button"
        className="guides-tree-row guides-all-row-link"
        aria-current={place.kind === 'all' ? 'page' : undefined}
        data-testid="guides-all-pages"
        onClick={() => {
          openPlace(allOf(view));
        }}
      >
        <UiIcon name="bullets" size={16} />
        <span className="guides-entry-name">All pages</span>
        <span className="touch-figure" data-testid="guides-all-count">
          {count.toLocaleString('en')}
        </span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The reader

function Reader({
  game,
  wide,
  view,
  menu,
  bar,
}: {
  game: LoadedGame;
  wide: boolean;
  view: SourceView;
  /** Whether the source shown has a menu (see {@link hasMenu}). */
  menu: boolean;
  /** The bar beside the page, which may be folded away. */
  bar: BarFold;
}) {
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

  const { name } = view;
  const atHome = isLanding(game, place);
  const title = placeTitle(game, place, name);
  // On a computer or a tablet, the pages are as wide as the person (or the site) chose.
  const width = pageWidthOf(game, useOwnPages()).width;
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
        <HomeButton game={game} view={view} />
        {bar.offered && !bar.beside ? <ShowBarButton bar={bar} /> : null}
        <Breadcrumbs
          game={game}
          place={place}
          view={view}
          way={wayCame(reader)}
          menuWay={currentMenuWay(reader)}
        />
        {wide && !bar.beside ? (
          // No bar, or the bar folded away: what it would hold, in the head.
          <div className="guides-head-tools" data-testid="guides-head-tools">
            <SearchField />
            <SourceSwitcher game={game} view={view} />
            <button
              type="button"
              className="touch-button guides-all-button"
              aria-current={place.kind === 'all' ? 'page' : undefined}
              data-testid="guides-all-pages"
              onClick={() => {
                openPlace(allOf(view));
              }}
            >
              <UiIcon name="bullets" size={18} />
              All pages
            </button>
          </div>
        ) : null}
        {wide ? <PageWidthMenu game={game} /> : null}
        {wide ? null : menu ? (
          <button
            type="button"
            className="touch-icon-button"
            aria-label="Contents"
            title="Contents"
            data-testid="guides-contents-button"
            onClick={() => {
              openPlace({
                kind: 'contents',
                sectionId: null,
                ...(view.shown ? { source: view.shown.gameId } : {}),
              });
            }}
          >
            <UiIcon name="book" size={20} />
          </button>
        ) : (
          // No menu: the button opens every page, and says so.
          <button
            type="button"
            className="touch-icon-button"
            aria-label="All pages"
            title="All pages"
            data-testid="guides-contents-button"
            data-opens="all"
            onClick={() => {
              openPlace(allOf(view));
            }}
          >
            <UiIcon name="bullets" size={20} />
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
        <div className="guides-column" data-width={wide ? width : undefined}>
          {!wide &&
          (atHome ||
            place.kind === 'search' ||
            place.kind === 'all' ||
            (place.kind === 'contents' && !place.sectionId)) ? (
            <SearchField />
          ) : null}
          {atHome ? (
            <Landing game={game} wide={wide} view={view} menu={menu} beside={bar.beside} />
          ) : place.kind === 'all' ? (
            <AllPages game={game} view={view} />
          ) : place.kind === 'page' ? (
            <Page
              game={game}
              guide={contents.guide(place.guideId)}
              wide={wide}
              view={view}
              beside={bar.beside}
            />
          ) : place.kind === 'links' ? (
            <GuideLinksReview game={game} />
          ) : place.kind === 'search' ? (
            <SearchResults game={game} query={place.query} view={view} />
          ) : (
            <ContentsPlace
              game={game}
              sectionId={place.kind === 'contents' ? place.sectionId : null}
              view={view}
            />
          )}
        </div>
      </div>
    </section>
  );
}

const LINKS_TITLE = 'Link pages to the map';

const ALL_PAGES_TITLE = 'All pages';

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
 * Whether a place is the landing page: itself, or the home page of a
 * source of pages opened by a link.
 */
function isLanding(game: LoadedGame, place: ReaderPlace): boolean {
  return place.kind === 'home' || (place.kind === 'page' && isSourceHome(game, place.guideId));
}

/** The landing page of the source shown, as a place: Back and Forward show it of that source. */
function homeOf(view: SourceView): ReaderPlace {
  return view.shown ? { kind: 'home', source: view.shown.gameId } : { kind: 'home' };
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
    case 'all':
      return ALL_PAGES_TITLE;
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
 * Section › Page › … › the place itself: for a place opened from a row of
 * the bar, the way to that row, so a page the menu lists twice is shown
 * at the listing pressed; else the way to its first place in the menu.
 * The game's name opens the
 * landing page, a section its contents, a page the page. A section led by
 * its own page is that page, as in the bar: it opens the page, and is not
 * named before it. A page outside the menu is under the pages its source
 * files it under, where it says, else under the name alone (see `pathIn`
 * for both); "All pages" is under the name.
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
  view,
  way,
  menuWay,
}: {
  game: LoadedGame;
  place: ReaderPlace;
  view: SourceView;
  way: readonly WayStep[];
  /** The way down the menu to the row the place was opened from, if it was (see `reader.ts`). */
  menuWay: readonly string[] | undefined;
}) {
  const { contents } = guidesOf(game);
  const { name, shown } = view;
  // The way within the source shown: its section and home page are its start, the name;
  // through the listing of the menu pressed, while the menu still shows it.
  const trail = (id: string, by?: readonly string[]) => pathIn(game, shown, id, by);
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
      ? fromPage
        ? trail(walked[0]!.guideId, way[0]!.menuWay)
        : trail(place.guideId, menuWay)
      : place.kind === 'contents' && place.sectionId
        ? trail(place.sectionId, menuWay)
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
      : place.kind === 'all'
        ? ALL_PAGES_TITLE
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
            openPlace(homeOf(view));
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
              openPlace(stepPlace(contents, step));
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
 * A section's contents; or, with none, the top of the contents of the
 * source shown as a list, headed with its name: what a phone opens from
 * its "Contents" button, the home page first when there is one.
 */
function ContentsPlace({
  game,
  sectionId,
  view,
}: {
  game: LoadedGame;
  sectionId: string | null;
  view: SourceView;
}) {
  const { contents } = guidesOf(game);
  const { name, shown } = view;
  const section = sectionId ? contents.section(sectionId) : undefined;
  const entries = section ? contents.items(section.id) : (shown?.top ?? contents.top());
  const home = section ? null : (shown?.home ?? contents.homePage());
  // The pages of another game read with this one are changed in that game.
  const editable = !shown || shown.own;
  return (
    <div className="guides-contents" data-testid="guides-contents">
      <h1 className="guides-title">{section ? section.title : name}</h1>
      {!section && editable ? <EditPagesButton label="Edit the pages" guideId={null} /> : null}
      {home ? (
        <ul className="touch-plain-list guides-entries guides-entries-home">
          <li>
            <button
              type="button"
              className="guides-entry guides-entry-home"
              data-testid="guides-home-link"
              onClick={() => {
                openPlace(homeOf(view));
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
      <EntryList entries={entries} />
      {section ? null : <AllPagesRow game={game} view={view} />}
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
  entries,
  by = 'fresh',
}: {
  entries: readonly ContentsEntry[];
  by?: OpenedBy;
}) {
  const [count, setCount] = useState(ROWS_AT_ONCE);
  return (
    <ul className="touch-plain-list guides-entries">
      {entries.slice(0, count).map((entry) =>
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

/** Where an entry or a step of the contents opens: a section its contents, a page the page. */
function placeOf(entry: ContentsEntry | ContentsStep): ReaderPlace {
  if (entry.kind === 'section') return { kind: 'contents', sectionId: entry.section.id };
  return { kind: 'page', guideId: entry.guide.id };
}

/**
 * Where a step of the way above a place opens, as the bar opens it: a
 * section led by its own page (see `leadPage` in core) that page, else as
 * {@link placeOf}.
 */
function stepPlace(contents: GuideContents, step: ContentsStep): ReaderPlace {
  const lead = step.kind === 'section' ? contents.leadPage(step.section.id) : null;
  return lead ? { kind: 'page', guideId: lead.id } : placeOf(step);
}

/**
 * The contents beside the page (wide): a tree open to the place shown,
 * with the entries around it. A section opens its contents when pressed;
 * a page opens the page, and a page with pages under it has a button of
 * its own to show or hide them. The way to a new place opens again.
 *
 * A section led by its own page (see `leadPage` in core: a page of the
 * source's menu with pages under it) is that page, as the source's menu
 * shows it: its heading opens the page, and under it are the section's
 * other entries, after any pages put under the page by hand; the page is
 * not named again. Pressed while its page is shown there, the heading
 * folds or unfolds them.
 *
 * A page the menu lists in several places is marked in each. The tree is
 * open along the way to the row the place shown was opened from (see
 * `reader.ts`), that row marked as here (`data-here`); a place opened any
 * other way, along the way to its first place (see `menuWayIn`). Folded
 * away with the bar, the tree stays as it was, only hidden.
 */
function ContentsTree({
  game,
  view,
  shown,
}: {
  game: LoadedGame;
  view: SourceView;
  /** Whether the bar is in view: brought back, it shows the place's row again. */
  shown: boolean;
}) {
  const place = useReader(currentPlace);
  const remembered = useReader(currentMenuWay);
  const { contents } = guidesOf(game);
  const root = useRef<HTMLDivElement>(null);
  const way = useMemo(() => {
    const id =
      place.kind === 'page' ? place.guideId : place.kind === 'contents' ? place.sectionId : null;
    // A page outside the menu has no way in it: the tree stays as it was.
    return id ? menuWayIn(game, view.shown, id, remembered) : null;
  }, [game, view.shown, place, remembered]);
  const onPath = useMemo(() => new Set(way ?? []), [way]);
  // What the person folded or unfolded; the way to a new place opens again.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [followed, setFollowed] = useState(onPath);
  if (followed !== onPath) {
    setFollowed(onPath);
    setToggled(new Map([...toggled].filter(([id]) => !onPath.has(id))));
  }
  const here = way ? way.join('\n') : null;
  const tree: TreeState = {
    game,
    place,
    onPath,
    isHere: (rowWay) => here !== null && rowWay.join('\n') === here,
    isOpen: (id) => toggled.get(id) ?? onPath.has(id),
    toggle: (id, open) => {
      setToggled(new Map(toggled).set(id, open));
    },
  };
  // The place shown is in view: the row it was opened from, else its first listing;
  // also when the bar comes back from being folded away.
  useEffect(() => {
    const element = root.current;
    if (!shown) return;
    (
      element?.querySelector('[data-here]') ?? element?.querySelector('[aria-current="page"]')
    )?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [onPath, shown]);
  return (
    <div ref={root}>
      <TreeLevel tree={tree} entries={view.shown?.top ?? contents.top()} depth={0} way={[]} />
    </div>
  );
}

/** At the top of the contents beside the page: the source's name, which opens its landing page. */
function TreeHome({ game, view }: { game: LoadedGame; view: SourceView }) {
  const place = useReader(currentPlace);
  const { name } = view;
  const here = isLanding(game, place);
  return (
    <button
      type="button"
      className="guides-tree-row guides-tree-home"
      aria-current={here ? 'page' : undefined}
      data-testid="guides-tree-home"
      onClick={() => {
        openPlace(homeOf(view));
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
  /** Whether the row at the end of a way down the tree is the one the place shown is at. */
  isHere: (way: readonly string[]) => boolean;
  isOpen: (id: string) => boolean;
  toggle: (id: string, open: boolean) => void;
}

function TreeLevel({
  tree,
  entries,
  depth,
  way,
  id,
}: {
  tree: TreeState;
  entries: readonly ContentsEntry[];
  depth: number;
  /** The ids of the rows above this level, from the top down. */
  way: readonly string[];
  id?: string;
}) {
  const [count, setCount] = useState(ROWS_AT_ONCE);
  // Long lists show their rows a few hundred at a time, always as far as the way to the place shown.
  const onWay = entries.findIndex((entry) => tree.onPath.has(entryIdOf(entry)));
  const shown = Math.max(count, Math.ceil((onWay + 1) / ROWS_AT_ONCE) * ROWS_AT_ONCE);
  const keys = keysOf(entries);
  return (
    <ul id={id} className="touch-plain-list guides-tree-level">
      {entries
        .slice(0, shown)
        .map((entry, at) =>
          entry.kind === 'section' ? (
            <TreeSection key={keys[at]} tree={tree} entry={entry} depth={depth} way={way} />
          ) : (
            <TreePage key={keys[at]} tree={tree} entry={entry} depth={depth} way={way} />
          ),
        )}
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

/** A key for each entry of a list, unique in it though the list names an entry twice. */
function keysOf(entries: readonly ContentsEntry[]): string[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const id = entryIdOf(entry);
    const times = (seen.get(id) ?? 0) + 1;
    seen.set(id, times);
    return times === 1 ? id : `${id}#${times}`;
  });
}

/**
 * A section in the tree: a heading that opens its contents, and its
 * entries under it when it is open. A section led by its own page is that
 * page (see {@link ContentsTree}).
 */
function TreeSection({
  tree,
  entry,
  depth,
  way,
}: {
  tree: TreeState;
  entry: Extract<ContentsEntry, { kind: 'section' }>;
  depth: number;
  way: readonly string[];
}) {
  const { contents } = guidesOf(tree.game);
  const sectionId = entry.section.id;
  const rowWay = [...way, sectionId];
  const lead = contents.leadPage(sectionId);
  const holds = !lead || contents.itemCount(sectionId) > 1 || contents.itemCount(lead.id) > 0;
  const expanded = holds && tree.isOpen(sectionId);
  const leadShown = lead !== null && tree.place.kind === 'page' && tree.place.guideId === lead.id;
  const current =
    leadShown || (tree.place.kind === 'contents' && tree.place.sectionId === sectionId);
  const here = current && tree.isHere(rowWay);
  return (
    <li>
      <button
        type="button"
        className="guides-tree-row guides-tree-section"
        style={{ paddingLeft: 4 + depth * 14 }}
        aria-expanded={holds ? expanded : undefined}
        aria-current={current ? 'page' : undefined}
        data-here={here ? 'true' : undefined}
        onClick={() => {
          if (!lead) {
            openPlace({ kind: 'contents', sectionId }, 'fresh', rowWay);
          } else if (leadShown && here) {
            if (holds) tree.toggle(sectionId, !expanded);
          } else {
            if (holds) tree.toggle(sectionId, true);
            openPlace({ kind: 'page', guideId: lead.id }, 'fresh', rowWay);
          }
        }}
      >
        {holds ? (
          <UiIcon name={expanded ? 'chevronDown' : 'chevron'} size={14} strokeWidth={2} />
        ) : (
          <span className="guides-tree-icon-space" aria-hidden="true" />
        )}
        {entry.section.title}
      </button>
      {expanded ? (
        <TreeLevel
          tree={tree}
          entries={contents.menuItems(sectionId)}
          depth={depth + 1}
          way={rowWay}
        />
      ) : null}
    </li>
  );
}

/** A page in the tree; one with pages put under it by hand can show or hide them. */
function TreePage({
  tree,
  entry,
  depth,
  way,
}: {
  tree: TreeState;
  entry: Exclude<ContentsEntry, { kind: 'section' }>;
  depth: number;
  way: readonly string[];
}) {
  const { contents } = guidesOf(tree.game);
  const listId = useId();
  const id = entryIdOf(entry);
  const rowWay = [...way, id];
  const current = tree.place.kind === 'page' && tree.place.guideId === id;
  const here = current && tree.isHere(rowWay);
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
          className="guides-tree-row guides-tree-page-name"
          aria-current={current ? 'page' : undefined}
          data-here={here ? 'true' : undefined}
          data-testid="guides-tree-page"
          onClick={() => {
            if (holds) tree.toggle(id, true);
            openPlace(placeOf(entry), 'fresh', rowWay);
          }}
        >
          {title}
        </button>
      </div>
      {open ? (
        <TreeLevel
          tree={tree}
          entries={contents.items(id)}
          depth={depth + 1}
          way={rowWay}
          id={listId}
        />
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// All pages

/** The height of a row of "All pages", fixed so a part not drawn yet takes its room. */
const ALL_ROW_PX = 40;

/** How many rows of "All pages" are drawn together, as one part. */
const ALL_PART = 50;

/** A list in parts of at most `size`. */
function partsOf<T>(items: readonly T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let at = 0; at < items.length; at += size) parts.push(items.slice(at, at + size));
  return parts;
}

/**
 * "All pages": every page of the source shown, in its menu or not, from A
 * to Z (see `allPages.ts` in core), under the first letter of its title,
 * `#` first, each a link to the page. The letters lead to their groups. A
 * source may have thousands: each group is drawn in parts of
 * {@link ALL_PART} rows of one height, and a part out of view is left to
 * the browser to draw when it comes into view (`content-visibility`), its
 * room kept, so Back and Forward return to where it was scrolled to.
 * With no home page and no menu, it is the landing page (`landing`),
 * headed with the source's name.
 */
function AllPages({
  game,
  view,
  landing = false,
}: {
  game: LoadedGame;
  view: SourceView;
  landing?: boolean;
}) {
  const pages = pagesOfSource(game, view);
  const letters = useMemo(() => pagesAToZ(pages), [pages]);
  const ids = useId();
  const groupId = (letter: string) => `${ids}-${letter === '#' ? 'other' : letter}`;
  return (
    <div
      className={`guides-all${landing ? ' guides-landing' : ''}`}
      data-testid={landing ? 'guides-home' : 'guides-all'}
      data-landing={landing ? 'all' : undefined}
      data-source={view.shown?.gameId}
    >
      <h1 className="guides-title">{landing ? view.name : ALL_PAGES_TITLE}</h1>
      <p className="guides-lead" data-testid="guides-all-lead">
        {landing
          ? `${pagesText(pages.length)}, from A to Z.`
          : `${pagesText(pages.length)} of ${view.name}, from A to Z.`}
      </p>
      {letters.length > 1 ? (
        <nav className="guides-all-letters" aria-label="Letters" data-testid="guides-all-letters">
          {letters.map((group) => (
            <button
              key={group.letter}
              type="button"
              className="guides-all-letter-link"
              data-testid="guides-all-letter-link"
              onClick={() => {
                document.getElementById(groupId(group.letter))?.scrollIntoView({ block: 'start' });
              }}
            >
              {group.letter}
            </button>
          ))}
        </nav>
      ) : null}
      {letters.map((group) => (
        <section
          key={group.letter}
          className="guides-all-group"
          aria-labelledby={groupId(group.letter)}
          data-testid="guides-all-group"
          data-letter={group.letter}
        >
          <h2 id={groupId(group.letter)} className="guides-all-letter">
            {group.letter}
          </h2>
          {partsOf(group.pages, ALL_PART).map((part) => (
            <ul
              key={part[0]!.id}
              className="touch-plain-list guides-all-part"
              style={{ containIntrinsicSize: `auto ${part.length * ALL_ROW_PX}px` }}
            >
              {part.map((page) => (
                <li key={page.id}>
                  <button
                    type="button"
                    className="guides-all-row"
                    title={page.title}
                    data-testid="guides-all-page"
                    data-guide={page.id}
                    onClick={() => {
                      openPlace({ kind: 'page', guideId: page.id });
                    }}
                  >
                    {page.title}
                  </button>
                </li>
              ))}
            </ul>
          ))}
        </section>
      ))}
      {landing ? <LandingFoot game={game} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The landing page

/**
 * The landing page: the wiki's own home page, read as any page and
 * editable as one; or, for guides with no home page, one made from the
 * top of the contents (see `landing.ts` in the core package), which is no
 * stored page; with neither a home page nor a menu, "All pages". Below
 * each, what the top of the contents offers: linking the pages to the map,
 * and guides of other games.
 */
function Landing({
  game,
  wide,
  view,
  menu,
  beside,
}: {
  game: LoadedGame;
  wide: boolean;
  view: SourceView;
  menu: boolean;
  /** Whether the bar is beside the page (see {@link useBarFold}). */
  beside: boolean;
}) {
  const { contents } = guidesOf(game);
  const home = view.shown ? view.shown.home : contents.homePage();
  if (!home) {
    // No home page and no menu: every page, from A to Z, is the landing page.
    return !menu && pagesOfSource(game, view).length > 0 ? (
      <AllPages game={game} view={view} landing />
    ) : (
      <MadeLanding game={game} view={view} />
    );
  }
  return (
    <div
      className="guides-landing"
      data-testid="guides-home"
      data-landing="page"
      data-source={view.shown?.gameId}
    >
      <ContinueReading game={game} view={view} />
      <Page game={game} guide={home} wide={wide} view={view} beside={beside} home={view.name} />
      <LandingFoot game={game} />
    </div>
  );
}

/** The game's routes, under the landing page: each opens in Lists, drawn on the map. */
function GuidesRoutes() {
  const routes = useGameRoutes();
  if (routes.length === 0) return null;
  return (
    <section className="guides-routes" aria-labelledby="guides-routes-heading">
      <h2 className="touch-group-title" id="guides-routes-heading">
        Routes on the map
      </h2>
      <ul className="touch-plain-list touch-list-cards">
        {routes.map(({ route }) => (
          <li key={route.id}>
            <button
              type="button"
              className="touch-list-card"
              data-testid="guides-route"
              onClick={() => {
                openRoute(route.id);
                showSection('lists');
              }}
            >
              <UiIcon name="route" size={20} strokeWidth={1.8} />
              <span className="touch-list-card-text">
                <span className="touch-list-card-name">{route.title}</span>
                <span className="touch-figure">
                  {routeTypeName(route.type)} ·{' '}
                  {route.steps.length === 1 ? 'One step' : `${route.steps.length} steps`}
                </span>
              </span>
              <UiIcon name="chevron" size={20} strokeWidth={1.8} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Under the landing page: the game's guidebooks, linking the pages to the map, and guides of other games. */
function LandingFoot({ game }: { game: LoadedGame }) {
  return (
    <>
      <GuidebookList gameId={game.entry.id} gameTitle={game.pack.manifest.title} />
      <GuidesRoutes />
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

/** The landing page made from the top of the contents of the source shown: each section a group of tiles. */
function MadeLanding({ game, view }: { game: LoadedGame; view: SourceView }) {
  const { contents } = guidesOf(game);
  const { name, shown } = view;
  const groups = useMemo(
    () => (shown ? madeLandingOf(game, shown) : madeLanding(contents)),
    [game, contents, shown],
  );
  const pages = shown ? readingOrder(game, shown) : contents.pages();
  // Pages read from a site whose own home page was not kept with them.
  const fromSite = pages.some((page) => page.source !== undefined);
  const sequence = sequenceOf(game, view, null);
  return (
    <div
      className="guides-landing guides-landing-made"
      data-testid="guides-home"
      data-landing="made"
      data-source={shown?.gameId}
    >
      <h1 className="guides-title">{name}</h1>
      <p className="guides-lead">{pagesText(pages.length)}</p>
      <ContinueReading game={game} view={view} />
      {!shown || shown.own ? <EditPagesButton label="Edit the pages" guideId={null} /> : null}
      {groups.length === 0 ? <p className="touch-empty">Nothing here yet.</p> : null}
      {groups.map((group, index) => (
        <LandingGroupView
          key={group.section?.id ?? `pages-${index}`}
          game={game}
          group={group}
          view={view}
        />
      ))}
      {sequence ? (
        <PreviousNext
          previous={sequence.previous}
          next={sequence.next}
          name={name}
          home={shown?.home?.id ?? null}
        />
      ) : null}
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
  view,
}: {
  game: LoadedGame;
  group: LandingGroup;
  view: SourceView;
}) {
  const { section } = group;
  const { name } = view;
  const withPictures = group.tiles.some((tile) => tile.picture !== null);
  const openGroup = () => {
    openPlace(
      section
        ? { kind: 'contents', sectionId: section.id }
        : {
            kind: 'contents',
            sectionId: null,
            ...(view.shown ? { source: view.shown.gameId } : {}),
          },
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
  const section = entry.kind === 'section';
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
  view,
  beside,
  home,
}: {
  game: LoadedGame;
  guide: GuideEntry | undefined;
  wide: boolean;
  view: SourceView;
  /** Whether the bar is beside the page: a source with a menu, wide, the bar not folded away. */
  beside: boolean;
  /**
   * The game's name, for the home page shown as the landing page: its
   * heading, with nothing of a page in the contents (the way to the map,
   * building, the pages under it, the pages that link to it).
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
  // A page of a guide, read in order: the pages before and after it.
  const sequence = sequenceOf(game, view, guide.id);
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
      {sequence ? (
        <PreviousNext
          previous={sequence.previous}
          next={sequence.next}
          name={view.name}
          home={view.shown?.home?.id ?? null}
        />
      ) : null}
      {home === undefined && (!beside || !guidesOf(game).contents.isInMenu(guide.id)) ? (
        // Beside the bar, a page in it shows the pages under it there.
        <PagesUnder game={game} guideId={guide.id} />
      ) : null}
      {home === undefined ? <LinkedFrom key={guide.id} game={game} guideId={guide.id} /> : null}
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

/**
 * The pages the person put under this one by hand, at its foot: on a
 * phone, where the bar is not beside the page, and for a page the bar does
 * not show (outside the menu, or with no menu).
 */
function PagesUnder({ game, guideId }: { game: LoadedGame; guideId: string }) {
  const { contents } = guidesOf(game);
  const entries = contents.items(guideId);
  if (entries.length === 0) return null;
  return (
    <section className="guides-under" aria-label="Pages under this page" data-testid="pages-under">
      <h2 className="guides-under-title">Pages under this page</h2>
      <EntryList key={guideId} entries={entries} by="walk" />
    </section>
  );
}

/** How many pages "Linked from" names before "and n more". */
const LINKED_FROM_SHOWN = 12;

/**
 * "Linked from": the pages of the page's source that link to it (see
 * `linkedFrom` in core), {@link LINKED_FROM_SHOWN} named, then "and n
 * more", which names the rest. Worked out only when a page is shown; not
 * on the home page, which every page leads to.
 */
function LinkedFrom({ game, guideId }: { game: LoadedGame; guideId: string }) {
  const { contents } = guidesOf(game);
  const from = useMemo(() => {
    const of = parseId(guideId)?.gameId;
    return contents.linkedFrom(guideId).filter((page) => parseId(page.id)?.gameId === of);
  }, [contents, guideId]);
  const [count, setCount] = useState(LINKED_FROM_SHOWN);
  if (from.length === 0 || isSourceHome(game, guideId)) return null;
  const left = from.length - count;
  return (
    <nav className="guides-also" aria-label="Linked from" data-testid="linked-from">
      <h2 className="guides-also-title">Linked from</h2>
      <ul className="touch-plain-list guides-also-list">
        {from.slice(0, count).map((page) => (
          <li key={page.id}>
            <button
              type="button"
              className="guides-inline-button"
              data-testid="linked-from-page"
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
              data-testid="linked-from-more"
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
            Cancel
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

function SearchField() {
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
        placeholder="Search pages"
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

function SearchResults({
  game,
  query,
  view,
}: {
  game: LoadedGame;
  query: string;
  view: SourceView;
}) {
  const hits = useMemo(() => guidesOf(game).search.search(query, 100), [game, query]);
  const guidebookHits = useGuidebookHits(game.entry.id, query);
  // A page of another source than the one shown says which, so the choice of source hides none.
  const elsewhere = (guideId: string): string | null => {
    if (view.sources.length < 2) return null;
    const source = sourceOfEntry(game, guideId);
    return source && source !== view.shown ? (view.names.get(source.gameId) ?? source.title) : null;
  };
  return (
    <div className="guides-results" data-testid="guides-results">
      <h1 className="guides-title">Search</h1>
      <p className="guides-lead" aria-live="polite">
        {hits.length === 0 && guidebookHits.length > 0
          ? `No guide page has “${query.trim()}”. These pages of guidebooks have it.`
          : hits.length === 0
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
              <ResultSource name={elsewhere(hit.guide.id)} />
            </button>
            <AddToBuildButton
              game={game}
              thing={{ name: hit.guide.title, guideId: hit.guide.id }}
              small
            />
          </li>
        ))}
      </ul>
      <GuidebookResults hits={guidebookHits} query={query} />
    </div>
  );
}

/** Under a result of another source than the one shown: which it is of. */
function ResultSource({ name }: { name: string | null }) {
  if (!name) return null;
  return (
    <span className="guides-result-source" data-testid="guides-result-source">
      <UiIcon name="book" size={14} />
      In {name}
    </span>
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
