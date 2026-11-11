/**
 * Builds the demo pack into `packs/demo` at the repository root.
 *
 *   tsx src/cli/build-demo-pack.ts            build only if missing or out of date
 *   tsx src/cli/build-demo-pack.ts --force    always rebuild
 *
 * Options: --tiles pmtiles|xyz, --seed <n>, --size <px>, --locations <n>, --out <dir>.
 * `--tiles` defaults to the `ATLAS_DEMO_TILES` environment variable, else
 * pmtiles; the Android build sets it to xyz, so that `pnpm build` makes the
 * folder tiles that app can read.
 *
 * "Out of date" means the options or the source of the generator (this
 * package and the schema package) changed since the last build, as recorded
 * in the pack's `.build-stamp.json`.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  DEFAULT_DEMO_OPTIONS,
  STAMP_FILE,
  buildDemoPack,
  type DemoPackOptions,
} from '../demo/buildDemoPack';

const packageRoot = resolve(import.meta.dirname, '../..');
const repoRoot = resolve(packageRoot, '../..');

// An empty ATLAS_DEMO_TILES counts as unset.
const envTiles = process.env.ATLAS_DEMO_TILES?.trim() ?? '';
const defaultTiles = envTiles === '' ? DEFAULT_DEMO_OPTIONS.tileFormat : envTiles;

const { values } = parseArgs({
  options: {
    force: { type: 'boolean', default: false },
    tiles: { type: 'string', default: defaultTiles },
    seed: { type: 'string', default: String(DEFAULT_DEMO_OPTIONS.seed) },
    size: { type: 'string', default: String(DEFAULT_DEMO_OPTIONS.size) },
    locations: { type: 'string', default: String(DEFAULT_DEMO_OPTIONS.locationCount) },
    out: { type: 'string', default: join(repoRoot, 'packs', 'demo') },
  },
});

function positiveInt(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

if (values.tiles !== 'pmtiles' && values.tiles !== 'xyz') {
  throw new Error('--tiles (or ATLAS_DEMO_TILES) must be "pmtiles" or "xyz"');
}

const options: DemoPackOptions = {
  ...DEFAULT_DEMO_OPTIONS,
  tileFormat: values.tiles,
  seed: positiveInt('seed', values.seed),
  size: positiveInt('size', values.size),
  locationCount: positiveInt('locations', values.locations),
};
const outDir = resolve(values.out);

/** Hash of every non-test source file the pack is generated from. */
async function sourceHash(): Promise<string> {
  const hash = createHash('sha256');
  const roots = [join(packageRoot, 'src'), join(repoRoot, 'packages', 'schema', 'src')];
  for (const root of roots) {
    const files = (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
      )
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
    for (const file of files) {
      hash.update(relative(repoRoot, file).replaceAll('\\', '/'));
      hash.update(await readFile(file));
    }
  }
  return hash.digest('hex');
}

async function readStamp(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(outDir, STAMP_FILE), 'utf8'));
  } catch {
    return null;
  }
}

const stamp = { sourceHash: await sourceHash() };
const expected = JSON.stringify({ ...stamp, options });
const existing = await readStamp();
const displayOut = relative(process.cwd(), outDir) || '.';

if (!values.force && existing !== null && JSON.stringify(existing) === expected) {
  console.log(`Demo pack in ${displayOut} is up to date.`);
} else {
  console.log(`Building demo pack in ${displayOut} (${options.tileFormat} tiles)…`);
  const summary = await buildDemoPack(outDir, options, stamp, (message) => {
    console.log(`  ${message}`);
  });
  const mb = (summary.tileBytes / 1024 / 1024).toFixed(1);
  console.log(
    `Done: ${summary.locations} locations, ${summary.regions} regions, ` +
      `${summary.tiles} tiles (${mb} MiB, zoom 0-${summary.maxZoom}). ` +
      `Timings ms: content ${summary.millis.content}, render ${summary.millis.render}, ` +
      `tiles ${summary.millis.tiles}, write ${summary.millis.write}.`,
  );
}
