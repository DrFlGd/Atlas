import type { GuideEntry } from '@atlas/schema';
import { normalizeText } from '../search/searchIndex';

/**
 * The text of a guide as a reader sees it before showing anything hidden:
 * Markdown marks taken out, link and picture targets left out (their words
 * kept), and hidden text (`||like this||`) removed, so it can be searched
 * and quoted without giving anything away.
 *
 * This reads Markdown roughly, without a Markdown parser. Bars pair up left
 * to right, as the renderer pairs them; escaped bars and bars in inline code
 * are not marks. Where a text has both bars and code blocks, whose bars the
 * renderer does not count, the pairs could come out differently, so such a
 * text is cut at its first bar. An app with the renderer at hand passes
 * {@link GuideSearch} a reading made with it instead.
 */
/** Stands for a bar that is not a mark while marks are paired. */
const BAR = '\u0001';

export function guidePlainText(markdown: string): string {
  const codeBlock = /^(?: {4}|\t| {0,3}(?:`{3,}|~{3,}))/m;
  if (markdown.includes('||') && codeBlock.test(markdown)) {
    return guidePlainText(markdown.slice(0, markdown.indexOf('||')));
  }
  // Bars that are not marks: escaped, or in code.
  const masked = markdown
    .replace(/\\\|/g, BAR)
    .replace(/(`+)[\s\S]*?\1/g, (code) => code.replaceAll('|', BAR));
  const pieces = masked.split('||');
  const marks = pieces.length - 1;
  const paired = marks - (marks % 2);
  let visible = '';
  pieces.forEach((piece, i) => {
    if (i > 0 && i > paired) visible += '||';
    if (i % 2 === 0 || i > paired) visible += piece;
    else visible += ' ';
  });
  return (
    visible
      // Pictures and links: their words, not their targets.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<((?:https?|mailto):[^>\s]+|[a-z0-9-]+:[a-z]+:[^>\s]+)>/gi, ' ')
      // Fences, headings, quotes, list marks, table rules and cells, emphasis.
      .replace(/^ {0,3}(`{3,}|~{3,}).*$/gm, ' ')
      .replace(/^ {0,3}#{1,6}\s+/gm, '')
      .replace(/^ {0,3}>\s?/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
      .replace(/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/gm, ' ')
      .replace(/\|/g, ' ')
      .replace(/(\*\*|__|\*|_|~~|`)/g, '')
      .replace(/\\([\\`*_{}[\]()#+\-.!>~])/g, '$1')
      .replaceAll(BAR, '|')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** One page found by a search, with a line of its text around the first match. */
export interface GuideHit {
  guide: GuideEntry;
  /** The words are in the title. */
  inTitle: boolean;
  /** A line of the page's text around a match, without hidden text; empty when none fits. */
  snippet: string;
  /** Where the query's words are in `snippet`, as [start, end) character ranges. */
  marks: [number, number][];
  /** Lower is better. */
  score: number;
}

interface IndexedGuide {
  guide: GuideEntry;
  title: string;
  /** The plain text, and its normalised form with where each normalised character came from. */
  text: string;
  normal: string;
  origin: number[];
}

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const SNIPPET_BEFORE = 50;
const SNIPPET_LENGTH = 160;

/** Normalises text as search does, keeping where each normalised character came from. */
function normalizeWithOrigin(text: string): { normal: string; origin: number[] } {
  let normal = '';
  const origin: number[] = [];
  let i = 0;
  for (const char of text) {
    const part = normalizeText(char);
    origin.push(...Array<number>(part.length).fill(i));
    normal += part;
    i += char.length;
  }
  origin.push(text.length);
  return { normal, origin };
}

/**
 * Search over the titles and text of a pack's guides (pages): every word
 * of the query must be in the title or the text. Pages whose title has
 * them come first, then by how early the text has them. Hidden text is not
 * searched. Built when first asked.
 */
export class GuideSearch {
  private items: IndexedGuide[] | null = null;

  constructor(
    private readonly guides: readonly GuideEntry[],
    /** A guide's visible text, without hidden text; {@link guidePlainText} by default. */
    private readonly toText: (markdown: string) => string = guidePlainText,
  ) {}

  private index(): IndexedGuide[] {
    this.items ??= this.guides.map((guide) => {
      const text = this.toText(guide.body);
      return { guide, title: normalizeText(guide.title), text, ...normalizeWithOrigin(text) };
    });
    return this.items;
  }

  search(query: string, limit = 50): GuideHit[] {
    const terms = normalizeText(query).split(WORD_SPLIT).filter(Boolean);
    if (terms.length === 0 || limit <= 0) return [];
    const hits: GuideHit[] = [];
    for (const item of this.index()) {
      const inTitle = terms.every((term) => item.title.includes(term));
      if (
        !inTitle &&
        !terms.every((term) => item.title.includes(term) || item.normal.includes(term))
      ) {
        continue;
      }
      const first = Math.min(
        ...terms.map((term) => {
          const at = item.normal.indexOf(term);
          return at < 0 ? Infinity : at;
        }),
      );
      const titleScore =
        item.title === terms.join(' ') ? 0 : item.title.startsWith(terms[0]!) ? 1 : 2;
      const score = inTitle ? titleScore : 3 + Math.min(first, 1e6) / 1e6;
      hits.push({ guide: item.guide, inTitle, score, ...snippetOf(item, terms, first) });
    }
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    hits.sort((a, b) => a.score - b.score || collator.compare(a.guide.title, b.guide.title));
    return hits.slice(0, limit);
  }
}

function snippetOf(
  item: IndexedGuide,
  terms: readonly string[],
  first: number,
): Pick<GuideHit, 'snippet' | 'marks'> {
  const { text, normal, origin } = item;
  if (text === '') return { snippet: '', marks: [] };
  let start = Number.isFinite(first) ? Math.max(0, origin[first]! - SNIPPET_BEFORE) : 0;
  if (start > 0) {
    const space = text.indexOf(' ', start);
    start = space >= 0 && space < start + 20 ? space + 1 : start;
  }
  let end = Math.min(text.length, start + SNIPPET_LENGTH);
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    end = space > start + 40 ? space : end;
  }
  const prefix = start > 0 ? '… ' : '';
  const snippet = `${prefix}${text.slice(start, end)}${end < text.length ? ' …' : ''}`;
  const marks: [number, number][] = [];
  for (const term of terms) {
    let at = normal.indexOf(term);
    while (at >= 0) {
      const from = origin[at]!;
      const to = origin[at + term.length]!;
      if (from >= start && to <= end)
        marks.push([from - start + prefix.length, to - start + prefix.length]);
      at = normal.indexOf(term, at + term.length);
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  return { snippet, marks: mergeRanges(marks) };
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const range of ranges) {
    const last = out.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else out.push([...range]);
  }
  return out;
}
