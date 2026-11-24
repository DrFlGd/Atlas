/**
 * The 3D view of the Adjust floors panel: the area's triangles (as the floor finder sees them, from the make's floor
 * data), each part in the colour of the floor its height is on (the selected floor bright, the others dimmer), each
 * cut a see-through level plane in the colour of the floor above it, and the area's markers as dots. "Hide what is
 * above this floor" leaves out everything above the selected floor's top cut, so the view looks down into it.
 * With automatic passages (`triangleFloors`), each walkable triangle is in the colour of its own floor, walls and
 * slopes grey, there are no cut planes, and "Hide what is above this floor" leaves out the floors above it and
 * what stands higher than its top; the overlapping places are shown as large white-ringed dots.
 *
 * The setup of "Make a map from a 3D model…" shows the model here too, in its own colours (`ownColours`), with
 * its bounds as a box.
 *
 * Remove pieces (`picking`): a press on the model chooses the surface under it (`onPickSurface`, the triangle
 * pressed, the nearest one not cut away), in place of an item. `marks` shows each triangle's part in it (pieces.ts):
 * the chosen piece yellow, the rest of its part pale yellow, removed pieces dark red.
 *
 * Pressing an item's dot goes to it (`goTo`): the panel shows its floor and cuts the view at head height above it
 * (`cutAt`), and the view flies down to look at it from close by, a little tilted, facing the way it faced (it jumps
 * where the person asked for less motion; any move by hand stops it).
 *
 * It is loaded only when the panel shows it (three.js is large). Mouse, touch and keyboard turn and zoom it; it
 * draws only when something changed. Coordinates: three.js x is the game's x (east), y its height, z minus its z
 * (so that north is away from a viewer in the south and east is on the right, as on the map).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { floorColour, fromBase64, type MarkerLook } from './floors';
import type { AreaMarker, AreaModel } from './shell';

/** The most cuts the view colours by (the panel allows fewer). */
const MAX_CUTS = 32;
const DOT_SIZE = 9;
const HOVER_REACH = 12;

export interface FloorsSceneState {
  cuts: readonly number[];
  selected: number;
  hideAbove: boolean;
  showMarkers: boolean;
  /** The edges of the walls and floors (where the surface bends sharply) as light lines. */
  outlines: boolean;
  looks: readonly MarkerLook[];
  /** Automatic passages: each triangle's floor (255 for walls and slopes). */
  triangleFloors?: Uint8Array | null;
  /** Automatic passages: with hideAbove, the height above which walls and slopes are left out. */
  clipHeight?: number | null;
  /** Automatic passages: the overlapping places (x east, y height, z north), the chosen one first in look. */
  places?: readonly { x: number; y: number; z: number; chosen: boolean }[];
  /** After going to an item: the height everything above is left out, in place of the floor's. */
  cutAt?: number | null;
  /** Each triangle in its own colour (the model's `colours`), not its floor's. */
  ownColours?: boolean;
  /** Remove pieces: a press chooses a surface, not an item. */
  picking?: boolean;
  /** Per triangle (pieces.ts PieceMark): 1 the chosen piece, 2 removed, 3 the rest of the chosen piece's part. */
  marks?: Uint8Array | null;
}

export interface FloorsSceneHover {
  index: number;
  /** In the view's box, in CSS pixels, and as fractions of its width and height. */
  x: number;
  y: number;
  across: number;
  down: number;
}

export interface FloorsScene {
  update(state: FloorsSceneState): void;
  resetView(): void;
  /** Turns the view round its centre (radians) and up or down. */
  turn(around: number, up: number): void;
  /** Moves nearer (factor below 1) or further. */
  zoom(factor: number): void;
  /** Flies down to look at a marker from close by. */
  goTo(index: number): void;
  dispose(): void;
}

const MODEL_VERTEX = /* glsl */ `
attribute float floorIndex;
attribute vec3 ownColour;
attribute float mark;
varying vec3 vWorld;
varying float vFloor;
varying vec3 vOwn;
varying float vMark;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vFloor = floorIndex;
  vOwn = ownColour;
  vMark = mark;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const MODEL_FRAGMENT = /* glsl */ `
uniform float cuts[${MAX_CUTS}];
uniform int cutCount;
uniform vec3 colours[${MAX_CUTS + 1}];
uniform int selected;
uniform float clipTop;
uniform vec3 lightDir;
uniform int byTriangle;
uniform int hideFloorsAbove;
uniform int byOwnColour;
varying vec3 vWorld;
varying float vFloor;
varying vec3 vOwn;
varying float vMark;
void main() {
  if (vWorld.y > clipTop) discard;
  int band = 0;
  vec3 base;
  if (byTriangle == 1) {
    band = vFloor > 254.5 ? -1 : int(vFloor + 0.5);
    if (hideFloorsAbove == 1 && band > selected) discard;
    base = vec3(0.54, 0.565, 0.6);
    for (int i = 0; i <= ${MAX_CUTS}; i++) {
      if (i == band) base = colours[i];
    }
  } else {
    for (int i = 0; i < ${MAX_CUTS}; i++) {
      if (i >= cutCount) break;
      if (vWorld.y > cuts[i]) band++;
    }
    base = colours[band];
  }
  if (byOwnColour == 1) {
    base = vOwn;
    band = selected;
  }
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  float up = abs(n.y);
  float light = 0.38 + 0.47 * abs(dot(n, lightDir)) + 0.15 * up;
  vec3 colour = (band == selected || band < 0) ? base : mix(base, vec3(0.46, 0.49, 0.54), 0.62) * 0.72;
  colour = mix(colour * 0.78, colour, up);
  if (vMark > 0.5 && vMark < 1.5) colour = vec3(1.0, 0.84, 0.3);
  else if (vMark > 1.5 && vMark < 2.5) colour = mix(colour, vec3(0.55, 0.12, 0.14), 0.75);
  else if (vMark > 2.5) colour = mix(colour, vec3(1.0, 0.9, 0.6), 0.45);
  gl_FragColor = vec4(colour * light, 1.0);
}
`;

const EDGE_VERTEX = /* glsl */ `
varying float vHeight;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vHeight = world.y;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const EDGE_FRAGMENT = /* glsl */ `
uniform float clipTop;
varying float vHeight;
void main() {
  if (vHeight > clipTop) discard;
  gl_FragColor = vec4(0.965, 0.925, 0.784, 0.9);
}
`;

const DOT_VERTEX = /* glsl */ `
attribute vec3 dotColor;
attribute float look;
uniform float size;
uniform float pixelRatio;
uniform float clipTop;
varying vec3 vColor;
varying float vLook;
varying float vHidden;
void main() {
  vColor = dotColor;
  vLook = look;
  vHidden = position.y > clipTop ? 1.0 : 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = (look > 0.5 ? size * 1.45 : size) * pixelRatio;
}
`;

const DOT_FRAGMENT = /* glsl */ `
uniform float opacity;
varying vec3 vColor;
varying float vLook;
varying float vHidden;
void main() {
  if (vHidden > 0.5) discard;
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float border = vLook > 0.5 ? 0.6 : 0.72;
  vec3 ring = vLook > 1.5 ? vec3(1.0) : (vLook > 0.5 ? vec3(1.0, 0.84, 0.3) : vec3(0.05, 0.06, 0.08));
  gl_FragColor = vec4(r > border ? ring : vColor, opacity);
}
`;

export function createFloorsScene(options: {
  container: HTMLElement;
  model: AreaModel;
  markers: readonly AreaMarker[];
  onHover: (hover: FloorsSceneHover | null) => void;
  /** A press on the view: the marker pressed, or null for none. */
  onPick?: (index: number | null) => void;
  /** Remove pieces: a press on the model, the triangle pressed (null: none). */
  onPickSurface?: (triangle: number | null) => void;
  /** The model's bounds drawn as a box. */
  bounds?: boolean;
}): FloorsScene {
  const { container, model, markers } = options;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x161a20);
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 20000);

  // The model, from its 16-bit corners.
  const steps = fromBase64(model.positions);
  const corners = new Uint16Array(steps.buffer, steps.byteOffset, Math.floor(steps.byteLength / 2));
  const positions = new Float32Array(corners.length);
  const span = [0, 1, 2].map((k) => model.max[k]! - model.min[k]!);
  for (let i = 0; i < corners.length; i += 3) {
    positions[i] = model.min[0] + (corners[i]! / 65535) * span[0]!;
    positions[i + 1] = model.min[1] + (corners[i + 1]! / 65535) * span[1]!;
    positions[i + 2] = -(model.min[2] + (corners[i + 2]! / 65535) * span[2]!);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const vertexFloors = new Float32Array(positions.length / 3).fill(255);
  const floorAttribute = new THREE.BufferAttribute(vertexFloors, 1);
  geometry.setAttribute('floorIndex', floorAttribute);
  let shownFloors: Uint8Array | null = null;
  // Each triangle's own colour, given as sRGB bytes (drawn as they are: the view does no colour conversion).
  const own = new Float32Array(positions.length).fill(0.75);
  if (model.colours) {
    const bytes = fromBase64(model.colours);
    for (let t = 0; t < own.length / 9 && t * 3 + 2 < bytes.length; t++) {
      for (let corner = 0; corner < 3; corner++) {
        for (let k = 0; k < 3; k++) own[t * 9 + corner * 3 + k] = bytes[t * 3 + k]! / 255;
      }
    }
  }
  geometry.setAttribute('ownColour', new THREE.BufferAttribute(own, 3));
  const vertexMarks = new Float32Array(positions.length / 3);
  const markAttribute = new THREE.BufferAttribute(vertexMarks, 1);
  geometry.setAttribute('mark', markAttribute);
  let shownMarks: Uint8Array | null = null;
  let picking = false;
  geometry.computeBoundingBox();
  const box =
    geometry.boundingBox ?? new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const reach = Math.max(size.x, size.y, size.z, 10);
  camera.near = reach / 2000;
  camera.far = reach * 20;

  const colours = Array.from({ length: MAX_CUTS + 1 }, (_, i) => new THREE.Color(floorColour(i)));
  const modelMaterial = new THREE.ShaderMaterial({
    vertexShader: MODEL_VERTEX,
    fragmentShader: MODEL_FRAGMENT,
    side: THREE.DoubleSide,
    // Behind the outlines drawn on it.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    uniforms: {
      cuts: { value: new Array<number>(MAX_CUTS).fill(0) },
      cutCount: { value: 0 },
      colours: { value: colours },
      selected: { value: 0 },
      clipTop: { value: 1e9 },
      lightDir: { value: new THREE.Vector3(0.45, 0.8, 0.35).normalize() },
      byTriangle: { value: 0 },
      hideFloorsAbove: { value: 0 },
      byOwnColour: { value: 0 },
    },
  });
  const modelMesh = new THREE.Mesh(geometry, modelMaterial);
  scene.add(modelMesh);
  const raycaster = new THREE.Raycaster();
  const boundsBox = options.bounds ? new THREE.Box3Helper(box.clone(), 0xf6ecc8) : null;
  if (boundsBox) scene.add(boundsBox);

  // The outlines, worked out the first time they are asked for.
  const edgeMaterial = new THREE.ShaderMaterial({
    vertexShader: EDGE_VERTEX,
    fragmentShader: EDGE_FRAGMENT,
    transparent: true,
    uniforms: { clipTop: { value: 1e9 } },
  });
  let edges: THREE.LineSegments | null = null;
  const showEdges = (shown: boolean) => {
    if (shown && !edges) {
      edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 35), edgeMaterial);
      scene.add(edges);
    }
    if (edges) edges.visible = shown;
  };

  // The markers, a little above where they stand, drawn twice: plainly, and faintly through what hides them.
  const dotPositions = new Float32Array(markers.length * 3);
  const dotColours = new Float32Array(markers.length * 3);
  const dotLooks = new Float32Array(markers.length);
  markers.forEach((marker, i) => {
    dotPositions.set([marker.x, marker.y + 0.4, -marker.z], i * 3);
    const colour = new THREE.Color(marker.colour);
    dotColours.set([colour.r, colour.g, colour.b], i * 3);
  });
  const dotGeometry = new THREE.BufferGeometry();
  dotGeometry.setAttribute('position', new THREE.BufferAttribute(dotPositions, 3));
  dotGeometry.setAttribute('dotColor', new THREE.BufferAttribute(dotColours, 3));
  const lookAttribute = new THREE.BufferAttribute(dotLooks, 1);
  dotGeometry.setAttribute('look', lookAttribute);
  const dotMaterial = (opacity: number, depthTest: boolean) =>
    new THREE.ShaderMaterial({
      vertexShader: DOT_VERTEX,
      fragmentShader: DOT_FRAGMENT,
      transparent: opacity < 1,
      depthTest,
      depthWrite: false,
      uniforms: {
        size: { value: DOT_SIZE },
        pixelRatio: { value: renderer.getPixelRatio() },
        clipTop: { value: 1e9 },
        opacity: { value: opacity },
      },
    });
  const dots = [dotMaterial(1, true), dotMaterial(0.4, false)].map((material, i) => {
    const points = new THREE.Points(dotGeometry, material);
    points.renderOrder = 2 + i;
    points.frustumCulled = false;
    scene.add(points);
    return points;
  });

  // The overlapping places of automatic passages: large dots, made again when they change.
  const placeMaterials = [dotMaterial(1, true), dotMaterial(0.45, false)];
  for (const material of placeMaterials) material.uniforms.size!.value = DOT_SIZE * 1.6;
  const placePoints = placeMaterials.map((material, i) => {
    const points = new THREE.Points(new THREE.BufferGeometry(), material);
    points.renderOrder = 4 + i;
    points.frustumCulled = false;
    scene.add(points);
    return points;
  });
  let shownPlaces = '';
  const makePlaces = (places: FloorsSceneState['places']) => {
    const list = places ?? [];
    const key = JSON.stringify(list);
    if (key === shownPlaces) return;
    shownPlaces = key;
    const at = new Float32Array(list.length * 3);
    const colour = new Float32Array(list.length * 3);
    const look = new Float32Array(list.length);
    list.forEach((place, i) => {
      at.set([place.x, place.y + 0.8, -place.z], i * 3);
      colour.set(place.chosen ? [1, 0.84, 0.3] : [0.95, 0.95, 0.95], i * 3);
      look[i] = 2;
    });
    const made = new THREE.BufferGeometry();
    made.setAttribute('position', new THREE.BufferAttribute(at, 3));
    made.setAttribute('dotColor', new THREE.BufferAttribute(colour, 3));
    made.setAttribute('look', new THREE.BufferAttribute(look, 1));
    for (const points of placePoints) {
      points.geometry.dispose();
      points.geometry = made;
    }
  };

  // The cuts' planes, made again when the cuts change.
  const planes = new THREE.Group();
  scene.add(planes);
  const planeGeometry = new THREE.PlaneGeometry(size.x * 1.08 + 2, size.z * 1.08 + 2);
  planeGeometry.rotateX(-Math.PI / 2);
  const edgeGeometry = new THREE.EdgesGeometry(planeGeometry);
  let shownCuts = '';
  const makePlanes = (cuts: readonly number[], clipTop: number) => {
    const key = `${cuts.join()}|${clipTop}`;
    if (key === shownCuts) return;
    shownCuts = key;
    for (const child of [...planes.children]) {
      planes.remove(child);
      const material = (child as THREE.Mesh).material as THREE.Material;
      material.dispose();
    }
    cuts.forEach((cut, i) => {
      if (cut >= clipTop - 1e-3) return;
      const colour = new THREE.Color(floorColour(i + 1));
      const plane = new THREE.Mesh(
        planeGeometry,
        new THREE.MeshBasicMaterial({
          color: colour,
          transparent: true,
          opacity: 0.17,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      plane.position.set(centre.x, cut, centre.z);
      plane.renderOrder = 1;
      const edge = new THREE.LineSegments(
        edgeGeometry,
        new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.85 }),
      );
      edge.position.copy(plane.position);
      planes.add(plane, edge);
    });
  };

  const controls = new OrbitControls(camera, canvas);
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  controls.minDistance = reach / 200;
  controls.maxDistance = reach * 6;

  let frame = 0;
  let disposed = false;
  let screen: { x: number; y: number }[] = [];
  let visible: boolean[] = markers.map(() => true);
  const draw = () => {
    frame = 0;
    renderer.render(scene, camera);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const point = new THREE.Vector3();
    screen = markers.map((marker) => {
      point.set(marker.x, marker.y + 0.4, -marker.z).project(camera);
      return point.z > 1
        ? { x: -1e6, y: -1e6 }
        : { x: ((point.x + 1) / 2) * width, y: ((1 - point.y) / 2) * height };
    });
  };
  const render = () => {
    if (frame === 0 && !disposed) frame = requestAnimationFrame(draw);
  };
  controls.addEventListener('change', render);
  // A flight, stopped by any move by hand.
  let flight: {
    from: { target: THREE.Vector3; offset: THREE.Spherical };
    to: { target: THREE.Vector3; offset: THREE.Spherical };
    start: number;
  } | null = null;
  let flightFrame = 0;
  controls.addEventListener('start', () => {
    flight = null;
  });

  const resetView = () => {
    controls.target.copy(centre);
    const distance = reach * 1.15;
    // From the south-east, looking down a little.
    const offset = new THREE.Vector3().setFromSpherical(
      new THREE.Spherical(distance, THREE.MathUtils.degToRad(58), THREE.MathUtils.degToRad(35)),
    );
    camera.position.copy(centre).add(offset);
    camera.lookAt(centre);
    controls.update();
    render();
  };

  const resize = () => {
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  resetView();

  const onMove = (event: PointerEvent) => {
    if (event.buttons !== 0) {
      options.onHover(null);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best = -1;
    let bestDistance = HOVER_REACH;
    screen.forEach((p, i) => {
      if (!visible[i]) return;
      const distance = Math.hypot(p.x - x, p.y - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    if (best < 0) {
      options.onHover(null);
      return;
    }
    const at = screen[best]!;
    options.onHover({
      index: best,
      x: at.x,
      y: at.y,
      across: at.x / Math.max(rect.width, 1),
      down: at.y / Math.max(rect.height, 1),
    });
  };
  const onLeave = () => {
    options.onHover(null);
  };
  // Remove pieces: the triangle under a point of the view, the nearest not cut away above the view's cut.
  const surfaceAt = (x: number, y: number, rect: DOMRect): number | null => {
    const pointer = new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const top = modelMaterial.uniforms.clipTop!.value as number;
    const hit = raycaster
      .intersectObject(modelMesh, false)
      .find((found) => found.point.y <= top && found.faceIndex !== undefined);
    return hit?.faceIndex ?? null;
  };
  // A press (not a drag): the nearest marker shown within reach.
  let down: { x: number; y: number; id: number } | null = null;
  const onDown = (event: PointerEvent) => {
    down = event.button === 0 ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
  };
  const onUp = (event: PointerEvent) => {
    const press = down;
    down = null;
    if (press?.id !== event.pointerId || !(options.onPick ?? options.onPickSurface)) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (picking && options.onPickSurface) {
      options.onPickSurface(surfaceAt(x, y, rect));
      return;
    }
    const reach = event.pointerType === 'mouse' ? HOVER_REACH : HOVER_REACH * 2;
    if (!options.onPick) return;
    let best: number | null = null;
    let bestDistance = reach;
    screen.forEach((p, i) => {
      if (!visible[i]) return;
      const distance = Math.hypot(p.x - x, p.y - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    options.onPick(best);
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);

  const turn = (around: number, up: number) => {
    if (disposed) return;
    const offset = camera.position.clone().sub(controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta += around;
    spherical.phi = THREE.MathUtils.clamp(spherical.phi + up, 0.02, Math.PI - 0.02);
    offset.setFromSpherical(spherical);
    camera.position.copy(controls.target).add(offset);
    camera.lookAt(controls.target);
    controls.update();
    render();
  };
  const zoom = (factor: number) => {
    if (disposed) return;
    const offset = camera.position.clone().sub(controls.target);
    const length = THREE.MathUtils.clamp(
      offset.length() * factor,
      controls.minDistance,
      controls.maxDistance,
    );
    camera.position.copy(controls.target).add(offset.setLength(length));
    controls.update();
    render();
  };

  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const FLY_MS = 700;
  const fly = (now: number) => {
    flightFrame = 0;
    if (!flight || disposed) return;
    const t = Math.min(1, (now - flight.start) / FLY_MS);
    const k = ease(t);
    const { from, to } = flight;
    let turn = to.offset.theta - from.offset.theta;
    turn = ((((turn + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
    const offset = new THREE.Spherical(
      from.offset.radius * (to.offset.radius / from.offset.radius) ** k,
      from.offset.phi + (to.offset.phi - from.offset.phi) * k,
      from.offset.theta + turn * k,
    );
    controls.target.copy(from.target).lerp(to.target, k);
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(offset));
    camera.lookAt(controls.target);
    controls.update();
    render();
    if (t >= 1) flight = null;
    else flightFrame = requestAnimationFrame(fly);
  };
  const goTo = (index: number) => {
    const marker = markers[index];
    if (!marker || disposed) return;
    const from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    // About 26 m above it (less in a small area), tilted by 10°, facing the way the view faces.
    const distance = THREE.MathUtils.clamp(
      26 / Math.cos(THREE.MathUtils.degToRad(10)),
      controls.minDistance,
      Math.max(controls.minDistance, reach * 0.6),
    );
    const to = new THREE.Spherical(distance, THREE.MathUtils.degToRad(10), from.theta);
    const target = new THREE.Vector3(marker.x, marker.y + 0.4, -marker.z);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      flight = null;
      controls.target.copy(target);
      camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(to));
      camera.lookAt(target);
      controls.update();
      render();
      return;
    }
    flight = {
      from: { target: controls.target.clone(), offset: from },
      to: { target, offset: to },
      start: performance.now(),
    };
    if (flightFrame === 0) flightFrame = requestAnimationFrame(fly);
  };

  return {
    goTo,
    update(state) {
      if (disposed) return;
      const cuts = state.cuts.slice(0, MAX_CUTS);
      const uniforms = modelMaterial.uniforms;
      const values = uniforms.cuts!.value as number[];
      values.fill(0);
      cuts.forEach((cut, i) => (values[i] = cut));
      uniforms.cutCount!.value = cuts.length;
      uniforms.selected!.value = state.selected;
      const byTriangle = Boolean(state.triangleFloors);
      if (state.triangleFloors && state.triangleFloors !== shownFloors) {
        shownFloors = state.triangleFloors;
        const floors = state.triangleFloors;
        for (let t = 0; t < vertexFloors.length / 3; t++) {
          const value = floors[t] ?? 255;
          vertexFloors[t * 3] = value;
          vertexFloors[t * 3 + 1] = value;
          vertexFloors[t * 3 + 2] = value;
        }
        floorAttribute.needsUpdate = true;
      }
      picking = state.picking ?? false;
      canvas.style.cursor = picking ? 'crosshair' : '';
      const marks = state.marks ?? null;
      if (marks !== shownMarks) {
        shownMarks = marks;
        for (let t = 0; t < vertexMarks.length / 3; t++) {
          const value = marks?.[t] ?? 0;
          vertexMarks[t * 3] = value;
          vertexMarks[t * 3 + 1] = value;
          vertexMarks[t * 3 + 2] = value;
        }
        markAttribute.needsUpdate = true;
      }
      uniforms.byTriangle!.value = byTriangle ? 1 : 0;
      uniforms.byOwnColour!.value = state.ownColours && model.colours ? 1 : 0;
      uniforms.hideFloorsAbove!.value = byTriangle && state.hideAbove ? 1 : 0;
      const floorTop = byTriangle
        ? state.hideAbove && state.clipHeight !== null && state.clipHeight !== undefined
          ? state.clipHeight
          : 1e9
        : state.hideAbove && state.selected < cuts.length
          ? cuts[state.selected]!
          : 1e9;
      const cutAt = state.cutAt ?? null;
      const clipTop = cutAt ?? floorTop;
      uniforms.clipTop!.value = clipTop;
      edgeMaterial.uniforms.clipTop!.value = clipTop;
      showEdges(state.outlines);
      for (const points of dots) {
        points.material.uniforms.clipTop!.value = clipTop;
        points.visible = state.showMarkers;
      }
      for (let i = 0; i < markers.length; i++) dotLooks[i] = state.looks[i] ?? 0;
      lookAttribute.needsUpdate = true;
      visible = markers.map((marker) => state.showMarkers && marker.y + 0.4 <= clipTop);
      makePlanes(byTriangle ? [] : cuts, clipTop);
      makePlaces(byTriangle ? state.places : []);
      for (const points of placePoints) points.material.uniforms.clipTop!.value = 1e9;
      render();
    },
    resetView,
    turn,
    zoom,
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      if (flightFrame) cancelAnimationFrame(flightFrame);
      observer.disconnect();
      controls.dispose();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      for (const child of planes.children)
        ((child as THREE.Mesh).material as THREE.Material).dispose();
      planeGeometry.dispose();
      edgeGeometry.dispose();
      geometry.dispose();
      boundsBox?.geometry.dispose();
      (boundsBox?.material as THREE.Material | undefined)?.dispose();
      dotGeometry.dispose();
      modelMaterial.dispose();
      edges?.geometry.dispose();
      edgeMaterial.dispose();
      for (const points of dots) points.material.dispose();
      for (const points of placePoints) {
        points.geometry.dispose();
        points.material.dispose();
      }
      renderer.dispose();
      canvas.remove();
    },
  };
}
