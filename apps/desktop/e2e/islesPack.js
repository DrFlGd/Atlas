// @ts-check
/**
 * The test pack `test-isles`: a game that comes with the app and was made
 * from web pages, so the import test can refresh it from the made-up demo
 * site (`demoSite.js`). It is built here exactly as the app builds a game
 * from the site's pages, with the demo importer's `convert`, and comes with
 * the page data it was made from (`import/`) and a manifest that records
 * those pages (`source`), as a bundled pack must for a refresh of one page
 * to keep its other maps.
 *
 *   node apps/desktop/e2e/islesPack.js [port]
 *
 * writes the pack to `packs/test-isles/` (ignored by git), with map pages
 * and map images at `http://127.0.0.1:<port>/` (default 4432, or
 * ATLAS_E2E_SITE_PORT). Build the desktop app with
 * `ATLAS_BUNDLE_PACKS=e2e-remote,demo,test-isles` to bundle it.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import importer from '../../../packages/importer-api/demo/demo-importer.js';
import { SITE_PORT, WORLDS, mapPageData } from './demoSite.js';

export const ISLES_ID = 'test-isles';
/** When the pages were read, as recorded in the pack. */
const IMPORTED_AT = '2026-01-01T00:00:00.000Z';

/**
 * The pack's files, by name, built from the site's pages one after another.
 * @param {number} port
 * @returns {Promise<Record<string, unknown>>}
 */
export async function islesFiles(port = SITE_PORT) {
  const world = WORLDS[ISLES_ID];
  if (!world) throw new Error(`demoSite.js has no world ${ISLES_ID}`);
  const origin = `http://127.0.0.1:${port}`;
  /** @type {{ key: string, url: string, importedAt: string, mapId: string, data: unknown }[]} */
  const sources = [];
  /** @type {any} */
  let pack = null;
  for (const map of world.maps) {
    const url = `${origin}/demo-maps/${ISLES_ID}/${map.slug}`;
    const data = mapPageData(ISLES_ID, map, origin);
    const outcome = await importer.convert(data, {
      url,
      importedAt: IMPORTED_AT,
      app: { name: 'Atlas', version: 'test' },
      savedSources: () => Promise.resolve(sources.map((s) => ({ ...s }))),
      existingPack: () => Promise.resolve(null),
      isBundled: () => false,
    });
    if (!outcome.ok || !outcome.mapId) {
      throw new Error(`Could not build ${ISLES_ID}: ${outcome.ok ? 'no map' : outcome.message}`);
    }
    sources.push({
      key: outcome.sourceKey,
      url,
      importedAt: IMPORTED_AT,
      mapId: outcome.mapId,
      data,
    });
    pack = outcome.pack;
  }
  const { manifest, ...collections } = pack;
  /** @type {Record<string, unknown>} */
  const files = {
    'manifest.json': {
      ...manifest,
      schemaVersion: 2,
      created: IMPORTED_AT,
      updated: IMPORTED_AT,
      source: {
        importer: { id: importer.id, title: importer.title },
        pages: sources.map(({ url, mapId, importedAt }) => ({ url, mapId, importedAt })),
      },
    },
    'import/index.json': {
      format: 'atlas-import',
      version: 1,
      importer: { id: importer.id, title: importer.title },
      sources: sources.map(({ key, url, importedAt, mapId }) => ({
        key,
        url,
        importedAt,
        mapId,
        file: `${key}.json`,
      })),
    },
  };
  for (const [name, value] of Object.entries(collections)) files[`${name}.json`] = value;
  for (const source of sources) files[`import/${source.key}.json`] = source.data;
  return files;
}

/** Writes the pack into `dir`, replacing what is there. */
export async function writeIslesPack(/** @type {string} */ dir, port = SITE_PORT) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, 'import'), { recursive: true });
  for (const [name, content] of Object.entries(await islesFiles(port))) {
    await writeFile(join(dir, name), `${JSON.stringify(content, null, 2)}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? SITE_PORT);
  const dir = fileURLToPath(new URL(`../../../packs/${ISLES_ID}`, import.meta.url));
  await writeIslesPack(dir, port);
  console.log(`Wrote ${dir} for the demo map site at http://127.0.0.1:${port}/`);
}
