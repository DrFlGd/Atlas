import { useId, useState } from 'react';
import {
  floorsOfMap,
  pickFloor,
  requestSceneView,
  sceneOf,
  setCut,
  setCutTowardCamera,
  setViewMode,
  useScene3d,
  useSceneShown,
} from '../state/scene3d';
import { useAtlas } from '../state/store';
import { UiIcon } from './icons';

/** "2D | 3D": how a map with a model is shown. */
export function SceneSwitch() {
  const mode = useScene3d((s) => s.mode);
  const webgl = useScene3d((s) => s.webgl);
  const shown = useSceneShown();
  // Edit locations, the list editor and a route being changed work in 2D.
  const editing = mode === '3d' && webgl !== 'no' && !shown;
  return (
    <div
      className="scene-switch"
      role="group"
      aria-label="Show the map in"
      data-testid="scene-switch"
    >
      {(['2d', '3d'] as const).map((value) => (
        <button
          key={value}
          type="button"
          className="scene-switch-button"
          aria-pressed={value === '3d' ? shown : !shown}
          disabled={value === '3d' && (webgl === 'no' || editing)}
          data-testid={`scene-mode-${value}`}
          title={
            value === '2d'
              ? 'Show the map in 2D'
              : editing
                ? 'Shown in 2D while locations are changed'
                : 'Show the map in 3D'
          }
          onClick={() => {
            setViewMode(value);
          }}
        >
          {value === '2d' ? '2D' : '3D'}
        </button>
      ))}
    </div>
  );
}

/**
 * The 3D view's tools: the floors (each, or all of them), "View from
 * above", "Back to the start", and the cuts: away above a height, when no
 * floor is picked, and toward the camera.
 */
export function SceneTools() {
  const game = useAtlas((s) => s.game);
  const mapId = useAtlas((s) => s.mapId);
  const layerId = useAtlas((s) => s.layerId);
  const allFloors = useScene3d((s) => s.allFloors);
  const cut = useScene3d((s) => s.cut);
  const towardCamera = useScene3d((s) => s.cutTowardCamera);
  const [cutsOpen, setCutsOpen] = useState(false);
  const sliderId = useId();
  if (!game || !mapId) return null;
  const state = { game };
  const floors = floorsOfMap(state, mapId);
  const scene = sceneOf(state, mapId);
  const picked = floors.length > 0 && !allFloors ? layerId : null;
  const heights = sceneHeights(scene, floors);
  const cutting = cut !== null || towardCamera;
  return (
    <>
      {floors.length > 0 ? (
        <div className="scene-floors" role="group" aria-label="Floor" data-testid="scene-floors">
          <button
            type="button"
            className="scene-floor"
            aria-pressed={picked === null}
            data-testid="scene-floor-all"
            onClick={() => {
              pickFloor(null);
            }}
          >
            All
          </button>
          {[...floors].reverse().map((floor) => (
            <button
              key={floor.id}
              type="button"
              className="scene-floor"
              aria-pressed={picked === floor.id}
              data-testid="scene-floor"
              data-layer={floor.id}
              onClick={() => {
                pickFloor(floor.id);
              }}
            >
              {floor.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="scene-buttons">
        <button
          type="button"
          className="scene-tool"
          data-testid="scene-from-above"
          title="View from above (V)"
          onClick={() => {
            requestSceneView('above');
          }}
        >
          <UiIcon name="fromAbove" size={18} />
          <span>View from above</span>
        </button>
        <button
          type="button"
          className="scene-tool"
          data-testid="scene-recenter"
          title="Back to where the view started (0)"
          onClick={() => {
            requestSceneView('recenter');
          }}
        >
          <UiIcon name="recenter" size={18} />
          <span>Back to the start</span>
        </button>
        <button
          type="button"
          className="scene-tool"
          aria-expanded={cutsOpen}
          aria-pressed={cutting}
          data-testid="scene-cuts"
          onClick={() => {
            setCutsOpen(!cutsOpen);
          }}
        >
          <UiIcon name="cut" size={18} />
          <span>Cut</span>
        </button>
      </div>
      {cutsOpen ? (
        <div className="scene-cuts" data-testid="scene-cuts-panel">
          {picked === null && heights ? (
            <label className="scene-cut" htmlFor={sliderId}>
              <span className="scene-cut-label">
                Cut above{' '}
                <span className="muted">{cut === null ? 'off' : Math.round(cut).toString()}</span>
              </span>
              <input
                id={sliderId}
                type="range"
                min={heights[0]}
                max={heights[1]}
                step={(heights[1] - heights[0]) / 100}
                value={cut ?? heights[1]}
                data-testid="scene-cut-above"
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setCut(value >= heights[1] ? null : value);
                }}
              />
            </label>
          ) : picked !== null ? (
            <p className="scene-cut-note muted">The floor picked is cut above its top.</p>
          ) : null}
          <label className="scene-cut-toggle">
            <input
              type="checkbox"
              checked={towardCamera}
              data-testid="scene-cut-camera"
              onChange={(event) => {
                setCutTowardCamera(event.target.checked);
              }}
            />
            Cut toward the camera
          </label>
        </div>
      ) : null}
    </>
  );
}

/** The heights the free cut runs over: the model's, else those of its cells and floors. */
function sceneHeights(
  scene: ReturnType<typeof sceneOf>,
  floors: readonly { heights?: readonly [number, number] | undefined }[],
): [number, number] | null {
  if (!scene) return null;
  if (scene.heights) return [scene.heights[0], scene.heights[1]];
  const all = [
    ...scene.cells.flatMap((cell) => (cell.heights ? [...cell.heights] : [])),
    ...floors.flatMap((floor) => (floor.heights ? [...floor.heights] : [])),
  ];
  if (all.length < 2) return null;
  const low = Math.min(...all);
  const high = Math.max(...all);
  return high > low ? [low, high] : null;
}
