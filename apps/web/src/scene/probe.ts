import { cellBox, sceneFrame } from '@atlas/core';
import type { MapDef, Scene, SceneCell } from '@atlas/schema';
import * as THREE from 'three';
import { castDown } from './castDown';
import { modelLoader } from './loader';

/**
 * The heights of the surface of a 3D map's model below some of its map
 * pixels, for locations taken from another pack (see
 * `state/takeLocations.ts`): whether or not the 3D view is open, each cell
 * under a point is read once, at the finest level of detail that is not
 * too large to read for this, cast down onto, and let go of. Part of the
 * 3D view's chunk, loaded only when it is needed.
 */

/** A point to cast down from: a map pixel, and the height to start at (null: above the whole model). */
export interface ProbePoint {
  x: number;
  y: number;
  from: number | null;
}

/** The most triangles a level read only to cast down onto may have; a coarser one is read instead. */
export const PROBE_TRIANGLES = 400_000;

/** The level of a cell read to cast down onto: the finest small enough, else the coarsest. */
export function probeLevel(cell: Pick<SceneCell, 'lods'>): SceneCell['lods'][number] | undefined {
  const small = cell.lods.find(
    (lod) => lod.triangles !== undefined && lod.triangles <= PROBE_TRIANGLES,
  );
  return small ?? cell.lods.at(-1);
}

/** The height a cast down starts at when a location has none: above everything the model holds. */
function topOf(scene: Scene): number {
  const tops = [
    scene.heights?.[1],
    ...scene.cells.map((cell) => cell.heights?.[1]),
    scene.water,
  ].filter((value): value is number => value !== undefined);
  return tops.length > 0 ? Math.max(...tops) + 10 : 100_000;
}

/**
 * The height of the surface below each point (null: none), cast down from
 * its `from` or the top; where the model has nothing below, open water
 * (as the view puts a dot without height there). Throws where the
 * device cannot read the model (no WebGL 2).
 */
export async function probeHeights(
  map: Pick<MapDef, 'scene' | 'worldTransform'>,
  resolveUrl: (file: string) => string,
  points: readonly ProbePoint[],
): Promise<(number | null)[]> {
  const scene = map.scene;
  const frame = scene && map.worldTransform ? sceneFrame(map.worldTransform, scene) : null;
  if (!scene || !frame) return points.map(() => null);
  const top = topOf(scene);
  const view = points.map((point) => frame.fromPixel(point.x, point.y, 0));
  const found: (number | null)[] = points.map(() => null);
  // A context only to tell which compressed textures the device reads.
  const renderer = new THREE.WebGLRenderer({ canvas: document.createElement('canvas') });
  const loader = modelLoader(renderer);
  const raycaster = new THREE.Raycaster();
  try {
    for (const cell of scene.cells) {
      const [x0, z0, x1, z1] = cellBox(frame, cell.bounds);
      const margin = (x1 - x0) * 1e-6;
      const here = view
        .map((point, i) => ({ point, i }))
        .filter(
          ({ point: [x, , z] }) =>
            x >= x0 - margin && x <= x1 + margin && z >= z0 - margin && z <= z1 + margin,
        );
      const lod = probeLevel(cell);
      if (here.length === 0 || !lod) continue;
      let gltf: Awaited<ReturnType<typeof loader.load>>;
      try {
        gltf = await loader.load(resolveUrl(lod.file));
      } catch {
        // A cell that cannot be read has no surface to give.
        continue;
      }
      const root = new THREE.Group();
      root.matrixAutoUpdate = false;
      root.matrix.fromArray(frame.modelMatrix);
      root.add(gltf.scene);
      root.updateMatrixWorld(true);
      for (const { point, i } of here) {
        const from = points[i]!.from ?? top;
        const height = castDown([root], point[0], point[2], from, raycaster);
        // On the edge of two cells, the higher surface below the start.
        if (height !== null && (found[i] === null || height > found[i]!)) found[i] = height;
      }
      dispose(gltf.scene);
    }
  } finally {
    loader.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
  if (scene.water !== undefined) {
    const water = scene.water;
    return found.map((height, i) => {
      const from = points[i]!.from ?? top;
      return height === null && water <= from ? water : height;
    });
  }
  return found;
}

function dispose(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    (object.geometry as THREE.BufferGeometry).dispose();
    const materials = (
      Array.isArray(object.material) ? object.material : [object.material]
    ) as THREE.Material[];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}
