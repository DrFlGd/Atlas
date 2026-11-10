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
 *   platform being built for, as `tauri build` does.
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const outDir = fileURLToPath(new URL('../dist/', import.meta.url));

// Tauri sets TAURI_ENV_PLATFORM for build hooks; fall back to the host.
const platform =
  process.env.TAURI_ENV_PLATFORM ?? (process.platform === 'win32' ? 'windows' : process.platform);
// Windows (WebView2) serves custom schemes as http://<scheme>.localhost.
const packBase =
  platform === 'windows' ? 'http://atlas-pack.localhost/' : 'atlas-pack://localhost/';

await stat(`${webDist}index.html`).catch(() => {
  throw new Error(`No web build at ${webDist}; run \`pnpm build\` first.`);
});

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(webDist, outDir, {
  recursive: true,
  filter: (source) => {
    const path = source.slice(webDist.length).replaceAll('\\', '/');
    return path !== 'packs' && !path.startsWith('packs/') && !path.endsWith('.map');
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
 * Maps a pack URL to the pack protocol. A `packs/<folder>/` URL names a
 * bundled pack, which the shell serves under its folder name; absolute URLs
 * are kept as they are.
 * @param {string} url
 */
async function protocolUrl(url) {
  const match = /^(?:\.\/)?packs\/([^/]+)\/?$/.exec(url);
  if (!match) return url;
  const folder = match[1];
  await stat(`${webDist}packs/${folder}/manifest.json`).catch(() => {
    throw new Error(`The pack list points at ${url}, but the web build has no pack there.`);
  });
  return `${packBase}${folder}/`;
}

config.packs = await Promise.all(
  entries.map(async (entry) => ({ ...entry, url: await protocolUrl(entry.url) })),
);
// The explicit list replaces the older single-pack setting.
delete config.packUrl;
if (config.packs.length === 0) throw new Error('No packs to bundle.');
await writeFile(`${outDir}config.json`, `${JSON.stringify(config, null, 2)}\n`);

console.log(
  `Prepared ${outDir} for ${platform}; packs: ${config.packs.map((pack) => pack.url).join(', ')}`,
);
