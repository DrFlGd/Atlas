import { parseId, type Layer } from '@atlas/schema';
import { z } from 'zod';
import type { LoadedPack } from './loadedPack';

/**
 * The status file the desktop app writes next to a layer's downloaded map
 * images, at `offline-tiles/<layer local id>.json` in the pack. It lists the
 * complete pyramid levels, so the map can use a partial pyramid while the
 * rest downloads, or when only part of it was asked for.
 */
export const tileStatusSchema = z.object({
  format: z.literal('atlas-tile-status'),
  version: z.literal(1),
  layerId: z.string(),
  /** Every complete level, ascending. */
  levels: z.array(z.int().nonnegative()),
  /** The unbroken run of complete levels from the layer's `minZoom` up; null while none. */
  nativeMinZoom: z.int().nonnegative().nullable(),
  nativeMaxZoom: z.int().nonnegative().nullable(),
  /** Every level of the layer is there. */
  complete: z.boolean(),
  /** Milliseconds since 1970. */
  updatedAt: z.number(),
});

export type TileStatusFile = z.infer<typeof tileStatusSchema>;

/** Folder of the status files, relative to the pack root. */
export const TILE_STATUS_DIR = 'offline-tiles';

/** Whether a layer's tiles can be downloaded (an `xyz` layer with a `remote`). */
export function isDownloadable(layer: Layer): boolean {
  return layer.tiles.type === 'xyz' && layer.tiles.remote !== undefined;
}

/** The status file of a downloadable layer, relative to the pack root, or null. */
export function tileStatusPath(layer: Layer): string | null {
  const localId = parseId(layer.id)?.localId;
  return isDownloadable(layer) && localId ? `${TILE_STATUS_DIR}/${localId}.json` : null;
}

/**
 * Reads a downloadable layer's status file. Null when the layer is not
 * downloadable, nothing was downloaded, or the file does not match the layer.
 */
export async function readTileStatus(
  pack: LoadedPack,
  layer: Layer,
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<TileStatusFile | null> {
  const path = tileStatusPath(layer);
  if (!path) return null;
  try {
    const response = await fetchFn(pack.resolveUrl(path), { cache: 'no-store' });
    if (!response.ok) return null;
    const parsed = tileStatusSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.layerId !== layer.id) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** The native zoom range a status file allows, clamped to the layer, or null. */
export function nativeZoomOf(
  layer: Layer,
  status: TileStatusFile | null,
): { min: number; max: number } | null {
  if (status?.nativeMinZoom == null || status.nativeMaxZoom == null) return null;
  const min = Math.max(layer.minZoom, status.nativeMinZoom);
  const max = Math.min(layer.maxZoom, status.nativeMaxZoom);
  return min <= max ? { min, max } : null;
}
