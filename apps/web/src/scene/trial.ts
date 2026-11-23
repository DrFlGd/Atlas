import { deviceClass, sceneBudget, type DeviceSignals } from '@atlas/core';
import * as THREE from 'three';

/**
 * The 3D trial (Settings › 3D trial): a made-up scene, heavier at each
 * step in triangles and in texture memory (from 250,000 triangles and
 * 21 MB of textures to 16 million and 1.7 GB), drawn for a while at each
 * step to measure the frames a second. It stops when frames come too
 * slowly, when a step fails or the graphics give up, or after the last
 * step; its report says what this device held, so the budgets of the 3D
 * view (`SCENE_BUDGETS` in `@atlas/core`) can be set from what devices
 * really do.
 *
 * Every block of ground is a geometry of its own and every texture a
 * texture of its own on the graphics side, as a real map's would be; the
 * page lets go of its copy of a block once it is uploaded, and its
 * textures share a few sets of pixels, so the page itself stays small
 * while the graphics side grows.
 */

export interface TrialStep {
  triangles: number;
  textureBytes: number;
  /** Frames a second, from the median time between frames. */
  fps: number;
  medianMs: number;
  /** The slowest 5% of frames. */
  slowMs: number;
  /** Bytes of geometry the trial gave the graphics side (vertices and indices). */
  geometryBytes: number;
  /** Geometries and textures the renderer holds (`renderer.info.memory`). */
  geometries: number;
  textures: number;
}

export interface TrialResult {
  steps: TrialStep[];
  /** Why it stopped: `failed` with no steps means it could not start. */
  ended: 'done' | 'slow' | 'lost' | 'stopped' | 'failed';
  /** What went wrong, when a step failed. */
  failure?: string;
  graphics: string;
  maxTextureSize: number;
}

export interface TrialProgress {
  step: number;
  steps: number;
  triangles: number;
  textureBytes: number;
}

/** Triangles of one block of ground; the steps add blocks. */
const BLOCK_TRIANGLES = 250_000;
const TEXTURE_SIDE = 1024;
/** Bytes of one texture with its smaller copies (mipmaps). */
const TEXTURE_BYTES = Math.round(TEXTURE_SIDE * TEXTURE_SIDE * 4 * (4 / 3));
/** Blocks and textures at each step: 250,000 triangles to 16 million. */
export const TRIAL_STEPS: readonly { blocks: number; textures: number }[] = [
  { blocks: 1, textures: 4 },
  { blocks: 2, textures: 8 },
  { blocks: 4, textures: 16 },
  { blocks: 8, textures: 32 },
  { blocks: 12, textures: 64 },
  { blocks: 16, textures: 128 },
  { blocks: 24, textures: 160 },
  { blocks: 32, textures: 192 },
  { blocks: 48, textures: 256 },
  { blocks: 64, textures: 320 },
];
/** Blocks side by side in a row. */
const ROW = 8;
const SPACING = 42;
/** Sets of pixels the textures share (see the module). */
const PIXEL_SETS = 4;
const STEP_MS = 2500;
/** After a step's new blocks and textures are uploaded, frames before this are not counted. */
const SETTLE_MS = 300;
/** Slower than this, the trial stops: the step before is what the device holds. */
const STOP_FPS = 20;

/** Bytes of a geometry's vertices and indices. */
function geometryBytes(geometry: THREE.BufferGeometry): number {
  let bytes = geometry.index?.array.byteLength ?? 0;
  for (const attribute of Object.values(geometry.attributes)) {
    bytes += (attribute as THREE.BufferAttribute).array.byteLength;
  }
  return bytes;
}

/** Lets the page's copy of an attribute go once it is on the graphics side. */
function releaseOnUpload(geometry: THREE.BufferGeometry): void {
  const release = function (this: THREE.BufferAttribute) {
    (this as unknown as { array: ArrayLike<number> | null }).array = null;
  };
  geometry.index?.onUpload(release);
  for (const attribute of Object.values(geometry.attributes)) {
    (attribute as THREE.BufferAttribute).onUpload(release);
  }
}

function block(index: number): THREE.BufferGeometry {
  const side = Math.round(Math.sqrt(BLOCK_TRIANGLES / 2));
  const geometry = new THREE.PlaneGeometry(40, 40, side, side);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position!;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    position.setY(i, Math.sin(x * 0.4 + index) * Math.cos(z * 0.3) * 1.5);
  }
  geometry.computeVertexNormals();
  const col = index % ROW;
  const row = Math.floor(index / ROW);
  geometry.translate((col - (ROW - 1) / 2) * SPACING, 0, (row - (ROW - 1) / 2) * SPACING);
  geometry.computeBoundingSphere();
  return geometry;
}

function pixels(index: number): Uint8Array {
  const data = new Uint8Array(TEXTURE_SIDE * TEXTURE_SIDE * 4);
  for (let y = 0; y < TEXTURE_SIDE; y++) {
    for (let x = 0; x < TEXTURE_SIDE; x++) {
      const at = (y * TEXTURE_SIDE + x) * 4;
      const check = ((x >> 5) + (y >> 5) + index) & 1;
      data[at] = check ? 200 : 90 + ((index * 37) % 120);
      data[at + 1] = check ? 190 : 120;
      data[at + 2] = check ? 170 : 80 + ((index * 53) % 150);
      data[at + 3] = 255;
    }
  }
  return data;
}

function texture(data: Uint8Array): THREE.DataTexture {
  const out = new THREE.DataTexture(data, TEXTURE_SIDE, TEXTURE_SIDE);
  out.generateMipmaps = true;
  out.minFilter = THREE.LinearMipmapLinearFilter;
  out.colorSpace = THREE.SRGBColorSpace;
  out.needsUpdate = true;
  return out;
}

function graphicsName(renderer: THREE.WebGLRenderer): string {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = info
    ? (gl.getParameter(info.UNMASKED_RENDERER_WEBGL) as unknown)
    : (gl.getParameter(gl.RENDERER) as unknown);
  return typeof name === 'string' ? name : 'unknown';
}

/** Runs the trial in a container; `signal` stops it. */
export async function runTrial(
  container: HTMLElement,
  signals: DeviceSignals,
  onProgress: (progress: TrialProgress) => void,
  signal: AbortSignal,
): Promise<TrialResult> {
  const canvas = document.createElement('canvas');
  canvas.className = 'scene-canvas';
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
  } catch {
    return { steps: [], ended: 'failed', graphics: 'none (no WebGL 2)', maxTextureSize: 0 };
  }
  container.append(canvas);
  const budget = sceneBudget(signals);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, budget.maxPixelRatio));
  const box = container.getBoundingClientRect();
  renderer.setSize(Math.max(1, box.width), Math.max(1, box.height), false);
  const graphicsState = { lost: false };
  const onLost = (event: Event) => {
    event.preventDefault();
    graphicsState.lost = true;
  };
  canvas.addEventListener('webglcontextlost', onLost);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fb3d1);
  scene.add(new THREE.HemisphereLight(0xe4eef8, 0x5a5242, 1.1));
  const sun = new THREE.DirectionalLight(0xfff3df, 1.6);
  sun.position.set(-0.5, 1, -0.4);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(50, box.width / Math.max(1, box.height), 1, 1000);

  const blocks: THREE.Mesh[] = [];
  const blockMaterial = new THREE.MeshLambertMaterial({ color: 0x6f8f55 });
  const pixelSets: Uint8Array[] = [];
  let allocatedGeometry = 0;
  const textures: THREE.DataTexture[] = [];
  const tiles: THREE.Mesh[] = [];
  const tileGeometry = new THREE.PlaneGeometry(6, 6);
  tileGeometry.rotateX(-Math.PI / 2);
  const steps: TrialStep[] = [];
  let ended: TrialResult['ended'] = 'done';
  let failure: string | undefined;
  const graphics = graphicsName(renderer);
  const maxTextureSize = renderer.capabilities.maxTextureSize;

  try {
    for (let s = 0; s < TRIAL_STEPS.length; s++) {
      const want = TRIAL_STEPS[s]!;
      while (blocks.length < want.blocks) {
        const geometry = block(blocks.length);
        allocatedGeometry += geometryBytes(geometry);
        releaseOnUpload(geometry);
        const mesh = new THREE.Mesh(geometry, blockMaterial);
        // Drawn even when out of sight: every triangle of the step is sent each frame.
        mesh.frustumCulled = false;
        scene.add(mesh);
        blocks.push(mesh);
      }
      while (textures.length < want.textures) {
        if (pixelSets.length < PIXEL_SETS) pixelSets.push(pixels(pixelSets.length));
        const map = texture(pixelSets[textures.length % PIXEL_SETS]!);
        textures.push(map);
        const tile = new THREE.Mesh(tileGeometry, new THREE.MeshLambertMaterial({ map }));
        const i = tiles.length;
        tile.position.set(
          ((i % 16) - 7.5) * 7,
          3 + Math.floor(i / 16) * 0.5,
          -90 - Math.floor(i / 16) * 7,
        );
        tile.frustumCulled = false;
        scene.add(tile);
        tiles.push(tile);
      }
      const triangles = blocks.length * BLOCK_TRIANGLES;
      const textureBytes = textures.length * TEXTURE_BYTES;
      onProgress({ step: s + 1, steps: TRIAL_STEPS.length, triangles, textureBytes });
      // Far enough to see every block of the step.
      const rows = Math.ceil(blocks.length / ROW);
      const reach = Math.max(120, Math.max(Math.min(blocks.length, ROW), rows) * SPACING * 0.9);
      const times = await new Promise<number[]>((resolve, reject) => {
        const frames: number[] = [];
        const start = performance.now();
        let last = 0;
        const frame = (now: number) => {
          if (signal.aborted || graphicsState.lost || now - start > STEP_MS + SETTLE_MS) {
            resolve(frames);
            return;
          }
          try {
            const angle = (now - start) / 1600 + s;
            camera.position.set(Math.sin(angle) * reach, reach * 0.6, Math.cos(angle) * reach);
            camera.far = reach * 4;
            camera.updateProjectionMatrix();
            camera.lookAt(0, 0, -20);
            renderer.render(scene, camera);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          // The first frames upload what is new: they are not counted.
          if (last > 0 && now - start > SETTLE_MS) frames.push(now - last);
          last = now;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      if (signal.aborted) {
        ended = 'stopped';
        break;
      }
      if (graphicsState.lost) {
        ended = 'lost';
        break;
      }
      const sorted = [...times].sort((a, b) => a - b);
      const medianMs = sorted[Math.floor(sorted.length / 2)] ?? STEP_MS;
      const slowMs = sorted[Math.floor(sorted.length * 0.95)] ?? medianMs;
      const fps = Math.round(1000 / medianMs);
      const memory = renderer.info.memory;
      steps.push({
        triangles,
        textureBytes,
        fps,
        medianMs,
        slowMs,
        geometryBytes: allocatedGeometry,
        geometries: memory.geometries,
        textures: memory.textures,
      });
      if (fps < STOP_FPS) {
        ended = 'slow';
        break;
      }
    }
  } catch (error) {
    ended = 'failed';
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    canvas.removeEventListener('webglcontextlost', onLost);
    for (const mesh of blocks) mesh.geometry.dispose();
    blockMaterial.dispose();
    for (const tile of tiles) (tile.material as THREE.Material).dispose();
    tileGeometry.dispose();
    for (const map of textures) map.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  }
  return { steps, ended, graphics, maxTextureSize, ...(failure ? { failure } : {}) };
}

const count = new Intl.NumberFormat('en');
const mb = (bytes: number) => `${count.format(Math.round(bytes / (1 << 20)))} MB`;

const ENDED: Record<TrialResult['ended'], string> = {
  done: 'It went through every step.',
  slow: `It stopped when frames came slower than ${STOP_FPS} a second.`,
  lost: 'It stopped when the graphics gave up (the WebGL context was lost).',
  stopped: 'It was stopped before the end.',
  failed: 'A step failed.',
};

/** Why it stopped, in a sentence. */
function endedText(result: TrialResult): string {
  if (result.ended !== 'failed') return ENDED[result.ended];
  if (result.steps.length === 0) return 'It could not run: this device cannot show the 3D view.';
  return `Step ${result.steps.length + 1} failed${result.failure ? ` (${result.failure})` : ''}.`;
}

/** The report: plain text, short, to keep or to send. */
export function trialReport(
  result: TrialResult,
  signals: DeviceSignals,
  app: { name: string; version: string } | null,
  when: Date,
): string {
  const budget = sceneBudget(signals);
  const lines = [
    `${app?.name ?? 'Atlas'} 3D trial`,
    `Date: ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `App: ${app ? `${app.name} ${app.version}` : 'Atlas (in a browser)'}, system: ${signals.platform ?? 'browser'}`,
    `Device: ${deviceClass(signals)}; screen ${signals.screenWidth} × ${signals.screenHeight}; ` +
      `touch screen: ${signals.coarsePointer ? 'yes' : 'no'}; memory: ${
        signals.deviceMemory === undefined ? 'not said' : `${signals.deviceMemory} GB`
      }; pixel ratio ${window.devicePixelRatio || 1}`,
    `Graphics: ${result.graphics}; largest texture ${result.maxTextureSize}`,
    `The 3D view's budget here: ${count.format(budget.triangles)} triangles, ${mb(budget.textureBytes)} of textures`,
    '',
    'Steps:',
    ...result.steps.map(
      (step, i) =>
        `${i + 1}. ${count.format(step.triangles)} triangles, ${mb(step.textureBytes)} of textures: ` +
        `${step.fps} frames a second (median ${step.medianMs.toFixed(1)} ms, slowest 5% ${step.slowMs.toFixed(1)} ms); ` +
        `graphics memory given ${mb(step.geometryBytes + step.textureBytes)} ` +
        `(geometry ${mb(step.geometryBytes)}, textures ${mb(step.textureBytes)}; ` +
        `the renderer holds ${count.format(step.geometries)} geometries and ${count.format(step.textures)} textures)`,
    ),
    '',
    endedText(result),
  ];
  const held = [...result.steps].reverse().find((step) => step.fps >= 30);
  lines.push(
    held
      ? `Held 30 frames a second or more up to ${count.format(held.triangles)} triangles and ${mb(held.textureBytes)} of textures.`
      : 'Did not hold 30 frames a second at any step.',
  );
  return `${lines.join('\n')}\n`;
}
