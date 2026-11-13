import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  COLLECTION_NAMES,
  MANIFEST_FILE,
  PACK_COLLECTIONS,
  checkPackIntegrity,
  packDataSchema,
  type PackData,
} from '@atlas/schema';
import type { Tile } from '../tiles/cutPyramid';

/**
 * Validates pack data against the schema and integrity rules, throwing with
 * every problem listed if anything is wrong.
 */
export function assertValidPack(data: PackData): PackData {
  const parsed = packDataSchema.safeParse(data);
  if (!parsed.success) {
    const lines = parsed.error.issues
      .slice(0, 20)
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Pack data does not match the schema:\n${lines.join('\n')}`);
  }
  const issues = checkPackIntegrity(parsed.data);
  if (issues.length > 0) {
    const lines = issues.slice(0, 20).map((issue) => `  - ${issue.path}: ${issue.message}`);
    throw new Error(`Pack data is inconsistent:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

/** Collections written only when a pack has some, so packs without them keep their files. */
const OPTIONAL_COLLECTIONS: ReadonlySet<string> = new Set(['sections', 'pictures']);

/** Formats an array as JSON with one element per line, which keeps diffs readable. */
export function formatCollection(items: readonly unknown[]): string {
  if (items.length === 0) return '[]\n';
  return `[\n${items.map((item) => `  ${JSON.stringify(item)}`).join(',\n')}\n]\n`;
}

/** Writes the pack's JSON files into `dir`, validating first. Returns the files written. */
export async function writePackJson(dir: string, data: PackData): Promise<string[]> {
  const valid = assertValidPack(data);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, MANIFEST_FILE), `${JSON.stringify(valid.manifest, null, 2)}\n`);
  const written = [MANIFEST_FILE];
  for (const name of COLLECTION_NAMES) {
    const { file } = PACK_COLLECTIONS[name];
    const items = valid[name];
    // Contents and pictures are written only when the pack has some.
    if (items === undefined || (OPTIONAL_COLLECTIONS.has(name) && items.length === 0)) continue;
    await writeFile(join(dir, file), formatCollection(items));
    written.push(file);
  }
  return written;
}

/** Writes tiles as `{z}/{x}/{y}.<extension>` files under `dir`. */
export async function writeTileFolder(
  dir: string,
  tiles: readonly Tile[],
  extension = 'webp',
): Promise<void> {
  for (const tile of tiles) {
    const path = join(dir, String(tile.z), String(tile.x), `${tile.y}.${extension}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, tile.data);
  }
}
