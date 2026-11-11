import type { ListedPack } from '../desktop';
import {
  loadPages,
  openMapPage,
  openPageInBrowser,
  pageLabel,
  usePageView,
} from '../state/pageView';
import '../styles/pageView.css';

/**
 * In the Maps dialog, for a pack added from a web page: the page (or pages)
 * it was made from, with "View map page", "View map page and save images as
 * I browse" and "Open in my browser".
 */
export function MapPageActions({ pack }: { pack: ListedPack }) {
  const entry = usePageView((s) => s.pages[pack.id]);
  const pending = usePageView((s) => s.pending);
  const status = usePageView((s) => s.status);
  return (
    <details
      className="map-page-details"
      data-testid="map-page-details"
      onToggle={(event) => {
        const details = event.currentTarget;
        if (!details.open) return;
        void loadPages(pack.id).then(() => {
          // The pack list scrolls; show what just opened.
          details.scrollIntoView({ block: 'nearest' });
        });
      }}
    >
      <summary className="link-button">Map page…</summary>
      {entry?.state === 'loading' ? <p className="muted small">Looking…</p> : null}
      {entry?.state === 'failed' ? <p className="download-error">{entry.message}</p> : null}
      {entry?.state === 'ready' && entry.info.pages.length === 0 ? (
        <p className="muted small">This map pack does not say which page it was made from.</p>
      ) : null}
      {entry?.state === 'ready' && entry.info.pages.length > 0 ? (
        <>
          <ul className="map-page-list">
            {entry.info.pages.map((page) => {
              const isOpen = status?.open && status.packId === pack.id && status.url === page.url;
              return (
                <li key={page.url} className="map-page-item" data-testid="map-page">
                  <span className="map-page-name">
                    {pageLabel(page)}
                    {isOpen ? (
                      <span className="badge">{status.saving ? 'Saving images' : 'Open'}</span>
                    ) : null}
                  </span>
                  <span className="path small">{page.url}</span>
                  <div className="row-actions wrap">
                    <button
                      type="button"
                      className="button button-small"
                      data-testid="map-page-view"
                      disabled={pending}
                      title="Open the page in a window of this app, just to look at it"
                      onClick={() => void openMapPage(pack.id, page.url, false)}
                    >
                      View map page
                    </button>
                    {entry.info.canSave ? (
                      <button
                        type="button"
                        className="button button-small button-primary"
                        data-testid="map-page-save"
                        disabled={pending}
                        title="Open the page in a window of this app and keep the map images it shows while you pan and zoom it"
                        onClick={() => void openMapPage(pack.id, page.url, true)}
                      >
                        View map page and save images as I browse
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="button button-small"
                      data-testid="map-page-browser"
                      disabled={pending}
                      onClick={() => void openPageInBrowser(pack.id, page.url)}
                    >
                      Open in my browser
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {entry.info.canSave ? (
            <p className="muted small">
              Saving keeps a copy of the map images the page shows you while you pan and zoom it
              yourself. Nothing extra is downloaded. Start zoomed out, so the whole map is saved
              first, then zoom in where you want detail.
            </p>
          ) : entry.info.saveNote ? (
            <p className="muted small">{entry.info.saveNote}</p>
          ) : null}
        </>
      ) : null}
    </details>
  );
}
