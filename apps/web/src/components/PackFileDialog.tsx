import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  desktop,
  type ContentCounts,
  type Detail,
  type PackDetails,
  type PackFileExported,
  type PackFileHeader,
  type PackFileInfo,
  type PackFileOptions,
  type PackFileProgress,
  type PickedPackFile,
} from '../desktop';
import { useGameFacts } from '../state/gameFacts';
import { presentMembers, useSourceFacts, useTitleOf } from '../state/gameGroups';
import {
  cancelPackFile,
  closePackFileDialog,
  exportPackFile,
  importPackFile,
  loadExportOptions,
  loadPackDetails,
  packFileProgress,
} from '../state/packFile';
import { useAtlas } from '../state/store';
import { formatBytes } from './downloadFormat';
import { UiIcon } from './icons';
import { When } from './PackFacts';
import {
  compareWithInstalled,
  contentsText,
  DETAIL_LABELS,
  exportHolds,
  freshnessText,
  holdsNamesText,
  imagesDownloadedAt,
  imagesText,
  installedImagesText,
  mineHint,
  mineLabel,
  packKind,
  photosHint,
  photosLabel,
  PICTURES_IN_FILE_LABELS,
  picturesInFileText,
  replaceText,
  savedText,
  sourceText,
  wikisApartText,
  type PackKind,
  type PicturesInFile,
} from './packFileText';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Counts of a game not read yet. */
const NO_CONTENTS: ContentCounts = {
  maps: 0,
  layers: 0,
  locations: 0,
  categories: 0,
  regions: 0,
  checklists: 0,
  guides: 0,
};

/** Said when exporting a game kept for personal use; the export itself is not held back. */
export const PERSONAL_USE_EXPORT =
  'This game is kept for personal use. The file is for your own devices.';

/** What each level of detail puts in a pack file of a game with a map. */
const DETAIL_DESCRIPTIONS: Record<Detail, string> = {
  overview: 'The smallest file. Good for finding your way; blurry when zoomed in close.',
  standard: 'Sharp at most zoom levels, at about a quarter of the size of full detail.',
  full: 'Every level of the map images downloaded. The largest file.',
};

/**
 * "Export to a file…" and "Import a pack file…", in the desktop app: one game in one
 * `.atlaspack` file, to copy to another computer or to Atlas for Android.
 * A game with a map goes with the map images chosen; a game of pages and
 * pictures with no map (a wiki) goes with its pages, and the dialog speaks
 * of pages and pictures and offers no detail. Shown over the Maps dialog.
 * While a file is being written or read the dialog stays open, with a
 * Cancel button. In the Android app it imports only, after showing the
 * picked file being copied into the app.
 */
export function PackFileDialog() {
  const state = useAtlas((s) => s.packFileDialog);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (state && !dialog.open) dialog.showModal();
    if (!state && dialog.open) dialog.close();
  }, [state]);

  if (!desktop) return null;
  return (
    <dialog
      ref={ref}
      className="dialog pack-file-dialog"
      aria-labelledby={titleId}
      data-testid="pack-file-dialog"
      onCancel={(event) => {
        // Escape does not close it while a file is being written or read.
        if (busy) event.preventDefault();
      }}
      onClose={() => {
        setBusy(false);
        closePackFileDialog();
      }}
    >
      {state ? (
        <div className="dialog-body">
          <header className="dialog-head">
            <h2 id={titleId}>
              {state.kind === 'export' ? `Export ${state.title}` : 'Import a pack file'}
            </h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close"
              disabled={busy}
              onClick={closePackFileDialog}
            >
              <UiIcon name="close" />
            </button>
          </header>
          {state.kind === 'export' ? (
            <ExportView
              key={state.packId}
              packId={state.packId}
              title={state.title}
              setBusy={setBusy}
            />
          ) : state.kind === 'copy' ? (
            <CopyView picked={state.picked} setBusy={setBusy} />
          ) : (
            <ImportView key={state.file.path} file={state.file} setBusy={setBusy} />
          )}
        </div>
      ) : null}
    </dialog>
  );
}

/** How far the file being written or read is, asked every 400 ms while mounted. */
function useJobProgress(): PackFileProgress | null {
  const [progress, setProgress] = useState<PackFileProgress | null>(null);
  useEffect(() => {
    let live = true;
    const look = () => {
      packFileProgress().then(
        (now) => {
          if (live) setProgress(now);
        },
        () => undefined,
      );
    };
    look();
    const timer = window.setInterval(look, 400);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);
  return progress;
}

/** Shown while a file is being written, read or (on Android) copied into the app. */
function JobProgress({ verb }: { verb: string }) {
  const progress = useJobProgress();
  // Pictures made smaller before anything is written: counted by pictures.
  const shrinking =
    progress !== null && progress.entriesTotal === 0 && (progress.picturesTotal ?? 0) > 0;
  const done = (shrinking ? progress.picturesDone : progress?.bytesDone) ?? 0;
  const total = (shrinking ? progress.picturesTotal : progress?.bytesTotal) ?? 0;
  const pictureCount = (count: number) => count.toLocaleString('en');
  return (
    <div className="download-overall" data-testid="pack-file-progress">
      <span className="download-figures">
        <span>{verb}…</span>
        <span className="muted small">
          {shrinking
            ? `Making the pictures smaller: ${pictureCount(done)} of ${pictureCount(total)}`
            : progress && progress.entriesTotal > 0
              ? `${progress.entriesDone.toLocaleString('en')} of ${progress.entriesTotal.toLocaleString('en')} files · ${formatBytes(done)} of ${formatBytes(total)}`
              : progress?.kind === 'copy' && total > 0
                ? `${formatBytes(done)} of ${formatBytes(total)}`
                : 'Starting…'}
        </span>
      </span>
      <span
        className="meter"
        role="progressbar"
        aria-label={verb}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={
          shrinking
            ? `${pictureCount(done)} of ${pictureCount(total)} pictures`
            : `${formatBytes(done)} of ${formatBytes(total)}`
        }
      >
        <span className="meter-fill" style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
      </span>
      <div className="row-actions">
        <button
          type="button"
          className="button"
          data-testid="pack-file-cancel"
          disabled={progress?.cancelling === true}
          onClick={() => void cancelPackFile()}
        >
          {progress?.cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

/**
 * Android: the picked file being copied into the app, before the import
 * dialog shows what is in it. Cancel stops the copy and keeps nothing.
 */
function CopyView({
  picked,
  setBusy,
}: {
  picked: PickedPackFile;
  setBusy: (busy: boolean) => void;
}) {
  useEffect(() => {
    setBusy(true);
    return () => {
      setBusy(false);
    };
  }, [setBusy]);
  return (
    <div className="download-body">
      <p className="path" data-testid="copy-file">
        {picked.fileName}
        {picked.size !== null ? <span className="muted"> ({formatBytes(picked.size)})</span> : null}
      </p>
      <p className="download-note" data-testid="copy-note">
        <strong>{picked.title}</strong>. The file is copied into the app first; then you see what
        importing it does. The copy is deleted when the import is over.
      </p>
      <JobProgress verb="Copying the file into the app" />
    </div>
  );
}

function ExportView({
  packId,
  title,
  setBusy,
}: {
  packId: string;
  title: string;
  setBusy: (busy: boolean) => void;
}) {
  const name = useId();
  const [options, setOptions] = useState<PackFileOptions | null>(null);
  const [chosen, setChosen] = useState<Detail | null>(null);
  const [withProgress, setWithProgress] = useState(false);
  // A game made in the app is mostly the person's own: theirs go with it unless they say not.
  const madeInApp = useAtlas(
    (s) => s.library?.packs.find((pack) => pack.id === packId)?.madeInApp === true,
  );
  const [withMine, setWithMine] = useState(madeInApp);
  const personalUse = useAtlas(
    (s) => s.library?.packs.find((pack) => pack.id === packId)?.personalUse === true,
  );
  const mineId = useId();
  // Off until asked for: a file with them is one to keep, not to pass on.
  const [withPhotos, setWithPhotos] = useState(false);
  const photosId = useId();
  // Full size until asked otherwise: the file is then as large as the pictures here.
  const [picturesInFile, setPicturesInFile] = useState<PicturesInFile>('full');
  const sizeName = useId();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PackFileExported | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the game holds: what the Library read already, then what the shell says now.
  const known = useGameFacts((s) => s.byId[packId]?.details?.contents ?? null);
  const [contents, setContents] = useState(known);
  const kind: PackKind | null = contents ? packKind(contents) : null;
  // The wikis shown with this game under one title: never in its file.
  const group = useTitleOf(packId);
  const sourceFacts = useSourceFacts(group);
  const catalog = useAtlas((s) => s.catalog);
  const wikis = group
    ? presentMembers(group, catalog).flatMap((entry) => {
        const facts = sourceFacts[entry.id];
        return entry.id !== packId && facts?.maps.length === 0 ? [facts.title] : [];
      })
    : [];

  useEffect(() => {
    let live = true;
    loadPackDetails(packId).then(
      (details) => {
        if (live) setContents(details.contents);
      },
      // Without them the dialog speaks of a game with a map, as it always did.
      () => {
        if (live) setContents((before) => before ?? { ...NO_CONTENTS, maps: 1 });
      },
    );
    loadExportOptions(packId).then(
      (loaded) => {
        if (!live) return;
        setOptions(loaded);
        // The most detail there is: what this computer has.
        setChosen(loaded.details.findLast((option) => option.available)?.detail ?? null);
      },
      (reason: unknown) => {
        if (live) setError(errorText(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [packId]);

  const ownUse = options?.ownUsePictures ?? 0;
  // The pictures the file would carry, and their bytes at full size.
  const carried = (options?.pictures ?? 0) + (withPhotos ? ownUse : 0);
  const carriedBytes =
    (options?.pictureBytes ?? 0) + (withPhotos ? (options?.ownUsePictureBytes ?? 0) : 0);
  // Offered by a shell that can make them smaller, for a game with pictures.
  const sizeOffered = options?.pictures !== undefined && (options.pictures > 0 || ownUse > 0);

  const start = (detail: Detail) => {
    setError(null);
    setRunning(true);
    setBusy(true);
    exportPackFile(
      packId,
      detail,
      withProgress,
      withMine,
      withPhotos && ownUse > 0,
      sizeOffered && carried > 0 && picturesInFile === 'smaller',
    )
      .then(setResult, (reason: unknown) => {
        setError(errorText(reason));
      })
      .finally(() => {
        setRunning(false);
        setBusy(false);
      });
  };

  const pages = kind === 'pages';
  // For a game of pages it decides whether the pictures of the pages go, so it comes first.
  const photosBox =
    options && kind && ownUse > 0 ? (
      <label className="checkbox-row pack-file-check">
        <input
          type="checkbox"
          data-testid="export-with-photos"
          aria-labelledby={`${photosId}-name`}
          aria-describedby={`${photosId}-hint`}
          checked={withPhotos}
          disabled={running}
          onChange={(event) => {
            setWithPhotos(event.target.checked);
          }}
        />
        <span>
          <span id={`${photosId}-name`}>{photosLabel(kind)}</span>
          <span id={`${photosId}-hint`} className="muted small pack-file-hint">
            {photosHint(ownUse, formatBytes(options.ownUsePictureBytes ?? 0), kind)}
          </span>
        </span>
      </label>
    ) : null;
  const apart = kind === 'map' ? wikisApartText(wikis) : null;
  if (result) return <ExportResult result={result} pictures={carried} />;
  return (
    <div className="download-body">
      {kind ? (
        <p className="download-intro" data-testid="export-intro">
          A pack file holds <strong>{title}</strong> in one file:{' '}
          {exportHolds(kind, { shared: options?.pictures ?? 0, ownUse })} Your progress is not in
          this file. Tick below to save it in a second file.
        </p>
      ) : null}
      {apart ? (
        <p className="download-intro" data-testid="export-wikis-apart">
          {apart}
        </p>
      ) : null}
      {personalUse ? (
        <p className="download-intro" data-testid="export-personal-use">
          {PERSONAL_USE_EXPORT}
        </p>
      ) : null}
      {error ? (
        <p className="download-error" role="alert" data-testid="pack-file-error">
          {error}
        </p>
      ) : null}
      {!options || !kind ? (
        error ? null : (
          <p className="muted small" data-testid="export-looking">
            {kind === 'pages'
              ? 'Looking at the pages and pictures…'
              : kind === 'map'
                ? 'Looking at the map images…'
                : 'Looking at what this game holds…'}
          </p>
        )
      ) : !options.exportable ? (
        <p className="download-error" data-testid="export-refused">
          {options.reason}
        </p>
      ) : (
        <>
          {pages ? null : (
            <fieldset className="detail-options" disabled={running}>
              <legend className="visually-hidden">How much detail</legend>
              {options.details.map((option) => (
                <label
                  key={option.detail}
                  className="detail-option"
                  data-detail={option.detail}
                  data-testid="export-detail"
                  aria-disabled={!option.available}
                >
                  <input
                    type="radio"
                    name={name}
                    value={option.detail}
                    disabled={!option.available}
                    checked={chosen === option.detail}
                    onChange={() => {
                      setChosen(option.detail);
                    }}
                  />
                  <span className="detail-text">
                    <span className="detail-label">{DETAIL_LABELS[option.detail]}</span>
                    <span className="detail-description">{DETAIL_DESCRIPTIONS[option.detail]}</span>
                    <span className="detail-numbers" data-testid={`export-${option.detail}`}>
                      {option.available
                        ? `${option.images.toLocaleString('en')} map image${option.images === 1 ? '' : 's'} · about ${formatBytes(option.bytes)}`
                        : option.reason}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {options.wholeLayers.length > 0 ? (
            <p className="download-note" data-testid="export-whole-layers">
              The map images of {options.wholeLayers.join(', ')} come with the game, so they are
              included whole at every detail and counted in each size.
            </p>
          ) : null}
          {options.downloading ? (
            <p className="download-note" role="status">
              {pages ? 'Pictures' : 'Map images'} of this game are downloading. Pause or cancel that
              first, then export.
            </p>
          ) : null}
          {pages ? photosBox : null}
          <label className="checkbox-row pack-file-check">
            <input
              type="checkbox"
              data-testid="export-with-progress"
              checked={withProgress}
              disabled={running}
              onChange={(event) => {
                setWithProgress(event.target.checked);
              }}
            />
            <span>
              Also save my progress beside it
              <span className="muted small pack-file-hint">
                A second file next to the pack file, ending in <code>.progress.json</code>. It holds
                the progress of every game and profile, as “Export all profiles” saves it. Import it
                under Profiles on the other device.
              </span>
            </span>
          </label>
          <label className="checkbox-row pack-file-check">
            <input
              type="checkbox"
              data-testid="export-with-mine"
              aria-labelledby={`${mineId}-name`}
              aria-describedby={`${mineId}-hint`}
              checked={withMine}
              disabled={running}
              onChange={(event) => {
                setWithMine(event.target.checked);
              }}
            />
            <span>
              <span id={`${mineId}-name`}>{mineLabel(kind, contents ?? NO_CONTENTS)}</span>
              <span id={`${mineId}-hint`} className="muted small pack-file-hint">
                {mineHint(kind, contents ?? NO_CONTENTS)}
              </span>
            </span>
          </label>
          {pages ? null : photosBox}
          {sizeOffered ? (
            <fieldset
              className="detail-options pack-file-pictures"
              disabled={running || carried === 0}
              data-testid="export-picture-size"
            >
              <legend className="pack-file-legend">Pictures in the file</legend>
              {(['full', 'smaller'] as const).map((choice) => (
                <label
                  key={choice}
                  className="detail-option"
                  data-testid={`export-pictures-${choice}`}
                >
                  <input
                    type="radio"
                    name={sizeName}
                    value={choice}
                    checked={picturesInFile === choice}
                    onChange={() => {
                      setPicturesInFile(choice);
                    }}
                  />
                  <span className="detail-text">
                    <span className="detail-label">{PICTURES_IN_FILE_LABELS[choice]}</span>
                    <span className="detail-description">
                      {picturesInFileText(choice, carried, formatBytes(carriedBytes))}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          {running ? (
            <JobProgress
              verb={
                pages ? 'Saving the pages and pictures in the pack file' : 'Saving the pack file'
              }
            />
          ) : (
            <div className="row-actions">
              <button
                type="button"
                className="button button-primary"
                data-testid="export-start"
                disabled={!chosen || options.downloading}
                onClick={() => {
                  if (chosen) start(chosen);
                }}
              >
                Export
              </button>
              <button type="button" className="button" onClick={closePackFileDialog}>
                Cancel
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Data read from pages on <date> and map images downloaded on <date>, as far as recorded. */
function DatesLine({ header }: { header: PackFileHeader }) {
  const pages = header.source.newestPageAt;
  const images = imagesDownloadedAt(header);
  const parts: ReactNode[] = [];
  if (pages) {
    parts.push(
      <span key="pages">
        data read from the game’s pages on <When iso={pages} />
      </span>,
    );
  }
  if (images) {
    parts.push(
      <span key="images">
        map images downloaded on <When iso={images} />
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <p className="download-note" data-testid="pack-file-dates">
      It holds {parts[0]}
      {parts[1] ? <> and {parts[1]}</> : null}.
    </p>
  );
}

/** `pictures`: the pictures that went in the file, said for a game of pages. */
function ExportResult({ result, pictures }: { result: PackFileExported; pictures: number }) {
  return (
    <div className="download-body">
      <p data-testid="export-result">
        Saved <strong>{result.fileName}</strong> ({formatBytes(result.size)}):{' '}
        {savedText(result.header, pictures)}
      </p>
      <p className="path">{result.path}</p>
      <DatesLine header={result.header} />
      {result.header.mine ? (
        <p className="download-note" data-testid="export-mine">
          It holds your own {mineText(result.header.mine)}.
        </p>
      ) : null}
      {result.progressFile ? (
        <p className="download-note" data-testid="export-progress-file">
          Your progress (every game and profile) is saved beside it:{' '}
          <span className="path-inline">{result.progressFile}</span>
        </p>
      ) : null}
      {result.progressError ? (
        <p className="download-error" role="alert" data-testid="export-progress-error">
          The pack file is saved. {result.progressError}
        </p>
      ) : null}
      <div className="row-actions">
        <button type="button" className="button button-primary" onClick={closePackFileDialog}>
          Done
        </button>
      </div>
    </div>
  );
}

function ImportView({ file, setBusy }: { file: PackFileInfo; setBusy: (busy: boolean) => void }) {
  const { header, installed } = file;
  const kind = packKind(header.contents);
  const names = holdsNamesText(header);
  const freshness = installed?.details ? compareWithInstalled(header, installed.details) : null;
  const older = freshness?.verdict === 'installed-newer';
  const [confirmOlder, setConfirmOlder] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof importPackFile>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setError(null);
    setRunning(true);
    setBusy(true);
    importPackFile(file, file.replaces)
      .then(setResult, (reason: unknown) => {
        setError(errorText(reason));
      })
      .finally(() => {
        setRunning(false);
        setBusy(false);
      });
  };

  if (result) {
    return (
      <div className="download-body">
        <p data-testid="import-result">
          {result.replaced ? 'Replaced' : 'Imported'} <strong>{result.title}</strong>. It is in the
          maps folder and shown now.
          {result.replaced
            ? kind === 'map'
              ? ' Your found marks are kept.'
              : ' Your progress is kept.'
            : ''}
        </p>
        {result.mine ? (
          <p className="download-note" data-testid="import-mine">
            {result.mine.lists +
              result.mine.locations +
              result.mine.types +
              result.mine.areas +
              result.mine.photos +
              result.mine.pages +
              result.mine.sections +
              result.mine.notes +
              (result.mine.guideLinks ? 1 : 0) >
            0
              ? `Your own ${mineText(result.mine)} from the file were added to yours.`
              : ''}
            {result.mine.title ? (
              <span data-testid="import-title">
                {' '}
                It is shown under the title {result.mine.title} with its other sources.
              </span>
            ) : null}
            {result.mine.problem ? ` ${result.mine.problem}` : ''}
          </p>
        ) : null}
        <div className="row-actions">
          <button type="button" className="button button-primary" onClick={closePackFileDialog}>
            Done
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="download-body">
      <p className="path" data-testid="import-file">
        {file.fileName} <span className="muted">({formatBytes(file.size)})</span>
      </p>
      <p data-testid="import-summary">
        <strong>{header.title}</strong>, version {header.packVersion}
        {header.pack.gamePatch ? ` (game patch ${header.pack.gamePatch})` : ''}:{' '}
        {contentsText(header.contents)}.{kind === 'map' ? ` ${imagesText(header)}` : ''}
      </p>
      {names ? (
        <p className="download-note" data-testid="import-names">
          {names}
        </p>
      ) : null}
      <p className="download-note">
        {sourceText(header.source)} Made with {header.exportedBy.name} {header.exportedBy.version}{' '}
        on <When iso={header.exportedAt} />.
      </p>
      <DatesLine header={header} />
      {header.mine ? (
        <p className="download-note" data-testid="import-has-mine">
          It also holds someone’s own {mineText(header.mine)}. They are added to yours for this
          game; one with the same name and id as one of yours replaces it.
        </p>
      ) : null}
      {installed ? (
        <>
          <Compare
            header={header}
            installed={installed.details}
            title={installed.title}
            kind={kind}
          />
          {freshness ? (
            <p
              className={older ? 'download-error' : 'download-note'}
              data-testid="import-verdict"
              data-verdict={freshness.verdict}
            >
              {freshnessText(freshness)}
            </p>
          ) : null}
        </>
      ) : null}
      {file.blocked ? (
        <p className="download-error" data-testid="import-blocked">
          {file.blocked}
        </p>
      ) : installed ? (
        <p className="download-note" data-testid="import-replace-note">
          {replaceText(kind, installed, file.replaces)}
        </p>
      ) : null}
      {error ? (
        <p className="download-error" role="alert" data-testid="pack-file-error">
          {error}
        </p>
      ) : null}
      {running ? (
        <JobProgress verb="Importing" />
      ) : file.blocked ? (
        <div className="row-actions">
          <button type="button" className="button" onClick={closePackFileDialog}>
            Close
          </button>
        </div>
      ) : older && !confirmOlder ? (
        <div className="row-actions wrap">
          <button type="button" className="button button-primary" onClick={closePackFileDialog}>
            Keep the installed game
          </button>
          <button
            type="button"
            className="button"
            data-testid="import-older"
            onClick={() => {
              setConfirmOlder(true);
            }}
          >
            Replace it with the older file…
          </button>
        </div>
      ) : older ? (
        <div className="removal-confirm" role="group" aria-label="Replace with the older file?">
          <p>
            Replace the newer {installed?.title ?? header.title} with the older data in this file?
          </p>
          <div className="row-actions wrap">
            <button
              type="button"
              className="button button-danger"
              data-testid="import-start"
              onClick={start}
            >
              Replace with the older file
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setConfirmOlder(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="row-actions">
          <button
            type="button"
            className="button button-primary"
            data-testid="import-start"
            onClick={start}
          >
            {file.replaces ? 'Import and replace' : 'Import'}
          </button>
          <button type="button" className="button" onClick={closePackFileDialog}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/** The file and the installed game side by side; for a file of pages, without map images. */
function Compare({
  header,
  installed,
  title,
  kind,
}: {
  header: PackFileHeader;
  installed: PackDetails | null;
  title: string;
  kind: PackKind;
}) {
  const date = (iso: string | null | undefined) => (iso ? <When iso={iso} /> : 'Not recorded');
  const fileImages = imagesDownloadedAt(header);
  const rows: [string, ReactNode, ReactNode][] = [
    ['Version', header.packVersion, installed?.pack.packVersion ?? '—'],
    [
      'Pages last read',
      date(header.source.newestPageAt),
      installed ? date(installed.source.newestPageAt) : '—',
    ],
    ['Contents', contentsText(header.contents), installed ? contentsText(installed.contents) : '—'],
  ];
  if (kind === 'map') {
    rows.push([
      'Map images',
      <>
        {imagesText(header)}
        {fileImages ? (
          <>
            {' '}
            Downloaded on <When iso={fileImages} />.
          </>
        ) : null}
      </>,
      installed ? (
        <>
          {installedImagesText(installed)}
          {installed.imagesAt ? (
            <>
              {' '}
              Last on <When iso={installed.imagesAt} />.
            </>
          ) : null}
        </>
      ) : (
        '—'
      ),
    ]);
  }
  rows.push([
    'Made',
    <>
      Exported on <When iso={header.exportedAt} />
    </>,
    installed?.packFile ? (
      <>
        Imported from {installed.packFile.fileName} on <When iso={installed.packFile.importedAt} />
      </>
    ) : installed ? (
      sourceText(installed.source)
    ) : (
      '—'
    ),
  ]);
  return (
    <table className="pack-compare" data-testid="import-compare">
      <thead>
        <tr>
          <th scope="col">
            <span className="visually-hidden">What</span>
          </th>
          <th scope="col">In this file</th>
          <th scope="col">{title}, installed now</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, file, now]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{file}</td>
            <td>{now}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** "2 lists, 5 locations and 1 type" of a person's own, as a file carries them. */
function mineText(mine: {
  lists: number;
  locations: number;
  types: number;
  areas: number;
  photos?: number;
  guideLinks?: boolean;
  pages?: number;
  sections?: number;
  notes?: number;
  group?: boolean;
}): string {
  const count = (n: number, one: string, many: string) =>
    n === 1 ? `1 ${one}` : `${n.toLocaleString('en')} ${many}`;
  const parts = [
    mine.lists > 0 ? count(mine.lists, 'list', 'lists') : null,
    mine.locations > 0 ? count(mine.locations, 'location', 'locations') : null,
    mine.types > 0 ? count(mine.types, 'type', 'types') : null,
    mine.areas > 0 ? count(mine.areas, 'area', 'areas') : null,
    (mine.photos ?? 0) > 0 ? count(mine.photos ?? 0, 'photo', 'photos') : null,
    mine.guideLinks ? 'guide links' : null,
    (mine.pages ?? 0) > 0 ? count(mine.pages ?? 0, 'page', 'pages') : null,
    (mine.sections ?? 0) > 0 ? count(mine.sections ?? 0, 'section', 'sections') : null,
    (mine.notes ?? 0) > 0 ? count(mine.notes ?? 0, 'note', 'notes') : null,
    mine.group ? 'the title it shares with other games' : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return 'lists, locations and types (none)';
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`;
}
