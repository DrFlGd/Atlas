import { MeshoptDecoder } from 'meshoptimizer';
import { checkPackIntegrity, floorsOf, packDataSchema } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { readGlbJson, writeGlb, type GlbModel } from '../scene/glb';
import { addChecklists } from './checklists';
import { generateDemoContent, layoutRegions } from './content';
import { addKeep, groundHeight, keepImages, keepScene, KEEP_IMAGE, KEEP_MAP_ID } from './keep';
import { createTerrain } from './terrain';
import { addWiki } from './wiki';

const triangle: GlbModel = {
  materials: [{ name: 'm', color: [1, 1, 1, 1], roughness: 1 }],
  meshes: [
    {
      name: 'tri',
      primitives: [
        {
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
          colors: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]),
          indices: new Uint16Array([0, 1, 2]),
          material: 0,
        },
      ],
    },
  ],
  nodes: [{ name: 'tri', mesh: 0 }],
};

interface Json {
  bufferViews: {
    buffer: number;
    byteLength: number;
    extensions?: {
      EXT_meshopt_compression: {
        byteOffset: number;
        byteLength: number;
        byteStride: number;
        count: number;
        mode: string;
      };
    };
  }[];
  buffers: { byteLength: number }[];
  extensionsRequired?: string[];
}

describe('the glb writer', () => {
  it('writes a valid glTF 2.0 binary file', async () => {
    const file = await writeGlb(triangle);
    expect(file.toString('latin1', 0, 4)).toBe('glTF');
    expect(file.readUInt32LE(4)).toBe(2);
    expect(file.readUInt32LE(8)).toBe(file.length);
    const json = readGlbJson(file) as unknown as Json;
    expect(json.extensionsRequired).toBeUndefined();
    expect(json.bufferViews.every((view) => view.buffer === 0)).toBe(true);
  });

  it('compresses with EXT_meshopt_compression, which decodes back to the same data', async () => {
    const file = await writeGlb(triangle, { compress: true });
    const json = readGlbJson(file) as unknown as Json;
    expect(json.extensionsRequired).toEqual(['EXT_meshopt_compression']);
    const jsonLength = file.readUInt32LE(12);
    const bin = file.subarray(20 + jsonLength + 8);
    await MeshoptDecoder.ready;
    const positions = json.bufferViews[0]!.extensions!.EXT_meshopt_compression;
    const out = new Uint8Array(positions.count * positions.byteStride);
    MeshoptDecoder.decodeGltfBuffer(
      out,
      positions.count,
      positions.byteStride,
      bin.subarray(positions.byteOffset, positions.byteOffset + positions.byteLength),
      positions.mode,
    );
    expect([...new Float32Array(out.buffer)]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });
});

describe('the demo 3D map', () => {
  it('is a valid map with a scene, floors and heights', async () => {
    const terrain = createTerrain(7, 512);
    const base = addWiki(
      addChecklists(
        generateDemoContent(terrain, layoutRegions(7, terrain), {
          seed: 7,
          size: 512,
          tileSize: 256,
          locationCount: 50,
          tiles: { type: 'pmtiles', url: 'tiles/surface.pmtiles' },
        }),
      ),
    );
    const { scene, files } = await keepScene();
    const pack = addKeep(base, scene, {
      tileSize: 256,
      tiles: (local) => ({ type: 'pmtiles', url: `tiles/${local}.pmtiles` }),
    });
    expect(checkPackIntegrity(pack)).toEqual([]);
    expect(packDataSchema.safeParse(pack).success).toBe(true);
    const map = pack.maps.find((m) => m.id === KEEP_MAP_ID)!;
    expect(map.scene?.cells).toHaveLength(16);
    expect(floorsOf(pack.layers, KEEP_MAP_ID).map((l) => l.name)).toEqual([
      'Caves',
      'Ground floor',
      'Upper floor',
    ]);
    const spots = pack.locations.filter((l) => l.mapId === KEEP_MAP_ID);
    expect(spots.length).toBeGreaterThanOrEqual(30);
    expect(spots.some((l) => l.height === undefined)).toBe(true);
    expect(spots.some((l) => l.guideId !== null)).toBe(true);
    // Every file the scene names is written, finer levels larger, all of it small.
    for (const cell of map.scene!.cells) {
      for (const lod of cell.lods) expect(files.has(lod.file)).toBe(true);
      const sizes = cell.lods.map((lod) => lod.triangles!);
      expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    }
    const total = [...files.values()].reduce((sum, file) => sum + file.length, 0);
    expect(total).toBeLessThan(4 * 1024 * 1024);
  });

  it('draws a map image of each floor, of the map size', () => {
    const images = keepImages();
    expect([...images.keys()]).toEqual(['keep-caves', 'keep-ground', 'keep-upper']);
    for (const image of images.values()) expect(image.length).toBe(KEEP_IMAGE * KEEP_IMAGE * 3);
  });

  it('has a lake below the water and a hill', () => {
    expect(groundHeight(70, 180)).toBeLessThan(0);
    expect(groundHeight(190, 190)).toBeGreaterThan(20);
  });
});
