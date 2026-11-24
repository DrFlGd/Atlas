import {
  cellBox,
  FIRST_FRAME_BIAS,
  MAX_BIAS,
  nextBias,
  nextTextureBias,
  planCells,
  sampleFrames,
  type FrameBias,
  type PlanCell,
  type SceneBudget,
  type SceneFrame,
} from '@atlas/core';
import type { Scene, SceneCell } from '@atlas/schema';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  FRAME_MS,
  frameDistance,
  flightStep,
  GO_TO_MS,
  GO_TO_TILT,
  goToDistance,
  MIN_AREA_RADIUS,
  shiftedTarget,
} from './goTo';
import { FLOOR_SHADE, MAX_FLOORS, type FloorBand } from './floorColours';
import {
  channels,
  DEFAULT_SHADE,
  lookShown,
  RAMP_STOPS,
  shadeRamp,
  SLOPE_SHADE,
  slopeShade,
  STRONG_SLOPE_SHADE,
  type SceneLook,
} from './looks';
import { modelLoader, type ModelLoader } from './loader';
import { firstKept, type ViewPoint } from './placing';

/**
 * The 3D view of a map: its model, loaded cell by cell as the camera moves
 * (near cells finely, far ones coarsely, within the device's budget; see
 * `planCells` in `@atlas/core`), lit by the sky, the sun and a light at the
 * camera, without shadows; the locations as dots of their type's colour,
 * drawn together in one buffer, seen through walls (dimmer when hidden);
 * the open route as a line. Floors and the height cut are clipping planes.
 *
 * Each surface is drawn on the sides its model's material says (glTF's
 * `doubleSided`; one side, its front, by default), as the game draws it: a
 * level seen from outside shows no wall that faces away from the camera.
 * While a cut is on (a floor, the height cut, or the cut toward the
 * camera), the back of every one-sided surface is drawn too, darkened, so
 * a model cut open shows its inside as inside rather than as a hole. Files
 * of the first builder (`Atlas scene builder 0.1`) were made for a view
 * that drew both sides of everything, so they still are.
 *
 * It draws only when something changed: the camera, a cell, the dots.
 *
 * It can go to a location (`goTo`: down at it from close by, a little
 * tilted) and frame an area (`frameArea`), flying there unless the person
 * asked for reduced motion; any move by hand stops a flight. Area titles
 * are points it keeps on the model (`setTitles`) and reports where they
 * are in the view after each frame drawn (`titlesOnScreen`), for the page
 * to draw them over it (see `titles.ts`).
 *
 * In Edit locations (`setEditing`), a press off the dots is a point of the
 * model (`surfaceAt`: the first surface under it that is not cut away, see
 * `placing.ts`), and the person's own dots can be dragged over the model.
 *
 * "Floor colours" (`setFloorColours`) paints the map's own model, not its
 * surroundings, each floor in its own colour by height (see
 * `floorColours.ts`): a few lines added to its materials' shaders, which
 * read the floors from uniforms shared by them all, so turning it on or off
 * or changing the floors needs nothing loaded or built again. "Look"
 * (`setLook`) draws the model textured, where it has textures or colours of
 * its own, or shaded in one colour by height and slope (see `looks.ts`),
 * the same way: Floor colours, while on, paints over either.
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
  /** Whether the model has textures or colours of its own; null while none of it is in. */
  ownLook: boolean | null;
  /** The look it is drawn with. */
  look: SceneLook;
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
  /** A frame was drawn: the camera or what is shown may have changed. */
  frame?(): void;
  /**
   * In Edit locations, the model was pressed off the dots: the point of
   * its surface there, or null where nothing is (or all of it is cut away).
   */
  place?(point: ViewPoint | null): void;
  /** In Edit locations, a dot was dragged and let go of over the model (null: off it). */
  drop?(id: string, point: ViewPoint | null): void;
}

/** A point of the view for an area's title. */
export interface SceneTitleAnchor {
  id: string;
  /** Map pixel. */
  px: number;
  py: number;
  /** Its height, or null to put it on what lies below `top`. */
  height: number | null;
  top: number | null;
  /** How far its area reaches, in map pixels. */
  radius: number;
}

/** A title's point as the view shows it now (see `titlesOnScreen`). */
export interface SceneTitlePoint {
  id: string;
  /** In the view's box, in CSS pixels. */
  x: number;
  y: number;
  /** From the camera, in metres. */
  distance: number;
  /** How far its area reaches, in metres. */
  radius: number;
  /** In front of the camera and not cut away. */
  shown: boolean;
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
  /** The darkened backs of one-sided surfaces, shown while a cut is on. */
  insides: THREE.Mesh[];
  triangles: number;
  textureBytes: number;
  /** Whether its materials have textures or colours of their own (see `ownLookOf`). */
  ownLook: boolean;
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

/** How dark the inside of a cut-open model is: the back of a surface, its colour times this. */
export const INSIDE_SHADE = 0x3a3a3a;

/**
 * How the map's model is painted, shared by every material of it: its
 * look (see `looks.ts`; `lookShaded` 0 is textured) and the floors "Floor
 * colours" paints by (`floorCount` 0 is off), which win over the look.
 */
export interface ModelPaint {
  floorCount: { value: number };
  floorLows: { value: number[] };
  floorHighs: { value: number[] };
  floorColours: { value: THREE.Color[] };
  lookShaded: { value: number };
  /** The shade's ramp, as the page shows it (sRGB, 0 to 1), at `RAMP_STOPS`. */
  lookRamp: { value: THREE.Vector3[] };
  /** The heights the ramp runs over: low, high. */
  lookHeights: { value: THREE.Vector2 };
  /** The shades of steep slopes (over 50°) and walls (over 70°). */
  lookSlopes: { value: THREE.Vector2 };
}

export function modelPaint(): ModelPaint {
  const paint: ModelPaint = {
    floorCount: { value: 0 },
    floorLows: { value: new Array<number>(MAX_FLOORS).fill(0) },
    floorHighs: { value: new Array<number>(MAX_FLOORS).fill(0) },
    floorColours: { value: Array.from({ length: MAX_FLOORS }, () => new THREE.Color()) },
    lookShaded: { value: 0 },
    lookRamp: { value: RAMP_STOPS.map(() => new THREE.Vector3()) },
    lookHeights: { value: new THREE.Vector2(0, 0) },
    lookSlopes: { value: new THREE.Vector2(1, 1) },
  };
  writeLook(paint, { look: 'textured', shade: DEFAULT_SHADE, strong: false, heights: null });
  return paint;
}

/** Sets the floors to paint by, lowest first; none turns "Floor colours" off. */
export function writeFloorUniforms(uniforms: ModelPaint, bands: readonly FloorBand[]): void {
  const count = Math.min(bands.length, MAX_FLOORS);
  uniforms.floorCount.value = count;
  for (let i = 0; i < count; i++) {
    const band = bands[i]!;
    uniforms.floorLows.value[i] = band.low;
    uniforms.floorHighs.value[i] = band.high;
    // The colour as the page shows it, in the renderer's working (linear) colours.
    uniforms.floorColours.value[i]!.set(band.color);
  }
}

/** A look as the model is drawn with it (see `looks.ts`). */
export interface ModelLook {
  /** As drawn: textured only where the model has its own textures or colours. */
  look: SceneLook;
  /** The colour shaded with: a preset's id or `#rrggbb`. */
  shade: string;
  /** "Darker walls and slopes". */
  strong: boolean;
  /** The heights the shade's ramp runs over; null: not known, all of it at the middle of the ramp. */
  heights: readonly [number, number] | null;
}

/** Sets the look to draw the model with: no shader is made again, nothing is loaded again. */
export function writeLook(uniforms: ModelPaint, look: ModelLook): void {
  uniforms.lookShaded.value = look.look === 'shaded' ? 1 : 0;
  shadeRamp(look.shade).forEach((colour, i) => {
    const [r, g, b] = channels(colour);
    uniforms.lookRamp.value[i]!.set(r / 255, g / 255, b / 255);
  });
  const [low, high] = look.heights ?? [0, 0];
  uniforms.lookHeights.value.set(low, high);
  const slopes = look.strong ? STRONG_SLOPE_SHADE : SLOPE_SHADE;
  uniforms.lookSlopes.value.set(slopeShade(slopes, 70), slopeShade(slopes, 90));
}

const PAINT_VERTEX_HEAD = /* glsl */ `
varying vec3 vPaintWorld;
`;

const PAINT_VERTEX = /* glsl */ `
#include <project_vertex>
vPaintWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const PAINT_FRAGMENT_HEAD = /* glsl */ `
#define FLOOR_MAX ${MAX_FLOORS}
uniform int floorCount;
uniform float floorLows[FLOOR_MAX];
uniform float floorHighs[FLOOR_MAX];
uniform vec3 floorColours[FLOOR_MAX];
uniform float lookShaded;
uniform vec3 lookRamp[4];
uniform vec2 lookHeights;
uniform vec2 lookSlopes;
uniform vec3 paintTone;
varying vec3 vPaintWorld;

vec3 paintLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

vec3 paintRamp(float t) {
  if (t <= ${RAMP_STOPS[1].toFixed(3)}) {
    return mix(lookRamp[0], lookRamp[1], t / ${RAMP_STOPS[1].toFixed(3)});
  }
  if (t <= ${RAMP_STOPS[2].toFixed(3)}) {
    return mix(lookRamp[1], lookRamp[2], (t - ${RAMP_STOPS[1].toFixed(3)}) / ${(RAMP_STOPS[2] - RAMP_STOPS[1]).toFixed(3)});
  }
  return mix(lookRamp[2], lookRamp[3], (t - ${RAMP_STOPS[2].toFixed(3)}) / ${(RAMP_STOPS[3] - RAMP_STOPS[2]).toFixed(3)});
}
`;

/**
 * The look, then the floors: in place of the surface's own colour (its
 * texture's cutout kept). Shaded, the ramp at the height, times the shade
 * of the surface's slope (from the triangle itself, whatever normals the
 * model has), worked as on the page (sRGB), as the Map Maker does. Floor
 * colours: its floor's colour, shaded by where the height lies within the
 * floor, so it reads as the Map Maker's 2D style.
 */
const PAINT_FRAGMENT = /* glsl */ `
#include <color_fragment>
if (lookShaded > 0.5) {
  float span = lookHeights.y - lookHeights.x;
  float t = span > 0.0 ? clamp((vPaintWorld.y - lookHeights.x) / span, 0.0, 1.0) : 0.5;
  vec3 facing = cross(dFdx(vPaintWorld), dFdy(vPaintWorld));
  float up = abs(facing.y) / max(length(facing), 1e-20);
  float slope = up >= ${Math.cos((50 * Math.PI) / 180).toFixed(4)} ? 1.0 : up >= ${Math.cos((70 * Math.PI) / 180).toFixed(4)} ? lookSlopes.x : lookSlopes.y;
  diffuseColor.rgb = paintLinear(paintRamp(t) * slope) * paintTone;
}
if (floorCount > 0) {
  int found = 0;
  for (int i = 0; i < FLOOR_MAX; i++) {
    if (i >= floorCount) break;
    if (floorLows[i] <= vPaintWorld.y) found = i;
  }
  float low = floorLows[0];
  float high = floorHighs[0];
  vec3 colour = floorColours[0];
  for (int i = 1; i < FLOOR_MAX; i++) {
    if (i == found) {
      low = floorLows[i];
      high = floorHighs[i];
      colour = floorColours[i];
    }
  }
  float t = high > low ? clamp((vPaintWorld.y - low) / (high - low), 0.0, 1.0) : 0.5;
  float shade = mix(${FLOOR_SHADE[0].toFixed(3)}, ${FLOOR_SHADE[1].toFixed(3)}, t);
  diffuseColor.rgb = colour * pow(shade, 2.2) * paintTone;
}
`;

/**
 * Lets a material be painted as `uniforms` say (the look, the floors);
 * `tone` darkens it (the inside of a cut-open model). Every material of
 * the model shares the uniforms and one program.
 */
export function paintModel(
  material: THREE.Material,
  uniforms: ModelPaint,
  tone: THREE.Color = new THREE.Color(1, 1, 1),
): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { paintTone: { value: tone } });
    shader.vertexShader =
      PAINT_VERTEX_HEAD + shader.vertexShader.replace('#include <project_vertex>', PAINT_VERTEX);
    shader.fragmentShader =
      PAINT_FRAGMENT_HEAD +
      shader.fragmentShader.replace('#include <color_fragment>', PAINT_FRAGMENT);
  };
  material.customProgramCacheKey = () => 'atlas-model-paint';
}

/**
 * The heights a model spans, for the shaded look: its own, else those of
 * its cells; null where it says none.
 */
export function modelHeights(scene: Pick<Scene, 'heights' | 'cells'>): [number, number] | null {
  if (scene.heights) return [scene.heights[0], scene.heights[1]];
  const ranges = scene.cells.flatMap((cell) => (cell.heights ? [cell.heights] : []));
  if (ranges.length === 0) return null;
  return [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))];
}

/** Whether a file was written by the first builder, for a view that drew both sides of everything. */
export function drawnBothSides(generator: string | undefined): boolean {
  return (generator ?? '').startsWith('Atlas scene builder 0.1.');
}

/**
 * The material of the back of a one-sided surface, shown while a cut is
 * on: unlit, its texture and colours darkened, its cutout kept.
 */
export function insideOf(material: THREE.MeshLambertMaterial): THREE.MeshBasicMaterial {
  const out = new THREE.MeshBasicMaterial({
    color: new THREE.Color(INSIDE_SHADE).multiply(material.color),
    map: material.map,
    vertexColors: material.vertexColors,
    side: THREE.BackSide,
    transparent: material.transparent,
    opacity: material.opacity,
    alphaTest: material.alphaTest,
  });
  out.name = `${material.name} (inside)`;
  return out;
}

/**
 * A plain material in place of the model's: lit by the hemisphere, the sun
 * and the camera's light, on the sides the model's material says (both
 * with `bothSides`).
 */
export function lambertOf(material: THREE.Material, bothSides = false): THREE.MeshLambertMaterial {
  // Any material of a model: some have no texture or glow.
  const source = material as Partial<THREE.MeshStandardMaterial> & THREE.Material;
  const out = new THREE.MeshLambertMaterial({
    color: source.color ?? new THREE.Color(0xffffff),
    map: source.map ?? null,
    emissive: source.emissive ?? new THREE.Color(0),
    emissiveMap: source.emissiveMap ?? null,
    vertexColors: source.vertexColors,
    // The model's own sides: the front only unless it says both.
    side: bothSides || material.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.FrontSide,
    transparent: source.transparent,
    opacity: source.opacity,
    alphaTest: source.alphaTest,
  });
  out.name = source.name;
  return out;
}

/** A primitive of a loaded model: its geometry, where it stands, and its material. */
interface Primitive {
  geometry: THREE.BufferGeometry;
  /** Its place in the model, or null where it stands as it is. */
  matrix: THREE.Matrix4 | null;
}

/**
 * A primitive's geometry to draw by itself: its own attributes, not
 * copied (the builder's files give every primitive of a cell one set of
 * vertices, so the cell's meshes share them, held once in memory and on
 * the graphics card), unless it must be moved into place.
 */
function sharedPart({ geometry, matrix }: Primitive): THREE.BufferGeometry {
  if (matrix) {
    const part = geometry.clone();
    part.clearGroups();
    part.morphAttributes = {};
    part.applyMatrix4(matrix);
    return part;
  }
  const part = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    part.setAttribute(name, attribute);
  }
  part.setIndex(geometry.index);
  return part;
}

/**
 * A primitive's geometry with only the vertices its triangles use, copied,
 * moved into place: for merging with others of its material.
 */
export function compactPart({ geometry, matrix }: Primitive): THREE.BufferGeometry {
  const index = geometry.index;
  let part: THREE.BufferGeometry;
  if (!index) {
    part = geometry.clone();
    part.clearGroups();
    part.morphAttributes = {};
  } else {
    const newOf = new Map<number, number>();
    const used: number[] = [];
    const indices = new Uint32Array(index.count);
    for (let i = 0; i < index.count; i++) {
      const old = index.getX(i);
      let at = newOf.get(old);
      if (at === undefined) {
        at = used.length;
        newOf.set(old, at);
        used.push(old);
      }
      indices[i] = at;
    }
    part = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      const size = attribute.itemSize;
      const source = attribute.array as unknown as {
        constructor: new (n: number) => THREE.TypedArray;
      };
      const array = new source.constructor(used.length * size);
      const out = new THREE.BufferAttribute(array, size, attribute.normalized);
      for (let v = 0; v < used.length; v++) {
        for (let k = 0; k < size; k++) {
          out.setComponent(v, k, attribute.getComponent(used[v]!, k));
        }
      }
      part.setAttribute(name, out);
    }
    part.setIndex(
      new THREE.BufferAttribute(used.length > 65535 ? indices : Uint16Array.from(indices), 1),
    );
  }
  if (matrix) part.applyMatrix4(matrix);
  return part;
}

/**
 * The meshes of a loaded model, one per material (and set of attributes):
 * a cell is drawn in a few calls, whatever its file holds. A material of
 * one primitive draws it as it is, its vertices shared with the rest of
 * the cell; the primitives of a material that has several are merged, each
 * with only the vertices it uses. With `paint`, they are painted as it
 * says (the look, the floors; see `paintModel`).
 */
export function mergeByMaterial(
  root: THREE.Object3D,
  bothSides = false,
  cut = false,
  paint: ModelPaint | null = null,
): Loaded {
  root.updateMatrixWorld(true);
  const groups = new Map<string, { material: THREE.Material; parts: Primitive[] }>();
  const sources = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const identity = new THREE.Matrix4();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry as THREE.BufferGeometry;
    const material = (Array.isArray(object.material) ? object.material[0] : object.material) as
      THREE.Material | undefined;
    sources.add(geometry);
    if (!material) return;
    materials.add(material);
    const key = [
      material.uuid,
      geometry.index ? 'i' : 'n',
      ...Object.keys(geometry.attributes).sort(),
    ].join('|');
    let group = groups.get(key);
    if (!group) {
      group = { material, parts: [] };
      groups.set(key, group);
    }
    group.parts.push({
      geometry,
      matrix: object.matrixWorld.equals(identity) ? null : object.matrixWorld.clone(),
    });
  });
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  const textures = new Set<THREE.Texture>();
  const lamberts = new Map<THREE.Material, THREE.MeshLambertMaterial>();
  const insides: THREE.Mesh[] = [];
  const spheres = new Map<unknown, THREE.Sphere>();
  let triangles = 0;
  for (const { material, parts } of groups.values()) {
    let geometries: THREE.BufferGeometry[];
    if (parts.length === 1) {
      geometries = [sharedPart(parts[0]!)];
    } else {
      const compact = parts.map(compactPart);
      // Null when the parts cannot be merged after all: they are drawn apart.
      const merged = mergeGeometries(compact, false) as THREE.BufferGeometry | null;
      if (merged) for (const part of compact) part.dispose();
      geometries = merged ? [merged] : compact;
    }
    let lambert = lamberts.get(material);
    if (!lambert) {
      lambert = lambertOf(material, bothSides);
      if (paint) paintModel(lambert, paint);
      lamberts.set(material, lambert);
      if (lambert.map) textures.add(lambert.map);
      if (lambert.emissiveMap) textures.add(lambert.emissiveMap);
    }
    for (const geometry of geometries) {
      // Meshes that share their vertices share their bounds, worked out once.
      const position = geometry.getAttribute('position');
      const sphere = spheres.get(position);
      if (sphere) {
        geometry.boundingSphere = sphere.clone();
      } else {
        geometry.computeBoundingSphere();
        if (geometry.boundingSphere) spheres.set(position, geometry.boundingSphere);
      }
      triangles += trianglesOf(geometry);
      const mesh = new THREE.Mesh(geometry, lambert);
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      meshes.push(mesh);
      if (lambert.side === THREE.FrontSide) {
        const back = insideOf(lambert);
        if (paint) paintModel(back, paint, new THREE.Color(INSIDE_SHADE));
        const inside = new THREE.Mesh(geometry, back);
        inside.matrixAutoUpdate = false;
        inside.visible = cut;
        group.add(inside);
        insides.push(inside);
      }
    }
  }
  const ownLook = [...lamberts.values()].some(ownLookOf);
  // The model's own geometries were never drawn: letting them go frees no attribute the meshes share.
  for (const geometry of sources) geometry.dispose();
  for (const material of materials) material.dispose();
  let textureBytes = 0;
  textures.forEach((texture) => (textureBytes += textureBytesOf(texture)));
  return { level: -1, group, meshes, insides, triangles, textureBytes, ownLook };
}

/**
 * The name of the one material of a model the Map Maker makes from a
 * game's collision (`raw_glb` in tools/gamefiles/atlas_gamefiles/scene.py):
 * white, its vertices coloured by height, as the shaded look draws it.
 */
export const HEIGHT_COLOURED_MATERIAL = 'collision';

/**
 * Whether a material has a look of its own, to be shown "Textured": a
 * texture, a colour other than white, or colours in its vertices other
 * than the Map Maker's height ramp.
 */
export function ownLookOf(material: THREE.MeshLambertMaterial): boolean {
  if (material.map) return true;
  const { r, g, b } = material.color;
  if (Math.min(r, g, b) < 0.98) return true;
  return material.vertexColors && material.name !== HEIGHT_COLOURED_MATERIAL;
}

function disposeLoaded(loaded: Loaded): void {
  const materials = new Set<THREE.MeshLambertMaterial>();
  // Meshes of a cell may share their vertices: they all go together, and
  // the renderer lets go of a shared buffer once.
  for (const mesh of loaded.meshes) {
    mesh.geometry.dispose();
    materials.add(mesh.material as THREE.MeshLambertMaterial);
  }
  for (const material of materials) {
    material.map?.dispose();
    material.emissiveMap?.dispose();
    material.dispose();
  }
  for (const inside of loaded.insides) (inside.material as THREE.Material).dispose();
  loaded.group.removeFromParent();
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
  private titles: SceneTitleAnchor[] = [];
  private titlePositions: THREE.Vector3[] = [];
  /** How the model is painted: its look, and the floors "Floor colours" paints by. */
  private readonly paint = modelPaint();
  /** The look asked for (see `setLook`). */
  private look: Omit<ModelLook, 'heights'> = {
    look: 'textured',
    shade: DEFAULT_SHADE,
    strong: false,
  };
  /** Whether the model has textures or colours of its own, found as its parts come in. */
  private ownLook = false;
  /** The heights the shaded look's ramp runs over; null until known. */
  private shadeHeights: [number, number] | null;
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
  private frameBias: FrameBias = FIRST_FRAME_BIAS;
  private textureBias = 0;
  /** When the textures' bias may step again. */
  private textureStepDue = 0;
  /** The textures' bias stepped and the cells it asked for are not all in yet. */
  private textureStepped = false;
  /** Frames still to leave out of the frame rate after a cell was put in. */
  private settling = 0;
  private frameTimes: number[] = [];
  private lastFrame = 0;
  private lost = false;
  private lostTimer = 0;
  private disposed = false;
  private hovered: string | null = null;
  /** In Edit locations: the dots that can be dragged; null when not editing. */
  private editing: ReadonlySet<string> | null = null;
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
    this.shadeHeights = modelHeights(scene);
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
    // Any move by hand (a drag, the wheel, a key) stops a flight.
    const onStart = () => {
      this.flight = null;
    };
    this.controls.addEventListener('change', onChange);
    this.controls.addEventListener('start', onStart);
    this.cleanups.push(() => {
      this.controls.removeEventListener('change', onChange);
      this.controls.removeEventListener('start', onStart);
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

  /** The points of the areas' titles. */
  setTitles(titles: readonly SceneTitleAnchor[]): void {
    this.titles = [...titles];
    this.placeTitles();
  }

  /**
   * Edit locations on (`draggable`: the dots that can be dragged, the
   * person's own) or off (null): a press off the dots then places, and a
   * press on one picks it, never going to it.
   */
  setEditing(draggable: ReadonlySet<string> | null): void {
    this.editing = draggable;
    this.canvas.style.cursor = this.cursorFor(this.hovered);
  }

  /** The mouse's pointer over a dot (or none): a hand to press, to drag one's own, or a cross to place. */
  private cursorFor(id: string | null): string {
    if (!this.editing) return id ? 'pointer' : '';
    if (!id) return 'crosshair';
    return this.editing.has(id) ? 'grab' : 'pointer';
  }

  /**
   * The point of the model under a point of the view's box (CSS pixels):
   * the first surface the ray from the camera meets that the cuts leave,
   * on the model or the open water. Null where there is none.
   */
  surfaceAt(x: number, y: number): ViewPoint | null {
    if (this.width <= 0 || this.height <= 0) return null;
    this.camera.updateMatrixWorld();
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, 1 - (y / this.height) * 2);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.far = Infinity;
    const meshes = this.meshes();
    // A model cut open shows the backs of its surfaces: they can be pressed too.
    if (this.cutOn()) {
      for (const state of this.cells) if (state.loaded) meshes.push(...state.loaded.insides);
    }
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (this.water?.visible) hits.push(...this.raycaster.intersectObject(this.water, false));
    const hit = firstKept(hits, this.renderer.clippingPlanes);
    return hit ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : null;
  }

  /** The point of the model in the middle of the view: where the crosshair is. */
  surfaceAtCentre(): ViewPoint | null {
    return this.surfaceAt(this.width / 2, this.height / 2);
  }

  /** Paints the model by floor (see `floorColours.ts`), or not (null or no floors). */
  setFloorColours(bands: readonly FloorBand[] | null): void {
    writeFloorUniforms(this.paint, bands ?? []);
    this.dirty = true;
  }

  /** How many floors the model is painted by now: 0 when "Floor colours" is off. */
  get floorColoursShown(): number {
    return this.paint.floorCount.value;
  }

  /**
   * Draws the model textured (where it has textures or colours of its
   * own) or shaded in a colour (see `looks.ts`): a few numbers its
   * materials share, nothing built or loaded again.
   */
  setLook(look: SceneLook, shade: string, strong: boolean): void {
    this.look = { look, shade, strong };
    this.writeLook();
    this.report();
  }

  /** The look the model is drawn with now. */
  get lookShown(): SceneLook {
    return this.paint.lookShaded.value > 0.5 ? 'shaded' : 'textured';
  }

  private writeLook(): void {
    writeLook(this.paint, {
      ...this.look,
      look: lookShown(this.look.look, this.ownLook),
      heights: this.shadeHeights,
    });
    this.dirty = true;
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
    // The insides of cut-open models show only while a cut is on.
    const cut = this.cutOn();
    for (const loaded of [...this.cells.map((state) => state.loaded), this.neighbours]) {
      for (const inside of loaded?.insides ?? []) inside.visible = cut;
    }
    this.updatePlanes();
    this.paintSky();
    this.writeDotStates();
  }

  /** Whether a cut is on: a height (a floor's top or the free cut), or the cut toward the camera. */
  private cutOn(): boolean {
    return this.topCut !== null || this.towardCamera;
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

  /**
   * Goes to a location: looks down at it from close by, a little tilted,
   * facing the way the view faces now (see `goTo.ts`). Its height, or with
   * none what lies under it below `top`. With `shift`, it shows that many
   * CSS pixels above the middle of the view (above a card over its foot).
   */
  goTo(px: number, py: number, height: number | null, top: number | null, shift = 0): void {
    const [x, , z] = this.options.frame.fromPixel(px, py, 0);
    const y = height ?? this.groundAt(x, z, top);
    const distance = goToDistance(this.extent.size, this.controls.minDistance);
    const azimuth = this.controls.getAzimuthalAngle();
    const target = shiftedTarget([x, y + DOT_LIFT, z], shift, {
      distance,
      azimuth,
      fovDegrees: this.camera.fov,
      height: this.height,
    });
    this.fly(
      { target: new THREE.Vector3(...target), distance, azimuth, polar: GO_TO_TILT },
      GO_TO_MS,
    );
  }

  /** The height a location stands at: its own, or what lies under it below `top`. */
  heightAt(px: number, py: number, top: number | null): number {
    const [x, , z] = this.options.frame.fromPixel(px, py, 0);
    return this.groundAt(x, z, top);
  }

  /**
   * Shows the whole of an area: from above, a little tilted, facing the
   * way the view faces now, far enough to see `radius` map pixels round
   * its point.
   */
  frameArea(px: number, py: number, height: number | null, radius: number): void {
    const [x, , z] = this.options.frame.fromPixel(px, py, 0);
    const y = height ?? this.groundAt(x, z, null);
    const reach = Math.max(radius * this.options.frame.unit, MIN_AREA_RADIUS);
    const distance = Math.min(
      Math.max(
        frameDistance(reach, this.camera.fov, this.camera.aspect),
        this.controls.minDistance,
      ),
      this.controls.maxDistance,
    );
    this.fly(
      {
        target: new THREE.Vector3(x, y, z),
        distance,
        azimuth: this.controls.getAzimuthalAngle(),
        polar: GO_TO_TILT,
      },
      FRAME_MS,
    );
  }

  /** Where the areas' titles are in the view now, in the order given. */
  titlesOnScreen(): SceneTitlePoint[] {
    const v = new THREE.Vector3();
    const top = this.topCut;
    const unit = this.options.frame.unit;
    return this.titles.map((title, i) => {
      const position = this.titlePositions[i]!;
      v.copy(position).project(this.camera);
      const front = v.z >= -1 && v.z <= 1;
      return {
        id: title.id,
        x: ((v.x + 1) / 2) * this.width,
        y: ((1 - v.y) / 2) * this.height,
        distance: position.distanceTo(this.camera.position),
        radius: title.radius * unit,
        shown: front && (top === null || position.y - DOT_LIFT <= top + 0.5),
      };
    });
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

  /** The model's widest extent, in metres. */
  get size(): number {
    return this.extent.size;
  }

  /** The view's box, in CSS pixels. */
  viewSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** Whether the view was let go of (`dispose`). */
  get gone(): boolean {
    return this.disposed;
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
      ownLook: cells > 0 ? this.ownLook : null,
      look: this.lookShown,
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
      const step = flightStep(from, to, t);
      this.setPose({ ...step, target: from.target.clone().lerp(to.target, step.k) });
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
      // Frames while a cell loads, or just after one is put in, say nothing of the drawing.
      const loading = this.settling > 0 || this.cells.some((state) => state.loading !== null);
      this.frameTimes = sampleFrames(this.frameTimes, now - this.lastFrame, loading);
      this.settling = Math.max(0, this.settling - 1);
    }
    this.lastFrame = now;
    if (now >= this.biasDue) {
      this.biasDue = now + BIAS_MS;
      const frameBias = nextBias(this.frameBias, this.frameTimes);
      if (this.frameTimes.length >= 20) this.frameTimes = [];
      // Once the coarser cells are in, the textures may leave room for finer ones again.
      const textureChanged = this.stepTextureBias(now);
      // A level slow again once stepped back to is given up for this view (its floor).
      const changed = frameBias.bias !== this.frameBias.bias || textureChanged;
      this.frameBias = frameBias;
      if (changed) {
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
    this.options.events.frame?.();
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

  /**
   * Steps the textures' bias as their memory asks, at most once a bias
   * period and not again until the cells loading after a step are all in:
   * they are counted only once they are in, so a second step before then
   * would overshoot. Whether it stepped.
   */
  private stepTextureBias(now: number): boolean {
    const loading = this.cells.some((state) => state.loading !== null);
    // After a step, the next waits until the cells it asked for are all in.
    if (this.textureStepped && !loading) this.textureStepped = false;
    if (now < this.textureStepDue || this.textureStepped) return false;
    const next = nextTextureBias(this.textureBias, this.status().textureBytes, this.options.budget);
    if (next === this.textureBias) return false;
    this.textureBias = next;
    this.textureStepDue = now + BIAS_MS;
    this.textureStepped = true;
    return true;
  }

  private planBias(): number {
    return Math.min(MAX_BIAS, this.frameBias.bias + this.textureBias);
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
      const loaded = mergeByMaterial(
        gltf.scene,
        drawnBothSides(gltf.asset.generator),
        this.cutOn(),
        this.paint,
      );
      loaded.level = level;
      if (this.disposed) {
        disposeLoaded(loaded);
        return;
      }
      if (state.loaded) disposeLoaded(state.loaded);
      state.loaded = loaded;
      this.model.add(loaded.group);
      loaded.group.updateMatrixWorld(true);
      this.lookAtPart(loaded);
      this.stepTextureBias(performance.now());
      this.placeDots(state);
      this.placeTitles();
      this.drawRoute();
    } catch {
      state.failed.add(level);
    } finally {
      state.loading = null;
      // Its upload is in the next frame drawn: that frame and the one before say nothing of the drawing.
      this.settling = 2;
      this.dirty = true;
      this.planDue = 0;
      this.report();
    }
  }

  /**
   * What a part of the model just in says of its look: whether it has
   * textures or colours of its own (shown textured from the first frame it
   * is drawn in, where asked for) and, where the model does not say, its
   * heights, for the shaded look's ramp.
   */
  private lookAtPart(loaded: Loaded): void {
    let changed = false;
    if (loaded.ownLook && !this.ownLook) {
      this.ownLook = true;
      changed = true;
    }
    if (!this.options.scene.heights && !this.options.scene.cells.some((cell) => cell.heights)) {
      const box = new THREE.Box3().setFromObject(loaded.group);
      if (!box.isEmpty()) {
        const before = this.shadeHeights;
        this.shadeHeights = [
          Math.min(before?.[0] ?? box.min.y, box.min.y),
          Math.max(before?.[1] ?? box.max.y, box.max.y),
        ];
        changed ||= before?.[0] !== this.shadeHeights[0] || before[1] !== this.shadeHeights[1];
      }
    }
    if (changed) this.writeLook();
  }

  private async loadNeighbours(file: string): Promise<void> {
    try {
      const gltf = await this.loader.load(this.options.resolveUrl(file));
      const loaded = mergeByMaterial(
        gltf.scene,
        drawnBothSides(gltf.asset.generator),
        this.cutOn(),
      );
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

  /** Shows a dot at a point of the model while it is dragged. */
  private moveDot(index: number, point: ViewPoint): void {
    const position = this.dotPositions[index];
    const attribute = this.dotGeometry.getAttribute('position') as
      THREE.BufferAttribute | undefined;
    if (!position || !attribute) return;
    position.set(point.x, point.y + DOT_LIFT, point.z);
    attribute.setXYZ(index, position.x, position.y, position.z);
    attribute.needsUpdate = true;
    this.dirty = true;
  }

  /** Puts the titles' points where they belong: at their height, or on what lies below. */
  private placeTitles(): void {
    const frame = this.options.frame;
    const meshes = this.meshes();
    this.titlePositions = this.titles.map((title) => {
      const [x, , z] = frame.fromPixel(title.px, title.py, 0);
      const y = title.height ?? this.groundAt(x, z, title.top, meshes);
      return new THREE.Vector3(x, y + DOT_LIFT, z);
    });
    this.dirty = true;
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
          canvas.style.cursor = this.cursorFor(id);
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
      if (this.editing && !id) {
        this.options.events.place?.(this.surfaceAt(point.x, point.y));
        return;
      }
      this.options.events.pick(id);
    };
    // In Edit locations, one of the person's own dots is dragged over the
    // model: taken before the controls see the press, so the view stays.
    let drag: {
      id: string;
      index: number;
      pointer: number;
      moved: boolean;
      x: number;
      y: number;
    } | null = null;
    let dragPoint: ViewPoint | null = null;
    const onDragDown = (event: PointerEvent) => {
      if (!this.editing || event.button !== 0 || drag) return;
      const point = local(event);
      const id = this.dotAt(point.x, point.y, reach);
      if (!id || !this.editing.has(id)) return;
      const index = this.dots.findIndex((dot) => dot.id === id);
      if (index < 0) return;
      event.stopImmediatePropagation();
      this.flight = null;
      drag = { id, index, pointer: event.pointerId, moved: false, ...point };
      dragPoint = null;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Not captured: the drag ends where the pointer leaves the view.
      }
    };
    const onDragMove = (event: PointerEvent) => {
      if (drag?.pointer !== event.pointerId) return;
      const point = local(event);
      if (!drag.moved && Math.hypot(point.x - drag.x, point.y - drag.y) <= PRESS_MOVE) return;
      drag.moved = true;
      dragPoint = this.surfaceAt(point.x, point.y);
      if (dragPoint) this.moveDot(drag.index, dragPoint);
    };
    const onDragUp = (event: PointerEvent) => {
      if (drag?.pointer !== event.pointerId) return;
      const done = drag;
      drag = null;
      event.stopImmediatePropagation();
      if (event.type === 'pointercancel') {
        this.placeDots();
        return;
      }
      if (!done.moved) {
        this.options.events.pick(done.id);
        return;
      }
      this.options.events.drop?.(done.id, dragPoint);
      // Back where it belongs until the store says where it went.
      if (!dragPoint) this.placeDots();
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
    canvas.addEventListener('pointerdown', onDragDown, { capture: true });
    canvas.addEventListener('pointermove', onDragMove);
    canvas.addEventListener('pointerup', onDragUp, { capture: true });
    canvas.addEventListener('pointercancel', onDragUp, { capture: true });
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
      canvas.removeEventListener('pointerdown', onDragDown, { capture: true });
      canvas.removeEventListener('pointermove', onDragMove);
      canvas.removeEventListener('pointerup', onDragUp, { capture: true });
      canvas.removeEventListener('pointercancel', onDragUp, { capture: true });
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
