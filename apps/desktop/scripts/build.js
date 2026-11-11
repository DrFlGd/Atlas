// @ts-check
/**
 * `pnpm desktop:build`: runs `tauri build` with the bundling config, and,
 * when a build sets them, its own app name and identifier:
 *
 *   ATLAS_APP_NAME="My Atlas" ATLAS_APP_IDENTIFIER=org.example.myatlas pnpm desktop:build
 *
 * A build with its own identifier installs next to the plain Atlas app
 * instead of replacing it, with its own app data (and so its own saved
 * progress); both read the same maps folder (see README, "Two apps, one
 * maps folder"). Both variables must be set together.
 *
 * `ATLAS_ENABLE_DOWNLOADS=1` builds an app that fetches map images from
 * other servers ("Download map images", "View map page and save images as
 * I browse"). It turns on the shell's `downloads` Cargo feature, which
 * compiles that code and its commands in and makes `build.rs` read the
 * capability in `capabilities/downloads/`, and the web app's flag of the
 * same name (`apps/web/vite.config.ts`), which keeps their interface in the
 * bundle. Without it, the default, the app is a viewer only. The choice is
 * recorded in `src-tauri/atlas-build.json` (ignored by git), so the tests of
 * the built app know what to expect without being told again.
 *
 * Other arguments are passed on to `tauri build`.
 *
 * `node scripts/build.js android` (`pnpm --filter @atlas/desktop
 * android:build`) builds the Android app instead: a viewer with the packs
 * named in `ATLAS_BUNDLE_PACKS` (the demo by default) inside its web build,
 * as folder tiles (`ATLAS_DEMO_TILES=xyz`), since the Android WebView cannot
 * read PMTiles archives from the app. It refuses downloads, importers and a
 * custom name or identifier; the Android name and identifier are in
 * `src-tauri/tauri.android.conf.json`. It creates the Android project
 * (`src-tauri/gen/android`, ignored by git) with `tauri android init` when
 * there is none, then runs `tauri android build --apk` with the other
 * arguments, for example `--target aarch64`. The APK is unsigned; a release
 * signs it. Before building, it writes the app's own activity
 * (`android/MainActivity.kt`: the page is told the system bar sizes) over
 * the generated one, keeping its package, and adds `android/atlas-rules.pro`
 * to the release shrinking rules, since the generated project is made anew.
 */
import { spawn } from 'node:child_process';
import { access, copyFile, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (/** @type {string} */ path) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The config to merge for a custom name and identifier, or null for the
 * plain Atlas build. Exported for tests.
 * @param {{ name?: string, identifier?: string }} identity
 * @param {{ app: { windows: Array<Record<string, unknown>> } }} baseConfig
 */
export function identityConfig({ name, identifier }, baseConfig) {
  if (!name && !identifier) return null;
  if (!name || !identifier) {
    throw new Error('Set both ATLAS_APP_NAME and ATLAS_APP_IDENTIFIER, or neither.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(name)) {
    throw new Error(
      `ATLAS_APP_NAME "${name}" must be 1 to 40 letters, digits, spaces, dots, dashes or underscores.`,
    );
  }
  if (!/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(identifier) || identifier.endsWith('.app')) {
    throw new Error(`ATLAS_APP_IDENTIFIER "${identifier}" must look like org.example.app-name.`);
  }
  if (identifier === 'dev.atlas.desktop') {
    throw new Error(
      'ATLAS_APP_IDENTIFIER must differ from the plain Atlas app (dev.atlas.desktop).',
    );
  }
  return {
    productName: name,
    identifier,
    app: {
      // Arrays are replaced when configs merge, so every window is listed again.
      windows: baseConfig.app.windows.map((window) =>
        window.label === 'main' ? { ...window, title: name } : window,
      ),
    },
  };
}

/**
 * Whether `ATLAS_ENABLE_DOWNLOADS` asks for downloads: `1` yes; unset, empty
 * or `0` no; anything else is refused. Exported for tests.
 * @param {string | undefined} value
 */
export function downloadsEnabled(value) {
  const text = value?.trim() ?? '';
  if (text === '' || text === '0') return false;
  if (text === '1') return true;
  throw new Error(`ATLAS_ENABLE_DOWNLOADS must be 1, 0 or unset, not "${value}".`);
}

/** Where a build records whether it has downloads; see `scripts/check-binary.js`. */
export const BUILD_RECORD = here('../src-tauri/atlas-build.json');

/**
 * The arguments for `tauri build`. Exported for tests.
 * @param {{ identity: boolean, downloads: boolean, extra: string[] }} options
 */
export function tauriArgs({ identity, downloads, extra }) {
  const args = ['build', '--config', 'src-tauri/tauri.build.conf.json'];
  if (identity) args.push('--config', 'src-tauri/tauri.identity.conf.json');
  if (downloads) args.push('--features', 'downloads');
  args.push(...extra.filter((arg) => arg !== '--'));
  return args;
}

/**
 * The `tauri` commands of an Android build: `android init` when the Android
 * project does not exist yet, then `android build`. Exported for tests.
 * @param {{ initialised: boolean, extra: string[] }} options
 */
export function androidCommands({ initialised, extra }) {
  /** @type {string[][]} */
  const commands = [];
  if (!initialised) commands.push(['android', 'init', '--ci', '--skip-targets-install']);
  commands.push(['android', 'build', '--apk', '--ci', ...extra.filter((arg) => arg !== '--')]);
  return commands;
}

/**
 * The app's activity for the generated Android project: `ours` with the
 * package line of the generated `MainActivity.kt`. Exported for tests.
 * @param {string} generated @param {string} ours
 */
export function mainActivitySource(generated, ours) {
  const packageLine = /^package\s+[\w.`]+\s*$/m;
  const found = packageLine.exec(generated);
  if (!found) throw new Error('The generated MainActivity.kt has no package line.');
  if (!packageLine.test(ours)) throw new Error('android/MainActivity.kt has no package line.');
  return ours.replace(packageLine, found[0].trim());
}

/**
 * The generated `MainActivity.kt` under a folder, at any depth.
 * @param {string} dir @returns {Promise<string | null>}
 */
async function findMainActivity(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const found = entries.find((entry) => entry.isFile() && entry.name === 'MainActivity.kt');
  return found ? join(found.parentPath, found.name) : null;
}

/** Puts the app's own activity and shrinking rules into the generated Android project. */
async function prepareAndroidProject() {
  const app = here('../src-tauri/gen/android/app/');
  const activity = await findMainActivity(join(app, 'src/main/java'));
  if (!activity) throw new Error(`No MainActivity.kt under ${app}src/main/java`);
  const ours = await readFile(here('../android/MainActivity.kt'), 'utf8');
  await writeFile(activity, mainActivitySource(await readFile(activity, 'utf8'), ours));
  await copyFile(here('../android/atlas-rules.pro'), join(app, 'atlas-rules.pro'));
  console.log(`Wrote the app's activity to ${activity} and its shrinking rules beside it`);
}

/**
 * The environment of an Android build, or an error for settings it cannot
 * have. Exported for tests.
 * @param {NodeJS.ProcessEnv} env
 */
export function androidEnv(env) {
  if (downloadsEnabled(env.ATLAS_ENABLE_DOWNLOADS)) {
    throw new Error('The Android app is a viewer: ATLAS_ENABLE_DOWNLOADS must be 0 or unset.');
  }
  if (env.ATLAS_BUNDLE_IMPORTERS?.trim()) {
    throw new Error('The Android app has no importers: unset ATLAS_BUNDLE_IMPORTERS.');
  }
  if (env.ATLAS_APP_NAME?.trim() || env.ATLAS_APP_IDENTIFIER?.trim()) {
    throw new Error(
      'The Android app takes its name and identifier from src-tauri/tauri.android.conf.json: unset ATLAS_APP_NAME and ATLAS_APP_IDENTIFIER.',
    );
  }
  return { ...env, ATLAS_ENABLE_DOWNLOADS: '0', ATLAS_DEMO_TILES: 'xyz' };
}

/**
 * Runs `tauri` with these arguments; resolves to its exit code.
 * @param {string[]} args @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
function tauri(args, env) {
  return new Promise((resolve) => {
    const child = spawn('tauri', args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env,
    });
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

async function buildAndroid() {
  const env = androidEnv(process.env);
  const initialised = await access(here('../src-tauri/gen/android')).then(
    () => true,
    () => false,
  );
  console.log('Building the Android app: a viewer, with folder tiles (ATLAS_DEMO_TILES=xyz)');
  for (const args of androidCommands({ initialised, extra: process.argv.slice(3) })) {
    if (args[1] === 'build') await prepareAndroidProject();
    const code = await tauri(args, env);
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'android') {
  await buildAndroid();
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = JSON.parse(await readFile(here('../src-tauri/tauri.conf.json'), 'utf8'));
  const identity = identityConfig(
    {
      name: process.env.ATLAS_APP_NAME?.trim(),
      identifier: process.env.ATLAS_APP_IDENTIFIER?.trim(),
    },
    base,
  );
  const downloads = downloadsEnabled(process.env.ATLAS_ENABLE_DOWNLOADS);
  // A file rather than a JSON argument, which Windows shells would mangle.
  const identityFile = here('../src-tauri/tauri.identity.conf.json');
  await rm(identityFile, { force: true });
  if (identity) {
    await writeFile(identityFile, `${JSON.stringify(identity, null, 2)}\n`);
    console.log(`Building "${identity.productName}" (${identity.identifier})`);
  }
  console.log(
    downloads
      ? 'With map image downloads (ATLAS_ENABLE_DOWNLOADS=1)'
      : 'Without map image downloads: a viewer (set ATLAS_ENABLE_DOWNLOADS=1 for them)',
  );
  const args = tauriArgs({
    identity: identity !== null,
    downloads,
    extra: process.argv.slice(2),
  });
  // The web build that `tauri build` runs first reads the same variable.
  const env = { ...process.env, ATLAS_ENABLE_DOWNLOADS: downloads ? '1' : '0' };
  await writeFile(BUILD_RECORD, `${JSON.stringify({ downloads }, null, 2)}\n`);
  const child = spawn('tauri', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env,
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
