import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { INSIDE_SHADE, drawnBothSides, insideOf, lambertOf } from './engine';

describe('the sides of a surface', () => {
  it('draws the sides the model’s material says: its front only by default', () => {
    const oneSided = new THREE.MeshStandardMaterial({ color: 0x808080 });
    expect(lambertOf(oneSided).side).toBe(THREE.FrontSide);
    const twoSided = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
    expect(lambertOf(twoSided).side).toBe(THREE.DoubleSide);
    // Files of the first builder were made for a view that drew both sides.
    expect(lambertOf(oneSided, true).side).toBe(THREE.DoubleSide);
    expect(drawnBothSides('Atlas scene builder 0.1.0')).toBe(true);
    expect(drawnBothSides('Atlas scene builder 0.2.0')).toBe(false);
    expect(drawnBothSides(undefined)).toBe(false);
  });

  it('draws the inside of a cut-open model darkened, with its texture and cutout', () => {
    const map = new THREE.Texture();
    const lambert = lambertOf(
      new THREE.MeshStandardMaterial({ color: 0xffffff, map, alphaTest: 0.5 }),
    );
    const inside = insideOf(lambert);
    expect(inside.side).toBe(THREE.BackSide);
    expect(inside.map).toBe(map);
    expect(inside.alphaTest).toBe(0.5);
    expect(inside.color.getHex()).toBe(INSIDE_SHADE);
    // Unlit, so the inside reads as inside whatever the light.
    expect(inside).toBeInstanceOf(THREE.MeshBasicMaterial);
  });
});
