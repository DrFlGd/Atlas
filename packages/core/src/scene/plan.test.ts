import { describe, expect, it } from 'vitest';
import {
  cellBox,
  deviceClass,
  nextBias,
  nextTextureBias,
  planCells,
  SCENE_BUDGETS,
  sceneBudget,
  sceneFrame,
  UNKNOWN_TRIANGLES,
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
    expect(SCENE_BUDGETS.phone.triangles).toBeLessThan(SCENE_BUDGETS.handheld.triangles);
    expect(SCENE_BUDGETS.handheld.triangles).toBeLessThanOrEqual(SCENE_BUDGETS.computer.triangles);
  });

  it('gives a phone about 2 million triangles and 300 MB of textures, the others about twice', () => {
    expect(SCENE_BUDGETS.phone).toMatchObject({ triangles: 2_000_000, textureBytes: 300 << 20 });
    for (const other of [SCENE_BUDGETS.handheld, SCENE_BUDGETS.computer]) {
      expect(other.triangles).toBe(2 * SCENE_BUDGETS.phone.triangles);
      expect(other.textureBytes).toBe(2 * SCENE_BUDGETS.phone.textureBytes);
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
    const unknown: PlanCell[] = [{ id: 'u', box: [0, 0, 10, 10], levels: [{ level: 0 }] }];
    expect(planCells(unknown, [5, 0, 5], { triangles: UNKNOWN_TRIANGLES - 1, reach: 8 })).toEqual(
      [],
    );
  });
});

describe('stepping the detail by frame rate', () => {
  it('steps down when frames are slow, up again when quick, and waits for enough frames', () => {
    expect(nextBias(0, Array(30).fill(60))).toBe(1);
    expect(nextBias(3, Array(30).fill(60))).toBe(3);
    expect(nextBias(2, Array(30).fill(10))).toBe(1);
    expect(nextBias(0, Array(30).fill(10))).toBe(0);
    expect(nextBias(1, Array(30).fill(30))).toBe(1);
    expect(nextBias(0, Array(5).fill(60))).toBe(0);
  });

  it('steps back up, one level at a time, once frames recover', () => {
    let bias = 0;
    for (let i = 0; i < 5; i++) bias = nextBias(bias, Array(30).fill(60));
    expect(bias).toBe(3);
    const seen = [];
    for (let i = 0; i < 4; i++) {
      bias = nextBias(bias, Array(30).fill(16.7));
      seen.push(bias);
    }
    expect(seen).toEqual([2, 1, 0, 0]);
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
