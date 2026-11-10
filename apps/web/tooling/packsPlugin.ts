import { createReadStream } from 'node:fs';
import { cp, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

export interface PacksPluginOptions {
  /** Folder that holds one sub-folder per pack. */
  packsDir: string;
  /** Packs to copy into the build output, under `packs/<name>/`. */
  bundle: readonly string[];
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
 * same way in both. The dev server honours single HTTP byte ranges, which the
 * PMTiles reader relies on.
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
