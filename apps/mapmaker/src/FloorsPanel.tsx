import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Floors3D, SectionPicture, TopPicture } from './FloorViews';
import { MapStyleChoice } from './MapStyleChoice';
import {
  addCut,
  canAddCut,
  checkMarker,
  deleteFloor,
  entryOf,
  floorBands,
  floorColour,
  heightTicks,
  lookOf,
  markerTypeText,
  moveCut,
  northText,
  removeCut,
  renameFloor,
  tipPlace,
  roundHeight,
  sameDraft,
  shippedDraft,
  startDraft,
  suggestedCut,
  walkableBetween,
  type FloorsDraft,
} from './floors';
import {
  count,
  cutSourceText,
  heightText,
  mapStyleLabel,
  plural,
  type HeightProfile,
  type MadeArea,
  type MapStyleId,
} from './report';
import {
  errorText,
  type CheckStatus,
  type FloorOverrides,
  type FloorViews,
  type FloorViewsReady,
  type Shell,
} from './shell';

interface Props {
  api: Shell;
  area: MadeArea;
  game: string;
  status: CheckStatus | null;
  make3d: boolean;
  /** The style the area was drawn in: Make this area again starts from it. */
  mapStyle: MapStyleId;
  /** When this area was made again last, from these floors. */
  remadeAt: string | null;
  onClose: () => void;
  onOverrides: (overrides: FloorOverrides) => void;
  onRemake: (area: string, style: MapStyleId) => Promise<void>;
  onCancel: () => void;
  onMakeAll: () => void;
}

type Axis = 'x' | 'z';

const AXES: { axis: Axis; label: string; note: string }[] = [
  { axis: 'x', label: 'Seen from the south', note: 'west on the left, east on the right' },
  { axis: 'z', label: 'Seen from the east', note: 'south on the left, north on the right' },
];

/** The view under the section: the 3D model, or the selected floor from above. */
type Lower = '3d' | 'top';

/**
 * Adjust floors: one area's floors, the cuts between them, and views to place the cuts by. A cut is moved by
 * dragging its line or with the keyboard (it is a slider), or by typing its height.
 */
export function FloorsPanel(props: Props) {
  const { api, area, game, status } = props;
  const [draft, setDraft] = useState<FloorsDraft>(() => startDraft(area));
  const [baseline, setBaseline] = useState<FloorsDraft>(() => startDraft(area));
  const [ready, setReady] = useState<FloorViewsReady | null>(null);
  const [views, setViews] = useState<FloorViews | null>(null);
  const [viewsProblem, setViewsProblem] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [selected, setSelected] = useState(area.mainFloor ?? 0);
  const [axis, setAxis] = useState<Axis>('x');
  const [lower, setLower] = useState<Lower>('3d');
  const [full3d, setFull3d] = useState(false);
  const [hideAbove, setHideAbove] = useState(false);
  const [showItems, setShowItems] = useState(true);
  const [turn, setTurn] = useState(0);
  const [tip, setTip] = useState<number | null>(null);
  const [style, setStyle] = useState<MapStyleId>(props.mapStyle);
  const [outlines, setOutlines] = useState(props.mapStyle === 'outlines');
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const running = status?.state === 'running' || status?.state === 'cancelling';
  const remaking = running && status.kind === 'remake';
  const profile: HeightProfile | undefined = ready?.profile ?? area.floorPlan?.profile;
  const low = ready?.heights.low ?? profile?.low ?? 0;
  const high =
    ready?.heights.high ?? (profile && profile.high > profile.low ? profile.high : low + 1);
  const floorCount = draft.cuts.length + 1;
  const bands = floorBands(draft.cuts, low, high);
  const shown = Math.min(selected, floorCount - 1);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // The views helper, while the panel is open (not while the area is being made again: that rewrites its data).
  useEffect(() => {
    if (running) return;
    let live = true;
    api.floorViewsOpen(area.key).then(
      (answer) => {
        if (!live) return;
        setReady(answer);
        setViewsProblem(null);
      },
      (error: unknown) => {
        if (live) setViewsProblem(errorText(error));
      },
    );
    return () => {
      live = false;
    };
  }, [api, area.key, running]);
  useEffect(
    () => () => {
      void api.floorViewsClose().catch(() => undefined);
    },
    [api],
  );

  // Redraw the views a moment after the cuts or names change; one request at a time, the latest wins.
  const wanted = useRef({ draft, outlines });
  useEffect(() => {
    wanted.current = { draft, outlines };
  }, [draft, outlines]);
  const inFlight = useRef(false);
  const again = useRef(false);
  const redraw = useCallback(async () => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    setDrawing(true);
    try {
      for (let more = true; more; more = again.current) {
        again.current = false;
        const asked = entryOf(wanted.current.draft);
        const answer = await api.floorViewsRequest(
          area.key,
          asked.cuts ?? [],
          asked.names ?? [],
          wanted.current.outlines,
        );
        setViews(answer);
        setViewsProblem(null);
      }
    } catch (error) {
      setViewsProblem(errorText(error));
    } finally {
      inFlight.current = false;
      setDrawing(false);
    }
  }, [api, area.key]);
  useEffect(() => {
    if (!ready || running) return;
    const timer = window.setTimeout(() => void redraw(), 200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [ready, running, draft, outlines, redraw]);

  const change = (next: FloorsDraft) => {
    setDraft(next);
    setMessage(null);
  };

  // Dragging a cut line.
  const plotRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const heightAt = (clientY: number) => {
    const box = plotRef.current?.getBoundingClientRect();
    if (!box || box.height === 0) return null;
    const fraction = (clientY - box.top) / box.height;
    return Math.round((high - fraction * (high - low)) * 10) / 10;
  };
  const top = (height: number) => `${((high - height) / (high - low)) * 100}%`;
  const startDrag = (event: ReactPointerEvent<HTMLElement>, index: number) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = index;
  };
  const drag = (event: ReactPointerEvent<HTMLElement>, index: number) => {
    if (dragging.current !== index) return;
    const height = heightAt(event.clientY);
    if (height !== null) setDraft((current) => moveCut(current, index, height, low, high));
  };
  const endDrag = () => {
    dragging.current = null;
  };
  const cutKeys = (event: KeyboardEvent<HTMLElement>, index: number) => {
    const by: Record<string, number> = {
      ArrowUp: 0.1,
      ArrowRight: 0.1,
      ArrowDown: -0.1,
      ArrowLeft: -0.1,
      PageUp: 1,
      PageDown: -1,
    };
    if (event.key in by) {
      event.preventDefault();
      const step = by[event.key]! * (event.shiftKey ? 10 : 1);
      change(moveCut(draft, index, draft.cuts[index]! + step, low, high));
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      change(removeCut(draft, index));
    }
  };

  // Where each cut came from: as made (automatic, yours or the Map Maker's), or moved here.
  const sourceOf = (cut: number) => {
    const made = area.floorPlan?.cutList?.find((entry) => Math.abs(entry.height - cut) < 0.005);
    return made ? cutSourceText(made.by) : 'set by you';
  };
  const viewed = views?.cuts.join() === draft.cuts.map(roundHeight).join() ? views : null;
  const nameOf = (index: number) =>
    draft.names[index]?.trim()
      ? draft.names[index].trim()
      : (viewed?.floors[index]?.name ?? `Floor ${index + 1}`);

  // Each marker for these cuts: its floor, and whether a cut passes within a metre of it.
  const markers = useMemo(() => ready?.markers ?? [], [ready]);
  const placed = viewed?.markers;
  const checks = useMemo(
    () => markers.map((marker, i) => checkMarker(draft.cuts, marker.y, placed?.[i])),
    [markers, draft.cuts, placed],
  );
  const looks = useMemo(() => checks.map(lookOf), [checks]);
  const nearCount = checks.filter((check) => check.nearCut !== null).length;
  const describe = (index: number) => {
    const marker = markers[index];
    const check = checks[index];
    if (!marker || !check) return '';
    const notes = [
      `${markerTypeText(marker.type)} at ${heightText(marker.y)}`,
      `on ${nameOf(check.floor)}`,
    ];
    if (check.nearCut !== null)
      notes.push(
        `${heightText(roundHeight(Math.abs(marker.y - check.nearCut)))} from the cut at ${heightText(check.nearCut)}`,
      );
    if (check.noSurface) notes.push('no walkable floor under it');
    else if (check.otherFloor) notes.push('its height is on another floor');
    return notes.join(' · ');
  };

  const [newCut, setNewCut] = useState<number>(() =>
    profile ? suggestedCut(profile, draft.cuts) : 0,
  );
  const addable = canAddCut(draft, newCut, low, high);

  const save = async (): Promise<boolean> => {
    setProblem(null);
    try {
      props.onOverrides(await api.floorOverridesSet(game, area.key, entryOf(draft)));
      setBaseline(draft);
      return true;
    } catch (error) {
      setProblem(errorText(error));
      return false;
    }
  };
  const backToAutomatic = async () => {
    setProblem(null);
    try {
      props.onOverrides(await api.floorOverridesSet(game, area.key, null));
      const next = shippedDraft(area, ready?.shippedCuts);
      setDraft(next);
      setBaseline(next);
      setMessage(
        'Your cuts for this area are cleared: it has the Map Maker’s own floors again. Press Make this area again to redraw its map.',
      );
    } catch (error) {
      setProblem(errorText(error));
    }
  };
  const remake = async () => {
    if (!(await save())) return;
    setMessage(null);
    await props.onRemake(area.key, style);
  };
  const saveFile = async () => {
    setProblem(null);
    try {
      if (!sameDraft(draft, baseline) && !(await save())) return;
      const file = await api.floorOverridesSaveFile(game);
      if (file)
        setMessage(
          `Saved your floor cuts of ${plural(file.areas, 'area')} as ${file.name}. Upload that file to the thread.`,
        );
    } catch (error) {
      setProblem(errorText(error));
    }
  };
  const loadFile = async () => {
    setProblem(null);
    try {
      const file = await api.floorOverridesLoadFile();
      if (!file) return;
      if (file.overrides) props.onOverrides(file.overrides);
      const entry = file.overrides?.[game]?.[area.key];
      if (entry?.cuts) {
        const next = { cuts: [...entry.cuts], names: entry.names ?? [] };
        setDraft(next);
        setBaseline(next);
      }
      setMessage(
        `Loaded the floor cuts of ${plural(file.areas, 'area')} from ${file.name}. Make map, or Make this area again, uses them.`,
      );
    } catch (error) {
      setProblem(errorText(error));
    }
  };

  const unsaved = !sameDraft(draft, baseline);
  const maxBar = Math.max(1, ...(profile?.areas ?? [1]));
  const section = ready?.section[axis] ?? null;
  const tipAcross = (marker: { x: number; z: number }) =>
    section && section.to > section.from
      ? ((axis === 'x' ? marker.x : marker.z) - section.from) / (section.to - section.from)
      : 0.5;
  const topView = viewed?.floors[shown]?.top ?? null;
  const floorsHighestFirst = [...bands].reverse();
  const failedRemake = status?.kind === 'remake' && status.state === 'failed' ? status : null;

  return (
    <div
      className="mm-overlay"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || dragging.current !== null) return;
        if (full3d) setFull3d(false);
        else props.onClose();
      }}
    >
      <section
        className="mm-fp"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fp-title"
        aria-describedby="fp-intro"
      >
        <header className="mm-fp-head">
          <h2 id="fp-title" ref={titleRef} tabIndex={-1}>
            Adjust floors: {area.name}
          </h2>
          <button type="button" className="button" onClick={props.onClose}>
            Close
          </button>
        </header>
        <p id="fp-intro" className="muted small">
          A cut is the height where one floor ends and the next begins. Drag a cut’s line, or type
          its height; with the keyboard, the arrow keys move a selected cut by 0.1 m and Page Up or
          Page Down by 1 m. The section, the 3D view and the floor from above follow as you go.
          Items lie at walking height, so a cut passing through them is likely in the wrong place.
          Press Make this area again to redraw this area’s map from these floors.
        </p>

        <div className="mm-fp-body">
          <div className="mm-fp-views">
            <div className="mm-row mm-fp-axes" role="group" aria-label="Side view">
              {AXES.map((entry) => (
                <button
                  key={entry.axis}
                  type="button"
                  className="button"
                  aria-pressed={axis === entry.axis}
                  onClick={() => {
                    setAxis(entry.axis);
                  }}
                >
                  {entry.label}
                </button>
              ))}
              <button
                type="button"
                className="button"
                aria-pressed={showItems}
                onClick={() => {
                  setShowItems(!showItems);
                }}
              >
                Show items
              </button>
            </div>
            <div className="mm-fp-chart">
              <div className="mm-fp-axis" aria-hidden="true">
                {heightTicks(low, high).map((tick) => (
                  <span key={tick} style={{ top: top(tick) }}>
                    {heightText(tick)}
                  </span>
                ))}
              </div>
              <div className="mm-fp-plot" ref={plotRef}>
                <svg
                  className="mm-fp-bars"
                  viewBox={`0 0 100 ${high - low}`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  {(profile?.areas ?? []).map((value, index) => {
                    if (value <= 0) return null;
                    const barLow = profile!.low + index * profile!.step;
                    const band = draft.cuts.filter(
                      (cut) => cut < barLow + profile!.step / 2,
                    ).length;
                    return (
                      <rect
                        key={index}
                        x={0}
                        y={high - barLow - profile!.step}
                        height={profile!.step}
                        width={Math.max(2, Math.sqrt(value / maxBar) * 100)}
                        fill={floorColour(band)}
                      />
                    );
                  })}
                </svg>
                <div className="mm-fp-side">
                  {section?.pixels ? (
                    <SectionPicture
                      section={section}
                      low={low}
                      high={high}
                      cuts={draft.cuts}
                      selected={shown}
                      label={`${area.name} ${AXES.find((a) => a.axis === axis)!.label.toLowerCase()}, walls and all, each floor in its colour`}
                    />
                  ) : (
                    <span className="muted small">
                      {viewsProblem ? 'No section' : 'Drawing the section…'}
                    </span>
                  )}
                  {section?.pixels &&
                    showItems &&
                    section.to > section.from &&
                    markers.map((marker, index) => {
                      const check = checks[index]!;
                      const across = axis === 'x' ? marker.x : marker.z;
                      const look = looks[index];
                      return (
                        <button
                          key={index}
                          type="button"
                          className={`mm-fp-dot${look === 1 ? ' mm-fp-dot-near' : ''}${look === 2 ? ' mm-fp-dot-odd' : ''}`}
                          style={{
                            left: `${((across - section.from) / (section.to - section.from)) * 100}%`,
                            top: top(marker.y),
                            background: marker.colour,
                          }}
                          aria-label={describe(index)}
                          onPointerEnter={() => {
                            setTip(index);
                          }}
                          onPointerLeave={() => {
                            setTip(null);
                          }}
                          onFocus={() => {
                            setTip(index);
                          }}
                          onBlur={() => {
                            setTip(null);
                          }}
                          onClick={() => {
                            setSelected(check.floor);
                          }}
                        />
                      );
                    })}
                  {tip !== null && showItems && section && markers[tip] && (
                    <span
                      className="mm-fp-tip"
                      role="status"
                      style={{
                        left: `${tipAcross(markers[tip]) * 100}%`,
                        top: top(markers[tip].y),
                        transform: tipPlace(
                          tipAcross(markers[tip]),
                          (high - markers[tip].y) / (high - low),
                        ),
                      }}
                    >
                      {describe(tip)}
                    </span>
                  )}
                </div>
                {bands.map((band) => (
                  <div
                    key={band.index}
                    className={band.index === shown ? 'mm-fp-band mm-fp-band-on' : 'mm-fp-band'}
                    style={{
                      top: top(band.to),
                      height: `${((band.to - band.from) / (high - low)) * 100}%`,
                    }}
                    onClick={() => {
                      setSelected(band.index);
                    }}
                    aria-hidden="true"
                  />
                ))}
                {draft.cuts.map((cut, index) => (
                  <div
                    key={index}
                    className="mm-fp-cut"
                    style={{ top: top(cut) }}
                    onPointerDown={(event) => {
                      startDrag(event, index);
                    }}
                    onPointerMove={(event) => {
                      drag(event, index);
                    }}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                  >
                    <span
                      className="mm-fp-handle"
                      role="slider"
                      tabIndex={0}
                      aria-label={`Cut ${index + 1}, between ${nameOf(index)} and ${nameOf(index + 1)}`}
                      aria-valuemin={roundHeight(low)}
                      aria-valuemax={roundHeight(high)}
                      aria-valuenow={cut}
                      aria-valuetext={heightText(cut)}
                      aria-orientation="vertical"
                      onKeyDown={(event) => {
                        cutKeys(event, index);
                      }}
                    >
                      {heightText(cut)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <p className="muted small">
              Left: how much walkable floor there is at each height. Right: the whole area{' '}
              {AXES.find((a) => a.axis === axis)!.label.toLowerCase()} (
              {AXES.find((a) => a.axis === axis)!.note}, heights stretched to fit): walkable floor
              as bright lines, walls see-through and lighter where more stand one behind another,
              each in the colour of its floor.
              {showItems &&
                ' Dots are items and other locations, in the colour of their type: a yellow ring is within 1 m of a cut, a white ring is on another floor than its height gives or has no floor under it.'}{' '}
              Press a floor to choose it.
            </p>
            {showItems && nearCount > 0 && (
              <p className="mm-alert mm-warn small">
                {plural(nearCount, 'marker')} {nearCount === 1 ? 'lies' : 'lie'} within 1 m of a
                cut. Things lie at walking height, so the cut may be in the wrong place.
              </p>
            )}

            <div className="mm-row mm-fp-axes" role="group" aria-label="View below">
              <button
                type="button"
                className="button"
                aria-pressed={lower === '3d'}
                onClick={() => {
                  setLower('3d');
                }}
              >
                3D view
              </button>
              <button
                type="button"
                className="button"
                aria-pressed={lower === 'top'}
                onClick={() => {
                  setLower('top');
                }}
              >
                From above
              </button>
            </div>
            {(lower === '3d' || full3d) && (
              <div
                className={full3d ? 'mm-fp-3d mm-fp-3d-full' : 'mm-fp-3d'}
                role={full3d ? 'dialog' : undefined}
                aria-label={full3d ? `${area.name} in 3D` : undefined}
              >
                <div className="mm-row mm-fp-3d-tools">
                  {full3d && <strong>{area.name}</strong>}
                  <label className="mm-fp-pick">
                    <span className="small muted">Floor</span>
                    <select
                      value={shown}
                      onChange={(event) => {
                        setSelected(Number(event.target.value));
                      }}
                    >
                      {floorsHighestFirst.map((band) => (
                        <option key={band.index} value={band.index}>
                          {nameOf(band.index)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="button"
                    aria-pressed={hideAbove}
                    disabled={shown === floorCount - 1}
                    onClick={() => {
                      setHideAbove(!hideAbove);
                    }}
                  >
                    Hide what is above this floor
                  </button>
                  <button
                    type="button"
                    className="button"
                    aria-pressed={showItems}
                    onClick={() => {
                      setShowItems(!showItems);
                    }}
                  >
                    Show items
                  </button>
                  <button
                    type="button"
                    className="button"
                    aria-pressed={outlines}
                    onClick={() => {
                      setOutlines(!outlines);
                    }}
                  >
                    Outlines
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setFull3d(!full3d);
                    }}
                  >
                    {full3d ? 'Back to the floors' : 'Full 3D'}
                  </button>
                </div>
                {ready && ready.model.triangles > 0 ? (
                  <Floors3D
                    model={ready.model}
                    markers={ready.markers}
                    cuts={draft.cuts}
                    selected={shown}
                    hideAbove={hideAbove && shown < floorCount - 1}
                    showMarkers={showItems}
                    outlines={outlines}
                    looks={looks}
                    label={`${area.name} in 3D, ${nameOf(shown)} chosen`}
                    describe={describe}
                  />
                ) : (
                  <div className="mm-preview-empty muted small">
                    {viewsProblem ? 'No 3D view' : 'Loading the area…'}
                  </div>
                )}
                <p className="muted small">
                  Drag to turn, scroll or pinch to zoom, right-drag or drag with two fingers to
                  move. With the view selected: the arrow keys turn it, + and − zoom, Home goes back
                  to the start. Each cut is a see-through level in the colour of the floor above it;
                  the chosen floor is bright. Outlines draws the edges of the walls and floors.
                </p>
              </div>
            )}
            {lower === 'top' && (
              <figure className="mm-fp-top">
                <div className="mm-row mm-fp-3d-tools">
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setTurn((turn + 3) % 4);
                    }}
                  >
                    Turn left
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setTurn((turn + 1) % 4);
                    }}
                  >
                    Turn right
                  </button>
                  <button
                    type="button"
                    className="button"
                    aria-pressed={outlines}
                    onClick={() => {
                      setOutlines(!outlines);
                    }}
                  >
                    Outlines
                  </button>
                </div>
                {topView ? (
                  <div
                    className="mm-fp-top-box"
                    tabIndex={0}
                    aria-label={`${nameOf(shown)} from above: the arrow keys Left and Right turn it`}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                        event.preventDefault();
                        setTurn((turn + (event.key === 'ArrowLeft' ? 3 : 1)) % 4);
                      }
                    }}
                  >
                    <TopPicture src={topView} turn={turn} label={`${nameOf(shown)} from above`} />
                  </div>
                ) : (
                  <div className="mm-preview-empty muted small">
                    {viewsProblem ? 'No picture' : 'Drawing…'}
                  </div>
                )}
                <figcaption className="small">
                  From above, {northText(turn)}: <strong>{nameOf(shown)}</strong>, with what is
                  above it left out, as its map is drawn. The floors below show faintly; dots are
                  markers on this floor
                  {outlines ? '; outlines are the walls and the edge of the floor' : ''}.
                </figcaption>
              </figure>
            )}
            <p className="small mm-fp-state" role="status">
              {viewsProblem ?? stateText(drawing, ready !== null, viewed)}
            </p>
          </div>

          <div className="mm-fp-side-panel">
            <h3>Floors, highest first</h3>
            <ol className="mm-fp-list" reversed>
              {floorsHighestFirst.map((band) => {
                const floor = viewed?.floors[band.index];
                const walkable =
                  floor?.areaSquareMetres ??
                  (profile ? walkableBetween(profile, band.from, band.to) : 0);
                const cutIndex = band.index - 1;
                return (
                  <li key={band.index} className="mm-fp-item">
                    <div
                      className={
                        band.index === shown ? 'mm-fp-floor mm-fp-floor-on' : 'mm-fp-floor'
                      }
                    >
                      <span
                        className="mm-fp-swatch"
                        style={{ background: floorColour(band.index) }}
                        aria-hidden="true"
                      />
                      <div className="mm-fp-floor-main">
                        <label className="mm-fp-name">
                          <span className="small muted">Floor {band.index + 1} name</span>
                          <input
                            type="text"
                            value={draft.names[band.index] ?? ''}
                            placeholder={floor?.name ?? 'The Map Maker’s name'}
                            maxLength={80}
                            onChange={(event) => {
                              change(renameFloor(draft, band.index, event.target.value));
                            }}
                          />
                        </label>
                        <div className="small muted">
                          {band.index === 0 ? 'bottom' : heightText(band.from)} to{' '}
                          {band.index === floorCount - 1 ? 'top' : heightText(band.to)} ·{' '}
                          {count(walkable)} m² walkable
                          {floor ? ` · ${plural(floor.markers, 'marker')}` : ''}
                        </div>
                        <div className="mm-row mm-fp-buttons">
                          <button
                            type="button"
                            className="button"
                            aria-pressed={band.index === shown && lower === 'top'}
                            onClick={() => {
                              setSelected(band.index);
                              setLower('top');
                            }}
                          >
                            Show from above
                          </button>
                          <button
                            type="button"
                            className="button"
                            aria-pressed={band.index === shown && lower === '3d'}
                            onClick={() => {
                              setSelected(band.index);
                              setLower('3d');
                            }}
                          >
                            Show in 3D
                          </button>
                          <button
                            type="button"
                            className="button"
                            disabled={floorCount === 1}
                            onClick={() => {
                              change(deleteFloor(draft, band.index));
                              setSelected(Math.max(0, band.index - 1));
                            }}
                          >
                            Delete floor
                          </button>
                        </div>
                      </div>
                    </div>
                    {cutIndex >= 0 && (
                      <CutRow
                        index={cutIndex}
                        cut={draft.cuts[cutIndex]!}
                        source={sourceOf(draft.cuts[cutIndex]!)}
                        onChange={(height) => {
                          change(moveCut(draft, cutIndex, height, low, high));
                        }}
                        onRemove={() => {
                          change(removeCut(draft, cutIndex));
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ol>
            {viewed && viewed.dropped.length > 0 && (
              <p className="mm-alert mm-warn small">
                {viewed.dropped.map(heightText).join(', ')}:{' '}
                {viewed.dropped.length === 1 ? 'this cut leaves' : 'these cuts leave'} a floor with
                nothing on it, so the map will not use {viewed.dropped.length === 1 ? 'it' : 'them'}
                .
              </p>
            )}

            <div className="mm-fp-add">
              <label>
                <span className="small muted">Add a floor: cut at</span>
                <HeightField
                  label="Height of the new cut, in metres"
                  value={newCut}
                  onChange={setNewCut}
                />
              </label>
              <button
                type="button"
                className="button"
                disabled={!addable}
                onClick={() => {
                  const next = addCut(draft, newCut);
                  change(next);
                  setSelected(next.cuts.indexOf(roundHeight(newCut)) + 1);
                  if (profile) setNewCut(suggestedCut(profile, next.cuts));
                }}
              >
                Add a floor
              </button>
            </div>
            {!addable && (
              <p className="small muted">
                Choose a height between {heightText(low)} and {heightText(high)}, at least 0.5 m
                from another cut.
              </p>
            )}
          </div>
        </div>

        <footer className="mm-fp-foot">
          {message && (
            <p className="mm-alert mm-good" role="status">
              {message}
            </p>
          )}
          {problem && (
            <p className="mm-alert mm-bad" role="alert">
              {problem}
            </p>
          )}
          {props.remadeAt && !unsaved && !remaking && (
            <p className="mm-alert mm-good" role="status">
              This area’s map was made again from these floors at {props.remadeAt}.
            </p>
          )}
          {remaking && (
            <div className="mm-fp-progress">
              <div
                className="mm-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(status.fraction * 100)}
                aria-label="Making this area again"
              >
                <div
                  className="mm-progress-fill"
                  style={{ width: `${Math.round(status.fraction * 100)}%` }}
                />
              </div>
              <div className="mm-row">
                <span className="small">
                  {Math.round(status.fraction * 100)}% · {status.message || 'Starting…'}
                </span>
                <button
                  type="button"
                  className="button"
                  onClick={props.onCancel}
                  disabled={status.state === 'cancelling'}
                >
                  {status.state === 'cancelling' ? 'Stopping…' : 'Cancel'}
                </button>
              </div>
            </div>
          )}
          {failedRemake && (
            <div className="mm-alert mm-bad" role="alert">
              <p>{failedRemake.error ?? 'Making the area again stopped.'}</p>
              {failedRemake.errorCode && (
                <button type="button" className="button button-primary" onClick={props.onMakeAll}>
                  Make map (all areas)
                </button>
              )}
            </div>
          )}
          <MapStyleChoice
            id="fp-style"
            label="Map style of this area"
            value={style}
            disabled={running}
            onChange={setStyle}
          />
          <div className="mm-row">
            <button
              type="button"
              className="button button-primary"
              disabled={running}
              onClick={() => void remake()}
            >
              Make this area again
            </button>
            <button
              type="button"
              className="button"
              disabled={!unsaved || running}
              onClick={() => {
                void save().then((done) => {
                  if (done)
                    setMessage(
                      'Saved. Make map and Make this area again use your cuts for this area.',
                    );
                });
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="button"
              disabled={running}
              onClick={() => void backToAutomatic()}
            >
              Back to automatic
            </button>
            {unsaved && <span className="small mm-tone-warn">Not saved yet</span>}
          </div>
          <p className="muted small">
            Make this area again redraws this area’s map from these floors in the style chosen (now{' '}
            {mapStyleLabel(props.mapStyle).toLowerCase()})
            {props.make3d ? ', with its 3D model,' : ''} and puts it in your map pack in place of
            the old one. The other maps stay as they are.
          </p>
          <div className="mm-row">
            <button type="button" className="button" onClick={() => void saveFile()}>
              Save my floor cuts to a file…
            </button>
            <button type="button" className="button" onClick={() => void loadFile()}>
              Load floor cuts from a file…
            </button>
          </div>
          <p className="muted small">
            The file holds your cuts and floor names of every area of this game, and nothing of the
            game itself.
          </p>
        </footer>
      </section>
    </div>
  );
}

function stateText(drawing: boolean, ready: boolean, viewed: FloorViews | null): string {
  if (drawing) return 'Redrawing…';
  if (!ready) return 'Loading the area’s floors…';
  return viewed ? `Drawn in ${viewed.seconds} s.` : '';
}

function CutRow(props: {
  index: number;
  cut: number;
  source: string;
  onChange: (height: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="mm-fp-cutrow">
      <label>
        <span className="small muted">Cut {props.index + 1} at</span>
        <HeightField
          label={`Height of cut ${props.index + 1}, in metres`}
          value={props.cut}
          onChange={props.onChange}
        />
      </label>
      <span className="small muted">{props.source}</span>
      <button type="button" className="button" onClick={props.onRemove}>
        Remove cut
      </button>
    </div>
  );
}

/** A height in metres, typed: taken when it is a number, put back to the value when left otherwise. */
function HeightField(props: { label: string; value: number; onChange: (height: number) => void }) {
  const [text, setText] = useState(String(props.value));
  const [editing, setEditing] = useState(false);
  const shown = editing ? text : String(props.value);
  return (
    <span className="mm-fp-height">
      <input
        type="number"
        inputMode="decimal"
        step={0.1}
        aria-label={props.label}
        value={shown}
        onFocus={() => {
          setText(String(props.value));
          setEditing(true);
        }}
        onBlur={() => {
          setEditing(false);
        }}
        onChange={(event) => {
          setText(event.target.value);
          const height = Number.parseFloat(event.target.value);
          if (Number.isFinite(height)) props.onChange(height);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
      <span className="small muted">m</span>
    </span>
  );
}
