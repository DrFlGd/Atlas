// @ts-check
/**
 * Prepares the frontend that `tauri build` embeds, from the static web build:
 *
 * - copies `apps/web/dist` to `apps/desktop/dist`, leaving out source maps and
 *   `packs/`, which ship as app resources instead (see tauri.build.conf.json)
 *   and are served by the `atlas-pack` protocol with byte-range support;
 * - writes an explicit `packs` list into `config.json`, one entry per pack in
 *   the web build's `packs/index.json`, with URLs on that protocol. The app
 *   then never asks for the index, which is not part of the embedded
 *   frontend. The protocol's URL differs per platform, so this runs on the
 *   platform being built for, as `tauri build` does;
 * - adds the importers named in `ATLAS_BUNDLE_IMPORTERS` (comma-separated
 *   paths of importer modules, absolute or relative to the repository root;
 *   see `packages/importer-api`): each is checked, copied to
 *   `importers/<id>.js` and listed under `importers` in `config.json`.
 *   Without it the app has no importers and offers no "Add a map".
 *
 * For Android (`TAURI_ENV_PLATFORM=android`) the packs stay in the web
 * build instead, and `config.json` points at them there (`packs/<folder>/`):
 * the Android app has no resource folder to serve them from. Its WebView
 * cannot read PMTiles archives from the app (it answers byte ranges itself),
 * so a pack with a `.pmtiles` file is refused; build the demo with folder
 * tiles (`ATLAS_DEMO_TILES=xyz`, which `scripts/build.js android` sets).
 * Importers are refused too: the Android app has no import window.
 */
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const outDir = fileURLToPath(new URL('../dist/', import.meta.url));

// Tauri sets TAURI_ENV_PLATFORM for build hooks; fall back to the host.
const platform =
  process.env.TAURI_ENV_PLATFORM ?? (process.platform === 'win32' ? 'windows' : process.platform);
const android = platform === 'android';
// Windows (WebView2) and Android serve custom schemes as http://<scheme>.localhost.
const packBase =
  platform === 'windows' || android ? 'http://atlas-pack.localhost/' : 'atlas-pack://localhost/';

await stat(`${webDist}index.html`).catch(() => {
  throw new Error(`No web build at ${webDist}; run \`pnpm build\` first.`);
});

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(webDist, outDir, {
  recursive: true,
  filter: (source) => {
    const path = source.slice(webDist.length).replaceAll('\\', '/');
    if (path.endsWith('.map')) return false;
    return android || (path !== 'packs' && !path.startsWith('packs/'));
  },
});

/** @typedef {{ id: string, url: string, title: string }} PackEntry */

/** @type {{ packs?: PackEntry[], packUrl?: string } & Record<string, unknown>} */
const config = JSON.parse(await readFile(`${webDist}config.json`, 'utf8'));

/**
 * The packs to list: an explicit list already in config.json, else the
 * build's pack index. URLs in both are relative to the app root.
 * @type {PackEntry[]}
 */
const entries =
  config.packs ??
  /** @type {{ packs: PackEntry[] }} */ (
    JSON.parse(
      await readFile(`${webDist}packs/index.json`, 'utf8').catch(() => {
        throw new Error(`The web build has no packs/index.json; build it with bundled packs.`);
      }),
    )
  ).packs;

/**
 * The PMTiles archives in a folder and its sub-folders.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function pmtilesIn(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.pmtiles'))
    .map((entry) => entry.name);
}

/**
 * Maps a pack URL to the pack protocol. A `packs/<folder>/` URL names a
 * bundled pack, which the shell serves under its folder name; absolute URLs
 * are kept as they are. On Android the pack stays in the web build, at
 * `packs/<folder>/`.
 * @param {string} url
 */
async function protocolUrl(url) {
  const match = /^(?:\.\/)?packs\/([^/]+)\/?$/.exec(url);
  if (!match) return url;
  const folder = match[1];
  await stat(`${webDist}packs/${folder}/manifest.json`).catch(() => {
    throw new Error(`The pack list points at ${url}, but the web build has no pack there.`);
  });
  if (!android) return `${packBase}${folder}/`;
  const archives = await pmtilesIn(`${webDist}packs/${folder}`);
  if (archives.length > 0) {
    throw new Error(
      `The pack ${folder} has PMTiles archives (${archives.join(', ')}), which the Android app cannot read. ` +
        'Build it with folder tiles: ATLAS_DEMO_TILES=xyz for the demo (scripts/build.js android sets it).',
    );
  }
  return `packs/${folder}/`;
}

config.packs = await Promise.all(
  entries.map(async (entry) => ({ ...entry, url: await protocolUrl(entry.url) })),
);
// The explicit list replaces the older single-pack setting.
delete config.packUrl;
if (config.packs.length === 0) throw new Error('No packs to bundle.');

/** @typedef {{ id: string, title: string, description: string, version: string, module: string }} ImporterEntry */

/**
 * Checks an importer module the way the app will use it, without a
 * TypeScript toolchain: it must load in Node (so it touches no page or
 * browser API when imported) and export the contract's fields.
 * @param {string} path
 * @returns {Promise<ImporterEntry>}
 */
async function importerEntry(path) {
  const source = await readFile(path, 'utf8').catch(() => {
    throw new Error(`ATLAS_BUNDLE_IMPORTERS names ${path}, which cannot be read.`);
  });
  if (/\bfrom\s*['"]node:|\brequire\(\s*['"]/.test(source)) {
    throw new Error(
      `${path} uses Node modules; an importer must be one self-contained browser module.`,
    );
  }
  const module = /** @type {{ default?: Record<string, unknown> }} */ (
    await import(pathToFileURL(path).href)
  );
  const importer = module.default;
  const problems = [];
  if (!importer || typeof importer !== 'object') problems.push('no default export');
  else {
    if (importer.apiVersion !== 1) problems.push('apiVersion is not 1');
    if (typeof importer.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(importer.id))
      problems.push('id is not a lowercase slug');
    for (const key of ['title', 'description', 'version']) {
      if (typeof importer[key] !== 'string' || importer[key] === '')
        problems.push(`${key} is missing`);
    }
    // A page is read by the importer's page reader, or by the app fetching
    // the addresses the importer names.
    const fetch = /** @type {{ addresses?: unknown } | undefined} */ (importer.fetch);
    const readsByFetching = typeof fetch === 'object' && typeof fetch?.addresses === 'function';
    if (!readsByFetching && (typeof importer.pageReader !== 'string' || importer.pageReader === ''))
      problems.push('pageReader is missing (and there is no fetch.addresses)');
    for (const key of ['matches', 'convert']) {
      if (typeof importer[key] !== 'function') problems.push(`${key} is not a function`);
    }
  }
  if (problems.length > 0 || !importer) {
    throw new Error(`${path} is not an Atlas importer: ${problems.join(', ')}.`);
  }
  return {
    id: /** @type {string} */ (importer.id),
    title: /** @type {string} */ (importer.title),
    description: /** @type {string} */ (importer.description),
    version: /** @type {string} */ (importer.version),
    module: `importers/${String(importer.id)}.js`,
  };
}

const importerPaths = (process.env.ATLAS_BUNDLE_IMPORTERS ?? '')
  .split(',')
  .map((path) => path.trim())
  .filter(Boolean)
  .map((path) => (isAbsolute(path) ? path : resolve(repoRoot, path)));
if (android && importerPaths.length > 0) {
  throw new Error('The Android app has no import window, so it takes no ATLAS_BUNDLE_IMPORTERS.');
}
/** @type {ImporterEntry[]} */
const importers = [];
for (const path of importerPaths) {
  const entry = await importerEntry(path);
  if (importers.some((other) => other.id === entry.id)) {
    throw new Error(`Two importers have the id ${entry.id}.`);
  }
  await mkdir(`${outDir}importers`, { recursive: true });
  await copyFile(path, `${outDir}${entry.module}`);
  importers.push(entry);
}
config.importers = importers;

await writeFile(`${outDir}config.json`, `${JSON.stringify(config, null, 2)}\n`);

console.log(
  `Prepared ${outDir} for ${platform}; packs: ${config.packs.map((pack) => pack.url).join(', ')}; ` +
    `importers: ${importers.map((importer) => importer.id).join(', ') || 'none'}`,
);
