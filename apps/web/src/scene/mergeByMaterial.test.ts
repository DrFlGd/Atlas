import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { compactPart, mergeByMaterial } from './engine';

/**
 * A made-up cell as a loader gives it: one set of vertices (a grid of
 * `side` by `side`), and a mesh per primitive, each with its own triangles
 * and material, all sharing those vertices.
 */
function sharedCell(side: number, primitives: number, materialOf = (p: number) => p) {
  const count = side * side;
  const position = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
  const normal = new THREE.BufferAttribute(new Int8Array(count * 3), 3, true);
  const uv = new THREE.BufferAttribute(new Float32Array(count * 2), 2);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const v = j * side + i;
      position.setXYZ(v, i, Math.sin(i / 7) * Math.cos(j / 9), -j);
      normal.setXYZ(v, 0, 1, 0);
      uv.setXY(v, i / side, j / side);
    }
  }
  const quads: number[][] = Array.from({ length: primitives }, () => []);
  for (let j = 0; j < side - 1; j++) {
    for (let i = 0; i < side - 1; i++) {
      const a = j * side + i;
      quads[(j * (side - 1) + i) % primitives]!.push(
        a,
        a + 1,
        a + side + 1,
        a,
        a + side + 1,
        a + side,
      );
    }
  }
  const materials = new Map<number, THREE.Material>();
  const root = new THREE.Group();
  quads.forEach((indices, p) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', position);
    geometry.setAttribute('normal', normal);
    geometry.setAttribute('uv', uv);
    geometry.setIndex(indices);
    const key = materialOf(p);
    let material = materials.get(key);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ name: `made-up ${key}` });
      materials.set(key, material);
    }
    root.add(new THREE.Mesh(geometry, material));
  });
  return { root, position, count };
}

describe('the meshes of a loaded cell', () => {
  it('draws a material of one primitive with the vertices the cell shares, not a copy', () => {
    const { root, position } = sharedCell(40, 12);
    const loaded = mergeByMaterial(root);
    expect(loaded.meshes).toHaveLength(12);
    for (const mesh of loaded.meshes) {
      expect(mesh.geometry.getAttribute('position')).toBe(position);
    }
    expect(loaded.triangles).toBe(39 * 39 * 2);
  });

  it('merges the primitives of one material, each with only the vertices it uses', () => {
    // Two materials over four primitives: 0 and 2 share one, 1 and 3 the other.
    const { root, count } = sharedCell(20, 4, (p) => p % 2);
    const loaded = mergeByMaterial(root);
    expect(loaded.meshes).toHaveLength(2);
    expect(loaded.triangles).toBe(19 * 19 * 2);
    for (const mesh of loaded.meshes) {
      const merged = mesh.geometry.getAttribute('position').count;
      // Each half of the triangles uses fewer vertices than the two parts' copies of all.
      expect(merged).toBeLessThan(2 * count);
      expect(mesh.geometry.getAttribute('normal').normalized).toBe(true);
    }
  });

  it('keeps only the vertices a primitive uses, moved into place, and the same triangles', () => {
    const position = new THREE.BufferAttribute(
      new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 5, 5, 5]),
      3,
    );
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', position);
    geometry.setIndex([3, 2, 0]);
    const moved = new THREE.Matrix4().makeTranslation(10, 0, 0);
    const part = compactPart({ geometry, matrix: moved });
    const out = part.getAttribute('position');
    expect(out.count).toBe(3);
    expect([0, 1, 2].map((i) => [out.getX(i), out.getY(i)])).toEqual([
      [10, 1],
      [11, 1],
      [10, 0],
    ]);
    expect(Array.from(part.index!.array)).toEqual([0, 1, 2]);
    // The model's own vertices are left as they were.
    expect(position.getX(0)).toBe(0);
  });

  it('moves a primitive that stands elsewhere in the model on a copy of its vertices', () => {
    const { root, position } = sharedCell(10, 2);
    root.children[0]!.position.set(100, 0, 0);
    const loaded = mergeByMaterial(root);
    const [moved, kept] = loaded.meshes;
    expect(moved!.geometry.getAttribute('position')).not.toBe(position);
    expect(moved!.geometry.getAttribute('position').getX(0)).toBe(100);
    expect(kept!.geometry.getAttribute('position')).toBe(position);
    expect(position.getX(0)).toBe(0);
  });
});
