import type { Token } from 'markdown-it';
import { editParser, inlineFromTokens, sameInline, writeInline, type Inline } from './inline';

/**
 * A page's Markdown as the page editor edits it: one block after another
 * (a paragraph, a heading, a list, a table, a quote, code, a line), each
 * remembering its own text exactly as it is in the page, with exactly what
 * separates it from the next.
 *
 * A page opened and saved without a change is the same text, byte for
 * byte: the blocks joined again are the page. Only a block that is edited
 * is written anew, from what it holds (see {@link writeBlock}); one edited
 * back to what it held is its own text again. Inside a list or a table,
 * an item or a row that was not changed keeps its own text too.
 *
 * Anything the editor has no tool for (reference definitions, a list item
 * holding more than text and a list, a quote holding more than paragraphs,
 * hidden text that spans blocks) is a block of its own kept as it is,
 * edited as Markdown.
 */

export type Align = 'left' | 'center' | 'right' | null;

export interface ListItemModel {
  content: Inline[];
  /** A list inside the item, after its text. */
  children: ListModel | null;
}

export interface ListModel {
  kind: 'list';
  ordered: boolean;
  /** The first number of a numbered list. */
  start: number;
  /** The bullet (`-`, `*`, `+`) or what follows a number (`.`, `)`). */
  marker: string;
  /** With a blank line between items. */
  loose: boolean;
  items: ListItemModel[];
}

export interface TableModel {
  kind: 'table';
  /** The alignment of each column. */
  align: Align[];
  header: Inline[][];
  rows: Inline[][][];
}

export type BlockModel =
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'heading'; level: number; setext: boolean; content: Inline[] }
  | ListModel
  | TableModel
  | { kind: 'quote'; paragraphs: Inline[][] }
  | { kind: 'code'; fence: string | null; info: string; text: string }
  | { kind: 'rule' }
  /** Kept as it is: `hidden`, hidden text that spans blocks or parts of a block. */
  | { kind: 'raw'; why: 'hidden' | 'other' };

export type BlockKind = BlockModel['kind'];

/** A block of a page: its own text, and what follows it up to the next block. */
export interface SourceBlock {
  source: string;
  after: string;
}

export interface SplitPage {
  /** What is before the first block (blank lines). */
  lead: string;
  blocks: SourceBlock[];
}

// ---------------------------------------------------------------------------
// Splitting a page into blocks

const LINE_END = /\r\n|\r|\n/g;
const isBlank = (line: string) => /^[ \t]*$/.test(line);

/** The `||` marks a block's text has, counted as the Markdown view counts them. */
function hiddenMarks(tokens: readonly Token[]): number[] {
  return tokens
    .filter((token) => token.type === 'inline')
    .map((token) =>
      (token.children ?? [])
        .filter((child) => child.type === 'text')
        .reduce((sum, child) => sum + child.content.split('||').length - 1, 0),
    );
}

interface Range {
  start: number;
  end: number;
  /** The `||` marks of each part of it with text. */
  marks: number[];
}

/** A page split into its blocks (see the top of this file). Joined again, they are the page. */
export function splitBlocks(text: string): SplitPage {
  const starts = [0];
  for (const match of text.matchAll(LINE_END)) starts.push(match.index + match[0].length);
  const lineText = (i: number) => {
    const from = starts[i]!;
    const to = i + 1 < starts.length ? starts[i + 1]! : text.length;
    return text.slice(from, to).replace(/(?:\r\n|\r|\n)$/, '');
  };
  const lineCount = starts.length;
  const tokens = editParser.parse(text, {});

  // Each block at the top: its lines, without blank lines at its end.
  const found: Range[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.level !== 0 || token.nesting === -1 || !token.map) continue;
    let j = i + 1;
    if (token.nesting === 1) {
      let depth = 1;
      while (j < tokens.length && depth > 0) {
        depth += tokens[j]!.nesting;
        j++;
      }
    }
    const start = token.map[0];
    let end = token.map[1];
    while (end - 1 > start && isBlank(lineText(end - 1))) end--;
    found.push({ start, end, marks: hiddenMarks(tokens.slice(i, j)) });
    i = j - 1;
  }

  // Lines between blocks that are not blank (reference definitions): kept as blocks of their own.
  const ranges: Range[] = [];
  let line = 0;
  const gap = (from: number, to: number) => {
    let first = from;
    while (first < to && isBlank(lineText(first))) first++;
    let last = to;
    while (last > first && isBlank(lineText(last - 1))) last--;
    if (first < last) ranges.push({ start: first, end: last, marks: [] });
  };
  for (const range of found) {
    gap(line, range.start);
    ranges.push(range);
    line = range.end;
  }
  gap(line, lineCount);

  // Hidden text that opens in one block and closes in a later one: one block.
  const grouped: Range[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i]!;
    let total = range.marks.reduce((a, b) => a + b, 0);
    if (total % 2 === 0) {
      grouped.push(range);
      continue;
    }
    // The last bar pairs with one further on, if there is one.
    const laterMarks = ranges.slice(i + 1).some((r) => r.marks.some((n) => n > 0));
    if (!laterMarks) {
      grouped.push(range);
      continue;
    }
    let j = i;
    while (total % 2 === 1 && j + 1 < ranges.length) {
      j++;
      total += ranges[j]!.marks.reduce((a, b) => a + b, 0);
    }
    grouped.push({ start: range.start, end: ranges[j]!.end, marks: [total] });
    i = j;
  }

  const offset = (lineIndex: number) => (lineIndex < lineCount ? starts[lineIndex]! : text.length);
  const endOf = (lineIndex: number) => offset(lineIndex) + lineText(lineIndex).length;
  const blocks: SourceBlock[] = grouped.map((range, i) => {
    const from = offset(range.start);
    const to = endOf(range.end - 1);
    const next = grouped[i + 1];
    return {
      source: text.slice(from, to),
      after: text.slice(to, next ? offset(next.start) : text.length),
    };
  });
  return { lead: text.slice(0, grouped[0] ? offset(grouped[0].start) : text.length), blocks };
}

/** The page again from its blocks. */
export function joinBlocks(page: SplitPage): string {
  return page.lead + page.blocks.map((block) => block.source + block.after).join('');
}

/** The line end a text uses most: `\r\n` or `\n`. */
export function lineEndOf(text: string): '\n' | '\r\n' {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

// ---------------------------------------------------------------------------
// Reading one block

/** The tokens of one list, read into a list; null when an item holds more than the editor edits. */
function readList(tokens: readonly Token[], at: number): { list: ListModel; next: number } | null {
  const open = tokens[at]!;
  const ordered = open.type === 'ordered_list_open';
  const list: ListModel = {
    kind: 'list',
    ordered,
    start: ordered ? Number(open.attrGet('start') ?? 1) : 1,
    marker: open.markup || (ordered ? '.' : '-'),
    loose: false,
    items: [],
  };
  let i = at + 1;
  while (tokens[i]?.type === 'list_item_open') {
    const item: ListItemModel = { content: [], children: null };
    let k = i + 1;
    let text = false;
    while (tokens[k] && tokens[k]!.type !== 'list_item_close') {
      const token = tokens[k]!;
      if (token.type === 'paragraph_open' && !text && item.children === null) {
        item.content = inlineFromTokens(tokens[k + 1]?.children ?? []).pieces;
        if (!token.hidden) list.loose = true;
        text = true;
        k += 3;
      } else if (
        (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') &&
        item.children === null
      ) {
        const inner = readList(tokens, k);
        if (!inner) return null;
        item.children = inner.list;
        k = inner.next;
      } else {
        return null;
      }
    }
    list.items.push(item);
    i = k + 1;
  }
  return { list, next: i + 1 };
}

const ALIGN = /text-align:\s*(left|center|right)/;

function readTable(tokens: readonly Token[]): TableModel | null {
  const table: TableModel = { kind: 'table', align: [], header: [], rows: [] };
  let row: Inline[][] | null = null;
  let inHead = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    switch (token.type) {
      case 'thead_open':
        inHead = true;
        break;
      case 'thead_close':
        inHead = false;
        break;
      case 'tr_open':
        row = [];
        break;
      case 'tr_close':
        if (row) {
          if (inHead) table.header = row;
          else table.rows.push(row);
        }
        row = null;
        break;
      case 'th_open':
      case 'td_open': {
        if (token.type === 'th_open') {
          const match = ALIGN.exec(String(token.attrGet('style') ?? ''));
          table.align.push((match?.[1] as Align | undefined) ?? null);
        }
        const inline = tokens[i + 1];
        row?.push(inline?.type === 'inline' ? inlineFromTokens(inline.children ?? []).pieces : []);
        break;
      }
      default:
        break;
    }
  }
  const width = table.header.length;
  if (width === 0) return null;
  // Rows shorter than the header have empty cells, as the view shows them.
  table.rows = table.rows.map((cells) => Array.from({ length: width }, (_, c) => cells[c] ?? []));
  return table;
}

/** What a block holds, read from its text; `raw` when the editor has no tool for it. */
export function readBlock(source: string): BlockModel {
  const tokens = editParser.parse(source, {});
  const top = tokens.filter((token) => token.level === 0 && token.nesting !== -1);
  if (top.length !== 1) return { kind: 'raw', why: 'other' };
  const marks = hiddenMarks(tokens);
  if (marks.some((n) => n % 2 === 1)) return { kind: 'raw', why: 'hidden' };
  const first = tokens[0]!;
  switch (first.type) {
    case 'paragraph_open':
      return { kind: 'paragraph', content: inlineFromTokens(tokens[1]?.children ?? []).pieces };
    case 'heading_open':
      return {
        kind: 'heading',
        level: Number(first.tag.slice(1)),
        setext: first.markup === '=' || first.markup === '-',
        content: inlineFromTokens(tokens[1]?.children ?? []).pieces,
      };
    case 'bullet_list_open':
    case 'ordered_list_open':
      return readList(tokens, 0)?.list ?? { kind: 'raw', why: 'other' };
    case 'table_open':
      return readTable(tokens) ?? { kind: 'raw', why: 'other' };
    case 'blockquote_open': {
      const paragraphs: Inline[][] = [];
      for (let i = 1; i < tokens.length - 1; i += 3) {
        if (tokens[i]!.type !== 'paragraph_open') return { kind: 'raw', why: 'other' };
        paragraphs.push(inlineFromTokens(tokens[i + 1]?.children ?? []).pieces);
      }
      return paragraphs.length > 0 ? { kind: 'quote', paragraphs } : { kind: 'raw', why: 'other' };
    }
    case 'fence':
      return { kind: 'code', fence: first.markup, info: first.info, text: first.content };
    case 'code_block':
      return { kind: 'code', fence: null, info: '', text: first.content };
    case 'hr':
      return { kind: 'rule' };
    default:
      return { kind: 'raw', why: 'other' };
  }
}

// ---------------------------------------------------------------------------
// Comparing

const sameRows = (a: readonly Inline[][], b: readonly Inline[][]) =>
  a.length === b.length && a.every((cell, i) => sameInline(cell, b[i]!));

function sameList(a: ListModel, b: ListModel): boolean {
  return (
    a.ordered === b.ordered &&
    a.loose === b.loose &&
    a.marker === b.marker &&
    (!a.ordered || a.start === b.start) &&
    a.items.length === b.items.length &&
    a.items.every((item, i) => sameItem(item, b.items[i]!))
  );
}

function sameItem(a: ListItemModel, b: ListItemModel): boolean {
  return (
    sameInline(a.content, b.content) &&
    (a.children === null || b.children === null
      ? a.children === b.children
      : sameList(a.children, b.children))
  );
}

/** Whether two blocks hold the same: what they show, not how they are written. */
export function sameBlock(a: BlockModel, b: BlockModel): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'paragraph':
      return sameInline(a.content, (b as typeof a).content);
    case 'heading': {
      const o = b as typeof a;
      return a.level === o.level && sameInline(a.content, o.content);
    }
    case 'list':
      return sameList(a, b as ListModel);
    case 'table': {
      const o = b as TableModel;
      return (
        a.align.length === o.align.length &&
        a.align.every((align, i) => align === o.align[i]) &&
        sameRows(a.header, o.header) &&
        a.rows.length === o.rows.length &&
        a.rows.every((row, i) => sameRows(row, o.rows[i]!))
      );
    }
    case 'quote': {
      const o = b as typeof a;
      return (
        a.paragraphs.length === o.paragraphs.length &&
        a.paragraphs.every((p, i) => sameInline(p, o.paragraphs[i]!))
      );
    }
    case 'code': {
      const o = b as typeof a;
      return (a.fence === null) === (o.fence === null) && a.info === o.info && a.text === o.text;
    }
    case 'rule':
      return true;
    case 'raw':
      return false;
  }
}

// ---------------------------------------------------------------------------
// Writing one block

/** The lines of a text indented by `pad`, blank lines left blank. */
const indent = (text: string, pad: string) =>
  text
    .split('\n')
    .map((line) => (line === '' ? '' : pad + line))
    .join('\n');

/** A heading's text with `#` at its end escaped, which would be taken for closing marks. */
function headingText(content: readonly Inline[]): string {
  const text = writeInline(content, 'line');
  return /(^|[ \t])#+[ \t]*$/.test(text) ? text.replace(/#([ \t]*)$/, '\\#$1') : text;
}

function writeList(
  list: ListModel,
  original: ListModel | null,
  sources: readonly string[],
): string {
  const bullet = /^[-*+]$/.test(list.marker) ? list.marker : '-';
  const delimiter = list.marker === ')' ? ')' : '.';
  const same =
    original !== null &&
    original.ordered === list.ordered &&
    original.marker === list.marker &&
    original.loose === list.loose &&
    (!list.ordered || original.start === list.start);
  const items = list.items.map((item, i) => {
    const kept = same ? original.items[i] : undefined;
    if (kept && sources[i] !== undefined && sameItem(item, kept)) return sources[i];
    const marker = list.ordered ? `${list.start + i}${delimiter}` : bullet;
    const pad = ' '.repeat(marker.length + 1);
    const text = writeInline(item.content, 'block');
    let out = text === '' ? marker : `${marker} ${indent(text, pad).slice(pad.length)}`;
    if (item.children) out += `\n${indent(writeList(item.children, null, []), pad)}`;
    return out;
  });
  return items.join(list.loose ? '\n\n' : '\n');
}

function writeTable(
  table: TableModel,
  original: TableModel | null,
  lines: readonly string[],
): string {
  const width = table.align.length;
  const sameWidth = original !== null && original.align.length === width;
  const row = (cells: readonly Inline[][]) =>
    `| ${cells.map((cell) => writeInline(cell, 'cell')).join(' | ')} |`.replace(/ {2}\|/g, ' |');
  const header =
    sameWidth && sameRows(table.header, original.header) && lines[0] !== undefined
      ? lines[0]
      : row(table.header);
  const rule =
    sameWidth && table.align.every((a, i) => a === original.align[i]) && lines[1] !== undefined
      ? lines[1]
      : `| ${table.align
          .map((align) =>
            align === 'center'
              ? ':---:'
              : align === 'right'
                ? '---:'
                : align === 'left'
                  ? ':---'
                  : '---',
          )
          .join(' | ')} |`;
  const body = table.rows.map((cells, i) => {
    const kept = sameWidth ? original.rows[i] : undefined;
    const line = lines[i + 2];
    return kept && line !== undefined && sameRows(cells, kept) ? line : row(cells);
  });
  return [header, rule, ...body].join('\n');
}

/** Code between fences longer than any line of it that could close them. */
function writeCode(fence: string, info: string, text: string): string {
  let char = fence.startsWith('~') ? '~' : '`';
  if (char === '`' && info.includes('`')) char = '~';
  const longest = Math.max(
    0,
    ...text
      .split('\n')
      .map((line) => new RegExp(`^ {0,3}(\\${char}+)`).exec(line)?.[1]?.length ?? 0),
  );
  const marks = char.repeat(Math.max(3, fence.length, longest + 1));
  const body = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return `${marks}${info}\n${body}${marks}`;
}

/** The lines of each item of a list at the top of a block, as the block has them. */
function itemSources(source: string): string[] {
  const tokens = editParser.parse(source, {});
  const lines = source.split(/\r\n|\r|\n/);
  return tokens
    .filter((token) => token.type === 'list_item_open' && token.level === 1 && token.map)
    .map((token) => {
      const [start, last] = token.map!;
      let end = last;
      while (end - 1 > start && isBlank(lines[end - 1] ?? '')) end--;
      return lines.slice(start, end).join('\n');
    });
}

/** The line of each row of a table, the rule under the header second. */
function rowSources(source: string): string[] {
  return source.split(/\r\n|\r|\n/);
}

/**
 * A block written as Markdown. Given what the block was (its text), what
 * did not change keeps that text: the whole block, or the items of a list
 * and the rows of a table that are as they were.
 */
export function writeBlock(model: BlockModel, original?: string): string {
  const before = original === undefined ? null : readBlock(original);
  if (before && original !== undefined && sameBlock(model, before)) return original;
  switch (model.kind) {
    case 'paragraph':
      return writeInline(model.content, 'block');
    case 'heading':
      if (model.setext && model.level <= 2) {
        const text = writeInline(model.content, 'block');
        return `${text}\n${model.level === 1 ? '===' : '---'}`;
      }
      return `${'#'.repeat(Math.min(6, Math.max(1, model.level)))} ${headingText(model.content)}`.trimEnd();
    case 'list':
      return writeList(
        model,
        before?.kind === 'list' ? before : null,
        before?.kind === 'list' ? itemSources(original!) : [],
      );
    case 'table':
      return writeTable(
        model,
        before?.kind === 'table' ? before : null,
        before?.kind === 'table' ? rowSources(original!) : [],
      );
    case 'quote':
      return model.paragraphs
        .map((paragraph) =>
          writeInline(paragraph, 'block')
            .split('\n')
            .map((line) => (line === '' ? '>' : `> ${line}`))
            .join('\n'),
        )
        .join('\n>\n');
    case 'code':
      if (model.fence === null) {
        return model.text
          .replace(/\n$/, '')
          .split('\n')
          .map((line) => (line === '' ? '' : `    ${line}`))
          .join('\n');
      }
      return writeCode(model.fence, model.info, model.text);
    case 'rule':
      return original ?? '---';
    case 'raw':
      return original ?? '';
  }
}

// ---------------------------------------------------------------------------
// New blocks

export const emptyParagraph = (): BlockModel => ({ kind: 'paragraph', content: [] });

/** A table of `columns` columns, a header and `rows` rows, all empty. */
export function newTable(columns = 3, rows = 2): TableModel {
  const empty = () => Array.from({ length: columns }, (): Inline[] => []);
  return {
    kind: 'table',
    align: Array.from({ length: columns }, () => null),
    header: Array.from({ length: columns }, (_, i): Inline[] => [
      { kind: 'text', text: `Column ${i + 1}`, marks: {} },
    ]),
    rows: Array.from({ length: rows }, empty),
  };
}

export function newList(ordered: boolean, content: Inline[] = []): ListModel {
  return {
    kind: 'list',
    ordered,
    start: 1,
    marker: ordered ? '.' : '-',
    loose: false,
    items: [{ content, children: null }],
  };
}
