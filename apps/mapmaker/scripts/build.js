// @ts-check
/**
 * `pnpm --filter @atlas/mapmaker desktop:build`: builds Atlas Map Maker with its helper and its 3D builder.
 *
 * The helper is the single-file `atlas-gamefiles` program built from tools/gamefiles with PyInstaller (see the
 * README there); the 3D builder is the `atlas-scene` program built from crates/atlas-scene. This script copies each
 * to `src-tauri/binaries/<name>-<target triple>[.exe]`, the name Tauri expects for a sidecar, then runs `tauri
 * build` with `src-tauri/tauri.build.conf.json`, which lists both under `bundle.externalBin`, so the installer puts
 * them next to the app. Plain `cargo` builds and tests do not read that file, so they need neither.
 *
 *   ATLAS_GAMEFILES_HELPER=tools/gamefiles/dist/atlas-gamefiles.exe pnpm --filter @atlas/mapmaker desktop:build
 *
 * Without ATLAS_GAMEFILES_HELPER, the helper is taken from tools/gamefiles/dist/. Without ATLAS_SCENE_BUILDER, the
 * 3D builder is built here (`cargo build --release --locked` in crates/atlas-scene). Other arguments are passed on
 * to `tauri build`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (/** @type {string} */ path) => fileURLToPath(new URL(path, import.meta.url));
const repoRoot = here('../../../');

/**
 * The file name Tauri looks for: `atlas-gamefiles-x86_64-pc-windows-msvc.exe`. Exported for tests.
 * @param {string} triple
 * @param {string} [name]
 */
export function sidecarName(triple, name = 'atlas-gamefiles') {
  if (!/^[a-z0-9_]+(-[a-z0-9_]+){2,3}$/.test(triple)) {
    throw new Error(`"${triple}" is not a target triple like x86_64-pc-windows-msvc.`);
  }
  return `${name}-${triple}${triple.includes('windows') ? '.exe' : ''}`;
}

/**
 * The host's target triple, from `rustc -vV`. Exported for tests.
 * @param {string} rustcOutput
 */
export function hostTriple(rustcOutput) {
  const match = /^host:\s*(\S+)$/m.exec(rustcOutput);
  if (!match?.[1]) throw new Error('rustc -vV printed no host line.');
  return match[1];
}

/**
 * The arguments for `tauri build`. Exported for tests.
 * @param {string[]} extra
 */
export function tauriArgs(extra) {
  return [
    'build',
    '--config',
    'src-tauri/tauri.build.conf.json',
    ...extra.filter((arg) => arg !== '--'),
  ];
}

/**
 * Where the built helper is: ATLAS_GAMEFILES_HELPER (relative to the repository root), or tools/gamefiles/dist/.
 * Exported for tests.
 * @param {string | undefined} value
 * @param {NodeJS.Platform} platform
 */
export function helperSource(value, platform) {
  const path = value?.trim();
  if (path) return isAbsolute(path) ? path : resolve(repoRoot, path);
  return join(
    repoRoot,
    'tools',
    'gamefiles',
    'dist',
    `atlas-gamefiles${platform === 'win32' ? '.exe' : ''}`,
  );
}

/**
 * Where the 3D builder is: ATLAS_SCENE_BUILDER (relative to the repository root), or null to build it in
 * crates/atlas-scene. Exported for tests.
 * @param {string | undefined} value
 */
export function sceneBuilderSource(value) {
  const path = value?.trim();
  if (!path) return null;
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

/**
 * Where `cargo build --release` in crates/atlas-scene puts the 3D builder. Exported for tests.
 * @param {NodeJS.Platform} platform
 */
export function builtSceneBuilder(platform) {
  return join(
    repoRoot,
    'crates',
    'atlas-scene',
    'target',
    'release',
    `atlas-scene${platform === 'win32' ? '.exe' : ''}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const triple =
    process.env.TAURI_ENV_TARGET_TRIPLE ??
    hostTriple(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }));
  const source = helperSource(process.env.ATLAS_GAMEFILES_HELPER, process.platform);
  await stat(source).catch(() => {
    throw new Error(
      `No helper at ${source}. Build it first (see tools/gamefiles/README.md), or set ATLAS_GAMEFILES_HELPER.`,
    );
  });
  const binaries = here('../src-tauri/binaries/');
  await mkdir(binaries, { recursive: true });
  const target = join(binaries, sidecarName(triple));
  await copyFile(source, target);
  await chmod(target, 0o755);
  console.log(`Helper: ${source} -> ${target}`);
  let builder = sceneBuilderSource(process.env.ATLAS_SCENE_BUILDER);
  if (!builder) {
    execFileSync(
      'cargo',
      [
        'build',
        '--release',
        '--locked',
        '--manifest-path',
        join(repoRoot, 'crates', 'atlas-scene', 'Cargo.toml'),
      ],
      { stdio: 'inherit' },
    );
    builder = builtSceneBuilder(process.platform);
  }
  await stat(builder).catch(() => {
    throw new Error(
      `No 3D builder at ${builder}. Build it in crates/atlas-scene, or set ATLAS_SCENE_BUILDER.`,
    );
  });
  const builderTarget = join(binaries, sidecarName(triple, 'atlas-scene'));
  await copyFile(builder, builderTarget);
  await chmod(builderTarget, 0o755);
  console.log(`3D builder: ${builder} -> ${builderTarget}`);
  const child = spawn('tauri', tauriArgs(process.argv.slice(2)), {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
