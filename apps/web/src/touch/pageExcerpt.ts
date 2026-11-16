import { withoutLayoutMarkers } from '@atlas/schema';
import { guideSearchText, withoutBoxes } from '../markdown';

/** About how much of a page's text the card shows. */
const EXCERPT_CHARS = 260;

/**
 * The first lines of a page as plain text: no pictures, no marks, no box
 * of facts, no marker lines of layout forms (their blocks are read in
 * order), and no hidden text (read with the renderer, so what is hidden
 * stays hidden).
 */
export function pageExcerpt(body: string, chars = EXCERPT_CHARS): string {
  // The lead: the text before the first heading or table, when there is one.
  const lines = withoutBoxes(withoutLayoutMarkers(body))
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .trim()
    .split('\n');
  const end = lines.findIndex((line, i) => i > 0 && /^\s*(#{1,6}\s|\|)/u.test(line));
  const lead = guideSearchText((end > 0 ? lines.slice(0, end) : lines).join('\n')).trim();
  const text = (lead || guideSearchText(lines.join('\n')) || guideSearchText(body))
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length <= chars) return text;
  const cut = text.lastIndexOf(' ', chars);
  return `${text.slice(0, cut > chars / 2 ? cut : chars).replace(/[\s,;:.]+$/u, '')}…`;
}
