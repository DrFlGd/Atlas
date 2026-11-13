import MarkdownIt, { type Token } from 'markdown-it';
import { CELL_BREAK, markdownMarks } from '../markdownMarks';

/**
 * The text of one part of a page (a paragraph, a heading, a list item, a
 * table cell) as the page editor edits it: a row of pieces, each with the
 * marks it has, read from Markdown with the same rules the app's Markdown
 * view uses (see `markdown.ts`), and written back to Markdown.
 *
 * Every inline feature the view shows has a piece or a mark here: bold
 * (`**`, `__`), italic (`*`, `_`), strikethrough (`~~`), raised and lowered
 * text (`^`, `~`), code, links (to the web, to a page or a location by its
 * id, `<autolinks>`), pictures by id, hidden text (`||like this||`) and
 * line breaks, soft (a line end) and hard (a backslash or two spaces at a
 * line end; `<br>` in a table cell). Character references and
 * backslash escapes are read as the characters they stand for, and written
 * back escaped where they would mean something else.
 *
 * A bare web address is a link here as in the view, written back bare;
 * "smart" quotes and dashes are what the view makes of plain text, so they
 * stay plain text here and are written back as they were.
 */

/** A link: its address (a web address, or a page's or location's id) and title. */
export interface LinkMark {
  href: string;
  title?: string;
  /**
   * Written as `<address>`, the text being the address (`true`); or a bare
   * web address in the text, which the view makes a link (`bare`).
   */
  auto?: true | 'bare';
}

export interface Marks {
  /** Bold, written with `**` or `__`. */
  strong?: '**' | '__';
  /** Italic, written with `*` or `_`. */
  em?: '*' | '_';
  /** Struck through. */
  s?: true;
  /** Hidden until the reader asks (`||`). */
  hidden?: true;
  /** Raised (`^`) or lowered (`~`): a note's mark, a small tag, a formula. */
  sup?: true;
  sub?: true;
  link?: LinkMark;
}

export type Inline =
  | { kind: 'text'; text: string; marks: Marks }
  | { kind: 'code'; text: string; marks: Marks }
  | { kind: 'picture'; src: string; alt: string; title?: string; marks: Marks }
  /** A hard line break. */
  | { kind: 'break'; marks: Marks }
  /** A line end inside the text: shown as a space by the view. */
  | { kind: 'soft'; marks: Marks };

/**
 * The parser the editor reads with: the view's rules, without turning
 * quotes into curly ones, and with escaped and referenced characters kept
 * apart from text (`text_special`), so a `||` counts as the view counts it.
 */
export const editParser = new MarkdownIt({ html: false, linkify: true, typographer: false });
editParser.use(markdownMarks);
editParser.core.ruler.disable('text_join');

// ---------------------------------------------------------------------------
// Reading

/** The plain words of a picture's description, as the view shows them. */
function altText(tokens: readonly Token[]): string {
  return tokens.map((token) => (token.children ? altText(token.children) : token.content)).join('');
}

/**
 * The pieces of an inline token's children. `hidden` is whether the text
 * starts inside hidden text; the result says whether it ends inside it.
 */
export function inlineFromTokens(
  tokens: readonly Token[],
  hiddenAtStart = false,
): { pieces: Inline[]; hidden: boolean } {
  const pieces: Inline[] = [];
  const marks: Marks = hiddenAtStart ? { hidden: true } : {};
  const now = (): Marks => ({ ...marks });
  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const parts = token.content.split('||');
        parts.forEach((part, i) => {
          if (i > 0) {
            if (marks.hidden) delete marks.hidden;
            else marks.hidden = true;
          }
          if (part !== '') pieces.push({ kind: 'text', text: part, marks: now() });
        });
        break;
      }
      case 'text_special':
        // An escaped space in raised text is a space, which follows it.
        if (token.content !== '') pieces.push({ kind: 'text', text: token.content, marks: now() });
        break;
      case 'code_inline':
        pieces.push({ kind: 'code', text: token.content, marks: now() });
        break;
      case 'softbreak':
        pieces.push({ kind: 'soft', marks: now() });
        break;
      case 'hardbreak':
        pieces.push({ kind: 'break', marks: now() });
        break;
      case 'strong_open':
        marks.strong = token.markup === '__' ? '__' : '**';
        break;
      case 'strong_close':
        delete marks.strong;
        break;
      case 'em_open':
        marks.em = token.markup === '_' ? '_' : '*';
        break;
      case 'em_close':
        delete marks.em;
        break;
      case 's_open':
        marks.s = true;
        break;
      case 's_close':
        delete marks.s;
        break;
      case 'sup_open':
        marks.sup = true;
        break;
      case 'sup_close':
        delete marks.sup;
        break;
      case 'sub_open':
        marks.sub = true;
        break;
      case 'sub_close':
        delete marks.sub;
        break;
      case 'link_open': {
        const href = String(token.attrGet('href') ?? '');
        const title = token.attrGet('title');
        marks.link = {
          href,
          ...(title ? { title: String(title) } : {}),
          ...(token.markup === 'autolink'
            ? { auto: true as const }
            : token.markup === 'linkify'
              ? { auto: 'bare' as const }
              : {}),
        };
        break;
      }
      case 'link_close':
        delete marks.link;
        break;
      case 'image': {
        const title = token.attrGet('title');
        pieces.push({
          kind: 'picture',
          src: String(token.attrGet('src') ?? ''),
          alt: token.children ? altText(token.children) : token.content,
          ...(title ? { title: String(title) } : {}),
          marks: now(),
        });
        break;
      }
      default:
        // Nothing else is made by the editor's parser; kept as its text if it were.
        if (token.content) pieces.push({ kind: 'text', text: token.content, marks: now() });
    }
  }
  return { pieces: normalizeInline(pieces), hidden: marks.hidden === true };
}

/** The pieces of a piece of inline Markdown (one paragraph's text). */
export function parseInline(markdown: string): Inline[] {
  const tokens = editParser.parseInline(markdown, {});
  return inlineFromTokens(tokens[0]?.children ?? []).pieces;
}

// ---------------------------------------------------------------------------
// Comparing and tidying

export function sameLink(a: LinkMark | undefined, b: LinkMark | undefined): boolean {
  if (!a || !b) return a === b;
  return a.href === b.href && (a.title ?? '') === (b.title ?? '') && a.auto === b.auto;
}

/** Whether two sets of marks are the same, the way they are written aside. */
export function sameMarks(a: Marks, b: Marks): boolean {
  return (
    !a.strong === !b.strong &&
    !a.em === !b.em &&
    !a.s === !b.s &&
    !a.hidden === !b.hidden &&
    !a.sup === !b.sup &&
    !a.sub === !b.sub &&
    sameLink(a.link, b.link)
  );
}

/** Whether two rows of pieces read the same: what they show, not how they are written. */
export function sameInline(a: readonly Inline[], b: readonly Inline[]): boolean {
  const x = normalizeInline(a);
  const y = normalizeInline(b);
  if (x.length !== y.length) return false;
  return x.every((piece, i) => {
    const other = y[i]!;
    if (piece.kind !== other.kind || !sameMarks(piece.marks, other.marks)) return false;
    if (piece.kind === 'text' || piece.kind === 'code') {
      return piece.text === (other as typeof piece).text;
    }
    if (piece.kind === 'picture') {
      const o = other as typeof piece;
      return piece.src === o.src && piece.alt === o.alt && (piece.title ?? '') === (o.title ?? '');
    }
    return true;
  });
}

/** Joins neighbouring text with the same marks and drops empty text. */
export function normalizeInline(pieces: readonly Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const piece of pieces) {
    if (piece.kind === 'text' && piece.text === '') continue;
    const last = out.at(-1);
    if (
      piece.kind === 'text' &&
      last?.kind === 'text' &&
      sameMarks(last.marks, piece.marks) &&
      last.marks.strong === piece.marks.strong &&
      last.marks.em === piece.marks.em
    ) {
      out[out.length - 1] = { ...last, text: last.text + piece.text };
    } else {
      out.push(piece);
    }
  }
  return out;
}

/** The plain words of the pieces: text, code and pictures' descriptions, line ends as spaces. */
export function inlinePlainText(pieces: readonly Inline[]): string {
  return pieces
    .map((piece) =>
      piece.kind === 'text' || piece.kind === 'code'
        ? piece.text
        : piece.kind === 'picture'
          ? piece.alt
          : ' ',
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Writing

/** Where the text is written: a cell escapes its bars, a heading has no line ends. */
export type InlineContext = 'block' | 'cell' | 'line';

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/**
 * Plain text escaped so it reads as the same text: every character that
 * could start or end a mark, a link, a picture or hidden text, and what
 * would start a block at the beginning of a line.
 */
export function escapeText(text: string, atLineStart: boolean): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const prev = text[i - 1];
    const next = text[i + 1];
    switch (ch) {
      case '\\':
        // A backslash escapes only punctuation; before anything else it is itself.
        out += next === undefined || ASCII_PUNCTUATION.test(next) ? '\\\\' : '\\';
        break;
      case '*':
      case '`':
      case '[':
      case ']':
      case '<':
      case '~':
      case '^':
      case '|':
        out += `\\${ch}`;
        break;
      case '_':
        out += isWordChar(prev) && isWordChar(next) ? '_' : '\\_';
        break;
      case '&':
        out += /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.test(text.slice(i))
          ? '&amp;'
          : '&';
        break;
      default:
        out += ch;
    }
  }
  return atLineStart ? escapeLineStart(out) : out;
}

/** What would start a block at the beginning of a line, escaped. */
function escapeLineStart(line: string): string {
  // Spaces at the start of a line are not shown, and four would make code.
  const rest = line.replace(/^[ \t]+/, '');
  if (/^(?:#{1,6}(?:[ \t]|$)|>|[-+=](?:[ \t]|$)|[-=]+[ \t]*$)/.test(rest)) return `\\${rest}`;
  const ordered = /^(\d{1,9})([.)])/.exec(rest);
  if (ordered) return `${ordered[1]}\\${rest.slice(ordered[1]!.length)}`;
  return rest;
}

/** Code written between enough backticks, with spaces where its ends need them. */
function writeCode(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((most, run) => Math.max(most, run.length), 0);
  const fence = '`'.repeat(longest + 1);
  const pad =
    text.startsWith('`') ||
    text.endsWith('`') ||
    (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '')
      ? ' '
      : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** A link's or picture's address as Markdown writes it. */
function writeDestination(href: string): string {
  if (href === '' || /[\s<>]/.test(href) || !balancedParens(href)) {
    return `<${href.replace(/([<>\\])/g, '\\$1')}>`;
  }
  return href.replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\');
}

function balancedParens(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

const writeTitle = (title: string | undefined) =>
  title ? ` "${title.replace(/(["\\])/g, '\\$1')}"` : '';

/** Plain text for inside `[…]` or `![…]`. */
const escapeLabel = (text: string) => escapeText(text.replace(/\s*\n\s*/g, ' '), false);

type MarkName = 'link' | 'strong' | 'em' | 's' | 'sup' | 'sub';
/**
 * Outermost first: a link holds bold, bold holds italic, italic holds
 * strikethrough, which holds raised and lowered text.
 */
const ORDER: readonly MarkName[] = ['link', 'strong', 'em', 's', 'sup', 'sub'];

interface Open {
  name: MarkName;
  /** What opened it: its delimiter, or the link. */
  delimiter: string;
  link?: LinkMark;
}

const hasMark = (marks: Marks, name: MarkName): boolean =>
  name === 'link' ? marks.link !== undefined : marks[name] !== undefined;

/**
 * Text whose spaces at its ends go outside the bold, italic and
 * strikethrough around it, where Markdown needs them to be.
 */
function spacesOutside(pieces: readonly Inline[]): Inline[] {
  const out: Inline[] = [];
  // Spaces may stand inside raised and lowered text (escaped), so they keep those.
  const kept = (a: Marks): Marks => ({
    ...(a.hidden ? { hidden: true } : {}),
    ...(a.sup ? { sup: true } : {}),
    ...(a.sub ? { sub: true } : {}),
  });
  const shared = (a: Marks, b: Marks | undefined): Marks => {
    if (!b) return { ...(a.link ? { link: a.link } : {}), ...kept(a) };
    const m: Marks = kept(a);
    if (a.link && sameLink(a.link, b.link)) m.link = a.link;
    if (a.strong && b.strong) m.strong = a.strong;
    if (a.em && b.em) m.em = a.em;
    if (a.s && b.s) m.s = true;
    return m;
  };
  pieces.forEach((piece, i) => {
    if (piece.kind !== 'text' || (!piece.marks.strong && !piece.marks.em && !piece.marks.s)) {
      out.push(piece);
      return;
    }
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(piece.text)!;
    const [, lead, core, trail] = match as unknown as [string, string, string, string];
    if (core === '') {
      out.push({ ...piece, marks: shared(piece.marks, pieces[i - 1]?.marks) });
      return;
    }
    if (lead)
      out.push({ kind: 'text', text: lead, marks: shared(piece.marks, pieces[i - 1]?.marks) });
    out.push({ ...piece, text: core });
    if (trail) {
      out.push({ kind: 'text', text: trail, marks: shared(piece.marks, pieces[i + 1]?.marks) });
    }
  });
  return out;
}

/**
 * The pieces as inline Markdown. Soft line ends are written as line ends
 * (`\n`), which the block they are in indents as it needs; in a cell or on
 * one line they are written as spaces.
 */
export function writeInline(pieces: readonly Inline[], context: InlineContext = 'block'): string {
  /** Raised and lowered text holds no bare space or line end: they are escaped. */
  const inScript = (marks: Marks) => marks.sup === true || marks.sub === true;
  // Line ends at the ends of a text are not shown, and a break at its end would be a backslash.
  const trimmed = normalizeInline(pieces);
  while (trimmed[0]?.kind === 'soft' || trimmed[0]?.kind === 'break') trimmed.shift();
  while (trimmed.at(-1)?.kind === 'soft' || trimmed.at(-1)?.kind === 'break') trimmed.pop();
  const items = spacesOutside(trimmed);
  let out = '';
  const stack: Open[] = [];
  let hidden = false;
  let atLineStart = true;

  const close = (open: Open) => {
    if (open.name === 'link') {
      const link = open.link!;
      out += `](${writeDestination(link.href)}${writeTitle(link.title)})`;
    } else {
      out += open.delimiter;
    }
  };
  const lastChar = () => out.at(-1);

  items.forEach((piece, index) => {
    // A link written as its address alone: `<address>`, or a bare address.
    const link = piece.marks.link;
    const atom =
      link?.auto !== undefined &&
      piece.kind === 'text' &&
      (link.auto === 'bare' || piece.text === link.href) &&
      !sameLink(items[index - 1]?.marks.link, link) &&
      !sameLink(items[index + 1]?.marks.link, link);
    const marks: Marks = atom ? { ...piece.marks, link: undefined } : piece.marks;
    // Close what this piece does not have, and what lies inside it.
    let keep = 0;
    while (keep < stack.length) {
      const open = stack[keep]!;
      const still =
        open.name === 'link' ? sameLink(open.link, marks.link) : hasMark(marks, open.name);
      if (!still) break;
      keep++;
    }
    while (stack.length > keep) close(stack.pop()!);
    if (!!marks.hidden !== hidden) {
      out += '||';
      hidden = !hidden;
    }
    // Open what it has, outermost first.
    for (const name of ORDER) {
      if (!hasMark(marks, name) || stack.some((open) => open.name === name)) continue;
      if (name === 'link') {
        out += '[';
        stack.push({ name, delimiter: '[', link: marks.link! });
        continue;
      }
      out += delimiterFor(name, marks, lastChar());
      stack.push({
        name,
        delimiter: out.slice(-(name === 'em' || name === 'sup' || name === 'sub' ? 1 : 2)),
      });
    }
    if (atom) {
      out += link.auto === 'bare' ? piece.text : `<${piece.text}>`;
      atLineStart = false;
      return;
    }
    switch (piece.kind) {
      case 'text': {
        const lines = piece.text.split('\n');
        lines.forEach((line, i) => {
          if (i > 0) {
            out += context === 'block' ? '\n' : ' ';
            atLineStart = context === 'block';
          }
          const escaped = escapeText(line, atLineStart);
          out += inScript(piece.marks) ? escaped.replace(/[ \t]/g, '\\ ') : escaped;
          if (line !== '') atLineStart = false;
        });
        break;
      }
      case 'code':
        out += writeCode(piece.text);
        atLineStart = false;
        break;
      case 'picture':
        out += `![${escapeLabel(piece.alt)}](${writeDestination(piece.src)}${writeTitle(piece.title)})`;
        atLineStart = false;
        break;
      case 'break':
        if (inScript(piece.marks) && context !== 'cell') {
          out += '\\ ';
        } else if (context === 'cell') {
          // The one line break a table cell has.
          out += CELL_BREAK;
        } else if (context === 'block') {
          out += '\\\n';
          atLineStart = true;
        } else {
          out += ' ';
        }
        break;
      case 'soft':
        if (inScript(piece.marks)) {
          out += '\\ ';
          break;
        }
        // Spaces before a line end would make it a hard break.
        out = out.replace(/[ \t]+$/, '');
        out += context === 'block' ? '\n' : ' ';
        atLineStart = context === 'block';
        break;
    }
  });
  while (stack.length > 0) close(stack.pop()!);
  if (hidden as boolean) out += '||';
  // A table splits its rows at bars and takes one backslash before a bar as
  // its own (a bar it does not split at), so in a cell every bar gets one:
  // the cell then reads as the text does, hidden text, code and all.
  return context === 'cell' ? out.replaceAll('|', '\\|') : out;
}

/**
 * The delimiter that opens bold, italic or strikethrough after `before`:
 * as the text had it, except that `_` never opens inside a word, and a
 * delimiter never follows another of the same character, where the two
 * would read as one.
 */
function delimiterFor(name: Exclude<MarkName, 'link'>, marks: Marks, before: string | undefined) {
  if (name === 's') return '~~';
  if (name === 'sup') return '^';
  if (name === 'sub') return '~';
  const wanted = name === 'strong' ? marks.strong! : marks.em!;
  const char = wanted[0]!;
  const other = char === '*' ? '_' : '*';
  const swap = (text: string) => text.replaceAll(char, other);
  if (char === '_' && (isWordChar(before) || before === '_')) return swap(wanted);
  if (char === '*' && before === '*') return swap(wanted);
  return wanted;
}

// ---------------------------------------------------------------------------
// Changing the pieces: what the text tools do

/** How long a piece is, counted as the editor counts places in the text. */
export function pieceLength(piece: Inline): number {
  return piece.kind === 'text' || piece.kind === 'code' ? piece.text.length : 1;
}

export function inlineLength(pieces: readonly Inline[]): number {
  return pieces.reduce((sum, piece) => sum + pieceLength(piece), 0);
}

/** The pieces split at a place in the text: what is before it and what is after. */
export function splitInline(pieces: readonly Inline[], at: number): [Inline[], Inline[]] {
  const before: Inline[] = [];
  const after: Inline[] = [];
  let pos = 0;
  for (const piece of pieces) {
    const length = pieceLength(piece);
    if (pos + length <= at) before.push(piece);
    else if (pos >= at) after.push(piece);
    else if (piece.kind === 'text' || piece.kind === 'code') {
      before.push({ ...piece, text: piece.text.slice(0, at - pos) });
      after.push({ ...piece, text: piece.text.slice(at - pos) });
    }
    pos += length;
  }
  return [normalizeInline(before), normalizeInline(after)];
}

/** The pieces from `start` to `end`, and what is around them. */
function cut(pieces: readonly Inline[], start: number, end: number) {
  const [before, rest] = splitInline(pieces, start);
  const [middle, after] = splitInline(rest, end - start);
  return { before, middle, after };
}

export type ToggleMark = 'strong' | 'em' | 's' | 'hidden' | 'code';

/** Whether every piece from `start` to `end` has a mark (or is code). */
export function hasMarkIn(
  pieces: readonly Inline[],
  start: number,
  end: number,
  mark: ToggleMark,
): boolean {
  if (start === end) {
    // At a place: the mark of the piece the place is in, or just after.
    const [before, after] = splitInline(pieces, start);
    const piece = after[0] ?? before.at(-1);
    return piece !== undefined && pieceHas(piece, mark);
  }
  const { middle } = cut(pieces, start, end);
  return middle.length > 0 && middle.every((piece) => pieceHas(piece, mark));
}

function pieceHas(piece: Inline, mark: ToggleMark): boolean {
  if (mark === 'code') return piece.kind === 'code';
  return piece.marks[mark] !== undefined;
}

/**
 * Turns a mark on for the pieces from `start` to `end`, or off when all of
 * them have it. Code turns text into code and back.
 */
export function toggleMark(
  pieces: readonly Inline[],
  start: number,
  end: number,
  mark: ToggleMark,
): Inline[] {
  if (start >= end) return [...pieces];
  const on = !hasMarkIn(pieces, start, end, mark);
  const { before, middle, after } = cut(pieces, start, end);
  const changed = middle.map((piece): Inline => {
    if (mark === 'code') {
      if (on && piece.kind === 'text')
        return { kind: 'code', text: piece.text, marks: piece.marks };
      if (!on && piece.kind === 'code')
        return { kind: 'text', text: piece.text, marks: piece.marks };
      return piece;
    }
    const marks: Marks = { ...piece.marks };
    if (mark === 'strong') marks.strong = on ? '**' : undefined;
    else if (mark === 'em') marks.em = on ? '*' : undefined;
    else if (mark === 's') marks.s = on ? true : undefined;
    else marks.hidden = on ? true : undefined;
    return { ...piece, marks: tidyMarks(marks) };
  });
  return normalizeInline([...before, ...changed, ...after]);
}

/** The span of the link at a place, or of the links from `start` to `end`. */
export function linkSpan(
  pieces: readonly Inline[],
  start: number,
  end: number,
): { start: number; end: number; link: LinkMark } | null {
  let pos = 0;
  const spans: { start: number; end: number; link: LinkMark }[] = [];
  for (const piece of pieces) {
    const length = pieceLength(piece);
    const link = piece.marks.link;
    if (link) {
      const last = spans.at(-1);
      if (last?.end === pos && sameLink(last.link, link)) last.end = pos + length;
      else spans.push({ start: pos, end: pos + length, link });
    }
    pos += length;
  }
  return (
    spans.find((span) =>
      start === end
        ? span.start <= start && start <= span.end && span.end > span.start
        : span.start < end && start < span.end,
    ) ?? null
  );
}

/** Links the pieces from `start` to `end` (or takes their link off, with null). */
export function setLink(
  pieces: readonly Inline[],
  start: number,
  end: number,
  link: LinkMark | null,
): Inline[] {
  const { before, middle, after } = cut(pieces, start, end);
  const changed = middle.map((piece): Inline => {
    return { ...piece, marks: tidyMarks({ ...piece.marks, link: link ?? undefined }) };
  });
  return normalizeInline([...before, ...changed, ...after]);
}

/** Marks without those set to nothing. */
function tidyMarks(marks: Marks): Marks {
  const out: Marks = {};
  if (marks.strong) out.strong = marks.strong;
  if (marks.em) out.em = marks.em;
  if (marks.s) out.s = true;
  if (marks.hidden) out.hidden = true;
  if (marks.sup) out.sup = true;
  if (marks.sub) out.sub = true;
  if (marks.link) out.link = marks.link;
  return out;
}

/** Puts pieces in at `at`, in place of what is from `at` to `end`. */
export function insertInline(
  pieces: readonly Inline[],
  at: number,
  end: number,
  inserted: readonly Inline[],
): Inline[] {
  const { before, after } = cut(pieces, at, end);
  return normalizeInline([...before, ...inserted, ...after]);
}

/** The marks text typed at a place gets: those of the text before it (not a link's end). */
export function marksAt(pieces: readonly Inline[], at: number): Marks {
  const [before] = splitInline(pieces, at);
  const last = before.at(-1);
  return last ? { ...last.marks } : {};
}
