/**
 * "Make a map from a 3D model…": what the 3D builder says of a model file (`atlas-scene inspect`), and the setup
 * the person chooses for it (settings.rs ModelSetup, the helper's `make-model`): its name and title, which way is
 * up, its units, its textures, its sides and how floors are found. The preview of its shape is turned and scaled
 * here as the map will be, for the Adjust floors 3D view (floors3d.ts).
 */
import { fromBase64 } from './floors';
import type { MapStyleId } from './report';
import type { AreaModel } from './shell';

/** What the builder read in a model file (atlas-scene formats.rs ModelInfo). */
export interface ModelInfo {
  format: 'gltf' | 'obj' | 'stl' | 'ply';
  formatName: string;
  triangles: number;
  parts: number;
  materials: number;
  texturedMaterials: number;
  texturesFound: number;
  hasColours: boolean;
  /** The axis most likely up for this type of file. */
  up: UpAxis;
  /** The file says which materials are seen from both sides (glTF does; OBJ, STL and PLY do not). */
  sidesGiven: boolean;
  /** The model's box in its own units and axes. */
  min: [number, number, number];
  max: [number, number, number];
  missingFiles: string[];
  warnings: string[];
}

/** A small copy of the model's shape (atlas-scene draw.rs Preview), in its own units and axes. */
export interface ModelPreview {
  triangles: number;
  min: [number, number, number];
  max: [number, number, number];
  /** Each corner's x, y and z as 16-bit steps from `min` to `max`, base64. */
  positions: string;
  /** Each triangle's colour, three sRGB bytes, base64. */
  colours: string;
  simplified: boolean;
}

export interface Inspected {
  info: ModelInfo;
  preview: ModelPreview;
}

export type UpAxis = '+y' | '+z' | '-y' | '-z' | '+x' | '-x';

/** Which of the model's axes gives east, north and up on the map, for each up axis: each a turn, never a mirror
 * (as the helper's model.UP_AXES). */
export const UP_AXES: Record<UpAxis, [string, string, string]> = {
  '+y': ['+x', '-z', '+y'],
  '+z': ['+x', '+y', '+z'],
  '-y': ['+x', '+z', '-y'],
  '-z': ['+x', '-y', '-z'],
  '+x': ['+y', '+z', '+x'],
  '-x': ['+y', '-z', '-x'],
};

export const UP_CHOICES: { id: UpAxis; label: string }[] = [
  { id: '+y', label: 'Y up (glTF, OBJ, most programs)' },
  { id: '+z', label: 'Z up (STL, PLY, CAD programs)' },
  { id: '-y', label: 'Y down' },
  { id: '-z', label: 'Z down' },
  { id: '+x', label: 'X up' },
  { id: '-x', label: 'X down' },
];

export type Units = 'metres' | 'centimetres' | 'millimetres' | 'inches' | 'feet' | 'custom';

export const UNITS: { id: Units; label: string; metres: number | null }[] = [
  { id: 'metres', label: 'Metres', metres: 1 },
  { id: 'centimetres', label: 'Centimetres', metres: 0.01 },
  { id: 'millimetres', label: 'Millimetres', metres: 0.001 },
  { id: 'inches', label: 'Inches', metres: 0.0254 },
  { id: 'feet', label: 'Feet', metres: 0.3048 },
  { id: 'custom', label: 'Custom', metres: null },
];

export type ModelFloors = 'ground' | 'passages' | 'none';

export const MODEL_FLOORS: { id: ModelFloors; label: string }[] = [
  { id: 'ground', label: 'By ground area' },
  { id: 'passages', label: 'Automatic passages' },
  { id: 'none', label: 'No floors (one floor)' },
];

/** The setup sent to `model_make_start` (settings.rs ModelSetup). */
export interface ModelSetup {
  name: string;
  title: string;
  up: UpAxis;
  /** Metres per model unit. */
  scale: number;
  units: Units;
  textures: 'keep' | 'plain';
  doubleSided: 'auto' | 'yes' | 'no';
  floors: ModelFloors;
  floorSeparation: number | null;
  mergeGap: number | null;
  allowLarge: boolean;
  mapStyle: MapStyleId;
}

/** The defaults for ground area (the helper's floors.DEFAULTS). */
export const DEFAULT_SEPARATION = 3;
export const DEFAULT_MERGE_GAP = 2;

/** The model's own name, from its file name: "old_mill-v2.glb" gives "old mill v2". */
export function nameFromFile(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[^.]*$/, '');
  const spaced = stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced.slice(0, 80) || 'Model';
}

/** The pack id made from a name (as the helper's model.pack_id_for): lower case letters, digits and dashes, accents
 * dropped, at most 64. */
export function packIdFor(name: string): string {
  const plain = Array.from(name.normalize('NFKD').replace(/\p{M}/gu, ''))
    .map((c) => (/^[A-Za-z0-9]$/.test(c) ? c : '-'))
    .join('')
    .toLowerCase();
  const slug = plain
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug || 'model-map';
}

/** The metres per unit of `units`, or `custom` when given. */
export function scaleOf(units: Units, custom: number): number {
  return UNITS.find((u) => u.id === units)?.metres ?? custom;
}

/** The model's size on the map, in metres: east to west, south to north, and its height. */
export function sizeMetres(
  info: Pick<ModelInfo, 'min' | 'max'>,
  up: UpAxis,
  scale: number,
): [number, number, number] {
  const span = [0, 1, 2].map((k) => Math.abs(info.max[k]! - info.min[k]!) * scale);
  const axis = (name: string) => span['xyz'.indexOf(name[1]!)]!;
  const [east, north, height] = UP_AXES[up];
  return [axis(east), axis(north), axis(height)];
}

/** "1.25 m", "38 m", "1,200 m", "4 mm": a length in plain words. */
export function lengthText(metres: number): string {
  if (!Number.isFinite(metres)) return '–';
  if (metres > 0 && metres < 0.01) return `${Math.round(metres * 10000) / 10} mm`;
  const rounded =
    metres < 10
      ? Math.round(metres * 100) / 100
      : metres < 100
        ? Math.round(metres * 10) / 10
        : Math.round(metres);
  return `${rounded.toLocaleString('en-US')} m`;
}

/** "30 × 22 m, 7.5 m high". */
export function sizeText(size: [number, number, number]): string {
  return `${lengthText(size[0]).replace(/ m$/, '')} × ${lengthText(size[1])}, ${lengthText(size[2])} high`;
}

/** A word on a size that is unlikely for a building or a level: the units may be wrong. */
export function sizeHint(size: [number, number, number]): string | null {
  const largest = Math.max(...size);
  if (largest > 5000)
    return 'That is very large for a map: the model may be in centimetres or millimetres.';
  if (largest > 0 && largest < 1)
    return 'That is very small for a map: the model may be in other units, or need a larger scale.';
  return null;
}

/** Whether the setup can be made, or what is missing. */
export function setupProblem(setup: ModelSetup): string | null {
  if (!setup.name.trim()) return 'Give the map a name.';
  if (!setup.title.trim()) return 'Give the map a title.';
  if (!(Number.isFinite(setup.scale) && setup.scale >= 1e-6 && setup.scale <= 1e6))
    return 'The scale must be a number above 0.000001.';
  if (
    setup.floorSeparation !== null &&
    !(setup.floorSeparation >= 0.5 && setup.floorSeparation <= 50)
  )
    return 'The floor separation must be between 0.5 and 50 metres.';
  if (setup.mergeGap !== null && !(setup.mergeGap >= 0 && setup.mergeGap <= 20))
    return 'The merge gap must be between 0 and 20 metres.';
  return null;
}

/** The setup to start from for a model just read. */
export function startSetup(file: string, info: ModelInfo, mapStyle: MapStyleId): ModelSetup {
  const name = nameFromFile(file);
  const textured = info.texturesFound > 0 || info.hasColours;
  return {
    name,
    title: name,
    up: info.up,
    scale: 1,
    units: 'metres',
    textures: 'keep',
    doubleSided: 'auto',
    floors: 'ground',
    floorSeparation: null,
    mergeGap: null,
    allowLarge: false,
    mapStyle: textured ? 'textured' : mapStyle.startsWith('textured') ? 'shaded' : mapStyle,
  };
}

/** The preview of the model as the map will hold it: turned so that `up` is up, scaled to metres, as the Adjust
 * floors view takes an area's triangles (x east, height, z north), with each triangle's own colour. */
export function previewModel(preview: ModelPreview, up: UpAxis, scale: number): AreaModel {
  const steps = fromBase64(preview.positions);
  const corners = new Uint16Array(steps.buffer, steps.byteOffset, Math.floor(steps.byteLength / 2));
  const span = [0, 1, 2].map((k) => preview.max[k]! - preview.min[k]!);
  // Each map axis (east, height, north): the model axis it comes from, and its sign.
  const [east, north, height] = UP_AXES[up];
  const from = [east, height, north].map((name) => ({
    axis: 'xyz'.indexOf(name[1]!),
    sign: name.startsWith('-') ? -1 : 1,
  }));
  const low = from.map(({ axis, sign }) =>
    sign > 0 ? preview.min[axis]! * scale : 0 - preview.max[axis]! * scale,
  ) as [number, number, number];
  const high = from.map(({ axis, sign }) =>
    sign > 0 ? preview.max[axis]! * scale : 0 - preview.min[axis]! * scale,
  ) as [number, number, number];
  const out = new Uint16Array(corners.length);
  for (let i = 0; i + 2 < corners.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const { axis, sign } = from[k]!;
      // A step along the model axis is the same step along the map axis, or the opposite one.
      const step = corners[i + axis]!;
      out[i + k] = span[axis]! > 0 ? (sign > 0 ? step : 65535 - step) : 0;
    }
  }
  return {
    triangles: Math.floor(corners.length / 9),
    min: low,
    max: high,
    positions: toBase64(new Uint8Array(out.buffer)),
    colours: preview.colours,
  };
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    text += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(text);
}
