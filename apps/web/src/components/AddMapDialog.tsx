import { useEffect, useId, useRef } from 'react';
import { numberFormat } from '../state/derived';
import { downloadsOffered } from '../features';
import { setDownloadPanelOpen } from '../state/downloads';
import {
  STILL_WAITING_SECONDS,
  cancelImport,
  confirmChecked,
  resetImport,
  setAddMapOpen,
  setDraft,
  stopRun,
  submitAddresses,
  useImport,
  type ImportPhase,
} from '../state/importing';
import {
  MAX_RUN_ADDRESSES,
  parseAddresses,
  runSummary,
  stopReasonText,
  type RunPageState,
  type RunState,
} from '../state/importRun';
import { useAtlas } from '../state/store';
import { formatDuration } from './downloadFormat';
import { UiIcon } from './icons';

/**
 * "Add a map", in desktop builds that include importers: paste the address
 * of a map page, or several, wait while each page loads in its own window,
 * and see what was added.
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
  const running = phase.kind === 'run' && phase.run.status === 'running';
  const close = () => {
    // Closing while waiting stops the import, and a run; while converting it finishes.
    if (phase.kind === 'waiting' || running) void cancelImport();
    setAddMapOpen(false);
  };

  return (
    <dialog
      ref={ref}
      className="dialog add-map-dialog"
      aria-labelledby={titleId}
      data-testid="add-map-dialog"
      data-phase={phase.kind}
      data-run={phase.kind === 'run' ? phase.run.status : undefined}
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
          {phase.kind === 'check' ? <Check phase={phase} /> : null}
          {busy ? <Progress phase={phase} /> : null}
          {phase.kind === 'done' ? <Result phase={phase} /> : null}
          {phase.kind === 'run' ? <Run run={phase.run} shownPackId={phase.shownPackId} /> : null}
        </div>
      ) : null}
    </dialog>
  );
}

function AddressForm({ failure }: { failure: string | null }) {
  const importers = useAtlas((s) => s.config?.importers ?? []);
  const address = useImport((s) => s.draft);
  const inputId = useId();
  const hintId = useId();
  const count = parseAddresses(address).addresses.length;
  const submit = () => {
    if (count > 0) void submitAddresses(address);
  };
  return (
    <form
      className="dialog-section add-map-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="muted small" id={hintId}>
        Paste the address of a map page. The page opens in a window of its own; if it asks you to
        sign in or to confirm you are a person, do that there. This app reads the map data once the
        page shows it, and then closes the window. To add several maps, paste one address per line
        (up to {MAX_RUN_ADDRESSES}): this app opens the pages one at a time, in that order, with a
        short pause between them.
      </p>
      <label htmlFor={inputId} className="field-label">
        Map page addresses
      </label>
      <div className="inline-form add-map-inputs">
        <textarea
          id={inputId}
          className="text-input add-map-addresses"
          rows={count > 1 ? Math.min(8, count + 1) : 2}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://"
          aria-describedby={hintId}
          data-testid="add-map-url"
          value={address}
          autoFocus
          onChange={(event) => {
            setDraft(event.target.value);
            if (failure) resetImport();
          }}
          onKeyDown={(event) => {
            // Enter adds, as in a one-line field; Shift+Enter starts a new line.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="submit"
          className="button button-primary"
          data-testid="add-map-start"
          disabled={count === 0}
        >
          {count > 1 ? `Add ${count} maps` : 'Add'}
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

/** Several addresses, some of which cannot be added: shown before anything opens. */
function Check({ phase }: { phase: Extract<ImportPhase, { kind: 'check' }> }) {
  const usable = phase.addresses.filter((address) => address.importer !== null).length;
  const leftOut = phase.addresses.length - usable;
  return (
    <section className="dialog-section" data-testid="add-map-check">
      <p role="status">
        {usable === 0 ? (
          <strong>None of these addresses can be added.</strong>
        ) : (
          <>
            <strong>
              {leftOut === 1
                ? 'One address cannot be added.'
                : `${leftOut} addresses cannot be added.`}
            </strong>{' '}
            {usable === 1
              ? 'The other one can.'
              : `The other ${usable} can, one at a time, in this order.`}
          </>
        )}
      </p>
      <ol className="add-map-run-list">
        {phase.addresses.map((address) => (
          <li
            key={address.url}
            data-testid="add-map-check-address"
            data-state={address.importer ? 'ready' : 'left-out'}
          >
            <span className="add-map-url">{address.url}</span>
            <span className={address.importer ? 'muted small' : 'add-map-row-problem small'}>
              {address.importer
                ? `Ready to add, with ${address.importer}.`
                : `Left out: ${address.problem ?? ''}`}
            </span>
          </li>
        ))}
      </ol>
      {phase.importers.length > 0 ? (
        <p className="muted small">This app can add maps from: {phase.importers.join(', ')}.</p>
      ) : (
        <p className="muted small">
          This app has no importers, so it cannot add maps from web pages.
        </p>
      )}
      <div className="row-actions wrap">
        {usable > 0 ? (
          <button
            type="button"
            className="button button-primary"
            data-testid="add-map-confirm"
            onClick={() => void confirmChecked()}
          >
            {usable === 1 ? 'Add the other map' : `Add the other ${usable}`}
          </button>
        ) : null}
        <button
          type="button"
          className="button"
          data-testid="add-map-edit"
          onClick={() => {
            resetImport();
          }}
        >
          Change the addresses
        </button>
      </div>
    </section>
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
            setDraft('');
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

/** "12 seconds so far", and after a while what may be holding the page up. */
function OpenPage({ state }: { state: Extract<RunPageState, { kind: 'open' }> }) {
  const elapsed = Math.max(0, Math.round((state.now - state.startedAt) / 1000));
  const left = Math.max(0, state.waitSeconds - elapsed);
  return (
    <>
      <span className="small">
        <strong>
          {state.loading ? 'Open: the page is loading…' : 'Open: waiting for the map data…'}
        </strong>{' '}
        <span className="muted">{formatDuration(elapsed)} so far</span>
      </span>
      {elapsed >= STILL_WAITING_SECONDS ? (
        <span className="download-note small" data-testid="add-map-still-waiting">
          Look at the page window: if it asks you to sign in, to confirm you are a person or to
          wait, deal with it there, or close the window to stop. This app waits{' '}
          {left > 60 ? `about ${Math.ceil(left / 60)} more minutes` : 'less than a minute more'}.
        </span>
      ) : null}
    </>
  );
}

/** The state of one page of a run, in words. */
function PageState({ state }: { state: RunPageState }) {
  switch (state.kind) {
    case 'waiting':
      return <span className="muted small">Waiting</span>;
    case 'open':
      return <OpenPage state={state} />;
    case 'converting':
      return (
        <span className="small">
          <strong>Building the map…</strong>
        </span>
      );
    case 'added':
      return (
        <span className="small">
          {state.refreshed ? 'Refreshed' : 'Added'} “{state.map}”{' '}
          <span className="muted">
            {state.refreshed ? 'in' : 'to'} {state.game}
          </span>
        </span>
      );
    case 'failed':
      return <span className="add-map-row-problem small">Not added: {state.message}</span>;
    case 'not-started':
      return <span className="muted small">Not started</span>;
  }
}

/** Several pages, one after another: each with its state, then a summary. */
function Run({ run, shownPackId }: { run: RunState; shownPackId: string | null }) {
  const running = run.status === 'running';
  // The games maps were added to, by pack id.
  const games = new Map(
    run.pages.flatMap(({ state }) =>
      state.kind === 'added' ? [[state.packId, state.game] as const] : [],
    ),
  );
  const shownGame = (shownPackId && games.get(shownPackId)) ?? 'this game';
  const downloadable = useAtlas(
    (s) =>
      __ATLAS_DOWNLOADS__ &&
      downloadsOffered(s) &&
      shownPackId !== null &&
      s.game?.entry.id === shownPackId &&
      s.downloads.packFolder !== null,
  );
  const done = run.pages.filter(
    ({ state }) => state.kind === 'added' || state.kind === 'failed',
  ).length;
  return (
    <section
      className="dialog-section"
      aria-busy={running}
      data-testid="add-map-run"
      data-status={run.status}
    >
      {running ? (
        <p role="status">
          <strong>
            Adding {run.pages.length} maps, one page at a time: {done} of {run.pages.length} done.
          </strong>{' '}
          {run.pausing ? <span className="muted">Opening the next page in a moment.</span> : null}
        </p>
      ) : (
        <p role="status" data-testid="add-map-summary">
          <strong>{runSummary(run)}.</strong>
        </p>
      )}
      {run.stopReason ? (
        <p
          className={run.stopReason === 'no-data' ? 'download-error' : 'download-note'}
          data-testid="add-map-stopped"
        >
          {stopReasonText(run.stopReason)}
        </p>
      ) : null}
      {running && run.stopRequested ? (
        <p className="download-note" data-testid="add-map-stopping">
          This app stops after the page that is open now. To stop at once, close the page window.
        </p>
      ) : null}
      <ol className="add-map-run-list">
        {run.pages.map((page) => (
          <li key={page.url} data-testid="add-map-run-page" data-state={page.state.kind}>
            <span className="add-map-url">{page.url}</span>
            <PageState state={page.state} />
          </li>
        ))}
      </ol>
      {run.leftOut > 0 ? (
        <p className="muted small">
          {run.leftOut === 1
            ? 'One address was left out, because this app cannot add maps from it.'
            : `${run.leftOut} addresses were left out, because this app cannot add maps from them.`}
        </p>
      ) : null}
      {!running && games.size > 0 ? (
        <p className="muted small" data-testid="add-map-images-note">
          {__ATLAS_DOWNLOADS__ && downloadable
            ? games.size === 1
              ? `Map images of ${shownGame} are not downloaded yet, so the markers show on a blank map until you download them.`
              : `Map images are not downloaded with the maps. ${shownGame} is shown now; to download the images of another game, choose that game in the top bar and download them there.`
            : games.size === 1
              ? 'Its map images are not installed, so the markers show on a plain background.'
              : 'Their map images are not installed, so the markers show on a plain background.'}
        </p>
      ) : null}
      <div className="row-actions wrap">
        {running ? (
          <button
            type="button"
            className="button"
            data-testid="add-map-stop"
            disabled={run.stopRequested}
            onClick={() => {
              stopRun();
            }}
          >
            Stop
          </button>
        ) : (
          <>
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
                <UiIcon name="download" size={16} />{' '}
                {games.size === 1 ? 'Download map images…' : `Download map images of ${shownGame}…`}
              </button>
            ) : null}
            <button
              type="button"
              className="button"
              onClick={() => {
                setDraft('');
                resetImport();
              }}
            >
              Add more maps
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
          </>
        )}
      </div>
    </section>
  );
}
