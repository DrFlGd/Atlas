import { describe, expect, it } from 'vitest';
import { filingText } from './filingText';

const filing = (
  underListPage: number,
  inSection: number,
  inPagesSection: number,
  underFiledPage = 0,
) => ({
  pages: underListPage + inSection + inPagesSection + underFiledPage,
  underListPage,
  underFiledPage,
  inSection,
  inPagesSection,
  byHand: 0,
  pagesTitle: 'Pages',
});

describe('how the pages of a game of pages are filed, in a sentence', () => {
  it('says how many are under a list page, in a section of the menu and in Pages', () => {
    expect(filingText(filing(610, 380, 150))).toBe(
      'Of the 1,140 pages in its contents, 610 are under a list page, 380 are in a section of the menu and 150 are in “Pages”.',
    );
    expect(filingText(filing(1, 0, 4))).toBe(
      'Of the 5 pages in its contents, 1 is under a list page and 4 are in “Pages”.',
    );
  });

  it('says first how many are under the page the site files them under', () => {
    expect(filingText(filing(10, 2, 3, 40))).toBe(
      'Of the 55 pages in its contents, 40 are under the page the site files them under, 10 are under a list page, 2 are in a section of the menu and 3 are in “Pages”.',
    );
    expect(filingText(filing(4, 0, 0, 1))).toBe(
      'Of the 5 pages in its contents, 1 is under the page the site files it under and 4 are under a list page.',
    );
    expect(filingText(filing(0, 0, 0, 1))).toBe(
      'The one page in its contents is under the page the site files it under.',
    );
  });

  it('says it in one part when all pages are filed alike, and nothing for none', () => {
    expect(filingText(filing(0, 0, 12))).toBe('All 12 pages in its contents are in “Pages”.');
    expect(filingText(filing(0, 1, 0))).toBe(
      'The one page in its contents is in a section of the menu.',
    );
    expect(filingText(filing(0, 0, 0))).toBeNull();
  });
});
