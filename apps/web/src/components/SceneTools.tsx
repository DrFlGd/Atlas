import { useId, useState } from 'react';
import { SHADE_PRESETS, shadeSwatch, texturedReason, type SceneLook } from '../scene/looks';
import {
  cutOf,
  floorColoursReason,
  floorsOfMap,
  lookOf,
  pickFloor,
  requestSceneView,
  sceneOf,
  setCut,
  setCutTowardCamera,
  setFloorColoursShown,
  setLook,
  setShade,
  setStrongShade,
  setTitlesShown,
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
  // The list editor and a route being changed work in 2D.
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
                ? 'Shown in 2D while a list or a route is changed'
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
 * above", "Back to the start", the names of the areas on or off, "Look"
 * (textured or shaded, and the colour; see `LookPanel`), each floor in its
 * own colour or not ("Floor colours", where the map has floors: elsewhere
 * the button stays, to be reached with a controller, and says why it does
 * nothing), and the cuts: away above a height, when no floor is picked,
 * and toward the camera. After going to a location, All (or Back to the
 * start) goes back. One of Look and Cut is open at a time.
 */
export function SceneTools() {
  const game = useAtlas((s) => s.game);
  const mapId = useAtlas((s) => s.mapId);
  const layerId = useAtlas((s) => s.layerId);
  const allFloors = useScene3d((s) => s.allFloors);
  const cut = useScene3d((s) => cutOf(s, mapId));
  const towardCamera = useScene3d((s) => s.cutTowardCamera);
  const focus = useScene3d((s) => s.focus);
  const titles = useScene3d((s) => s.titles);
  const floorColours = useScene3d((s) => s.floorColours);
  const lookShown = useScene3d(lookOf);
  const ownLook = useScene3d((s) => s.ownLook);
  const shade = useScene3d((s) => s.shade);
  const strongShade = useScene3d((s) => s.strongShade);
  const [open, setOpen] = useState<'look' | 'cuts' | null>(null);
  const cutsOpen = open === 'cuts';
  const lookOpen = open === 'look';
  // The reason "Floor colours" does nothing here, once pressed; null: not asked.
  const [noFloorsFor, setNoFloorsFor] = useState<string | null>(null);
  const sliderId = useId();
  if (!game || !mapId) return null;
  const state = { game };
  const floors = floorsOfMap(state, mapId);
  const scene = sceneOf(state, mapId);
  const picked = floors.length > 0 && !allFloors ? layerId : null;
  const heights = sceneHeights(scene, floors);
  // Going to a location cuts above it, in place of the free cut.
  const shownCut = focus?.cut ?? cut;
  const cutting = shownCut !== null || towardCamera;
  const noColours = floorColoursReason(floors);
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
          aria-pressed={titles}
          data-testid="scene-titles-toggle"
          title={titles ? 'Hide the names of the areas' : 'Show the names of the areas'}
          onClick={() => {
            setTitlesShown(!titles);
          }}
        >
          <UiIcon name="titles" size={18} />
          <span>Area names</span>
        </button>
        <button
          type="button"
          className="scene-tool"
          aria-expanded={lookOpen}
          data-testid="scene-look"
          title="How the model is drawn: textured, or shaded in a colour"
          onClick={() => {
            setOpen(lookOpen ? null : 'look');
          }}
        >
          <UiIcon name="look" size={18} />
          <span>Look</span>
        </button>
        <FloorColoursToggle
          on={floorColours}
          reason={noColours}
          onPress={() => {
            if (noColours !== null) {
              setNoFloorsFor(noFloorsFor === mapId ? null : mapId);
              return;
            }
            setFloorColoursShown(!floorColours);
          }}
        />
        <button
          type="button"
          className="scene-tool"
          aria-expanded={cutsOpen}
          aria-pressed={cutting}
          data-testid="scene-cuts"
          onClick={() => {
            setOpen(cutsOpen ? null : 'cuts');
          }}
        >
          <UiIcon name="cut" size={18} />
          <span>Cut</span>
        </button>
      </div>
      {noColours !== null && noFloorsFor === mapId ? (
        <p className="scene-note" role="status" data-testid="scene-floor-colours-note">
          {noColours}: floor colours show only on a map with floors.
        </p>
      ) : null}
      {lookOpen ? (
        <LookPanel
          shown={lookShown}
          ownLook={ownLook}
          shade={shade}
          strong={strongShade}
          floorColours={floorColours && noColours === null}
          onLook={(look) => {
            // Already drawn so: the choice for other maps stays as it is.
            if (look !== lookShown) setLook(look);
          }}
          onShade={setShade}
          onStrong={setStrongShade}
        />
      ) : null}
      {cutsOpen ? (
        <div className="scene-cuts" data-testid="scene-cuts-panel">
          {picked === null && heights ? (
            <label className="scene-cut" htmlFor={sliderId}>
              <span className="scene-cut-label">
                Cut above{' '}
                <span className="muted">
                  {shownCut === null ? 'off' : Math.round(shownCut).toString()}
                </span>
              </span>
              <input
                id={sliderId}
                type="range"
                min={heights[0]}
                max={heights[1]}
                step={(heights[1] - heights[0]) / 100}
                value={Math.min(Math.max(shownCut ?? heights[1], heights[0]), heights[1])}
                data-testid="scene-cut-above"
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setCut(value >= heights[1] ? null : value, mapId);
                }}
              />
            </label>
          ) : picked !== null ? (
            <p className="scene-cut-note muted">
              {focus
                ? 'Cut just above the location shown. All goes back to every floor.'
                : 'The floor picked is cut above its top.'}
            </p>
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

/**
 * "Floor colours", on or off. Where it cannot be used (`reason`), it is
 * not disabled but marked so (`aria-disabled`): a controller still reaches
 * it, and pressing it says why.
 */
export function FloorColoursToggle(props: {
  on: boolean;
  reason: string | null;
  onPress: () => void;
}) {
  const { on, reason } = props;
  return (
    <button
      type="button"
      className="scene-tool"
      aria-pressed={reason === null && on}
      aria-disabled={reason !== null}
      data-testid="scene-floor-colours-toggle"
      title={
        reason !== null
          ? `Floor colours: ${reason.toLowerCase()}`
          : on
            ? 'Show the model in its own colours'
            : 'Show each floor in its own colour'
      }
      onClick={props.onPress}
    >
      <UiIcon name="floorColours" size={18} />
      <span>Floor colours</span>
    </button>
  );
}

/**
 * "Look": the model textured or shaded (see `scene/looks.ts`), the colour
 * it is shaded in (a few colours, or one of the person's own) and "Darker
 * walls and slopes". Where the model has no textures, Textured stays, to
 * be reached with a controller, and pressing it says why it does nothing.
 * Picking a colour shows the model shaded.
 */
export function LookPanel(props: {
  /** The look the model is drawn with. */
  shown: SceneLook;
  /** Whether the model has textures or colours of its own; null: not known yet. */
  ownLook: boolean | null;
  shade: string;
  strong: boolean;
  /** "Floor colours" is on, painting over the look. */
  floorColours: boolean;
  onLook: (look: SceneLook) => void;
  onShade: (shade: string) => void;
  onStrong: (on: boolean) => void;
}) {
  const { shown, shade, strong } = props;
  const reason = texturedReason(props.ownLook);
  const [whyAsked, setWhyAsked] = useState(false);
  const own = shade.startsWith('#');
  return (
    <div className="scene-cuts scene-look" data-testid="scene-look-panel">
      <div className="scene-look-choice" role="group" aria-label="Look">
        <button
          type="button"
          className="scene-look-option"
          aria-pressed={reason === null && shown === 'textured'}
          aria-disabled={reason !== null}
          data-testid="scene-look-textured"
          title={
            reason !== null
              ? `Textured: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`
              : 'Show the model with its own textures and colours'
          }
          onClick={() => {
            if (reason !== null) {
              setWhyAsked(!whyAsked);
              return;
            }
            props.onLook('textured');
          }}
        >
          Textured
        </button>
        <button
          type="button"
          className="scene-look-option"
          aria-pressed={shown === 'shaded'}
          data-testid="scene-look-shaded"
          title="Show the model in one colour, darker low and lighter high"
          onClick={() => {
            props.onLook('shaded');
          }}
        >
          Shaded
        </button>
      </div>
      {reason !== null && whyAsked ? (
        <p className="scene-cut-note muted" role="status" data-testid="scene-look-note">
          {reason}, so it is shown shaded.
        </p>
      ) : null}
      <div className="scene-shades" role="group" aria-label="Colour of the shaded look">
        {SHADE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="scene-shade"
            aria-pressed={shade === preset.id}
            aria-label={preset.name}
            title={preset.name}
            data-testid="scene-shade"
            data-shade={preset.id}
            style={{ background: shadeSwatch(preset.id) }}
            onClick={() => {
              props.onShade(preset.id);
            }}
          />
        ))}
        <label
          className="scene-shade scene-shade-own"
          data-pressed={own}
          title="A colour of your own"
          style={own ? { background: shade } : undefined}
        >
          <input
            type="color"
            aria-label="A colour of your own"
            value={shadeSwatch(shade)}
            data-testid="scene-shade-own"
            onChange={(event) => {
              props.onShade(event.target.value);
            }}
          />
        </label>
      </div>
      <label className="scene-cut-toggle">
        <input
          type="checkbox"
          checked={strong}
          data-testid="scene-strong-shade"
          onChange={(event) => {
            props.onStrong(event.target.checked);
          }}
        />
        Darker walls and slopes
      </label>
      {props.floorColours ? (
        <p className="scene-cut-note muted" data-testid="scene-look-floors">
          Floor colours is on, so each floor is shown in its own colour. Turn it off to see this
          look.
        </p>
      ) : null}
    </div>
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
