/**
 * Layout forms of a guide page's Markdown: blocks set side by side, a card
 * with a title, a row of short items, a list in columns and a centred
 * block. Each form is written with whole marker lines around ordinary
 * Markdown blocks, so an app that does not know the forms shows every
 * block in reading order and the marker lines as the text they are.
 *
 * The syntax, read the same way by every part of the app that reads page
 * text (the page, its headings, search, extracts, the page editor):
 *
 * - A marker line is `:::`, one space and a form's name, and for some
 *   forms one space and its values. It starts at the very start of the
 *   line (no space before it), may end with spaces, and stands alone: a
 *   blank line (or the start or the end of the page) before it and after
 *   it. Names and values are exactly as below, in lower case.
 * - `::: side` opens blocks side by side, optionally with their shares of
 *   the width, two to four whole numbers joined by `:` (`::: side 1:3`).
 *   `::: next` stands between two blocks. Without shares the blocks are
 *   equally wide; a block without a share of its own has a share of 1, a
 *   share left over is ignored, and each share counts as at least 1 and at
 *   most {@link MAX_SHARE}. At most {@link MAX_SIDE_BLOCKS} blocks: a
 *   `::: next` after the fourth block is text.
 * - `::: card` opens a framed block with a title bar: its title is the
 *   ordinary Markdown heading that is its first block (`### Menu`), a
 *   heading of the page as any other. A card without a heading first has
 *   no title bar.
 * - `::: row` opens a row: a list inside it is set on one line, its items
 *   with a dot between them (or, when each starts with a small picture,
 *   the picture beside each), wrapping to further lines where narrow. An
 *   item of several lines (line breaks in it) is a block of those lines,
 *   one under another, the small pictures it starts with beside them.
 * - `::: columns 3` opens a list flowed in that many columns, a whole
 *   number counted as at least 2 and at most {@link MAX_COLUMNS}. A list
 *   whose every item is one line fills the columns in turn, as many items
 *   in each as the first holds; as many lists as columns are one list a
 *   column.
 * - `::: centred` opens a block set in the middle.
 * - `::: end` closes the form opened last that is still open.
 * - Forms nest: a form may stand in a block of another, at most
 *   {@link MAX_DEPTH} deep; a deeper one is read as text, its content as
 *   the blocks it holds. A page holds at most {@link MAX_FORMS} forms; any
 *   after are read as text in the same way.
 * - Markers pair up as brackets do. A marker without a partner (an opening
 *   line never closed, an `::: end` with nothing open, a `::: next` whose
 *   innermost open form is not `side`), an unknown name, a value that is
 *   not as above, a marker line indented, inside a list item, a quote or
 *   code, joined to a line of text, or escaped (`\::: card`) is ordinary
 *   text, shown as written. Nothing is lost and nothing throws.
 *
 * {@link layoutFormsIn} reads a page's forms; {@link withoutLayoutMarkers}
 * gives the page's text without its marker lines, for readers of the text
 * that need only the blocks in reading order; the writers
 * ({@link sideBySideMarkdown} and the others) write a form as a reader
 * reads it, for importers.
 */

/** The name of a layout form, as its opening marker line writes it. */
export type LayoutFormName = 'side' | 'card' | 'row' | 'columns' | 'centred';

/** What a marker line says. */
export type LayoutMarker =
  | { role: 'open'; form: 'side'; shares: number[] | null }
  | { role: 'open'; form: 'columns'; columns: number }
  | { role: 'open'; form: 'card' | 'row' | 'centred' }
  | { role: 'next' }
  | { role: 'end' };

/** The most blocks side by side. */
export const MAX_SIDE_BLOCKS = 4;
/** The largest share of the width a block side by side has (the smallest is 1). */
export const MAX_SHARE = 9;
/** The most columns a list is flowed in (the fewest is 2). */
export const MAX_COLUMNS = 6;
/** How deep forms may stand one inside another. */
export const MAX_DEPTH = 4;
/** The most forms one page holds. */
export const MAX_FORMS = 200;

/** What starts every marker line. */
export const LAYOUT_MARK = ':::';

const MARKER = /^:{3} (side|card|row|columns|centred|next|end)(?: (\S+))?[ \t]*$/u;
const SHARES = /^\d{1,2}(?::\d{1,2}){1,3}$/u;
const COUNT = /^\d{1,2}$/u;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** What a line says as a marker line, or null when it is no marker line (its context aside). */
export function parseLayoutMarker(line: string): LayoutMarker | null {
  const match = MARKER.exec(line);
  if (!match) return null;
  const name = match[1]!;
  const value = match[2];
  switch (name) {
    case 'side':
      if (value === undefined) return { role: 'open', form: 'side', shares: null };
      if (!SHARES.test(value)) return null;
      return {
        role: 'open',
        form: 'side',
        shares: value.split(':').map((share) => clamp(Number(share), 1, MAX_SHARE)),
      };
    case 'columns':
      if (value === undefined || !COUNT.test(value)) return null;
      return { role: 'open', form: 'columns', columns: clamp(Number(value), 2, MAX_COLUMNS) };
    case 'card':
    case 'row':
    case 'centred':
      return value === undefined ? { role: 'open', form: name } : null;
    case 'next':
      return value === undefined ? { role: 'next' } : null;
    default:
      return value === undefined ? { role: 'end' } : null;
  }
}

/** Whether a line, on its own, reads as a marker line (see the top of this file). */
export const isLayoutMarkerLine = (line: string): boolean => parseLayoutMarker(line) !== null;

/** One form of a page, as {@link layoutFormsIn} reads it. Lines count from 0. */
export interface LayoutForm {
  form: LayoutFormName;
  /** The line that opens it, and the line that closes it. */
  open: number;
  end: number;
  /** The lines between its blocks side by side, in order (none for the other forms). */
  next: number[];
  /** For `side`: the share of each block, one per block, each 1 to {@link MAX_SHARE}. */
  shares: number[];
  /** For `columns`: how many, 2 to {@link MAX_COLUMNS}; 1 for the other forms. */
  columns: number;
  /** 1 for a form at the top of the page, 2 for one inside it, and so on. */
  depth: number;
}

/** The forms of a page, and the role of each of its marker lines. */
export interface LayoutForms {
  /** Every form, in the order of their opening lines. */
  forms: LayoutForm[];
  /** Each line that is a marker of a form, by line: the form's index in `forms`. */
  markers: Map<number, number>;
}

const BLANK = /^[ \t]*$/u;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

/** The lines of a text, split as Markdown splits them. */
export const linesOf = (text: string): string[] => text.split(/\r\n|\r|\n/u);

/** Open while it is read: the lines of a form, before it is known to be closed. */
interface Opening {
  marker: Extract<LayoutMarker, { role: 'open' }>;
  line: number;
  next: number[];
}

/**
 * The forms of a page's Markdown (see the top of this file): marker lines
 * paired as brackets, those in code or out of their context left as text,
 * and forms too deep or too many read as text with their content kept.
 */
export function layoutFormsIn(source: string): LayoutForms {
  const empty: LayoutForms = { forms: [], markers: new Map() };
  if (!source.includes(LAYOUT_MARK)) return empty;
  const lines = linesOf(source);
  const paired: { opening: Opening; end: number }[] = [];
  const open: Opening[] = [];
  let fence: { char: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line);
      const run = close?.[1] ?? '';
      if (run.startsWith(fence.char) && run.length >= fence.length) fence = null;
      continue;
    }
    const opens = FENCE_OPEN.exec(line);
    if (opens && !(opens[1]!.startsWith('`') && opens[2]!.includes('`'))) {
      fence = { char: opens[1]![0]!, length: opens[1]!.length };
      continue;
    }
    if (!line.startsWith(LAYOUT_MARK)) continue;
    const marker = parseLayoutMarker(line);
    if (!marker) continue;
    // A marker line stands alone, between blank lines or the page's ends.
    if (i > 0 && !BLANK.test(lines[i - 1]!)) continue;
    if (i + 1 < lines.length && !BLANK.test(lines[i + 1]!)) continue;
    if (marker.role === 'open') {
      open.push({ marker, line: i, next: [] });
    } else if (marker.role === 'next') {
      const innermost = open.at(-1);
      if (innermost?.marker.form === 'side' && innermost.next.length < MAX_SIDE_BLOCKS - 1) {
        innermost.next.push(i);
      }
    } else {
      const opening = open.pop();
      if (opening) paired.push({ opening, end: i });
    }
  }
  // Each kept form in the order of its opening line, its depth counted
  // among the forms kept around it.
  paired.sort((a, b) => a.opening.line - b.opening.line);
  const forms: LayoutForm[] = [];
  const markers = new Map<number, number>();
  const around: LayoutForm[] = [];
  for (const { opening, end } of paired) {
    while (around.length > 0 && around.at(-1)!.end < opening.line) around.pop();
    if (around.length >= MAX_DEPTH || forms.length >= MAX_FORMS) continue;
    const { marker } = opening;
    const blocks = opening.next.length + 1;
    const shares =
      marker.form === 'side'
        ? Array.from({ length: blocks }, (_, i) => marker.shares?.[i] ?? 1)
        : [];
    const form: LayoutForm = {
      form: marker.form,
      open: opening.line,
      end,
      next: opening.next,
      shares,
      columns: marker.form === 'columns' ? marker.columns : 1,
      depth: around.length + 1,
    };
    const index = forms.push(form) - 1;
    for (const line of [form.open, ...form.next, form.end]) markers.set(line, index);
    around.push(form);
  }
  return { forms, markers };
}

/**
 * A page's Markdown with each marker line of its forms made blank: the
 * blocks they hold in reading order, as an app without the forms reads
 * them, for readers of the text that need no layout. Line numbers stay.
 */
export function withoutLayoutMarkers(source: string): string {
  const { markers } = layoutFormsIn(source);
  if (markers.size === 0) return source;
  const parts = source.split(/(\r\n|\r|\n)/u);
  // Lines at even indexes, the line ends between them.
  for (const line of markers.keys()) parts[line * 2] = '';
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Writing the forms, for importers

/** The marker line between blocks side by side. */
export const LAYOUT_NEXT_LINE = '::: next';
/** The marker line that closes a form. */
export const LAYOUT_END_LINE = '::: end';

/** A block's Markdown without blank lines before or after it. */
const tidy = (markdown: string) =>
  markdown.replace(/^(?:[ \t]*(?:\r\n|\r|\n))+/u, '').replace(/(?:(?:\r\n|\r|\n)[ \t]*)+$/u, '');

/** A form's marker lines around its blocks, a blank line between each. */
const wrapped = (open: string, blocks: readonly string[]) =>
  [
    open,
    ...blocks.flatMap((block, i) => (i === 0 ? [block] : [LAYOUT_NEXT_LINE, block])),
    LAYOUT_END_LINE,
  ]
    .filter((part) => part !== '')
    .join('\n\n');

/** The opening marker line of a form, with its values. */
export function layoutOpenLine(
  form: LayoutFormName,
  values: { shares?: readonly number[]; columns?: number } = {},
): string {
  if (form === 'side' && values.shares && values.shares.length > 0) {
    const shares = values.shares
      .slice(0, MAX_SIDE_BLOCKS)
      .map((share) => clamp(Math.round(share) || 1, 1, MAX_SHARE));
    return shares.length > 1 ? `::: side ${shares.join(':')}` : '::: side';
  }
  if (form === 'columns') {
    return `::: columns ${clamp(Math.round(values.columns ?? 2) || 2, 2, MAX_COLUMNS)}`;
  }
  return `::: ${form}`;
}

/**
 * The shares of the width, as whole numbers of at most {@link MAX_SHARE},
 * nearest to widths given in any unit (pixels, percents): `[200, 600]`
 * gives `[1, 3]`.
 */
export function sharesOf(widths: readonly number[]): number[] {
  const usable = widths.map((width) => (Number.isFinite(width) && width > 0 ? width : 0));
  const smallest = Math.min(...usable.filter((width) => width > 0));
  if (!Number.isFinite(smallest)) return widths.map(() => 1);
  const largest = Math.max(...usable);
  // The smallest block is 1, unless the largest would then be over the limit.
  const unit = Math.max(smallest, largest / MAX_SHARE);
  return usable.map((width) => clamp(Math.round(width / unit) || 1, 1, MAX_SHARE));
}

/**
 * Blocks side by side, each block's Markdown in order, with the shares of
 * the width given (`[1, 3]`) or equal ones. One block is that block alone;
 * blocks after the fourth are added to the fourth, one under another.
 */
export function sideBySideMarkdown(blocks: readonly string[], shares?: readonly number[]): string {
  const tidied = blocks.map(tidy);
  if (tidied.length <= 1) return tidied[0] ?? '';
  const kept =
    tidied.length <= MAX_SIDE_BLOCKS
      ? tidied
      : [
          ...tidied.slice(0, MAX_SIDE_BLOCKS - 1),
          tidied
            .slice(MAX_SIDE_BLOCKS - 1)
            .filter((block) => block !== '')
            .join('\n\n'),
        ];
  return wrapped(
    layoutOpenLine('side', shares ? { shares: shares.slice(0, kept.length) } : {}),
    kept,
  );
}

/**
 * A card: its title as a heading of the page (the title's Markdown on one
 * line, at `level`, 1 to 6), then its blocks. Without a title it has no
 * title bar.
 */
export function cardMarkdown(title: string | null, body: string, level = 3): string {
  const words = title?.replace(/\s+/gu, ' ').trim() ?? '';
  const heading = words === '' ? '' : `${'#'.repeat(clamp(Math.round(level) || 3, 1, 6))} ${words}`;
  return wrapped('::: card', [[heading, tidy(body)].filter((part) => part !== '').join('\n\n')]);
}

/** A line that would start a block of its own after a line of text (a list, a heading, a quote, code, a rule): escaped. */
const BLOCK_START = /^(?:[-*+](?=\s|$)|#{1,6}(?=\s|$)|>|`{3}|~{3}|=+\s*$|-+\s*$|(?:[*_]\s*){3,}$)/u;
const NUMBERED = /^(\d{1,9})([.)])(?=\s|$)/u;

/** A line of an item after its first, as the line it is and no block. */
function continuationLine(line: string): string {
  const numbered = NUMBERED.exec(line);
  if (numbered) return `${numbered[1]}\\${numbered[2]}${line.slice(numbered[0].length)}`;
  return BLOCK_START.test(line) ? `\\${line}` : line;
}

/**
 * A row of short items, each item's Markdown on one line; an item's line
 * breaks (`\n`) are kept as Markdown line breaks, so an item the page
 * shows as a block of lines (a name over a number) stays one.
 */
export function rowMarkdown(items: readonly string[]): string {
  const lines = items
    .map((item) =>
      item
        .split(/\r\n|\r|\n/u)
        .map((line) => line.replace(/\s+/gu, ' ').trim())
        .filter(Boolean)
        .map((line, i) => (i === 0 ? line : continuationLine(line)))
        .join('  \n  '),
    )
    .filter(Boolean);
  return wrapped('::: row', [lines.map((item) => `- ${item}`).join('\n')]);
}

/** A list (or any blocks) flowed in `count` columns. */
export function columnsMarkdown(count: number, body: string): string {
  return wrapped(layoutOpenLine('columns', { columns: count }), [tidy(body)]);
}

/** Blocks set in the middle. */
export function centredMarkdown(body: string): string {
  return wrapped('::: centred', [tidy(body)]);
}

/**
 * A site's text with each line that would read as a marker line escaped
 * (`\::: card`), so it shows as written: for text an importer did not
 * mean as a form.
 */
export function escapeLayoutMarkers(markdown: string): string {
  if (!markdown.includes(LAYOUT_MARK)) return markdown;
  return markdown
    .split(/(\r\n|\r|\n)/u)
    .map((part) => (isLayoutMarkerLine(part) ? `\\${part}` : part))
    .join('');
}
