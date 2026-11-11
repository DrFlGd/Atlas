// @ts-check
/**
 * `pnpm --filter @atlas/mapmaker desktop:build`: builds Atlas Map Maker with its helper.
 *
 * The helper is the single-file `atlas-gamefiles` program built from tools/gamefiles with PyInstaller (see the
 * README there). This script copies it to `src-tauri/binaries/atlas-gamefiles-<target triple>[.exe]`, the name
 * Tauri expects for a sidecar, then runs `tauri build` with `src-tauri/tauri.build.conf.json`, which lists it under
 * `bundle.externalBin`, so the installer puts it next to the app. Plain `cargo` builds and tests do not read that
 * file, so they need no helper.
 *
 *   ATLAS_GAMEFILES_HELPER=tools/gamefiles/dist/atlas-gamefiles.exe pnpm --filter @atlas/mapmaker desktop:build
 *
 * Without ATLAS_GAMEFILES_HELPER, the helper is taken from tools/gamefiles/dist/. Other arguments are passed on to
 * `tauri build`.
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
 */
export function sidecarName(triple) {
  if (!/^[a-z0-9_]+(-[a-z0-9_]+){2,3}$/.test(triple)) {
    throw new Error(`"${triple}" is not a target triple like x86_64-pc-windows-msvc.`);
  }
  return `atlas-gamefiles-${triple}${triple.includes('windows') ? '.exe' : ''}`;
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
  const child = spawn('tauri', tauriArgs(process.argv.slice(2)), {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
