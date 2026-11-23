import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { MadeArea } from './report';
import { errorText, type CompareAlignment, type ComparePicture, type Shell } from './shell';
import { clampAlignment, compareKey, startAlignment } from './compare';

/**
 * "Compare with a picture…": a picture the player chooses (PNG or JPEG, say another map of the area) beside or over
 * one of this area's floors, moved, sized and turned by hand to line up. How it lies is remembered per area in the
 * Map Maker's settings, with the picture's place on this computer; the picture is only shown, never copied into a
 * map pack.
 */
export function ComparePanel(props: {
  api: Shell;
  game: string;
  area: MadeArea;
  onClose: () => void;
}) {
  const { api, game, area } = props;
  const key = compareKey(game, area.key);
  const floors = area.floors ?? [];
  const [floor, setFloor] = useState(() =>
    Math.min(area.mainFloor ?? 0, Math.max(floors.length - 1, 0)),
  );
  const [mapUrl, setMapUrl] = useState<string | null>(null);
  const [picture, setPicture] = useState<ComparePicture | null>(null);
  const [alignment, setAlignment] = useState<CompareAlignment | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // The floor's map picture (the make's preview of it).
  const preview = floors[floor]?.preview;
  useEffect(() => {
    if (!preview) return;
    let live = true;
    api.previewImage(preview).then(
      (url) => {
        if (live) setMapUrl(url);
      },
      (error: unknown) => {
        if (live) setProblem(errorText(error));
      },
    );
    return () => {
      live = false;
    };
  }, [api, preview]);

  // The picture remembered for this area, if any.
  useEffect(() => {
    const run = { live: true };
    const open = async () => {
      const remembered = (await api.compareRead())[key];
      if (!remembered) return;
      const opened = await api.compareOpenPicture(remembered.picture);
      if (!run.live) return;
      setPicture(opened);
      setAlignment(clampAlignment(remembered));
    };
    open().then(
      () => {
        if (run.live) setLoading(false);
      },
      (error: unknown) => {
        if (!run.live) return;
        setProblem(errorText(error));
        setLoading(false);
      },
    );
    return () => {
      run.live = false;
    };
  }, [api, key]);

  // Remembered a moment after each change.
  useEffect(() => {
    if (!alignment) return;
    const timer = window.setTimeout(() => {
      api.compareSet(key, alignment).catch((error: unknown) => {
        setProblem(errorText(error));
      });
    }, 300);
    return () => {
      window.clearTimeout(timer);
    };
  }, [api, key, alignment]);

  const choose = useCallback(async () => {
    setProblem(null);
    try {
      const chosen = await api.comparePickPicture();
      if (!chosen) return;
      setPicture(chosen);
      setAlignment((current) =>
        current ? { ...current, picture: chosen.path } : startAlignment(chosen.path),
      );
    } catch (error) {
      setProblem(errorText(error));
    }
  }, [api]);

  const forget = useCallback(async () => {
    setProblem(null);
    try {
      await api.compareSet(key, null);
      setPicture(null);
      setAlignment(null);
    } catch (error) {
      setProblem(errorText(error));
    }
  }, [api, key]);

  const update = (change: Partial<CompareAlignment>) => {
    setAlignment((current) => (current ? clampAlignment({ ...current, ...change }) : current));
  };

  // Moving the picture by dragging it over the map.
  const stage = useRef<HTMLDivElement>(null);
  const dragFrom = useRef<{ x: number; y: number; at: [number, number] } | null>(null);
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (alignment?.view !== 'overlay') return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragFrom.current = { x: event.clientX, y: event.clientY, at: [alignment.x, alignment.y] };
  };
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const from = dragFrom.current;
    const box = stage.current?.getBoundingClientRect();
    if (!from || !box || box.width === 0 || box.height === 0) return;
    update({
      x: from.at[0] + (event.clientX - from.x) / box.width,
      y: from.at[1] + (event.clientY - from.y) / box.height,
    });
  };
  const endDrag = () => {
    dragFrom.current = null;
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!alignment) return;
    const step = event.shiftKey ? 0.05 : 0.005;
    const moves: Record<string, Partial<CompareAlignment>> = {
      ArrowLeft: { x: alignment.x - step },
      ArrowRight: { x: alignment.x + step },
      ArrowUp: { y: alignment.y - step },
      ArrowDown: { y: alignment.y + step },
      '+': { scale: alignment.scale * 1.02 },
      '=': { scale: alignment.scale * 1.02 },
      '-': { scale: alignment.scale / 1.02 },
      '[': { turn: alignment.turn - (event.shiftKey ? 5 : 0.5) },
      ']': { turn: alignment.turn + (event.shiftKey ? 5 : 0.5) },
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      update(move);
    }
  };

  const overlay = alignment?.view !== 'side';
  return (
    <div
      className="mm-overlay mm-compare-overlay"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <section
        className="mm-fp mm-compare"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compare-title"
      >
        <header className="mm-fp-head">
          <h2 id="compare-title" ref={titleRef} tabIndex={-1}>
            Compare with a picture: {area.name}
          </h2>
          <button type="button" className="button" onClick={props.onClose}>
            Close
          </button>
        </header>
        <p className="muted small">
          Choose a picture of a map of this area (PNG or JPEG) and line it up with the map Atlas
          made: drag it, or with the view selected use the arrow keys to move it, + and − to size
          it, and [ and ] to turn it (with Shift, in larger steps). How it lies is remembered for
          this area. The picture is only shown here: it is never copied into your map pack.
        </p>
        <div className="mm-row">
          <button type="button" className="button button-primary" onClick={() => void choose()}>
            {picture ? 'Choose another picture…' : 'Choose a picture…'}
          </button>
          {floors.length > 1 && (
            <label className="mm-fp-pick">
              <span className="small muted">Floor</span>
              <select
                value={floor}
                onChange={(event) => {
                  setFloor(Number(event.target.value));
                }}
              >
                {floors.map((f, index) => (
                  <option key={f.index} value={index}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {alignment && (
            <div className="mm-row" role="group" aria-label="View">
              <button
                type="button"
                className="button"
                aria-pressed={alignment.view === 'side'}
                onClick={() => {
                  update({ view: 'side' });
                }}
              >
                Side by side
              </button>
              <button
                type="button"
                className="button"
                aria-pressed={alignment.view !== 'side'}
                onClick={() => {
                  update({ view: 'overlay' });
                }}
              >
                Over the map
              </button>
            </div>
          )}
        </div>
        {problem && (
          <p className="mm-alert mm-bad" role="alert">
            {problem}
          </p>
        )}

        {picture && alignment && overlay ? (
          <div
            ref={stage}
            className="mm-compare-stage"
            tabIndex={0}
            role="application"
            aria-roledescription="picture over the map"
            aria-label={`${picture.name} over ${area.name}: drag it, or use the arrow keys, + and −, [ and ]`}
            onPointerDown={startDrag}
            onPointerMove={drag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={keys}
          >
            {mapUrl ? (
              <img className="mm-compare-map" src={mapUrl} alt="" draggable={false} />
            ) : (
              <div className="mm-preview-empty muted small">Loading the map…</div>
            )}
            <img
              className="mm-compare-picture"
              src={picture.url}
              alt=""
              draggable={false}
              style={{
                left: `${alignment.x * 100}%`,
                top: `${alignment.y * 100}%`,
                width: `${alignment.scale * 100}%`,
                opacity: alignment.opacity,
                transform: `translate(-50%, -50%) rotate(${alignment.turn}deg)`,
              }}
            />
          </div>
        ) : (
          <div className="mm-compare-side">
            <figure>
              {mapUrl ? (
                <img src={mapUrl} alt={`${area.name}, the map Atlas made`} />
              ) : (
                <div className="mm-preview-empty muted small">Loading the map…</div>
              )}
              <figcaption className="small">The map Atlas made</figcaption>
            </figure>
            <figure>
              {picture ? (
                <img src={picture.url} alt={`${picture.name}, the picture to compare with`} />
              ) : (
                <div className="mm-preview-empty muted small">
                  {loading ? 'Loading…' : 'No picture chosen yet'}
                </div>
              )}
              <figcaption className="small">{picture?.name ?? 'Your picture'}</figcaption>
            </figure>
          </div>
        )}

        {alignment && (
          <div className="mm-compare-controls">
            <label>
              <span className="small muted">Opacity</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(alignment.opacity * 100)}
                onChange={(event) => {
                  update({ opacity: Number(event.target.value) / 100 });
                }}
              />
              <span className="small">{Math.round(alignment.opacity * 100)}%</span>
            </label>
            <label>
              <span className="small muted">Size</span>
              <input
                type="range"
                min={-300}
                max={300}
                value={Math.round(Math.log2(alignment.scale) * 100)}
                onChange={(event) => {
                  update({ scale: 2 ** (Number(event.target.value) / 100) });
                }}
              />
              <span className="small">{Math.round(alignment.scale * 100)}% of the map’s width</span>
            </label>
            <label>
              <span className="small muted">Turn</span>
              <input
                type="range"
                min={-180}
                max={180}
                step={0.5}
                value={alignment.turn}
                onChange={(event) => {
                  update({ turn: Number(event.target.value) });
                }}
              />
              <span className="small">{alignment.turn}°</span>
            </label>
            <div className="mm-row">
              <button
                type="button"
                className="button"
                onClick={() => {
                  update({ x: 0.5, y: 0.5, scale: 1, turn: 0 });
                }}
              >
                Reset
              </button>
              <button type="button" className="button" onClick={() => void forget()}>
                Forget this picture
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
