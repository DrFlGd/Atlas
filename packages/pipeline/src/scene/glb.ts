import { MeshoptEncoder } from 'meshoptimizer';

/**
 * A small writer of glTF 2.0 binary files (`.glb`), for the models of the
 * demo's 3D map: triangle meshes with positions, normals and vertex
 * colours, plain materials (a colour, how rough, whether both sides are
 * drawn) and nodes that place the meshes. With `compress`, the buffers are
 * written with EXT_meshopt_compression, as a pack's models may be.
 */

export interface GlbMaterial {
  name: string;
  /** Linear RGBA, 0 to 1. Multiplied with the vertex colours when a primitive has them. */
  color: readonly [number, number, number, number];
  roughness: number;
  metallic?: number;
  doubleSided?: boolean;
}

export interface GlbPrimitive {
  /** x, y, z per vertex. */
  positions: Float32Array;
  /** Unit x, y, z per vertex. */
  normals: Float32Array;
  /** RGBA per vertex, 0 to 255 (sRGB as glTF reads vertex colours: linear); none for plain. */
  colors?: Uint8Array;
  /** Three per triangle. */
  indices: Uint16Array | Uint32Array;
  /** Index into the file's materials. */
  material: number;
}

export interface GlbMesh {
  name: string;
  primitives: GlbPrimitive[];
}

export interface GlbNode {
  name: string;
  mesh: number;
  translation?: readonly [number, number, number];
}

export interface GlbModel {
  materials: GlbMaterial[];
  meshes: GlbMesh[];
  nodes: GlbNode[];
}

export interface GlbOptions {
  /** Write the buffers with EXT_meshopt_compression. */
  compress?: boolean;
}

/** The triangles of a model. */
export function triangleCount(model: GlbModel): number {
  return model.meshes.reduce(
    (sum, mesh) => sum + mesh.primitives.reduce((n, p) => n + p.indices.length / 3, 0),
    0,
  );
}

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

interface View {
  bytes: Uint8Array;
  /** Bytes per element (a vertex's attribute, or an index). */
  stride: number;
  count: number;
  target: number;
  mode: 'ATTRIBUTES' | 'TRIANGLES';
}

const pad4 = (n: number) => (n + 3) & ~3;

/** Writes a model as a `.glb` file. */
export async function writeGlb(model: GlbModel, options: GlbOptions = {}): Promise<Buffer> {
  const compress = options.compress ?? false;
  if (compress) await MeshoptEncoder.ready;
  const views: View[] = [];
  const accessors: Record<string, unknown>[] = [];
  const view = (data: ArrayBufferView, stride: number, count: number, target: number) => {
    views.push({
      bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      stride,
      count,
      target,
      mode: target === ARRAY_BUFFER ? 'ATTRIBUTES' : 'TRIANGLES',
    });
    return views.length - 1;
  };
  const accessor = (fields: Record<string, unknown>) => {
    accessors.push(fields);
    return accessors.length - 1;
  };

  const meshes = model.meshes.map((mesh) => ({
    name: mesh.name,
    primitives: mesh.primitives.map((primitive) => {
      const count = primitive.positions.length / 3;
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < primitive.positions.length; i++) {
        const value = primitive.positions[i]!;
        min[i % 3] = Math.min(min[i % 3]!, value);
        max[i % 3] = Math.max(max[i % 3]!, value);
      }
      const attributes: Record<string, number> = {
        POSITION: accessor({
          bufferView: view(primitive.positions, 12, count, ARRAY_BUFFER),
          componentType: FLOAT,
          count,
          type: 'VEC3',
          min,
          max,
        }),
        NORMAL: accessor({
          bufferView: view(primitive.normals, 12, count, ARRAY_BUFFER),
          componentType: FLOAT,
          count,
          type: 'VEC3',
        }),
      };
      if (primitive.colors) {
        attributes.COLOR_0 = accessor({
          bufferView: view(primitive.colors, 4, count, ARRAY_BUFFER),
          componentType: UNSIGNED_BYTE,
          normalized: true,
          count,
          type: 'VEC4',
        });
      }
      const wide = primitive.indices instanceof Uint32Array;
      // An index buffer of 16-bit indices is padded to 4 bytes (glTF aligns views).
      let indices: Uint16Array | Uint32Array = primitive.indices;
      if (!wide && indices.length % 2 === 1) {
        const padded = new Uint16Array(indices.length + 1);
        padded.set(indices);
        indices = padded;
      }
      const indexView = view(indices, wide ? 4 : 2, primitive.indices.length, ELEMENT_ARRAY_BUFFER);
      return {
        attributes,
        indices: accessor({
          bufferView: indexView,
          componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT,
          count: primitive.indices.length,
          type: 'SCALAR',
        }),
        material: primitive.material,
        mode: 4,
      };
    }),
  }));

  // The bytes of the file's buffer, and its views.
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const place = (bytes: Uint8Array) => {
    const at = offset;
    chunks.push(bytes);
    offset += bytes.length;
    const padding = pad4(offset) - offset;
    if (padding > 0) {
      chunks.push(new Uint8Array(padding));
      offset += padding;
    }
    return at;
  };
  let fallbackLength = 0;
  const bufferViews = views.map((v) => {
    const byteLength = v.mode === 'TRIANGLES' ? v.count * v.stride : v.bytes.length;
    const stride = v.target === ARRAY_BUFFER ? { byteStride: v.stride } : {};
    if (!compress) {
      const at = place(v.bytes.subarray(0, pad4(byteLength)));
      return { buffer: 0, byteOffset: at, byteLength, target: v.target, ...stride };
    }
    const encoded = MeshoptEncoder.encodeGltfBuffer(
      v.bytes.subarray(0, v.count * v.stride),
      v.count,
      v.stride,
      v.mode,
    );
    const at = place(encoded);
    const fallbackAt = fallbackLength;
    fallbackLength += pad4(byteLength);
    return {
      buffer: 1,
      byteOffset: fallbackAt,
      byteLength,
      target: v.target,
      ...stride,
      extensions: {
        EXT_meshopt_compression: {
          buffer: 0,
          byteOffset: at,
          byteLength: encoded.length,
          byteStride: v.stride,
          count: v.count,
          mode: v.mode,
        },
      },
    };
  });

  const json = {
    asset: { version: '2.0', generator: 'Atlas demo pack' },
    ...(compress
      ? {
          extensionsUsed: ['EXT_meshopt_compression'],
          extensionsRequired: ['EXT_meshopt_compression'],
        }
      : {}),
    scene: 0,
    scenes: [{ nodes: model.nodes.map((_, i) => i) }],
    nodes: model.nodes.map((node) => ({
      name: node.name,
      mesh: node.mesh,
      ...(node.translation ? { translation: [...node.translation] } : {}),
    })),
    meshes,
    materials: model.materials.map((material) => ({
      name: material.name,
      pbrMetallicRoughness: {
        baseColorFactor: [...material.color],
        metallicFactor: material.metallic ?? 0,
        roughnessFactor: material.roughness,
      },
      ...(material.doubleSided ? { doubleSided: true } : {}),
    })),
    accessors,
    bufferViews,
    buffers: [
      { byteLength: offset },
      ...(compress
        ? [
            {
              byteLength: fallbackLength,
              extensions: { EXT_meshopt_compression: { fallback: true } },
            },
          ]
        : []),
    ],
  };

  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonLength = pad4(jsonBytes.length);
  const binLength = offset;
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = Buffer.alloc(total);
  out.write('glTF', 0, 'latin1');
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonLength, 12);
  out.write('JSON', 16, 'latin1');
  jsonBytes.copy(out, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);
  const binAt = 20 + jsonLength;
  out.writeUInt32LE(binLength, binAt);
  out.write('BIN\0', binAt + 4, 'latin1');
  let at = binAt + 8;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** The JSON chunk of a `.glb` file, for tests. */
export function readGlbJson(file: Buffer): Record<string, unknown> {
  if (file.toString('latin1', 0, 4) !== 'glTF') throw new Error('not a glb');
  const length = file.readUInt32LE(12);
  return JSON.parse(file.toString('utf8', 20, 20 + length).trimEnd()) as Record<string, unknown>;
}
