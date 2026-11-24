import * as THREE from 'three';

/**
 * Casting down onto a model: the height of the first surface straight
 * below a point of the view's frame (x and z across the map, y the height),
 * from `from` down; null when nothing is below it. Surfaces are met on the
 * sides their materials are drawn on, as the view draws them, so a floor
 * is met from above and a roof's underside is not.
 */
export function castDown(
  objects: readonly THREE.Object3D[],
  x: number,
  z: number,
  from: number,
  raycaster = new THREE.Raycaster(),
): number | null {
  raycaster.set(new THREE.Vector3(x, from, z), new THREE.Vector3(0, -1, 0));
  raycaster.far = Infinity;
  const hit = raycaster.intersectObjects([...objects], true)[0];
  return hit ? hit.point.y : null;
}
