import { describe, expect, it } from 'vitest';
import { filingText } from './filingText';

const filing = (inMenu: number, outsideMenu: number, byHand = 0) => ({
  pages: inMenu + outsideMenu + byHand,
  inMenu,
  byHand,
  outsideMenu,
});

describe('where the pages of a game of pages are, in a sentence', () => {
  it('says how many are in the site’s menu and how many outside it', () => {
    expect(filingText(filing(380, 760))).toBe(
      'Of the 1,140 pages in its contents, 380 are in the site’s menu and 760 are outside it: All pages lists every one.',
    );
    expect(filingText(filing(1, 4))).toBe(
      'Of the 5 pages in its contents, 1 is in the site’s menu and 4 are outside it: All pages lists every one.',
    );
    expect(filingText(filing(3, 1, 1))).toBe(
      'Of the 5 pages in its contents, 4 are in the site’s menu and 1 is outside it: All pages lists every one.',
    );
  });

  it('says it in one part when all pages are in the menu, or none is, and nothing for none', () => {
    expect(filingText(filing(12, 0))).toBe('All 12 pages in its contents are in the site’s menu.');
    expect(filingText(filing(1, 0))).toBe('The one page in its contents is in the site’s menu.');
    expect(filingText(filing(0, 12))).toBe(
      'None of the 12 pages in its contents is in a menu of the site’s: All pages lists every one.',
    );
    expect(filingText(filing(0, 1))).toBe(
      'The one page in its contents is in no menu of the site’s: All pages lists it.',
    );
    expect(filingText(filing(0, 0))).toBeNull();
  });
});
