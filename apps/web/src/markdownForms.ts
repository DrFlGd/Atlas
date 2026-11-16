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
 *   narrow (see `guides.css`).
 * - A card: a `div.guide-card`, its first block, when a heading, its title
 *   bar (`guide-card-title`); the heading is a heading of the page.
 * - A row: a `div.guide-row`, whose lists are set on one line; a list whose
 *   every item starts with a small picture is `guide-row-pictures`.
 * - Columns: a `div.guide-columns` with the class `guide-columns-2` to
 *   `guide-columns-6`; a list in it whose every item is one line that
 *   starts with a small picture (an icon and its name) is
 *   `guide-columns-pictures`, its pictures beside their words.
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
  open.meta = { form: form.form } satisfies FormMeta;
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

/**
 * A card's first block, when a heading, is its title bar; a list in a row
 * whose every item starts with a small picture shows the pictures, not dots;
 * a list in columns whose every item is a line that starts with a small
 * picture shows each picture beside its words, for a bullet.
 */
const formParts =
  (small: (picture: Token) => boolean) =>
  (state: StateCore): void => {
    const tokens = state.tokens;
    tokens.forEach((token, i) => {
      if (token.type !== 'form_open') return;
      const form = (token.meta as unknown as FormMeta).form;
      if (form === 'card' && tokens[i + 1]?.type === 'heading_open') {
        tokens[i + 1]!.attrJoin('class', 'guide-card-title');
      }
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
