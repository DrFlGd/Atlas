import { create } from 'zustand';

/**
 * Which picture the larger view shows (`components/PictureViewer.tsx`),
 * and how large it is fitted.
 */

export interface ShownPicture {
  /** The picture's file. */
  url: string;
  /** What it shows: its caption, its alternative text, or "Photo of …". */
  description: string;
  credit?: string;
  /** Another file of it, shown when `url` cannot be loaded (a copy for pages). */
  fallbackUrl?: string;
  /** The element it was opened from, which gets the focus back. */
  opener?: HTMLElement | null;
}

export const useViewer = create<{ shown: ShownPicture | null; opened: number }>()(() => ({
  shown: null,
  opened: 0,
}));

/** Opens a picture in the larger view. */
export function openPicture(shown: ShownPicture): void {
  useViewer.setState((s) => ({ shown, opened: s.opened + 1 }));
}

/** Closes the larger view, if it is open. */
export function closePicture(): void {
  useViewer.setState({ shown: null });
}

/** A small picture is shown at most this many times its own size when fitted. */
export const MOST_ENLARGED = 4;

/** The size a picture is fitted at in `room`, and whether that is smaller than its real size. */
export function fittedSize(
  natural: { width: number; height: number },
  room: { width: number; height: number },
): { width: number; height: number; scale: number; zoomable: boolean } {
  const scale = Math.min(room.width / natural.width, room.height / natural.height, MOST_ENLARGED);
  return {
    width: Math.max(1, Math.round(natural.width * scale)),
    height: Math.max(1, Math.round(natural.height * scale)),
    scale,
    zoomable: scale < 1,
  };
}
