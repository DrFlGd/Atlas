import { lazy, Suspense, useEffect } from 'react';
import { layoutChoiceOffered } from '../features';
import { setLayout } from '../state/actions';
import { sceneOf, useScene3d, useSceneShown, webglSupport } from '../state/scene3d';
import { useAtlas } from '../state/store';
import { MapPane, type TouchMapOptions } from './MapPane';
import { SceneSwitch, SceneTools } from './SceneTools';

// The 3D view and three.js: a chunk of their own, loaded when a map is first shown in 3D.
const SceneView = lazy(() => import('../scene/SceneView'));

/**
 * The map of the standard layout: the 2D map, or the 3D view where the map
 * shown has a model and 3D is chosen (see `state/scene3d.ts`), with the
 * switch between them and the 3D view's tools.
 */
export function MapStage({ touch }: { touch: TouchMapOptions }) {
  const hasScene = useAtlas((s) => sceneOf(s, s.mapId) !== null);
  const shown = useSceneShown();
  const webgl = useScene3d((s) => s.webgl);
  const mode = useScene3d((s) => s.mode);
  useEffect(() => {
    if (hasScene) webglSupport();
  }, [hasScene]);
  return (
    <>
      {shown && webgl === 'yes' ? (
        <Suspense fallback={<SceneLoading />}>
          <SceneView touch={touch} />
        </Suspense>
      ) : shown ? (
        <SceneLoading />
      ) : (
        <MapPane touch={touch} />
      )}
      {hasScene ? (
        <div className="scene-side" data-testid="scene-side">
          <SceneSwitch />
          {shown ? <SceneTools /> : null}
          {webgl === 'no' && mode === '3d' ? (
            <p className="scene-note" role="status" data-testid="scene-no-webgl">
              This map has a 3D view, but this device cannot show it (it needs WebGL 2). The map is
              shown in 2D.
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function SceneLoading() {
  return (
    <div className="map-area scene-area">
      <p className="scene-loading" role="status">
        Opening the 3D view…
      </p>
    </div>
  );
}

/** The classic layout's note on a map with a model: it is shown in 2D there. */
export function ClassicSceneNote() {
  const hasScene = useAtlas((s) => sceneOf(s, s.mapId) !== null);
  const layoutChoice = useAtlas(layoutChoiceOffered);
  if (!hasScene) return null;
  return (
    <div className="scene-note scene-note-classic" role="note" data-testid="scene-classic-note">
      <span>This map has a 3D view, shown in the standard layout. Here it is shown in 2D.</span>
      {layoutChoice ? (
        <button
          type="button"
          className="button button-small"
          onClick={() => {
            setLayout('standard');
          }}
        >
          Use the standard layout
        </button>
      ) : null}
    </div>
  );
}
