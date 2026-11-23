import {
  cellBox,
  MAX_BIAS,
  nextBias,
  nextTextureBias,
  planCells,
  type PlanCell,
  type SceneBudget,
  type SceneFrame,
} from '@atlas/core';
import type { Scene, SceneCell } from '@atlas/schema';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { modelLoader, type ModelLoader } from './loader';

/**
 * The 3D view of a map: its model, loaded cell by cell as the camera moves
 * (near cells finely, far ones coarsely, within the device's budget; see
 * `planCells` in `@atlas/core`), lit by the sky, the sun and a light at the
 * camera, without shadows; the locations as dots of their type's colour,
 * drawn together in one buffer, seen through walls (dimmer when hidden);
 * the open route as a line. Floors and the height cut are clipping planes.
 *
 * It draws only when something changed: the camera, a cell, the dots.
 */

/** A location drawn as a dot. */
export interface SceneDot {
  id: string;
  /** Map pixel. */
  px: number;
  py: number;
  /** Its height, or null to put it on what lies below `top`. */
  height: number | null;
  /** The top of its floor, where it has one: a dot without height is put on what lies below. */
  top: number | null;
  /** `#rrggbb`. */
  color: string;
  /** Found: drawn faded, as on the 2D map. */
  muted: boolean;
}

export interface SceneHover {
  id: string;
  /** In the view's box, in CSS pixels. */
  x: number;
  y: number;
}

export interface SceneStatus {
  cells: number;
  loading: number;
  failed: number;
  triangles: number;
  textureBytes: number;
  bias: number;
  dots: number;
}

export interface SceneEvents {
  pick(id: string | null): void;
  longPress(id: string): void;
  menu(id: string): void;
  hover(hover: SceneHover | null): void;
  status(status: SceneStatus): void;
  /** The view cannot go on (the context was lost for good). */
  failed(): void;
  /** The view has come to rest after moving or changing. */
  settled?(): void;
}

export interface SceneEngineOptions {
  container: HTMLElement;
  scene: Scene;
  frame: SceneFrame;
  resolveUrl(file: string): string;
  budget: SceneBudget;
  /** Made for fingers: larger dots and wider presses. */
  fingers: boolean;
  dark: boolean;
  events: SceneEvents;
}

interface Loaded {
  level: number;
  group: THREE.Group;
  meshes: THREE.Mesh[];
  triangles: number;
  textureBytes: number;
}

interface CellState {
  cell: SceneCell;
  plan: PlanCell;
  loaded: Loaded | null;
  loading: number | null;
  failed: Set<number>;
}

interface ViewPose {
  target: THREE.Vector3;
  distance: number;
  azimuth: number;
  polar: number;
}

interface Flight {
  from: ViewPose;
  to: ViewPose;
  start: number;
  ms: number;
}

const DOT_SIZE = 13;
const DOT_SIZE_FINGERS = 16;
const DOT_LIFT = 0.6;
const HIDDEN_OPACITY = 0.38;
const PRESS_MOVE = 6;
const LONG_PRESS_MS = 550;
const PLAN_MS = 250;
const BIAS_MS = 1500;
/** Polar angle of "View from above": straight down (exactly 0 has no way round). */
const FROM_ABOVE = 1e-4;
const DEFAULT_SKY = '#a9c4dc';

const DOT_VERTEX = /* glsl */ `
attribute vec3 dotColor;
attribute float dotState;
uniform float size;
uniform float pixelRatio;
varying vec3 vColor;
varying float vState;
void main() {
  vColor = dotColor;
  vState = dotState;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = (dotState > 1.5 ? size * 1.6 : size) * pixelRatio;
}
`;

const DOT_FRAGMENT = /* glsl */ `
uniform float opacity;
uniform vec3 outline;
uniform vec3 ring;
varying vec3 vColor;
varying float vState;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float aa = max(fwidth(r), 0.02);
  vec3 fill = vColor;
  float alpha = opacity;
  if (vState > 0.5 && vState < 1.5) {
    fill = mix(fill, vec3(0.56, 0.58, 0.61), 0.6);
    alpha *= 0.6;
  }
  float border = vState > 1.5 ? 0.62 : 0.7;
  vec3 edge = vState > 1.5 ? ring : outline;
  vec3 colour = mix(fill, edge, smoothstep(border - aa, border + aa, r));
  alpha *= 1.0 - smoothstep(1.0 - aa * 1.5, 1.0, r);
  gl_FragColor = vec4(colour, alpha);
}
`;

function rgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const value = match ? parseInt(match[1]!, 16) : 0xcccccc;
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function mix(a: string, b: string, t: number): THREE.Color {
  return new THREE.Color(a).lerp(new THREE.Color(b), t);
}

function trianglesOf(geometry: THREE.BufferGeometry): number {
  const count = geometry.index ? geometry.index.count : (geometry.attributes.position?.count ?? 0);
  return Math.floor(count / 3);
}

function textureBytesOf(texture: THREE.Texture): number {
  const mipmaps = (texture as THREE.CompressedTexture).mipmaps as { data?: ArrayBufferView }[];
  if (texture instanceof THREE.CompressedTexture && Array.isArray(mipmaps)) {
    return mipmaps.reduce((sum, mip) => sum + (mip.data?.byteLength ?? 0), 0);
  }
  const image = texture.image as { width?: number; height?: number } | null;
  return Math.round((image?.width ?? 0) * (image?.height ?? 0) * 4 * (4 / 3));
}

/** A plain material in place of the model's: lit by the hemisphere, the sun and the camera's light. */
function lambertOf(material: THREE.Material): THREE.MeshLambertMaterial {
  // Any material of a model: some have no texture or glow.
  const source = material as Partial<THREE.MeshStandardMaterial> & THREE.Material;
  const out = new THREE.MeshLambertMaterial({
    color: source.color ?? new THREE.Color(0xffffff),
    map: source.map ?? null,
    emissive: source.emissive ?? new THREE.Color(0),
    emissiveMap: source.emissiveMap ?? null,
    vertexColors: source.vertexColors,
    // Both sides: where a cut opens the model, its inside shows dark rather than see-through.
    side: THREE.DoubleSide,
    transparent: source.transparent,
    opacity: source.opacity,
    alphaTest: source.alphaTest,
  });
  out.name = source.name;
  return out;
}

/**
 * The meshes of a loaded model, merged into one per material (and set of
 * attributes): a cell is drawn in a few calls, whatever its file holds.
 */
function mergeByMaterial(root: THREE.Object3D): Loaded {
  root.updateMatrixWorld(true);
  const groups = new Map<string, { material: THREE.Material; parts: THREE.BufferGeometry[] }>();
  const sources = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry as THREE.BufferGeometry;
    const material = (Array.isArray(object.material) ? object.material[0] : object.material) as
      THREE.Material | undefined;
    sources.add(geometry);
    if (!material) return;
    materials.add(material);
    const part = geometry.clone();
    part.clearGroups();
    part.applyMatrix4(object.matrixWorld);
    part.morphAttributes = {};
    const key = [
      material.uuid,
      part.index ? 'i' : 'n',
      ...Object.keys(part.attributes).sort(),
    ].join('|');
    let group = groups.get(key);
    if (!group) {
      group = { material, parts: [] };
      groups.set(key, group);
    }
    group.parts.push(part);
  });
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  const textures = new Set<THREE.Texture>();
  const lamberts = new Map<THREE.Material, THREE.MeshLambertMaterial>();
  let triangles = 0;
  for (const { material, parts } of groups.values()) {
    // Null when the parts cannot be merged after all: they are drawn apart.
    const merged = (
      parts.length === 1 ? parts[0]! : mergeGeometries(parts, false)
    ) as THREE.BufferGeometry | null;
    const geometries = merged ? [merged] : parts;
    if (merged && parts.length > 1) {
      for (const part of parts) part.dispose();
    }
    let lambert = lamberts.get(material);
    if (!lambert) {
      lambert = lambertOf(material);
      lamberts.set(material, lambert);
      if (lambert.map) textures.add(lambert.map);
      if (lambert.emissiveMap) textures.add(lambert.emissiveMap);
    }
    for (const geometry of geometries) {
      geometry.computeBoundingSphere();
      triangles += trianglesOf(geometry);
      const mesh = new THREE.Mesh(geometry, lambert);
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      meshes.push(mesh);
    }
  }
  for (const geometry of sources) geometry.dispose();
  for (const material of materials) material.dispose();
  let textureBytes = 0;
  textures.forEach((texture) => (textureBytes += textureBytesOf(texture)));
  return { level: -1, group, meshes, triangles, textureBytes };
}

function disposeLoaded(loaded: Loaded): void {
  const materials = new Set<THREE.MeshLambertMaterial>();
  for (const mesh of loaded.meshes) {
    mesh.geometry.dispose();
    materials.add(mesh.material as THREE.MeshLambertMaterial);
  }
  for (const material of materials) {
    material.map?.dispose();
    material.emissiveMap?.dispose();
    material.dispose();
  }
  loaded.group.removeFromParent();
}

function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export class SceneEngine {
  readonly canvas: HTMLCanvasElement;
  private readonly options: SceneEngineOptions;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly world = new THREE.Scene();
  private readonly model = new THREE.Group();
  private readonly loader: ModelLoader;
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly headlight: THREE.DirectionalLight;
  private water: THREE.Mesh | null = null;
  private readonly cells: CellState[];
  private readonly extent: { center: THREE.Vector3; size: number; side: number };
  private readonly start: ViewPose;
  private readonly raycaster = new THREE.Raycaster();
  private readonly resize: ResizeObserver;
  private readonly cleanups: (() => void)[] = [];
  private neighbours: Loaded | null = null;
  private dots: SceneDot[] = [];
  private dotPositions: THREE.Vector3[] = [];
  private dotShown: boolean[] = [];
  private readonly dotGeometry = new THREE.BufferGeometry();
  private readonly dotHidden: THREE.ShaderMaterial;
  private readonly dotSeen: THREE.ShaderMaterial;
  private selected: string | null = null;
  private route: { lines: (readonly { x: number; y: number }[])[]; color: string } | null = null;
  private routeLine: THREE.LineSegments | null = null;
  private topCut: number | null = null;
  private towardCamera = false;
  private dark = true;
  private readonly planes = {
    top: new THREE.Plane(new THREE.Vector3(0, -1, 0), 0),
    camera: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
  };
  private flight: Flight | null = null;
  private frameId = 0;
  private dirty = true;
  private planDue = 0;
  private biasDue = 0;
  private bias = 0;
  private textureBias = 0;
  private frameTimes: number[] = [];
  private lastFrame = 0;
  private lost = false;
  private lostTimer = 0;
  private disposed = false;
  private hovered: string | null = null;
  private width = 1;
  private height = 1;

  constructor(options: SceneEngineOptions) {
    this.options = options;
    const { container, scene, frame, budget } = options;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'scene-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', '3D view of the map');
    // Throws where WebGL 2 cannot be had; the caller stays in 2D.
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, budget.maxPixelRatio));
    container.append(this.canvas);
    this.loader = modelLoader(this.renderer);

    // The model's square on the ground, its heights, and where the view starts.
    const boxes = scene.cells.map((cell) => cellBox(frame, cell.bounds));
    const minX = Math.min(...boxes.map((b) => b[0]));
    const minZ = Math.min(...boxes.map((b) => b[1]));
    const maxX = Math.max(...boxes.map((b) => b[2]));
    const maxZ = Math.max(...boxes.map((b) => b[3]));
    const [low, high] = scene.heights ?? [0, 0];
    const size = Math.max(maxX - minX, maxZ - minZ, 1);
    const side = Math.max(...boxes.map((b) => Math.max(b[2] - b[0], b[3] - b[1])), 1);
    this.extent = {
      center: new THREE.Vector3((minX + maxX) / 2, (low + high) / 2, (minZ + maxZ) / 2),
      size,
      side,
    };
    this.cells = scene.cells.map((cell, i) => ({
      cell,
      plan: {
        id: cell.id,
        box: boxes[i]!,
        heights: cell.heights,
        levels: cell.lods.map((lod) => ({ level: lod.level, triangles: lod.triangles })),
      },
      loaded: null,
      loading: null,
      failed: new Set(),
    }));
    if (scene.camera) {
      const [x, y, h] = scene.camera.target;
      this.start = {
        target: new THREE.Vector3(...frame.fromWorld(x, y, h)),
        distance: scene.camera.distance,
        azimuth: (-scene.camera.yaw * Math.PI) / 180,
        polar: Math.max(FROM_ABOVE, ((90 - scene.camera.pitch) * Math.PI) / 180),
      };
    } else {
      this.start = {
        target: this.extent.center.clone(),
        distance: size * 0.9,
        azimuth: 0,
        polar: (50 * Math.PI) / 180,
      };
    }

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, size * 10);
    this.world.add(this.camera);
    this.model.matrixAutoUpdate = false;
    this.model.matrix.fromArray(frame.modelMatrix);
    this.model.matrixWorldNeedsUpdate = true;
    this.world.add(this.model);

    // Light: the sky and the ground, the sun, and a light where the camera is.
    this.hemisphere = new THREE.HemisphereLight(0xe4eef8, 0x5a5242, 1.1);
    this.world.add(this.hemisphere);
    this.sun = new THREE.DirectionalLight(0xfff3df, 1.6);
    this.sun.position.set(-0.55, 1, -0.35);
    this.world.add(this.sun);
    this.headlight = new THREE.DirectionalLight(0xffffff, 0.35);
    this.headlight.position.set(0, 0, 0);
    this.camera.add(this.headlight);
    this.camera.add(this.headlight.target);
    this.headlight.target.position.set(0, 0, -1);

    if (scene.water !== undefined) {
      const plane = new THREE.PlaneGeometry(size * 4, size * 4);
      plane.rotateX(-Math.PI / 2);
      const water = new THREE.Mesh(
        plane,
        new THREE.MeshLambertMaterial({
          color: 0x3d7ea6,
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
        }),
      );
      water.position.set(this.extent.center.x, scene.water, this.extent.center.z);
      water.renderOrder = 1;
      this.world.add(water);
      this.water = water;
    }

    // The dots: one buffer, drawn twice: dim through what hides them, then
    // in full where nothing does.
    const dotMaterial = (opacity: number, depthTest: boolean) =>
      new THREE.ShaderMaterial({
        vertexShader: DOT_VERTEX,
        fragmentShader: DOT_FRAGMENT,
        uniforms: {
          size: { value: options.fingers ? DOT_SIZE_FINGERS : DOT_SIZE },
          pixelRatio: { value: this.renderer.getPixelRatio() },
          opacity: { value: opacity },
          outline: { value: new THREE.Vector3(0.05, 0.06, 0.08) },
          ring: { value: new THREE.Vector3(1, 1, 1) },
        },
        transparent: true,
        depthTest,
        depthWrite: false,
      });
    this.dotHidden = dotMaterial(HIDDEN_OPACITY, false);
    this.dotSeen = dotMaterial(1, true);
    const hiddenPoints = new THREE.Points(this.dotGeometry, this.dotHidden);
    const seenPoints = new THREE.Points(this.dotGeometry, this.dotSeen);
    hiddenPoints.frustumCulled = false;
    seenPoints.frustumCulled = false;
    hiddenPoints.renderOrder = 10;
    seenPoints.renderOrder = 11;
    this.world.add(hiddenPoints, seenPoints);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.14;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = Math.max(1, side * 0.02);
    this.controls.maxDistance = size * 3;
    this.controls.zoomToCursor = !options.fingers;
    // As the 2D map: drag to move; the right button (or two fingers) turns.
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    const onChange = () => {
      this.dirty = true;
    };
    this.controls.addEventListener('change', onChange);
    this.cleanups.push(() => {
      this.controls.removeEventListener('change', onChange);
    });
    this.setPose(this.start);

    this.setTheme(options.dark);
    this.listen();
    this.resize = new ResizeObserver(() => {
      this.fit();
    });
    this.resize.observe(container);
    this.fit();
    if (scene.neighbours) void this.loadNeighbours(scene.neighbours);
    this.frameId = requestAnimationFrame(this.tick);
  }

  // -------------------------------------------------------------------------
  // What is shown

  setDots(dots: readonly SceneDot[]): void {
    this.dots = [...dots];
    this.placeDots();
  }

  setSelected(id: string | null): void {
    if (id === this.selected) return;
    this.selected = id;
    this.writeDotStates();
  }

  /** Cuts away what is above a height (a floor's top or the free cut), and what is toward the camera. */
  setCut(top: number | null, towardCamera: boolean): void {
    this.topCut = top;
    this.towardCamera = towardCamera;
    this.updatePlanes();
    this.paintSky();
    this.writeDotStates();
  }

  setTheme(dark: boolean): void {
    this.dark = dark;
    this.paintSky();
    this.hemisphere.intensity = dark ? 0.95 : 1.1;
    this.sun.intensity = dark ? 1.35 : 1.6;
    const accent = rgb(
      getComputedStyle(this.options.container).getPropertyValue('--atlas-selection') || '#ffffff',
    );
    for (const material of [this.dotHidden, this.dotSeen]) {
      (material.uniforms.ring!.value as THREE.Vector3).set(...accent);
    }
    this.dirty = true;
  }

  /** The open route on this map, as lines of map pixels; null for none. */
  setRoute(route: { lines: (readonly { x: number; y: number }[])[]; color: string } | null): void {
    this.route = route;
    this.drawRoute();
  }

  /**
   * The sky, or under a height cut a plain grey: what shows through where
   * the cut opens the ground is then plainly cut away, not sky or water.
   */
  private paintSky(): void {
    const sky = this.options.scene.sky ?? DEFAULT_SKY;
    const cut = this.topCut !== null;
    const background = cut
      ? new THREE.Color(this.dark ? '#20252c' : '#9a9fa6')
      : this.dark
        ? mix(sky, '#0e1115', 0.62)
        : new THREE.Color(sky);
    this.world.background = background;
    const fog = this.dark ? mix(sky, '#0e1115', 0.62) : new THREE.Color(sky);
    this.world.fog = new THREE.Fog(fog, this.extent.size * 1.4, this.extent.size * 4.5);
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Moving

  /** Moves by screen pixels and zooms by levels (1 is twice as near). */
  nudge(dx: number, dy: number, dz: number): void {
    this.flight = null;
    if (dx !== 0 || dy !== 0) this.controls.pan(-dx, -dy);
    if (dz !== 0) this.controls.dollyIn(2 ** -dz);
    this.dirty = true;
  }

  /** Turns round the point looked at, and tilts, in radians (as dragging with the right button). */
  turn(yaw: number, pitch: number): void {
    this.flight = null;
    if (yaw !== 0) this.controls.rotateLeft(yaw);
    if (pitch !== 0) this.controls.rotateUp(pitch);
    this.dirty = true;
  }

  /** Looks straight down at the point looked at, north up: the 2D map, in 3D. */
  fromAbove(): void {
    const pose = this.pose();
    this.fly({ ...pose, azimuth: 0, polar: FROM_ABOVE }, 650);
  }

  /** Back to where the view started. */
  recenter(): void {
    this.fly(this.start, 800);
  }

  /** Moves the point looked at to a dot, keeping the angle; near enough to see it. */
  lookAt(id: string, closer = false): boolean {
    const index = this.dots.findIndex((dot) => dot.id === id);
    if (index < 0) return false;
    const pose = this.pose();
    const distance = closer
      ? Math.min(Math.max(pose.distance, this.extent.side * 0.35), this.extent.side * 1.1)
      : pose.distance;
    this.fly({ ...pose, target: this.dotPositions[index]!.clone(), distance }, closer ? 700 : 260);
    return true;
  }

  /** Moves the point looked at to a map pixel, on the ground. */
  lookAtPixel(px: number, py: number): void {
    const [x, , z] = this.options.frame.fromPixel(px, py, 0);
    const pose = this.pose();
    this.fly({ ...pose, target: new THREE.Vector3(x, this.groundAt(x, z, null), z) }, 700);
  }

  /** The dots drawn and in front of the camera, with where each is in the view's box. */
  onScreen(): { ids: string[]; points: { x: number; y: number }[] } {
    const ids: string[] = [];
    const points: { x: number; y: number }[] = [];
    const v = new THREE.Vector3();
    this.dots.forEach((dot, i) => {
      if (!this.dotShown[i]) return;
      v.copy(this.dotPositions[i]!).project(this.camera);
      if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return;
      ids.push(dot.id);
      points.push({ x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height });
    });
    return { ids, points };
  }

  status(): SceneStatus {
    let triangles = 0;
    let textureBytes = 0;
    let cells = 0;
    let loading = 0;
    let failed = 0;
    for (const state of this.cells) {
      if (state.loaded) {
        cells++;
        triangles += state.loaded.triangles;
        textureBytes += state.loaded.textureBytes;
      }
      if (state.loading !== null) loading++;
      failed += state.failed.size;
    }
    return {
      cells,
      loading,
      failed,
      triangles,
      textureBytes,
      bias: this.planBias(),
      dots: this.dotShown.filter(Boolean).length,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.lostTimer);
    this.resize.disconnect();
    this.cleanups.forEach((cleanup) => {
      cleanup();
    });
    this.controls.dispose();
    for (const state of this.cells) {
      if (state.loaded) disposeLoaded(state.loaded);
      state.loaded = null;
    }
    if (this.neighbours) disposeLoaded(this.neighbours);
    this.routeLine?.geometry.dispose();
    (this.routeLine?.material as THREE.Material | undefined)?.dispose();
    if (this.water) {
      this.water.geometry.dispose();
      (this.water.material as THREE.Material).dispose();
    }
    this.dotGeometry.dispose();
    this.dotHidden.dispose();
    this.dotSeen.dispose();
    this.loader.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  // -------------------------------------------------------------------------
  // Inside

  private readonly tick = (now: number): void => {
    if (this.disposed) return;
    this.frameId = requestAnimationFrame(this.tick);
    if (this.lost) return;
    if (this.flight) {
      const t = Math.min(1, (now - this.flight.start) / this.flight.ms);
      const { from, to } = this.flight;
      const k = ease(t);
      let turn = to.azimuth - from.azimuth;
      turn = ((((turn + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
      this.setPose({
        target: from.target.clone().lerp(to.target, k),
        distance: from.distance * (to.distance / from.distance) ** k,
        azimuth: from.azimuth + turn * k,
        polar: from.polar + (to.polar - from.polar) * k,
      });
      if (t >= 1) this.flight = null;
    }
    if (this.controls.update()) this.dirty = true;
    if (now >= this.planDue) {
      this.planDue = now + PLAN_MS;
      this.stream();
    }
    if (!this.dirty) {
      if (this.lastFrame > 0 && !this.flight) this.options.events.settled?.();
      this.lastFrame = 0;
      return;
    }
    this.dirty = false;
    if (this.lastFrame > 0) {
      this.frameTimes.push(now - this.lastFrame);
      if (this.frameTimes.length > 120) this.frameTimes.shift();
    }
    this.lastFrame = now;
    if (now >= this.biasDue) {
      this.biasDue = now + BIAS_MS;
      const bias = nextBias(this.bias, this.frameTimes);
      if (this.frameTimes.length >= 20) this.frameTimes = [];
      // Once the coarser cells are in, the textures may leave room for finer ones again.
      const textureBias = nextTextureBias(
        this.textureBias,
        this.status().textureBytes,
        this.options.budget,
      );
      if (bias !== this.bias || textureBias !== this.textureBias) {
        this.bias = bias;
        this.textureBias = textureBias;
        this.planDue = 0;
        this.report();
      }
    }
    this.render();
  };

  private render(): void {
    const distance = this.controls.getDistance();
    this.camera.near = Math.max(0.05, distance / 400);
    this.camera.far = Math.max(this.extent.size * 6, distance * 4);
    this.camera.updateProjectionMatrix();
    if (this.towardCamera) this.updatePlanes();
    this.renderer.render(this.world, this.camera);
  }

  private fit(): void {
    const box = this.options.container.getBoundingClientRect();
    this.width = Math.max(1, box.width);
    this.height = Math.max(1, box.height);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private pose(): ViewPose {
    return {
      target: this.controls.target.clone(),
      distance: this.controls.getDistance(),
      azimuth: this.controls.getAzimuthalAngle(),
      polar: this.controls.getPolarAngle(),
    };
  }

  private setPose(pose: ViewPose): void {
    const offset = new THREE.Vector3().setFromSpherical(
      new THREE.Spherical(pose.distance, Math.max(FROM_ABOVE, pose.polar), pose.azimuth),
    );
    this.controls.target.copy(pose.target);
    this.camera.position.copy(pose.target).add(offset);
    this.camera.lookAt(pose.target);
    this.dirty = true;
  }

  private fly(to: ViewPose, ms: number): void {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      this.flight = null;
      this.setPose(to);
      return;
    }
    this.flight = { from: this.pose(), to, start: performance.now(), ms };
    this.dirty = true;
  }

  private planBias(): number {
    return Math.min(MAX_BIAS, this.bias + this.textureBias);
  }

  /** Loads and lets go of cells for where the camera is now. */
  private stream(): void {
    const camera = this.camera.position;
    const plan = planCells(
      this.cells.map((state) => state.plan),
      [camera.x, camera.y, camera.z],
      this.options.budget,
      this.planBias(),
    );
    const wanted = new Map(plan.map((entry) => [entry.id, entry.level] as const));
    let changed = false;
    for (const state of this.cells) {
      if (state.loaded && !wanted.has(state.cell.id) && state.loading === null) {
        disposeLoaded(state.loaded);
        state.loaded = null;
        changed = true;
      }
    }
    let loading = this.cells.filter((state) => state.loading !== null).length;
    for (const entry of plan) {
      if (loading >= this.options.budget.loads) break;
      const state = this.cells.find((s) => s.cell.id === entry.id);
      if (state?.loading !== null || state.loaded?.level === entry.level) continue;
      if (state.failed.has(entry.level)) continue;
      const lod = state.cell.lods.find((l) => l.level === entry.level);
      if (!lod) continue;
      loading++;
      void this.loadCell(state, entry.level, lod.file);
    }
    if (changed) {
      this.dirty = true;
      this.report();
    }
  }

  /** Loads a cell at a level, in place of the one shown; the next plan lets go of it if unwanted. */
  private async loadCell(state: CellState, level: number, file: string): Promise<void> {
    state.loading = level;
    this.report();
    try {
      const gltf = await this.loader.load(this.options.resolveUrl(file));
      const loaded = mergeByMaterial(gltf.scene);
      loaded.level = level;
      if (this.disposed) {
        disposeLoaded(loaded);
        return;
      }
      if (state.loaded) disposeLoaded(state.loaded);
      state.loaded = loaded;
      this.model.add(loaded.group);
      loaded.group.updateMatrixWorld(true);
      this.textureBias = nextTextureBias(
        this.textureBias,
        this.status().textureBytes,
        this.options.budget,
      );
      this.placeDots(state);
      this.drawRoute();
    } catch {
      state.failed.add(level);
    } finally {
      state.loading = null;
      this.dirty = true;
      this.planDue = 0;
      this.report();
    }
  }

  private async loadNeighbours(file: string): Promise<void> {
    try {
      const gltf = await this.loader.load(this.options.resolveUrl(file));
      const loaded = mergeByMaterial(gltf.scene);
      if (this.disposed) {
        disposeLoaded(loaded);
        return;
      }
      this.neighbours = loaded;
      this.model.add(loaded.group);
      this.dirty = true;
    } catch {
      // The model's surroundings are only a backdrop.
    }
  }

  private report(): void {
    this.options.events.status(this.status());
  }

  /** The meshes loaded now, to find the ground under a point. */
  private meshes(): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const state of this.cells) if (state.loaded) meshes.push(...state.loaded.meshes);
    return meshes;
  }

  /** The height of what lies under a point of the view, below `top`; else the water or 0. */
  private groundAt(x: number, z: number, top: number | null, meshes = this.meshes()): number {
    const high = top ?? this.options.scene.heights?.[1] ?? this.extent.size;
    this.raycaster.set(new THREE.Vector3(x, high, z), new THREE.Vector3(0, -1, 0));
    this.raycaster.far = Infinity;
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (hit) return hit.point.y;
    return this.options.scene.water ?? 0;
  }

  /** Puts the dots where they belong: all of them, or those over one cell just loaded. */
  private placeDots(only?: CellState): void {
    const frame = this.options.frame;
    const meshes = this.meshes();
    if (!only || this.dotPositions.length !== this.dots.length) {
      this.dotPositions = this.dots.map((dot) => {
        const [x, , z] = frame.fromPixel(dot.px, dot.py, 0);
        const y = dot.height ?? this.groundAt(x, z, dot.top, meshes);
        return new THREE.Vector3(x, y + DOT_LIFT, z);
      });
    } else {
      const [x0, z0, x1, z1] = only.plan.box;
      this.dots.forEach((dot, i) => {
        if (dot.height !== null) return;
        const position = this.dotPositions[i]!;
        if (position.x < x0 || position.x > x1 || position.z < z0 || position.z > z1) return;
        position.y = this.groundAt(position.x, position.z, dot.top, meshes) + DOT_LIFT;
      });
    }
    const positions = new Float32Array(this.dots.length * 3);
    const colors = new Float32Array(this.dots.length * 3);
    this.dots.forEach((dot, i) => {
      const p = this.dotPositions[i]!;
      positions.set([p.x, p.y, p.z], i * 3);
      colors.set(rgb(dot.color), i * 3);
    });
    this.dotGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.dotGeometry.setAttribute('dotColor', new THREE.BufferAttribute(colors, 3));
    this.writeDotStates();
  }

  /** Each dot's state (found, selected) and whether it is shown under the cuts. */
  private writeDotStates(): void {
    const states = new Float32Array(this.dots.length);
    const top = this.topCut;
    this.dotShown = this.dots.map(
      (_, i) => top === null || this.dotPositions[i]!.y - DOT_LIFT <= top + 0.5,
    );
    this.dots.forEach((dot, i) => {
      // A dot cut away is put out of sight: a state the shader never draws.
      if (!this.dotShown[i]) states[i] = -1;
      else states[i] = dot.id === this.selected ? 2 : dot.muted ? 1 : 0;
    });
    // The selected dot is drawn last, over the others.
    const order = this.dots.map((_, i) => i);
    const selectedAt = this.dots.findIndex((dot) => dot.id === this.selected);
    if (selectedAt >= 0) {
      order.splice(selectedAt, 1);
      order.push(selectedAt);
    }
    const index = new Uint32Array(order.filter((i) => this.dotShown[i]));
    this.dotGeometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.dotGeometry.setAttribute('dotState', new THREE.BufferAttribute(states, 1));
    this.dirty = true;
  }

  private drawRoute(): void {
    if (this.routeLine) {
      this.routeLine.geometry.dispose();
      (this.routeLine.material as THREE.Material).dispose();
      this.routeLine.removeFromParent();
      this.routeLine = null;
    }
    if (!this.route) {
      this.dirty = true;
      return;
    }
    const frame = this.options.frame;
    const meshes = this.meshes();
    const points: number[] = [];
    for (const line of this.route.lines) {
      const placed = line.map(({ x, y }) => {
        const [vx, , vz] = frame.fromPixel(x, y, 0);
        return [vx, this.groundAt(vx, vz, null, meshes) + DOT_LIFT * 2, vz] as const;
      });
      for (let i = 1; i < placed.length; i++) points.push(...placed[i - 1]!, ...placed[i]!);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const line = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color: new THREE.Color(this.route.color),
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      }),
    );
    line.renderOrder = 9;
    this.world.add(line);
    this.routeLine = line;
    this.dirty = true;
  }

  private updatePlanes(): void {
    const planes: THREE.Plane[] = [];
    if (this.topCut !== null) {
      this.planes.top.set(new THREE.Vector3(0, -1, 0), this.topCut);
      planes.push(this.planes.top);
    }
    if (this.towardCamera) {
      // A wall across the view just before the point looked at, facing away from the camera.
      const target = this.controls.target;
      const forward = new THREE.Vector3().subVectors(target, this.camera.position);
      forward.y = 0;
      if (forward.lengthSq() > 1e-9) {
        forward.normalize();
        const margin = Math.max(this.extent.side * 0.04, this.controls.getDistance() * 0.08);
        this.planes.camera.set(forward, -forward.dot(target) + margin);
        planes.push(this.planes.camera);
      }
    }
    this.renderer.clippingPlanes = planes;
    // The ground is a sheet: where a height cut opens it, the water level
    // would show through as a lake. Under a height cut there is no water.
    if (this.water) this.water.visible = this.topCut === null;
    this.dirty = true;
  }

  /** The dot under a point of the view's box, within the reach of a press. */
  private dotAt(x: number, y: number, reach: number): string | null {
    const seen = this.onScreen();
    let best: string | null = null;
    let bestDistance = reach * reach;
    seen.points.forEach((point, i) => {
      const distance = (point.x - x) ** 2 + (point.y - y) ** 2;
      // The selected one wins a tie, as it is drawn on top.
      if (distance < bestDistance || (distance === bestDistance && seen.ids[i] === this.selected)) {
        best = seen.ids[i]!;
        bestDistance = distance;
      }
    });
    return best;
  }

  private listen(): void {
    const canvas = this.canvas;
    const reach = this.options.fingers ? 22 : 12;
    let down: { x: number; y: number; at: number; button: number; id: number } | null = null;
    let holdTimer = 0;
    const local = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };
    const onDown = (event: PointerEvent) => {
      this.flight = null;
      const point = local(event);
      down = { ...point, at: performance.now(), button: event.button, id: event.pointerId };
      clearTimeout(holdTimer);
      if (event.pointerType !== 'mouse') {
        holdTimer = window.setTimeout(() => {
          if (!down) return;
          const id = this.dotAt(down.x, down.y, reach);
          if (id) {
            down = null;
            this.options.events.longPress(id);
          }
        }, LONG_PRESS_MS);
      }
    };
    const onMove = (event: PointerEvent) => {
      const point = local(event);
      if (down?.id === event.pointerId) {
        if (Math.hypot(point.x - down.x, point.y - down.y) > PRESS_MOVE) {
          down = null;
          clearTimeout(holdTimer);
        }
      }
      if (event.pointerType === 'mouse' && event.buttons === 0) {
        const id = this.dotAt(point.x, point.y, reach);
        if (id !== this.hovered) {
          this.hovered = id;
          canvas.style.cursor = id ? 'pointer' : '';
          this.options.events.hover(id ? this.hoverOf(id) : null);
        }
      }
    };
    const onUp = (event: PointerEvent) => {
      clearTimeout(holdTimer);
      const press = down;
      down = null;
      if (press?.id !== event.pointerId) return;
      const point = local(event);
      if (Math.hypot(point.x - press.x, point.y - press.y) > PRESS_MOVE) return;
      const id = this.dotAt(point.x, point.y, reach);
      if (press.button === 2) {
        if (id) this.options.events.menu(id);
        return;
      }
      if (press.button !== 0) return;
      this.options.events.pick(id);
    };
    const onLeave = () => {
      if (this.hovered) {
        this.hovered = null;
        this.options.events.hover(null);
      }
    };
    const onContextMenu = (event: Event) => {
      event.preventDefault();
    };
    const onLost = (event: Event) => {
      event.preventDefault();
      this.lost = true;
      clearTimeout(this.lostTimer);
      this.lostTimer = window.setTimeout(() => {
        if (this.lost) this.options.events.failed();
      }, 4000);
    };
    const onRestored = () => {
      this.lost = false;
      clearTimeout(this.lostTimer);
      this.dirty = true;
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    this.cleanups.push(() => {
      clearTimeout(holdTimer);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    });
  }

  private hoverOf(id: string): SceneHover | null {
    const seen = this.onScreen();
    const i = seen.ids.indexOf(id);
    return i < 0 ? null : { id, x: seen.points[i]!.x, y: seen.points[i]!.y };
  }
}
