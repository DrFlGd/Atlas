import type { LoadedPack } from '@atlas/core';

/**
 * Whether a pack says its pages are a guide, read in order (its manifest's
 * `pagesInOrder`, the literal `true`), rather than a wiki read as a
 * collection. The person's own say, kept with their own pages, wins over
 * it (see `guideSources.ts`).
 *
 * Read here only, so that the field is read in one place.
 */
export function packSaysPagesInOrder(pack: LoadedPack): boolean {
  return pack.manifest.pagesInOrder === true;
}
