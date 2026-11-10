import { PMTiles, TileType, type RangeResponse, type Source } from 'pmtiles';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { cutPyramid, type Tile } from './cutPyramid';
import { writePmtiles } from './pmtiles';

/** Serves byte ranges of an in-memory archive, as an HTTP server with range support would. */
class BufferSource implements Source {
  constructor(private readonly buffer: Buffer) {}
  getKey() {
    return 'memory';
  }
  getBytes(offset: number, length: number): Promise<RangeResponse> {
    const slice = this.buffer.subarray(offset, offset + length);
    return Promise.resolve({
      data: slice.buffer.slice(
        slice.byteOffset,
        slice.byteOffset + slice.byteLength,
      ) as ArrayBuffer,
    });
  }
}

function gradientImage(width: number, height: number) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      data[o] = (x * 255) / width;
      data[o + 1] = (y * 255) / height;
      data[o + 2] = 128;
    }
  }
  return { data, width, height, channels: 3 as const };
}

describe('cutPyramid', () => {
  it('cuts every level of a non-square image into full-size tiles', async () => {
    const pyramid = await cutPyramid(gradientImage(600, 300), { tileSize: 256 });
    expect(pyramid.maxZoom).toBe(2);
    const keys = pyramid.tiles.map((t) => `${t.z}/${t.x}/${t.y}`).sort();
    // z2: 3x2 tiles, z1: 2x1 (300x150), z0: 1x1 (150x75).
    expect(keys).toEqual([
      '0/0/0',
      '1/0/0',
      '1/1/0',
      '2/0/0',
      '2/0/1',
      '2/1/0',
      '2/1/1',
      '2/2/0',
      '2/2/1',
    ]);
    for (const tile of pyramid.tiles) {
      const meta = await sharp(tile.data).metadata();
      expect(meta.format).toBe('webp');
      expect([meta.width, meta.height]).toEqual([256, 256]);
    }
  });

  it('pads partial edge tiles with transparency', async () => {
    const pyramid = await cutPyramid(gradientImage(600, 300), { tileSize: 256 });
    const edge = pyramid.tiles.find((t) => t.z === 2 && t.x === 2 && t.y === 1)!;
    const { data, info } = await sharp(edge.data)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
    expect(alphaAt(10, 10)).toBe(255); // inside the image (600 - 512 = 88 px wide, 300 - 256 = 44 px tall)
    expect(alphaAt(200, 10)).toBe(0);
    expect(alphaAt(10, 200)).toBe(0);
  });

  it('respects minZoom', async () => {
    const pyramid = await cutPyramid(gradientImage(600, 300), { tileSize: 256, minZoom: 2 });
    expect(new Set(pyramid.tiles.map((t) => t.z))).toEqual(new Set([2]));
  });
});

describe('writePmtiles', () => {
  const fakeTiles = (maxZoom: number): Tile[] => {
    const tiles: Tile[] = [];
    for (let z = 0; z <= maxZoom; z++) {
      for (let x = 0; x < 2 ** z; x++) {
        for (let y = 0; y < 2 ** z; y++)
          tiles.push({ z, x, y, data: Buffer.from(`tile ${z}/${x}/${y}`) });
      }
    }
    return tiles;
  };

  it('writes an archive the pmtiles reader can read back', async () => {
    const tiles = fakeTiles(3);
    const archive = new PMTiles(
      new BufferSource(
        writePmtiles(tiles, {
          tileType: 'webp',
          minZoom: 0,
          maxZoom: 3,
          metadata: { name: 'test' },
        }),
      ),
    );
    const header = await archive.getHeader();
    expect(header.specVersion).toBe(3);
    expect(header.tileType).toBe(TileType.Webp);
    expect([header.minZoom, header.maxZoom]).toEqual([0, 3]);
    expect(header.numAddressedTiles).toBe(tiles.length);
    expect(header.clustered).toBe(true);
    expect(await archive.getMetadata()).toEqual({ name: 'test' });
    for (const tile of tiles) {
      const read = await archive.getZxy(tile.z, tile.x, tile.y);
      expect(Buffer.from(read!.data).toString()).toBe(tile.data.toString());
    }
    expect(await archive.getZxy(4, 0, 0)).toBeUndefined();
  });

  it('stores identical tiles once and run-length encodes consecutive ones', async () => {
    const blank = Buffer.from('same');
    const tiles = fakeTiles(2).map((t) => ({ ...t, data: blank }));
    const buffer = writePmtiles(tiles, { tileType: 'png', minZoom: 0, maxZoom: 2 });
    const archive = new PMTiles(new BufferSource(buffer));
    const header = await archive.getHeader();
    expect(header.numTileContents).toBe(1);
    expect(header.numTileEntries).toBe(1);
    expect(header.tileDataLength).toBe(blank.length);
    expect(Buffer.from((await archive.getZxy(2, 3, 1))!.data).toString()).toBe('same');
  });

  it('falls back to leaf directories when the root directory is too large', async () => {
    const tiles = fakeTiles(5);
    const buffer = writePmtiles(tiles, { tileType: 'webp', minZoom: 0, maxZoom: 5, rootLimit: 64 });
    const archive = new PMTiles(new BufferSource(buffer));
    const header = await archive.getHeader();
    expect(header.leafDirectoryLength).toBeGreaterThan(0);
    for (const tile of [tiles[0]!, tiles[500]!, tiles.at(-1)!]) {
      const read = await archive.getZxy(tile.z, tile.x, tile.y);
      expect(Buffer.from(read!.data).toString()).toBe(tile.data.toString());
    }
  });

  it('rejects duplicate tile coordinates', () => {
    const tile = { z: 0, x: 0, y: 0, data: Buffer.from('a') };
    expect(() =>
      writePmtiles([tile, { ...tile, data: Buffer.from('b') }], {
        tileType: 'webp',
        minZoom: 0,
        maxZoom: 0,
      }),
    ).toThrow(/duplicate tile/);
  });
});
