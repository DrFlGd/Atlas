import { MOVES, movingBytes } from './movingPictures';
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

/** A picture shown narrower or shorter than this, in CSS pixels, has no corner mark: it would be covered. */
export const MARK_WIDTH = 96;
export const MARK_HEIGHT = 64;

/** The tooltips of a picture that opens large, and of one that moves. */
export const LARGE_TIP = 'Press to see this picture larger.';
export const MOVING_TIP = 'This picture moves. Press to see it larger and play it from its start.';
const TIPS = new Set([LARGE_TIP, MOVING_TIP]);

/** The box around a picture with a corner mark. */
const BOX = 'picture-box';

/** The box with a corner mark around a picture, when it has one. */
function boxOf(img: HTMLImageElement): HTMLElement | null {
  const box = img.parentElement?.closest(`.${BOX}`);
  return box instanceof HTMLElement && box.contains(img) ? box : null;
}

/** Sets an attribute to a value, or removes it for null; nothing when it already is so. */
function setAttr(element: Element, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name);
  else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/**
 * Marks a picture of a page that opens large, once it has loaded, so it
 * can be pressed and focused: a button for screen readers, named by what
 * it shows, with a tooltip that says what a press does, and a corner mark
 * when it is shown on its own and large enough. One that does not open
 * large is left as it is (and one that no longer does is put back so).
 * It may be called again at any time, as often as wished: the page's
 * pictures are looked at again on every render, when hidden text is
 * shown, when the window changes size and once a GIF is known to move.
 */
export function markLargePicture(img: HTMLImageElement): void {
  if (!img.complete || img.naturalWidth === 0 || !img.isConnected) return;
  const moving = img.getAttribute(MOVES);
  const opens =
    !isLinked(img) &&
    img.width > 0 &&
    (moving !== null ||
      opensLarger(
        { width: img.naturalWidth, height: img.naturalHeight },
        { width: img.width, height: img.height },
      ));
  const frame = img.closest('.guide-picture');
  const alone = frame !== null && !frame.classList.contains('inline');
  if (opens) {
    setAttr(img, OPENS, '');
    if (img.tabIndex !== 0) img.tabIndex = 0;
    setAttr(img, 'role', 'button');
    setAttr(img, 'aria-haspopup', 'dialog');
  } else {
    img.removeAttribute(OPENS);
    img.removeAttribute('tabindex');
    img.removeAttribute('role');
    img.removeAttribute('aria-haspopup');
  }
  // The tooltip, on a picture shown on its own: a small one in a line of
  // text keeps its own, what it shows.
  if (opens && alone) setAttr(img, 'title', moving !== null ? MOVING_TIP : LARGE_TIP);
  else if (TIPS.has(img.title)) img.removeAttribute('title');
  // The corner mark.
  const marked = opens && alone && img.width >= MARK_WIDTH && img.height >= MARK_HEIGHT;
  let box = boxOf(img);
  // Moving a focused picture into its box would take its focus: it gets its box later.
  if (marked && !box && document.activeElement !== img) {
    // Around the picture, or around the still picture with its Play button (movingPictures.ts).
    const shown = img.parentElement?.classList.contains('moving-picture') ? img.parentElement : img;
    box = document.createElement('span');
    box.className = BOX;
    shown.replaceWith(box);
    box.append(shown);
  }
  if (box) setAttr(box, 'data-mark', marked ? (moving !== null ? 'moving' : 'large') : null);
}

/** The picture an event happened on, when it opens large. */
export function largePictureAt(target: EventTarget | null): HTMLImageElement | null {
  return target instanceof HTMLImageElement && target.hasAttribute(OPENS) ? target : null;
}

/** What a picture of a page shows, in words: its caption and credit, its tooltip or its alternative text. */
function descriptionOf(img: HTMLImageElement): string {
  const note = img.closest('.guide-picture')?.querySelector('.guide-picture-note')?.textContent;
  // Its tooltip, unless it is only what a press does.
  const tip = TIPS.has(img.title) ? '' : img.title.trim();
  const words = [note?.trim() ?? '', tip, img.alt.trim()];
  return words.find((text) => text !== '') ?? 'Picture';
}

/**
 * Opens a picture of a page in the larger view: its file, else the copy
 * the page shows. A picture that moves is played there from its start,
 * from the bytes of its file already read, when that is the file shown.
 */
export function openLargePicture(img: HTMLImageElement): void {
  const full = img.getAttribute('data-full');
  const url = full ?? img.src;
  const bytes = movingBytes(img, url);
  openPicture({
    url,
    ...(full ? { fallbackUrl: img.src } : {}),
    ...(bytes ? { moving: bytes } : {}),
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
