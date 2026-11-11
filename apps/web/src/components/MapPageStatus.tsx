import {
  closeMapPage,
  countPhrases,
  dismissMapPage,
  headline,
  problemNotes,
  shouldShow,
  stopSaving,
  usePageView,
} from '../state/pageView';
import { useAtlas } from '../state/store';
import { UiIcon } from './icons';
import '../styles/pageView.css';

/**
 * A card over the map while the map page window is open: whether map images
 * are being saved, how many were saved, were there already or could not be
 * saved, and buttons to stop saving and to close the page. After the window
 * closes it stays until dismissed, with the final counts.
 */
export function MapPageStatus() {
  const status = usePageView((s) => s.status);
  const pending = usePageView((s) => s.pending);
  const title = useAtlas((s) =>
    status?.packId ? s.catalog.find((p) => p.id === status.packId)?.title : undefined,
  );
  if (!shouldShow(status)) return null;
  const state = status.open ? (status.saving ? 'saving' : 'open') : 'closed';
  const [saved, had, notSaved] = countPhrases(status.counts);
  const notes = problemNotes(status);
  return (
    <section
      className="map-page-status"
      aria-label="Map page"
      data-testid="map-page-status"
      data-state={state}
    >
      <div className="download-head">
        <h2>
          {status.saving ? <span className="map-page-dot" aria-hidden="true" /> : null}
          {headline(status)}
        </h2>
        {!status.open ? (
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss"
            data-testid="map-page-dismiss"
            onClick={dismissMapPage}
          >
            <UiIcon name="close" size={16} />
          </button>
        ) : null}
      </div>
      {title ? <p className="muted small map-page-game">{title}</p> : null}
      {status.savedSession ? (
        <ul className="map-page-counts" aria-live="polite">
          <li data-testid="map-page-saved" data-count={status.counts.saved}>
            {saved}
          </li>
          <li data-testid="map-page-had" data-count={status.counts.alreadyHad}>
            {had}
          </li>
          <li
            data-testid="map-page-not-saved"
            data-count={status.counts.notSaved}
            className={status.counts.notSaved > 0 ? 'map-page-warn' : undefined}
          >
            {notSaved}
          </li>
        </ul>
      ) : (
        <p className="muted small">
          It is open in its own window, just to look at. Nothing is saved from it.
        </p>
      )}
      {notes.map((note) => (
        <p key={note} className="small map-page-note" data-testid="map-page-note">
          {note}
        </p>
      ))}
      {status.message ? <p className="small map-page-note">{status.message}</p> : null}
      {status.open ? (
        <div className="row-actions wrap">
          {status.saving ? (
            <button
              type="button"
              className="button button-small button-primary"
              data-testid="map-page-stop"
              disabled={pending}
              onClick={() => void stopSaving()}
            >
              Stop saving
            </button>
          ) : null}
          <button
            type="button"
            className="button button-small"
            data-testid="map-page-close"
            disabled={pending}
            onClick={() => void closeMapPage()}
          >
            Close the map page
          </button>
        </div>
      ) : null}
      {status.saving ? (
        <p className="muted small">Closing the map page window also stops saving.</p>
      ) : null}
    </section>
  );
}
