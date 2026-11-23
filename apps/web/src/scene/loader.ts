import type { WebGLRenderer } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/**
 * Reads the model files of a 3D map: glTF 2.0 in `.glb` files, with their
 * meshes compressed by EXT_meshopt_compression or not, and their textures
 * packed with KHR_texture_basisu (KTX2) or as PNG and JPEG. The decoders
 * come with the app: the meshopt decoder is in the code, and the Basis
 * transcoder (`basis_transcoder.js` and `.wasm`) is emitted with the build
 * where three.js names it, so nothing is fetched from elsewhere.
 */
export interface ModelLoader {
  load(url: string): Promise<GLTF>;
  dispose(): void;
}

export function modelLoader(renderer: WebGLRenderer): ModelLoader {
  const ktx2 = new KTX2Loader().detectSupport(renderer);
  const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
  return {
    load: (url) => gltf.loadAsync(url),
    dispose: () => {
      ktx2.dispose();
    },
  };
}
