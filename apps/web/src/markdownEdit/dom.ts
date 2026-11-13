import { parseColour, TEXT_COLOUR_ATTRIBUTE } from '../textColour';
import { normalizeInline, type Inline, type LinkMark, type Marks } from './inline';
import { readPictureSize } from './pictureSize';

/**
 * The pieces of a text shown in an editable element, and read back from it
 * as it is typed in; and places in the text (as `pieceLength` counts them)
 * found in the element and back. A picture and a hard line break count as
 * one place; a line end inside the text is a `\n` in the element, which
 * shows it with `white-space: pre-wrap`.
 */

export interface ShownPicture {
  url: string;
  width?: number;
  height?: number;
}

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function attrs(values: Record<string, string | undefined>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escape(value)}"`)
    .join('');
}

function wrap(html: string, marks: Marks): string {
  let out = html;
  if (marks.strong) out = `<strong${attrs({ 'data-d': marks.strong })}>${out}</strong>`;
  if (marks.em) out = `<em${attrs({ 'data-d': marks.em })}>${out}</em>`;
  if (marks.s) out = `<s>${out}</s>`;
  if (marks.sup) out = `<sup>${out}</sup>`;
  if (marks.sub) out = `<sub>${out}</sub>`;
  if (marks.hidden) out = `<span class="md-hidden" data-md-hidden="">${out}</span>`;
  if (marks.colour) {
    out = `<span${attrs({ class: 'text-colour', [TEXT_COLOUR_ATTRIBUTE]: marks.colour })}>${out}</span>`;
  }
  if (marks.link) {
    const { href, title, auto } = marks.link;
    out = `<a${attrs({
      'data-md-link': '',
      'data-href': href,
      'data-title': title,
      'data-auto': auto === undefined ? undefined : String(auto),
      title: href,
    })}>${out}</a>`;
  }
  return out;
}

/** The HTML an editable element shows the pieces with. */
export function piecesToHtml(
  pieces: readonly Inline[],
  pictureOf: (src: string) => ShownPicture | null,
): string {
  let html = '';
  for (const piece of pieces) {
    switch (piece.kind) {
      case 'text':
        html += wrap(escape(piece.text), piece.marks);
        break;
      case 'code':
        html += wrap(`<code data-md-code="">${escape(piece.text)}</code>`, piece.marks);
        break;
      case 'soft':
        html += wrap('\n', piece.marks);
        break;
      case 'break':
        html += '<br data-md-break="">';
        break;
      case 'picture': {
        const shown = pictureOf(piece.src);
        const data = {
          'data-md-picture': '',
          'data-src': piece.src,
          'data-alt': piece.alt,
          'data-title': piece.title,
          contenteditable: 'false',
          tabindex: '-1',
        };
        const size = readPictureSize(piece.title);
        const style =
          size.kind === 'inline'
            ? `width:${size.width}px;height:${size.height}px`
            : size.kind === 'width'
              ? `width:${size.width}px`
              : undefined;
        html += wrap(
          shown
            ? `<img${attrs({
                ...data,
                src: shown.url,
                alt: piece.alt,
                class: size.kind === 'inline' ? 'md-picture md-picture-inline' : 'md-picture',
                style,
              })}>`
            : `<span${attrs({ ...data, class: 'md-picture md-picture-missing' })}>${escape(
                piece.alt || 'Picture',
              )}</span>`,
          piece.marks,
        );
        break;
      }
    }
  }
  // A last line end shows only with something after it.
  if (pieces.at(-1)?.kind === 'soft' || pieces.at(-1)?.kind === 'break') html += '<br>';
  return html;
}

const ZERO_WIDTH = /\u200b/g;

const isPicture = (node: Node): boolean =>
  node instanceof HTMLElement && node.hasAttribute('data-md-picture');
const isHardBreak = (node: Node) =>
  node instanceof HTMLElement && node.tagName === 'BR' && node.hasAttribute('data-md-break');

/** The pieces an editable element holds now. */
export function piecesFromDom(root: HTMLElement): Inline[] {
  const pieces: Inline[] = [];
  const walk = (node: Node, marks: Marks) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').replace(ZERO_WIDTH, '');
      text.split('\n').forEach((part, i) => {
        if (i > 0) pieces.push({ kind: 'soft', marks: { ...marks } });
        if (part)
          pieces.push({ kind: 'text', text: part.replace(/\u00a0/g, ' '), marks: { ...marks } });
      });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (isPicture(node)) {
      const title = node.dataset.title;
      pieces.push({
        kind: 'picture',
        src: node.dataset.src ?? '',
        alt: node.dataset.alt ?? '',
        ...(title !== undefined ? { title } : {}),
        marks: { ...marks },
      });
      return;
    }
    const tag = node.tagName;
    if (tag === 'BR') {
      if (isHardBreak(node)) pieces.push({ kind: 'break', marks: {} });
      return;
    }
    if (tag === 'CODE') {
      const text = node.textContent.replace(ZERO_WIDTH, '').replace(/\n/g, ' ');
      if (text) pieces.push({ kind: 'code', text, marks: { ...marks } });
      return;
    }
    const inner: Marks = { ...marks };
    if (tag === 'STRONG' || tag === 'B') inner.strong = node.dataset.d === '__' ? '__' : '**';
    else if (tag === 'EM' || tag === 'I') inner.em = node.dataset.d === '_' ? '_' : '*';
    else if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') inner.s = true;
    else if (tag === 'SUP') inner.sup = true;
    else if (tag === 'SUB') inner.sub = true;
    if (node.hasAttribute('data-md-hidden')) inner.hidden = true;
    const colour = parseColour(node.getAttribute(TEXT_COLOUR_ATTRIBUTE) ?? '');
    if (colour) inner.colour = colour;
    if (node.hasAttribute('data-md-link')) {
      const link: LinkMark = { href: node.dataset.href ?? '' };
      if (node.dataset.title !== undefined) link.title = node.dataset.title;
      if (node.dataset.auto === 'true') link.auto = true;
      else if (node.dataset.auto === 'bare') link.auto = 'bare';
      inner.link = link;
    }
    // A block a browser made (pasting, or Enter where it was not caught): a new line.
    const block = tag === 'DIV' || tag === 'P' || tag === 'LI';
    if (block && pieces.length > 0 && pieces.at(-1)?.kind !== 'soft') {
      pieces.push({ kind: 'soft', marks: {} });
    }
    node.childNodes.forEach((child) => {
      walk(child, inner);
    });
  };
  root.childNodes.forEach((child) => {
    walk(child, {});
  });
  // A link's text typed on past its end in a browser is still the link: as it is shown.
  return normalizeInline(pieces.filter((piece) => piece.kind !== 'text' || piece.text !== ''));
}

/** How many places a node holds. */
function lengthOf(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').replace(ZERO_WIDTH, '').length;
  }
  if (!(node instanceof HTMLElement)) return 0;
  if (isPicture(node) || isHardBreak(node)) return 1;
  if (node.tagName === 'BR') return 0;
  let sum = 0;
  node.childNodes.forEach((child) => {
    sum += lengthOf(child);
  });
  return sum;
}

/** The place in the text of a place in the element (as a selection gives it). */
export function offsetIn(root: HTMLElement, node: Node, offset: number): number {
  // Inside a picture: at the picture.
  let target = node;
  let at = offset;
  for (let up: Node | null = node; up && up !== root; up = up.parentNode) {
    if (isPicture(up)) {
      target = up.parentNode!;
      at = Array.from(target.childNodes).indexOf(up as ChildNode);
    }
  }
  let count = 0;
  if (target.nodeType === Node.TEXT_NODE) {
    count = (target.textContent ?? '').slice(0, at).replace(ZERO_WIDTH, '').length;
  } else {
    for (let i = 0; i < at && i < target.childNodes.length; i++) {
      count += lengthOf(target.childNodes[i]!);
    }
  }
  for (let up: Node | null = target; up && up !== root; up = up.parentNode) {
    for (let before = up.previousSibling; before; before = before.previousSibling) {
      count += lengthOf(before);
    }
  }
  return count;
}

/** The place in the element of a place in the text. */
export function placeIn(root: HTMLElement, at: number): { node: Node; offset: number } {
  let left = at;
  const find = (parent: Node): { node: Node; offset: number } | null => {
    for (let i = 0; i < parent.childNodes.length; i++) {
      const child = parent.childNodes[i]!;
      const length = lengthOf(child);
      if (child.nodeType === Node.TEXT_NODE) {
        if (left <= length) return { node: child, offset: left };
      } else if (child instanceof HTMLElement && (isPicture(child) || isHardBreak(child))) {
        if (left === 0) return { node: parent, offset: i };
      } else if (left < length || (left === length && length > 0 && !child.nextSibling)) {
        const inner = find(child);
        if (inner) return inner;
      }
      left -= length;
    }
    return left <= 0 ? { node: parent, offset: parent.childNodes.length } : null;
  };
  return find(root) ?? { node: root, offset: root.childNodes.length };
}

/** The selection in an element, as places in the text; null when it is not in it. */
export function selectionIn(root: HTMLElement): [number, number] | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const start = offsetIn(root, range.startContainer, range.startOffset);
  const end = offsetIn(root, range.endContainer, range.endOffset);
  return start <= end ? [start, end] : [end, start];
}

/** Selects from `start` to `end` in an element. */
export function selectIn(root: HTMLElement, start: number, end: number = start): void {
  const selection = root.ownerDocument.getSelection();
  if (!selection) return;
  const from = placeIn(root, start);
  const to = end === start ? from : placeIn(root, end);
  const range = root.ownerDocument.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}
