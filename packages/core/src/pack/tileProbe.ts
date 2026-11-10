/** The PMTiles v3 magic number, "PM" read as a little-endian 16-bit integer. */
const PMTILES_MAGIC = 0x4d50;

export interface TileSourceRef {
  type: 'pmtiles' | 'xyz';
  /** Absolute URL; a `{z}/{x}/{y}` template for `xyz`. */
  url: string;
}

/**
 * Checks once whether a layer's tiles can be read, so a pack whose tiles have
 * not been downloaded yet shows its markers on a plain background instead of
 * failing every tile request. For PMTiles it reads the archive header; for a
 * tile folder, the top-left tile of the lowest level.
 */
export async function probeTiles(
  source: TileSourceRef,
  minZoom: number,
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<boolean> {
  try {
    if (source.type === 'pmtiles') {
      const response = await fetchFn(source.url, { headers: { range: 'bytes=0-15' } });
      if (!response.ok) return false;
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.length >= 2 && (bytes[0]! | (bytes[1]! << 8)) === PMTILES_MAGIC;
    }
    const url = source.url.replace('{z}', String(minZoom)).replace('{x}', '0').replace('{y}', '0');
    const response = await fetchFn(url);
    return response.ok;
  } catch {
    return false;
  }
}
