import { deviceClass, sceneBudget, type DeviceSignals } from '@atlas/core';
import * as THREE from 'three';

/**
 * The 3D trial (Settings › 3D trial): a made-up scene, heavier at each
 * step in triangles and in texture memory, drawn for a while at each step
 * to measure the frames a second. It stops when frames come too slowly,
 * when the graphics give up, or after the last step; its report says what
 * this device held, so the budgets of the 3D view (`SCENE_BUDGETS` in
 * `@atlas/core`) can be set from what devices really do.
 */

export interface TrialStep {
  triangles: number;
  textureBytes: number;
  /** Frames a second, from the median time between frames. */
  fps: number;
  medianMs: number;
  /** The slowest 5% of frames. */
  slowMs: number;
  /** The page's own memory where the browser says it, in bytes. */
  heapBytes: number | null;
}

export interface TrialResult {
  steps: TrialStep[];
  /** Why it stopped. */
  ended: 'done' | 'slow' | 'lost' | 'stopped' | 'failed';
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
/** Blocks and textures at each step. */
const STEPS: readonly { blocks: number; textures: number }[] = [
  { blocks: 1, textures: 4 },
  { blocks: 2, textures: 8 },
  { blocks: 4, textures: 16 },
  { blocks: 8, textures: 32 },
  { blocks: 12, textures: 64 },
  { blocks: 16, textures: 128 },
];
const STEP_MS = 2500;
/** Slower than this, the trial stops: the step before is what the device holds. */
const STOP_FPS = 20;

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
  const col = index % 4;
  const row = Math.floor(index / 4);
  geometry.translate((col - 1.5) * 42, 0, (row - 1.5) * 42);
  return geometry;
}

function texture(index: number): THREE.DataTexture {
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
  const out = new THREE.DataTexture(data, TEXTURE_SIDE, TEXTURE_SIDE);
  out.generateMipmaps = true;
  out.minFilter = THREE.LinearMipmapLinearFilter;
  out.colorSpace = THREE.SRGBColorSpace;
  out.needsUpdate = true;
  return out;
}

function heap(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null;
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
  const textures: THREE.DataTexture[] = [];
  const tiles: THREE.Mesh[] = [];
  const tileGeometry = new THREE.PlaneGeometry(6, 6);
  tileGeometry.rotateX(-Math.PI / 2);
  const steps: TrialStep[] = [];
  let ended: TrialResult['ended'] = 'done';
  const graphics = graphicsName(renderer);
  const maxTextureSize = renderer.capabilities.maxTextureSize;

  try {
    for (let s = 0; s < STEPS.length; s++) {
      const want = STEPS[s]!;
      while (blocks.length < want.blocks) {
        const mesh = new THREE.Mesh(
          block(blocks.length),
          new THREE.MeshLambertMaterial({ color: 0x6f8f55 }),
        );
        scene.add(mesh);
        blocks.push(mesh);
      }
      while (textures.length < want.textures) {
        const map = texture(textures.length);
        textures.push(map);
        const tile = new THREE.Mesh(tileGeometry, new THREE.MeshLambertMaterial({ map }));
        const i = tiles.length;
        tile.position.set(
          ((i % 16) - 7.5) * 7,
          3 + Math.floor(i / 16) * 0.5,
          -90 + Math.floor(i / 16) * 7,
        );
        scene.add(tile);
        tiles.push(tile);
      }
      const triangles = blocks.length * BLOCK_TRIANGLES;
      const textureBytes = textures.length * TEXTURE_BYTES;
      onProgress({ step: s + 1, steps: STEPS.length, triangles, textureBytes });
      const times = await new Promise<number[]>((resolve) => {
        const frames: number[] = [];
        const start = performance.now();
        let last = 0;
        const frame = (now: number) => {
          if (signal.aborted || graphicsState.lost || now - start > STEP_MS) {
            resolve(frames);
            return;
          }
          const angle = (now - start) / 1600 + s;
          camera.position.set(Math.sin(angle) * 120, 70, Math.cos(angle) * 120);
          camera.lookAt(0, 0, -20);
          renderer.render(scene, camera);
          // The first frames upload what is new: they are not counted.
          if (last > 0 && now - start > 400) frames.push(now - last);
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
      steps.push({ triangles, textureBytes, fps, medianMs, slowMs, heapBytes: heap() });
      if (fps < STOP_FPS) {
        ended = 'slow';
        break;
      }
    }
  } catch {
    ended = 'failed';
  } finally {
    canvas.removeEventListener('webglcontextlost', onLost);
    for (const mesh of blocks) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    for (const tile of tiles) (tile.material as THREE.Material).dispose();
    tileGeometry.dispose();
    for (const map of textures) map.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  }
  return { steps, ended, graphics, maxTextureSize };
}

const count = new Intl.NumberFormat('en');
const mb = (bytes: number) => `${count.format(Math.round(bytes / (1 << 20)))} MB`;

const ENDED: Record<TrialResult['ended'], string> = {
  done: 'It went through every step.',
  slow: `It stopped when frames came slower than ${STOP_FPS} a second.`,
  lost: 'It stopped when the graphics gave up (the WebGL context was lost).',
  stopped: 'It was stopped before the end.',
  failed: 'It could not run: this device cannot show the 3D view.',
};

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
        `${step.fps} frames a second (median ${step.medianMs.toFixed(1)} ms, slowest 5% ${step.slowMs.toFixed(1)} ms)` +
        (step.heapBytes === null ? '' : `, page memory ${mb(step.heapBytes)}`),
    ),
    '',
    ENDED[result.ended],
  ];
  const held = [...result.steps].reverse().find((step) => step.fps >= 30);
  lines.push(
    held
      ? `Held 30 frames a second or more up to ${count.format(held.triangles)} triangles and ${mb(held.textureBytes)} of textures.`
      : 'Did not hold 30 frames a second at any step.',
  );
  return `${lines.join('\n')}\n`;
}
