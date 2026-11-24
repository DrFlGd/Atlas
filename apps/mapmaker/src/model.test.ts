import { describe, expect, it } from 'vitest';
import { fromBase64 } from './floors';
import {
  UP_AXES,
  lengthText,
  nameFromFile,
  packIdFor,
  previewModel,
  scaleOf,
  setupProblem,
  sizeHint,
  sizeMetres,
  sizeText,
  startSetup,
  type ModelInfo,
  type ModelPreview,
  type UpAxis,
} from './model';
import { isModelReport, makeSummaryLine, type MakeReport } from './report';

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** One made-up triangle in a box 2 by 3 by 1 model units: (0, 0, 0), (2, 0, 0), (0, 3, 1). */
const preview: ModelPreview = {
  triangles: 1,
  min: [0, 0, 0],
  max: [2, 3, 1],
  positions: base64(
    new Uint8Array(new Uint16Array([0, 0, 0, 65535, 0, 0, 0, 65535, 65535]).buffer),
  ),
  colours: base64(new Uint8Array([200, 60, 40])),
  simplified: false,
};

/** The corners of a preview as the Adjust floors view reads them: x east, height, z north. */
function corners(model: ReturnType<typeof previewModel>): number[][] {
  const bytes = fromBase64(model.positions);
  const steps = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const out: number[][] = [];
  for (let i = 0; i < steps.length; i += 3) {
    out.push(
      [0, 1, 2].map(
        (k) =>
          Math.round(
            (model.min[k]! + (steps[i + k]! / 65535) * (model.max[k]! - model.min[k]!)) * 1000,
          ) /
            1000 +
          0,
      ),
    );
  }
  return out;
}

const info: ModelInfo = {
  format: 'obj',
  formatName: 'OBJ',
  triangles: 216,
  parts: 4,
  materials: 4,
  texturedMaterials: 1,
  texturesFound: 1,
  hasColours: true,
  up: '+y',
  sidesGiven: false,
  min: [-7, -0.2, -16],
  max: [23, 7.3, 6],
  missingFiles: [],
  warnings: [],
};

describe('a 3D model’s setup', () => {
  it('turns each up axis without mirroring, as the helper does', () => {
    const unit: Record<string, number[]> = {
      '+x': [1, 0, 0],
      '-x': [-1, 0, 0],
      '+y': [0, 1, 0],
      '-y': [0, -1, 0],
      '+z': [0, 0, 1],
      '-z': [0, 0, -1],
    };
    const cross = (a: number[], b: number[]) => [
      a[1]! * b[2]! - a[2]! * b[1]!,
      a[2]! * b[0]! - a[0]! * b[2]!,
      a[0]! * b[1]! - a[1]! * b[0]!,
    ];
    for (const [up, [east, north, height]] of Object.entries(UP_AXES)) {
      expect(height).toBe(up);
      expect(cross(unit[east]!, unit[north]!).map((v) => v + 0)).toEqual(unit[height]);
    }
  });

  it('makes pack ids and names as the helper does', () => {
    expect(packIdFor('Made-up House')).toBe('made-up-house');
    expect(packIdFor('Château d’Été 2')).toBe('chateau-d-ete-2');
    expect(packIdFor('   ')).toBe('model-map');
    expect(packIdFor('a'.repeat(100))).toBe('a'.repeat(64));
    expect(nameFromFile('C:\\Users\\Someone\\3D Models\\old_mill-v2.glb')).toBe('old mill v2');
    expect(nameFromFile('house.obj')).toBe('house');
    expect(nameFromFile('.glb')).toBe('Model');
  });

  it('gives the size in metres for the units and up axis chosen', () => {
    expect(scaleOf('centimetres', 5)).toBe(0.01);
    expect(scaleOf('feet', 5)).toBe(0.3048);
    expect(scaleOf('custom', 5)).toBe(5);
    expect(sizeMetres(info, '+y', 1)).toEqual([30, 22, 7.5]);
    expect(sizeText(sizeMetres(info, '+y', 1))).toBe('30 × 22 m, 7.5 m high');
    expect(sizeMetres(info, '+z', 1)).toEqual([30, 7.5, 22]);
    const [east, north, height] = sizeMetres(info, '+y', 0.001);
    expect([east, north, height].map((v) => Math.round(v * 1000) / 1000)).toEqual([
      0.03, 0.022, 0.008,
    ]);
    expect(lengthText(0.004)).toBe('4 mm');
    expect(lengthText(1234.4)).toBe('1,234 m');
    expect(sizeHint([30, 22, 7.5])).toBeNull();
    expect(sizeHint([30000, 22000, 7500])).toMatch(/centimetres or millimetres/);
    expect(sizeHint([0.03, 0.022, 0.0075])).toMatch(/very small/);
  });

  it('starts from the file’s name, its usual up axis, and textured when it has colours', () => {
    const setup = startSetup('house.obj', info, 'outlines');
    expect(setup).toMatchObject({
      name: 'house',
      title: 'house',
      up: '+y',
      scale: 1,
      units: 'metres',
      floors: 'ground',
      doubleSided: 'auto',
      mapStyle: 'textured',
    });
    const grey = startSetup(
      'part.stl',
      { ...info, up: '+z', hasColours: false, texturesFound: 0 },
      'outlines',
    );
    expect(grey.up).toBe('+z');
    expect(grey.mapStyle).toBe('outlines');
    expect(setupProblem(setup)).toBeNull();
    expect(setupProblem({ ...setup, name: ' ' })).toMatch(/name/);
    expect(setupProblem({ ...setup, scale: Number.NaN })).toMatch(/scale/);
    expect(setupProblem({ ...setup, floorSeparation: 0.1 })).toMatch(/separation/);
    expect(setupProblem({ ...setup, mergeGap: 30 })).toMatch(/merge gap/);
  });

  it('turns and scales the preview as the map will hold it', () => {
    const zUp = previewModel(preview, '+z', 2);
    expect(zUp.min).toEqual([0, 0, 0]);
    expect(zUp.max).toEqual([4, 2, 6]);
    expect(corners(zUp)).toEqual([
      [0, 0, 0],
      [4, 0, 0],
      [0, 2, 6],
    ]);
    expect(zUp.colours).toBe(preview.colours);
    // Y up: north is the model's -z.
    const yUp = previewModel(preview, '+y', 1);
    expect(yUp.min).toEqual([0, 0, -1]);
    expect(yUp.max).toEqual([2, 3, 0]);
    expect(corners(yUp)).toEqual([
      [0, 0, 0],
      [2, 0, 0],
      [0, 3, -1],
    ]);
    for (const up of Object.keys(UP_AXES) as UpAxis[]) {
      expect(previewModel(preview, up, 1).triangles).toBe(1);
    }
  });
});

describe('a map made from a 3D model', () => {
  it('says what was made and that locations are added in Atlas', () => {
    const report = {
      kind: 'make',
      source: 'model',
      model: { file: 'house.obj' },
      game: { id: 'made-up-house', title: 'Made-up House', supported: true },
      summary: { floors: 3, threeD: { bytes: 2 * 1024 * 1024 } },
      areas: [],
    } as unknown as MakeReport;
    expect(isModelReport(report)).toBe(true);
    expect(makeSummaryLine(report)).toBe(
      '3 floors from house.obj, with its 3D model (2.0 MB). No locations: add them in Atlas with Edit locations.',
    );
    expect(isModelReport({ ...report, source: undefined })).toBe(false);
  });
});
