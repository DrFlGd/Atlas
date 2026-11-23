import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ComparePanel } from './Compare';
import { Floors3D, SectionPicture, TopPicture } from './FloorViews';
import { MapStyleChoice } from './MapStyleChoice';
import {
  addCut,
  bandOf,
  canAddCut,
  checkMarker,
  deleteFloor,
  floorBands,
  floorAtPixel,
  placeSlots,
  floorColour,
  fromBase64,
  headCut,
  heightTicks,
  lookOf,
  markerTypeText,
  methodEntry,
  moveCut,
  northText,
  removeCut,
  renameFloor,
  setShow,
  showOf,
  startChoices,
  startMethod,
  tipPlace,
  roundHeight,
  shippedDraft,
  startDraft,
  suggestedCut,
  walkableBetween,
  type FloorsDraft,
  type MarkerCheck,
} from './floors';
import {
  FLOOR_METHODS,
  count,
  cutSourceText,
  floorMethodLabel,
  heightText,
  mapStyleLabel,
  plural,
  type FloorMethod,
  type HeightProfile,
  type MadeArea,
  type MapStyleId,
  type PassageChoice,
  type PassagePlace,
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
  const [method, setMethod] = useState<FloorMethod>(() => startMethod(area));
  const [choices, setChoices] = useState<PassageChoice[]>(() => startChoices(area));
  const [baseline, setBaseline] = useState<string>(() =>
    JSON.stringify(
      methodEntry(
        startMethod(area),
        startDraft(area),
        startChoices(area),
        area.floors?.length ?? 1,
      ),
    ),
  );
  const [place, setPlace] = useState<number | null>(null);
  const [comparing, setComparing] = useState(false);
  const [ready, setReady] = useState<FloorViewsReady | null>(null);
  const [views, setViews] = useState<FloorViews | null>(null);
  const [viewsProblem, setViewsProblem] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [selected, setSelected] = useState(area.mainFloor ?? 0);
  const [axis, setAxis] = useState<Axis>('x');
  const [lower, setLower] = useState<Lower>('3d');
  const [full3d, setFull3d] = useState(false);
  const [hideAbove, setHideAbove] = useState(false);
  // The item the 3D view went to, and the cut above it (see floors3d.ts).
  const [focus, setFocus] = useState<{ index: number; cut: number; seq: number } | null>(null);
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
  const passages = method === 'passages';
  const choicesKey = JSON.stringify(choices);

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
  const wanted = useRef({ draft, outlines, method, choices });
  useEffect(() => {
    wanted.current = { draft, outlines, method, choices };
  }, [draft, outlines, method, choices]);
  // What each answer was asked for: with passages, the views are those of these choices only.
  const [askedKey, setAskedKey] = useState('');
  // The last views of passages, shown while new ones are drawn.
  const [passageViews, setPassageViews] = useState<FloorViews | null>(null);
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
        const now = wanted.current;
        const cutsAsked = now.draft.cuts.map(roundHeight);
        const namesAsked = now.draft.names.map((name) => name.trim());
        const answer = await api.floorViewsRequest(
          area.key,
          now.method === 'cuts' ? cutsAsked : [],
          namesAsked,
          now.outlines,
          now.method,
          now.method === 'passages' ? now.choices : [],
        );
        setViews(answer);
        if (answer.method === 'passages') setPassageViews(answer);
        setAskedKey(`${now.method}|${JSON.stringify(now.choices)}`);
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
  }, [ready, running, draft, outlines, method, choicesKey, redraw]);

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
  const viewed = passages
    ? views?.method === 'passages' && askedKey === `passages|${choicesKey}`
      ? views
      : null
    : views &&
        views.method !== 'passages' &&
        views.cuts.join() === draft.cuts.map(roundHeight).join()
      ? views
      : null;
  const floorCount = passages
    ? Math.max(1, passageViews?.floors.length ?? area.floors?.length ?? 1)
    : draft.cuts.length + 1;
  const bands = passages
    ? Array.from({ length: floorCount }, (_, index) => {
        const heights = passageViews?.floors[index]?.heights ?? [low, high];
        return { index, from: heights[0], to: heights[1] };
      })
    : floorBands(draft.cuts, low, high);
  const shown = Math.min(selected, floorCount - 1);
  const places = useMemo<PassagePlace[]>(() => passageViews?.places ?? [], [passageViews]);
  const pixelFloors = useMemo(() => {
    const text = passageViews?.sectionFloors?.[axis];
    return text ? fromBase64(text) : null;
  }, [passageViews, axis]);
  const triangleFloors = useMemo(() => {
    const text = passageViews?.triangleFloors;
    return text ? fromBase64(text) : null;
  }, [passageViews]);
  const placeDots = useMemo(
    () => places.map((p) => ({ x: p.x, y: p.heights[1], z: p.z, chosen: p.id === place })),
    [places, place],
  );
  const nameOf = (index: number) =>
    draft.names[index]?.trim()
      ? draft.names[index].trim()
      : ((passages ? passageViews : viewed)?.floors[index]?.name ?? `Floor ${index + 1}`);

  // Each marker for these cuts: its floor, and whether a cut passes within a metre of it.
  const markers = useMemo(() => ready?.markers ?? [], [ready]);
  const placed = (passages ? passageViews : viewed)?.markers;
  const checks = useMemo(
    () =>
      markers.map((marker, i): MarkerCheck => {
        if (!passages) return checkMarker(draft.cuts, marker.y, placed?.[i]);
        // Passages are not apart in height: a marker is on the floor of the surface under it.
        const at = placed?.[i];
        return {
          floor: at?.floor ?? 0,
          nearCut: null,
          otherFloor: false,
          noSurface: at?.surface === null,
        };
      }),
    [markers, draft.cuts, placed, passages],
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

  const entryNow = methodEntry(method, draft, choices, floorCount);
  const save = async (): Promise<boolean> => {
    setProblem(null);
    try {
      props.onOverrides(await api.floorOverridesSet(game, area.key, entryNow));
      setBaseline(JSON.stringify(entryNow));
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
      const nextChoices = [...(area.floorPlan?.shipped?.passages ?? [])];
      setDraft(next);
      setChoices(nextChoices);
      setBaseline(JSON.stringify(methodEntry(method, next, nextChoices, floorCount)));
      setMessage(
        passages
          ? 'Your choices for this area are cleared: each overlapping place shows its upper storey again. Press Make this area again to redraw its map.'
          : 'Your cuts for this area are cleared: it has the Map Maker’s own floors again. Press Make this area again to redraw its map.',
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
      if (unsaved && !(await save())) return;
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
      if (entry) {
        const nextMethod = entry.method ?? method;
        const next = { cuts: [...(entry.cuts ?? draft.cuts)], names: entry.names ?? [] };
        const nextChoices = [...(entry.passages ?? [])];
        setMethod(nextMethod);
        setDraft(next);
        setChoices(nextChoices);
        setBaseline(JSON.stringify(methodEntry(nextMethod, next, nextChoices, floorCount)));
      }
      setMessage(
        `Loaded the floor cuts of ${plural(file.areas, 'area')} from ${file.name}. Make map, or Make this area again, uses them.`,
      );
    } catch (error) {
      setProblem(errorText(error));
    }
  };

  const unsaved = JSON.stringify(entryNow) !== baseline;
  const choose = (target: PassagePlace, show: 'upper' | 'lower') => {
    setChoices(setShow(choices, target, show));
    setPlace(target.id);
    setMessage(null);
  };
  const maxBar = Math.max(1, ...(profile?.areas ?? [1]));
  const section = ready?.section[axis] ?? null;
  const slots = useMemo(() => {
    if (!section) return [];
    const across = places.map((p) => ({
      across: axis === 'x' ? p.x : p.z,
      low: Math.min(p.heights[0], p.heights[1]),
      high: Math.max(p.heights[0], p.heights[1]),
    }));
    return placeSlots(across, (section.to - section.from) * 0.03);
  }, [places, axis, section]);
  const tipAcross = (marker: { x: number; z: number }) =>
    section && section.to > section.from
      ? ((axis === 'x' ? marker.x : marker.z) - section.from) / (section.to - section.from)
      : 0.5;
  const topView = (passages ? passageViews : viewed)?.floors[shown]?.top ?? null;
  const floorsHighestFirst = [...bands].reverse();
  const failedRemake = status?.kind === 'remake' && status.state === 'failed' ? status : null;

  return (
    <div
      className="mm-overlay"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || dragging.current !== null) return;
        // Back from an item the 3D view went to, first.
        if (focus) setFocus(null);
        else if (full3d) setFull3d(false);
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
        {passages ? (
          <p id="fp-intro" className="muted small">
            Automatic passages keep the ground whole and split it only where one walkable surface
            lies over another, such as a bridge over a street: each such overlapping place is listed
            on the right, where you choose whether the main floor shows its upper storey (the
            bridge) or its lower one (the passage under it). The other storey goes on a floor of its
            own. The section, the 3D view and the floor from above follow as you go. Press Make this
            area again to redraw this area’s map from these floors.
          </p>
        ) : (
          <p id="fp-intro" className="muted small">
            A cut is the height where one floor ends and the next begins. Drag a cut’s line, or type
            its height; with the keyboard, the arrow keys move a selected cut by 0.1 m and Page Up
            or Page Down by 1 m. The section, the 3D view and the floor from above follow as you go.
            Items lie at walking height, so a cut passing through them is likely in the wrong place.
            Press Make this area again to redraw this area’s map from these floors.
          </p>
        )}

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
                    const band = passages
                      ? -1
                      : draft.cuts.filter((cut) => cut < barLow + profile!.step / 2).length;
                    return (
                      <rect
                        key={index}
                        x={0}
                        y={high - barLow - profile!.step}
                        height={profile!.step}
                        width={Math.max(2, Math.sqrt(value / maxBar) * 100)}
                        fill={band < 0 ? 'var(--mm-fp-bar-plain, #8a909a)' : floorColour(band)}
                      />
                    );
                  })}
                </svg>
                <div
                  className="mm-fp-side"
                  onClick={(event) => {
                    // Automatic passages: pressing a walkable surface in the section chooses its floor.
                    if (!passages || !section || event.target !== event.currentTarget.firstChild)
                      return;
                    const box = event.currentTarget.getBoundingClientRect();
                    const floor = floorAtPixel(
                      pixelFloors,
                      section.columns,
                      section.rows,
                      (event.clientX - box.left) / box.width,
                      (event.clientY - box.top) / box.height,
                    );
                    if (floor !== null) setSelected(floor);
                  }}
                >
                  {section?.pixels ? (
                    <SectionPicture
                      section={section}
                      low={low}
                      high={high}
                      cuts={passages ? [] : draft.cuts}
                      selected={shown}
                      pixelFloors={passages ? pixelFloors : null}
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
                  {passages &&
                    section &&
                    section.to > section.from &&
                    places.map((p, number) => {
                      const across = axis === 'x' ? p.x : p.z;
                      const lowest = Math.min(p.heights[0], p.heights[1]);
                      const highest = Math.max(p.heights[0], p.heights[1]);
                      const slot = slots[number] ?? 0;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className={`mm-fp-place${p.id === place ? ' mm-fp-place-on' : ''}`}
                          style={{
                            left: `calc(${((across - section.from) / (section.to - section.from)) * 100}% + ${slot * 18}px)`,
                            top: top(highest + 0.6),
                            height: `${((highest - lowest + 1.2) / (high - low)) * 100}%`,
                          }}
                          aria-label={`Overlapping place ${number + 1}: the main floor shows its ${p.show === 'lower' ? 'lower' : 'upper'} storey`}
                          onClick={() => {
                            setPlace(p.id);
                          }}
                        >
                          <span>{number + 1}</span>
                        </button>
                      );
                    })}
                </div>
                {!passages &&
                  bands.map((band) => (
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
                {!passages &&
                  draft.cuts.map((cut, index) => (
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
              {passages
                ? ' each walkable surface in the colour of its floor, walls grey. Numbered brackets are the overlapping places.'
                : ' each in the colour of its floor.'}
              {showItems &&
                (passages
                  ? ' Dots are items and other locations, in the colour of their type: a white ring has no floor under it.'
                  : ' Dots are items and other locations, in the colour of their type: a yellow ring is within 1 m of a cut, a white ring is on another floor than its height gives or has no floor under it.')}{' '}
              {passages
                ? 'Press a walkable surface to choose its floor.'
                : 'Press a floor to choose it.'}
            </p>
            {!passages && showItems && nearCount > 0 && (
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
                        setFocus(null);
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
                      setFocus(null);
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
                    cuts={passages ? [] : draft.cuts}
                    triangleFloors={passages ? triangleFloors : null}
                    clipHeight={
                      passages ? (passageViews?.floors[shown]?.heights[1] ?? high) + 1.5 : null
                    }
                    places={passages ? placeDots : []}
                    selected={shown}
                    hideAbove={hideAbove && shown < floorCount - 1}
                    showMarkers={showItems}
                    outlines={outlines}
                    looks={looks}
                    label={`${area.name} in 3D, ${nameOf(shown)} chosen`}
                    describe={describe}
                    focus={focus}
                    onPick={(index) => {
                      if (index === null) {
                        setFocus(null);
                        return;
                      }
                      // Its floor (by its height with cuts; the floor it is put on with automatic passages), and
                      // the view cut at head height above it.
                      const marker = markers[index];
                      if (!marker) return;
                      const floor = passages
                        ? (checks[index]?.floor ?? 0)
                        : bandOf(draft.cuts, marker.y);
                      const band = bands[Math.min(floor, bands.length - 1)];
                      const top = passages || floor < floorCount - 1 ? (band?.to ?? null) : null;
                      setSelected(floor);
                      setFocus({
                        index,
                        cut: headCut(marker.y, top),
                        seq: (focus?.seq ?? 0) + 1,
                      });
                    }}
                  />
                ) : (
                  <div className="mm-preview-empty muted small">
                    {viewsProblem ? 'No 3D view' : 'Loading the area…'}
                  </div>
                )}
                <p className="muted small">
                  Drag to turn, scroll or pinch to zoom, right-drag or drag with two fingers to
                  move. With the view selected: the arrow keys turn it, + and − zoom, Home goes back
                  to the start.{' '}
                  {passages
                    ? 'Each walkable surface is in the colour of its floor, walls and slopes grey; the chosen floor is bright. Large white dots are the overlapping places (the chosen one yellow).'
                    : 'Each cut is a see-through level in the colour of the floor above it; the chosen floor is bright.'}{' '}
                  Outlines draws the edges of the walls and floors.
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
            <div className="mm-fp-method" role="group" aria-labelledby="fp-method-label">
              <span id="fp-method-label" className="small muted">
                Floors
              </span>
              <div className="mm-row">
                {FLOOR_METHODS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="button"
                    aria-pressed={method === entry.id}
                    disabled={running}
                    onClick={() => {
                      setMethod(entry.id);
                      setMessage(null);
                    }}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
              {area.floorPlan?.method !== method && (
                <span className="small mm-tone-warn">
                  The map was made with {floorMethodLabel(area.floorPlan?.method).toLowerCase()}:
                  press Make this area again to use {floorMethodLabel(method).toLowerCase()}.
                </span>
              )}
            </div>
            <h3>Floors, highest first</h3>
            <ol className="mm-fp-list" reversed>
              {floorsHighestFirst.map((band) => {
                const floor = (passages ? passageViews : viewed)?.floors[band.index];
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
                          {passages
                            ? `${heightText(band.from).replace(/ m$/, '')} to ${heightText(band.to)}`
                            : `${band.index === 0 ? 'bottom' : heightText(band.from)} to ${
                                band.index === floorCount - 1 ? 'top' : heightText(band.to)
                              }`}{' '}
                          · {count(walkable)} m² walkable
                          {floor ? ` · ${plural(floor.markers, 'marker')}` : ''}
                          {passages && band.index === (passageViews?.mainFloor ?? -1)
                            ? ' · the main floor'
                            : ''}
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
                          {!passages && (
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
                          )}
                        </div>
                      </div>
                    </div>
                    {!passages && cutIndex >= 0 && (
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
            {passages && (
              <PlacesList
                places={places}
                choices={choices}
                chosen={place}
                floorName={nameOf}
                disabled={running}
                onChoose={choose}
                onShow={(target) => {
                  setPlace(target.id);
                  const floors = target.floors;
                  if (floors.length > 0) setSelected(floors[floors.length - 1]!);
                }}
              />
            )}
            {!passages && viewed && viewed.dropped.length > 0 && (
              <p className="mm-alert mm-warn small">
                {viewed.dropped.map(heightText).join(', ')}:{' '}
                {viewed.dropped.length === 1 ? 'this cut leaves' : 'these cuts leave'} a floor with
                nothing on it, so the map will not use {viewed.dropped.length === 1 ? 'it' : 'them'}
                .
              </p>
            )}

            {!passages && (
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
            )}
            {!passages && !addable && (
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
            <button
              type="button"
              className="button"
              onClick={() => {
                setComparing(true);
              }}
            >
              Compare with a picture…
            </button>
            <span className="small muted">
              Lay a picture of a map over this area’s map to check it (the picture is only shown,
              never put in your map pack).
            </span>
          </div>
          <div className="mm-row">
            <button type="button" className="button" onClick={() => void saveFile()}>
              Save my floor cuts to a file…
            </button>
            <button type="button" className="button" onClick={() => void loadFile()}>
              Load floor cuts from a file…
            </button>
          </div>
          <p className="muted small">
            The file holds your cuts, floor names and passage choices of every area of this game,
            and nothing of the game itself.
          </p>
        </footer>
      </section>
      {comparing && (
        <ComparePanel
          api={api}
          game={game}
          area={area}
          onClose={() => {
            setComparing(false);
          }}
        />
      )}
    </div>
  );
}

/** Automatic passages: the overlapping places, each with its Upper / Lower choice for the main floor. */
function PlacesList(props: {
  places: readonly PassagePlace[];
  choices: readonly PassageChoice[];
  chosen: number | null;
  floorName: (index: number) => string;
  disabled: boolean;
  onChoose: (place: PassagePlace, show: 'upper' | 'lower') => void;
  onShow: (place: PassagePlace) => void;
}) {
  const { places, choices } = props;
  return (
    <div className="mm-fp-places">
      <h3>Overlapping places</h3>
      {places.length === 0 ? (
        <p className="small muted">
          Nothing walkable lies over anything else here, so the area is one floor.
        </p>
      ) : (
        <>
          <p className="small muted">
            Where one walkable surface lies over another. The main floor shows one storey of each;
            the other goes on a floor of its own.
          </p>
          <ol className="mm-fp-place-list">
            {places.map((p, number) => {
              const show = showOf(p, choices);
              const lowest = Math.min(...p.heights);
              const highest = Math.max(...p.heights);
              return (
                <li
                  key={p.id}
                  className={
                    p.id === props.chosen
                      ? 'mm-fp-place-item mm-fp-place-item-on'
                      : 'mm-fp-place-item'
                  }
                >
                  <div className="small">
                    <strong>Place {number + 1}</strong>{' '}
                    <span className="muted">
                      · near x {Math.round(p.x)}, z {Math.round(p.z)} · {plural(p.levels, 'storey')}{' '}
                      from {heightText(lowest).replace(/ m$/, '')} to {heightText(highest)} ·{' '}
                      {count(p.area)} m²
                      {p.floors.length > 0
                        ? ` · on ${p.floors.map((f) => props.floorName(f)).join(', ')}`
                        : ''}
                    </span>
                  </div>
                  <div
                    className="mm-row"
                    role="group"
                    aria-label={`Place ${number + 1}: the main floor shows`}
                  >
                    <span className="small muted">Main floor shows</span>
                    {(['upper', 'lower'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className="button"
                        aria-pressed={show === value}
                        disabled={props.disabled}
                        onClick={() => {
                          props.onChoose(p, value);
                        }}
                      >
                        {value === 'upper' ? 'Upper' : 'Lower'}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="button"
                      aria-pressed={p.id === props.chosen}
                      onClick={() => {
                        props.onShow(p);
                      }}
                    >
                      Show
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
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
