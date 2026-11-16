/**
 * Pictures of a page that move (a GIF of more than one picture, kept as it
 * is, see the shell's `tiles::manager::photos`), for people who prefer less
 * motion. When the system asks for reduced motion
 * (`prefers-reduced-motion: reduce`), such a picture is shown still, as its
 * first picture, with a small "Play" button on it; pressing the button
 * plays that picture, as it is shown without the setting. A GIF that does
 * not move is left as it is, and so is every picture without the setting.
 *
 * Whether a GIF moves is read from its bytes ({@link gifFrames}): the
 * picture's own file, from the pack's folder, once more.
 */

/** Marks a picture of a page already looked at: `still`, `played` or `as-is`. */
const MARK = 'data-motion';

/** Whether the system asks for less motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Whether an address names a GIF file. */
export function isGifAddress(address: string): boolean {
  try {
    return /\.gif$/iu.test(new URL(address, 'http://localhost/').pathname);
  } catch {
    return false;
  }
}

/**
 * How many pictures (frames) a GIF holds, counting no further than two: 2
 * for one that moves. Null for bytes that are no GIF, or that end before
 * its first picture. Only the GIF's blocks are walked; nothing is decoded.
 */
export function gifFrames(bytes: Uint8Array): number | null {
  const head = String.fromCharCode(...bytes.subarray(0, 6));
  if ((head !== 'GIF87a' && head !== 'GIF89a') || bytes.length < 13) return null;
  // A table of colours of 3 × 2^(n + 1) bytes, when the flags say so.
  const table = (flags: number) => (flags & 0x80 ? 3 << ((flags & 0x07) + 1) : 0);
  // Blocks of data, each its length first, until one of length 0.
  const skipBlocks = (from: number): number | null => {
    let at = from;
    for (;;) {
      const length = bytes[at];
      if (length === undefined) return null;
      at += 1;
      if (length === 0) return at;
      at += length;
    }
  };
  let at: number | null = 13 + table(bytes[10]!);
  let frames = 0;
  while (frames < 2 && at !== null) {
    const block: number | undefined = bytes[at];
    if (block === 0x21) {
      // An extension: its label, then its blocks.
      at = skipBlocks(at + 2);
    } else if (block === 0x2c) {
      // A picture: where it goes (9 bytes), its own colours, the size of its codes, then its blocks.
      const flags = bytes[at + 9];
      if (flags === undefined) return null;
      at = skipBlocks(at + 10 + table(flags) + 1);
      if (at === null) return null;
      frames += 1;
    } else {
      break;
    }
  }
  return frames > 0 ? frames : null;
}

/**
 * Shows a picture of a page still when it moves and the system asks for
 * less motion: its first picture drawn over it, the same size, with a
 * "Play" button named after what it shows. Does nothing otherwise, and
 * nothing for a picture already looked at.
 */
export async function holdMovingPicture(img: HTMLImageElement): Promise<void> {
  if (img.hasAttribute(MARK) || !prefersReducedMotion()) return;
  const address = img.currentSrc || img.src;
  if (!isGifAddress(address)) return;
  img.setAttribute(MARK, 'as-is');
  let bytes: Uint8Array;
  try {
    const response = await fetch(address);
    if (!response.ok) return;
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return;
  }
  // The page may have been shown anew meanwhile.
  const gone = () => !img.isConnected;
  if ((gifFrames(bytes) ?? 0) < 2 || gone()) return;
  let first: ImageBitmap;
  try {
    first = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/gif' }));
  } catch {
    return;
  }
  if (gone()) return;
  const canvas = document.createElement('canvas');
  canvas.width = first.width;
  canvas.height = first.height;
  canvas.getContext('2d')?.drawImage(first, 0, 0);
  first.close();
  canvas.className = 'moving-picture-still';
  canvas.setAttribute('aria-hidden', 'true');
  const what = img.alt.trim();
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'moving-picture-play';
  play.textContent = 'Play';
  play.setAttribute(
    'aria-label',
    what ? `Play the moving picture: ${what}` : 'Play the moving picture',
  );
  play.title = 'This picture moves. It is shown still because your system asks for less motion.';
  const frame = document.createElement('span');
  frame.className = 'moving-picture';
  frame.setAttribute('data-still', '');
  img.replaceWith(frame);
  frame.append(img, canvas, play);
  img.setAttribute(MARK, 'still');
  play.addEventListener('click', (event) => {
    // Not a press of the link or the picture it is on.
    event.preventDefault();
    event.stopPropagation();
    canvas.remove();
    play.remove();
    frame.removeAttribute('data-still');
    img.setAttribute(MARK, 'played');
    // From its first picture.
    const source = img.src;
    img.src = '';
    img.src = source;
    img.focus({ preventScroll: true });
  });
}
