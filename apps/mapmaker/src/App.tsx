import { useCallback, useEffect, useRef, useState } from 'react';
import { ComparePanel } from './Compare';
import { FloorsPanel } from './FloorsPanel';
import { MapStyleChoice } from './MapStyleChoice';
import { ModelSetup } from './ModelSetup';
import { levelLines } from './model';
import { RedrawCard } from './RedrawCard';
import {
  CATEGORY_LABELS,
  SOURCE_LABELS,
  areaNotes,
  boundsText,
  canAdjustFloors,
  cutsLine,
  floorRangeText,
  categoryCounts,
  count,
  floorPreviewFile,
  gameHeadline,
  isMakeReport,
  isModelReport,
  makeSuggestedFileName,
  makeSummaryLine,
  sceneLines,
  waitingCuts,
  plural,
  previewFile,
  sourceDetails,
  sourceText,
  sourceTone,
  suggestedFileName,
  summaryLine,
  FLOOR_METHODS,
  LOOKS_3D,
  type AreaReport,
  type FloorMethod,
  type GeometrySourceName,
  type Look3d,
  type MadeArea,
  type MakeReport,
  type MapStyleId,
  type MarkerCategory,
  type Report,
} from './report';
import {
  errorText,
  shell,
  type AppInfo,
  type CheckStatus,
  type FloorEntry,
  type FloorOverrides,
  type SavedReport,
} from './shell';

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
  const [make3d, setMake3d] = useState(true);
  const [look3d, setLook3d] = useState<Look3d>('models');
  const [mapStyle, setMapStyle] = useState<MapStyleId>('shaded');
  const [floorMethod, setFloorMethod] = useState<FloorMethod | null>(null);
  const [overrides, setOverrides] = useState<FloorOverrides>({});
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [comparing, setComparing] = useState<string | null>(null);

  useEffect(() => {
    void api.appInfo().then(
      (appInfo) => {
        setInfo(appInfo);
        setFolder((current) => current ?? appInfo.lastFolder);
        setMake3d(appInfo.make3d);
        setLook3d(appInfo.look3d);
        setMapStyle(appInfo.mapStyle);
        setFloorMethod(appInfo.floorMethod);
      },
      (error: unknown) => {
        setProblem(errorText(error));
      },
    );
    // The last make's report, from when the app was open before, so its floors can be adjusted.
    void api.restoreLastMake().then(setStatus, () => {
      void api.checkStatus().then(setStatus, () => undefined);
    });
    api.floorOverridesRead().then(setOverrides, (error: unknown) => {
      setProblem(`Your floor cuts could not be read: ${errorText(error)}`);
    });
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
        setStatus(
          await (kind === 'make'
            ? api.makeStart(folder, make3d, mapStyle, floorMethod, look3d)
            : api.checkStart(folder)),
        );
      } catch (error) {
        setProblem(errorText(error));
      }
    },
    [api, folder, make3d, mapStyle, floorMethod, look3d],
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

  const remake = useCallback(
    async (area: string, style: MapStyleId) => {
      setProblem(null);
      setSaved(null);
      try {
        setStatus(await api.remakeStart(area, make3d, style, look3d));
      } catch (error) {
        setProblem(errorText(error));
      }
    },
    [api, make3d, look3d],
  );

  const redraw = useCallback(
    async (pack: string, style: MapStyleId) => {
      setProblem(null);
      setSaved(null);
      try {
        setStatus(await api.redrawStart(pack, style));
      } catch (error) {
        setProblem(errorText(error));
      }
    },
    [api],
  );

  // A make's report stays shown while one of its areas is made again, and when that fails; and while and after
  // its pack (or another) is drawn again.
  const report =
    status?.kind === 'redraw' ? (status.lastMakeReport ?? null) : (status?.report ?? null);
  const what =
    status?.kind === 'make'
      ? 'making of the map'
      : status?.kind === 'remake'
        ? 'making of the area again'
        : status?.kind === 'redraw'
          ? 'drawing of the maps again'
          : 'check';
  // A make from a 3D model: its progress is shown under the model's setup.
  const fromModel = status?.fromModel === true;
  const adjusted = isMakeReport(report)
    ? report.areas.find((area) => area.key === adjusting)
    : null;
  const compared = isMakeReport(report)
    ? report.areas.find((area) => area.key === comparing)
    : null;

  return (
    <main className="mm-page">
      <header className="mm-header">
        <h1>Atlas Map Maker</h1>
        {info && <span className="muted small">version {info.version}</span>}
      </header>
      <p className="mm-intro">
        Makes an Atlas map pack from your own game files, or checks what map data can be read from
        them. It only reads the game folder: nothing there is changed, and nothing is sent anywhere.
        The map pack stays on this computer, in the folder Atlas reads its maps from. It can also
        make a map from a 3D model you made or exported.
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
          Bloodborne, choose your Bloodborne 1.09 game folder (dvdroot_ps4).
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
          {running && status.kind !== 'redraw' && (
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
        <label className="mm-check">
          <input
            id="make-3d"
            type="checkbox"
            checked={make3d}
            onChange={(event) => {
              setMake3d(event.target.checked);
            }}
            disabled={running}
          />
          Also make 3D maps
        </label>
        <div className="mm-style">
          <label htmlFor="look-3d">3D look</label>
          <select
            id="look-3d"
            value={look3d}
            disabled={running || !make3d}
            aria-describedby="look-3d-note"
            onChange={(event) => {
              setLook3d(event.target.value === 'collision' ? 'collision' : 'models');
            }}
          >
            {LOOKS_3D.map((look) => (
              <option key={look.id} value={look.id}>
                {look.label}
              </option>
            ))}
          </select>
          <span id="look-3d-note" className="small muted">
            Game models makes each 3D map from the game’s own models, with every texture at its own
            size up close (Dark Souls Remastered and Bloodborne). An area whose models or textures
            cannot be read, or whose 3D map would be too large, is made from its collision, and its
            report says why. Collision makes it from the ground and walls, coloured as the map.
          </span>
        </div>
        <MapStyleChoice
          id="map-style"
          label="Map style"
          value={mapStyle}
          disabled={running}
          onChange={setMapStyle}
        />
        <div className="mm-style">
          <label htmlFor="floor-method">Floors</label>
          <select
            id="floor-method"
            value={floorMethod ?? 'game'}
            disabled={running}
            aria-describedby="floor-method-note"
            onChange={(event) => {
              const value = event.target.value;
              setFloorMethod(value === 'passages' || value === 'cuts' ? value : null);
            }}
          >
            <option value="game">As suits the game</option>
            {FLOOR_METHODS.map((method) => (
              <option key={method.id} value={method.id}>
                {method.label}
              </option>
            ))}
          </select>
          <span id="floor-method-note" className="small muted">
            Automatic passages keep the ground whole and split it only where one walkable surface
            lies over another (a bridge over a street); cuts split an area into floors at set
            heights. As suits the game: automatic passages for Bloodborne, cuts for Dark Souls
            Remastered. Each area can be changed in Adjust floors.
          </span>
        </div>
        <p className="muted small">
          Make map reads every area (a few minutes for Dark Souls Remastered) and puts the map pack
          in <span className="mono">{info?.mapsFolder ?? 'the Atlas maps folder'}</span>, replacing
          one it made before. With 3D maps, each area also gets a 3D model, which Atlas shows with
          its 2D | 3D switch; it takes a little longer, and longer still with the game’s models and
          textures. Check game files only reports what can be read.
        </p>
        {make3d && info && !info.sceneBuilderFound && (
          <p className="mm-alert" role="status">
            The 3D builder that comes with the Map Maker (atlas-scene) is missing, so the maps will
            be flat. Please reinstall the app.
          </p>
        )}
        {status && status.state !== 'idle' && !fromModel && status.kind !== 'redraw' && (
          <Progress status={status} />
        )}
      </section>

      <ModelSetup
        api={api}
        info={info}
        running={running}
        mapStyle={mapStyle}
        onStarted={(started) => {
          setSaved(null);
          setProblem(null);
          setAdjusting(null);
          setComparing(null);
          setStatus(started);
        }}
      />
      {status && status.state !== 'idle' && fromModel && (
        <section className="mm-card" aria-label="Making the map from the model">
          <Progress status={status} />
        </section>
      )}

      {problem && (
        <p className="mm-alert mm-bad" role="alert">
          {problem}
        </p>
      )}

      {status?.state === 'failed' && (
        <Failure
          status={status}
          onMakeAll={
            status.kind === 'remake' && status.errorCode && !isModelReport(report)
              ? () => void start('make')
              : undefined
          }
        />
      )}
      {status?.state === 'cancelled' && (
        <p className="mm-alert">
          The {what} was stopped. Nothing was changed in the maps folder.{' '}
          {status.kind === 'remake' || status.kind === 'redraw'
            ? 'Your map pack is as it was.'
            : 'Press a button above to start again.'}
        </p>
      )}

      {isMakeReport(report) && status?.pack && (
        <section className="mm-card" aria-labelledby="pack-title">
          <h2 id="pack-title">Your map pack is ready</h2>
          {isModelReport(report) ? (
            <p>
              Open the Library in Atlas: {report.game.title} is listed there. It has no locations
              yet: add them in Atlas with Edit locations.
            </p>
          ) : (
            <p>Open the Library in Atlas: the game is listed there.</p>
          )}
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
            {isModelReport(report) && !report.model?.level
              ? 'It is made from your model: share it only if the model is yours to share.'
              : 'It is made from your game files, so keep it to yourself: do not share or upload it.'}
          </p>
        </section>
      )}

      {info && (
        <RedrawCard
          api={api}
          status={status}
          madePack={status?.pack?.id ?? null}
          mapStyle={mapStyle}
          running={running}
          helperFound={info.helperFound}
          onMapStyle={setMapStyle}
          onStart={(pack, style) => void redraw(pack, style)}
          onCancel={() => void cancel()}
          progress={status && status.state !== 'idle' ? <Progress status={status} /> : null}
        />
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
          {isMakeReport(report) ? (
            <MakeResults
              key={`${status?.runId ?? 0}:${report.updatedAt ?? report.createdAt}`}
              report={report}
              ownFor={report.options?.floorOverrides?.usedFor ?? []}
              saved={overrides[report.game.id] ?? {}}
              running={running}
              onAdjust={setAdjusting}
              onCompare={setComparing}
            />
          ) : (
            <Results report={report} />
          )}
        </>
      )}
      {isMakeReport(report) && adjusted && (
        <FloorsPanel
          key={`${adjusted.key}:${report.updatedAt ?? report.createdAt}`}
          api={api}
          area={adjusted}
          game={report.game.id}
          status={status}
          make3d={isModelReport(report) || make3d}
          model={isModelReport(report)}
          mapStyle={adjusted.mapStyle ?? report.options?.mapStyle ?? mapStyle}
          remadeAt={
            report.remade?.area === adjusted.key
              ? new Date(report.remade.at).toLocaleTimeString()
              : null
          }
          onClose={() => {
            setAdjusting(null);
          }}
          onOverrides={setOverrides}
          onRemake={remake}
          onCancel={() => void cancel()}
          onMakeAll={
            isModelReport(report)
              ? undefined
              : () => {
                  setAdjusting(null);
                  void start('make');
                }
          }
        />
      )}
      {isMakeReport(report) && compared && !adjusted && (
        <ComparePanel
          api={api}
          game={report.game.id}
          area={compared}
          onClose={() => {
            setComparing(null);
          }}
        />
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

function Failure({
  status,
  onMakeAll,
}: {
  status: CheckStatus;
  onMakeAll?: (() => void) | undefined;
}) {
  const title =
    status.kind === 'make'
      ? 'Making the map'
      : status.kind === 'remake'
        ? 'Making the area again'
        : status.kind === 'redraw'
          ? 'Drawing the maps again'
          : 'The check';
  return (
    <section className="mm-card mm-bad-card" role="alert">
      <h2>{title} stopped with an error</h2>
      <p>{status.error ?? 'The file reader stopped unexpectedly.'}</p>
      {(status.kind === 'remake' || status.kind === 'redraw') && (
        <p>Your map pack was left as it was.</p>
      )}
      {onMakeAll && (
        <div className="mm-row">
          <button type="button" className="button button-primary" onClick={onMakeAll}>
            Make map (all areas)
          </button>
        </div>
      )}
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

interface Adjusting {
  /** Areas whose floors are the player's own cuts. */
  ownFor: string[];
  /** The player's floor cuts as saved now, by area. */
  saved: Record<string, FloorEntry>;
  running: boolean;
  onAdjust: (area: string) => void;
  onCompare: (area: string) => void;
}

/** The model a map was made from, and how it was set up. */
function ModelLine({ report }: { report: MakeReport }) {
  const model = report.model!;
  const [east, north, height] = model.sizeMetres;
  return (
    <p className="small">
      From <span className="mono">{model.file}</span> ({model.format},{' '}
      {plural(model.triangles, 'triangle')}): {up(model.up)},{' '}
      {model.units ?? `${model.scale} m per unit`}, {east} × {north} m and {height} m high;{' '}
      {model.textures === 'plain'
        ? 'plain colours'
        : model.texturesFound > 0
          ? `${plural(model.texturesFound, 'texture')} kept`
          : 'no textures'}
      {model.bothSides ? ', faces seen from both sides' : ''}.
      {model.levelReport ? ` ${levelLines(model.levelReport).join(' ')}` : ''}
    </p>
  );
}

function up(axis: string): string {
  return `${axis.slice(1).toUpperCase()} ${axis.startsWith('-') ? 'down' : 'up'}`;
}

function MakeResults({ report, ...adjusting }: { report: MakeReport } & Adjusting) {
  const summary = report.summary;
  const fromModel = isModelReport(report);
  const made = report.areas.filter((area) => !area.skipped);
  const threeD = report.areas.some((area) => area.scene);
  const remade = report.remade;
  const ownFile = report.options?.floorOverrides;
  return (
    <>
      <section className="mm-card" aria-labelledby="result-title">
        <h2 id="result-title">{gameHeadline(report.game)}</h2>
        <p>{makeSummaryLine(report)}</p>
        {remade && (
          <p className="small">
            {remade.name} was made again at {new Date(remade.at).toLocaleTimeString()}; the other
            areas are as the make before made them.
          </p>
        )}
        {ownFile && ownFile.usedFor.length > 0 && (
          <p className="small">
            Your floor cuts were used for {plural(ownFile.usedFor.length, 'area')}:{' '}
            {ownFile.usedFor
              .map((key) => report.areas.find((area) => area.key === key)?.name ?? key)
              .join(', ')}
            .
          </p>
        )}
        {summary && categoryCounts(summary.markersByCategory) && (
          <p className="small">{categoryCounts(summary.markersByCategory)}.</p>
        )}
        {report.model && <ModelLine report={report} />}
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
                {!fromModel && <th scope="col">Markers</th>}
                {threeD && <th scope="col">3D model</th>}
                <th scope="col">To look at</th>
              </tr>
            </thead>
            <tbody>
              {report.areas.map((area) => (
                <MadeAreaRow
                  key={area.id}
                  area={area}
                  threeD={threeD}
                  markers={!fromModel}
                  {...adjusting}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {made.length > 0 && <FloorPreviews areas={made} markers={!fromModel} {...adjusting} />}
    </>
  );
}

function AdjustButton({ area, running, onAdjust }: { area: MadeArea } & Adjusting) {
  if (!canAdjustFloors(area)) return null;
  return (
    <button
      type="button"
      className="button mm-adjust"
      disabled={running}
      onClick={() => {
        onAdjust(area.key);
      }}
    >
      Adjust floors
    </button>
  );
}

function CompareButton({ area, running, onCompare }: { area: MadeArea } & Adjusting) {
  if (area.skipped || !(area.floors ?? []).some((floor) => floor.preview)) return null;
  return (
    <button
      type="button"
      className="button mm-adjust"
      disabled={running}
      onClick={() => {
        onCompare(area.key);
      }}
    >
      Compare with a picture…
    </button>
  );
}

function MadeAreaRow({
  area,
  threeD,
  markers,
  ...adjusting
}: { area: MadeArea; threeD: boolean; markers: boolean } & Adjusting) {
  const notes = areaNotes(area);
  const floors = area.floors ?? [];
  const cuts = cutsLine(area);
  return (
    <tr>
      <th scope="row">
        <div>{area.name}</div>
        <div className="muted small mono">{area.id}</div>
      </th>
      <td>
        {floors.length === 0
          ? '–'
          : [...floors].reverse().map((floor) => {
              const range = floorRangeText(floor);
              return (
                <div key={floor.index} className="small">
                  {floor.name}
                  <span className="muted">
                    {' '}
                    · {count(floor.areaSquareMetres)} m²{range ? ` · ${range}` : ''}
                  </span>
                </div>
              );
            })}
        {cuts && (
          <div className="small muted mm-cuts">
            {cuts}
            {adjusting.ownFor.includes(area.key) ? ' · your floor cuts' : ''}
          </div>
        )}
        {waitingCuts(area, adjusting.saved[area.key], adjusting.ownFor.includes(area.key)) && (
          <div className="small mm-tone-warn">
            Your saved floor cuts are not in this map yet: press Adjust floors, then Make this area
            again.
          </div>
        )}
        <AdjustButton area={area} {...adjusting} />
        <CompareButton area={area} {...adjusting} />
      </td>
      {markers && (
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
      )}
      {threeD && (
        <td className="small">
          {area.scene
            ? sceneLines(area.scene).map((line, index) => (
                <div key={index} className={index === 0 ? undefined : 'muted'}>
                  {line}
                </div>
              ))
            : '–'}
        </td>
      )}
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

function FloorPreviews({
  areas,
  markers,
  ...adjusting
}: { areas: MadeArea[]; markers: boolean } & Adjusting) {
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
        {markers
          ? 'Small copies of the map pictures, north (+z) up: lighter where higher, walls in dark lines, the floors below faded. Dots are markers on that floor.'
          : 'Small copies of the map pictures, north up: each floor from above with everything over it cut away, walls in dark lines, the floors below faded.'}
      </p>
      {markers && (
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
      )}
      <div className="mm-previews">
        {areas.flatMap((area) =>
          (area.floors ?? []).map((floor, index) => {
            const file = floorPreviewFile(floor);
            if (!file) return null;
            const range = floorRangeText(floor);
            return (
              <figure key={file} className="mm-preview">
                {images[file] ? (
                  <img src={images[file]} alt={`${area.name}, ${floor.name}, from above`} />
                ) : (
                  <div className="mm-preview-empty muted small">Loading…</div>
                )}
                <figcaption className="small">
                  {area.name}
                  <span className="muted">
                    {' '}
                    · {floor.name}
                    {range ? ` (${range})` : ''}
                  </span>
                  {index === 0 && <AdjustButton area={area} {...adjusting} />}
                </figcaption>
              </figure>
            );
          }),
        )}
      </div>
    </section>
  );
}
