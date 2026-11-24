import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  HEIGHT_COLOURED_MATERIAL,
  mergeByMaterial,
  modelHeights,
  modelPaint,
  ownLookOf,
  writeFloorUniforms,
  writeLook,
} from './engine';
import { shadeRamp, SLOPE_SHADE, STRONG_SLOPE_SHADE } from './looks';
// The Map Maker names the material of a model it makes from collision.
import scenePy from '../../../../tools/gamefiles/atlas_gamefiles/scene.py?raw';

/** A made-up cell: a few triangles in each of the materials given, one mesh each. */
function cell(materials: THREE.Material[]): THREE.Group {
  const root = new THREE.Group();
  for (const material of materials) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0]), 3),
    );
    geometry.setAttribute(
      'normal',
      new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3),
    );
    geometry.setIndex([0, 2, 1, 0, 1, 3]);
    root.add(new THREE.Mesh(geometry, material));
  }
  return root;
}

/** What a material's program would be made of, as three.js hands it over before compiling it. */
function compiled(material: THREE.Material, lib: 'lambert' | 'basic') {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: THREE.ShaderLib[lib].vertexShader,
    fragmentShader: THREE.ShaderLib[lib].fragmentShader,
  };
  material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null!);
  return shader;
}

const texture = () => new THREE.DataTexture(new Uint8Array(4), 1, 1);

describe('the look of the model', () => {
  it('paints every material of a cell, and the insides of a cut, from one set of numbers', () => {
    const paint = modelPaint();
    const loaded = mergeByMaterial(
      cell([
        new THREE.MeshStandardMaterial({ name: 'stone', map: texture() }),
        new THREE.MeshStandardMaterial({ name: 'moss', color: 0x557744 }),
      ]),
      false,
      true,
      paint,
    );
    const materials = [...loaded.meshes, ...loaded.insides].map(
      (mesh) => mesh.material as THREE.Material,
    );
    expect(materials).toHaveLength(4);
    for (const material of materials) {
      // One program for all of them, whatever the look.
      expect(material.customProgramCacheKey()).toBe('atlas-model-paint');
    }
    const lit = compiled(materials[0]!, 'lambert');
    const inside = compiled(loaded.insides[0]!.material as THREE.Material, 'basic');
    for (const shader of [lit, inside]) {
      expect(shader.vertexShader).toContain('vPaintWorld = (modelMatrix');
      expect(shader.fragmentShader).toContain('if (lookShaded > 0.5)');
      expect(shader.fragmentShader).toContain('if (floorCount > 0)');
      expect(shader.fragmentShader.match(/#include <color_fragment>/g)).toHaveLength(1);
      // The very numbers the engine writes: switching looks needs no new program.
      expect(shader.uniforms.lookShaded).toBe(paint.lookShaded);
      expect(shader.uniforms.lookRamp).toBe(paint.lookRamp);
      expect(shader.uniforms.floorCount).toBe(paint.floorCount);
    }
    // The inside, darker.
    expect((inside.uniforms.paintTone!.value as THREE.Color).r).toBeLessThan(0.1);
    expect((lit.uniforms.paintTone!.value as THREE.Color).r).toBe(1);
  });

  it('switches between textured and shaded, and the colour, without touching the materials', () => {
    const paint = modelPaint();
    const loaded = mergeByMaterial(
      cell([new THREE.MeshStandardMaterial({ map: texture() })]),
      false,
      false,
      paint,
    );
    const material = loaded.meshes[0]!.material as THREE.MeshLambertMaterial;
    const version = material.version;
    const ramp = paint.lookRamp.value;
    expect(paint.lookShaded.value).toBe(0);

    writeLook(paint, { look: 'shaded', shade: 'teal', strong: false, heights: [-5, 20] });
    expect(paint.lookShaded.value).toBe(1);
    expect(paint.lookHeights.value.toArray()).toEqual([-5, 20]);
    // As the page shows the colours: the Map Maker's ramp, as it is.
    expect(ramp[0]!.toArray().map((value) => Math.round(value * 255))).toEqual([46, 72, 86]);
    expect(ramp[3]!.toArray().map((value) => Math.round(value * 255))).toEqual([172, 224, 210]);
    expect(paint.lookSlopes.value.toArray()).toEqual([SLOPE_SHADE[1]![1], SLOPE_SHADE[2]![1]]);

    writeLook(paint, { look: 'shaded', shade: '#336699', strong: true, heights: null });
    const own = shadeRamp('#336699')[2];
    expect(
      `#${ramp[2]!
        .toArray()
        .map((v) =>
          Math.round(v * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')}`,
    ).toBe(own);
    expect(paint.lookSlopes.value.toArray()).toEqual([
      STRONG_SLOPE_SHADE[1]![1],
      STRONG_SLOPE_SHADE[2]![1],
    ]);
    // Heights not known: the middle of the ramp.
    expect(paint.lookHeights.value.toArray()).toEqual([0, 0]);

    writeLook(paint, { look: 'textured', shade: 'sand', strong: false, heights: [0, 1] });
    expect(paint.lookShaded.value).toBe(0);
    // The same vectors, written over; the material never asked to be built again.
    expect(paint.lookRamp.value).toBe(ramp);
    expect(material.version).toBe(version);
    expect(material.map).not.toBeNull();
  });

  it('keeps Floor colours over either look', () => {
    const paint = modelPaint();
    writeLook(paint, { look: 'shaded', shade: 'light', strong: false, heights: [0, 10] });
    writeFloorUniforms(paint, [{ low: 0, high: 5, color: '#0072b2' }]);
    expect(paint.floorCount.value).toBe(1);
    expect(paint.lookShaded.value).toBe(1);
    writeFloorUniforms(paint, []);
    expect(paint.floorCount.value).toBe(0);
    expect(paint.lookShaded.value).toBe(1);
  });

  it('tells a model with textures or colours of its own from one coloured only by height', () => {
    const own = (material: THREE.Material) => mergeByMaterial(cell([material])).ownLook;
    expect(own(new THREE.MeshStandardMaterial({ map: texture() }))).toBe(true);
    expect(own(new THREE.MeshStandardMaterial({ color: 0x8c8c8c }))).toBe(true);
    // White, coloured in its vertices: a model's own colours...
    expect(own(new THREE.MeshStandardMaterial({ name: 'stone', vertexColors: true }))).toBe(true);
    // ...but for the Map Maker's model of a game's collision, coloured by height.
    const collision = { name: HEIGHT_COLOURED_MATERIAL, vertexColors: true };
    expect(own(new THREE.MeshStandardMaterial(collision))).toBe(false);
    expect(scenePy).toContain(`"materials": [{"name": "${HEIGHT_COLOURED_MATERIAL}"`);
    expect(ownLookOf(new THREE.MeshLambertMaterial())).toBe(false);
    expect(
      mergeByMaterial(
        cell([
          new THREE.MeshStandardMaterial(collision),
          new THREE.MeshStandardMaterial({ map: texture() }),
        ]),
      ).ownLook,
    ).toBe(true);
  });

  it('runs the shade over the model’s heights, else its cells’', () => {
    const lods = [{ level: 0, file: 'scene/a/lod0.glb' }];
    const bounds: [number, number, number, number] = [0, 0, 10, 10];
    expect(modelHeights({ heights: [-3, 9], cells: [] })).toEqual([-3, 9]);
    expect(
      modelHeights({
        cells: [
          { id: 'a', bounds, lods, heights: [2, 4] },
          { id: 'b', bounds, lods },
          { id: 'c', bounds, lods, heights: [-1, 3] },
        ],
      }),
    ).toEqual([-1, 4]);
    expect(modelHeights({ cells: [{ id: 'a', bounds, lods }] })).toBeNull();
  });
});
