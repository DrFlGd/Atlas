import { describe, expect, it } from 'vitest';
import {
  cellBox,
  deviceClass,
  FIRST_FRAME_BIAS,
  FRAMES_KEPT,
  nextBias,
  nextTextureBias,
  planCells,
  sampleFrames,
  SCENE_BUDGETS,
  sceneBudget,
  sceneFrame,
  UNKNOWN_TRIANGLES,
  type FrameBias,
  type PlanCell,
} from './plan';

const apply = (m: number[], [x, y, z]: [number, number, number]) =>
  [0, 1, 2].map((r) => m[r]! * x + m[4 + r]! * y + m[8 + r]! * z + m[12 + r]!);

describe('the 3D view frame', () => {
  // World x = px / 4, world y = 256 - py / 4: north up on the map.
  const transform = { a: 0.25, b: 0, c: 0, d: -0.25, e: 0, f: 256 };

  it('lines the view up with the map image, in world units', () => {
    const frame = sceneFrame(transform, {})!;
    expect(frame.unit).toBeCloseTo(0.25);
    expect(frame.fromPixel(400, 800, 3)).toEqual([100, 3, 200]);
    const [x, h, z] = frame.fromWorld(100, 56, 3);
    expect([x, h, z].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([100, 3, 200]);
    expect(frame.toPixel(100, 200)).toEqual([400, 800]);
  });

  it('places the model where its world points are', () => {
    // glTF axes: model (X, Y, Z) is world (X, -Z) at height Y.
    const frame = sceneFrame(transform, {})!;
    const view = apply(frame.modelMatrix, [100, 3, -56]);
    expect(view.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([100, 3, 200]);
    // A Z-up model, scaled and moved.
    const zUp = sceneFrame(transform, { axes: ['+x', '+y', '+z'], scale: 2, offset: [10, 6, 1] })!;
    const moved = apply(zUp.modelMatrix, [45, 25, 1]);
    // World (100, 56) at height 3.
    expect(moved.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([100, 3, 200]);
  });

  it('has no frame for a transform that cannot be turned round', () => {
    expect(sceneFrame({ a: 1, b: 2, c: 2, d: 4, e: 0, f: 0 }, {})).toBeNull();
  });

  it('gives a cell its square in the view', () => {
    const frame = sceneFrame(transform, {})!;
    expect(cellBox(frame, [0, 192, 64, 256]).map((v) => Math.round(v))).toEqual([0, 0, 64, 64]);
  });
});

describe('device budgets', () => {
  const computer = {
    platform: 'windows',
    coarsePointer: false,
    screenWidth: 1920,
    screenHeight: 1080,
  };

  it('tells a phone, a Steam Deck and a computer apart', () => {
    expect(deviceClass({ ...computer, platform: 'android' })).toBe('phone');
    expect(
      deviceClass({ platform: null, coarsePointer: true, screenWidth: 412, screenHeight: 915 }),
    ).toBe('phone');
    expect(
      deviceClass({ platform: 'linux', coarsePointer: true, screenWidth: 1280, screenHeight: 800 }),
    ).toBe('handheld');
    expect(deviceClass(computer)).toBe('computer');
    expect(deviceClass({ ...computer, platform: null })).toBe('computer');
  });

  it('halves the budget of a device with little memory', () => {
    expect(sceneBudget(computer)).toEqual(SCENE_BUDGETS.computer);
    const small = sceneBudget({ ...computer, platform: 'android', deviceMemory: 2 });
    expect(small.triangles).toBe(SCENE_BUDGETS.phone.triangles / 2);
    expect(SCENE_BUDGETS.phone.triangles).toBeLessThanOrEqual(SCENE_BUDGETS.handheld.triangles);
    expect(SCENE_BUDGETS.handheld.triangles).toBeLessThanOrEqual(SCENE_BUDGETS.computer.triangles);
  });

  it('gives a phone, a Steam Deck and a computer 4 million triangles and 600 MB of textures', () => {
    for (const budget of [SCENE_BUDGETS.phone, SCENE_BUDGETS.handheld, SCENE_BUDGETS.computer]) {
      expect(budget).toMatchObject({ triangles: 4_000_000, textureBytes: 600 << 20 });
    }
  });
});

describe('which cells to load', () => {
  const levels = [
    { level: 0, triangles: 8000 },
    { level: 1, triangles: 2000 },
    { level: 2, triangles: 500 },
  ];
  // A row of cells of side 10 along x.
  const row: PlanCell[] = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i}`,
    box: [i * 10, 0, i * 10 + 10, 10],
    heights: [0, 2],
    levels,
  }));
  const huge = { triangles: 1e9, reach: 8 };

  it('loads near cells finely, far ones coarsely, and none past the reach', () => {
    const plan = planCells(row, [5, 0, 5], huge);
    expect(plan[0]).toMatchObject({ id: 'c0', level: 0, distance: 0 });
    expect(plan.find((p) => p.id === 'c1')!.level).toBe(0);
    expect(plan.find((p) => p.id === 'c3')!.level).toBe(1);
    expect(plan.find((p) => p.id === 'c6')!.level).toBe(2);
    expect(plan.map((p) => p.id)).not.toContain('c9');
    // Nearest first.
    const distances = plan.map((p) => p.distance);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
  });

  it('counts height: a camera high above sees coarser cells', () => {
    const low = planCells(row, [5, 0, 5], huge);
    const high = planCells(row, [5, 40, 5], huge);
    expect(high[0]!.level).toBeGreaterThan(low[0]!.level);
  });

  it('steps the detail down with a bias', () => {
    const plan = planCells(row, [5, 0, 5], huge, 1);
    expect(plan[0]!.level).toBe(1);
  });

  it('keeps within the triangle budget, coarser far away first, then fewer cells', () => {
    const tight = planCells(row, [5, 0, 5], { triangles: 12_000, reach: 8 });
    const total = tight.reduce(
      (sum, p) => sum + levels.find((l) => l.level === p.level)!.triangles,
      0,
    );
    expect(total).toBeLessThanOrEqual(12_000);
    expect(tight[0]!.level).toBe(0);
    const tiny = planCells(row, [5, 0, 5], { triangles: 1500, reach: 8 });
    expect(tiny.length).toBeLessThan(row.length);
    expect(tiny.every((p) => p.level === 2)).toBe(true);
  });

  it('counts a level that does not say its triangles as a large one', () => {
    const unknown: PlanCell[] = [
      { id: 'u', box: [0, 0, 10, 10], levels: [{ level: 0 }] },
      { id: 'v', box: [10, 0, 20, 10], levels: [{ level: 0 }] },
    ];
    expect(
      planCells(unknown, [5, 0, 5], { triangles: 2 * UNKNOWN_TRIANGLES - 1, reach: 8 }).map(
        (p) => p.id,
      ),
    ).toEqual(['u']);
  });

  it('never leaves the view empty: the nearest cell stays, at its coarsest', () => {
    const tight = planCells(row, [5, 0, 5], { triangles: 10, reach: 8 });
    expect(tight).toEqual([{ id: 'c0', level: 2, distance: 0 }]);
    expect(planCells([], [5, 0, 5], { triangles: 10, reach: 8 })).toEqual([]);
  });

  it('shows a scene of one cell at the finest level the bias and budget allow, near or far', () => {
    const whole: PlanCell[] = [{ id: 'whole', box: [0, 0, 10, 10], heights: [0, 2], levels }];
    for (const camera of [
      [5, 0, 5],
      [5, 30, 5],
      [60, 10, 5],
    ] as const) {
      expect(planCells(whole, camera, huge)[0]!.level).toBe(0);
      expect(planCells(whole, camera, huge, 1)[0]!.level).toBe(1);
      expect(planCells(whole, camera, { triangles: 5_000, reach: 8 })[0]!.level).toBe(1);
    }
    // Past the reach it is not shown, as any cell.
    expect(planCells(whole, [500, 0, 5], huge)).toEqual([]);
  });
});

describe('stepping the detail by frame rate', () => {
  const at = (bias: number, floor = 0): FrameBias => ({ bias, floor, retrying: false });
  const slow = Array(30).fill(60);
  const quick = Array(30).fill(10);
  it('steps down when frames are slow, up again when quick, and waits for enough frames', () => {
    expect(nextBias(at(0), slow).bias).toBe(1);
    expect(nextBias(at(3), slow).bias).toBe(3);
    expect(nextBias(at(2), quick).bias).toBe(1);
    expect(nextBias(at(0), quick).bias).toBe(0);
    expect(nextBias(at(1), Array(30).fill(30)).bias).toBe(1);
    expect(nextBias(at(0), Array(5).fill(60)).bias).toBe(0);
    expect(nextBias(FIRST_FRAME_BIAS, slow)).toEqual({ bias: 1, floor: 0, retrying: false });
  });

  it('steps back up, one level at a time, once frames recover', () => {
    let bias = FIRST_FRAME_BIAS;
    for (let i = 0; i < 5; i++) bias = nextBias(bias, slow);
    expect(bias.bias).toBe(3);
    const seen = [];
    for (let i = 0; i < 4; i++) {
      bias = nextBias(bias, Array(30).fill(16.7));
      seen.push(bias.bias);
    }
    expect(seen).toEqual([2, 1, 0, 0]);
  });

  it('gives up a level that is slow again once stepped back to, so it does not swing', () => {
    // Slow at the finest level, quick one coarser: tried once more, then given up.
    let bias = FIRST_FRAME_BIAS;
    const seen = [];
    for (let i = 0; i < 4; i++) {
      bias = nextBias(bias, bias.bias === 0 ? slow : quick);
      seen.push(bias.bias);
    }
    expect(seen).toEqual([1, 0, 1, 1]);
    expect(bias.floor).toBe(1);
    // In between, it stays where it is.
    expect(nextBias(bias, Array(30).fill(30))).toBe(bias);
    // It may still step coarser, and back to the floor, never past it.
    bias = nextBias(bias, slow);
    expect(bias).toEqual({ bias: 2, floor: 1, retrying: false });
    bias = nextBias(nextBias(bias, quick), quick);
    expect(bias.bias).toBe(1);
    // Frames between slow and quick after a step back keep the level, and a slow spell later gives it up.
    expect(nextBias(at(2, 1), quick)).toEqual({ bias: 1, floor: 1, retrying: true });
    expect(nextBias({ bias: 1, floor: 1, retrying: true }, slow)).toEqual({
      bias: 2,
      floor: 2,
      retrying: false,
    });
  });
});

describe('the frames the frame rate is judged by', () => {
  it('keeps the last frames, and none while a cell loads', () => {
    expect(sampleFrames([10, 20], 30, false)).toEqual([10, 20, 30]);
    expect(sampleFrames(new Array<number>(FRAMES_KEPT).fill(10), 60, false)).toHaveLength(
      FRAMES_KEPT,
    );
    expect(sampleFrames(new Array<number>(FRAMES_KEPT).fill(10), 60, false).at(-1)).toBe(60);
    expect(sampleFrames([60, 60, 60], 60, true)).toEqual([]);
  });

  it('never gives up a level for the frames a load took', () => {
    // Stepped back to the finest level, whose load makes frames slow for a while.
    let frames: number[] = [];
    let bias: FrameBias = { bias: 0, floor: 0, retrying: true };
    for (let i = 0; i < 40; i++) frames = sampleFrames(frames, 80, i < 39);
    bias = nextBias(bias, frames);
    expect(bias.floor).toBe(0);
    // Slow once it is in: given up.
    for (let i = 0; i < 30; i++) frames = sampleFrames(frames, 80, false);
    expect(nextBias(bias, frames)).toEqual({ bias: 1, floor: 1, retrying: false });
  });
});

describe('stepping the detail by texture memory', () => {
  const budget = { textureBytes: 400 };
  it('steps down over the budget, and back up once well under it', () => {
    expect(nextTextureBias(0, 401, budget)).toBe(1);
    expect(nextTextureBias(3, 900, budget)).toBe(3);
    expect(nextTextureBias(1, 300, budget)).toBe(1);
    expect(nextTextureBias(1, 99, budget)).toBe(0);
    expect(nextTextureBias(0, 0, budget)).toBe(0);
  });
});
