import {
  makeId,
  type Layer,
  type Location,
  type MapDef,
  type PackData,
  type Scene,
  type SceneCell,
  type TileSource,
} from '@atlas/schema';
import { pyramidMaxZoom } from '@atlas/core';
import { triangleCount, writeGlb, type GlbMaterial, type GlbModel } from '../scene/glb';
import { DEMO_GAME_ID } from './content';
import { WIKI_PAGES } from './wiki';

/**
 * The demo's 3D map, "Mossgate Keep": a made-up valley of 256 by 256 world
 * units (metres) with slopes, a lake, a hill, a keep of two storeys and a
 * cave under the hill reached by a tunnel. Everything is generated here
 * from formulas: the ground, the keep and the cave are drawn as boxes and
 * grids, and the map images are drawn from the same formulas, so the 2D
 * and 3D views agree.
 *
 * The model is cut into 4 by 4 square cells of 64 units, each at three
 * levels of detail (`scene/<cell>/lod0.glb` to `lod2.glb`); levels 0 and 1
 * are written with EXT_meshopt_compression, level 2 plain, so the viewer
 * reads both. A light model of the hills around it is the scene's
 * `neighbours`. Its three layers are floors (`heights`): Caves, Ground
 * floor and Upper floor, each with a map image of its own. Its locations
 * have heights, but for some on open ground, which sit on the surface.
 */

const id = (kind: Parameters<typeof makeId>[1], local: string) => makeId(DEMO_GAME_ID, kind, local);

export const KEEP_MAP_ID = id('map', 'keep');
/** World units across the valley. */
export const KEEP_WORLD = 256;
/** Map image pixels across. */
export const KEEP_IMAGE = 1024;
const PIXELS_PER_UNIT = KEEP_IMAGE / KEEP_WORLD;
const CELLS = 4;
const CELL = KEEP_WORLD / CELLS;
/** Terrain segments across a cell at each level of detail. */
const SEGMENTS = [64, 32, 16] as const;
/** The water's height. */
const WATER = 0;

/** The keep: its footprint in world x and y, and the height its ground floor stands at. */
const KEEP = { x0: 68, x1: 92, y0: 62, y1: 78, base: 3 } as const;
const STOREY = 4;
/** The cave's chamber, and its tunnel out to the hillside. */
const CAVE = { x0: 184, x1: 206, y0: 186, y1: 204, floor: -10, ceiling: -3 } as const;
const TUNNEL = { from: 184, to: 136, y: 195, half: 2, high: 3.5 } as const;

/** The floors: each a layer of the map with its map image. */
export const KEEP_FLOORS = [
  { local: 'keep-caves', name: 'Caves', heights: [-12, -4] },
  // Each storey is cut just under the floor above it, so its rooms show from above.
  { local: 'keep-ground', name: 'Ground floor', heights: [-4, KEEP.base + STOREY - 0.25] },
  {
    local: 'keep-upper',
    name: 'Upper floor',
    heights: [KEEP.base + STOREY - 0.25, KEEP.base + 2 * STOREY - 0.25],
  },
] as const satisfies readonly { local: string; name: string; heights: [number, number] }[];

// ---------------------------------------------------------------------------
// The ground

const smooth = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
const bump = (x: number, y: number, cx: number, cy: number, spread: number) =>
  Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * spread * spread));

/** The tunnel's floor at world x. */
function tunnelFloor(x: number): number {
  const t = (TUNNEL.from - x) / (TUNNEL.from - TUNNEL.to);
  return CAVE.floor + t * (7 - CAVE.floor);
}

/** The rolling ground, before the keep's yard and the trench are cut. */
function rolling(x: number, y: number): number {
  return (
    3 +
    2.5 * Math.sin(x / 23) * Math.cos(y / 31) +
    1.5 * Math.sin((x + y) / 17) +
    28 * bump(x, y, 190, 190, 30) -
    9 * bump(x, y, 70, 180, 18)
  );
}

/** The ground's height at world x and y. */
export function groundHeight(x: number, y: number): number {
  let h = rolling(x, y);
  // The keep's yard is level.
  const outside = Math.max(KEEP.x0 - 8 - x, x - KEEP.x1 - 8, KEEP.y0 - 8 - y, y - KEEP.y1 - 8, 0);
  const yard = 1 - smooth(0, 8, outside);
  h = h * (1 - yard) + (KEEP.base - 0.2) * yard;
  // A trench leads down into the tunnel.
  if (x >= 126 && x <= 152 && Math.abs(y - TUNNEL.y) < TUNNEL.half + 0.5) {
    h = Math.min(h, tunnelFloor(Math.max(x, TUNNEL.to)));
  }
  return h;
}

/** Whether a point of the ground is under the lake. */
const underWater = (x: number, y: number) => groundHeight(x, y) < WATER;

/** The ground's colour (0 to 1) by height and slope. */
function groundColour(h: number, slope: number): [number, number, number] {
  if (h < 0.6) return [0.62, 0.56, 0.4];
  if (slope > 0.7) return [0.42, 0.4, 0.36];
  const high = smooth(10, 26, h);
  return [0.3 + 0.12 * high, 0.46 - 0.06 * high, 0.22 + 0.06 * high];
}

// ---------------------------------------------------------------------------
// Meshes

/** World x, y, height to model coordinates (glTF's own axes: Y up, -Z north). */
const model = (x: number, y: number, h: number): [number, number, number] => [x, h, -y];

/** An sRGB value (0 to 1) as a linear one, 0 to 255. */
const linear = (v: number) =>
  Math.round(255 * (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));

class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(p: readonly number[], n: readonly number[], c: readonly number[]): number {
    this.positions.push(p[0]!, p[1]!, p[2]!);
    this.normals.push(n[0]!, n[1]!, n[2]!);
    // glTF reads vertex colours as linear; the colours here are chosen as sRGB.
    this.colors.push(linear(c[0]!), linear(c[1]!), linear(c[2]!), 255);
    return this.vertexCount - 1;
  }

  /** A flat quad in model coordinates, turned to face away from `inside`. */
  quad(
    corners: readonly (readonly [number, number, number])[],
    colour: readonly number[],
    inside: readonly number[],
  ): void {
    const [a, c] = [corners[0]!, corners[2]!];
    let [b, d] = [corners[1]!, corners[3]!];
    let n = cross(sub(b, a), sub(c, a));
    const centre = [0, 1, 2].map((k) => (a[k]! + b[k]! + c[k]! + d[k]!) / 4);
    if (dot(n, sub(centre, inside)) < 0) {
      [b, d] = [d, b];
      n = n.map((v) => -v);
    }
    n = normalise(n);
    const at = [a, b, c, d].map((p) => this.vertex(p, n, colour));
    this.indices.push(at[0]!, at[1]!, at[2]!, at[0]!, at[2]!, at[3]!);
  }

  /** A box from one world corner to the other, its faces outward. */
  box(
    x0: number,
    y0: number,
    h0: number,
    x1: number,
    y1: number,
    h1: number,
    colour: readonly number[],
  ): void {
    const inside = model((x0 + x1) / 2, (y0 + y1) / 2, (h0 + h1) / 2);
    const p = (x: number, y: number, h: number) => model(x, y, h);
    const faces = [
      [p(x0, y0, h0), p(x1, y0, h0), p(x1, y1, h0), p(x0, y1, h0)],
      [p(x0, y0, h1), p(x1, y0, h1), p(x1, y1, h1), p(x0, y1, h1)],
      [p(x0, y0, h0), p(x1, y0, h0), p(x1, y0, h1), p(x0, y0, h1)],
      [p(x0, y1, h0), p(x1, y1, h0), p(x1, y1, h1), p(x0, y1, h1)],
      [p(x0, y0, h0), p(x0, y1, h0), p(x0, y1, h1), p(x0, y0, h1)],
      [p(x1, y0, h0), p(x1, y1, h0), p(x1, y1, h1), p(x1, y0, h1)],
    ];
    for (const face of faces) this.quad(face, colour, inside);
  }

  get empty(): boolean {
    return this.indices.length === 0;
  }

  primitive(material: number) {
    const wide = this.vertexCount > 65535;
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      colors: new Uint8Array(this.colors),
      indices: wide ? new Uint32Array(this.indices) : new Uint16Array(this.indices),
      material,
    };
  }
}

const sub = (a: readonly number[], b: readonly number[]) => [
  a[0]! - b[0]!,
  a[1]! - b[1]!,
  a[2]! - b[2]!,
];
const dot = (a: readonly number[], b: readonly number[]) =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]) => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const normalise = (v: readonly number[]) => {
  const length = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return v.map((x) => x / length);
};

/** The materials of every model file; vertex colours give the rest. */
const MATERIALS: GlbMaterial[] = [
  { name: 'ground', color: [1, 1, 1, 1], roughness: 0.95 },
  { name: 'stone', color: [1, 1, 1, 1], roughness: 0.85 },
  { name: 'wood', color: [1, 1, 1, 1], roughness: 0.8 },
  { name: 'roof', color: [1, 1, 1, 1], roughness: 0.7, doubleSided: true },
  { name: 'rock', color: [1, 1, 1, 1], roughness: 1, doubleSided: true },
];
const GROUND = 0;
const STONE = 1;
const WOOD = 2;
const ROOF = 3;
const ROCK = 4;

const STONE_COLOUR = [0.62, 0.6, 0.56];
const WOOD_COLOUR = [0.5, 0.36, 0.22];
const ROOF_COLOUR = [0.55, 0.22, 0.18];
const ROCK_COLOUR = [0.44, 0.38, 0.33];

/** The ground at a world point: its height, its normal in the model and its colour (sRGB). */
function groundPoint(x: number, y: number) {
  const e = 0.5;
  const h = groundHeight(x, y);
  const hx = (groundHeight(x + e, y) - groundHeight(x - e, y)) / (2 * e);
  const hy = (groundHeight(x, y + e) - groundHeight(x, y - e)) / (2 * e);
  return { h, normal: normalise([-hx, 1, hy]), colour: groundColour(h, Math.hypot(hx, hy)) };
}

/**
 * The ground of one cell. Its edges have the points of the finest level
 * at every level, so a cell meets its neighbours at any level without a
 * gap: the squares along the edges are drawn as fans from their middles.
 * (The cells once hung skirts under their edges to hide the gaps, which
 * showed as thin lines between cells.)
 */
function groundMesh(cx: number, cy: number, segments: number): MeshBuilder {
  const mesh = new MeshBuilder();
  const x0 = cx * CELL;
  const y0 = cy * CELL;
  const step = CELL / segments;
  const fine = SEGMENTS[0] / segments;
  const at = new Map<string, number>();
  // A point of the cell, by its place on the finest grid.
  const point = (fi: number, fj: number) => {
    const key = `${fi},${fj}`;
    let index = at.get(key);
    if (index === undefined) {
      const x = x0 + (fi * CELL) / SEGMENTS[0];
      const y = y0 + (fj * CELL) / SEGMENTS[0];
      const ground = groundPoint(x, y);
      index = mesh.vertex(model(x, y, ground.h), ground.normal, ground.colour);
      at.set(key, index);
    }
    return index;
  };
  const edge = (fi: number, fj: number) =>
    fi === 0 || fj === 0 || fi === SEGMENTS[0] || fj === SEGMENTS[0];
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const [fi, fj] = [i * fine, j * fine];
      const v00 = point(fi, fj);
      const v10 = point(fi + fine, fj);
      const v01 = point(fi, fj + fine);
      const v11 = point(fi + fine, fj + fine);
      const onEdge = i === 0 || j === 0 || i === segments - 1 || j === segments - 1;
      if (fine === 1 || !onEdge) {
        mesh.indices.push(v00, v10, v01, v10, v11, v01);
        continue;
      }
      // Round the square (v00, v10, v11, v01), with every point of the finest
      // level on a side that is the cell's edge, as a fan from its middle.
      const ring: number[] = [];
      const side = (ai: number, aj: number, di: number, dj: number) => {
        const split = edge(ai, aj) && edge(ai + di * fine, aj + dj * fine) ? fine : 1;
        for (let k = 0; k < split; k++) {
          const t = (k * fine) / split;
          ring.push(point(ai + di * t, aj + dj * t));
        }
      };
      side(fi, fj, 1, 0);
      side(fi + fine, fj, 0, 1);
      side(fi + fine, fj + fine, -1, 0);
      side(fi, fj + fine, 0, -1);
      const x = x0 + (i + 0.5) * step;
      const y = y0 + (j + 0.5) * step;
      const ground = groundPoint(x, y);
      const middle = mesh.vertex(model(x, y, ground.h), ground.normal, ground.colour);
      for (let k = 0; k < ring.length; k++) {
        mesh.indices.push(middle, ring[k]!, ring[(k + 1) % ring.length]!);
      }
    }
  }
  return mesh;
}

/** The keep: two storeys of rooms, stairs and a roof; at the coarsest level, a block. */
function keepMeshes(level: number): { stone: MeshBuilder; wood: MeshBuilder; roof: MeshBuilder } {
  const stone = new MeshBuilder();
  const wood = new MeshBuilder();
  const roof = new MeshBuilder();
  const { x0, x1, y0, y1, base } = KEEP;
  const t = 0.4;
  const top = base + 2 * STOREY;
  if (level >= 2) {
    stone.box(x0, y0, base - 0.5, x1, y1, top, STONE_COLOUR);
  } else {
    // Floors: the ground floor, and the upper floor with an opening for the stairs.
    wood.box(x0, y0, base - 0.5, x1, y1, base + 0.2, WOOD_COLOUR);
    const upper = base + STOREY;
    wood.box(x0, y0, upper, 85.6, y1, upper + 0.3, WOOD_COLOUR);
    wood.box(85.6, y0, upper, x1, 66, upper + 0.3, WOOD_COLOUR);
    wood.box(85.6, 74.4, upper, x1, y1, upper + 0.3, WOOD_COLOUR);
    // Stairs up the east side.
    for (let k = 0; k < 8; k++) {
      wood.box(86, 66 + k, base + 0.2, 90, 67 + k, base + 0.2 + (k + 1) * 0.5, WOOD_COLOUR);
    }
    for (const [h0, h1] of [
      [base + 0.2, base + STOREY],
      [upper + 0.3, top],
    ] as const) {
      const ground = h0 < upper;
      // South wall: a door below, two windows above.
      const gaps = ground
        ? [[78, 82]]
        : [
            [72, 75],
            [85, 88],
          ];
      let from: number = x0;
      for (const [g0, g1] of gaps) {
        stone.box(from, y0, h0, g0!, y0 + t, h1, STONE_COLOUR);
        stone.box(g0!, y0, ground ? h1 - 0.8 : h1 - 1, g1!, y0 + t, h1, STONE_COLOUR);
        if (!ground) stone.box(g0!, y0, h0, g1!, y0 + t, h0 + 1, STONE_COLOUR);
        from = g1!;
      }
      stone.box(from, y0, h0, x1, y0 + t, h1, STONE_COLOUR);
      stone.box(x0, y1 - t, h0, x1, y1, h1, STONE_COLOUR);
      stone.box(x0, y0 + t, h0, x0 + t, y1 - t, h1, STONE_COLOUR);
      stone.box(x1 - t, y0 + t, h0, x1, y1 - t, h1, STONE_COLOUR);
      // A wall between two rooms, with a way through.
      stone.box(79.8, y0 + t, h0, 80.2, 69, h1, STONE_COLOUR);
      stone.box(79.8, 72, h0, 80.2, y1 - t, h1, STONE_COLOUR);
    }
  }
  // A roof of two slopes, its gables closed.
  const ridge = top + 3;
  const mid = (y0 + y1) / 2;
  const inside = model((x0 + x1) / 2, mid, top);
  const rx0 = x0 - 0.5;
  const rx1 = x1 + 0.5;
  roof.quad(
    [
      model(rx0, y0 - 0.5, top),
      model(rx1, y0 - 0.5, top),
      model(rx1, mid, ridge),
      model(rx0, mid, ridge),
    ],
    ROOF_COLOUR,
    inside,
  );
  roof.quad(
    [
      model(rx0, y1 + 0.5, top),
      model(rx1, y1 + 0.5, top),
      model(rx1, mid, ridge),
      model(rx0, mid, ridge),
    ],
    ROOF_COLOUR,
    inside,
  );
  for (const x of [x0, x1]) {
    roof.quad(
      [model(x, y0, top), model(x, y1, top), model(x, mid, ridge), model(x, mid, ridge)],
      STONE_COLOUR,
      model((x0 + x1) / 2, mid, top + 1),
    );
  }
  return { stone, wood, roof };
}

/** The cave: a chamber of rock and the tunnel up to the hillside. */
function caveMesh(level: number): MeshBuilder {
  const rock = new MeshBuilder();
  const { x0, x1, y0, y1, floor, ceiling } = CAVE;
  const inside = model((x0 + x1) / 2, (y0 + y1) / 2, (floor + ceiling) / 2);
  const p = (x: number, y: number, h: number) => model(x, y, h);
  const faces = [
    [p(x0, y0, floor), p(x1, y0, floor), p(x1, y1, floor), p(x0, y1, floor)],
    [p(x0, y0, ceiling), p(x1, y0, ceiling), p(x1, y1, ceiling), p(x0, y1, ceiling)],
    [p(x0, y0, floor), p(x1, y0, floor), p(x1, y0, ceiling), p(x0, y0, ceiling)],
    [p(x0, y1, floor), p(x1, y1, floor), p(x1, y1, ceiling), p(x0, y1, ceiling)],
    [p(x1, y0, floor), p(x1, y1, floor), p(x1, y1, ceiling), p(x1, y0, ceiling)],
    // The west wall, open where the tunnel comes in.
    [
      p(x0, y0, floor),
      p(x0, TUNNEL.y - TUNNEL.half, floor),
      p(x0, TUNNEL.y - TUNNEL.half, ceiling),
      p(x0, y0, ceiling),
    ],
    [
      p(x0, TUNNEL.y + TUNNEL.half, floor),
      p(x0, y1, floor),
      p(x0, y1, ceiling),
      p(x0, TUNNEL.y + TUNNEL.half, ceiling),
    ],
  ];
  for (const face of faces) rock.quad(face, ROCK_COLOUR, inside);
  // Pillars in the chamber, but at the coarsest level.
  if (level < 2) {
    rock.box(192, 190, floor, 194, 192, ceiling, ROCK_COLOUR);
    rock.box(198, 198, floor, 200, 200, ceiling, ROCK_COLOUR);
  }
  const segments = level === 0 ? 12 : 6;
  const length = TUNNEL.from - TUNNEL.to;
  const ya = TUNNEL.y - TUNNEL.half;
  const yb = TUNNEL.y + TUNNEL.half;
  for (let k = 0; k < segments; k++) {
    const xa = TUNNEL.from - (k * length) / segments;
    const xb = TUNNEL.from - ((k + 1) * length) / segments;
    const fa = tunnelFloor(xa);
    const fb = tunnelFloor(xb);
    const ca = fa + TUNNEL.high;
    const cb = fb + TUNNEL.high;
    const centre = model((xa + xb) / 2, TUNNEL.y, (fa + fb) / 2 + TUNNEL.high / 2);
    rock.quad([p(xa, ya, fa), p(xb, ya, fb), p(xb, yb, fb), p(xa, yb, fa)], ROCK_COLOUR, centre);
    rock.quad([p(xa, ya, ca), p(xb, ya, cb), p(xb, yb, cb), p(xa, yb, ca)], ROCK_COLOUR, centre);
    rock.quad([p(xa, ya, fa), p(xb, ya, fb), p(xb, ya, cb), p(xa, ya, ca)], ROCK_COLOUR, centre);
    rock.quad([p(xa, yb, fa), p(xb, yb, fb), p(xb, yb, cb), p(xa, yb, ca)], ROCK_COLOUR, centre);
  }
  return rock;
}

const cellOf = (x: number, y: number) => `c${Math.floor(x / CELL)}-${Math.floor(y / CELL)}`;

/** The model of one cell at one level of detail. */
function cellModel(cx: number, cy: number, level: number): GlbModel {
  const meshes: GlbModel['meshes'] = [];
  const add = (name: string, mesh: MeshBuilder, material: number) => {
    if (!mesh.empty) meshes.push({ name, primitives: [mesh.primitive(material)] });
  };
  add('ground', groundMesh(cx, cy, SEGMENTS[level]!), GROUND);
  const here = cellOf(cx * CELL, cy * CELL);
  if (here === cellOf((KEEP.x0 + KEEP.x1) / 2, (KEEP.y0 + KEEP.y1) / 2)) {
    const keep = keepMeshes(level);
    add('keep walls', keep.stone, STONE);
    add('keep floors', keep.wood, WOOD);
    add('keep roof', keep.roof, ROOF);
  }
  if (here === cellOf((CAVE.x0 + CAVE.x1) / 2, (CAVE.y0 + CAVE.y1) / 2)) {
    add('cave', caveMesh(level), ROCK);
  }
  return {
    materials: MATERIALS,
    meshes,
    nodes: meshes.map((mesh, i) => ({ name: mesh.name, mesh: i })),
  };
}

/** The hills around the valley: one light grid, without the valley itself. */
function neighboursModel(): GlbModel {
  const mesh = new MeshBuilder();
  const step = 16;
  const from = -KEEP_WORLD;
  const to = 2 * KEEP_WORLD;
  const count = (to - from) / step;
  const height = (x: number, y: number) => {
    const out = Math.max(0 - x, x - KEEP_WORLD, 0 - y, y - KEEP_WORLD, 0);
    return (
      rolling(Math.min(Math.max(x, 0), KEEP_WORLD), Math.min(Math.max(y, 0), KEEP_WORLD)) -
      0.5 +
      out * 0.12 +
      4 * Math.sin(x / 41) * Math.sin(y / 37) * smooth(0, 40, out)
    );
  };
  const grid: number[][] = [];
  for (let j = 0; j <= count; j++) {
    const row: number[] = [];
    for (let i = 0; i <= count; i++) {
      const x = from + i * step;
      const y = from + j * step;
      const h = height(x, y);
      const hx = (height(x + 1, y) - height(x - 1, y)) / 2;
      const hy = (height(x, y + 1) - height(x, y - 1)) / 2;
      row.push(mesh.vertex(model(x, y, h), normalise([-hx, 1, hy]), [0.36, 0.42, 0.3]));
    }
    grid.push(row);
  }
  for (let j = 0; j < count; j++) {
    for (let i = 0; i < count; i++) {
      const x = from + i * step;
      const y = from + j * step;
      if (x >= 0 && x + step <= KEEP_WORLD && y >= 0 && y + step <= KEEP_WORLD) continue;
      const v00 = grid[j]![i]!;
      const v10 = grid[j]![i + 1]!;
      const v01 = grid[j + 1]![i]!;
      const v11 = grid[j + 1]![i + 1]!;
      mesh.indices.push(v00, v10, v01, v10, v11, v01);
    }
  }
  return {
    materials: [MATERIALS[GROUND]!],
    meshes: [{ name: 'hills around', primitives: [mesh.primitive(0)] }],
    nodes: [{ name: 'hills around', mesh: 0 }],
  };
}

export interface KeepFiles {
  /** The model files, by path in the pack. */
  files: Map<string, Buffer>;
  scene: Scene;
}

/** Writes the model files of the keep and the scene that names them. */
export async function keepScene(): Promise<KeepFiles> {
  const files = new Map<string, Buffer>();
  const cells: SceneCell[] = [];
  for (let cy = 0; cy < CELLS; cy++) {
    for (let cx = 0; cx < CELLS; cx++) {
      const cellId = `c${cx}-${cy}`;
      const lods: SceneCell['lods'] = [];
      let low = Infinity;
      let high = -Infinity;
      for (let level = 0; level < SEGMENTS.length; level++) {
        const glb = cellModel(cx, cy, level);
        for (const mesh of glb.meshes) {
          for (const primitive of mesh.primitives) {
            for (let k = 1; k < primitive.positions.length; k += 3) {
              low = Math.min(low, primitive.positions[k]!);
              high = Math.max(high, primitive.positions[k]!);
            }
          }
        }
        const file = `scene/${cellId}/lod${level}.glb`;
        files.set(file, await writeGlb(glb, { compress: level < 2 }));
        lods.push({ level, file, triangles: triangleCount(glb) });
      }
      cells.push({
        id: cellId,
        bounds: [cx * CELL, cy * CELL, (cx + 1) * CELL, (cy + 1) * CELL],
        heights: [Math.floor(low), Math.ceil(high)],
        lods,
      });
    }
  }
  files.set('scene/neighbours.glb', await writeGlb(neighboursModel(), { compress: true }));
  const scene: Scene = {
    heights: [-12, 40],
    cells,
    water: WATER,
    sky: '#9cc3e6',
    camera: { target: [128, 120, 4], distance: 230, yaw: 20, pitch: 42 },
    neighbours: 'scene/neighbours.glb',
  };
  return { files, scene };
}

// ---------------------------------------------------------------------------
// The map's data

interface Spot {
  local: string;
  name: string;
  category: string;
  x: number;
  y: number;
  /** Absent: on the ground, wherever it is when shown. */
  height?: number;
  guide?: string;
  /** The floor it is on; the ground floor when absent. */
  floor?: 'keep-caves' | 'keep-upper';
}

const KEEP_FLOOR_TOP = KEEP.base + 0.2;
const UPPER_TOP = KEEP.base + STOREY + 0.3;

/** The keep's locations, in world units. */
const SPOTS: readonly Spot[] = [
  // Open ground, with a height.
  {
    local: 'waystone-west',
    name: 'West waystone',
    category: 'waystone',
    x: 40,
    y: 210,
    height: 0,
    guide: WIKI_PAGES.waystones,
  },
  { local: 'camp-crossing', name: 'Crossing camp', category: 'camp', x: 120, y: 120, height: 0 },
  { local: 'herb-meadow', name: 'Meadow herbs', category: 'herb', x: 30, y: 40, height: 0 },
  { local: 'herb-east', name: 'Sunny bank herbs', category: 'herb', x: 230, y: 60, height: 0 },
  {
    local: 'den-east',
    name: 'Hillside den',
    category: 'den',
    x: 215,
    y: 120,
    height: 0,
    guide: WIKI_PAGES.wolves,
  },
  {
    local: 'warden-hill',
    name: 'Hilltop warden',
    category: 'elite',
    x: 175,
    y: 215,
    height: 0,
    guide: WIKI_PAGES.wardens,
  },
  { local: 'relic-lake', name: 'Drowned relic', category: 'relic', x: 70, y: 180, height: 0 },
  // Open ground, without a height: they sit on the surface.
  { local: 'herb-lakeside', name: 'Lakeside herbs', category: 'herb', x: 100, y: 200 },
  { local: 'herb-south', name: 'Roadside herbs', category: 'herb', x: 150, y: 40 },
  { local: 'relic-field', name: 'Field relic', category: 'relic', x: 60, y: 140 },
  { local: 'chest-corner', name: 'Forgotten chest', category: 'chest', x: 240, y: 240 },
  { local: 'camp-south', name: 'South camp', category: 'camp', x: 200, y: 30 },
  {
    local: 'waystone-hill',
    name: 'Hill waystone',
    category: 'waystone',
    x: 128,
    y: 160,
    guide: WIKI_PAGES.waystones,
  },
  { local: 'key-west', name: 'Lost key', category: 'key', x: 20, y: 120 },
  { local: 'relic-rise', name: 'Relic on the rise', category: 'relic', x: 180, y: 90 },
  { local: 'trench-mouth', name: 'Tunnel mouth', category: 'cavemouth', x: 132, y: 195 },
  // The keep's ground floor.
  {
    local: 'keep-door',
    name: 'Keep door',
    category: 'door',
    x: 80,
    y: 62.6,
    height: KEEP_FLOOR_TOP,
  },
  {
    local: 'keep-chest-hall',
    name: 'Hall chest',
    category: 'chest',
    x: 72,
    y: 66,
    height: KEEP_FLOOR_TOP,
  },
  {
    local: 'keep-chest-store',
    name: 'Storeroom chest',
    category: 'chest',
    x: 84,
    y: 75,
    height: KEEP_FLOOR_TOP,
  },
  {
    local: 'keep-key',
    name: 'Steward’s key',
    category: 'key',
    x: 75,
    y: 75,
    height: KEEP_FLOOR_TOP,
  },
  {
    local: 'keep-tablet',
    name: 'Founding tablet',
    category: 'tablet',
    x: 70,
    y: 73,
    height: KEEP_FLOOR_TOP,
  },
  // The keep's upper floor.
  {
    local: 'keep-chest-upper',
    floor: 'keep-upper',
    name: 'Solar chest',
    category: 'chest',
    x: 70,
    y: 64,
    height: UPPER_TOP,
  },
  {
    local: 'keep-relic',
    floor: 'keep-upper',
    name: 'Keep relic',
    category: 'relic',
    x: 90.5,
    y: 64,
    height: UPPER_TOP,
  },
  {
    local: 'keep-key-upper',
    floor: 'keep-upper',
    name: 'Tower key',
    category: 'key',
    x: 75,
    y: 76,
    height: UPPER_TOP,
  },
  {
    local: 'keep-warden',
    floor: 'keep-upper',
    name: 'Keep warden',
    category: 'elite',
    x: 83,
    y: 70,
    height: UPPER_TOP,
    guide: WIKI_PAGES.wardens,
  },
  {
    local: 'keep-herbs',
    floor: 'keep-upper',
    name: 'Drying herbs',
    category: 'herb',
    x: 89,
    y: 77,
    height: UPPER_TOP,
  },
  // The cave and its tunnel.
  {
    local: 'cave-chest',
    floor: 'keep-caves',
    name: 'Cave chest',
    category: 'chest',
    x: 190,
    y: 190,
    height: CAVE.floor,
  },
  {
    local: 'cave-relic',
    floor: 'keep-caves',
    name: 'Cave relic',
    category: 'relic',
    x: 202,
    y: 201,
    height: CAVE.floor,
  },
  {
    local: 'cave-warden',
    floor: 'keep-caves',
    name: 'Cave warden',
    category: 'elite',
    x: 196,
    y: 195,
    height: CAVE.floor,
    guide: WIKI_PAGES.wardens,
  },
  {
    local: 'cave-den',
    floor: 'keep-caves',
    name: 'Bat roost',
    category: 'den',
    x: 188,
    y: 202,
    height: CAVE.floor,
    guide: WIKI_PAGES.wolves,
  },
  {
    local: 'cave-key',
    floor: 'keep-caves',
    name: 'Glass key',
    category: 'key',
    x: 204,
    y: 188,
    height: CAVE.floor,
  },
  {
    local: 'cave-door',
    floor: 'keep-caves',
    name: 'Sealed cave door',
    category: 'door',
    x: 185,
    y: 195,
    height: CAVE.floor,
  },
  {
    local: 'tunnel-relic',
    name: 'Tunnel relic',
    category: 'relic',
    x: 160,
    y: 195,
    height: tunnelFloor(160),
  },
  {
    local: 'tunnel-chest',
    floor: 'keep-caves',
    name: 'Tunnel chest',
    category: 'chest',
    x: 172,
    y: 194,
    height: tunnelFloor(172),
  },
];

/** World x and y to map image pixels. */
const toPixel = (x: number, y: number): [number, number] => [
  Math.round(x * PIXELS_PER_UNIT * 10) / 10,
  Math.round((KEEP_WORLD - y) * PIXELS_PER_UNIT * 10) / 10,
];

export interface KeepOptions {
  tileSize: number;
  /** The tile source of each floor's layer, by its local id. */
  tiles: (local: string) => TileSource;
}

/** Adds the keep to the demo pack: its map with the scene, its floors and its locations. */
export function addKeep(data: PackData, scene: Scene, options: KeepOptions): PackData {
  const map: MapDef = {
    id: KEEP_MAP_ID,
    name: 'Mossgate Keep',
    width: KEEP_IMAGE,
    height: KEEP_IMAGE,
    // World x = px / 4, world y = 256 - py / 4: north is up on the map.
    worldTransform: {
      a: 1 / PIXELS_PER_UNIT,
      b: 0,
      c: 0,
      d: -1 / PIXELS_PER_UNIT,
      e: 0,
      f: KEEP_WORLD,
    },
    scene,
  };
  const maxZoom = pyramidMaxZoom(KEEP_IMAGE, KEEP_IMAGE, options.tileSize);
  const layers: Layer[] = KEEP_FLOORS.map((floor) => ({
    id: id('layer', floor.local),
    mapId: KEEP_MAP_ID,
    name: floor.name,
    tiles: options.tiles(floor.local),
    minZoom: 0,
    maxZoom,
    tileSize: options.tileSize,
    heights: [...floor.heights],
  }));
  const guides = new Set(data.guides.map((guide) => guide.id));
  const locations: Location[] = SPOTS.map((spot) => {
    const [x, y] = toPixel(spot.x, spot.y);
    const height = spot.height === 0 ? round(groundHeight(spot.x, spot.y)) : spot.height;
    return {
      id: id('loc', `keep-${spot.local}`),
      mapId: KEEP_MAP_ID,
      layerId: id('layer', spot.floor ?? 'keep-ground'),
      x,
      y,
      categoryId: id('cat', spot.category),
      regionId: null,
      name: spot.name,
      entityIds: [],
      guideId: spot.guide && guides.has(spot.guide) ? spot.guide : null,
      since: data.manifest.packVersion,
      ...(height === undefined ? {} : { height: round(height) }),
    };
  });
  return {
    ...data,
    maps: [...data.maps, map],
    layers: [...data.layers, ...layers],
    locations: [...data.locations, ...locations],
  };
}

const round = (value: number) => Math.round(value * 100) / 100;

// ---------------------------------------------------------------------------
// The map images: one of each floor, drawn from the same formulas

/** RGB pixels of each floor's map image, by the floor's local id. */
export function keepImages(): Map<string, Buffer> {
  const size = KEEP_IMAGE;
  const ground = Buffer.alloc(size * size * 3);
  const light = normalise([-0.5, 0.8, -0.4]);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) / PIXELS_PER_UNIT;
      const y = KEEP_WORLD - (py + 0.5) / PIXELS_PER_UNIT;
      const h = groundHeight(x, y);
      const e = 0.5;
      const hx = (groundHeight(x + e, y) - groundHeight(x - e, y)) / (2 * e);
      const hy = (groundHeight(x, y + e) - groundHeight(x, y - e)) / (2 * e);
      const shade = 0.55 + 0.6 * Math.max(0, dot(normalise([-hx, 1, hy]), light));
      let [r, g, b] = groundColour(h, Math.hypot(hx, hy)).map((c) => c * shade) as [
        number,
        number,
        number,
      ];
      if (underWater(x, y)) {
        const depth = Math.min(1, -h / 8);
        [r, g, b] = [0.2 - 0.1 * depth, 0.42 - 0.15 * depth, 0.6 - 0.1 * depth];
      }
      // Contour lines every 4 units.
      if (Math.abs(h / 4 - Math.round(h / 4)) < 0.03) [r, g, b] = [r * 0.8, g * 0.8, b * 0.8];
      const at = (py * size + px) * 3;
      ground[at] = Math.min(255, r * 255);
      ground[at + 1] = Math.min(255, g * 255);
      ground[at + 2] = Math.min(255, b * 255);
    }
  }
  const paint = (
    image: Buffer,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    colour: readonly number[],
  ) => {
    const [px0, py1] = toPixel(x0, y0);
    const [px1, py0] = toPixel(x1, y1);
    for (let py = Math.max(0, Math.floor(py0)); py < Math.min(size, Math.ceil(py1)); py++) {
      for (let px = Math.max(0, Math.floor(px0)); px < Math.min(size, Math.ceil(px1)); px++) {
        const at = (py * size + px) * 3;
        image[at] = colour[0]!;
        image[at + 1] = colour[1]!;
        image[at + 2] = colour[2]!;
      }
    }
  };
  const plan = (image: Buffer, upper: boolean) => {
    const { x0, x1, y0, y1 } = KEEP;
    paint(image, x0, y0, x1, y1, upper ? [176, 150, 112] : [150, 118, 82]);
    const wall = [70, 66, 60];
    paint(image, x0, y0, x1, y0 + 0.5, wall);
    paint(image, x0, y1 - 0.5, x1, y1, wall);
    paint(image, x0, y0, x0 + 0.5, y1, wall);
    paint(image, x1 - 0.5, y0, x1, y1, wall);
    paint(image, 79.8, y0, 80.2, 69, wall);
    paint(image, 79.8, 72, 80.2, y1, wall);
    if (!upper) paint(image, 78, y0, 82, y0 + 0.5, [150, 118, 82]);
    else {
      paint(image, 72, y0, 75, y0 + 0.5, [190, 215, 235]);
      paint(image, 85, y0, 88, y0 + 0.5, [190, 215, 235]);
    }
    for (let k = 0; k < 8; k++) {
      const tone = upper ? 120 - k * 6 : 170 - k * 8;
      paint(image, 86, 66 + k, 90, 66.8 + k, [tone, tone * 0.8, tone * 0.6]);
    }
  };
  const groundFloor = Buffer.from(ground);
  plan(groundFloor, false);
  const upperFloor = Buffer.alloc(ground.length);
  for (let i = 0; i < ground.length; i++) upperFloor[i] = 40 + ground[i]! * 0.45;
  plan(upperFloor, true);
  const caves = Buffer.alloc(ground.length);
  for (let i = 0; i < ground.length; i += 3) {
    const tone = 22 + ground[i + 1]! * 0.12;
    caves[i] = tone;
    caves[i + 1] = tone * 0.95;
    caves[i + 2] = tone * 0.9;
  }
  paint(caves, CAVE.x0, CAVE.y0, CAVE.x1, CAVE.y1, [150, 128, 104]);
  paint(
    caves,
    TUNNEL.to,
    TUNNEL.y - TUNNEL.half,
    TUNNEL.from,
    TUNNEL.y + TUNNEL.half,
    [128, 110, 90],
  );
  paint(caves, 192, 190, 194, 192, [70, 60, 50]);
  paint(caves, 198, 198, 200, 200, [70, 60, 50]);
  return new Map([
    ['keep-caves', caves],
    ['keep-ground', groundFloor],
    ['keep-upper', upperFloor],
  ]);
}
