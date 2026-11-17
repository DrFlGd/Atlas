/**
 * A list of pages as Markdown: one item per page, a link to it by its id,
 * with the pages under it as a list in the item, as deep as they go. A
 * level that is no page (a group of words) is its words, with its
 * pages under it. What a person puts in a page's text, which reads as an
 * index from then on and never changes by itself.
 */

/** A page, or a level that is no page (no `id`), with what is under it. */
export interface ListedPage {
  id?: string;
  title: string;
  under?: readonly ListedPage[];
}

/** Words as the text of a link or an item: no line breaks, and Markdown's signs taken as they are. */
const linkWords = (title: string) =>
  title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\[\]*_`<>]/g, (sign) => `\\${sign}`);

/** The pages as a bulleted list, nested as they are, with a line end after each item. */
export function pagesListMarkdown(pages: readonly ListedPage[]): string {
  const lines: string[] = [];
  const add = (items: readonly ListedPage[], depth: number) => {
    for (const item of items) {
      const words = linkWords(item.title) || 'Page';
      // Plain words never start a list, a heading or a quote of their own.
      const text = item.id
        ? `[${words}](${item.id})`
        : words.replace(/^(\d+)([.)])/, '$1\\$2').replace(/^([#+\->])/, '\\$1');
      lines.push(`${'  '.repeat(depth)}- ${text}`);
      if (item.under && item.under.length > 0) add(item.under, depth + 1);
    }
  };
  add(pages, 0);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
