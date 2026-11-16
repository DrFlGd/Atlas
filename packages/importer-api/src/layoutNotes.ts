/**
 * Notes of a page's layout, as a browser laid it out. Most sites lay their
 * pages out with style sheets, so a page's HTML alone does not say which
 * blocks stand side by side, which are framed, flowed in columns, centred
 * or hidden. Where a page is open in a real browser view (an importer's
 * readers in the app's window, "In a window" and "As I browse"), the
 * measuring step {@link LAYOUT_NOTES_SCRIPT} notes on a copy of the page's
 * article what the browser made of each element, as `data-atlas-*`
 * attributes. The notes travel with the copy of the page, so a page saved
 * with them is converted again ("Build again from saved pages") with the
 * same notes, and nothing is asked of the site.
 *
 * The step reads only geometry and computed style. It changes nothing in
 * the page: it measures the page's own elements and writes on their copies
 * (a copy it makes in a document of its own, which loads nothing and runs
 * nothing, unless the caller hands it a fresh copy), makes no requests,
 * presses, scrolls or focuses nothing, and stores nothing. It works on any
 * document handed to it, through the element's own document and window,
 * so a parent can measure a frame's document from outside. It is bounded
 * ({@link MAX_LAYOUT_NOTES} elements, {@link LAYOUT_NOTES_MS} ms, both lower
 * when the caller asks) and measures the outer elements first, so a page
 * too large for the bounds has its outer layout noted and its inner parts
 * not; any error leaves the copy without notes.
 *
 * The notes (each value compact, numbers in CSS pixels, rounded):
 *
 * - `data-atlas-layout="1 16"` on the copy of the article itself: the
 *   version of the notes and the size of the article's text (the size most
 *   of its characters have), with ` cut` after them when the bounds ran
 *   out before every element was measured. Notes are present only where
 *   this mark is.
 * - `data-atlas-hidden="display"` (or `visibility`, or `box`) on an
 *   element the page does not show: `display: none`, `visibility: hidden`,
 *   or no box to show anything in (less than 2 pixels wide or tall with its
 *   overflow cut, or wholly above or left of the page). Nothing under it is
 *   noted.
 * - `data-atlas-box="left top width height"` on each element shown that is
 *   a box of its own (not a line's word or link, nor a table's row or
 *   group), relative to the article's top left.
 * - `data-atlas-flow` where an element lays its children out other than
 *   one under another: `row` or `column` (a flex box, with ` wrap` when it
 *   wraps), `grid 200 200 200` (a grid and the widths of its columns),
 *   `columns 3` (text flowed in that many columns), `inline` (a list whose
 *   items, or boxes whose children, are set in the line) or `float` (two or
 *   more children floated).
 * - `data-atlas-look`, words for what the element shows: `centred` (its
 *   text set in the middle, where that starts or where it holds text of
 *   its own), `framed` (a border all round, or a background unlike what is
 *   behind it), and for an element that holds text of its own (its words,
 *   and those of the elements of its lines): `bold` and `italic` when all
 *   of that text is, and `x1.5` for its size against the article's text
 *   (the smallest of its text, noted when 10% or more larger or smaller).
 *
 * An app or importer without notes reads a page as before, and one that
 * does not know them sees attributes it does not use.
 */

/** The version of the notes {@link LAYOUT_NOTES_SCRIPT} writes. */
export const LAYOUT_NOTES_VERSION = 1;

/** The most elements the measuring step notes by default (a caller may ask for fewer). */
export const MAX_LAYOUT_NOTES = 5000;

/** How long the measuring step measures by default, in milliseconds (a caller may ask for less). */
export const LAYOUT_NOTES_MS = 400;

/** The attributes of the notes, by what they say. */
export const LAYOUT_NOTE_ATTRIBUTES = {
  layout: 'data-atlas-layout',
  box: 'data-atlas-box',
  hidden: 'data-atlas-hidden',
  flow: 'data-atlas-flow',
  look: 'data-atlas-look',
} as const;

/** An element's box, relative to the article's top left, in CSS pixels. */
export interface LayoutNoteBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Why an element is not shown: `display: none`, `visibility: hidden`, or no box to show anything in. */
export type LayoutNoteHidden = 'display' | 'visibility' | 'box';

/** How an element lays its children out, when not one under another. */
export type LayoutNoteFlow =
  | { form: 'row' | 'column'; wrap: boolean }
  | { form: 'grid'; tracks: number[] }
  | { form: 'columns'; count: number }
  | { form: 'inline' }
  | { form: 'float' };

/** What an element shows of its text and frame. */
export interface LayoutNoteLook {
  centred: boolean;
  framed: boolean;
  bold: boolean;
  italic: boolean;
  /** Its text's size against the article's text (1 when the same, or not noted). */
  size: number;
}

/** What the notes say of one element. */
export interface LayoutNote {
  hidden?: LayoutNoteHidden;
  box?: LayoutNoteBox;
  flow?: LayoutNoteFlow;
  look?: LayoutNoteLook;
}

/** What the mark on the article says. */
export interface LayoutNotesMark {
  version: number;
  /** The size of the article's text, in CSS pixels. */
  textSize: number;
  /** The bounds ran out before every element was measured. */
  cut: boolean;
}

/** Attributes of an element as a reader of HTML gives them, by name. */
type Attributes = Readonly<Record<string, string | undefined>>;

const MARK = /^(\d{1,3}) (\d{1,3}(?:\.\d{1,2})?)( cut)?$/u;
const BOX = /^(-?\d{1,6}) (-?\d{1,6}) (\d{1,6}) (\d{1,6})$/u;
const FLOW =
  /^(?:(row|column)( wrap)?|grid((?: \d{1,5}){1,24})|columns (\d{1,2})|(inline)|(float))$/u;
const SIZE = /^x(\d{1,2}(?:\.\d{1,2})?)$/u;

/** The mark the measuring step writes on the article, read; null for none or one not in its form. */
export function readLayoutNotesMark(value: string | undefined): LayoutNotesMark | null {
  const match = MARK.exec(value?.trim() ?? '');
  if (!match) return null;
  const textSize = Number(match[2]);
  if (!(textSize > 0)) return null;
  return { version: Number(match[1]), textSize, cut: match[3] !== undefined };
}

/**
 * What the notes say of an element, from its attributes; null when it has
 * none. A value not in its form is left out, so a page's own attribute of
 * the same name says nothing it should not. Never throws.
 */
export function readLayoutNote(attributes: Attributes): LayoutNote | null {
  const note: LayoutNote = {};
  const hidden = attributes[LAYOUT_NOTE_ATTRIBUTES.hidden]?.trim();
  if (hidden === 'display' || hidden === 'visibility' || hidden === 'box') note.hidden = hidden;
  const box = BOX.exec(attributes[LAYOUT_NOTE_ATTRIBUTES.box]?.trim() ?? '');
  if (box) {
    note.box = {
      left: Number(box[1]),
      top: Number(box[2]),
      width: Number(box[3]),
      height: Number(box[4]),
    };
  }
  const flow = FLOW.exec(attributes[LAYOUT_NOTE_ATTRIBUTES.flow]?.trim() ?? '');
  if (flow) {
    if (flow[1]) note.flow = { form: flow[1] as 'row' | 'column', wrap: flow[2] !== undefined };
    else if (flow[3]) note.flow = { form: 'grid', tracks: flow[3].trim().split(' ').map(Number) };
    else if (flow[4]) {
      const count = Number(flow[4]);
      if (count >= 2) note.flow = { form: 'columns', count };
    } else note.flow = { form: flow[5] ? 'inline' : 'float' };
  }
  const words = (attributes[LAYOUT_NOTE_ATTRIBUTES.look] ?? '').trim().split(/\s+/u);
  const look: LayoutNoteLook = {
    centred: false,
    framed: false,
    bold: false,
    italic: false,
    size: 1,
  };
  let looks = false;
  for (const word of words) {
    if (word === 'centred' || word === 'framed' || word === 'bold' || word === 'italic') {
      look[word] = true;
      looks = true;
      continue;
    }
    const size = SIZE.exec(word);
    if (size && Number(size[1]) > 0) {
      look.size = Number(size[1]);
      looks = true;
    }
  }
  if (looks) note.look = look;
  return Object.keys(note).length > 0 ? note : null;
}

/** A note as the attributes the measuring step writes, for tests and pages made by hand. */
export function layoutNoteAttributes(note: LayoutNote): Record<string, string> {
  const out: Record<string, string> = {};
  if (note.hidden) out[LAYOUT_NOTE_ATTRIBUTES.hidden] = note.hidden;
  if (note.box) {
    const { left, top, width, height } = note.box;
    out[LAYOUT_NOTE_ATTRIBUTES.box] = [left, top, width, height].map(Math.round).join(' ');
  }
  const flow = note.flow;
  if (flow) {
    out[LAYOUT_NOTE_ATTRIBUTES.flow] =
      flow.form === 'row' || flow.form === 'column'
        ? `${flow.form}${flow.wrap ? ' wrap' : ''}`
        : flow.form === 'grid'
          ? `grid ${flow.tracks.map(Math.round).join(' ')}`
          : flow.form === 'columns'
            ? `columns ${flow.count}`
            : flow.form;
  }
  const look = note.look;
  if (look) {
    const words = (['centred', 'framed', 'bold', 'italic'] as const).filter((word) => look[word]);
    if (look.size !== 1) words.push(`x${Math.round(look.size * 100) / 100}` as never);
    if (words.length > 0) out[LAYOUT_NOTE_ATTRIBUTES.look] = words.join(' ');
  }
  return out;
}

/** The mark of the article as the measuring step writes it. */
export const layoutNotesMark = (mark: LayoutNotesMark): string =>
  `${mark.version} ${Math.round(mark.textSize * 2) / 2}${mark.cut ? ' cut' : ''}`;

/** Optional bounds a caller gives the measuring step, below the defaults. */
export interface LayoutNotesLimits {
  /** The most elements to note. */
  elements?: number;
  /** How long to measure, in milliseconds. */
  ms?: number;
}

/**
 * The measuring step, as plain JavaScript text (the source of a function),
 * for an importer's page scripts and the app alike:
 * `(<LAYOUT_NOTES_SCRIPT>)(article, copy?, limits?)`.
 *
 * `article` is an element of a document a browser has laid out (the page's
 * article, or its body). `copy` is optional: a deep copy of `article` made
 * just now and not changed since (`article.cloneNode(true)`, or the copy
 * of an element around it), whose elements match the article's one for
 * one; without it the step makes one in a document of its own, which
 * loads nothing. `limits` ({@link LayoutNotesLimits}) may lower the
 * bounds. It returns the copy with the notes (see the top of this file),
 * or without them when the page's style sheets are not all there yet, the
 * bounds left nothing, or anything goes wrong; null only when no copy
 * could be made. Notes the page itself had on the copy are taken off
 * first. It never throws.
 */
export const LAYOUT_NOTES_SCRIPT = String.raw`(article, given, limits) => {
  const NAMES = ['data-atlas-layout', 'data-atlas-box', 'data-atlas-hidden', 'data-atlas-flow', 'data-atlas-look'];
  const clear = (root) => {
    for (const el of [root, ...Array.from(root.querySelectorAll(NAMES.map((name) => '[' + name + ']').join(',')))]) {
      for (const name of NAMES) el.removeAttribute(name);
    }
  };
  let copy = given || null;
  try {
    if (!copy) copy = article.ownerDocument.implementation.createHTMLDocument('').importNode(article, true);
    clear(copy);
  } catch (error) {
    return copy;
  }
  const notes = [];
  let base = 16;
  let cut = false;
  try {
    const doc = article.ownerDocument;
    const view = doc && doc.defaultView;
    if (!view || doc.readyState === 'loading') return copy;
    // The layout is the page's own only once its style sheets are there.
    if (doc.readyState !== 'complete') {
      for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"]'))) {
        if (!link.disabled && !link.sheet) return copy;
      }
    }
    const clock = view.performance && typeof view.performance.now === 'function' ? () => view.performance.now() : () => Date.now();
    const most = Math.min(${MAX_LAYOUT_NOTES}, Math.max(1, Math.floor(Number(limits && limits.elements) || ${MAX_LAYOUT_NOTES})));
    const budget = Math.min(${LAYOUT_NOTES_MS}, Math.max(1, Number(limits && limits.ms) || ${LAYOUT_NOTES_MS}));
    const started = clock();
    const styles = new Map();
    const styleOf = (el) => {
      let style = styles.get(el);
      if (style === undefined) {
        style = view.getComputedStyle(el);
        styles.set(el, style);
      }
      return style;
    };
    const SKIP = /^(?:script|style|template|noscript|link|meta|br|wbr|head|title)$/;
    const LEAF = /^(?:svg|math|canvas|iframe|frame|object|embed|video|audio|img|picture|select|textarea|input|button)$/;
    const NO_BOX = /^(?:tbody|thead|tfoot|tr|colgroup|col)$/;
    const IN_LINE = /^inline-(?:block|flex|grid|table)$/;
    const CENTRE = /^(?:center|-webkit-center|-moz-center)$/;
    const centred = (style) => CENTRE.test(style.textAlign);
    const alpha = (colour) => {
      const text = String(colour || '').trim();
      if (!text || text === 'transparent') return 0;
      const parts = /^rgba?\(([^)]*)\)$/.exec(text);
      if (!parts) return 1;
      const values = parts[1].split(/[\s,\/]+/).filter(Boolean);
      if (values.length < 4) return 1;
      const last = values[3];
      return /%$/.test(last) ? parseFloat(last) / 100 : parseFloat(last);
    };
    const backdrops = new Map();
    const backdrop = (el) => {
      // The page's canvas, white unless the page says otherwise.
      if (!el || el.nodeType !== 1) return 'rgb(255, 255, 255)';
      if (backdrops.has(el)) return backdrops.get(el);
      const colour = styleOf(el).backgroundColor;
      const behind = alpha(colour) > 0.05 ? colour : backdrop(el.parentElement);
      backdrops.set(el, behind);
      return behind;
    };
    const edge = (style, side) =>
      parseFloat(style['border' + side + 'Width']) > 0 &&
      !/^(?:none|hidden)$/.test(style['border' + side + 'Style']) &&
      alpha(style['border' + side + 'Color']) > 0.05;
    const sizes = new Map();
    const ownText = (el, style) => {
      const text = { chars: 0, bold: 0, italic: 0, least: Infinity };
      let nodes = 0;
      const walk = (node, at) => {
        for (let child = node.firstChild; child && nodes < 400; child = child.nextSibling) {
          nodes += 1;
          if (child.nodeType === 3) {
            const chars = String(child.nodeValue || '').replace(/\s+/g, '').length;
            if (!chars) continue;
            const size = parseFloat(at.fontSize) || 16;
            text.chars += chars;
            if ((parseInt(at.fontWeight, 10) || 400) >= 600) text.bold += chars;
            if (/^(?:italic|oblique)/.test(at.fontStyle)) text.italic += chars;
            text.least = Math.min(text.least, size);
            sizes.set(size, (sizes.get(size) || 0) + chars);
          } else if (child.nodeType === 1 && !SKIP.test(child.localName)) {
            const inner = styleOf(child);
            if (inner.display === 'inline' && inner.visibility !== 'hidden' && inner.visibility !== 'collapse') walk(child, inner);
          }
        }
      };
      walk(el, style);
      return text;
    };
    const origin = article.getBoundingClientRect();
    const queue = [[article, copy]];
    for (let at = 0; at < queue.length; at += 1) {
      if (notes.length >= most || ((at & 31) === 0 && clock() - started > budget)) {
        cut = true;
        break;
      }
      const el = queue[at][0];
      const twin = queue[at][1];
      const name = el.localName;
      const style = styleOf(el);
      const display = style.display;
      const note = { twin, look: [] };
      if (display === 'none') note.hidden = 'display';
      else if (style.visibility === 'hidden' || style.visibility === 'collapse') note.hidden = 'visibility';
      else if (display !== 'inline' && display !== 'contents') {
        const rect = el.getBoundingClientRect();
        const cuts = (overflow) => overflow !== 'visible';
        // No box at all (inside a part the browser does not lay out), a box too small to show its
        // words with what overflows it cut (not one waiting for its pictures), or wholly off the page.
        if (
          el.getClientRects().length === 0 ||
          (!LEAF.test(name) &&
            ((rect.width < 2 && cuts(style.overflowX)) || (rect.height < 2 && cuts(style.overflowY))) &&
            !el.querySelector('img, picture, video, canvas, svg, iframe, object, embed')) ||
          rect.right + view.scrollX < 0 ||
          rect.bottom + view.scrollY < 0
        ) {
          note.hidden = 'box';
        } else {
          if (!NO_BOX.test(name)) {
            note.box = [rect.left - origin.left, rect.top - origin.top, rect.width, rect.height].map((n) => Math.round(n)).join(' ');
          }
          if (/flex$/.test(display)) {
            note.flow = (String(style.flexDirection).indexOf('column') === 0 ? 'column' : 'row') + (style.flexWrap && style.flexWrap !== 'nowrap' ? ' wrap' : '');
          } else if (/grid$/.test(display)) {
            const tracks = String(style.gridTemplateColumns || '').split(/\s+/).map(parseFloat).filter((n) => n > 0).slice(0, 24);
            if (tracks.length > 0) note.flow = 'grid ' + tracks.map((n) => Math.round(n)).join(' ');
          } else {
            const count = parseInt(style.columnCount, 10) || 0;
            const width = parseFloat(style.columnWidth) || 0;
            let columns = count;
            if (width > 0) {
              const gap = parseFloat(style.columnGap) || parseFloat(style.fontSize) || 16;
              const inner = rect.width - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
              const fit = Math.max(1, Math.floor((inner + gap) / (width + gap)));
              columns = count > 0 ? Math.min(count, fit) : fit;
            }
            if (columns > 1) note.flow = 'columns ' + Math.min(columns, 99);
            else if (!LEAF.test(name)) {
              const kids = Array.from(el.children).filter((kid) => !SKIP.test(kid.localName)).map(styleOf).filter((kid) => kid.display !== 'none');
              const own = Array.from(el.childNodes).some((node) => node.nodeType === 3 && String(node.nodeValue || '').trim());
              const list = /^(?:ul|ol|menu|dl)$/.test(name);
              if (kids.length >= 2 && !own && kids.every((kid) => IN_LINE.test(kid.display) || (list && kid.display === 'inline'))) note.flow = 'inline';
              else if (kids.filter((kid) => kid.float !== 'none').length >= 2) note.flow = 'float';
            }
          }
          const text = LEAF.test(name) ? null : ownText(el, style);
          if (text && text.chars > 0) note.text = text;
          const parent = el.parentElement;
          if (centred(style) && (el === article || !parent || !centred(styleOf(parent)) || (text && text.chars > 0))) note.look.push('centred');
          const large = rect.width >= 48 && rect.height >= 24;
          if (
            ['Top', 'Right', 'Bottom', 'Left'].every((side) => edge(style, side)) ||
            (large && style.backgroundImage && style.backgroundImage !== 'none') ||
            (alpha(style.backgroundColor) > 0.05 && style.backgroundColor !== backdrop(parent))
          ) {
            note.look.push('framed');
          }
        }
      }
      if (note.hidden || note.box || note.flow || note.text || note.look.length > 0) notes.push(note);
      if (note.hidden || LEAF.test(name)) continue;
      const kids = el.children;
      const twins = twin.children;
      if (kids.length !== twins.length) continue;
      for (let i = 0; i < kids.length; i += 1) {
        if (queue.length >= most * 4) {
          cut = true;
          break;
        }
        const kid = kids[i];
        if (!SKIP.test(kid.localName) && kid.localName === twins[i].localName) queue.push([kid, twins[i]]);
      }
    }
    let commonest = 0;
    for (const [size, chars] of sizes) {
      if (chars > commonest) {
        commonest = chars;
        base = size;
      }
    }
    if (commonest === 0) base = parseFloat(styleOf(article).fontSize) || 16;
  } catch (error) {
    return copy;
  }
  // An article the page does not show has no layout to note.
  if (notes.length === 0 || notes[0].twin !== copy || notes[0].hidden) return copy;
  try {
    copy.setAttribute('data-atlas-layout', '1 ' + Math.round(base * 2) / 2 + (cut ? ' cut' : ''));
    for (const note of notes) {
      const twin = note.twin;
      if (note.hidden) {
        twin.setAttribute('data-atlas-hidden', note.hidden);
        continue;
      }
      if (note.box) twin.setAttribute('data-atlas-box', note.box);
      if (note.flow) twin.setAttribute('data-atlas-flow', note.flow);
      const look = note.look;
      const text = note.text;
      if (text) {
        if (text.bold === text.chars) look.push('bold');
        if (text.italic === text.chars) look.push('italic');
        const ratio = Math.round((text.least / base) * 100) / 100;
        if (ratio >= 1.1 || ratio <= 0.9) look.push('x' + ratio);
      }
      if (look.length > 0) twin.setAttribute('data-atlas-look', look.join(' '));
    }
  } catch (error) {
    try {
      clear(copy);
    } catch (again) {
      // The copy stays as it is.
    }
  }
  return copy;
}`;
