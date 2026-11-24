import { sceneFrame } from '@atlas/core';
import { modelToWorld, worldToPixel, type Affine, type Scene } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { firstKept, floorIdAt, keptByCuts, placementAt, type ViewPoint } from './placing';

/** Mossgate Keep's: 4 pixels a world unit, world y up the map. */
const KEEP: Affine = { a: 0.25, b: 0, c: 0, d: -0.25, e: 0, f: 256 };
/** Another map of another scale, turned a quarter and moved. */
const TURNED: Affine = { a: 0, b: 0.5, c: 0.5, d: 0, e: -40, f: 12 };

const MAP = { width: 1024, height: 1024 };

/** Floors as the demo's keep has them. */
const FLOORS = [
  { id: 'caves', mapId: 'keep', heights: [-12, -1] as const },
  { id: 'ground', mapId: 'keep', heights: [-1, 22] as const },
  { id: 'upper', mapId: 'keep', heights: [22, 40] as const },
];

/** A point of a model file (after its own node transforms) in the 3D view's frame. */
function modelPointInView(t: Affine, scene: Pick<Scene, 'axes' | 'scale' | 'offset'>, p: number[]) {
  const frame = sceneFrame(t, scene)!;
  const m = frame.modelMatrix;
  const [x, y, z] = p as [number, number, number];
  return {
    frame,
    point: {
      x: m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
      y: m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
      z: m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    },
  };
}

/** The world point of a model point, as the file format says (see `modelToWorld`). */
function modelPointInWorld(scene: Pick<Scene, 'axes' | 'scale' | 'offset'>, p: number[]) {
  const m = modelToWorld(scene);
  const row = (r: number) =>
    m[r * 4]! * p[0]! + m[r * 4 + 1]! * p[1]! + m[r * 4 + 2]! * p[2]! + m[r * 4 + 3]!;
  return [row(0), row(1), row(2)] as const;
}

describe('a point of the model pressed, as a location', () => {
  it('gives the map pixel under it and its height, through the map and the scene', () => {
    for (const [t, scene] of [
      [KEEP, {}],
      [
        KEEP,
        {
          axes: ['+x', '+z', '+y'] as Scene['axes'],
          scale: 2,
          offset: [10, -4, 3] as [number, number, number],
        },
      ],
      [TURNED, { axes: ['-y', '+x', '+z'] as Scene['axes'], scale: 0.5 }],
    ] as const) {
      const model = [37.5, 8.25, -91];
      const { frame, point } = modelPointInView(t, scene, model);
      const [wx, wy, h] = modelPointInWorld(scene, model);
      const [px, py] = worldToPixel(t, wx, wy)!;
      const placed = placementAt(frame, point, { width: 1e6, height: 1e6 }, [], 'surface');
      // Off the map image where the made-up transforms put it: the pixels are what matter.
      if (px < 0 || py < 0) {
        expect(placed).toBeNull();
        continue;
      }
      expect(placed).toEqual({
        x: Math.round(px),
        y: Math.round(py),
        height: Math.round(h * 100) / 100,
        layerId: 'surface',
      });
    }
  });

  it('puts it on the floor its height is on, or the level shown on a map without floors', () => {
    const frame = sceneFrame(KEEP, {})!;
    const at = (h: number) => frame.fromWorld(80, 70, h);
    const view = (h: number): ViewPoint => {
      const [x, y, z] = at(h);
      return { x, y, z };
    };
    expect(placementAt(frame, view(10), MAP, FLOORS, 'shown')).toMatchObject({
      x: 320,
      y: 744,
      height: 10,
      layerId: 'ground',
    });
    expect(placementAt(frame, view(25.123), MAP, FLOORS, 'shown')).toMatchObject({
      height: 25.12,
      layerId: 'upper',
    });
    expect(placementAt(frame, view(-6), MAP, FLOORS, 'shown')?.layerId).toBe('caves');
    // Below every floor: the lowest; above every floor: the highest.
    expect(placementAt(frame, view(-50), MAP, FLOORS, 'shown')?.layerId).toBe('caves');
    expect(placementAt(frame, view(99), MAP, FLOORS, 'shown')?.layerId).toBe('upper');
    expect(placementAt(frame, view(10), MAP, [], 'shown')?.layerId).toBe('shown');
  });

  it('puts nothing off the map image', () => {
    const frame = sceneFrame(KEEP, {})!;
    const [x, y, z] = frame.fromWorld(-3, 70, 0);
    expect(placementAt(frame, { x, y, z }, MAP, [], 'shown')).toBeNull();
    const [x2, y2, z2] = frame.fromWorld(10, 300, 0);
    expect(placementAt(frame, { x: x2, y: y2, z: z2 }, MAP, [], 'shown')).toBeNull();
    expect(placementAt(frame, { x: Number.NaN, y: 0, z: 0 }, MAP, [], 'shown')).toBeNull();
  });
});

describe('floors', () => {
  it('picks the highest floor that starts at or below a height', () => {
    expect(floorIdAt(FLOORS, -1)).toBe('ground');
    expect(floorIdAt(FLOORS, 21.99)).toBe('ground');
    expect(floorIdAt(FLOORS, 22)).toBe('upper');
    expect(floorIdAt([], 5)).toBeNull();
  });
});

describe('what the cuts leave', () => {
  // The floor's top at 22: what is above is cut away (as the view's clipping plane).
  const top = { normal: { x: 0, y: -1, z: 0 }, constant: 22 };
  // The cut toward the camera: a wall at z = 100, cutting away what is nearer the camera (z > 100).
  const toward = { normal: { x: 0, y: 0, z: -1 }, constant: 100 };

  it('keeps a point below the top and behind the wall', () => {
    expect(keptByCuts({ x: 0, y: 21, z: 50 }, [top, toward])).toBe(true);
    expect(keptByCuts({ x: 0, y: 22, z: 50 }, [top])).toBe(true);
    expect(keptByCuts({ x: 0, y: 23, z: 50 }, [top])).toBe(false);
    expect(keptByCuts({ x: 0, y: 0, z: 120 }, [toward])).toBe(false);
    expect(keptByCuts({ x: 0, y: 99, z: 999 }, [])).toBe(true);
  });

  it('presses through what is cut away, onto the first surface left', () => {
    const roof = { point: { x: 0, y: 30, z: 50 }, distance: 10 };
    const wall = { point: { x: 0, y: 10, z: 130 }, distance: 12 };
    const floor = { point: { x: 0, y: 5, z: 50 }, distance: 35 };
    const cellar = { point: { x: 0, y: -8, z: 50 }, distance: 48 };
    expect(firstKept([cellar, roof, floor, wall], [top, toward])).toBe(floor);
    expect(firstKept([cellar, roof, floor], [])).toBe(roof);
    expect(firstKept([roof], [top])).toBeNull();
    expect(firstKept([], [])).toBeNull();
  });
});
