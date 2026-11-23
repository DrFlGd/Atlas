/**
 * The width a game's guide pages are shown at, in the reader of Guides on
 * a computer or a tablet (a phone always shows a page as wide as it is):
 *
 * - `reading`: a column of text at most {@link PAGE_WIDTH_PIXELS} `reading`
 *   wide, as every page was shown before there was a choice; the default;
 * - `wide`: about 1,000 pixels, for a site that lays its pages out wider,
 *   so that blocks it sets side by side stay side by side;
 * - `full`: as wide as the window, with the reader's side margins;
 * - `site`: as wide as the site's own pages are, the width of their text
 *   column as the site's own style sheets lay it out in a computer's
 *   window, a number the pack keeps (the manifest's `siteWidth`, see
 *   {@link isSiteWidth}). A pack that knows no such number has no `site`
 *   width to show: its pages are shown at `reading` instead (see
 *   {@link shownPageWidth}), and Guides does not offer it.
 *
 * A site rules file gives a wiki's default (`layout.pageWidth`), which an
 * importer writes into the pack it builds (the manifest's `pageWidth`); the
 * person's own choice is kept with their changes to the pages (the own
 * pages file's `pageWidth`, see `ownPages.ts`) and wins over the pack's.
 * `site` came after the other three: an app that does not know it reads a
 * pack or an own pages file that names it as one that names no width.
 */

/** The widths a game's guide pages can be shown at, the fixed ones narrowest first, then the site's own. */
export const PAGE_WIDTHS = ['reading', 'wide', 'full', 'site'] as const;
export type PageWidth = (typeof PAGE_WIDTHS)[number];

/** The widths whose number is the same for every pack: all but the site's own. */
export type FixedPageWidth = Exclude<PageWidth, 'site'>;

/** The width pages are shown at when nothing says otherwise. */
export const DEFAULT_PAGE_WIDTH: FixedPageWidth = 'reading';

/**
 * The widest the text column of a page is at each fixed width, in CSS
 * pixels. `full` has no bound in the app (it is the window's width); the
 * number here is the width a page is laid out at where one number is
 * needed: the closed frame the app lays a page out in, to see where its
 * blocks stand, is as wide (`LAYOUT_FRAME_WIDTH` of `@atlas/importer-api`).
 * That frame stands for a computer's window on the site, whatever width
 * the page is then shown at in Guides. The site's own width is the pack's
 * (see {@link pageWidthPixels}).
 */
export const PAGE_WIDTH_PIXELS: Readonly<Record<FixedPageWidth, number>> = {
  reading: 760,
  wide: 1000,
  full: 1280,
};

/**
 * The narrowest and the widest a site's own width may be, in CSS pixels:
 * the width of a phone's page at least, and of a very wide window at most.
 * A number outside them was not measured on a page laid out for a computer.
 */
export const MIN_SITE_WIDTH = 320;
export const MAX_SITE_WIDTH = 3840;

/** Whether a value is one of the {@link PAGE_WIDTHS}. */
export const isPageWidth = (value: unknown): value is PageWidth =>
  PAGE_WIDTHS.some((width) => width === value);

/** Whether a value is a site's own width: a whole number of pixels within the bounds above. */
export const isSiteWidth = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= MIN_SITE_WIDTH &&
  value <= MAX_SITE_WIDTH;

/**
 * The width pages are shown at when `width` is asked for, for a pack whose
 * site's own width is `siteWidth` (none when it knows none): `width`
 * itself, but `site` without a number, which is `reading`.
 */
export const shownPageWidth = (width: PageWidth, siteWidth: number | undefined): PageWidth =>
  width === 'site' && !isSiteWidth(siteWidth) ? DEFAULT_PAGE_WIDTH : width;

/**
 * The widest the text column of a page is at `width`, in CSS pixels, for a
 * pack whose site's own width is `siteWidth`: the site's number for
 * `site`, or `reading`'s when the pack knows none.
 */
export const pageWidthPixels = (width: PageWidth, siteWidth?: number): number => {
  const shown = shownPageWidth(width, siteWidth);
  return shown === 'site' ? siteWidth! : PAGE_WIDTH_PIXELS[shown];
};
