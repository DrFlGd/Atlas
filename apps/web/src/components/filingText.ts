import type { PagesFiling } from '../state/importing';
import { numberFormat } from '../state/derived';

/**
 * One plain sentence on how the pages of a game of pages are filed in its
 * contents, said after it was built again from its saved pages, as
 * "Of the 1,140 pages in its contents, 610 are under a list page, 380 are
 * in a section of the menu and 150 are in “Pages”." Pages under the page
 * the site itself files them under (its categories) are said first. Null
 * when the contents
 * holds no page. It counts the pages as the game files them, before the
 * person's own changes to the contents (which stay as they made them).
 */
export function filingText(filing: PagesFiling): string | null {
  const total = filing.pages;
  if (total === 0) return null;
  const parts = (
    [
      [filing.underFiledPage, 'under the page the site files them under'],
      [filing.underListPage, 'under a list page'],
      [filing.inSection, 'in a section of the menu'],
      [filing.inPagesSection, `in “${filing.pagesTitle}”`],
    ] as const
  ).filter(([count]) => count > 0);
  // Said of one page, "them" is "it".
  const of = (count: number, where: string) =>
    count === 1 ? where.replace(' them ', ' it ') : where;
  if (parts.length === 1) {
    const where = of(total, parts[0]![1]);
    return total === 1
      ? `The one page in its contents is ${where}.`
      : `All ${numberFormat.format(total)} pages in its contents are ${where}.`;
  }
  const said = parts.map(
    ([count, where]) =>
      `${numberFormat.format(count)} ${count === 1 ? 'is' : 'are'} ${of(count, where)}`,
  );
  const last = said.pop()!;
  return `Of the ${numberFormat.format(total)} pages in its contents, ${said.join(', ')} and ${last}.`;
}
