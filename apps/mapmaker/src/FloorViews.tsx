import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { fromBase64, northText, paintSection, tipPlace, type MarkerLook } from './floors';
import type { FloorsScene, FloorsSceneHover } from './floors3d';
import type { AreaMarker, AreaModel, Section } from './shell';

/**
 * The panel's 3D view (floors3d.ts, loaded when first shown): turned and zoomed with the mouse, a finger or the
 * keyboard; a marker under the pointer is named.
 */
export function Floors3D(props: {
  model: AreaModel;
  markers: readonly AreaMarker[];
  cuts: readonly number[];
  selected: number;
  hideAbove: boolean;
  showMarkers: boolean;
  outlines: boolean;
  looks: readonly MarkerLook[];
  label: string;
  describe: (index: number) => string;
  /** Automatic passages (see floors3d.ts). */
  triangleFloors?: Uint8Array | null;
  clipHeight?: number | null;
  places?: readonly { x: number; y: number; z: number; chosen: boolean }[];
  /** A press on the view: the marker pressed, or null for none. */
  onPick?: (index: number | null) => void;
  /** The item the view went to (`seq` tells a press again from the last), and the height it is cut at. */
  focus?: { index: number; cut: number; seq: number } | null;
  /** A 3D model's preview: each triangle in its own colour, and its bounds as a box. */
  ownColours?: boolean;
  bounds?: boolean;
  /** Remove pieces: a press chooses a surface (`onPickSurface`, the triangle pressed), and `marks` shows each
   * triangle's part in it (see floors3d.ts). */
  picking?: boolean;
  marks?: Uint8Array | null;
  onPickSurface?: (triangle: number | null) => void;
}) {
  const { model, markers, bounds } = props;
  const box = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<FloorsScene | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [hover, setHover] = useState<FloorsSceneHover | null>(null);
  const pickRef = useRef(props.onPick);
  const surfaceRef = useRef(props.onPickSurface);
  useEffect(() => {
    pickRef.current = props.onPick;
    surfaceRef.current = props.onPickSurface;
  });

  useEffect(() => {
    let live = true;
    let made: FloorsScene | null = null;
    import('./floors3d').then(
      ({ createFloorsScene }) => {
        if (!live || !box.current) return;
        try {
          made = createFloorsScene({
            container: box.current,
            model,
            markers,
            onHover: setHover,
            onPick: (index) => pickRef.current?.(index),
            onPickSurface: (triangle) => surfaceRef.current?.(triangle),
            bounds: bounds ?? false,
          });
          setScene(made);
        } catch {
          setProblem('The 3D view could not start: this computer’s graphics do not offer WebGL.');
        }
      },
      () => {
        if (live) setProblem('The 3D view could not be loaded.');
      },
    );
    return () => {
      live = false;
      made?.dispose();
    };
  }, [model, markers, bounds]);

  const { cuts, selected, hideAbove, showMarkers, outlines, looks } = props;
  const { triangleFloors, clipHeight, places, focus, ownColours, picking, marks } = props;
  const cutAt = focus?.cut ?? null;
  // Going to an item: the view flies down to it, once for each press.
  const flownTo = useRef(0);
  useEffect(() => {
    if (!scene || !focus || focus.seq === flownTo.current) return;
    flownTo.current = focus.seq;
    scene.goTo(focus.index);
  }, [scene, focus]);
  useEffect(() => {
    scene?.update({
      cuts,
      selected,
      hideAbove,
      showMarkers,
      outlines,
      looks,
      triangleFloors: triangleFloors ?? null,
      clipHeight: clipHeight ?? null,
      places: places ?? [],
      cutAt,
      ownColours: ownColours ?? false,
      picking: picking ?? false,
      marks: marks ?? null,
    });
  }, [
    picking,
    marks,
    cutAt,
    ownColours,
    scene,
    cuts,
    selected,
    hideAbove,
    showMarkers,
    outlines,
    looks,
    triangleFloors,
    clipHeight,
    places,
  ]);

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!scene) return;
    const step = event.shiftKey ? Math.PI / 4 : Math.PI / 12;
    const actions: Record<string, () => void> = {
      ArrowLeft: () => {
        scene.turn(-step, 0);
      },
      ArrowRight: () => {
        scene.turn(step, 0);
      },
      ArrowUp: () => {
        scene.turn(0, -step / 2);
      },
      ArrowDown: () => {
        scene.turn(0, step / 2);
      },
      '+': () => {
        scene.zoom(0.8);
      },
      '=': () => {
        scene.zoom(0.8);
      },
      '-': () => {
        scene.zoom(1.25);
      },
      _: () => {
        scene.zoom(1.25);
      },
      Home: () => {
        scene.resetView();
      },
    };
    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  };

  return (
    <div className="mm-fp-3d-view">
      <div
        ref={box}
        className="mm-fp-3d-canvas"
        role="application"
        aria-label={props.label}
        aria-roledescription="3D view"
        tabIndex={0}
        onKeyDown={keys}
      />
      {!scene && (
        <p className="mm-fp-3d-note small muted" role="status">
          {problem ?? 'Loading the 3D view…'}
        </p>
      )}
      {scene && (
        <button
          type="button"
          className="button mm-fp-3d-reset"
          onClick={() => {
            scene.resetView();
          }}
        >
          Reset view
        </button>
      )}
      {hover && (
        <span
          className="mm-fp-tip"
          style={{
            left: hover.x,
            top: hover.y,
            transform: tipPlace(hover.across, hover.down),
          }}
          role="status"
        >
          {props.describe(hover.index)}
        </span>
      )}
    </div>
  );
}

/** The section: the whole area from one side, coloured for the cuts as they change (no wait for the helper), or
 * with automatic passages, by each pixel's floor (`pixelFloors`). */
export function SectionPicture(props: {
  section: Section;
  low: number;
  high: number;
  cuts: readonly number[];
  selected: number;
  label: string;
  pixelFloors?: Uint8Array | null;
}) {
  const { section, low, high, cuts, selected, pixelFloors } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const pixels = useRef<{ text: string; bytes: Uint8Array } | null>(null);
  useEffect(() => {
    const target = canvas.current;
    const context = target?.getContext('2d');
    if (!target || !context || !section.pixels) return;
    if (pixels.current?.text !== section.pixels)
      pixels.current = { text: section.pixels, bytes: fromBase64(section.pixels) };
    target.width = section.columns;
    target.height = section.rows;
    const painted = paintSection(
      pixels.current.bytes,
      section.columns,
      section.rows,
      low,
      high,
      cuts,
      selected,
      pixelFloors,
    );
    context.putImageData(new ImageData(painted, section.columns, section.rows), 0, 0);
  }, [section, low, high, cuts, selected, pixelFloors]);
  return <canvas ref={canvas} className="mm-fp-section" role="img" aria-label={props.label} />;
}

/** A floor from above, turned a quarter at a time (`turn`, clockwise). */
export function TopPicture(props: { src: string; turn: number; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { src, turn } = props;
  useEffect(() => {
    let live = true;
    const image = new Image();
    image.onload = () => {
      const target = canvas.current;
      const context = target?.getContext('2d');
      if (!live || !target || !context) return;
      const odd = turn % 2 === 1;
      target.width = odd ? image.height : image.width;
      target.height = odd ? image.width : image.height;
      context.imageSmoothingEnabled = false;
      context.translate(target.width / 2, target.height / 2);
      context.rotate((turn * Math.PI) / 2);
      context.drawImage(image, -image.width / 2, -image.height / 2);
    };
    image.src = src;
    return () => {
      live = false;
    };
  }, [src, turn]);
  return (
    <canvas
      ref={canvas}
      className="mm-fp-top-picture"
      role="img"
      aria-label={`${props.label}, ${northText(turn)}`}
    />
  );
}
