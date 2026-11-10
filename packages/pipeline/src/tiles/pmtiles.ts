import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { zxyToTileId } from 'pmtiles';
import type { Tile } from './cutPyramid';

/**
 * A writer for PMTiles v3 archives (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
 *
 * Layout: 127-byte header, root directory, JSON metadata, leaf directories,
 * tile data. Directories and metadata are gzip-compressed; tile data is
 * stored as given. Tiles are ordered by Hilbert tile id ("clustered"),
 * identical tiles are stored once, and runs of consecutive identical tiles
 * share one directory entry.
 */

const HEADER_SIZE = 127;
/** Readers fetch the first 16 KiB in one request; header and root directory must fit in it. */
const ROOT_LIMIT = 16384 - HEADER_SIZE;

const COMPRESSION_NONE = 1;
const COMPRESSION_GZIP = 2;

export const TILE_TYPE = { png: 2, jpeg: 3, webp: 4, avif: 5 } as const;

export interface PmtilesOptions {
  tileType: keyof typeof TILE_TYPE;
  minZoom: number;
  maxZoom: number;
  /** Stored in the archive's JSON metadata. */
  metadata?: Record<string, unknown>;
  /** Largest root directory, in bytes, before leaf directories are used. For tests. */
  rootLimit?: number;
}

interface Entry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

/** Builds a complete PMTiles archive in memory. */
export function writePmtiles(tiles: readonly Tile[], options: PmtilesOptions): Buffer {
  const sorted = tiles
    .map((tile) => ({ tile, tileId: zxyToTileId(tile.z, tile.x, tile.y) }))
    .sort((a, b) => a.tileId - b.tileId);

  const chunks: Buffer[] = [];
  const offsetsByHash = new Map<string, { offset: number; length: number }>();
  const entries: Entry[] = [];
  let dataLength = 0;
  for (const { tile, tileId } of sorted) {
    const hash = createHash('sha256').update(tile.data).digest('hex');
    let stored = offsetsByHash.get(hash);
    if (!stored) {
      stored = { offset: dataLength, length: tile.data.length };
      offsetsByHash.set(hash, stored);
      chunks.push(tile.data);
      dataLength += tile.data.length;
    }
    const last = entries.at(-1);
    if (
      last?.offset === stored.offset &&
      last.length === stored.length &&
      last.tileId + last.runLength === tileId
    ) {
      last.runLength++;
    } else {
      if (last?.tileId === tileId) throw new Error(`duplicate tile ${tile.z}/${tile.x}/${tile.y}`);
      entries.push({ tileId, offset: stored.offset, length: stored.length, runLength: 1 });
    }
  }

  const { root, leaves } = buildDirectories(entries, options.rootLimit ?? ROOT_LIMIT);
  const metadata = gzipSync(Buffer.from(JSON.stringify(options.metadata ?? {})));

  const rootOffset = HEADER_SIZE;
  const metadataOffset = rootOffset + root.length;
  const leafOffset = metadataOffset + metadata.length;
  const tileDataOffset = leafOffset + leaves.length;

  const header = Buffer.alloc(HEADER_SIZE);
  header.write('PMTiles', 0, 'ascii');
  header.writeUInt8(3, 7);
  const u64 = (value: number, at: number) => header.writeBigUInt64LE(BigInt(value), at);
  u64(rootOffset, 8);
  u64(root.length, 16);
  u64(metadataOffset, 24);
  u64(metadata.length, 32);
  u64(leafOffset, 40);
  u64(leaves.length, 48);
  u64(tileDataOffset, 56);
  u64(dataLength, 64);
  u64(sorted.length, 72); // addressed tiles
  u64(entries.length, 80); // tile entries
  u64(offsetsByHash.size, 88); // tile contents
  header.writeUInt8(1, 96); // clustered
  header.writeUInt8(COMPRESSION_GZIP, 97); // internal compression
  header.writeUInt8(COMPRESSION_NONE, 98); // tile compression
  header.writeUInt8(TILE_TYPE[options.tileType], 99);
  header.writeUInt8(options.minZoom, 100);
  header.writeUInt8(options.maxZoom, 101);
  // The format describes geographic bounds. A game map has none, so the whole
  // Web Mercator range is declared to keep readers that validate bounds happy.
  header.writeInt32LE(-180 * 1e7, 102);
  header.writeInt32LE(-85 * 1e7, 106);
  header.writeInt32LE(180 * 1e7, 110);
  header.writeInt32LE(85 * 1e7, 114);
  header.writeUInt8(options.minZoom, 118);
  header.writeInt32LE(0, 119);
  header.writeInt32LE(0, 123);

  return Buffer.concat([header, root, metadata, leaves, ...chunks]);
}

/** Splits entries into a root directory and, when it would be too large, leaf directories. */
function buildDirectories(entries: Entry[], rootLimit: number): { root: Buffer; leaves: Buffer } {
  const root = serializeDirectory(entries);
  if (root.length <= rootLimit) return { root, leaves: Buffer.alloc(0) };

  for (let leafSize = 4096; ; leafSize *= 2) {
    const leafBuffers: Buffer[] = [];
    const rootEntries: Entry[] = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const leaf = serializeDirectory(entries.slice(i, i + leafSize));
      rootEntries.push({ tileId: entries[i]!.tileId, offset, length: leaf.length, runLength: 0 });
      leafBuffers.push(leaf);
      offset += leaf.length;
    }
    const leafRoot = serializeDirectory(rootEntries);
    if (leafRoot.length <= rootLimit || rootEntries.length === 1) {
      return { root: leafRoot, leaves: Buffer.concat(leafBuffers) };
    }
  }
}

function serializeDirectory(entries: readonly Entry[]): Buffer {
  const bytes: number[] = [];
  const varint = (value: number) => {
    let v = value;
    while (v >= 0x80) {
      bytes.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    bytes.push(v);
  };
  varint(entries.length);
  let lastId = 0;
  for (const entry of entries) {
    varint(entry.tileId - lastId);
    lastId = entry.tileId;
  }
  for (const entry of entries) varint(entry.runLength);
  for (const entry of entries) varint(entry.length);
  entries.forEach((entry, i) => {
    const previous = entries[i - 1];
    // 0 means "directly after the previous entry's data".
    if (previous && entry.offset === previous.offset + previous.length) varint(0);
    else varint(entry.offset + 1);
  });
  return gzipSync(Buffer.from(bytes));
}
