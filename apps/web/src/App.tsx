import { lazy, Suspense, useEffect, useState } from 'react';
import { ActivityLogDialog } from './components/ActivityLogDialog';
import { AddMapDialog } from './components/AddMapDialog';
import { ChecklistsPane } from './components/ChecklistsPane';
import { DetailsPane } from './components/DetailsPane';
import { FilterPane } from './components/FilterPane';
import { UiIcon } from './components/icons';
import { MapPageStatus } from './components/MapPageStatus';
import { MapPane } from './components/MapPane';
import { MapsDialog } from './components/MapsDialog';
import { PhotoViewer } from './components/Photos';
import { ProfileDialog } from './components/ProfileDialog';
import { SearchBox } from './components/SearchBox';
import { Toast } from './components/Toast';
import { TopBar } from './components/TopBar';
import { downloadsOffered, touchUiOffered } from './features';
import { useShortcuts } from './keyboard';
import { NARROW_QUERY, boot, onWidthClassChange, setPane } from './state/actions';
import { checklistScreenTitle, showLeftTab } from './state/checklists';
import { hasMap } from './state/guides';
import { loadGuideLinks, lookForGuideGames } from './state/guideLinks';
import { loadOwnPages } from './state/ownPages';
import { loadOwnLists } from './state/ownLists';
import { sweepOwnPicturesOnOpen } from './state/ownPictures';
import { initSaves } from './state/saves';
import { useAtlas, type AtlasState, type LeftTab, type PaneName } from './state/store';
import { coarsePointer, requestedUi, sessionStore, shownUi } from './touch/uiMode';
import { formatViewHash, parseViewHash } from './viewHash';

// The standard layout (src/touch/): loaded only where it is shown, so the
// classic layout's bundle stays as it was.
const TouchShell = lazy(() =>
  import('./touch/TouchShell').then((module) => ({ default: module.TouchShell })),
);

// Opened rarely, so loaded when first opened.
const SaveDialog = lazy(() =>
  import('./components/SaveDialog').then((module) => ({ default: module.SaveDialog })),
);

// Only the desktop app writes and reads map pack files: their dialog is
// loaded the first time it opens, so the bundle every browser loads stays
// as it was.
const PackFileDialog = lazy(() =>
  import('./components/PackFileDialog').then((module) => ({ default: module.PackFileDialog })),
);

/**
 * Loads the configuration and the first pack, then shows the standard
 * layout (a rail, a panel and the map), or the classic three-pane layout
 * where the person chose it (see `touch/uiMode.ts`).
 */
export function App() {
  const status = useAtlas((s) => s.status);
  const game = useAtlas((s) => s.game);
  const [coarse] = useState(coarsePointer);
  const shown = (s: AtlasState) =>
    shownUi({
      android: touchUiOffered(s),
      requested: s.uiRequest,
      saved: s.layout,
      coarse,
    });
  const touch = useAtlas((s) => shown(s).layout === 'standard');
  const input = useAtlas((s) => shown(s).input);

  useEffect(() => {
    useAtlas.setState({ uiRequest: requestedUi(window.location.search, sessionStore()) });
    const stopSaves = initSaves();
    void boot(parseViewHash(window.location.hash));
    return stopSaves;
  }, []);

  // The person's own lists of the game, read when the game opens.
  useEffect(() => {
    if (!game) return;
    const gameId = game.pack.manifest.gameId;
    void loadOwnLists(game).then(() => {
      sweepOwnPicturesOnOpen(gameId);
    });
  }, [game]);
  // Their links between guide pages and the map, and other games with pages to read with it.
  useEffect(() => {
    if (!game) return;
    void loadGuideLinks(game);
    void lookForGuideGames(game);
  }, [game]);
  // Their own guide pages and changes to the pack's pages.
  useEffect(() => {
    if (!game) return;
    void loadOwnPages(game);
  }, [game]);

  useViewHashSync();
  useWidthClass();
  useShortcuts();
  useEffect(() => {
    if (touch) document.documentElement.dataset.ui = 'touch';
    else delete document.documentElement.dataset.ui;
  }, [touch]);

  if (status.kind === 'error') {
    return (
      <main className="status status-error" role="alert">
        <h1>Could not load the map</h1>
        <pre>{status.message}</pre>
      </main>
    );
  }
  if (!game) {
    return (
      <main className="status" aria-busy="true">
        Loading…
      </main>
    );
  }
  if (touch) {
    return (
      <Suspense
        fallback={
          <main className="status" aria-busy="true">
            Loading…
          </main>
        }
      >
        <TouchShell key={input} input={input} />
      </Suspense>
    );
  }
  return <Shell />;
}

function Shell() {
  const panes = useAtlas((s) => s.panes);
  const game = useAtlas((s) => s.game)!;
  const leftTab = useAtlas((s) => s.leftTab);
  const hasChecklists = !game.checklists.isEmpty;
  const showChecklists = hasChecklists && leftTab === 'checklists';
  const loading = useAtlas((s) => s.status.kind === 'loading');
  const packFileOpen = useAtlas((s) => s.packFileDialog !== null);
  const persistent = useAtlas((s) => s.persistent);
  const saveDialogOpen = useAtlas((s) => s.saveDialogOpen);
  const pageViews = useAtlas(downloadsOffered);
  return (
    <div
      className="shell"
      data-filters={panes.filters ? 'open' : 'closed'}
      data-details={panes.details ? 'open' : 'closed'}
      data-left={showChecklists ? 'checklists' : 'filters'}
      data-storage={persistent ? 'saved' : 'memory'}
      aria-busy={loading}
    >
      <TopBar search={<SearchBox />} />
      {hasChecklists ? (
        <SidePane
          name="filters"
          title={showChecklists ? checklistScreenTitle(game) : 'Filters'}
          head={<LeftTabs current={showChecklists ? 'checklists' : 'filters'} />}
        >
          <div
            className="pane-panel"
            role="tabpanel"
            id="left-tab-filters"
            aria-labelledby="left-tab-filters-tab"
            hidden={showChecklists}
          >
            <FilterPane />
          </div>
          <div
            className="pane-panel"
            role="tabpanel"
            id="left-tab-checklists"
            aria-labelledby="left-tab-checklists-tab"
            hidden={!showChecklists}
          >
            <ChecklistsPane visible={panes.filters && showChecklists} />
          </div>
        </SidePane>
      ) : (
        <SidePane name="filters" title="Filters">
          <FilterPane />
        </SidePane>
      )}
      <main className="map-main" aria-label="Map area">
        {hasMap(game) ? <MapPane /> : <NoMap hasPages={hasChecklists} />}
        {__ATLAS_DOWNLOADS__ && pageViews ? <MapPageStatus /> : null}
      </main>
      <SidePane name="details" title="Details">
        <DetailsPane />
      </SidePane>
      <Toast />
      <ProfileDialog />
      {saveDialogOpen ? (
        <Suspense fallback={null}>
          <SaveDialog />
        </Suspense>
      ) : null}
      <MapsDialog />
      <AddMapDialog />
      <ActivityLogDialog />
      <PhotoViewer />
      {packFileOpen ? (
        <Suspense fallback={null}>
          <PackFileDialog />
        </Suspense>
      ) : null}
    </div>
  );
}

/** Where the map would be, in a game with no map: guides and lists only. */
function NoMap({ hasPages }: { hasPages: boolean }) {
  return (
    <div className="no-map" data-testid="no-map">
      <h2>This game has no map</h2>
      <p>Its guides and lists are on the left{hasPages ? '' : ', when it has some'}.</p>
      {hasPages ? (
        <button
          type="button"
          className="button"
          onClick={() => {
            showLeftTab('checklists');
          }}
        >
          Show the guides
        </button>
      ) : null}
    </div>
  );
}

function SidePane({
  name,
  title,
  head,
  children,
}: {
  name: PaneName;
  title: string;
  /** Shown in place of the title, such as tabs that name the pane's parts. */
  head?: React.ReactNode;
  children: React.ReactNode;
}) {
  const open = useAtlas((s) => s.panes[name]);
  return (
    <aside
      id={`${name}-pane`}
      className={`side-pane side-pane-${name}`}
      aria-label={title}
      hidden={!open}
      data-testid={`${name}-pane`}
    >
      <div className="pane-head">
        {head ?? <h1 className="pane-title">{title}</h1>}
        <button
          type="button"
          className="icon-button"
          aria-label={`Close ${title.toLowerCase()}`}
          onClick={() => {
            setPane(name, false);
          }}
        >
          <UiIcon name="close" size={16} />
        </button>
      </div>
      {children}
    </aside>
  );
}

const LEFT_TABS: LeftTab[] = ['filters', 'checklists'];

/**
 * The left pane's tabs: the filters, and the checklists and guides. Arrow
 * keys move between them, as in any tab list.
 */
function LeftTabs({ current }: { current: LeftTab }) {
  const game = useAtlas((s) => s.game)!;
  const label = (tab: LeftTab) => (tab === 'filters' ? 'Filters' : checklistScreenTitle(game));
  return (
    <div
      className="pane-tabs"
      role="tablist"
      aria-label="Left pane"
      onKeyDown={(event) => {
        const step = { ArrowRight: 1, ArrowLeft: -1, Home: -9, End: 9 }[event.key];
        if (step === undefined) return;
        event.preventDefault();
        const index = Math.max(
          0,
          Math.min(LEFT_TABS.length - 1, LEFT_TABS.indexOf(current) + step),
        );
        const next = LEFT_TABS[index]!;
        showLeftTab(next);
        document.getElementById(`left-tab-${next}-tab`)?.focus();
      }}
    >
      {LEFT_TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={`left-tab-${tab}-tab`}
          className="pane-tab"
          aria-selected={tab === current}
          aria-controls={`left-tab-${tab}`}
          tabIndex={tab === current ? 0 : -1}
          onClick={() => {
            showLeftTab(tab);
          }}
        >
          {label(tab)}
        </button>
      ))}
    </div>
  );
}

/** Closes the side panes when the window becomes narrow and restores them when it widens. */
function useWidthClass() {
  const [query] = useState(() => window.matchMedia(NARROW_QUERY));
  useEffect(() => {
    const onChange = (event: MediaQueryListEvent) => {
      void onWidthClassChange(event.matches);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, [query]);
}

/** Mirrors the map view into the URL fragment without adding history entries. */
function useViewHashSync() {
  const view = useAtlas((s) => s.view);
  useEffect(() => {
    if (!view) return;
    const timer = window.setTimeout(() => {
      const hash = formatViewHash({ ...view.center, zoom: view.zoom });
      if (hash !== window.location.hash) {
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${window.location.search}${hash}`,
        );
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
    };
  }, [view]);
}
