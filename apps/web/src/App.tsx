import { lazy, Suspense, useEffect, useState } from 'react';
import { ActivityLogDialog } from './components/ActivityLogDialog';
import { ChecklistsPane } from './components/ChecklistsPane';
import { DetailsPane } from './components/DetailsPane';
import { FilterPane } from './components/FilterPane';
import { UiIcon } from './components/icons';
import { MapPageStatus } from './components/MapPageStatus';
import { MapPane } from './components/MapPane';
import { ClassicSceneNote } from './components/MapStage';
import { MapsDialog } from './components/MapsDialog';
import { PackArrivalNote } from './components/PackArrivalNote';
import { PictureViewer } from './components/PictureViewer';
import { GuidebookLayer } from './guidebook/Guidebooks';
import { ProfileDialog } from './components/ProfileDialog';
import { SearchBox } from './components/SearchBox';
import { Toast } from './components/Toast';
import { UpdateNotice } from './components/UpdateNotice';
import { TopBar } from './components/TopBar';
import { downloadsOffered, touchUiOffered } from './features';
import { loadPadSettings } from './input/padState';
import { loadSceneSettings } from './state/scene3d';
import { useShortcuts } from './keyboard';
import { NARROW_QUERY, boot, moveMap, onWidthClassChange, setPane } from './state/actions';
import { checklistScreenTitle, showLeftTab } from './state/checklists';
import { loadGameGroups } from './state/gameGroups';
import { hasMap } from './state/guides';
import { loadGuideLinks, lookForGuideGames } from './state/guideLinks';
import { useLibrary } from './state/libraryView';
import { followBackground } from './state/background';
import { followArrivals } from './state/packArrivals';
import { followKeptPacks } from './state/keptPacks';
import { startUpdateCheck } from './state/updates';
import { loadOwnNotes } from './state/ownNotes';
import { loadOwnRoutes } from './state/ownRoutes';
import { loadOwnPages } from './state/ownPages';
import { loadOwnLists } from './state/ownLists';
import { sweepOwnPicturesOnOpen } from './state/ownPictures';
import { initSaves } from './state/saves';
import { useAtlas, type AtlasState, type LeftTab, type PaneName } from './state/store';
import { inputFor } from './touch/controls';
import { followControls, screenFacts, startControls } from './touch/followControls';
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

// Only the desktop app writes and reads pack files: their dialog is
// loaded the first time it opens, so the bundle every browser loads stays
// as it was.
// The desktop app's Library, over the whole window in this layout.
const LibraryScreen = lazy(() =>
  import('./library/LibraryScreen').then((module) => ({ default: module.LibraryScreen })),
);

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
  const touch = useAtlas((s) => shownOf(s).layout === 'standard');
  const input = useAtlas((s) => shownOf(s).input);
  // The version for fingers on a computer (a Steam Deck, a computer with a
  // touch screen), not on a phone or a tablet, nor as the address asked.
  const handheld = useAtlas(
    (s) => input === 'touch' && !coarse && !touchUiOffered(s) && s.uiRequest !== 'touch',
  );
  // What the standard layout is made for, by the setting "Controls": the
  // start decided again once the shell says which system it runs on.
  const platform = useAtlas((s) => s.app?.platform ?? null);
  useEffect(() => {
    startControls(screenFacts(platform));
  }, [platform]);

  useEffect(() => {
    useAtlas.setState({ uiRequest: requestedUi(window.location.search, sessionStore()) });
    const stopControls = followControls();
    // The other version of the layout makes a new map: it opens where the old one was.
    const stopKeepingView = useAtlas.subscribe((state, previous) => {
      const view = previous.view;
      if (view && shownOf(state).input !== shownOf(previous).input) {
        moveMap(view.center.x, view.center.y, { zoom: view.zoom, animate: false });
      }
    });
    const stopSaves = initSaves();
    // Before the start, so a pack file opened meanwhile is not missed.
    const stopArrivals = followArrivals();
    // A game another program asks for, and the settings changed from the tray.
    const stopBackground = followBackground();
    // The notice of a run of the kept packs that failed comes wherever the person is.
    const stopKeptPacks = followKeptPacks();
    // A quiet look for a new version of Atlas, a few seconds after the start.
    const stopUpdates = startUpdateCheck();
    void boot(parseViewHash(window.location.hash));
    return () => {
      stopUpdates();
      stopControls();
      stopKeepingView();
      stopSaves();
      stopArrivals();
      stopBackground();
      stopKeptPacks();
    };
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
  // Their own notes on the game's locations.
  useEffect(() => {
    if (!game) return;
    void loadOwnNotes(game);
  }, [game]);
  // Their own routes of the game.
  useEffect(() => {
    if (!game) return;
    void loadOwnRoutes(game);
  }, [game]);
  // The games they show under one title, once the app knows where they are kept.
  const booted = game !== null;
  useEffect(() => {
    if (booted) void loadGameGroups();
  }, [booted]);
  // The settings of a controller, once the store with the settings is open.
  const configured = useAtlas((s) => s.config !== null);
  useEffect(() => {
    if (configured) {
      void loadPadSettings();
      void loadSceneSettings();
    }
  }, [configured]);

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
        <TouchShell key={input} input={input} handheld={handheld} />
      </Suspense>
    );
  }
  return <Shell />;
}

/** What the app shows (see `touch/uiMode.ts`). */
function shownOf(s: AtlasState) {
  return shownUi({
    android: touchUiOffered(s),
    requested: s.uiRequest,
    saved: s.layout,
    input: inputFor(s.controls, s.autoInput.input),
  });
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
  const libraryOpen = useLibrary((s) => s.windowOpen);
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
        {hasMap(game) ? <ClassicSceneNote /> : null}
        {__ATLAS_DOWNLOADS__ && pageViews ? <MapPageStatus /> : null}
      </main>
      <SidePane name="details" title="Details">
        <DetailsPane />
      </SidePane>
      <PackArrivalNote />
      <UpdateNotice />
      <Toast />
      <ProfileDialog />
      {saveDialogOpen ? (
        <Suspense fallback={null}>
          <SaveDialog />
        </Suspense>
      ) : null}
      {libraryOpen ? (
        <Suspense fallback={null}>
          <LibraryScreen mode="window" />
        </Suspense>
      ) : null}
      <MapsDialog />
      <ActivityLogDialog />
      <PictureViewer />
      <GuidebookLayer />
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
