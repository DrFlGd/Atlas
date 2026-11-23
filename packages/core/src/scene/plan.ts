import { modelToWorld, type Affine, type Scene } from '@atlas/schema';

/**
 * The arithmetic of the 3D view, apart from the renderer so it can be
 * tested: where things are in the view's own frame, which cells to load
 * and at which level of detail, how much a device may hold, and when to
 * step the detail down because frames come too slowly.
 *
 * The view's frame lines up with the map image, never mirrored: X along
 * the map's x (right), Z along its y (down, toward the viewer from above),
 * Y up, in world units: a map pixel (px, py) at height h is at
 * `(px * unit, h, py * unit)`, where `unit` is the world units of one map
 * pixel. So the 3D view seen from above is the 2D map, whichever way the
 * game's own axes run.
 */

/** A map's frame for the 3D view (see the module). */
export interface SceneFrame {
  /** World units per map pixel. */
  unit: number;
  /** A map pixel at a height, in the view's frame. */
  fromPixel(px: number, py: number, height: number): [number, number, number];
  /** A point of the view's frame as a map pixel. */
  toPixel(x: number, z: number): [number, number];
  /** A world point in the view's frame. */
  fromWorld(wx: number, wy: number, height: number): [number, number, number];
  /** The model's points in the view's frame: a 4 by 4 matrix, column-major (as WebGL takes it). */
  modelMatrix: number[];
}

/** The frame of a map with this transform and scene; null when the transform cannot be turned round. */
export function sceneFrame(
  t: Affine,
  scene: Pick<Scene, 'axes' | 'scale' | 'offset'>,
): SceneFrame | null {
  const det = t.a * t.d - t.b * t.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const unit = Math.sqrt(Math.abs(det));
  // World x, y to map pixels: p = Inv · (w - [e, f]).
  const ia = t.d / det;
  const ib = -t.b / det;
  const ic = -t.c / det;
  const id = t.a / det;
  const fromWorld = (wx: number, wy: number, h: number): [number, number, number] => {
    const dx = wx - t.e;
    const dy = wy - t.f;
    return [(ia * dx + ic * dy) * unit, h, (ib * dx + id * dy) * unit];
  };
  // Model to world (3 rows of 4), then world to view.
  const m = modelToWorld(scene);
  const row = (r: number) => [m[r * 4]!, m[r * 4 + 1]!, m[r * 4 + 2]!, m[r * 4 + 3]!];
  const wx = row(0);
  const wy = row(1);
  const wh = row(2);
  // View X = unit * (ia * (wx - e) + ic * (wy - f)); view Z likewise; view Y = wh.
  const viewRow = (p: number, q: number) =>
    [0, 1, 2, 3].map(
      (k) => unit * (p * wx[k]! + q * wy[k]!) - (k === 3 ? unit * (p * t.e + q * t.f) : 0),
    );
  const vx = viewRow(ia, ic);
  const vz = viewRow(ib, id);
  const rows = [vx, wh, vz, [0, 0, 0, 1]];
  const modelMatrix: number[] = [];
  for (let column = 0; column < 4; column++) {
    for (let r = 0; r < 4; r++) modelMatrix.push(rows[r]![column]!);
  }
  return {
    unit,
    fromPixel: (px, py, h) => [px * unit, h, py * unit],
    toPixel: (x, z) => [x / unit, z / unit],
    fromWorld,
    modelMatrix,
  };
}

/** A cell's square in the view's frame, `[minX, minZ, maxX, maxZ]`, from its world bounds. */
export function cellBox(frame: SceneFrame, bounds: readonly [number, number, number, number]) {
  const corners = [
    frame.fromWorld(bounds[0], bounds[1], 0),
    frame.fromWorld(bounds[2], bounds[1], 0),
    frame.fromWorld(bounds[0], bounds[3], 0),
    frame.fromWorld(bounds[2], bounds[3], 0),
  ];
  const xs = corners.map((c) => c[0]);
  const zs = corners.map((c) => c[2]);
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)] as const;
}

// ---------------------------------------------------------------------------
// What a device may hold

/** The kinds of device the budgets are set for. */
export type DeviceClass = 'phone' | 'handheld' | 'computer';

/** What the app can tell of the device, cheaply and without asking. */
export interface DeviceSignals {
  /** The desktop shell's system, or null in a browser. */
  platform: string | null;
  /** The main pointer is a finger (`pointer: coarse`). */
  coarsePointer: boolean;
  screenWidth: number;
  screenHeight: number;
  /** `navigator.deviceMemory`, in GB, where the browser gives it. */
  deviceMemory?: number | undefined;
}

/**
 * The kind of device: Atlas for Android, or a browser on a touch screen
 * with a short side under 900 pixels, is a phone (a tablet counts as one:
 * the same kind of graphics); Linux on a screen of 1280 by 800 is a Steam
 * Deck or such a handheld; the rest is a computer.
 */
export function deviceClass(signals: DeviceSignals): DeviceClass {
  const short = Math.min(signals.screenWidth, signals.screenHeight);
  const long = Math.max(signals.screenWidth, signals.screenHeight);
  if (signals.platform === 'android') return 'phone';
  if (signals.platform === null && signals.coarsePointer && short < 900) return 'phone';
  if (signals.platform === 'linux' && long === 1280 && short === 800) return 'handheld';
  return 'computer';
}

/** How much of a model the 3D view holds at once on a device. */
export interface SceneBudget {
  /** Triangles of the cells loaded, together. */
  triangles: number;
  /** Bytes of the textures loaded, together. */
  textureBytes: number;
  /** The most device pixels per CSS pixel drawn. */
  maxPixelRatio: number;
  /** Cells farther than this many cell sides from the camera are not loaded. */
  reach: number;
  /** Files loaded at once. */
  loads: number;
}

/**
 * The budgets per kind of device: about 4 million triangles and 600 MB of
 * textures on a phone, a Steam Deck and a computer alike, for now (a phone
 * ran the 3D trial in Settings smoothly to 4 million triangles and 683 MB;
 * a Steam Deck's run will set the handheld's). They stay under what the
 * trial found devices hold at a good frame rate, leaving a margin for the
 * dots, the map beside the view and the rest of the page; the trial's
 * reports keep them honest.
 */
export const SCENE_BUDGETS: Readonly<Record<DeviceClass, SceneBudget>> = {
  phone: { triangles: 4_000_000, textureBytes: 600 << 20, maxPixelRatio: 1.5, reach: 6, loads: 2 },
  handheld: { triangles: 4_000_000, textureBytes: 600 << 20, maxPixelRatio: 1, reach: 8, loads: 3 },
  computer: { triangles: 4_000_000, textureBytes: 600 << 20, maxPixelRatio: 2, reach: 8, loads: 4 },
};

/** The budget of a device: its class's, halved where the browser says it has 2 GB or less. */
export function sceneBudget(signals: DeviceSignals): SceneBudget {
  const budget = SCENE_BUDGETS[deviceClass(signals)];
  if (signals.deviceMemory !== undefined && signals.deviceMemory <= 2) {
    return {
      ...budget,
      triangles: Math.round(budget.triangles / 2),
      textureBytes: Math.round(budget.textureBytes / 2),
    };
  }
  return budget;
}

// ---------------------------------------------------------------------------
// Which cells, at which level

/** A cell as the plan sees it: its square in the view's frame, and its levels finest first. */
export interface PlanCell {
  id: string;
  box: readonly [number, number, number, number];
  /** Its lowest and highest height, when known. */
  heights?: readonly [number, number] | undefined;
  levels: readonly { level: number; triangles?: number | undefined }[];
}

/** A cell to show, and at which of its levels (the `level` number). */
export interface PlannedCell {
  id: string;
  level: number;
  /** From the camera, in cell sides: what is near loads first. */
  distance: number;
}

/** Triangles counted for a level whose file does not say. */
export const UNKNOWN_TRIANGLES = 50_000;

/**
 * Which cells to show and at which level, nearest first. A cell's level
 * follows its distance from the camera in cell sides `r`: the finest
 * within 1.5, the next to 4.5, the next to 10.5 (`floor(log2(1 + r /
 * 1.5))`), plus `bias` levels coarser when frames come slowly; past
 * `budget.reach` it is not shown. While the triangles of the plan are
 * over the budget, the farthest cell that can be coarser is made coarser,
 * and when none can, the farthest is left out.
 */
export function planCells(
  cells: readonly PlanCell[],
  camera: readonly [number, number, number],
  budget: Pick<SceneBudget, 'triangles' | 'reach'>,
  bias = 0,
): PlannedCell[] {
  const [cx, cy, cz] = camera;
  const entries = cells
    .filter((cell) => cell.levels.length > 0)
    .map((cell) => {
      const [x0, z0, x1, z1] = cell.box;
      const side = Math.max(x1 - x0, z1 - z0, 1e-9);
      const dx = Math.max(x0 - cx, 0, cx - x1);
      const dz = Math.max(z0 - cz, 0, cz - z1);
      const [h0, h1] = cell.heights ?? [cy, cy];
      const dy = Math.max(h0 - cy, 0, cy - h1);
      const distance = Math.hypot(dx, dy, dz) / side;
      const rank = Math.floor(Math.log2(1 + distance / 1.5)) + Math.max(0, bias);
      return { cell, distance, index: Math.min(rank, cell.levels.length - 1) };
    })
    .filter((entry) => entry.distance <= budget.reach)
    .sort((a, b) => a.distance - b.distance);
  const triangles = (entry: (typeof entries)[number]) =>
    entry.cell.levels[entry.index]!.triangles ?? UNKNOWN_TRIANGLES;
  let total = entries.reduce((sum, entry) => sum + triangles(entry), 0);
  while (total > budget.triangles && entries.length > 0) {
    let coarser = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      if (entry.index < entry.cell.levels.length - 1) {
        coarser = i;
        break;
      }
    }
    if (coarser >= 0) {
      const entry = entries[coarser]!;
      total -= triangles(entry);
      entry.index += 1;
      total += triangles(entry);
    } else {
      total -= triangles(entries.pop()!);
    }
  }
  return entries.map((entry) => ({
    id: entry.cell.id,
    level: entry.cell.levels[entry.index]!.level,
    distance: entry.distance,
  }));
}

// ---------------------------------------------------------------------------
// Frame rate

/** Frames slower than this on average step the detail down. */
export const SLOW_FRAME_MS = 1000 / 24;
/** Frames faster than this on average for long let the detail step up again. */
export const QUICK_FRAME_MS = 1000 / 50;
/** The most levels the detail is stepped down. */
export const MAX_BIAS = 3;

/**
 * The bias of the plan after a second or two of frames: one level coarser
 * when they came slowly, one finer again when they came quickly (and the
 * bias is above 0), else as it was. `frameMs` are the times between frames
 * drawn while the view moved; too few say nothing. Between slow and quick
 * the bias stays, so the detail does not go up and down each time.
 */
export function nextBias(bias: number, frameMs: readonly number[]): number {
  if (frameMs.length < 20) return bias;
  const sorted = [...frameMs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (median > SLOW_FRAME_MS) return Math.min(MAX_BIAS, bias + 1);
  if (median < QUICK_FRAME_MS && bias > 0) return bias - 1;
  return bias;
}

/**
 * The bias the textures add to the plan: one level coarser while the
 * textures loaded are over the budget, one finer again once they take
 * less than a quarter of it (a level finer takes about four times the
 * texture memory, so it fits), else as it was.
 */
export function nextTextureBias(
  bias: number,
  textureBytes: number,
  budget: Pick<SceneBudget, 'textureBytes'>,
): number {
  if (textureBytes > budget.textureBytes) return Math.min(MAX_BIAS, bias + 1);
  if (bias > 0 && textureBytes * 4 < budget.textureBytes) return bias - 1;
  return bias;
}
