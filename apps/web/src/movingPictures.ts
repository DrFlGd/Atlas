/**
 * Pictures of a page that move (a GIF of more than one picture, kept as it
 * is, see the shell's `tiles::manager::photos`), for people who prefer less
 * motion. When the system asks for reduced motion
 * (`prefers-reduced-motion: reduce`), such a picture is shown still, as its
 * first picture, with a small "Play" button on it; pressing the button
 * plays that picture, as it is shown without the setting. A GIF that does
 * not move is left as it is, and so is every picture without the setting.
 *
 * Whether a GIF moves, and whether it plays for ever, is read from its
 * bytes ({@link gifMotion}): the picture's own file, from the pack's
 * folder, once more, and once only for each picture ({@link readMotion}),
 * with or without the setting. A picture that moves opens in the larger
 * view when pressed, and its corner mark says it plays (see
 * `pictureLarge.ts`); the larger view plays the bytes read from their
 * start.
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

/** What the walk of a GIF's blocks found: its pictures, counted no further than two, and its looping count. */
interface GifWalk {
  frames: number;
  loops: number | null;
}

/** The names of the application extension that says how often a GIF plays. */
const LOOPING = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);

/**
 * Walks a GIF's blocks until `enough` says so or the GIF ends, counting its
 * pictures (no further than two) and reading its looping extension. Null
 * for bytes that are no GIF, or that end before its first picture.
 */
function walkGif(bytes: Uint8Array, enough: (walk: GifWalk) => boolean): GifWalk | null {
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
  const walk: GifWalk = { frames: 0, loops: null };
  while (!enough(walk) && at !== null) {
    const block: number | undefined = bytes[at];
    if (block === 0x21) {
      // An extension: its label, then its blocks. The looping one is an
      // application extension (0xff) named in a block of 11 bytes, then a
      // block of 3: 1, and the count, low byte first.
      if (bytes[at + 1] === 0xff && bytes[at + 2] === 11 && bytes[at + 14]! >= 3) {
        const name = String.fromCharCode(...bytes.subarray(at + 3, at + 14));
        if (LOOPING.has(name) && bytes[at + 15] === 1 && bytes[at + 17] !== undefined) {
          walk.loops = bytes[at + 16]! | (bytes[at + 17]! << 8);
        }
      }
      at = skipBlocks(at + 2);
    } else if (block === 0x2c) {
      // A picture: where it goes (9 bytes), its own colours, the size of its codes, then its blocks.
      const flags = bytes[at + 9];
      if (flags === undefined) return null;
      at = skipBlocks(at + 10 + table(flags) + 1);
      if (at === null) return null;
      walk.frames = Math.min(2, walk.frames + 1);
    } else {
      break;
    }
  }
  return walk.frames > 0 ? walk : null;
}

/**
 * How many pictures (frames) a GIF holds, counting no further than two: 2
 * for one that moves. Null for bytes that are no GIF, or that end before
 * its first picture. Only the GIF's blocks are walked; nothing is decoded.
 */
export function gifFrames(bytes: Uint8Array): number | null {
  return walkGif(bytes, (walk) => walk.frames >= 2)?.frames ?? null;
}

/** How a GIF moves, read from its bytes. */
export interface GifMotion {
  /** It holds more than one picture. */
  moves: boolean;
  /**
   * It plays for ever: its looping extension (the application extension
   * "NETSCAPE2.0") gives a count of 0. Without that extension a GIF plays
   * once; with any other count it plays a few times, then stops.
   */
  forever: boolean;
}

/**
 * How a GIF moves: whether it holds more than one picture, and whether it
 * plays for ever. Null for bytes that are no GIF, or that end before its
 * first picture. The blocks are walked to the end when they need to be,
 * as the looping extension may come after the first pictures; nothing is
 * decoded.
 */
export function gifMotion(bytes: Uint8Array): GifMotion | null {
  const walk = walkGif(bytes, ({ frames, loops }) => frames >= 2 && loops !== null);
  return walk ? { moves: walk.frames >= 2, forever: walk.loops === 0 } : null;
}

/** A picture's file read once, for what its motion needs (see {@link readMotion}). */
export interface PictureMotion extends GifMotion {
  /** The address read. */
  address: string;
  /** The file's bytes, kept only for a picture that moves: the larger view plays them from their start. */
  bytes?: Uint8Array;
}

/** Marks a picture of a page that moves, once read: `forever`, or `stops` after a few plays. */
export const MOVES = 'data-moves';

/** The reading of each picture's file, by the address it was read at. */
const readings = new WeakMap<
  HTMLImageElement,
  { address: string; motion: Promise<PictureMotion | null>; read?: PictureMotion | null }
>();

/**
 * Reads a GIF picture of a page once, to learn whether it moves and
 * whether it plays for ever: its file, from the pack's folder. A picture
 * that moves is marked (`data-moves`) and keeps its bytes. Null for a
 * picture that is no GIF, or whose file cannot be read. A picture shown
 * from another address since (its file instead of its copy) is read again.
 */
export function readMotion(img: HTMLImageElement): Promise<PictureMotion | null> {
  const address = img.currentSrc || img.src;
  if (!isGifAddress(address)) return Promise.resolve(null);
  const known = readings.get(img);
  if (known?.address === address) return known.motion;
  const reading: {
    address: string;
    motion: Promise<PictureMotion | null>;
    read?: PictureMotion | null;
  } = {
    address,
    motion: Promise.resolve(null),
  };
  reading.motion = (async (): Promise<PictureMotion | null> => {
    let bytes: Uint8Array;
    try {
      const response = await fetch(address);
      if (!response.ok) return null;
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      return null;
    }
    const read = gifMotion(bytes);
    if (!read) return null;
    // The picture may show another file meanwhile.
    if ((img.currentSrc || img.src) === address) {
      if (read.moves) img.setAttribute(MOVES, read.forever ? 'forever' : 'stops');
      else img.removeAttribute(MOVES);
    }
    reading.read = read.moves ? { ...read, address, bytes } : { ...read, address };
    return reading.read;
  })();
  readings.set(img, reading);
  return reading.motion;
}

/**
 * The bytes of a picture of a page that moves, when they have been read
 * from `address`: the larger view plays them from their start.
 */
export function movingBytes(img: HTMLImageElement, address: string): Uint8Array | null {
  const known = readings.get(img);
  return known?.address === address ? (known.read?.bytes ?? null) : null;
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
  // The same reading as the one that tells whether it moves (see readMotion).
  const bytes = (await readMotion(img))?.bytes;
  // The page may have been shown anew meanwhile.
  const gone = () => !img.isConnected;
  if (!bytes || gone()) return;
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
