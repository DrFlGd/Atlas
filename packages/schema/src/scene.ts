import { z } from 'zod';
import type { SchemaMode } from './entities';

/**
 * 3D maps. A 3D map is an ordinary map of a pack with a model added: its
 * map images, layers, locations, areas, lists and routes are those of any
 * map, and an app that knows nothing of 3D shows it in 2D as before. Three
 * optional fields make it 3D:
 *
 * - `scene` on a map (`maps.json`): the map has a model, cut into square
 *   cells, each at several levels of detail, in glTF 2.0 binary files
 *   (`.glb`) under the pack's `scene/` folder. See {@link sceneSchemas}.
 * - `height` on a location (`locations.json`): its height in the game's
 *   world, in the units of the map's `worldTransform`. With its `x` and `y`
 *   it gives the location's place in 3D. A location without a height sits
 *   on the model's surface below it, wherever that is when it is shown.
 * - `heights` on a layer (`layers.json`): `[min, max]`, the heights of the
 *   world the layer shows, which makes the layer a floor. Floors are
 *   optional: a 3D map without them is shown whole, and cut at any height
 *   the person chooses. A location's height never depends on its floor.
 *
 * A map with a `scene` must have a `worldTransform`: the model lines up
 * with the map through it. Coordinates (see {@link SceneAxis}):
 *
 *   world = scale * (axes applied to the model's point) + offset
 *
 * that is, for a model point (X, Y, Z) after every node transform of its
 * file, `world x = scale * pick(axes[0]) + offset[0]`, `world y = scale *
 * pick(axes[1]) + offset[1]` and `height = scale * pick(axes[2]) +
 * offset[2]`, where `pick("+x")` is X, `pick("-z")` is -Z and so on. The
 * default, `["+x", "-z", "+y"]`, is glTF's own: Y up, and the world's y
 * axis pointing away from the model's +Z, as a Z-up, right-handed world is
 * written into glTF by most exporters. A map pixel (px, py) is at world
 * (x, y) through the map's `worldTransform`, so a model point is drawn
 * above the map pixel its world x and y lead back to.
 *
 * Written strictly, read tolerantly (see {@link SchemaMode}): when
 * reading, a scene that cannot be read is left out (the map is shown in
 * 2D), a cell that cannot be read is left out, a level of detail that
 * cannot be read is left out, and so is a height or a range that cannot.
 * A pack with a scene is written in version 11 of the pack file format
 * (see `docs/pack-file-format.md`).
 */

/** The folder of a pack that holds its models. */
export const SCENE_DIR = 'scene';
/**
 * A model file's path in the pack: `scene/` and up to five segments of
 * lower case letters, digits, `_`, `.` and `-`, each starting with a
 * letter or a digit and at most 64 characters, the last ending in `.glb`.
 * Lower case only, so no two paths differ only by case on any system.
 */
export const SCENE_FILE_PATTERN =
  /^scene\/(?:[a-z0-9][a-z0-9_.-]{0,63}\/){0,4}[a-z0-9][a-z0-9_.-]{0,59}\.glb$/;
/** A cell's id: unique among the cells of its map. */
export const SCENE_CELL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The most cells a map's scene has. */
export const MAX_SCENE_CELLS = 4096;
/** The levels of detail a cell may have: 0 (the finest) to this. */
export const MAX_SCENE_LEVEL = 7;
/** The most bytes one model file may have. */
export const MAX_SCENE_FILE_BYTES = 256 * 1024 * 1024;

/** An axis of the model and its direction, as `axes` names them. */
export const SCENE_AXES = ['+x', '-x', '+y', '-y', '+z', '-z'] as const;
export type SceneAxis = (typeof SCENE_AXES)[number];
/** glTF's own axes: Y up, world y away from +Z (see the module). */
export const DEFAULT_SCENE_AXES: readonly [SceneAxis, SceneAxis, SceneAxis] = ['+x', '-z', '+y'];

const finite = z.number();
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour');
/** `[min, max]`. Integrity checks that min is not above max. */
export const heightRangeSchema = z.tuple([finite, finite]);
const sceneFileSchema = z
  .string()
  .regex(
    SCENE_FILE_PATTERN,
    'must be scene/… in lower case letters, digits, _, . and -, ending in .glb',
  );

/** Whether `axes` names each of the model's three axes once. */
export function isAxesPermutation(axes: readonly string[]): boolean {
  return axes.length === 3 && new Set(axes.map((axis) => axis.slice(1))).size === 3;
}

/**
 * Reads an array leniently: the items that cannot be read are left out,
 * and an array left with none cannot be read. Typed as the strict array.
 */
function lenientArray<T extends z.ZodType>(item: T): z.ZodArray<T> {
  return z
    .array(z.unknown())
    .transform((list) =>
      list.flatMap((value) => {
        const parsed = item.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }),
    )
    .refine((list) => list.length > 0, 'has nothing that can be read') as unknown as z.ZodArray<T>;
}

export function sceneSchemas(mode: SchemaMode) {
  const reading = mode === 'read';
  const record = <T extends z.core.$ZodLooseShape>(shape: T) =>
    reading
      ? z.object(shape)
      : (z.strictObject(shape) as unknown as ReturnType<typeof z.object<T>>);
  /** Optional when writing; when reading, a value that cannot be read is left out. */
  const optional = <T extends z.ZodType>(schema: T) =>
    reading
      ? (schema.optional().catch(undefined) as unknown as z.ZodOptional<T>)
      : schema.optional();

  /** One level of detail of a cell: its file, and how many triangles it has when known. */
  const sceneLodSchema = record({
    /** 0 is the finest; each next level is coarser. */
    level: z.int().min(0).max(MAX_SCENE_LEVEL),
    file: sceneFileSchema,
    /** The triangles of the file, so an app can plan before it loads it. */
    triangles: optional(z.int().nonnegative()),
  });

  /**
   * A square part of the model, in world x and y (`bounds`), with its
   * files at several levels of detail. `heights` is the range of the
   * heights it holds, when known.
   */
  const sceneCellSchema = record({
    id: z.string().regex(SCENE_CELL_ID_PATTERN, 'must be 1 to 64 a-z, 0-9, _ and -'),
    /** `[minX, minY, maxX, maxY]` in world units; a square. */
    bounds: z.tuple([finite, finite, finite, finite]),
    heights: optional(heightRangeSchema),
    /** Finest first, each level once. */
    lods: reading
      ? lenientArray(sceneLodSchema)
      : z
          .array(sceneLodSchema)
          .min(1)
          .max(MAX_SCENE_LEVEL + 1),
  });

  /** Where the 3D view starts, unless the person has looked elsewhere. */
  const sceneCameraSchema = record({
    /** The point looked at: `[x, y, height]` in world units. */
    target: z.tuple([finite, finite, finite]),
    /** From the camera to the target, in world units. */
    distance: z.number().positive(),
    /** Where the camera looks, in degrees clockwise from the map image's up. */
    yaw: z.number().min(-360).max(360),
    /** How far it looks down, in degrees: 0 level, 90 straight down. */
    pitch: z.number().min(0).max(90),
  });

  const sceneSchema = record({
    /**
     * Which axis of the model gives world x, world y and height, each with
     * its direction (see the module); `["+x", "-z", "+y"]` when absent.
     * The up axis is the third.
     */
    axes: optional(
      z
        .tuple([z.enum(SCENE_AXES), z.enum(SCENE_AXES), z.enum(SCENE_AXES)])
        .refine(isAxesPermutation, 'must name each of x, y and z once'),
    ),
    /** World units per model unit; 1 when absent. */
    scale: optional(z.number().positive()),
    /** Added after scaling: `[x, y, height]` in world units; none when absent. */
    offset: optional(z.tuple([finite, finite, finite])),
    /** The heights the model spans, `[min, max]`, for the height cut. */
    heights: optional(heightRangeSchema),
    cells: reading
      ? lenientArray(sceneCellSchema)
      : z.array(sceneCellSchema).min(1).max(MAX_SCENE_CELLS),
    /** The height of open water, drawn as a plane; none when absent. */
    water: optional(finite),
    /** The colour of the sky, `#rrggbb`; the theme's when absent. */
    sky: optional(hexColor),
    camera: optional(sceneCameraSchema),
    /**
     * A light model of what lies around the cells (distant hills, the
     * coast), drawn at once and never cut into cells.
     */
    neighbours: optional(sceneFileSchema),
  });

  return { sceneLodSchema, sceneCellSchema, sceneCameraSchema, sceneSchema };
}

export const { sceneLodSchema, sceneCellSchema, sceneCameraSchema, sceneSchema } =
  sceneSchemas('write');
export const sceneReadSchemas = sceneSchemas('read');

export type Scene = z.infer<typeof sceneSchema>;
export type SceneCell = z.infer<typeof sceneCellSchema>;
export type SceneLod = z.infer<typeof sceneLodSchema>;
export type SceneCamera = z.infer<typeof sceneCameraSchema>;

// ---------------------------------------------------------------------------
// Detail of a pack file

/**
 * How much of each map a pack file holds (`atlas-pack`'s `Detail`), and so
 * which levels of detail of each cell go in:
 *
 * - `full`: every level.
 * - `standard`: every level but 0, the finest; a cell whose only level is
 *   0 keeps it.
 * - `overview`: the coarsest level of each cell alone.
 *
 * A cell always keeps at least one level. The crate's `scene_levels` does
 * the same, and `docs/pack-file-format.md` says it.
 */
export type PackDetail = 'overview' | 'standard' | 'full';

/** The levels of a cell a pack file of `detail` holds, finest first. */
export function sceneLevelsFor(detail: PackDetail, levels: readonly number[]): number[] {
  const sorted = [...new Set(levels)].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const coarsest = sorted[sorted.length - 1]!;
  switch (detail) {
    case 'full':
      return sorted;
    case 'standard': {
      const kept = sorted.filter((level) => level >= 1);
      return kept.length > 0 ? kept : [coarsest];
    }
    case 'overview':
      return [coarsest];
  }
}

/** A scene with each cell cut to the levels a pack file of `detail` holds. */
export function sceneForDetail(scene: Scene, detail: PackDetail): Scene {
  return {
    ...scene,
    cells: scene.cells.map((cell) => {
      const kept = new Set(
        sceneLevelsFor(
          detail,
          cell.lods.map((lod) => lod.level),
        ),
      );
      return { ...cell, lods: cell.lods.filter((lod) => kept.has(lod.level)) };
    }),
  };
}

/** Every file a scene names: each level of each cell, and the neighbours. */
export function sceneFiles(scene: Scene): string[] {
  return [
    ...scene.cells.flatMap((cell) => cell.lods.map((lod) => lod.file)),
    ...(scene.neighbours ? [scene.neighbours] : []),
  ];
}

// ---------------------------------------------------------------------------
// Floors

/** A layer that is a floor: one with `heights`. */
export interface FloorLike {
  id: string;
  mapId: string;
  heights?: readonly [number, number] | undefined;
}

/**
 * The floors of a map, lowest first: its layers with `heights`, by their
 * lowest height, then their highest, then their order in the pack. Empty
 * when the map has none, or one alone (one floor is no stack to go up and
 * down in).
 */
export function floorsOf<T extends FloorLike>(layers: readonly T[], mapId: string): T[] {
  const floors = layers
    .map((layer, index) => ({ layer, index }))
    .filter(({ layer }) => layer.mapId === mapId && layer.heights !== undefined)
    .sort(
      (a, b) =>
        a.layer.heights![0] - b.layer.heights![0] ||
        a.layer.heights![1] - b.layer.heights![1] ||
        a.index - b.index,
    )
    .map(({ layer }) => layer);
  return floors.length >= 2 ? floors : [];
}

/**
 * The floor a height is on, of floors lowest first (as {@link floorsOf}
 * gives them): the highest floor that starts at or below it. The lowest
 * floor takes what is below every floor, and the highest what is above.
 * Undefined when there are no floors.
 */
export function floorAt<T extends FloorLike>(floors: readonly T[], height: number): T | undefined {
  let found: T | undefined = floors[0];
  for (const floor of floors) {
    if (floor.heights && floor.heights[0] <= height) found = floor;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Where things are

/** The six numbers of a map's `worldTransform`. */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** A map pixel's world x and y. */
export function pixelToWorld(t: Affine, x: number, y: number): [number, number] {
  return [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
}

/** A world x and y's map pixel; null when the transform cannot be turned round. */
export function worldToPixel(t: Affine, wx: number, wy: number): [number, number] | null {
  const det = t.a * t.d - t.b * t.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const dx = wx - t.e;
  const dy = wy - t.f;
  return [(t.d * dx - t.c * dy) / det, (-t.b * dx + t.a * dy) / det];
}

/**
 * The model-to-world matrix of a scene, 3 rows of 4 (row-major): `[world
 * x, world y, height] = M · [X, Y, Z, 1]` (see the module).
 */
export function modelToWorld(scene: Pick<Scene, 'axes' | 'scale' | 'offset'>): number[] {
  const axes = scene.axes ?? DEFAULT_SCENE_AXES;
  const scale = scene.scale ?? 1;
  const offset = scene.offset ?? [0, 0, 0];
  const rows: number[] = [];
  axes.forEach((axis, row) => {
    const sign = axis.startsWith('-') ? -1 : 1;
    const column = 'xyz'.indexOf(axis.slice(1));
    for (let k = 0; k < 3; k++) rows.push(k === column ? sign * scale : 0);
    rows.push(offset[row]!);
  });
  return rows;
}
