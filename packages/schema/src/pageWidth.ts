/**
 * The width a game's guide pages are shown at, in the reader of Guides on
 * a computer or a tablet (a phone always shows a page as wide as it is):
 *
 * - `reading`: a column of text at most {@link PAGE_WIDTH_PIXELS} `reading`
 *   wide, as every page was shown before there was a choice; the default;
 * - `wide`: about 1,000 pixels, for a site that lays its pages out wider,
 *   so that blocks it sets side by side stay side by side;
 * - `full`: as wide as the window, with the reader's side margins.
 *
 * A site rules file gives a wiki's default (`layout.pageWidth`), which an
 * importer writes into the pack it builds (the manifest's `pageWidth`); the
 * person's own choice is kept with their changes to the pages (the own
 * pages file's `pageWidth`, see `ownPages.ts`) and wins over the pack's.
 */

/** The widths a game's guide pages can be shown at, the narrowest first. */
export const PAGE_WIDTHS = ['reading', 'wide', 'full'] as const;
export type PageWidth = (typeof PAGE_WIDTHS)[number];

/** The width pages are shown at when nothing says otherwise. */
export const DEFAULT_PAGE_WIDTH: PageWidth = 'reading';

/**
 * The widest the text column of a page is at each width, in CSS pixels.
 * `full` has no bound in the app (it is the window's width); the number
 * here is the width a page is laid out at where one number is needed, such
 * as a frame that lays a saved page out to see where its blocks stand.
 */
export const PAGE_WIDTH_PIXELS: Readonly<Record<PageWidth, number>> = {
  reading: 760,
  wide: 1000,
  full: 1280,
};

/** Whether a value is one of the {@link PAGE_WIDTHS}. */
export const isPageWidth = (value: unknown): value is PageWidth =>
  PAGE_WIDTHS.some((width) => width === value);
