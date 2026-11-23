import { layoutFormsIn, type LayoutForm } from '@atlas/schema';
import type { MarkdownIt, StateBlock, StateCore, Token } from 'markdown-it';

/**
 * The layout forms of a guide page (`::: side 1:3`, `::: card`, `::: row`,
 * `::: columns 3`, `::: centred`, each closed by `::: end`; see
 * `layoutForms.ts` in `@atlas/schema`, which reads the marker lines for
 * every reader of page text), as the page shows them. The blocks a form
 * holds are parsed as any blocks of the page, so every mark works inside.
 *
 * - Side by side: a `div.guide-side` of `div.guide-side-block`s, each
 *   with the class of its share of the width, `guide-share-1` to
 *   `guide-share-9`; the blocks fold one under another where the form is
 *   narrow (see `guides.css`). Blocks that hold only short lines (headings,
 *   short lines of words, lists of short one-line items: two lists side
 *   by side with their headings) are `guide-side-short`, and stay side by
 *   side down to a phone's width, as long as each has room for its lines.
 * - A card: a `div.guide-card`, its first block, when a heading, its title
 *   bar (`guide-card-title`); the heading is a heading of the page.
 * - A row: a `div.guide-row`, whose lists are set on one line; a list whose
 *   every item starts with a small picture is `guide-row-pictures`. An item
 *   of several lines (line breaks in it) keeps them, one under another in
 *   a `span.guide-row-lines` after the small pictures it starts with, so
 *   it is a block of lines with its pictures beside them.
 * - Columns: a `div.guide-columns` with the class `guide-columns-2` to
 *   `guide-columns-6`; a list in it whose every item is one line that
 *   starts with a small picture (an icon and its name) is
 *   `guide-columns-pictures`, its pictures beside their words. A list
 *   whose every item is one line fills the columns as a site's balanced
 *   columns of such lines do, by count: as many items in each column as
 *   the first holds (`guide-column-start` on the item that starts each
 *   column after the first), so an item that wraps in a narrower column
 *   moves none to another. As many lists as columns (and nothing else)
 *   are one list a column, the class on each list after the first.
 * - Centred: a `div.guide-centred`.
 *
 * Widths are classes only: no `style` attribute is written. A form hidden
 * as a whole by hidden text carries `hidden` as any block does.
 */

/** The parent type of the blocks inside a form, while they are parsed. */
const IN_FORM = 'atlas_form';

interface FormsEnv {
  atlasForms?: { src: string; byOpen: Map<number, LayoutForm> };
}

/** The forms of the text being parsed, by the line that opens each. */
function formsOf(state: StateBlock): Map<number, LayoutForm> {
  const env = state.env as FormsEnv;
  if (env.atlasForms?.src !== state.src) {
    const byOpen = new Map(layoutFormsIn(state.src).forms.map((form) => [form.open, form]));
    env.atlasForms = { src: state.src, byOpen };
  }
  return env.atlasForms.byOpen;
}

/** Meta of a form's tokens. */
export interface FormMeta {
  form: LayoutForm['form'];
  /** For columns: how many (1 for the other forms). */
  columns?: number;
}

function formRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  // Only at the top of the page or inside another form, never indented.
  const parent: string = state.parentType;
  if (parent !== 'root' && parent !== IN_FORM) return false;
  if (state.blkIndent !== 0 || state.tShift[startLine] !== 0) return false;
  if (state.src.charCodeAt(state.bMarks[startLine]!) !== 0x3a) return false;
  const form = formsOf(state).get(startLine);
  if (!form || form.end >= endLine) return false;
  if (silent) return true;

  const oldParent = state.parentType;
  const oldLineMax = state.lineMax;
  const open = state.push('form_open', 'div', 1);
  open.block = true;
  open.map = [startLine, form.end + 1];
  open.markup = ':::';
  open.info = form.form;
  open.meta = { form: form.form, columns: form.columns } satisfies FormMeta;
  const classes = ['guide-form', `guide-${form.form}`];
  if (form.form === 'side') classes.push(`guide-side-${form.shares.length}`);
  if (form.form === 'columns') classes.push(`guide-columns-${form.columns}`);
  open.attrs = [['class', classes.join(' ')]];

  (state as { parentType: string }).parentType = IN_FORM;
  const starts = [startLine, ...form.next];
  const ends = [...form.next, form.end];
  starts.forEach((from, i) => {
    const to = ends[i]!;
    let block: Token | null = null;
    if (form.form === 'side') {
      block = state.push('form_block_open', 'div', 1);
      block.block = true;
      block.map = [from, to + 1];
      block.attrs = [['class', `guide-side-block guide-share-${form.shares[i] ?? 1}`]];
    }
    state.lineMax = to;
    state.md.block.tokenize(state, from + 1, to);
    if (block) state.push('form_block_close', 'div', -1).block = true;
  });
  state.parentType = oldParent;
  state.lineMax = oldLineMax;

  const close = state.push('form_close', 'div', -1);
  close.block = true;
  close.markup = ':::';
  close.meta = { form: form.form } satisfies FormMeta;
  state.line = form.end + 1;
  return true;
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

/** Whether an item's line starts with a picture shown in the line of text. */
function startsWithSmallPicture(inline: Token | undefined, small: (picture: Token) => boolean) {
  const children = (inline?.children ?? []).filter(
    (token) =>
      !(token.type === 'text' && token.content.trim() === '') &&
      !token.type.startsWith('hidden_text'),
  );
  const first = children[0]?.type === 'link_open' ? children[1] : children[0];
  return first !== undefined && small(first);
}

/** Whether a list item holds only one line of words: a single paragraph a tight list does not show. */
function oneLine(tokens: readonly Token[], at: number): boolean {
  const inner = tokens.slice(at + 1, closing(tokens, at));
  return (
    inner.length === 3 &&
    inner[0]!.type === 'paragraph_open' &&
    inner[0]!.hidden &&
    inner[1]!.type === 'inline'
  );
}

/** Words of a short line, as the page shows them: at most this long. */
const SHORT_LINE = 60;

/** The words of inline tokens (pictures and line breaks aside). */
const wordsIn = (tokens: readonly Token[]): string =>
  tokens
    .map((token) =>
      token.type === 'text' || token.type === 'code_inline'
        ? token.content
        : token.children && token.type !== 'atlas_picture'
          ? wordsIn(token.children)
          : '',
    )
    .join('');

/** Whether an inline token is one short line: no line break, at most {@link SHORT_LINE} long. */
function shortLine(inline: Token | undefined): boolean {
  if (inline?.type !== 'inline') return false;
  const children = inline.children ?? [];
  return (
    !children.some((token) => token.type === 'hardbreak' || token.type === 'softbreak') &&
    wordsIn(children).replace(/\s+/gu, ' ').trim().length <= SHORT_LINE
  );
}

/**
 * Whether the tokens from `from` to `to` (not included) are blocks of
 * short lines only: headings, paragraphs of one short line, and lists
 * whose every item is one short line.
 */
function onlyShortLines(tokens: readonly Token[], from: number, to: number): boolean {
  let any = false;
  for (let i = from; i < to; i++) {
    const token = tokens[i]!;
    const end = closing(tokens, i);
    if (token.type === 'heading_open' || token.type === 'paragraph_open') {
      if (end !== i + 2 || !shortLine(tokens[i + 1])) return false;
    } else if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      for (let j = i + 1; j < end; j = closing(tokens, j) + 1) {
        if (tokens[j]!.type !== 'list_item_open' || !oneLine(tokens, j)) return false;
        if (!shortLine(tokens[j + 2])) return false;
      }
    } else {
      return false;
    }
    any = true;
    i = end;
  }
  return any;
}

/** The indices of the blocks at the top of a form (its lists, paragraphs, forms), in order. */
function topBlocks(tokens: readonly Token[], open: number): number[] {
  const end = closing(tokens, open);
  const out: number[] = [];
  for (let j = open + 1; j < end; j = closing(tokens, j) + 1) out.push(j);
  return out;
}

/** The items of the list opened at `list`, by the index of each item's open token. */
const itemsOf = (tokens: readonly Token[], list: number): number[] =>
  topBlocks(tokens, list).filter((at) => tokens[at]!.type === 'list_item_open');

/**
 * A list in columns fills them as balanced columns of lines do: when every
 * item is one line, the item that starts each column after the first is
 * marked; as many lists as columns are one list a column, each list after
 * the first marked. Anything else flows as the browser balances it.
 */
function columnStarts(tokens: readonly Token[], form: number, columns: number): void {
  const blocks = topBlocks(tokens, form);
  const isList = (at: number) =>
    tokens[at]!.type === 'bullet_list_open' || tokens[at]!.type === 'ordered_list_open';
  if (blocks.length === 0 || !blocks.every(isList)) return;
  if (blocks.length === columns) {
    for (const list of blocks.slice(1)) tokens[list]!.attrJoin('class', 'guide-column-start');
    return;
  }
  if (blocks.length !== 1) return;
  const items = itemsOf(tokens, blocks[0]!);
  if (items.length <= columns || !items.every((at) => oneLine(tokens, at))) return;
  const each = Math.ceil(items.length / columns);
  for (let at = each; at < items.length; at += each) {
    tokens[items[at]!]!.attrJoin('class', 'guide-column-start');
  }
}

/** Whether a token is a small picture, or a link holding only one (its open token). */
function smallPictureAt(children: readonly Token[], at: number, small: (t: Token) => boolean) {
  const token = children[at];
  if (token && small(token)) return 1;
  if (
    token?.type === 'link_open' &&
    children[at + 1] !== undefined &&
    small(children[at + 1]!) &&
    children[at + 2]?.type === 'link_close'
  ) {
    return 3;
  }
  return 0;
}

/**
 * An item of a row whose line has line breaks: the words after the small
 * pictures it starts with go in a `span.guide-row-lines`, one line under
 * another, the pictures beside them (a line of the pictures alone is no
 * line of its own). An item with hidden text is left as it is.
 */
function rowItemLines(state: StateCore, inline: Token, small: (t: Token) => boolean): void {
  const children = inline.children ?? [];
  if (!children.some((token) => token.type === 'hardbreak' || token.type === 'softbreak')) return;
  if (children.some((token) => token.type.startsWith('hidden_text'))) return;
  const blank = (token: Token | undefined) => token?.type === 'text' && token.content.trim() === '';
  let at = 0;
  for (;;) {
    if (blank(children[at])) {
      at++;
      continue;
    }
    const step = smallPictureAt(children, at, small);
    if (step === 0) break;
    at += step;
  }
  // The pictures, then the lines: no break or space before the first line.
  let first = at;
  while (
    blank(children[first]) ||
    children[first]?.type === 'hardbreak' ||
    children[first]?.type === 'softbreak'
  ) {
    first++;
  }
  if (first >= children.length) return;
  // The space between the pictures and the words is written once, before the lines.
  const lead = children[first]!;
  if (lead.type === 'text') lead.content = lead.content.trimStart();
  const open = new state.Token('row_lines_open', 'span', 1);
  open.attrs = [['class', 'guide-row-lines']];
  inline.children = [
    ...children.slice(0, at),
    ...(at > 0 ? [Object.assign(new state.Token('text', '', 0), { content: ' ' })] : []),
    open,
    ...children.slice(first),
    new state.Token('row_lines_close', 'span', -1),
  ];
}

/**
 * A card's first block, when a heading, is its title bar; a list in a row
 * whose every item starts with a small picture shows the pictures, not dots,
 * and an item of several lines keeps them beside its pictures; a list in
 * columns whose every item is a line that starts with a small picture shows
 * each picture beside its words, for a bullet, and a list of lines fills
 * its columns by count; blocks side by side of short lines only are marked
 * to stay side by side where narrow.
 */
const formParts =
  (small: (picture: Token) => boolean) =>
  (state: StateCore): void => {
    const tokens = state.tokens;
    tokens.forEach((token, i) => {
      if (token.type !== 'form_open') return;
      const { form, columns = 1 } = token.meta as unknown as FormMeta;
      if (form === 'card' && tokens[i + 1]?.type === 'heading_open') {
        tokens[i + 1]!.attrJoin('class', 'guide-card-title');
      }
      if (form === 'side') {
        const blocks = topBlocks(tokens, i).filter((at) => tokens[at]!.type === 'form_block_open');
        if (
          blocks.length >= 2 &&
          blocks.every((at) => onlyShortLines(tokens, at + 1, closing(tokens, at)))
        ) {
          token.attrJoin('class', 'guide-side-short');
        }
        return;
      }
      if (form === 'columns' && columns >= 2) columnStarts(tokens, i, columns);
      if (form !== 'row' && form !== 'columns') return;
      const end = closing(tokens, i);
      for (let j = i + 1; j < end; j++) {
        const list = tokens[j]!;
        if (list.level !== token.level + 1) continue;
        if (list.type !== 'bullet_list_open' && list.type !== 'ordered_list_open') continue;
        const listEnd = closing(tokens, j);
        const items = tokens
          .slice(j, listEnd)
          .flatMap((item, k) =>
            item.type === 'list_item_open' && item.level === list.level + 1 ? [j + k] : [],
          );
        const pictured = items.every(
          (at) =>
            (form === 'row' || oneLine(tokens, at)) &&
            startsWithSmallPicture(
              tokens.slice(at, closing(tokens, at)).find((t) => t.type === 'inline'),
              small,
            ),
        );
        if (items.length > 0 && pictured) {
          list.attrJoin('class', form === 'row' ? 'guide-row-pictures' : 'guide-columns-pictures');
        }
        if (form === 'row') {
          for (const at of items) {
            const inline = tokens.slice(at, closing(tokens, at)).find((t) => t.type === 'inline');
            if (inline) rowItemLines(state, inline, small);
          }
        }
        j = listEnd;
      }
    });
  };

const renderOpen = (
  tokens: Token[],
  index: number,
  _options: unknown,
  _env: unknown,
  self: {
    renderAttrs(token: Token): string;
  },
) => `<div${self.renderAttrs(tokens[index]!)}>\n`;

/**
 * Adds the layout forms to a parser. A row looks at pictures: `pictures`
 * names the core rule that makes them, and `small` says whether a token is
 * a picture shown in the line of text.
 */
export function markdownForms(
  md: MarkdownIt,
  { pictures, small }: { pictures: string; small: (token: Token) => boolean },
): void {
  md.block.ruler.before('fence', 'atlas_form', formRule);
  md.core.ruler.after(pictures, 'atlas_form_parts', formParts(small));
  md.renderer.rules.form_open = renderOpen;
  md.renderer.rules.form_block_open = renderOpen;
  md.renderer.rules.form_close = () => '</div>\n';
  md.renderer.rules.form_block_close = () => '</div>\n';
}
