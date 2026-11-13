import { useEffect, useId, useRef, useState } from 'react';
import { numberFormat } from '../state/derived';
import { downloadsOffered } from '../features';
import { setDownloadPanelOpen } from '../state/downloads';
import {
  STILL_WAITING_SECONDS,
  browseGames,
  cancelImport,
  catalogueImporters,
  confirmChecked,
  pictureText,
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
import { CataloguePick, ChoosePages, Listing, UpdateGames } from './GameChoice';
import { UiIcon } from './icons';
import { MeasureFromPage } from './MeasureFromPage';

/**
 * "Add a map", in desktop builds that include importers: paste the address
 * of a map page, or several, wait while each page loads in its own window,
 * and see what was added. A game's address, or a site's list of games,
 * first lists what there is to choose from (see `GameChoice.tsx`).
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
  const running =
    (phase.kind === 'run' || phase.kind === 'listing') && phase.run.status === 'running';
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
      data-run={phase.kind === 'run' || phase.kind === 'listing' ? phase.run.status : undefined}
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
          {phase.kind === 'run' ? (
            <Run run={phase.run} shownPackId={phase.shownPackId} update={phase.update} />
          ) : null}
          {phase.kind === 'listing' ? (
            <Listing run={phase.run} purpose={phase.purpose} PageState={PageState} />
          ) : null}
          {phase.kind === 'catalogue' ? <CataloguePick pick={phase.pick} /> : null}
          {phase.kind === 'update-games' ? <UpdateGames phase={phase} /> : null}
          {phase.kind === 'choose' ? <ChoosePages choice={phase.choice} /> : null}
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
  const { addresses } = parseAddresses(address);
  const count = addresses.length;
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
        short pause between them. When typing, Shift+Enter starts a new line and Enter adds.
      </p>
      <p className="muted small">
        You can also paste the address of a game’s own page, where the site lists its maps: this app
        reads that page and lists the maps for you to choose from.
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
      {__ATLAS_DOWNLOADS__ ? <MeasureFromPage urls={addresses} /> : null}
      {failure ? (
        <p className="download-error" role="alert" data-testid="add-map-error">
          {failure}
        </p>
      ) : null}
      <BrowseGames />
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

/** "Browse games…": one button for each importer that offers a list of games. */
function BrowseGames() {
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof catalogueImporters>>>([]);
  useEffect(() => {
    let live = true;
    catalogueImporters().then(
      (found) => {
        if (live) setEntries(found);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  if (entries.length === 0) return null;
  return (
    <div className="add-map-browse" data-testid="add-map-browse">
      <p className="muted small">
        Or choose games from a site’s list of games. This app opens the list in a window of its own,
        and you tick the games to add.
      </p>
      <div className="row-actions wrap">
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="button"
            data-testid="add-map-browse-games"
            data-importer={entry.id}
            title={entry.address}
            onClick={() => void browseGames(entry.id)}
          >
            {entry.label}…
          </button>
        ))}
      </div>
    </div>
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
        {phase.measuring ? (
          <p role="status">
            <strong>Measuring the map picture…</strong> Atlas is asking the image server which map
            images exist, so that the map is as large as its picture. This can take a minute.
          </p>
        ) : (
          <p role="status">
            <strong>Building the map…</strong> {phase.importer} is turning the page data into a map
            pack.
            {__ATLAS_DOWNLOADS__
              ? ' When a map’s size changes, the map images you already downloaded are fitted to it, which can take a minute.'
              : null}
          </p>
        )}
      </section>
    );
  }
  const elapsed = Math.max(0, Math.round((phase.now - phase.startedAt) / 1000));
  const left = Math.max(0, phase.waitSeconds - elapsed);
  return (
    <section className="dialog-section" aria-busy="true" data-testid="add-map-progress">
      <p role="status">
        <strong>
          {phase.measuring
            ? 'Measuring the map picture from the page…'
            : phase.loading
              ? 'Opening the page…'
              : 'Waiting for the map data…'}
        </strong>{' '}
        <span className="muted">{formatDuration(elapsed)} so far</span>
      </p>
      <p className="muted small add-map-url">{phase.url}</p>
      {phase.measuring ? (
        <p className="download-note" data-testid="add-map-measuring">
          The map data has been read. This app is now zooming the page out with the page’s own
          zoom-out button and noting which map images it loads. Leave the page window as it is; it
          closes by itself, in two minutes at most.
        </p>
      ) : elapsed >= STILL_WAITING_SECONDS ? (
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
      {summary.checklist && !phase.rebuilt ? (
        <ChecklistResult checklist={summary.checklist} />
      ) : (
        <MapFigures phase={phase} downloadable={downloadable} />
      )}
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

/** The figures of a map that was added. */
function MapFigures({
  phase,
  downloadable,
}: {
  phase: Extract<ImportPhase, { kind: 'done' }>;
  downloadable: boolean;
}) {
  const { summary } = phase;
  return (
    <>
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
        <dt>Types</dt>
        <dd>{numberFormat.format(summary.categories)}</dd>
      </dl>
      {summary.picture ? (
        <p className="small" data-testid="add-map-picture">
          {pictureText(summary.picture)}
        </p>
      ) : null}
      <p className="muted small">
        {__ATLAS_DOWNLOADS__ && downloadable
          ? 'Its map images are not downloaded yet, so the markers show on a blank map until you download them.'
          : 'Its map images are not installed, so the markers show on a plain background.'}
      </p>
    </>
  );
}

/** What a checklist page became. */
function ChecklistResult({ checklist }: { checklist: { items: number; leftOut: number } }) {
  return (
    <p data-testid="add-map-checklist">
      {checklist.items === 1
        ? 'It has 1 item'
        : `It has ${numberFormat.format(checklist.items)} items`}
      {checklist.leftOut > 0
        ? `. ${checklist.leftOut === 1 ? '1 row was' : `${numberFormat.format(checklist.leftOut)} rows were`} left out, because their locations are on maps that are not in this app yet; they are added when you add those maps.`
        : ', each one a location on the maps of this game.'}
    </p>
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
          {state.measuring
            ? 'Open: measuring the map picture from the page…'
            : state.loading
              ? 'Open: the page is loading…'
              : 'Open: waiting for the map data…'}
        </strong>{' '}
        <span className="muted">{formatDuration(elapsed)} so far</span>
      </span>
      {state.measuring ? null : elapsed >= STILL_WAITING_SECONDS ? (
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
          <strong>{state.measuring ? 'Measuring the map picture…' : 'Building the map…'}</strong>
        </span>
      );
    case 'added':
      return (
        <span className="small">
          {state.refreshed ? 'Refreshed' : 'Added'} “{state.map}”{' '}
          <span className="muted">
            {state.refreshed ? 'in' : 'to'} {state.game}
            {state.checklist
              ? `, a checklist of ${state.checklist.items} ${state.checklist.items === 1 ? 'item' : 'items'}${
                  state.checklist.leftOut > 0
                    ? ` (${state.checklist.leftOut} left out until their maps are added)`
                    : ''
                }`
              : ''}
            {state.picture
              ? state.picture.page?.used
                ? `; map picture measured from the page (${state.picture.page.images} map images)`
                : state.picture.measured
                  ? `; map picture measured${state.picture.tiles === undefined ? '' : ` (${state.picture.tiles} map images)`}`
                  : '; map picture not measured, sized from the locations'
              : ''}
          </span>
        </span>
      );
    case 'listed':
      return (
        <span className="small" data-testid="add-map-listed">
          {state.game
            ? `Read the list of “${state.game}”: ${state.count} ${state.count === 1 ? 'page' : 'pages'} this app can add${
                state.other > 0 ? `, ${state.other} it cannot add yet` : ''
              }.`
            : `Read the list: ${numberFormat.format(state.count)} ${state.count === 1 ? 'game' : 'games'}.`}
        </span>
      );
    case 'failed':
      return <span className="add-map-row-problem small">Not added: {state.message}</span>;
    case 'not-started':
      return <span className="muted small">Not started</span>;
  }
}

/** Several pages, one after another: each with its state, then a summary. */
function Run({
  run,
  shownPackId,
  update,
}: {
  run: RunState;
  shownPackId: string | null;
  update: boolean;
}) {
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
            {update ? 'Updating' : 'Adding'} {run.pages.length}{' '}
            {run.pages.length === 1 ? 'page' : 'pages'}, one page at a time: {done} of{' '}
            {run.pages.length} done.
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
