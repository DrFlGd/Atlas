import { describe, expect, it } from 'vitest';
import {
  checkPackIntegrity,
  floorAt,
  floorsOf,
  layerSchema,
  locationSchema,
  mapSchema,
  modelToWorld,
  packDataReadSchema,
  packDataSchema,
  packReadSchemas,
  pixelToWorld,
  sceneFiles,
  sceneForDetail,
  sceneLevelsFor,
  sceneSchema,
  worldToPixel,
  type Scene,
} from './index';
import { makeFixturePack } from './testing/fixture';

const scene = (): Scene => ({
  cells: [
    {
      id: 'c0',
      bounds: [0, 0, 100, 100],
      heights: [-5, 40],
      lods: [
        { level: 0, file: 'scene/c0/lod0.glb', triangles: 1000 },
        { level: 1, file: 'scene/c0/lod1.glb', triangles: 250 },
        { level: 2, file: 'scene/c0/lod2.glb', triangles: 60 },
      ],
    },
    { id: 'c1', bounds: [100, 0, 200, 100], lods: [{ level: 1, file: 'scene/c1/lod1.glb' }] },
  ],
  water: 0,
  sky: '#8fb8de',
  camera: { target: [50, 50, 0], distance: 120, yaw: 0, pitch: 45 },
  neighbours: 'scene/neighbours.glb',
});

/** The fixture pack with a scene on its map, floors and heights. */
function packWithScene() {
  const pack = makeFixturePack();
  pack.maps[0] = { ...pack.maps[0]!, scene: scene() };
  pack.layers = [
    { ...pack.layers[0]!, heights: [-10, 4] },
    {
      ...pack.layers[0]!,
      id: 'demo:layer:upper',
      name: 'Upper',
      tiles: { type: 'xyz', url: 'tiles/upper/{z}/{x}/{y}.webp' },
      heights: [4, 12],
    },
  ];
  pack.locations = pack.locations.map((location, i) =>
    i === 0 ? { ...location, height: 7.5 } : location,
  );
  return pack;
}

describe('3D maps in the schema', () => {
  it('writes and reads a map with a scene, floors and heights', () => {
    const pack = packWithScene();
    expect(packDataSchema.safeParse(pack).success).toBe(true);
    expect(checkPackIntegrity(pack)).toEqual([]);
    const read = packDataReadSchema.parse(pack);
    expect(read.maps[0]!.scene?.cells).toHaveLength(2);
    expect(read.layers[1]!.heights).toEqual([4, 12]);
    expect(read.locations[0]!.height).toBe(7.5);
  });

  it('is strict when writing', () => {
    expect(sceneSchema.safeParse({ ...scene(), extra: 1 }).success).toBe(false);
    expect(sceneSchema.safeParse({ ...scene(), cells: [] }).success).toBe(false);
    const badFile = scene();
    badFile.cells[0]!.lods[0]!.file = 'scene/C0/LOD0.glb';
    expect(sceneSchema.safeParse(badFile).success).toBe(false);
    for (const file of ['scene/../x.glb', 'models/a.glb', 'scene/a.gltf', '/scene/a.glb']) {
      const bad = scene();
      bad.cells[0]!.lods[0]!.file = file;
      expect(sceneSchema.safeParse(bad).success, file).toBe(false);
    }
    expect(sceneSchema.safeParse({ ...scene(), axes: ['+x', '+x', '+y'] }).success).toBe(false);
    expect(sceneSchema.safeParse({ ...scene(), axes: ['+x', '+y', '+z'] }).success).toBe(true);
    expect(layerSchema.safeParse({ ...makeFixturePack().layers[0], heights: [1] }).success).toBe(
      false,
    );
  });

  it('reads tolerantly: what cannot be read is left out, not the pack', () => {
    const read = packReadSchemas;
    const base = makeFixturePack();
    // A scene that cannot be read: the map is read without it.
    const map = read.mapSchema.parse({ ...base.maps[0], scene: { cells: 'many' } });
    expect(map.scene).toBeUndefined();
    // A cell or a level that cannot be read is left out; unknown keys are dropped.
    const loose = scene() as unknown as { cells: unknown[]; future: boolean };
    loose.cells.push({ id: 'Bad Id', bounds: [0, 0, 1, 1], lods: [] });
    (loose.cells[0] as { lods: unknown[] }).lods.push({ level: 3, file: 'elsewhere.obj' });
    loose.future = true;
    const parsed = read.mapSchema.parse({ ...base.maps[0], scene: loose });
    expect(parsed.scene?.cells.map((cell) => cell.id)).toEqual(['c0', 'c1']);
    expect(parsed.scene?.cells[0]!.lods).toHaveLength(3);
    expect(parsed.scene).not.toHaveProperty('future');
    // A height or a range that cannot be read is left out.
    expect(read.locationSchema.parse({ ...base.locations[0], height: 'high' }).height).toBe(
      undefined,
    );
    expect(read.layerSchema.parse({ ...base.layers[0], heights: [1, 'x'] }).heights).toBe(
      undefined,
    );
    expect(locationSchema.safeParse({ ...base.locations[0], height: 'high' }).success).toBe(false);
    expect(mapSchema.safeParse({ ...base.maps[0], scene: { cells: 'many' } }).success).toBe(false);
  });

  it('checks what a per-file schema cannot see', () => {
    const pack = packWithScene();
    const theScene = pack.maps[0]!.scene!;
    theScene.cells[1]!.id = 'c0';
    theScene.cells[1]!.bounds = [100, 0, 200, 150];
    theScene.cells[0]!.heights = [40, -5];
    theScene.cells[0]!.lods[2]!.level = 1;
    theScene.cells[0]!.lods[1]!.triangles = 2000;
    theScene.neighbours = 'scene/c0/lod0.glb';
    pack.layers[1]!.heights = [12, 4];
    delete pack.maps[0]!.worldTransform;
    const paths = checkPackIntegrity(pack).map((issue) => issue.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'layers[1].heights',
        'maps[0].scene',
        'maps[0].scene.cells[1].id',
        'maps[0].scene.cells[1].bounds',
        'maps[0].scene.cells[0].heights',
        'maps[0].scene.cells[0].lods[2].level',
        'maps[0].scene.cells[0].lods[1].triangles',
        'maps[0].scene.cells[0].lods[0].file',
      ]),
    );
  });

  it('picks the levels of detail a pack file of each detail holds', () => {
    expect(sceneLevelsFor('full', [2, 0, 1])).toEqual([0, 1, 2]);
    expect(sceneLevelsFor('standard', [0, 1, 2])).toEqual([1, 2]);
    expect(sceneLevelsFor('overview', [0, 1, 2])).toEqual([2]);
    // A cell always keeps a level.
    expect(sceneLevelsFor('standard', [0])).toEqual([0]);
    expect(sceneLevelsFor('overview', [0])).toEqual([0]);
    expect(sceneLevelsFor('standard', [1])).toEqual([1]);
    expect(sceneLevelsFor('full', [])).toEqual([]);
    const cut = sceneForDetail(scene(), 'standard');
    expect(cut.cells[0]!.lods.map((lod) => lod.level)).toEqual([1, 2]);
    expect(cut.cells[1]!.lods.map((lod) => lod.level)).toEqual([1]);
    expect(sceneFiles(sceneForDetail(scene(), 'overview'))).toEqual([
      'scene/c0/lod2.glb',
      'scene/c1/lod1.glb',
      'scene/neighbours.glb',
    ]);
  });

  it('orders floors lowest first, and has none for a single one', () => {
    const layers = [
      { id: 'b', mapId: 'm', heights: [4, 8] as [number, number] },
      { id: 'flat', mapId: 'm' },
      { id: 'a', mapId: 'm', heights: [-2, 4] as [number, number] },
      { id: 'other', mapId: 'n', heights: [0, 1] as [number, number] },
    ];
    expect(floorsOf(layers, 'm').map((layer) => layer.id)).toEqual(['a', 'b']);
    expect(floorsOf(layers, 'n')).toEqual([]);
  });

  it('finds the floor a height is on: the lowest takes what is below, the highest what is above', () => {
    const floors = [
      { id: 'caves', mapId: 'm', heights: [-12, -4] as [number, number] },
      { id: 'ground', mapId: 'm', heights: [-4, 6.75] as [number, number] },
      { id: 'upper', mapId: 'm', heights: [6.75, 10.75] as [number, number] },
    ];
    expect(floorAt(floors, -10)?.id).toBe('caves');
    expect(floorAt(floors, -40)?.id).toBe('caves');
    expect(floorAt(floors, 3.2)?.id).toBe('ground');
    // On the line between two floors: the one above, which starts there.
    expect(floorAt(floors, 6.75)?.id).toBe('upper');
    expect(floorAt(floors, 7.3)?.id).toBe('upper');
    expect(floorAt(floors, 80)?.id).toBe('upper');
    expect(floorAt(floors.slice(0, 0), 3)).toBeUndefined();
  });

  it('turns model points into world points', () => {
    // glTF's own axes: X east, Y up, -Z north.
    const m = modelToWorld({ scale: 2, offset: [10, 20, 1] });
    const apply = ([x, y, z]: [number, number, number]) =>
      [0, 1, 2].map((r) => m[r * 4]! * x + m[r * 4 + 1]! * y + m[r * 4 + 2]! * z + m[r * 4 + 3]!);
    expect(apply([1, 2, 3])).toEqual([12, 14, 5]);
    // A Z-up model written as it is.
    const z = modelToWorld({ axes: ['+x', '+y', '+z'] });
    expect(z).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  });

  it('goes from map pixels to the world and back', () => {
    const t = { a: 2, b: 0.5, c: -0.25, d: -2, e: 100, f: 300 };
    const [wx, wy] = pixelToWorld(t, 40, 70);
    const back = worldToPixel(t, wx, wy)!;
    expect(back[0]).toBeCloseTo(40, 9);
    expect(back[1]).toBeCloseTo(70, 9);
    expect(worldToPixel({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }, 1, 1)).toBeNull();
  });
});
