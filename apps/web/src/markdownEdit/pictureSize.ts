/**
 * The size a page shows a picture at, written as the picture's title in the
 * Markdown: `"=28x13"` (width and height) or `"=28"` (width only), in CSS
 * pixels. A picture whose height is at most 48 pixels is shown in the line
 * of text, as an emoji is. No title: its own size. Any other title is not a
 * size, and is kept as it is.
 */

import { INLINE_PICTURE_HEIGHT, isInlinePicture, shownSize } from '../markdown';

export type PictureSize =
  | { kind: 'own' }
  | { kind: 'inline'; width: number; height: number }
  | { kind: 'width'; width: number; height?: number }
  /** A title that is not a size. */
  | { kind: 'other'; title: string };

/** The tallest picture shown in the line of text. */
export const INLINE_MAX_HEIGHT = INLINE_PICTURE_HEIGHT;
/** The height a picture put in the line of text gets. */
export const INLINE_HEIGHT = 20;
export const MAX_PICTURE_WIDTH = 4000;

/** Reads a title as the page itself does when it is shown (`shownSize` in `markdown.ts`). */
export function readPictureSize(title: string | undefined): PictureSize {
  if (title === undefined || title === '') return { kind: 'own' };
  const size = shownSize(title);
  if (!size) return { kind: 'other', title };
  const { width, height } = size;
  // A width alone that small is shown in the line too; its title is kept as written.
  if (isInlinePicture(size) && height !== undefined) return { kind: 'inline', width, height };
  return height === undefined ? { kind: 'width', width } : { kind: 'width', width, height };
}

/** The title that says a size; undefined for the picture's own size. */
export function writePictureSize(size: PictureSize): string | undefined {
  switch (size.kind) {
    case 'own':
      return undefined;
    case 'other':
      return size.title;
    case 'inline':
      return `=${size.width}x${size.height}`;
    case 'width':
      return size.height === undefined ? `=${size.width}` : `=${size.width}x${size.height}`;
  }
}

/** The size of a picture put in the line of text: its shape kept, when it is known. */
export function inlineSize(width?: number, height?: number): PictureSize {
  const w = width && height ? Math.max(1, Math.round((INLINE_HEIGHT * width) / height)) : 20;
  return { kind: 'inline', width: Math.min(w, MAX_PICTURE_WIDTH), height: INLINE_HEIGHT };
}

/** A width typed, as a size: null when it is not one. */
export function widthSize(text: string): PictureSize | null {
  const width = Number(text.trim());
  if (!Number.isInteger(width) || width < 1 || width > MAX_PICTURE_WIDTH) return null;
  return { kind: 'width', width };
}
