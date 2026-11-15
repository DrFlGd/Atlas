import { headingNames, sectionOfTitle } from '@atlas/core';
import { parseId } from '@atlas/schema';
import MarkdownIt, { type StateCore, type Token } from 'markdown-it';
import { isBoxMark, markdownMarks } from './markdownMarks';

/**
 * Renders guide Markdown from a pack, which is untrusted content.
 *
 * - `html: false` escapes any raw HTML in the source instead of passing it
 *   through, so the output contains only tags the renderer itself creates.
 * - markdown-it's link validation drops `javascript:`, `vbscript:`, `file:`
 *   and `data:` link targets.
 * - A picture is shown only when its target is the id of a picture of the
 *   pack (`![the gate](demo:picture:gate)`, see
 *   {@link MarkdownOptions.picture}), from the pack's own folder. Any other
 *   image is shown as its alternative text, so a guide cannot make the app
 *   fetch remote content. A title of the form `"=28x13"` (or `"=28"`, the
 *   width alone) is the size the picture is shown at where it stands, in
 *   CSS pixels (see {@link shownSize}); one at most
 *   {@link INLINE_PICTURE_HEIGHT} pixels tall stands in the line of text,
 *   as a badge or an icon does.
 * - Links open in a new tab with `rel="noopener noreferrer"`.
 * - A link whose target is a content id, such as `[the old well](demo:loc:0412)`,
 *   is an in-app link (see {@link MarkdownOptions.isAppTarget}): it becomes a
 *   button carrying the id in `data-atlas-target`, which the app acts on, and
 *   never a link the browser follows. An id the pack does not have, or of a
 *   kind the app cannot show, becomes plain text.
 * - A link to a page can name a section of it with its title, `#` and the
 *   section's name: `[by boat](demo:guide:travel "#by-boat")` (see
 *   `sections.ts` in `@atlas/core`). The button carries the section in
 *   `data-atlas-section`, and such a title is no tooltip.
 * - Every heading has a name worked out from its words, in
 *   `data-section` (see {@link guideHeadings}), so a link to a section can
 *   find it; nothing is stored for it.
 * - Text between double bars, `||like this||`, is hidden until the reader
 *   asks for it (see {@link revealHiddenText}): a "Show hidden text" button
 *   stands where it begins, and the hidden part is in the page with the
 *   `hidden` attribute, so it is neither seen, read out nor reachable with
 *   the keyboard. A hidden part may span paragraphs, lists and code, and
 *   may hold in-app links. Bars pair up left to right; a last bar without a
 *   partner, bars in code and escaped bars stay plain text. Bars in
 *   paragraphs of their own around other blocks hide those blocks whole,
 *   a whole table among them (never a part of one), and a paragraph that
 *   only closes a hidden part is left out.
 * - Raised and lowered text, `^like this^` and `~like this~`, and a line
 *   break in a table cell, the exact text `<br>` (see `markdownMarks.ts`):
 *   the renderer makes the tags, as for any other mark; the text holds no
 *   HTML of its own.
 * - Coloured words, `[like this]{color=#b8714a}` (see `markdownMarks.ts`):
 *   a `span` whose one attribute of the text's own is the colour, checked
 *   to be `#` and six hexadecimal digits, as `data-text-colour`; the page
 *   shows it readable in both themes (see `textColour.ts`). No `style`
 *   attribute is ever written.
 * - A box of facts, a table whose first row is its title and `{box}` (see
 *   `markdownMarks.ts` and {@link boxes}): an `aside` named by its title,
 *   holding the table, its title across it, a label beside each value, and
 *   the rows with an empty second cell across it. The page shows it beside
 *   the text where there is room, and across the page where there is not.
 * - A list of tiles (see {@link tiles}): a bulleted list whose every item
 *   is a picture shown on its own and at most a name, as a wiki's gallery
 *   or a home page's grid of linked pictures, is shown as a grid of
 *   tiles, each name under its picture. Its Markdown is a list as any.
 */
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true });
markdown.use(markdownMarks);

/** A picture of the pack, as a guide shows it. */
export interface GuidePicture {
  /** Where the app loads it: in the pack's own folder. */
  url: string;
  /**
   * Its file, when `url` is a smaller copy of it for pages (the picture's
   * `pageCopy`): shown in the larger view, and on the page when the copy
   * is not there.
   */
  fullUrl?: string;
  caption?: string;
  credit?: string;
  width?: number;
  height?: number;
}

export interface MarkdownOptions {
  /** Whether an in-app link to this content id can be followed. */
  isAppTarget?: (id: string) => boolean;
  /** The pack's picture with this id, or null when the pack has none. */
  picture?: (id: string) => GuidePicture | null;
  /**
   * For a page of a game read from a site: what a link to one of its pages
   * that is not in the game says when pointed at ("This page has not been
   * read yet"). It stays plain text, marked with `data-unread`.
   */
  unreadPage?: string;
}

interface AppLinkMeta {
  appLink?: 'ok' | 'missing';
}

markdown.core.ruler.push('atlas_app_links', (state) => {
  const isAppTarget = (state.env as MarkdownOptions | undefined)?.isAppTarget;
  const unreadPage = (state.env as MarkdownOptions | undefined)?.unreadPage;
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    // Links do not nest, so each link_open is closed by the next link_close.
    let open: Token | null = null;
    for (const token of block.children) {
      if (token.type === 'link_open') {
        const href = String(token.attrGet('href') ?? '');
        const target = parseId(href);
        open = target ? token : null;
        if (!open) continue;
        const ok = isAppTarget?.(href) ?? false;
        const title = token.attrGet('title');
        // A title that names a section of the page is no tooltip.
        const section = target?.kind === 'guide' ? sectionOfTitle(String(title ?? '')) : null;
        (token.meta as AppLinkMeta | null) = { appLink: ok ? 'ok' : 'missing' };
        if (ok) {
          token.tag = 'button';
          token.attrs = [
            ['type', 'button'],
            ['class', 'app-link'],
            ['data-atlas-target', href],
          ];
          if (section) token.attrs.push(['data-atlas-section', section]);
        } else {
          token.tag = 'span';
          token.attrs = [['class', 'app-link-missing']];
          // A page of the site the game was read from that was not read yet.
          if (unreadPage && target?.kind === 'guide') {
            token.attrs.push(['data-unread', ''], ['title', unreadPage]);
          }
        }
        if (title !== null && title !== '' && !section) token.attrSet('title', String(title));
      } else if (token.type === 'link_close' && open) {
        token.tag = open.tag;
        open = null;
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Headings: each with a name from its words

/** A heading of a guide's text, as {@link guideHeadings} gives it. */
export interface GuideHeading {
  /** 1 to 6, as `#` to `######`. */
  level: number;
  /** Its words, as the page shows them. */
  words: string;
  /** Its name, which a link to its section names (see `sections.ts` in `@atlas/core`). */
  name: string;
  /** Inside hidden text, so not shown until the reader asks. */
  hidden: boolean;
}

/** The words of a heading's inline tokens, as the page shows them (pictures and buttons aside). */
function wordsOf(tokens: readonly Token[]): string {
  return tokens
    .map((token) =>
      token.type === 'text' || token.type === 'code_inline'
        ? token.content
        : token.type === 'softbreak' || token.type === 'hardbreak'
          ? ' '
          : token.children && token.type !== 'image'
            ? wordsOf(token.children)
            : '',
    )
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The headings of the parsed text, each named, in order. */
function headingsOf(state: StateCore): GuideHeading[] {
  const found: { open: Token; level: number; words: string; hidden: boolean }[] = [];
  // Whether each block open around a token is hidden as a whole.
  const around: boolean[] = [];
  state.tokens.forEach((token, i) => {
    if (token.nesting === -1) around.pop();
    if (token.nesting === 1) around.push(token.attrGet('hidden') !== null);
    if (token.type !== 'heading_open') return;
    const inline = state.tokens[i + 1];
    found.push({
      open: token,
      level: Number(token.tag.slice(1)) || 1,
      words: inline?.children ? wordsOf(inline.children) : '',
      hidden: around.includes(true),
    });
  });
  const names = headingNames(found.map((heading) => heading.words));
  return found.map((heading, i) => {
    heading.open.attrSet('data-section', names[i]!);
    return { level: heading.level, words: heading.words, name: names[i]!, hidden: heading.hidden };
  });
}

markdown.core.ruler.push('atlas_headings', (state) => {
  (state.env as HeadingsEnv).headings = headingsOf(state);
});

type HeadingsEnv = Record<string, unknown> & { headings?: GuideHeading[] };

/**
 * The headings of a guide's text, in order, each with its name: the same
 * names the page gives them where it is shown (`data-section`). A heading
 * inside hidden text says so.
 */
export function guideHeadings(source: string): GuideHeading[] {
  const env: HeadingsEnv = {};
  markdown.parse(source, env);
  return env.headings ?? [];
}

// ---------------------------------------------------------------------------
// Boxes of facts: | Title | {box} |

interface BoxMeta {
  /** On a box's `table_open` and `table_close`: its title in words, for the box's name. */
  box?: string;
}

/** The index of the token that closes the one at `open`, by nesting. */
function closing(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    depth += tokens[i]!.nesting;
    if (depth === 0) return i;
  }
  return tokens.length - 1;
}

/** Whether a cell's words are all bold: one bold part from its start to its end. */
function allBold(inline: Token): boolean {
  const parts = (inline.children ?? []).filter(
    (token) => !(token.type === 'text' && token.content.trim() === ''),
  );
  if (parts[0]?.type !== 'strong_open' || parts.at(-1)?.type !== 'strong_close') return false;
  let depth = 0;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]!.type === 'strong_open') depth++;
    else if (parts[i]!.type === 'strong_close') depth--;
    if (depth === 0 && i < parts.length - 1) return false;
  }
  return true;
}

/** A cell's tokens made the given tag, with only the given attributes. */
function cellAs(cell: readonly Token[], tag: 'th' | 'td', attrs: [string, string][]): Token[] {
  cell[0]!.tag = tag;
  cell[2]!.tag = tag;
  cell[0]!.attrs = attrs;
  return [...cell];
}

/**
 * Makes each box of facts of the parsed text a box: the `{box}` cell goes,
 * the title spans the table (or the first row goes, when the box has no
 * title), a row with an empty second cell spans it too (a sub-heading when
 * its words are all bold), an empty row goes, and every other row is a
 * label (a heading cell for its row) and its value. Alignment is not kept.
 */
function boxes(state: StateCore): void {
  const tokens = state.tokens;
  for (let start = 0; start < tokens.length; start++) {
    if (tokens[start]!.type !== 'table_open') continue;
    const end = closing(tokens, start);
    // The first row: thead, tr, two cells of three tokens each, tr close.
    const [theadOpen, trOpen] = [tokens[start + 1], tokens[start + 2]];
    const title = tokens.slice(start + 3, start + 6);
    const mark = tokens.slice(start + 6, start + 9);
    const trClose = tokens[start + 9];
    if (
      theadOpen?.type !== 'thead_open' ||
      trClose?.type !== 'tr_close' ||
      mark[1]?.type !== 'inline' ||
      !isBoxMark(mark[1].content)
    ) {
      continue;
    }
    const words = title[1]?.children ? wordsOf(title[1].children) : '';
    const table = tokens[start]!;
    (table.meta as (BoxMeta & HiddenMeta) | null) = { ...metaOf(table), box: words };
    tokens[end]!.meta = { box: words } satisfies BoxMeta;
    const out: Token[] = [table];
    const theadClose = closing(tokens, start + 1);
    // The title across the box; no first row for a box without one.
    if ((title[1]?.content.trim() ?? '') !== '') {
      out.push(
        theadOpen,
        trOpen!,
        ...cellAs(title, 'th', [
          ['colspan', '2'],
          ['class', 'guide-box-title'],
          ['scope', 'colgroup'],
        ]),
        trClose,
        tokens[theadClose]!,
      );
    }
    for (let i = theadClose + 1; i < end; i++) {
      const token = tokens[i]!;
      if (token.type !== 'tr_open') {
        out.push(token);
        continue;
      }
      const rowEnd = closing(tokens, i);
      // A cell is three tokens: its open, its inline content, its close.
      const label = tokens.slice(i + 1, i + 4);
      const value = tokens.slice(i + 4, i + 7);
      const [open, close] = [token, tokens[rowEnd]!];
      i = rowEnd;
      const empty = (cell: readonly Token[]) => (cell[1]?.content.trim() ?? '') === '';
      if (label.length < 3 || empty(label)) {
        // Only a value: across the box; nothing: no row.
        if (value.length === 3 && !empty(value)) {
          out.push(
            open,
            ...cellAs(value, 'td', [
              ['colspan', '2'],
              ['class', 'guide-box-wide'],
            ]),
            close,
          );
        }
        continue;
      }
      if (value.length < 3 || empty(value)) {
        const heading = allBold(label[1]!);
        out.push(
          open,
          ...(heading
            ? cellAs(label, 'th', [
                ['colspan', '2'],
                ['class', 'guide-box-heading'],
                ['scope', 'colgroup'],
              ])
            : cellAs(label, 'td', [
                ['colspan', '2'],
                ['class', 'guide-box-wide'],
              ])),
          close,
        );
        continue;
      }
      out.push(
        open,
        ...cellAs(label, 'th', [
          ['scope', 'row'],
          ['class', 'guide-box-label'],
        ]),
        ...cellAs(value, 'td', [['class', 'guide-box-value']]),
        close,
      );
    }
    out.push(tokens[end]!);
    tokens.splice(start, end - start + 1, ...out);
    start += out.length - 1;
  }
}

markdown.core.ruler.push('atlas_boxes', boxes);

/** The first row of a box of facts, as written: `| Title | {box} |`. */
const BOX_ROW = /^ {0,3}\|?[^\n]*\|[ \t]*\{box\}[ \t]*\|?[ \t]*$/u;
const TABLE_RULE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/u;

/**
 * A guide's Markdown without its boxes of facts, read line by line: for
 * the lines that begin a page as its text does (a box usually stands
 * first, beside the text).
 */
export function withoutBoxes(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (BOX_ROW.test(lines[i]!) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') i++;
      i--;
      continue;
    }
    out.push(lines[i]!);
  }
  return out.join('\n');
}

const renderDefault: NonNullable<(typeof markdown.renderer.rules)['table_open']> = (
  tokens,
  index,
  options,
  _env,
  self,
) => self.renderToken(tokens, index, options);
const defaultTableOpen = markdown.renderer.rules.table_open ?? renderDefault;
const defaultTableClose = markdown.renderer.rules.table_close ?? renderDefault;

markdown.renderer.rules.table_open = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  const title = (token.meta as BoxMeta | null)?.box;
  if (title === undefined) return defaultTableOpen(tokens, index, options, env, self);
  // The box carries what the table would (hidden as a whole, say); the table itself is plain.
  const escape = markdown.utils.escapeHtml;
  const attrs = (token.attrs ?? [])
    .map(([name, value]) => ` ${escape(name)}="${escape(String(value))}"`)
    .join('');
  const name = title ? ` aria-label="${escape(title)}"` : '';
  return `<aside class="guide-box" data-box=""${name}${attrs}>\n<table>\n`;
};

markdown.renderer.rules.table_close = (tokens, index, options, env, self) =>
  (tokens[index]!.meta as BoxMeta | null)?.box === undefined
    ? defaultTableClose(tokens, index, options, env, self)
    : '</table>\n</aside>\n';

// ---------------------------------------------------------------------------
// Pictures: only the pack's own, by id

interface PictureMeta {
  alt: string;
  picture: GuidePicture | null;
  /** The size it is shown at where it stands, when the guide gives one. */
  shown: ShownSize | null;
}

/** The size a guide gives a picture where it stands, in CSS pixels. */
export interface ShownSize {
  width: number;
  height?: number;
}

/** A picture this tall or less is shown in the line of text, like a letter. */
export const INLINE_PICTURE_HEIGHT = 48;

/**
 * The size a picture's title gives: `"=28x13"` or `"=28"` (width only), as
 * in `![a badge](demo:picture:badge "=28x13")`. Any other title is none.
 */
export function shownSize(title: string | null | undefined): ShownSize | null {
  const match = /^=([1-9]\d{0,3})(?:x([1-9]\d{0,3}))?$/u.exec(title?.trim() ?? '');
  if (!match) return null;
  const width = Number(match[1]);
  return match[2] ? { width, height: Number(match[2]) } : { width };
}

/** Whether a picture of that size stands in the line of text. */
export const isInlinePicture = (size: ShownSize | null): boolean =>
  size !== null && (size.height ?? size.width) <= INLINE_PICTURE_HEIGHT;

markdown.core.ruler.push('atlas_pictures', (state) => {
  const pictureOf = (state.env as MarkdownOptions | undefined)?.picture;
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    for (const token of block.children) {
      if (token.type !== 'image') continue;
      const src = String(token.attrGet('src') ?? '');
      const alt = token.children ? altText(token.children) : token.content;
      const picture = parseId(src)?.kind === 'picture' ? (pictureOf?.(src) ?? null) : null;
      token.type = 'atlas_picture';
      const shown = shownSize(String(token.attrGet('title') ?? ''));
      token.meta = { alt, picture, shown } satisfies PictureMeta;
      token.children = null;
    }
  }
});

function altText(tokens: readonly Token[]): string {
  return tokens.map((token) => (token.children ? altText(token.children) : token.content)).join('');
}

markdown.renderer.rules.atlas_picture = (tokens, index) => {
  const { alt, picture, shown } = tokens[index]!.meta as unknown as PictureMeta;
  const escape = markdown.utils.escapeHtml;
  if (!picture) {
    // Never fetched: what the picture shows, in words.
    return alt ? `<span class="picture-alt">${escape(alt)}</span>` : '';
  }
  const note = [picture.caption, picture.credit].filter(Boolean).join(' · ');
  const full = picture.fullUrl ? ` data-full="${escape(picture.fullUrl)}"` : '';
  if (shown) {
    // The size the guide gives it where it stands; a small one stands in
    // the line of text, with what it shows as its tooltip and no line under it.
    const inline = isInlinePicture(shown);
    const size = ` width="${shown.width}"${shown.height ? ` height="${shown.height}"` : ''}`;
    const tip =
      inline && (picture.caption ?? alt) ? ` title="${escape(picture.caption ?? alt)}"` : '';
    return (
      `<span class="guide-picture ${inline ? 'inline' : 'sized'}"><img src="${escape(picture.url)}"${full} alt="${escape(alt)}"${size}${tip} loading="lazy" decoding="async">` +
      (note && !inline ? `<span class="guide-picture-note">${escape(note)}</span>` : '') +
      '</span>'
    );
  }
  const size =
    picture.width && picture.height ? ` width="${picture.width}" height="${picture.height}"` : '';
  return (
    `<span class="guide-picture"><img src="${escape(picture.url)}"${full} alt="${escape(alt)}"${size} loading="lazy" decoding="async">` +
    (note ? `<span class="guide-picture-note">${escape(note)}</span>` : '') +
    '</span>'
  );
};

// ---------------------------------------------------------------------------
// Tiles: a list of pictures, each with a name

/** Words under a tile's picture are at most this long: a name, not a text. */
const TILE_WORDS = 60;

/**
 * The part of a list item's line after its picture, when the item is a
 * tile: a picture shown on its own (not one in the line of text), alone
 * or as a link's only content, then at most a name's words, no other
 * picture and no hidden text. Null for any other item.
 */
function tileWordsFrom(inline: Token): number | null {
  const children = inline.children ?? [];
  let at = 0;
  while (children[at]?.type === 'text' && children[at]!.content.trim() === '') at++;
  const linked = children[at]?.type === 'link_open';
  const picture = children[linked ? at + 1 : at];
  if (picture?.type !== 'atlas_picture') return null;
  if (isInlinePicture((picture.meta as unknown as PictureMeta).shown)) return null;
  if (linked && children[at + 2]?.type !== 'link_close') return null;
  const rest = children.slice(linked ? at + 3 : at + 1);
  if (
    rest.some((token) => token.type === 'atlas_picture' || token.type.startsWith('hidden_text'))
  ) {
    return null;
  }
  return wordsOf(rest).length <= TILE_WORDS ? children.length - rest.length : null;
}

/**
 * A bulleted list of two items or more, each only a tile (see
 * {@link tileWordsFrom}), is a grid of tiles: the list gets the class
 * `guide-tiles`, and the words of each tile stand in a span of their own,
 * under its picture.
 */
function tiles(state: StateCore): void {
  const tokens = state.tokens;
  for (let open = 0; open < tokens.length; open++) {
    if (tokens[open]!.type !== 'bullet_list_open') continue;
    const close = closing(tokens, open);
    // Each item: its open, a paragraph (open, line, close), its close; nothing nested.
    const items: Token[] = [];
    let plain = true;
    for (let i = open + 1; i < close; i += 5) {
      const [item, paragraph, inline, end, itemEnd] = tokens.slice(i, i + 5);
      if (
        item?.type !== 'list_item_open' ||
        paragraph?.type !== 'paragraph_open' ||
        inline?.type !== 'inline' ||
        end?.type !== 'paragraph_close' ||
        itemEnd?.type !== 'list_item_close'
      ) {
        plain = false;
        break;
      }
      items.push(inline);
    }
    if (!plain || items.length < 2) continue;
    const starts = items.map(tileWordsFrom);
    if (starts.some((start) => start === null)) continue;
    tokens[open]!.attrJoin('class', 'guide-tiles');
    items.forEach((inline, i) => {
      const children = inline.children!;
      const start = starts[i]!;
      if (wordsOf(children.slice(start)) === '') return;
      const words = new state.Token('tile_words_open', 'span', 1);
      words.attrs = [['class', 'guide-tile-words']];
      inline.children = [
        ...children.slice(0, start),
        words,
        ...children.slice(start),
        new state.Token('tile_words_close', 'span', -1),
      ];
    });
    open = close;
  }
}

markdown.core.ruler.push('atlas_tiles', tiles);

// ---------------------------------------------------------------------------
// Hidden text: ||like this||

interface HiddenMeta {
  /** A `||` that opens (or closes) hidden part `part`. */
  hiddenMark?: { part: number; opens: boolean };
  /** A whole block inside hidden part `part`. */
  hiddenPart?: number;
}

const metaOf = (token: Token) => (token.meta ?? {}) as HiddenMeta;

/** The index of each token's partner (open with close), by nesting. */
function partners(tokens: readonly Token[]): Map<number, number> {
  const match = new Map<number, number>();
  const open: number[] = [];
  tokens.forEach((token, i) => {
    if (token.nesting === 1) open.push(i);
    else if (token.nesting === -1) {
      const start = open.pop();
      if (start !== undefined) {
        match.set(start, i);
        match.set(i, start);
      }
    }
  });
  return match;
}

/** Table parts are never hidden as a whole: hiding a cell would move the others. */
const TABLE_PARTS = /^(thead|tbody|tr|th|td)_open$/;

markdown.core.ruler.before('text_join', 'atlas_hidden_text', (state) => {
  const marks: { token: Token; block: number }[] = [];
  // Every `||` in text becomes a token of its own. Code and escaped bars
  // (`text_special` until text_join) are not text, so they do not count.
  state.tokens.forEach((block, b) => {
    if (block.type !== 'inline' || !block.children) return;
    const children: Token[] = [];
    for (const child of block.children) {
      if (child.type !== 'text' || !child.content.includes('||')) {
        children.push(child);
        continue;
      }
      const pieces = child.content.split('||');
      pieces.forEach((piece, i) => {
        if (i > 0) {
          const mark = new state.Token('text', '', 0);
          mark.content = '||';
          children.push(mark);
          marks.push({ token: mark, block: b });
        }
        if (piece !== '') {
          const text = new state.Token('text', '', 0);
          text.content = piece;
          children.push(text);
        }
      });
    }
    block.children = children;
  });
  if (marks.length < 2) return;

  // Bars pair up left to right; a last one alone stays text.
  const blockPartners = partners(state.tokens);
  let parts = 0;
  for (let m = 0; m + 1 < marks.length; m += 2) {
    const part = ++parts;
    const [open, close] = [marks[m]!, marks[m + 1]!];
    (open.token.meta as HiddenMeta | null) = { hiddenMark: { part, opens: true } };
    (close.token.meta as HiddenMeta | null) = { hiddenMark: { part, opens: false } };
    // Whole blocks between the two (a list, a code block) are hidden as
    // they are; the text of any other block on the way is wrapped below.
    let j = open.block + 1;
    while (j < close.block) {
      const token = state.tokens[j]!;
      const end = blockPartners.get(j);
      if (token.nesting === 1 && end !== undefined && end < close.block) {
        // A paragraph without tags (in a tight list) has no element to hide.
        if (!token.hidden && !TABLE_PARTS.test(token.type)) {
          (token.meta as HiddenMeta | null) = { ...metaOf(token), hiddenPart: part };
          token.attrSet('data-hidden-part', String(part));
          token.attrSet('hidden', '');
          j = end + 1;
          continue;
        }
      } else if (token.nesting === 0 && token.type !== 'inline') {
        (token.meta as HiddenMeta | null) = { ...metaOf(token), hiddenPart: part };
      }
      j++;
    }
  }

  // The text from a bar that opens to the bar that closes is wrapped in
  // spans that nest properly with what is around them, as many as needed.
  // The hidden part the text is in, as it goes from block to block.
  const open: { part: number | null } = { part: null };
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    const children = block.children;
    const match = partners(children);
    const closeAt = (from: number, which: number) => {
      const i = children.findIndex(
        (t, k) => k >= from && metaOf(t).hiddenMark?.part === which && !metaOf(t).hiddenMark!.opens,
      );
      return i < 0 ? Infinity : i;
    };
    const out: Token[] = [];
    let start = -1;
    let end = Infinity;
    let spanOpen = false;
    let linkAt = -1;
    if (open.part !== null) end = closeAt(0, open.part);
    const closeSpan = () => {
      if (!spanOpen) return;
      out.push(new state.Token('hidden_text_close', 'span', -1));
      spanOpen = false;
    };
    const openSpan = () => {
      if (spanOpen || open.part === null) return;
      const span = new state.Token('hidden_text_open', 'span', 1);
      span.attrs = [
        ['class', 'hidden-text'],
        ['data-hidden-part', String(open.part)],
        ['hidden', ''],
      ];
      out.push(span);
      spanOpen = true;
    };
    children.forEach((token, i) => {
      const mark = metaOf(token).hiddenMark;
      if (mark?.opens) {
        open.part = mark.part;
        start = i;
        end = closeAt(i, mark.part);
        const show = new state.Token('hidden_text_show', 'button', 0);
        show.meta = { hiddenShow: mark.part };
        // Never inside a link: the button goes before it.
        if (linkAt >= 0) out.splice(linkAt, 0, show);
        else out.push(show);
        return;
      }
      if (mark) {
        closeSpan();
        open.part = null;
        return;
      }
      if (token.type === 'link_open') linkAt = out.length;
      if (open.part !== null) {
        const partner = match.get(i);
        const leaves =
          (token.nesting === 1 && (partner === undefined || partner > end)) ||
          (token.nesting === -1 && (partner === undefined || partner < start));
        if (leaves) closeSpan();
        else openSpan();
      }
      out.push(token);
      if (token.type === 'link_close') linkAt = -1;
    });
    closeSpan();
    block.children = out;
  }

  // A paragraph that held only a bar that closes (after a hidden table or
  // list) shows nothing, so it is left out rather than left empty.
  state.tokens.forEach((block, b) => {
    const open = state.tokens[b - 1];
    const close = state.tokens[b + 1];
    if (
      block.type === 'inline' &&
      block.children?.length === 0 &&
      open?.type === 'paragraph_open' &&
      close?.type === 'paragraph_close' &&
      /^\s*\|\|\s*$/.test(block.content)
    ) {
      open.hidden = true;
      close.hidden = true;
    }
  });
});

markdown.renderer.rules.hidden_text_show = (tokens, index) => {
  const part = (tokens[index]!.meta as { hiddenShow: number }).hiddenShow;
  return `<button type="button" class="hidden-text-show" data-hidden-show="${part}">Show hidden text</button>`;
};

// Blocks without an element of their own to carry `hidden` are wrapped.
for (const rule of ['fence', 'code_block', 'hr'] as const) {
  const base =
    markdown.renderer.rules[rule] ??
    ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
  markdown.renderer.rules[rule] = (tokens, index, options, env, self) => {
    const html = base(tokens, index, options, env, self);
    const part = metaOf(tokens[index]!).hiddenPart;
    return part === undefined
      ? html
      : `<div class="hidden-text-block" data-hidden-part="${part}" hidden>${html}</div>`;
  };
}

const defaultLinkOpen =
  markdown.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  if ((token.meta as AppLinkMeta | null)?.appLink) return self.renderToken(tokens, index, options);
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, index, options, env, self);
};

/** HTML for a guide body. Safe to insert with `innerHTML`. */
export function renderGuideMarkdown(source: string, options: MarkdownOptions = {}): string {
  return markdown.render(source, { ...options });
}

/**
 * The words of a guide body as it reads before anything hidden is shown,
 * read with the renderer itself, so hidden text is left out exactly as the
 * page hides it: for searching pages and quoting a line of them.
 */
export function guideSearchText(source: string): string {
  const words: string[] = [];
  let hiddenBlocks = 0;
  for (const block of markdown.parse(source, {})) {
    if (hiddenBlocks > 0) {
      hiddenBlocks += block.nesting;
      continue;
    }
    if (block.attrGet('hidden') !== null) {
      // A whole block inside a hidden part; its close comes with it.
      hiddenBlocks = block.nesting === 1 ? 1 : 0;
      continue;
    }
    if (block.type === 'fence' || block.type === 'code_block') {
      if (metaOf(block).hiddenPart === undefined) words.push(block.content);
      continue;
    }
    if (block.type !== 'inline' || !block.children) continue;
    let hidden = 0;
    for (const token of block.children) {
      if (token.type === 'hidden_text_open') hidden++;
      else if (token.type === 'hidden_text_close') hidden--;
      else if (hidden > 0) continue;
      else if (token.type === 'text' || token.type === 'code_inline') words.push(token.content);
      else if (token.type === 'atlas_picture')
        words.push((token.meta as unknown as PictureMeta).alt);
      else if (token.type === 'softbreak' || token.type === 'hardbreak') words.push(' ');
    }
    words.push(' ');
  }
  return words.join('').replace(/\s+/g, ' ').trim();
}

/**
 * Shows the hidden part whose "Show hidden text" button an event happened
 * in, if it did: every piece of that part in `root` loses `hidden`, the
 * button goes, and the focus moves to the text. It stays shown until the
 * text is rendered again. Returns whether it acted.
 */
export function revealHiddenText(target: EventTarget | null, root: Element): boolean {
  if (!(target instanceof Element)) return false;
  const button = target.closest('[data-hidden-show]');
  const part = button?.getAttribute('data-hidden-show');
  if (!button || !root.contains(button) || !part || !/^\d+$/.test(part)) return false;
  const pieces = [...root.querySelectorAll(`[data-hidden-part="${part}"]`)];
  for (const piece of pieces) {
    piece.removeAttribute('hidden');
    piece.classList.add('hidden-text-shown');
  }
  button.remove();
  const first = pieces[0];
  if (first instanceof HTMLElement) {
    first.tabIndex = -1;
    first.focus({ preventScroll: true });
  }
  return true;
}

/** The content id of the in-app link an event happened in, if any. */
export function appLinkTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest('[data-atlas-target]')?.getAttribute('data-atlas-target') ?? null;
}

/** The section of its page the in-app link an event happened in names, if any. */
export function appLinkSection(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest('[data-atlas-target]')?.getAttribute('data-atlas-section') ?? null;
}
