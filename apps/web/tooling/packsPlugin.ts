import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

export interface PacksPluginOptions {
  /** Folder that holds one sub-folder per pack. */
  packsDir: string;
  /** Pack folders to copy into the build output, under `packs/<name>/`. */
  bundle: readonly string[];
}

/** An entry of `packs/index.json`; `url` is relative to the app root. */
export interface PackIndexEntry {
  id: string;
  url: string;
  title: string;
}

const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Pack folders to bundle, from a comma-separated list such as the
 * `ATLAS_BUNDLE_PACKS` environment variable. Unset means `demo`; an empty
 * string means none.
 */
export function bundledPackNames(value: string | undefined): string[] {
  const names = (value ?? 'demo')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names) {
    if (!FOLDER_NAME.test(name)) throw new Error(`Invalid pack folder name "${name}"`);
  }
  return [...new Set(names)];
}

/**
 * Builds the pack index for the given folders under `root`, reading each
 * pack's manifest for its game id and title. Folders without a manifest are
 * skipped; a second folder with the same game id is skipped with a warning.
 */
export async function buildPackIndex(
  root: string,
  folders: readonly string[],
  warn: (message: string) => void = console.warn,
): Promise<{ packs: PackIndexEntry[] }> {
  const packs: PackIndexEntry[] = [];
  for (const folder of folders) {
    let manifest: { gameId?: unknown; title?: unknown };
    try {
      manifest = JSON.parse(
        await readFile(join(root, folder, 'manifest.json'), 'utf8'),
      ) as typeof manifest;
    } catch {
      continue;
    }
    if (typeof manifest.gameId !== 'string' || typeof manifest.title !== 'string') {
      warn(`Pack folder "${folder}" has a manifest without gameId or title; skipped.`);
      continue;
    }
    if (packs.some((p) => p.id === manifest.gameId)) {
      warn(`Pack folder "${folder}" repeats game id "${manifest.gameId}"; skipped.`);
      continue;
    }
    packs.push({ id: manifest.gameId, url: `packs/${folder}/`, title: manifest.title });
  }
  return { packs };
}

/** Every sub-folder of `root` that holds a `manifest.json`, sorted by name. */
async function packFolders(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const folders: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !FOLDER_NAME.test(entry.name)) continue;
    const manifest = await stat(join(root, entry.name, 'manifest.json')).catch(() => null);
    if (manifest?.isFile()) folders.push(entry.name);
  }
  return folders.sort();
}

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.pmtiles': 'application/vnd.pmtiles',
};

/** Files in a pack folder that are not part of the pack. */
const SKIPPED = /(^|[/\\])(\.build-stamp\.json|\.gitignore|README\.md)$/;

/**
 * Serves data packs at `<base>packs/<name>/` during development and copies
 * the bundled packs into the build output, so the app loads packs by URL the
 * same way in both. `packs/index.json` lists every pack folder during
 * development and the bundled packs in a build. The dev server honours
 * single HTTP byte ranges, which the PMTiles reader relies on.
 */
export function packsPlugin(options: PacksPluginOptions): Plugin {
  const root = resolve(options.packsDir);
  let outDir = '';

  return {
    name: 'atlas-packs',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/packs', (req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://local').pathname;
        if (pathname === '/index.json') {
          packFolders(root)
            .then((folders) => buildPackIndex(root, folders))
            .then((index) => {
              res.setHeader('Content-Type', CONTENT_TYPES['.json']!);
              res.setHeader('Cache-Control', 'no-cache');
              res.end(`${JSON.stringify(index, null, 2)}\n`);
            })
            .catch(next);
          return;
        }
        serveFile(root, req, res).catch(next);
      });
    },
    async writeBundle() {
      for (const name of options.bundle) {
        const source = join(root, name);
        await stat(join(source, 'manifest.json')).catch(() => {
          throw new Error(`Pack "${name}" is missing at ${source}; run \`pnpm demo:build\` first.`);
        });
        await cp(source, join(outDir, 'packs', name), {
          recursive: true,
          filter: (path) => !SKIPPED.test(path),
        });
      }
      const index = await buildPackIndex(root, options.bundle);
      await mkdir(join(outDir, 'packs'), { recursive: true });
      await writeFile(join(outDir, 'packs', 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    },
  };
}

async function serveFile(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
  const file = resolve(root, `.${pathname}`);
  if (!file.startsWith(root + sep)) {
    res.statusCode = 403;
    res.end();
    return;
  }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  res.setHeader('Content-Type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0;
  let end = info.size - 1;
  if (range) {
    const [, from = '', to = ''] = range;
    if (from === '') {
      start = Math.max(0, info.size - Number(to));
    } else {
      start = Number(from);
      if (to !== '') end = Math.min(end, Number(to));
    }
    if (start > end || start >= info.size) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${info.size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
  }
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file, { start, end }).pipe(res);
}
