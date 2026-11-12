import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CATEGORY_LABELS,
  SOURCE_LABELS,
  areaNotes,
  boundsText,
  categoryCounts,
  count,
  floorPreviewFile,
  gameHeadline,
  isMakeReport,
  makeSuggestedFileName,
  makeSummaryLine,
  plural,
  previewFile,
  sourceDetails,
  sourceText,
  sourceTone,
  suggestedFileName,
  summaryLine,
  type AreaReport,
  type GeometrySourceName,
  type MadeArea,
  type MakeReport,
  type MarkerCategory,
  type Report,
} from './report';
import { errorText, shell, type AppInfo, type CheckStatus, type SavedReport } from './shell';

const SOURCES: GeometrySourceName[] = ['collision', 'navmesh', 'mapPieces'];
const POLL_MS = 300;

const LEGEND: [string, string][] = [
  ['treasure', 'var(--mm-dot-treasure)'],
  ['bonfire or lamp candidates', 'var(--mm-dot-bonfire)'],
  ['characters', 'var(--mm-dot-character)'],
  ['objects', 'var(--mm-dot-object)'],
  ['player starts', 'var(--mm-dot-start)'],
];

export function App() {
  if (!shell) {
    return (
      <main className="mm-page">
        <h1>Atlas Map Maker</h1>
        <p>
          This page runs inside the Atlas Map Maker app. Install the app and open it from the Start
          menu.
        </p>
      </main>
    );
  }
  return <MapMaker />;
}

function MapMaker() {
  const api = shell!;
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [status, setStatus] = useState<CheckStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedReport | null>(null);

  useEffect(() => {
    void api.appInfo().then(
      (appInfo) => {
        setInfo(appInfo);
        setFolder((current) => current ?? appInfo.lastFolder);
      },
      (error: unknown) => {
        setProblem(errorText(error));
      },
    );
    void api.checkStatus().then(setStatus, () => undefined);
  }, [api]);

  const running = status?.state === 'running' || status?.state === 'cancelling';
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      void api.checkStatus().then(setStatus, (error: unknown) => {
        setProblem(errorText(error));
      });
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [api, running]);

  const choose = useCallback(async () => {
    setProblem(null);
    try {
      const chosen = await api.chooseFolder();
      if (chosen) setFolder(chosen);
    } catch (error) {
      setProblem(errorText(error));
    }
  }, [api]);

  const start = useCallback(
    async (kind: 'check' | 'make') => {
      if (!folder) return;
      setProblem(null);
      setSaved(null);
      try {
        setStatus(await (kind === 'make' ? api.makeStart(folder) : api.checkStart(folder)));
      } catch (error) {
        setProblem(errorText(error));
      }
    },
    [api, folder],
  );

  const cancel = useCallback(async () => {
    try {
      await api.checkCancel();
      setStatus(await api.checkStatus());
    } catch (error) {
      setProblem(errorText(error));
    }
  }, [api]);

  const save = useCallback(async () => {
    setProblem(null);
    try {
      const report = status?.report ?? null;
      const now = new Date();
      const result = await api.saveReport(
        isMakeReport(report) ? makeSuggestedFileName(report, now) : suggestedFileName(report, now),
      );
      if (result) setSaved(result);
    } catch (error) {
      setProblem(errorText(error));
    }
  }, [api, status]);

  const report = status?.state === 'done' ? status.report : null;
  const what = status?.kind === 'make' ? 'making of the map' : 'check';

  return (
    <main className="mm-page">
      <header className="mm-header">
        <h1>Atlas Map Maker</h1>
        {info && <span className="muted small">version {info.version}</span>}
      </header>
      <p className="mm-intro">
        Makes an Atlas map pack from your own game files, or checks what map data can be read from
        them. It only reads the game folder: nothing there is changed, and nothing is sent anywhere.
        The map pack stays on this computer, in the folder Atlas reads its maps from.
      </p>
      {info && !info.helperFound && (
        <p className="mm-alert mm-bad" role="alert">
          The file reader that comes with the Map Maker (atlas-gamefiles) is missing. Please
          reinstall the app.
        </p>
      )}

      <section className="mm-card" aria-labelledby="step-folder">
        <h2 id="step-folder">1. Game folder</h2>
        <div className="mm-row">
          <span className={folder ? 'mm-path' : 'mm-path muted'} title={folder ?? undefined}>
            {folder ?? 'No folder chosen yet'}
          </span>
          <button
            id="choose-folder"
            type="button"
            className="button"
            onClick={() => void choose()}
            disabled={running}
          >
            Choose folder…
          </button>
        </div>
        <p className="muted small">
          Dark Souls Remastered on Steam is usually in{' '}
          <span className="mono">
            C:\Program Files (x86)\Steam\steamapps\common\DARK SOULS REMASTERED
          </span>
          {info?.typicalFolder ? ' (found on this computer).' : '.'} In Steam you can also
          right-click the game, then Manage, Browse local files, and copy the folder from there. For
          Bloodborne, choose your dump folder (the one with eboot.bin and dvdroot_ps4).
        </p>
      </section>

      <section className="mm-card" aria-labelledby="step-check">
        <h2 id="step-check">2. Make the map</h2>
        <div className="mm-row">
          <button
            id="make-start"
            type="button"
            className="button button-primary"
            onClick={() => void start('make')}
            disabled={!folder || running || info?.helperFound === false}
          >
            Make map
          </button>
          <button
            id="check-start"
            type="button"
            className="button"
            onClick={() => void start('check')}
            disabled={!folder || running || info?.helperFound === false}
          >
            Check game files
          </button>
          {running && (
            <button
              id="check-cancel"
              type="button"
              className="button"
              onClick={() => void cancel()}
              disabled={status.state === 'cancelling'}
            >
              {status.state === 'cancelling' ? 'Stopping…' : 'Cancel'}
            </button>
          )}
        </div>
        <p className="muted small">
          Make map reads every area (a few minutes for Dark Souls Remastered) and puts the map pack
          in <span className="mono">{info?.mapsFolder ?? 'the Atlas maps folder'}</span>, replacing
          one it made before. Check game files only reports what can be read.
        </p>
        {status && status.state !== 'idle' && <Progress status={status} />}
      </section>

      {problem && (
        <p className="mm-alert mm-bad" role="alert">
          {problem}
        </p>
      )}

      {status?.state === 'failed' && <Failure status={status} />}
      {status?.state === 'cancelled' && (
        <p className="mm-alert">
          The {what} was stopped. Nothing was changed in the maps folder. Click a button above to
          start again.
        </p>
      )}

      {isMakeReport(report) && status?.pack && (
        <section className="mm-card" aria-labelledby="pack-title">
          <h2 id="pack-title">Your map pack is ready</h2>
          <p>
            Open Atlas (or click Refresh in its Maps dialog): <strong>{report.pack?.id}</strong> is
            in its list of maps.
          </p>
          <div className="mm-row">
            <span className="mm-path" title={status.pack.folder}>
              {status.pack.folder}
            </span>
            <button
              id="reveal-pack"
              type="button"
              className="button"
              onClick={() => {
                api.revealPack().catch((error: unknown) => {
                  setProblem(errorText(error));
                });
              }}
            >
              Show in folder
            </button>
          </div>
          <p className="muted small">
            It is made from your game files, so keep it to yourself: do not share or upload it.
          </p>
        </section>
      )}

      {report && (
        <>
          <section className="mm-card" aria-labelledby="step-save">
            <h2 id="step-save">3. Save the report</h2>
            <div className="mm-row">
              <button
                id="save-report"
                type="button"
                className="button button-primary"
                onClick={() => void save()}
              >
                Save report…
              </button>
              {saved && (
                <button
                  type="button"
                  className="button"
                  onClick={() => void api.revealSavedReport()}
                >
                  Show in folder
                </button>
              )}
            </div>
            <p className="muted small">
              {saved ? (
                <>
                  Saved as <span className="mono">{saved.name}</span>. Upload that file to the
                  thread.
                </>
              ) : isMakeReport(report) ? (
                'Saves one .zip file with the report and small preview pictures of each floor (not the map pack). Upload it to the thread.'
              ) : (
                'Saves one .zip file with the report and the preview pictures. It holds no game files. Upload it to the thread.'
              )}
            </p>
          </section>
          {isMakeReport(report) ? <MakeResults report={report} /> : <Results report={report} />}
        </>
      )}
    </main>
  );
}

function Progress({ status }: { status: CheckStatus }) {
  const percent = Math.round(status.fraction * 100);
  const done = status.state === 'done';
  return (
    <div className="mm-progress-block">
      <div
        className="mm-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={done ? 100 : percent}
        aria-label="Progress"
      >
        <div className="mm-progress-fill" style={{ width: `${done ? 100 : percent}%` }} />
      </div>
      <p className="small">
        {done
          ? `Finished in ${Math.round(status.elapsedSeconds)} seconds.`
          : `${percent}% · ${status.message || 'Starting…'}`}
      </p>
    </div>
  );
}

function Failure({ status }: { status: CheckStatus }) {
  return (
    <section className="mm-card mm-bad-card" role="alert">
      <h2>{status.kind === 'make' ? 'Making the map' : 'The check'} stopped with an error</h2>
      <p>{status.error ?? 'The file reader stopped unexpectedly.'}</p>
      {status.helperOutput.length > 0 && (
        <details>
          <summary>Details for the thread</summary>
          <pre className="mm-pre">{status.helperOutput.join('\n')}</pre>
        </details>
      )}
    </section>
  );
}

function Results({ report }: { report: Report }) {
  const summary = report.summary;
  return (
    <>
      <section className="mm-card" aria-labelledby="result-title">
        <h2 id="result-title">{gameHeadline(report.game)}</h2>
        <p>{summaryLine(report)}</p>
        {summary && (
          <p className={summary.recommendedGeometry ? 'mm-alert mm-good' : 'mm-alert mm-warn'}>
            {summary.recommendation}
          </p>
        )}
        {summary?.mainAreas && (
          <p className="small">
            Main Bloodborne areas: {summary.mainAreas.found} of {summary.mainAreas.expected}
            {summary.mainAreas.missing.length > 0 &&
              ` (missing ${summary.mainAreas.missing.join(', ')})`}
            .
          </p>
        )}
        {report.gameData && (
          <ul className="mm-list small">
            <li>
              Item table:{' '}
              {report.gameData.itemLots.ok
                ? `${plural(report.gameData.itemLots.rows, 'item lot')} read`
                : `not read (${report.gameData.itemLots.error ?? 'unknown error'})`}
            </li>
            <li>
              Item names:{' '}
              {report.gameData.itemText.ok
                ? `${plural(report.gameData.itemText.entries, 'name')} in ${plural(report.gameData.itemText.tables, 'table')}`
                : `not read (${report.gameData.itemText.error ?? 'unknown error'})`}
            </li>
          </ul>
        )}
        {report.warnings.length > 0 && (
          <>
            <h3>Warnings</h3>
            <ul className="mm-list">
              {report.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </>
        )}
        <details>
          <summary className="small">How the game was recognised</summary>
          <ul className="mm-list small">
            {report.game.evidence.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </details>
      </section>
      {report.areas.length > 0 && <AreasTable areas={report.areas} />}
      {report.areas.some((area) => previewFile(area)) && <Previews areas={report.areas} />}
    </>
  );
}

function AreasTable({ areas }: { areas: AreaReport[] }) {
  return (
    <section className="mm-card" aria-labelledby="areas-title">
      <h2 id="areas-title">Areas</h2>
      <div className="mm-table-wrap">
        <table className="mm-table">
          <thead>
            <tr>
              <th scope="col">Area</th>
              <th scope="col">Parts</th>
              <th scope="col">Treasure</th>
              <th scope="col">Item lots</th>
              <th scope="col">Bonfires / lamps</th>
              {SOURCES.map((source) => (
                <th scope="col" key={source}>
                  {SOURCE_LABELS[source]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {areas.map((area) => (
              <tr key={area.id}>
                <th scope="row">
                  <div>{area.name}</div>
                  <div className="muted small mono">{area.id}</div>
                  {area.msb.ok ? (
                    <div className="muted small">{boundsText(area.bounds)}</div>
                  ) : (
                    <div className="mm-tone-bad small">Map layout not read: {area.msb.error}</div>
                  )}
                </th>
                <td
                  title={
                    area.parts
                      ? Object.entries(area.parts)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join('\n')
                      : ''
                  }
                >
                  {area.partsTotal === undefined ? '–' : count(area.partsTotal)}
                </td>
                <td>{area.treasures === undefined ? '–' : count(area.treasures)}</td>
                <td>
                  {area.itemLotsReferenced === undefined
                    ? '–'
                    : area.itemLotsFound === null || area.itemLotsFound === undefined
                      ? count(area.itemLotsReferenced)
                      : `${count(area.itemLotsFound)} of ${count(area.itemLotsReferenced)} found`}
                </td>
                <td title={area.bonfireCandidates?.method}>
                  {area.bonfireCandidates ? count(area.bonfireCandidates.count) : '–'}
                </td>
                {SOURCES.map((source) => {
                  const result = area.geometry[source];
                  const details = sourceDetails(result);
                  return (
                    <td key={source}>
                      <span className={`mm-tone-${sourceTone(result.status)}`}>
                        {sourceText(result)}
                      </span>
                      {details.length > 0 && (
                        <details className="small">
                          <summary>Details</summary>
                          <ul className="mm-list">
                            {details.map((line, index) => (
                              <li key={index}>{line}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Previews({ areas }: { areas: AreaReport[] }) {
  const api = shell!;
  const [images, setImages] = useState<Record<string, string>>({});
  const loading = useRef(new Set<string>());

  useEffect(() => {
    for (const area of areas) {
      const file = previewFile(area);
      if (!file || loading.current.has(file)) continue;
      loading.current.add(file);
      void api.previewImage(file).then(
        (url) => {
          setImages((current) => ({ ...current, [file]: url }));
        },
        () => undefined,
      );
    }
  }, [api, areas]);

  return (
    <section className="mm-card" aria-labelledby="previews-title">
      <h2 id="previews-title">Previews</h2>
      <p className="muted small">
        Seen from above, north (+z) up. Shaded areas are the geometry that could be read, lighter
        where higher.
      </p>
      <ul className="mm-legend small">
        {LEGEND.map(([label, colour]) => (
          <li key={label}>
            <span className="mm-swatch" style={{ background: colour }} />
            {label}
          </li>
        ))}
      </ul>
      <div className="mm-previews">
        {areas.map((area) => {
          const file = previewFile(area);
          if (!file) return null;
          return (
            <figure key={area.id} className="mm-preview">
              {images[file] ? (
                <img src={images[file]} alt={`Top-down preview of ${area.name}`} />
              ) : (
                <div className="mm-preview-empty muted small">Loading…</div>
              )}
              <figcaption className="small">
                {area.name}
                <span className="muted"> · {area.preview?.geometry}</span>
              </figcaption>
            </figure>
          );
        })}
      </div>
    </section>
  );
}

/** The dot colours of the floor previews (tools/gamefiles/atlas_gamefiles/render.py). */
const PREVIEW_LEGEND: [MarkerCategory, string][] = [
  ['bonfire', 'var(--mm-dot-bonfire-made)'],
  ['boss', 'var(--mm-dot-boss)'],
  ['npc', 'var(--mm-dot-npc)'],
  ['drop', 'var(--mm-dot-drop)'],
  ['consumable', 'var(--mm-dot-consumable)'],
  ['souls', 'var(--mm-dot-souls)'],
];

function MakeResults({ report }: { report: MakeReport }) {
  const summary = report.summary;
  const made = report.areas.filter((area) => !area.skipped);
  return (
    <>
      <section className="mm-card" aria-labelledby="result-title">
        <h2 id="result-title">{gameHeadline(report.game)}</h2>
        <p>{makeSummaryLine(report)}</p>
        {summary && <p className="small">{categoryCounts(summary.markersByCategory)}.</p>}
        {report.warnings.length > 0 && (
          <>
            <h3>Warnings</h3>
            <ul className="mm-list">
              {report.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </>
        )}
      </section>
      <section className="mm-card" aria-labelledby="areas-title">
        <h2 id="areas-title">Areas</h2>
        <div className="mm-table-wrap">
          <table className="mm-table">
            <thead>
              <tr>
                <th scope="col">Area</th>
                <th scope="col">Floors</th>
                <th scope="col">Markers</th>
                <th scope="col">To look at</th>
              </tr>
            </thead>
            <tbody>
              {report.areas.map((area) => (
                <MadeAreaRow key={area.id} area={area} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {made.length > 0 && <FloorPreviews areas={made} />}
    </>
  );
}

function MadeAreaRow({ area }: { area: MadeArea }) {
  const notes = areaNotes(area);
  const floors = area.floors ?? [];
  return (
    <tr>
      <th scope="row">
        <div>{area.name}</div>
        <div className="muted small mono">{area.id}</div>
      </th>
      <td>
        {floors.length === 0
          ? '–'
          : floors.map((floor) => (
              <div key={floor.index} className="small">
                {floor.name}
                <span className="muted"> · {count(floor.areaSquareMetres)} m²</span>
              </div>
            ))}
      </td>
      <td className="small">
        {area.markers ? (
          <>
            <div>{count(area.markers.total)}</div>
            <div className="muted">{categoryCounts(area.markers.byCategory)}</div>
          </>
        ) : (
          '–'
        )}
      </td>
      <td className="small">
        {notes.length === 0 ? (
          <span className="mm-tone-good">Nothing</span>
        ) : (
          <ul className="mm-list">
            {notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

function FloorPreviews({ areas }: { areas: MadeArea[] }) {
  const api = shell!;
  const [images, setImages] = useState<Record<string, string>>({});
  const loading = useRef(new Set<string>());

  useEffect(() => {
    for (const area of areas) {
      for (const floor of area.floors ?? []) {
        const file = floorPreviewFile(floor);
        if (!file || loading.current.has(file)) continue;
        loading.current.add(file);
        void api.previewImage(file).then(
          (url) => {
            setImages((current) => ({ ...current, [file]: url }));
          },
          () => undefined,
        );
      }
    }
  }, [api, areas]);

  return (
    <section className="mm-card" aria-labelledby="previews-title">
      <h2 id="previews-title">Floors</h2>
      <p className="muted small">
        Small copies of the map pictures, north (+z) up: lighter where higher, walls in dark lines,
        the floors below faded. Dots are markers on that floor.
      </p>
      <ul className="mm-legend small">
        {PREVIEW_LEGEND.map(([category, colour]) => (
          <li key={category}>
            <span className="mm-swatch" style={{ background: colour }} />
            {CATEGORY_LABELS[category]}
          </li>
        ))}
        <li>
          <span className="mm-swatch" style={{ background: 'var(--mm-dot-item)' }} />
          Other items
        </li>
      </ul>
      <div className="mm-previews">
        {areas.flatMap((area) =>
          (area.floors ?? []).map((floor) => {
            const file = floorPreviewFile(floor);
            if (!file) return null;
            return (
              <figure key={file} className="mm-preview">
                {images[file] ? (
                  <img src={images[file]} alt={`${area.name}, ${floor.name}, from above`} />
                ) : (
                  <div className="mm-preview-empty muted small">Loading…</div>
                )}
                <figcaption className="small">
                  {area.name}
                  <span className="muted"> · {floor.name}</span>
                </figcaption>
              </figure>
            );
          }),
        )}
      </div>
    </section>
  );
}
