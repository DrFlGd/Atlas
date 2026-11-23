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
}) {
  const { model, markers } = props;
  const box = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<FloorsScene | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [hover, setHover] = useState<FloorsSceneHover | null>(null);

  useEffect(() => {
    let live = true;
    let made: FloorsScene | null = null;
    import('./floors3d').then(
      ({ createFloorsScene }) => {
        if (!live || !box.current) return;
        try {
          made = createFloorsScene({ container: box.current, model, markers, onHover: setHover });
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
  }, [model, markers]);

  const { cuts, selected, hideAbove, showMarkers, outlines, looks } = props;
  useEffect(() => {
    scene?.update({ cuts, selected, hideAbove, showMarkers, outlines, looks });
  }, [scene, cuts, selected, hideAbove, showMarkers, outlines, looks]);

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

/** The section: the whole area from one side, coloured for the cuts as they change (no wait for the helper). */
export function SectionPicture(props: {
  section: Section;
  low: number;
  high: number;
  cuts: readonly number[];
  selected: number;
  label: string;
}) {
  const { section, low, high, cuts, selected } = props;
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
    );
    context.putImageData(new ImageData(painted, section.columns, section.rows), 0, 0);
  }, [section, low, high, cuts, selected]);
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
