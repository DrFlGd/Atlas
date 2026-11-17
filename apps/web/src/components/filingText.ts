import type { PagesFiling } from '../state/importing';
import { numberFormat } from '../state/derived';

/**
 * One plain sentence on where the pages of a game of pages are, said after
 * it was built again from its saved pages, as "Of the 1,140 pages in its
 * contents, 380 are in the site’s menu and 760 are outside it: All pages
 * lists every one." Guides shows only the site's own menu; the pages
 * outside it are found by the links between pages, by search and in "All
 * pages". Null when the contents holds no page. It counts the pages as the
 * game has them, before the person's own changes to the contents (which
 * stay as they made them).
 */
export function filingText(filing: PagesFiling): string | null {
  const total = filing.pages;
  if (total === 0) return null;
  const inMenu = filing.inMenu + filing.byHand;
  const outside = filing.outsideMenu;
  const count = (n: number) => numberFormat.format(n);
  if (outside === 0) {
    return total === 1
      ? 'The one page in its contents is in the site’s menu.'
      : `All ${count(total)} pages in its contents are in the site’s menu.`;
  }
  if (inMenu === 0) {
    return total === 1
      ? 'The one page in its contents is in no menu of the site’s: All pages lists it.'
      : `None of the ${count(total)} pages in its contents is in a menu of the site’s: All pages lists every one.`;
  }
  return `Of the ${count(total)} pages in its contents, ${count(inMenu)} ${inMenu === 1 ? 'is' : 'are'} in the site’s menu and ${count(outside)} ${outside === 1 ? 'is' : 'are'} outside it: All pages lists every one.`;
}
