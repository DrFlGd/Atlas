import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { castDown } from './castDown';

/** A level square of `side` at `height`, facing up (one-sided, as glTF's default). */
function slab(side: number, height: number, x = 0, z = 0): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(side, side);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
  mesh.position.set(x, height, z);
  mesh.updateMatrixWorld(true);
  return mesh;
}

describe('casting down onto the model', () => {
  const ground = slab(100, 0);
  const floor = slab(20, 12);
  const roof = slab(20, 24);
  const model = new THREE.Group();
  model.add(ground, floor, roof);
  model.updateMatrixWorld(true);

  it('meets the first surface below the start', () => {
    expect(castDown([model], 0, 0, 100)).toBeCloseTo(24);
    // From just above a location's own height, under the roof: its floor.
    expect(castDown([model], 0, 0, 13.5)).toBeCloseTo(12);
    expect(castDown([model], 0, 0, 11)).toBeCloseTo(0);
    // Off the house: the ground.
    expect(castDown([model], 30, 30, 100)).toBeCloseTo(0);
  });

  it('finds nothing where nothing is below', () => {
    expect(castDown([model], 80, 0, 100)).toBeNull();
    expect(castDown([model], 0, 0, -1)).toBeNull();
  });

  it('follows the model where it is placed in the view', () => {
    const moved = new THREE.Group();
    moved.add(slab(10, 3));
    moved.position.set(200, 5, -40);
    moved.updateMatrixWorld(true);
    expect(castDown([moved], 200, -40, 50)).toBeCloseTo(8);
    expect(castDown([moved], 0, 0, 50)).toBeNull();
  });
});
