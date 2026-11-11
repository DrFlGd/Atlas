import { useEffect, useId, useRef, useState } from 'react';
import { numberFormat } from '../state/derived';
import { downloadsOffered } from '../features';
import { setDownloadPanelOpen } from '../state/downloads';
import {
  STILL_WAITING_SECONDS,
  cancelImport,
  resetImport,
  setAddMapOpen,
  startImport,
  useImport,
  type ImportPhase,
} from '../state/importing';
import { useAtlas } from '../state/store';
import { formatDuration } from './downloadFormat';
import { UiIcon } from './icons';

/**
 * "Add a map", in desktop builds that include importers: paste the address
 * of a map page, wait while the page loads in its own window, and see what
 * was added.
 */
export function AddMapDialog() {
  const open = useAtlas((s) => s.addMapOpen);
  const phase = useImport((s) => s.phase);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const busy = phase.kind === 'waiting' || phase.kind === 'converting';
  const close = () => {
    // Closing while waiting stops the import; while converting it finishes.
    if (phase.kind === 'waiting') void cancelImport();
    setAddMapOpen(false);
  };

  return (
    <dialog
      ref={ref}
      className="dialog add-map-dialog"
      aria-labelledby={titleId}
      data-testid="add-map-dialog"
      data-phase={phase.kind}
      onCancel={(event) => {
        if (phase.kind === 'converting') event.preventDefault();
      }}
      onClose={close}
    >
      {open ? (
        <div className="dialog-body">
          <header className="dialog-head">
            <h2 id={titleId}>Add a map</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close"
              disabled={phase.kind === 'converting'}
              onClick={close}
            >
              <UiIcon name="close" />
            </button>
          </header>
          {phase.kind === 'idle' || phase.kind === 'failed' ? (
            <AddressForm failure={phase.kind === 'failed' ? phase.message : null} />
          ) : null}
          {busy ? <Progress phase={phase} /> : null}
          {phase.kind === 'done' ? <Result phase={phase} /> : null}
        </div>
      ) : null}
    </dialog>
  );
}

function AddressForm({ failure }: { failure: string | null }) {
  const importers = useAtlas((s) => s.config?.importers ?? []);
  const [address, setAddress] = useState('');
  const inputId = useId();
  const hintId = useId();
  return (
    <form
      className="dialog-section add-map-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (address.trim()) void startImport(address);
      }}
    >
      <p className="muted small" id={hintId}>
        Paste the address of a map page. The page opens in a window of its own; if it asks you to
        sign in or to confirm you are a person, do that there. This app reads the map data once the
        page shows it, and then closes the window.
      </p>
      <label htmlFor={inputId} className="field-label">
        Map page address
      </label>
      <div className="inline-form">
        <input
          id={inputId}
          className="text-input"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://"
          aria-describedby={hintId}
          data-testid="add-map-url"
          value={address}
          autoFocus
          onChange={(event) => {
            setAddress(event.target.value);
            if (failure) resetImport();
          }}
        />
        <button
          type="submit"
          className="button button-primary"
          data-testid="add-map-start"
          disabled={!address.trim()}
        >
          Add
        </button>
      </div>
      {failure ? (
        <p className="download-error" role="alert" data-testid="add-map-error">
          {failure}
        </p>
      ) : null}
      {importers.length > 0 ? (
        <div className="muted small">
          <p>This app can add maps from:</p>
          <ul className="importer-list">
            {importers.map((importer) => (
              <li key={importer.id}>
                <strong>{importer.title}</strong>
                {importer.description ? ` — ${importer.description}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </form>
  );
}

function Progress({ phase }: { phase: Extract<ImportPhase, { kind: 'waiting' | 'converting' }> }) {
  if (phase.kind === 'converting') {
    return (
      <section className="dialog-section" aria-busy="true" data-testid="add-map-progress">
        <p role="status">
          <strong>Building the map…</strong> {phase.importer} is turning the page data into a map
          pack.
        </p>
      </section>
    );
  }
  const elapsed = Math.max(0, Math.round((phase.now - phase.startedAt) / 1000));
  const left = Math.max(0, phase.waitSeconds - elapsed);
  return (
    <section className="dialog-section" aria-busy="true" data-testid="add-map-progress">
      <p role="status">
        <strong>{phase.loading ? 'Opening the page…' : 'Waiting for the map data…'}</strong>{' '}
        <span className="muted">{formatDuration(elapsed)} so far</span>
      </p>
      <p className="muted small add-map-url">{phase.url}</p>
      {elapsed >= STILL_WAITING_SECONDS ? (
        <p className="download-note" data-testid="add-map-still-waiting">
          Still waiting. Look at the page window: if it asks you to sign in, to confirm you are a
          person or to wait, deal with it there, or cancel. This app waits{' '}
          {left > 60 ? `about ${Math.ceil(left / 60)} more minutes` : 'less than a minute more'}.
        </p>
      ) : null}
      <div className="row-actions">
        <button
          type="button"
          className="button"
          data-testid="add-map-cancel"
          onClick={() => void cancelImport()}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

function Result({ phase }: { phase: Extract<ImportPhase, { kind: 'done' }> }) {
  const { summary } = phase;
  const downloadable = useAtlas(
    (s) =>
      __ATLAS_DOWNLOADS__ &&
      downloadsOffered(s) &&
      s.game?.entry.id === phase.packId &&
      s.downloads.packFolder !== null,
  );
  return (
    <section className="dialog-section" data-testid="add-map-result">
      <p role="status">
        <strong>
          {phase.rebuilt
            ? `Rebuilt ${summary.game}.`
            : summary.refreshed
              ? `Updated ${summary.map} in ${summary.game}.`
              : `Added ${summary.map} to ${summary.game}.`}
        </strong>
      </p>
      <dl className="add-map-figures">
        <dt>Game</dt>
        <dd data-testid="add-map-game">{summary.game}</dd>
        <dt>Map</dt>
        <dd>{summary.map}</dd>
        <dt>Locations on this map</dt>
        <dd data-testid="add-map-locations">{numberFormat.format(summary.mapLocations)}</dd>
        <dt>Maps in this game</dt>
        <dd>{numberFormat.format(summary.maps)}</dd>
        <dt>Locations in this game</dt>
        <dd>{numberFormat.format(summary.locations)}</dd>
        <dt>Categories</dt>
        <dd>{numberFormat.format(summary.categories)}</dd>
      </dl>
      <p className="muted small">
        {__ATLAS_DOWNLOADS__ && downloadable
          ? 'Its map images are not downloaded yet, so the markers show on a blank map until you download them.'
          : 'Its map images are not installed, so the markers show on a plain background.'}
      </p>
      <div className="row-actions wrap">
        {__ATLAS_DOWNLOADS__ && downloadable ? (
          <button
            type="button"
            className="button button-primary"
            data-testid="add-map-download"
            onClick={() => {
              setAddMapOpen(false);
              setDownloadPanelOpen(true);
            }}
          >
            <UiIcon name="download" size={16} /> Download map images…
          </button>
        ) : null}
        <button
          type="button"
          className="button"
          onClick={() => {
            resetImport();
          }}
        >
          Add another map
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            setAddMapOpen(false);
          }}
        >
          Done
        </button>
      </div>
    </section>
  );
}
