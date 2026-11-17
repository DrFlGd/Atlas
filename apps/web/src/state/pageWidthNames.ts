import { PAGE_WIDTHS, type PageWidth } from '@atlas/schema';

/**
 * The widths a game's pages can be shown at, as the app names them and says
 * what each is: in "Page width" of Guides, and in the settings of a site
 * rules file (`layout.pageWidth`).
 */
const WIDTH_WORDS: Record<PageWidth, { name: string; says: string }> = {
  reading: { name: 'Reading', says: 'A column of text, about 760 pixels wide' },
  wide: { name: 'Wide', says: 'About 1,000 pixels, for pages laid out wider' },
  full: { name: 'Full', says: 'As wide as the window' },
};

/** Each width, in the order of the format, with its name and what it is. */
export const PAGE_WIDTH_NAMES: readonly { width: PageWidth; name: string; says: string }[] =
  PAGE_WIDTHS.map((width) => ({ width, ...WIDTH_WORDS[width] }));
