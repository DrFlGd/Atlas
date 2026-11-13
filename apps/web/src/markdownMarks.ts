import type { MarkdownIt, StateCore, StateInline, Token } from 'markdown-it';
import { parseColour, TEXT_COLOUR_ATTRIBUTE } from './textColour';

/**
 * Marks a guide's Markdown has beyond CommonMark and tables, read the same
 * way by the app's view (`markdown.ts`) and by the page editor
 * (`markdownEdit/inline.ts`), so the two never disagree on what a text holds:
 *
 * - Raised and lowered text: `^raised^` and `~lowered~` (a note's mark, a
 *   small tag after a name, a formula). As elsewhere, neither may hold a
 *   space or a line end that is not escaped: `^two\ words^`. A link, a
 *   picture or code inside may hold spaces as they always can. `~~` stays
 *   strikethrough, and `\^` and `\~` are the characters themselves.
 * - A line break inside a table cell, where Markdown has none: the exact
 *   text `<br>`. It is the only HTML a guide can hold, and only there; any
 *   other `<…>`, and `<br>` anywhere else, stays text, as raw HTML does.
 * - Coloured words: `[like this]{color=#b8714a}`, the colour `#` and three
 *   or six hexadecimal digits and nothing else, right after the closing
 *   bracket. The words may hold any other mark, a link among them, and a
 *   link's words may be coloured: `[[a page](url)]{color=#c33}`,
 *   `[[a page]{color=#c33}](url)`. Anything else in the braces, or a space
 *   before them, is no colour and stays text. The renderer writes the
 *   colour only as an attribute (see `textColour.ts`), which the page shows
 *   readable in both themes.
 */

const CARET = 0x5e;
const TILDE = 0x7e;
const BACKSLASH = 0x5c;
const BACKTICK = 0x60;
const BRACKET = 0x5b;
const BANG = 0x21;

const isSpace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

/**
 * Where the text from `from` that a mark holds ends: at the next `end`
 * character outside code, links and pictures, before any space or line end
 * that is not escaped; -1 when there is none.
 */
function markEnd(state: StateInline, from: number, end: number): number {
  const max = state.posMax;
  const oldPos = state.pos;
  let pos = from;
  let found = -1;
  while (pos < max) {
    const code = state.src.charCodeAt(pos);
    if (code === end) {
      found = pos;
      break;
    }
    if (code === BACKSLASH) {
      // An escaped character, an escaped space among them, is part of the text.
      pos += 2;
      continue;
    }
    if (isSpace(code)) break;
    if (
      code === BACKTICK ||
      code === BRACKET ||
      (code === BANG && state.src.charCodeAt(pos + 1) === BRACKET)
    ) {
      // Code, a link or a picture is passed over whole, spaces and all.
      state.pos = pos;
      state.md.inline.skipToken(state);
      pos = state.pos;
      continue;
    }
    pos++;
  }
  state.pos = oldPos;
  return found;
}

function scriptRule(marker: number, name: 'sup' | 'sub') {
  const markup = String.fromCharCode(marker);
  return (state: StateInline, silent: boolean): boolean => {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== marker) return false;
    // Not in validation mode, as the plugins this follows do: a mark is
    // only ever read where it stands.
    if (silent) return false;
    // `~~` is strikethrough; an empty mark is no mark.
    const next = state.src.charCodeAt(start + 1);
    if (next === marker || start + 1 >= state.posMax) return false;
    const end = markEnd(state, start + 1, marker);
    if (end < 0 || end === start + 1) return false;
    const max = state.posMax;
    state.pos = start + 1;
    state.posMax = end;
    const open = state.push(`${name}_open`, name, 1);
    open.markup = markup;
    state.md.inline.tokenize(state);
    const close = state.push(`${name}_close`, name, -1);
    close.markup = markup;
    state.pos = end + 1;
    state.posMax = max;
    return true;
  };
}

/** What follows the words of a coloured part: its colour. */
const COLOUR = /^\{color=(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})\}/u;

/** Coloured words, `[like this]{color=#b8714a}`. */
function colourRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== BRACKET) return false;
  // Not in validation mode either: a link's words are checked for links
  // inside them that way, and coloured words may stand in a link's words.
  if (silent) return false;
  const labelEnd = state.md.helpers.parseLinkLabel(state, start, false);
  if (labelEnd < 0 || labelEnd === start + 1) return false;
  const match = COLOUR.exec(state.src.slice(labelEnd + 1, state.posMax));
  const colour = match ? parseColour(match[1]!) : null;
  if (!match || !colour) return false;
  const max = state.posMax;
  state.pos = start + 1;
  state.posMax = labelEnd;
  const open = state.push('colour_open', 'span', 1);
  open.markup = '[';
  open.meta = { colour };
  state.md.inline.tokenize(state);
  const close = state.push('colour_close', 'span', -1);
  close.markup = `]${match[0]}`;
  state.pos = labelEnd + 1 + match[0].length;
  state.posMax = max;
  return true;
}

/** The colour of a `colour_open` token, as `#rrggbb`. */
export const colourOf = (token: Token): string => (token.meta as { colour: string }).colour;

/** The exact text that is a line break in a table cell. */
export const CELL_BREAK = '<br>';

/** Inside raised or lowered text an escaped space (`\ `) is a space; the backslash goes. */
function scriptSpaces(state: StateCore): void {
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    let depth = 0;
    for (const token of block.children) {
      if (token.type === 'sup_open' || token.type === 'sub_open') depth++;
      else if (token.type === 'sup_close' || token.type === 'sub_close') depth--;
      else if (depth > 0 && token.type === 'text_special' && token.markup === '\\') {
        token.content = '';
      }
    }
  }
}

/** `<br>` in the text of a table cell: a line break. */
function cellBreaks(state: StateCore): void {
  state.tokens.forEach((block, b) => {
    if (block.type !== 'inline' || !block.children) return;
    const before = state.tokens[b - 1]?.type;
    if (before !== 'td_open' && before !== 'th_open') return;
    if (!block.children.some((t) => t.type === 'text' && t.content.includes(CELL_BREAK))) return;
    const children: Token[] = [];
    for (const child of block.children) {
      if (child.type !== 'text' || !child.content.includes(CELL_BREAK)) {
        children.push(child);
        continue;
      }
      child.content.split(CELL_BREAK).forEach((piece, i) => {
        if (i > 0) {
          const line = new state.Token('hardbreak', 'br', 0);
          line.markup = CELL_BREAK;
          children.push(line);
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
}

/**
 * Adds the marks above to a parser, and how the colour is rendered. Core
 * rules run before `text_join`, where there is one.
 */
export function markdownMarks(md: MarkdownIt): void {
  md.inline.ruler.before('link', 'colour', colourRule);
  md.renderer.rules.colour_open = (tokens, index) =>
    `<span class="text-colour" ${TEXT_COLOUR_ATTRIBUTE}="${colourOf(tokens[index]!)}">`;
  md.renderer.rules.colour_close = () => '</span>';
  md.inline.ruler.after('emphasis', 'sup', scriptRule(CARET, 'sup'));
  md.inline.ruler.after('sup', 'sub', scriptRule(TILDE, 'sub'));
  md.core.ruler.after('inline', 'atlas_script_spaces', scriptSpaces);
  md.core.ruler.after('atlas_script_spaces', 'atlas_cell_breaks', cellBreaks);
}
