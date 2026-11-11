// @ts-check
/**
 * A local mock tile server for the desktop download test. It draws PNG
 * tiles for the maps in `remotePack.js` on request: a gradient with a grid,
 * and a pink dot with a white ring under every beacon, so markers can be
 * checked against the downloaded image. It never talks to any other server.
 *
 * Modes: `ok`, `slow` (each answer waits 400 ms), `refuse` (HTTP 403).
 * With `setStoreMissing(true)`, it answers `STORE_MISSING_TILE` the way an
 * object store answers for an image it does not have (403, `AccessDenied`).
 *
 *   node apps/desktop/e2e/tileServer.js [port]   # serve until stopped
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { DEFAULT_PORT, MAPS, MISSING_TILE, STORE_MISSING_TILE } from './remotePack.js';

/** A made-up object store's answer for an object that does not exist. */
export const NO_SUCH_OBJECT =
  '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code>' +
  '<Message>Access Denied</Message><RequestId>0000TEST</RequestId>' +
  '<HostId>dGVzdC1ob3N0</HostId></Error>';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(/** @type {Buffer} */ data) {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(/** @type {string} */ type, /** @type {Buffer} */ data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encodes RGB pixels as a PNG. */
export function encodePng(
  /** @type {number} */ width,
  /** @type {number} */ height,
  /** @type {Uint8Array} */ rgb,
) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width * 3 + 1)] = 0; // no filter
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(
      rows,
      y * (width * 3 + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The colour of the dot under each beacon. */
export const DOT = [255, 0, 200];
const DOT_RADIUS = 22;
const RING_RADIUS = 28;

/**
 * Draws tile (z, x, y) of a map's pyramid, in that map's image pixels.
 * @param {import('./remotePack.js').TestMap} map
 * @param {number} z @param {number} x @param {number} y
 */
export function drawTile(map, z, x, y) {
  const size = 256;
  const scale = 2 ** (map.maxZoom - z);
  const rgb = new Uint8Array(size * size * 3);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const ix = (x * size + px + 0.5) * scale;
      const iy = (y * size + py + 0.5) * scale;
      let color;
      if (ix >= map.width || iy >= map.height) {
        color = [24, 26, 30];
      } else {
        color = [
          70 + Math.round((110 * ix) / map.width),
          120 + Math.round((60 * iy) / map.height),
          map.slug === 'cave' ? 150 : 90,
        ];
        if (ix % 256 < 2 * scale || iy % 256 < 2 * scale) color = [40, 60, 50];
        for (const beacon of map.beacons) {
          const d = Math.hypot(ix - beacon.x, iy - beacon.y);
          if (d <= DOT_RADIUS) color = DOT;
          else if (d <= RING_RADIUS) color = [255, 255, 255];
        }
      }
      rgb.set(color, (py * size + px) * 3);
    }
  }
  return encodePng(size, size, rgb);
}

/**
 * @typedef {{ path: string, userAgent: string, accept: string, cookie: string | undefined,
 *   at: number, status: number }} SeenRequest
 */

/**
 * Starts the server on 127.0.0.1.
 * @param {{ port?: number }} [options]
 */
export async function startTileServer({ port = DEFAULT_PORT } = {}) {
  /** @type {'ok' | 'slow' | 'refuse'} */
  let mode = 'ok';
  let storeMissing = false;
  /** @type {SeenRequest[]} */
  const seen = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const record = (/** @type {number} */ status) =>
      seen.push({
        path,
        userAgent: request.headers['user-agent'] ?? '',
        accept: request.headers.accept ?? '',
        cookie: request.headers.cookie,
        at: Date.now(),
        status,
      });
    const match = /^\/([a-z]+)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(path);
    const map = MAPS.find((candidate) => candidate.slug === match?.[1]);
    const [sourceZ, rx, ry] = (match ?? []).slice(2).map(Number);
    const level = map?.levels.find((candidate) => candidate.sourceZ === sourceZ);
    const answer = () => {
      if (mode === 'refuse') {
        record(403);
        response.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden');
        return;
      }
      if (!map || !level || rx === undefined || ry === undefined) {
        record(404);
        response.writeHead(404).end();
        return;
      }
      const x = rx - level.offsetX;
      const y = ry - level.offsetY;
      if (
        map.slug === MISSING_TILE.map &&
        level.z === MISSING_TILE.z &&
        x === MISSING_TILE.x &&
        y === MISSING_TILE.y
      ) {
        record(404);
        response.writeHead(404).end();
        return;
      }
      if (
        storeMissing &&
        map.slug === STORE_MISSING_TILE.map &&
        level.z === STORE_MISSING_TILE.z &&
        x === STORE_MISSING_TILE.x &&
        y === STORE_MISSING_TILE.y
      ) {
        record(403);
        response
          .writeHead(403, { 'content-type': 'application/xml', via: '1.1 test-cache' })
          .end(NO_SUCH_OBJECT);
        return;
      }
      record(200);
      response.writeHead(200, { 'content-type': 'image/png' }).end(drawTile(map, level.z, x, y));
    };
    if (mode === 'slow') setTimeout(answer, 400);
    else answer();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(undefined);
    });
  });
  return {
    url: `http://127.0.0.1:${port}/`,
    seen,
    setMode(/** @type {'ok' | 'slow' | 'refuse'} */ next) {
      mode = next;
    },
    /** Answers `STORE_MISSING_TILE` like an object store without it. */
    setStoreMissing(/** @type {boolean} */ on) {
      storeMissing = on;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.ATLAS_E2E_TILE_PORT ?? DEFAULT_PORT);
  const server = await startTileServer({ port });
  console.log(`Mock tiles at ${server.url}`);
}
