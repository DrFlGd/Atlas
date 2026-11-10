// @ts-check
/**
 * Prepares the frontend that `tauri build` embeds, from the static web build:
 *
 * - copies `apps/web/dist` to `apps/desktop/dist`, leaving out source maps and
 *   `packs/`, which ship as app resources instead (see tauri.build.conf.json)
 *   and are served by the `atlas-pack` protocol with byte-range support;
 * - rewrites `config.json` so relative `packs/<id>/` URLs point at that
 *   protocol. Its URL differs per platform, so this runs on the platform being
 *   built for, as `tauri build` does.
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

/** @type {{ packUrl: string } & Record<string, unknown>} */
const config = JSON.parse(await readFile(`${webDist}config.json`, 'utf8'));
const match = /^(?:\.\/)?packs\/(.+)$/.exec(config.packUrl);
if (match) {
  const packDir = `${webDist}packs/${match[1]}`;
  await stat(`${packDir.replace(/\/?$/, '/')}manifest.json`).catch(() => {
    throw new Error(
      `config.json points at ${config.packUrl}, but the web build has no pack there.`,
    );
  });
  config.packUrl = `${packBase}${match[1]}`;
}
await writeFile(`${outDir}config.json`, `${JSON.stringify(config, null, 2)}\n`);

console.log(`Prepared ${outDir} for ${platform}; packUrl is ${config.packUrl}`);
