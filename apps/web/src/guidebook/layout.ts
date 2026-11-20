/**
 * The arithmetic of the guidebook reader, apart from the page so it can be
 * tested: where each page is in the column of pages, which pages are in
 * view, the zoom that fits a page, the hits of a search next to a page,
 * and where the words looked for are in a run of text.
 */

export interface Size {
  width: number;
  height: number;
}

/** The space between pages, and around them, in CSS pixels. */
export const GAP = 12;
/** The smallest and largest zoom (1 is a page at its own size). */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
/** One step of the zoom buttons. */
export const ZOOM_STEP = 1.25;

export const clampZoom = (zoom: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(zoom) ? zoom : 1));

/** A zoom one step in or out, rounded to a whole percent. */
export function stepZoom(zoom: number, steps: number): number {
  return clampZoom(Math.round(zoom * ZOOM_STEP ** steps * 100) / 100);
}

/**
 * Where each page starts in the column (from 1: `starts[0]` is page 1's),
 * at `scale`, with {@link GAP} above each page; and the column's height.
 * A page whose size is not known yet takes `guess`.
 */
export function column(
  pages: number,
  sizes: ReadonlyMap<number, Size>,
  guess: Size,
  scale: number,
): { starts: Float64Array; heights: Float64Array; height: number; width: number } {
  const starts = new Float64Array(pages);
  const heights = new Float64Array(pages);
  let at = GAP;
  let width = guess.width * scale;
  for (let n = 1; n <= pages; n++) {
    const size = sizes.get(n) ?? guess;
    starts[n - 1] = at;
    heights[n - 1] = size.height * scale;
    at += size.height * scale + GAP;
    if (size.width * scale > width) width = size.width * scale;
  }
  return { starts, heights, height: at, width: width + 2 * GAP };
}

/** The page (from 1) at `y` in the column: the last one that starts above it. */
export function pageAt(starts: Float64Array, y: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= y) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** The pages in view between `top` and `bottom`, and `extra` more on each side. */
export function pagesInView(
  starts: Float64Array,
  top: number,
  bottom: number,
  extra = 1,
): { first: number; last: number } {
  const pages = starts.length;
  return {
    first: Math.max(1, pageAt(starts, top) - extra),
    last: Math.min(pages, pageAt(starts, bottom) + extra),
  };
}

/** The zoom at which a page of `size` (at zoom 1, `unit` pixels each) fits the `room`: its width, or all of it. */
export function fitZoom(fit: 'width' | 'page', size: Size, room: Size, unit: number): number {
  const width = (room.width - 2 * GAP) / (size.width * unit);
  if (fit === 'width') return clampZoom(width);
  const height = (room.height - 2 * GAP) / (size.height * unit);
  return clampZoom(Math.min(width, height));
}

/** The page of `hits` (sorted pages) after `page` (`step` 1) or before it (-1), going round. */
export function nextHit(hits: readonly number[], page: number, step: 1 | -1): number | null {
  if (hits.length === 0) return null;
  if (step === 1) return hits.find((hit) => hit > page) ?? hits[0]!;
  return [...hits].reverse().find((hit) => hit < page) ?? hits.at(-1)!;
}

/** The words of a search, as they are looked for in text: lower case, at least one letter or digit. */
export function searchWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((word) => word !== '');
}

/**
 * The parts of a run of text that are words looked for, as shares of its
 * width: where each starts and how wide it is, from 0 to 1. A run is
 * marked where its letters are, as if each letter were as wide.
 */
export function marksIn(
  text: string,
  words: readonly string[],
): { start: number; width: number }[] {
  const lower = text.toLowerCase();
  const marks: { start: number; width: number }[] = [];
  if (lower.length === 0) return marks;
  for (const word of words) {
    for (
      let at = lower.indexOf(word);
      at >= 0 && marks.length < 50;
      at = lower.indexOf(word, at + 1)
    ) {
      marks.push({ start: at / lower.length, width: word.length / lower.length });
    }
  }
  return marks;
}

/** A page number typed, when it is one of the guidebook's pages. */
export function typedPage(text: string, pages: number): number | null {
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 1 && value <= pages ? value : null;
}
