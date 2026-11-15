import { openPicture } from './state/pictureViewer';

/**
 * Pictures in the text of a page that open in the larger view
 * (`components/PictureViewer.tsx`) when pressed, or with Enter or Space
 * once focused. A picture opens large when its file is larger than the
 * page shows it (an icon in a line of text included); one whose file is no
 * larger than shown opens nothing, as there would be nothing more to see,
 * and is left as it was. A picture that is a link (an item's icon that
 * leads to its page) follows its link, as before, and does not open large.
 *
 * A picture with a smaller copy for pages (`data-full`, see
 * `GuidePicture.fullUrl`) shows that copy on the page and its file large;
 * when the copy is not there, the page shows the file.
 */

/** Marks a picture that opens large. */
const OPENS = 'data-opens-large';

/** Whether a picture shown at `shown` CSS pixels opens large: its file is larger. */
export function opensLarger(
  natural: { width: number; height: number },
  shown: { width: number; height: number },
  linked = false,
): boolean {
  if (linked || natural.width <= 0 || shown.width <= 0) return false;
  // A copy for pages is never larger than its file: larger than shown, its file is too.
  return natural.width > shown.width + 1 || natural.height > shown.height + 1;
}

/** Whether a picture of a page is inside a link or a button. */
const isLinked = (img: Element) => img.closest('a, button, [data-atlas-target]') !== null;

/**
 * Marks a picture of a page that opens large, once it has loaded, so it
 * can be pressed and focused: a button for screen readers, named by what
 * it shows. One that does not is left as it is.
 */
export function markLargePicture(img: HTMLImageElement): void {
  if (!img.complete || img.naturalWidth === 0 || !img.isConnected) return;
  const opens = opensLarger(
    { width: img.naturalWidth, height: img.naturalHeight },
    { width: img.width, height: img.height },
    isLinked(img),
  );
  if (opens === img.hasAttribute(OPENS)) return;
  if (opens) {
    img.setAttribute(OPENS, '');
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-haspopup', 'dialog');
  } else {
    img.removeAttribute(OPENS);
    img.removeAttribute('tabindex');
    img.removeAttribute('role');
    img.removeAttribute('aria-haspopup');
  }
}

/** The picture an event happened on, when it opens large. */
export function largePictureAt(target: EventTarget | null): HTMLImageElement | null {
  return target instanceof HTMLImageElement && target.hasAttribute(OPENS) ? target : null;
}

/** What a picture of a page shows, in words: its caption and credit, its tooltip or its alternative text. */
function descriptionOf(img: HTMLImageElement): string {
  const note = img.closest('.guide-picture')?.querySelector('.guide-picture-note')?.textContent;
  const words = [note?.trim() ?? '', img.title.trim(), img.alt.trim()];
  return words.find((text) => text !== '') ?? 'Picture';
}

/** Opens a picture of a page in the larger view: its file, else the copy the page shows. */
export function openLargePicture(img: HTMLImageElement): void {
  const full = img.getAttribute('data-full');
  openPicture({
    url: full ?? img.src,
    ...(full ? { fallbackUrl: img.src } : {}),
    description: descriptionOf(img),
    opener: img,
  });
}

/**
 * A picture with a copy for pages that could not be loaded: the page shows
 * its file instead. True when it was switched, false when there is nothing
 * else to show (the picture is not downloaded).
 */
export function showFileInstead(img: HTMLImageElement): boolean {
  const full = img.getAttribute('data-full');
  if (!full || img.getAttribute('src') === full) return false;
  img.removeAttribute('data-full');
  img.src = full;
  return true;
}
