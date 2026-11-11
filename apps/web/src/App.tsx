import { useEffect, useState } from 'react';
import { ActivityLogDialog } from './components/ActivityLogDialog';
import { AddMapDialog } from './components/AddMapDialog';
import { DetailsPane } from './components/DetailsPane';
import { FilterPane } from './components/FilterPane';
import { UiIcon } from './components/icons';
import { MapPane } from './components/MapPane';
import { MapsDialog } from './components/MapsDialog';
import { ProfileDialog } from './components/ProfileDialog';
import { SearchBox } from './components/SearchBox';
import { Toast } from './components/Toast';
import { TopBar } from './components/TopBar';
import { useShortcuts } from './keyboard';
import { NARROW_QUERY, boot, onWidthClassChange, setPane } from './state/actions';
import { useAtlas, type PaneName } from './state/store';
import { formatViewHash, parseViewHash } from './viewHash';

/** Loads the configuration and the first pack, then shows the three-pane layout. */
export function App() {
  const status = useAtlas((s) => s.status);
  const game = useAtlas((s) => s.game);

  useEffect(() => {
    void boot(parseViewHash(window.location.hash));
  }, []);

  useViewHashSync();
  useWidthClass();
  useShortcuts();

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
  return <Shell />;
}

function Shell() {
  const panes = useAtlas((s) => s.panes);
  const loading = useAtlas((s) => s.status.kind === 'loading');
  const persistent = useAtlas((s) => s.persistent);
  return (
    <div
      className="shell"
      data-filters={panes.filters ? 'open' : 'closed'}
      data-details={panes.details ? 'open' : 'closed'}
      data-storage={persistent ? 'saved' : 'memory'}
      aria-busy={loading}
    >
      <TopBar search={<SearchBox />} />
      <SidePane name="filters" title="Filters">
        <FilterPane />
      </SidePane>
      <main className="map-main" aria-label="Map area">
        <MapPane />
      </main>
      <SidePane name="details" title="Details">
        <DetailsPane />
      </SidePane>
      <Toast />
      <ProfileDialog />
      <MapsDialog />
      <AddMapDialog />
      <ActivityLogDialog />
    </div>
  );
}

function SidePane({
  name,
  title,
  children,
}: {
  name: PaneName;
  title: string;
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
        <h1 className="pane-title">{title}</h1>
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
