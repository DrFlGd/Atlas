import { useEffect, useState, type ReactNode } from 'react';
import { MapStyleChoice } from './MapStyleChoice';
import {
  defaultPack,
  isRedrawReport,
  redrawnMapLine,
  redrawSummaryLine,
  type RedrawReport,
} from './redrawing';
import { MAP_STYLES, type MapStyleId } from './report';
import { errorText, type CheckStatus, type PackWithScenes, type Shell } from './shell';

/**
 * "Draw all areas again": draws every 2D floor of a pack in the Atlas maps folder again from the pack's own 3D
 * models, in the map style chosen, with the player's floor cuts. No game files are needed, so it works for any
 * pack with 3D maps, made by the Map Maker or not.
 */
export function RedrawCard(props: {
  api: Shell;
  status: CheckStatus | null;
  /** The pack the make shown installed, offered first. */
  madePack: string | null;
  mapStyle: MapStyleId;
  running: boolean;
  helperFound: boolean;
  /** A style Make map draws too, chosen here: remembered for it. */
  onMapStyle: (style: MapStyleId) => void;
  onStart: (pack: string, style: MapStyleId) => void;
  onCancel: () => void;
  /** The progress of a redraw running or just finished. */
  progress: ReactNode;
}) {
  const { api, status } = props;
  const [packs, setPacks] = useState<PackWithScenes[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The pack's own model can be drawn in its textures too, as a map made from a model: those styles are kept here.
  const [style, setStyle] = useState<MapStyleId>(props.mapStyle);
  // Make map's style, once read from the settings or chosen there, is offered here too.
  const [makeStyle, setMakeStyle] = useState<MapStyleId>(props.mapStyle);
  if (makeStyle !== props.mapStyle) {
    setMakeStyle(props.mapStyle);
    setStyle(props.mapStyle);
  }
  // Listed again when a make or a redraw has finished.
  const finished = status?.state === 'done' ? status.runId : 0;
  useEffect(() => {
    let live = true;
    api.redrawPacks().then(
      (found) => {
        if (!live) return;
        setPacks(found);
        setChosen((current) =>
          current && found.some((pack) => pack.id === current)
            ? current
            : defaultPack(found, props.madePack),
        );
      },
      (error: unknown) => {
        if (live) setProblem(errorText(error));
      },
    );
    return () => {
      live = false;
    };
  }, [api, finished, props.madePack]);

  const picked = packs?.find((pack) => pack.id === chosen) ?? null;
  const report = status?.kind === 'redraw' && isRedrawReport(status.report) ? status.report : null;
  return (
    <section className="mm-card" aria-labelledby="redraw-title">
      <h2 id="redraw-title">Draw the maps again</h2>
      <p className="muted small">
        Draws every 2D floor of a map pack in the Atlas maps folder again from the pack’s own 3D
        models, in the map style chosen here, with your floor cuts. No game files are needed, so it
        works for any pack with 3D maps. The textured styles draw the model’s own textures and
        colours. Maps without a 3D model are left as they are.
      </p>
      {packs === null ? (
        <p className="muted small">Looking for map packs with 3D maps…</p>
      ) : packs.length === 0 ? (
        <p className="muted small">
          No map pack in the Atlas maps folder has 3D maps yet. Make a map with “Also make 3D maps”
          on, then come back here.
        </p>
      ) : (
        <>
          <div className="mm-style">
            <label htmlFor="redraw-pack">Map pack</label>
            <select
              id="redraw-pack"
              value={chosen ?? ''}
              disabled={props.running}
              onChange={(event) => {
                setChosen(event.target.value);
              }}
            >
              {packs.map((pack) => (
                <option key={pack.id} value={pack.id}>
                  {pack.title} ({pack.maps3d} of {pack.maps} maps in 3D)
                </option>
              ))}
            </select>
          </div>
          <MapStyleChoice
            id="redraw-style"
            label="Map style"
            value={style}
            model
            disabled={props.running}
            onChange={(next) => {
              setStyle(next);
              if (MAP_STYLES.some((entry) => entry.id === next && entry.available)) {
                props.onMapStyle(next);
              }
            }}
          />
          <div className="mm-row">
            <button
              id="redraw-start"
              type="button"
              className="button button-primary"
              disabled={!picked || props.running || !props.helperFound}
              onClick={() => {
                if (picked) props.onStart(picked.id, style);
              }}
            >
              Draw all areas again
            </button>
            {props.running && status?.kind === 'redraw' && (
              <button
                id="redraw-cancel"
                type="button"
                className="button"
                onClick={props.onCancel}
                disabled={status.state === 'cancelling'}
              >
                {status.state === 'cancelling' ? 'Stopping…' : 'Cancel'}
              </button>
            )}
          </div>
          {status?.kind === 'redraw' && props.progress}
          {picked && !picked.madeByMapMaker && (
            <p className="muted small">
              This pack was not made by the Map Maker: its maps keep their floors as they are, and a
              map whose floor cuts would change the number of its floors is left as it was.
            </p>
          )}
        </>
      )}
      {problem && (
        <p className="mm-alert mm-bad" role="alert">
          {problem}
        </p>
      )}
      {report && status?.state === 'done' && <RedrawResults report={report} />}
    </section>
  );
}

function RedrawResults({ report }: { report: RedrawReport }) {
  return (
    <div className="mm-redraw-results" data-testid="redraw-results">
      <p>{redrawSummaryLine(report)} If Atlas is open, open the map again to see it.</p>
      <ul className="mm-list small">
        {report.maps.map((map) => (
          <li key={map.id} className={map.redrawn ? undefined : 'muted'}>
            <strong>{map.name}</strong>: {redrawnMapLine(map)}
          </li>
        ))}
      </ul>
      {report.warnings.length > 0 && (
        <>
          <h3>Warnings</h3>
          <ul className="mm-list small">
            {report.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
