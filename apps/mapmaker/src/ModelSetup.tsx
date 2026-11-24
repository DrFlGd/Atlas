import { useCallback, useMemo, useState } from 'react';
import { Floors3D } from './FloorViews';
import { MapStyleChoice } from './MapStyleChoice';
import {
  DEFAULT_MERGE_GAP,
  DEFAULT_SEPARATION,
  MODEL_FLOORS,
  UNITS,
  UP_CHOICES,
  packIdFor,
  previewModel,
  scaleOf,
  setupProblem,
  sizeHint,
  sizeMetres,
  sizeText,
  startSetup,
  type Inspected,
  type ModelFloors,
  type ModelSetup as Setup,
  type Units,
  type UpAxis,
} from './model';
import { count, plural, type MapStyleId } from './report';
import { errorText, type AppInfo, type CheckStatus, type ModelChoice, type Shell } from './shell';

const NO_MARKERS: never[] = [];
const NO_CUTS: number[] = [];

/** The file types the Map Maker reads, and what to do with the others. */
const FORMATS_NOTE =
  'glTF (.glb or .gltf), OBJ (with its .mtl materials file and textures), STL or PLY. FBX and COLLADA files cannot be read yet: export the model as glTF or OBJ from the program you made it in.';

/** The number typed in a box, or null when it is empty (the helper's own then). */
function typedNumber(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : Number.NaN;
}

/**
 * "Make a map from a 3D model…": choose a model file (the app's file dialog), see what the 3D builder read in it and
 * a preview of it turned and scaled as the map will be, set it up, and make its map pack.
 */
export function ModelSetup(props: {
  api: Shell;
  info: AppInfo | null;
  running: boolean;
  /** The map style chosen for game files, to start from when the model has no colours of its own. */
  mapStyle: MapStyleId;
  onStarted: (status: CheckStatus) => void;
}) {
  const { api, info, running } = props;
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const [inspected, setInspected] = useState<Inspected | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [customScale, setCustomScale] = useState('1');
  const [separation, setSeparation] = useState('');
  const [mergeGap, setMergeGap] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const read = useCallback(
    async (chosen: ModelChoice, allowLarge: boolean) => {
      setReading(true);
      setReadError(null);
      setInspected(null);
      try {
        const answer = await api.modelInspect(allowLarge);
        setInspected(answer);
        setSetup({ ...startSetup(chosen.name, answer.info, props.mapStyle), allowLarge });
        setCustomScale('1');
        setSeparation('');
        setMergeGap('');
      } catch (error) {
        setReadError(errorText(error));
        setSetup(null);
      } finally {
        setReading(false);
      }
    },
    [api, props.mapStyle],
  );

  const choose = useCallback(async () => {
    setProblem(null);
    try {
      const chosen = await api.chooseModel();
      if (!chosen) return;
      setChoice(chosen);
      await read(chosen, false);
    } catch (error) {
      setProblem(errorText(error));
    }
  }, [api, read]);

  const scale = setup ? setup.scale : 1;
  const up: UpAxis = setup?.up ?? '+y';
  const shownScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const model = useMemo(
    () => (inspected ? previewModel(inspected.preview, up, shownScale) : null),
    [inspected, up, shownScale],
  );

  const change = (patch: Partial<Setup>) => {
    setSetup((current) => (current ? { ...current, ...patch } : current));
  };

  const make = useCallback(async () => {
    if (!setup) return;
    const wanted: Setup = {
      ...setup,
      floorSeparation: setup.floors === 'ground' ? typedNumber(separation) : null,
      mergeGap: setup.floors === 'ground' ? typedNumber(mergeGap) : null,
    };
    const wrong = setupProblem(wanted);
    if (wrong) {
      setProblem(wrong);
      return;
    }
    setProblem(null);
    try {
      props.onStarted(await api.modelMakeStart(wanted));
    } catch (error) {
      setProblem(errorText(error));
    }
  }, [api, setup, separation, mergeGap, props]);

  const info3d = inspected?.info;
  const size = info3d && setup ? sizeMetres(info3d, setup.up, shownScale) : null;
  const hint = size ? sizeHint(size) : null;
  const tooMany = readError?.includes('Allow very large models') ?? false;
  const builderMissing = info !== null && !info.sceneBuilderFound;

  return (
    <section className="mm-card" aria-labelledby="step-model">
      <h2 id="step-model">Make a map from a 3D model</h2>
      <p className="small">
        Makes a map pack from a 3D model you made or exported, such as a building or a level:{' '}
        {FORMATS_NOTE}
      </p>
      <div className="mm-row">
        <button
          id="choose-model"
          type="button"
          className="button"
          onClick={() => void choose()}
          disabled={running || reading || builderMissing}
        >
          Make a map from a 3D model…
        </button>
        {choice && (
          <span className="mm-path" title={choice.path}>
            {choice.path}
          </span>
        )}
      </div>
      {builderMissing && (
        <p className="mm-alert mm-bad" role="alert">
          The 3D builder that comes with the Map Maker (atlas-scene) is missing: it reads model
          files. Please reinstall the app.
        </p>
      )}
      {reading && (
        <p className="small" role="status">
          Reading {choice?.name ?? 'the model'}…
        </p>
      )}
      {readError && choice && (
        <div className="mm-alert mm-bad" role="alert">
          <p>{readError}</p>
          {tooMany && (
            <button
              type="button"
              className="button"
              onClick={() => void read(choice, true)}
              disabled={reading}
            >
              Allow very large models and read it again
            </button>
          )}
        </div>
      )}
      {inspected && setup && info3d && model && (
        <div className="mm-model">
          <p className="small">
            {info3d.formatName}: {plural(info3d.triangles, 'triangle')},{' '}
            {plural(info3d.materials, 'material')}
            {info3d.texturedMaterials > 0
              ? `, ${count(info3d.texturesFound)} of ${plural(info3d.texturedMaterials, 'texture')} found`
              : ', no textures'}
            {info3d.hasColours ? '' : ', no colours of its own'}.
          </p>
          {info3d.missingFiles.length > 0 && (
            <p className="mm-alert mm-warn small">
              Missing next to the model: {info3d.missingFiles.join(', ')}. The map is made without{' '}
              {info3d.missingFiles.length === 1 ? 'it' : 'them'}; put{' '}
              {info3d.missingFiles.length === 1 ? 'it' : 'them'} in the model’s folder and choose
              the model again to use {info3d.missingFiles.length === 1 ? 'it' : 'them'}.
            </p>
          )}
          {info3d.warnings.length > 0 && (
            <ul className="mm-list small">
              {info3d.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          )}
          <div className="mm-model-grid">
            <div className="mm-model-fields">
              <div className="mm-style">
                <label htmlFor="model-name">Name</label>
                <input
                  id="model-name"
                  type="text"
                  value={setup.name}
                  maxLength={80}
                  disabled={running}
                  aria-describedby="model-name-note"
                  onChange={(event) => {
                    const name = event.target.value;
                    change({
                      name,
                      // The title follows the name until it is changed by itself.
                      title: setup.title === setup.name ? name : setup.title,
                    });
                  }}
                />
                <span id="model-name-note" className="small muted">
                  Its map pack is <span className="mono">{packIdFor(setup.name)}</span>; making a
                  map of the same name again replaces it.
                </span>
              </div>
              <div className="mm-style">
                <label htmlFor="model-title">Title in Atlas</label>
                <input
                  id="model-title"
                  type="text"
                  value={setup.title}
                  maxLength={80}
                  disabled={running}
                  onChange={(event) => {
                    change({ title: event.target.value });
                  }}
                />
              </div>
              <div className="mm-style">
                <label htmlFor="model-up">Up axis</label>
                <select
                  id="model-up"
                  value={setup.up}
                  disabled={running}
                  aria-describedby="model-up-note"
                  onChange={(event) => {
                    change({ up: event.target.value as UpAxis });
                  }}
                >
                  {UP_CHOICES.map((axis) => (
                    <option key={axis.id} value={axis.id}>
                      {axis.label}
                    </option>
                  ))}
                </select>
                <span id="model-up-note" className="small muted">
                  {setup.up === info3d.up
                    ? `As is usual for ${info3d.formatName.replace(/ \(.*\)$/, '')} files.`
                    : 'Changed from what is usual for this type of file.'}{' '}
                  Check the preview: the ground should be at the bottom.
                </span>
              </div>
              <div className="mm-style">
                <label htmlFor="model-units">Units</label>
                <select
                  id="model-units"
                  value={setup.units}
                  disabled={running}
                  aria-describedby="model-size"
                  onChange={(event) => {
                    const units = event.target.value as Units;
                    const custom = typedNumber(customScale) ?? Number.NaN;
                    change({ units, scale: scaleOf(units, custom) });
                  }}
                >
                  {UNITS.map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {unit.label}
                    </option>
                  ))}
                </select>
                {setup.units === 'custom' && (
                  <label className="mm-inline small">
                    Metres per unit{' '}
                    <input
                      id="model-scale"
                      type="text"
                      inputMode="decimal"
                      value={customScale}
                      disabled={running}
                      size={8}
                      onChange={(event) => {
                        setCustomScale(event.target.value);
                        change({ scale: typedNumber(event.target.value) ?? Number.NaN });
                      }}
                    />
                  </label>
                )}
                <span id="model-size" className="small">
                  {size ? `Size: ${sizeText(size)}.` : ''}
                  {hint ? <span className="mm-tone-warn"> {hint}</span> : null}
                </span>
              </div>
              <fieldset className="mm-fieldset">
                <legend>Textures</legend>
                <label className="mm-check">
                  <input
                    type="radio"
                    name="model-textures"
                    checked={setup.textures === 'keep'}
                    disabled={running}
                    onChange={() => {
                      change({ textures: 'keep' });
                    }}
                  />
                  Keep the model’s textures
                </label>
                <label className="mm-check">
                  <input
                    type="radio"
                    name="model-textures"
                    checked={setup.textures === 'plain'}
                    disabled={running}
                    onChange={() => {
                      change({ textures: 'plain' });
                    }}
                  />
                  Plain colours (smaller; each material in one colour)
                </label>
              </fieldset>
              <div className="mm-style">
                <label htmlFor="model-sides">Faces</label>
                <select
                  id="model-sides"
                  value={setup.doubleSided}
                  disabled={running}
                  onChange={(event) => {
                    change({ doubleSided: event.target.value as Setup['doubleSided'] });
                  }}
                >
                  <option value="auto">
                    {info3d.sidesGiven
                      ? 'As the file says'
                      : 'Both sides (usual for this type of file)'}
                  </option>
                  <option value="yes">Both sides</option>
                  <option value="no">Front side only</option>
                </select>
              </div>
              <div className="mm-style">
                <label htmlFor="model-floors">Floors</label>
                <select
                  id="model-floors"
                  value={setup.floors}
                  disabled={running}
                  aria-describedby="model-floors-note"
                  onChange={(event) => {
                    change({ floors: event.target.value as ModelFloors });
                  }}
                >
                  {MODEL_FLOORS.map((method) => (
                    <option key={method.id} value={method.id}>
                      {method.label}
                    </option>
                  ))}
                </select>
                <span id="model-floors-note" className="small muted">
                  {setup.floors === 'ground'
                    ? 'Finds each storey where there is much flat ground at one height, and cuts 1.5 m below it. You can move the cuts afterwards with Adjust floors.'
                    : setup.floors === 'passages'
                      ? 'Keeps the ground whole and splits it only where one walkable surface lies over another, such as a bridge over a street.'
                      : 'The whole model on one floor.'}
                </span>
              </div>
              {setup.floors === 'ground' && (
                <div className="mm-row">
                  <label className="mm-inline small">
                    Floors at least{' '}
                    <input
                      id="model-separation"
                      type="text"
                      inputMode="decimal"
                      size={4}
                      placeholder={String(DEFAULT_SEPARATION)}
                      value={separation}
                      disabled={running}
                      onChange={(event) => {
                        setSeparation(event.target.value);
                      }}
                    />{' '}
                    m apart
                  </label>
                  <label className="mm-inline small">
                    Join levels closer than{' '}
                    <input
                      id="model-merge-gap"
                      type="text"
                      inputMode="decimal"
                      size={4}
                      placeholder={String(DEFAULT_MERGE_GAP)}
                      value={mergeGap}
                      disabled={running}
                      onChange={(event) => {
                        setMergeGap(event.target.value);
                      }}
                    />{' '}
                    m
                  </label>
                </div>
              )}
              <MapStyleChoice
                id="model-style"
                label="Map style"
                value={setup.mapStyle}
                disabled={running}
                model
                onChange={(mapStyle) => {
                  change({ mapStyle });
                }}
              />
              <label className="mm-check">
                <input
                  id="model-large"
                  type="checkbox"
                  checked={setup.allowLarge}
                  disabled={running}
                  onChange={(event) => {
                    change({ allowLarge: event.target.checked });
                  }}
                />
                Allow very large models (up to 50 million triangles; needs much memory)
              </label>
            </div>
            <div className="mm-model-preview">
              <Floors3D
                model={model}
                markers={NO_MARKERS}
                cuts={NO_CUTS}
                selected={0}
                hideAbove={false}
                showMarkers={false}
                outlines={false}
                looks={NO_MARKERS}
                label={`${setup.name}, turned and scaled as the map will be`}
                describe={() => ''}
                ownColours
                bounds
              />
              <p className="small muted">
                {inspected.preview.simplified
                  ? `A simpler copy of the model (${count(inspected.preview.triangles)} triangles), `
                  : 'The model, '}
                turned and scaled as the map will be, in a box of its size. North is away from you.
              </p>
            </div>
          </div>
          <p className="small">
            No locations are made from a model: once the map is in Atlas, add them there with Edit
            locations.
          </p>
          <div className="mm-row">
            <button
              id="model-make"
              type="button"
              className="button button-primary"
              onClick={() => void make()}
              disabled={running || info?.helperFound === false}
            >
              Make map
            </button>
            <span className="small muted">
              Puts the map pack in{' '}
              <span className="mono">{info?.mapsFolder ?? 'the Atlas maps folder'}</span>.
            </span>
          </div>
        </div>
      )}
      {problem && (
        <p className="mm-alert mm-bad" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
