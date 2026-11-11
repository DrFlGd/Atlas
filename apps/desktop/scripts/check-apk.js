// @ts-check
/**
 * Checks an Android APK of the Atlas viewer (`scripts/build.js android`)
 * before anyone installs it:
 *
 *   node apps/desktop/scripts/check-apk.js <app.apk> [--packs demo] [--forbid <text>]...
 *
 * - the APK holds the app's native library (`lib/<abi>/libatlas_desktop_lib.so`),
 *   and that library holds no download code (`scripts/check-binary.js`):
 *   the Android app is always a viewer;
 * - the packs that come with the app are exactly those named by `--packs`
 *   (comma-separated, default `demo`): in the web build embedded in the
 *   library (its file names are kept as they are, while the files are
 *   compressed), and in the prepared frontend it was built from
 *   (`apps/desktop/dist`, its `packs/` folder and `config.json`);
 * - no file in the APK, and no file of the prepared frontend, contains any
 *   `--forbid` text, ignoring case. The frontend is searched as well because
 *   the library holds it compressed.
 *
 * It needs `unzip` on the PATH. It exits with 1 and lists every problem
 * when one is found.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkBinary } from './check-binary.js';

/** The app's native library, as `tauri android build` names it. */
export const NATIVE_LIBRARY = 'libatlas_desktop_lib.so';

/**
 * The folder names of the packs whose files are embedded in a native
 * library, from the asset names Tauri keeps in it (`/packs/<folder>/...`).
 * @param {Buffer} bytes
 */
export function embeddedPacks(bytes) {
  const text = bytes.toString('latin1');
  const found = new Set();
  for (const match of text.matchAll(/\/packs\/([A-Za-z0-9][A-Za-z0-9._-]*)\/manifest\.json/g)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * The texts of `forbidden` that `bytes` contains, ignoring case.
 * @param {Buffer} bytes @param {readonly string[]} forbidden
 */
export function forbiddenIn(bytes, forbidden) {
  const text = bytes.toString('latin1').toLowerCase();
  return forbidden.filter((word) => text.includes(word.toLowerCase()));
}

/**
 * The differences between the packs found somewhere and those expected, as
 * problems.
 * @param {string} where @param {readonly string[]} found @param {readonly string[]} expected
 */
export function packProblems(where, found, expected) {
  const problems = [];
  const extra = found.filter((name) => !expected.includes(name));
  const missing = expected.filter((name) => !found.includes(name));
  if (extra.length > 0) problems.push(`${where} has packs it should not: ${extra.join(', ')}`);
  if (missing.length > 0) problems.push(`${where} lacks the packs: ${missing.join(', ')}`);
  return problems;
}

/**
 * Every file under a folder.
 * @param {string} dir
 */
async function filesUnder(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * The problems of an APK and the frontend it was built from.
 * @param {{ apk: string, frontend: string, packs: string[], forbid: string[] }} options
 */
export async function checkApk({ apk, frontend, packs, forbid }) {
  /** @type {string[]} */
  const problems = [];
  const dir = await mkdtemp(join(tmpdir(), 'atlas-apk-'));
  try {
    execFileSync('unzip', ['-q', '-o', apk, '-d', dir], { stdio: 'inherit' });
    const files = await filesUnder(dir);
    const libraries = files.filter(
      (file) => relative(dir, file).startsWith('lib') && file.endsWith(NATIVE_LIBRARY),
    );
    if (libraries.length === 0) problems.push(`${apk} holds no ${NATIVE_LIBRARY}`);
    for (const library of libraries) {
      const name = relative(dir, library).replaceAll('\\', '/');
      console.log(`Native library ${name}`);
      const problem = await checkBinary(library, false);
      if (problem) problems.push(problem.replace(library, name));
      const found = embeddedPacks(await readFile(library));
      console.log(`  packs in its web build: ${found.join(', ') || 'none'}`);
      problems.push(...packProblems(name, found, packs));
    }
    if (forbid.length > 0) {
      for (const file of files) {
        const words = forbiddenIn(await readFile(file), forbid);
        if (words.length > 0) {
          problems.push(`${relative(dir, file)} in the APK contains ${words.join(', ')}`);
        }
      }
      console.log(`Searched ${files.length} files in the APK for: ${forbid.join(', ')}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const isFolder = await stat(frontend).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!isFolder) {
    problems.push(`No prepared frontend at ${frontend} to check`);
    return problems;
  }
  const folders = (await readdir(join(frontend, 'packs'), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  console.log(`Packs in ${frontend}packs: ${folders.join(', ') || 'none'}`);
  problems.push(...packProblems(`${frontend}packs`, folders, packs));
  const config = /** @type {{ packs?: { id: string, url: string }[], importers?: unknown[] }} */ (
    JSON.parse(await readFile(join(frontend, 'config.json'), 'utf8'))
  );
  const listed = (config.packs ?? []).map((pack) => pack.url);
  console.log(`Packs in config.json: ${listed.join(', ') || 'none'}`);
  const local = listed.map((url) => /^packs\/([^/]+)\/$/.exec(url)?.[1] ?? url);
  problems.push(...packProblems(`${frontend}config.json`, local.sort(), packs));
  if ((config.importers ?? []).length > 0) {
    problems.push(`${frontend}config.json lists importers; the Android app has none`);
  }
  if (forbid.length > 0) {
    const frontendFiles = await filesUnder(frontend);
    for (const file of frontendFiles) {
      const words = forbiddenIn(await readFile(file), forbid);
      if (words.length > 0) problems.push(`${file} contains ${words.join(', ')}`);
    }
    console.log(`Searched ${frontendFiles.length} files of ${frontend} for: ${forbid.join(', ')}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      packs: { type: 'string', default: 'demo' },
      forbid: { type: 'string', multiple: true, default: [] },
      frontend: { type: 'string', default: fileURLToPath(new URL('../dist/', import.meta.url)) },
    },
  });
  const apk = positionals[0];
  if (!apk || positionals.length > 1) {
    console.error(
      'Usage: check-apk.js <app.apk> [--packs demo] [--forbid <text>]... [--frontend dist/]',
    );
    process.exit(2);
  }
  const frontend = values.frontend.endsWith('/') ? values.frontend : `${values.frontend}/`;
  const packs = values.packs
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
  const problems = await checkApk({ apk, frontend, packs, forbid: values.forbid });
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(
    `${apk} holds no download code and only the packs ${packs.join(', ')}` +
      (values.forbid.length > 0 ? `, and none of: ${values.forbid.join(', ')}` : '') +
      '.',
  );
}
