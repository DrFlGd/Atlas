import { access, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pyramidLevel } from '@atlas/core';
import {
  COLLECTION_NAMES,
  MANIFEST_FILE,
  MAP_COLLECTIONS,
  PACK_COLLECTIONS,
  MAX_SCENE_FILE_BYTES,
  checkPackIntegrity,
  packDataSchema,
  sceneFiles,
} from '@atlas/schema';

/** What {@link validatePackFolder} found: every problem, one per line, and what it checked. */
export interface FolderReport {
  problems: string[];
  files: string[];
  tilesChecked: number;
}

/**
 * Checks a pack folder on disk as a tool that writes packs must leave it:
 * each JSON file against the pack schema (strict, so an unknown field or an
 * unknown list type is a problem, although the app would skip it), the
 * pack's integrity rules, that every picture's file is there, that every
 * model file a map's scene names is there and is glTF 2.0 binary, and, for
 * every layer whose tiles are a `{z}/{x}/{y}` folder, that every tile of
 * its pyramid is there. A game with no map may leave out every map file.
 *
 * Tools that write packs in other languages (the Map Maker's Python helper)
 * are checked with this, so their output cannot drift from the schema.
 */
export async function validatePackFolder(dir: string): Promise<FolderReport> {
  const problems: string[] = [];
  const files: string[] = [];
  const raw: Record<string, unknown> = {};
  const read = async (file: string, required: boolean): Promise<unknown> => {
    let text: string;
    try {
      text = await readFile(join(dir, file), 'utf8');
    } catch {
      if (required) problems.push(`${file}: missing`);
      return required ? undefined : [];
    }
    files.push(file);
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      problems.push(`${file}: not JSON (${String(error)})`);
      return undefined;
    }
  };
  raw.manifest = await read(MANIFEST_FILE, true);
  // A game with no map may leave out every map file, but not some of them.
  const mapFiles: readonly string[] = MAP_COLLECTIONS;
  const present = await Promise.all(
    MAP_COLLECTIONS.map((name) =>
      access(join(dir, PACK_COLLECTIONS[name].file)).then(
        () => true,
        () => false,
      ),
    ),
  );
  const noMap = !present.some(Boolean);
  for (const name of COLLECTION_NAMES) {
    const { file, required } = PACK_COLLECTIONS[name];
    raw[name] = await read(file, required && !(noMap && mapFiles.includes(name)));
  }
  if (problems.length > 0) return { problems, files, tilesChecked: 0 };

  const parsed = packDataSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 50)) {
      problems.push(`${issue.path.join('.')}: ${issue.message}`);
    }
    return { problems, files, tilesChecked: 0 };
  }
  const pack = parsed.data;
  for (const issue of checkPackIntegrity(pack).slice(0, 50)) {
    problems.push(`${issue.path}: ${issue.message}`);
  }

  let tilesChecked = 0;
  const maps = new Map(pack.maps.map((map) => [map.id, map]));
  for (const layer of pack.layers) {
    const map = maps.get(layer.mapId);
    if (!map || layer.tiles.type !== 'xyz' || layer.tiles.remote) continue;
    const missing: string[] = [];
    for (let z = layer.minZoom; z <= layer.maxZoom; z++) {
      const level = pyramidLevel(map.width, map.height, layer.tileSize, layer.maxZoom, z);
      for (let x = 0; x < level.columns; x++) {
        for (let y = 0; y < level.rows; y++) {
          const path = layer.tiles.url
            .replace('{z}', String(z))
            .replace('{x}', String(x))
            .replace('{y}', String(y));
          tilesChecked++;
          try {
            await access(join(dir, path));
          } catch {
            missing.push(path);
          }
        }
      }
    }
    if (missing.length > 0) {
      problems.push(
        `${layer.id}: ${missing.length} tiles missing, such as ${missing.slice(0, 3).join(', ')}`,
      );
    }
  }
  for (const picture of pack.pictures ?? []) {
    try {
      await access(join(dir, picture.file));
    } catch {
      // A picture fetched later may be missing until someone downloads it.
      if (picture.remote) continue;
      problems.push(`${picture.id}: ${picture.file} is missing`);
    }
  }
  for (const map of pack.maps) {
    if (!map.scene) continue;
    for (const file of sceneFiles(map.scene)) {
      const problem = await checkModelFile(join(dir, file));
      if (problem) problems.push(`${map.id}: ${file} ${problem}`);
    }
  }
  return { problems, files, tilesChecked };
}

/**
 * Checks that a model file a scene names is there and is glTF 2.0 binary
 * (`.glb`): its header says `glTF`, version 2 and the file's own length,
 * within {@link MAX_SCENE_FILE_BYTES}. The model itself is not read.
 */
export async function checkModelFile(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return 'is missing';
  }
  try {
    const { size } = await handle.stat();
    if (size > MAX_SCENE_FILE_BYTES) return 'is too large';
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, 12, 0);
    if (bytesRead < 12 || header.toString('latin1', 0, 4) !== 'glTF') {
      return 'is not a glTF binary file';
    }
    if (header.readUInt32LE(4) !== 2) return 'is not glTF version 2';
    if (header.readUInt32LE(8) !== size) return 'does not have the length its header gives';
    return null;
  } finally {
    await handle.close();
  }
}
