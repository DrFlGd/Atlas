/**
 * The pure parts of the closed frame a saved page is laid out in (see
 * `frame.ts`): what of a page goes into the frame, how its style sheets are
 * made harmless, which sheets a page gets, and which attributes are notes.
 * No DOM here, so all of it is tested without a browser.
 *
 * Nothing that goes into the frame may run or fetch anything. The frame
 * itself forbids both (a sandbox without scripts, a policy that allows
 * nothing from the network); these rules take out, besides, everything
 * that would try: scripts, frames, objects, links, forms, event
 * attributes, the addresses of pictures and media, and every address in a
 * style sheet.
 */

/** The policy inside the frame: nothing from the network, styles only as the app sets them. */
export const FRAME_POLICY = "default-src 'none'; style-src 'unsafe-inline'";

/** The frame's own document, given as text: empty, with its policy first. */
export const FRAME_SHELL = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}"></head><body></body></html>`;

/** The size a picture with no size of its own is given, in CSS pixels. */
export const PICTURE_BOX = 24;

/** The attributes of the notes of a page's layout, and any other the app's own: `data-atlas-…`. */
export const isAtlasAttribute = (name: string): boolean =>
  name.toLowerCase().startsWith('data-atlas-');

// ---------------------------------------------------------------------------
// Elements and attributes

/** Elements taken out with all they hold: they run, load, send or show another page. */
const REMOVED = new Set([
  'script',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'portal',
  'fencedframe',
  'link',
  'base',
  'style',
]);

/** What becomes of an element of the page in the frame. */
export type ElementFate = 'keep' | 'remove' | 'div';

/**
 * What becomes of an element, by its name (lower case) and its attributes:
 * removed with what it holds (`style` blocks too, whose text the frame
 * takes as a sheet), a form made a plain `div` with the same content (the
 * form is gone, what it shows stays), or kept. A `meta` that acts on the
 * document (`http-equiv`) is removed; others say nothing to the layout.
 */
export function elementFate(name: string, attribute: (name: string) => string | null): ElementFate {
  const lower = name.toLowerCase();
  if (REMOVED.has(lower)) return 'remove';
  if (lower === 'meta' && attribute('http-equiv') !== null) return 'remove';
  if (lower === 'form') return 'div';
  return 'keep';
}

/** Attributes that name something to load, send to or open, whatever element has them. */
const LOADING = new Set([
  'src',
  'srcset',
  'srcdoc',
  'lowsrc',
  'dynsrc',
  'poster',
  'background',
  'data',
  'action',
  'formaction',
  'ping',
  'codebase',
  'archive',
  'longdesc',
  'manifest',
  'imagesrcset',
  'attributionsrc',
]);

/** Elements whose `href` (or `xlink:href`) is loaded, not followed: SVG's pictures and uses. */
const LOADS_HREF = new Set(['image', 'use', 'feimage', 'script', 'pattern', 'filter', 'tref']);

/**
 * Whether an attribute of an element goes into the frame: never an event
 * (`on…`), an address of something loaded (a picture, a medium, a form's
 * target), an `href` an SVG element would load (one inside the page,
 * `#…`, is kept), the element's own `style` (the frame sets it itself,
 * made harmless) or an attribute of the app's own (`data-atlas-…`, which a
 * page may carry, but whose notes only the app writes).
 */
export function keptAttribute(element: string, name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('on') || lower === 'style' || isAtlasAttribute(lower)) return false;
  if (LOADING.has(lower)) return false;
  if (lower === 'href' || lower === 'xlink:href') {
    return !LOADS_HREF.has(element.toLowerCase()) || value.trim().startsWith('#');
  }
  return true;
}

/** A length the page states for a picture: a number of pixels, or a length in CSS. */
const LENGTH = /^\s*\d+(?:\.\d+)?\s*(?:px)?\s*$/iu;
const declared = (style: string, property: 'width' | 'height') =>
  new RegExp(`(?:^|[;{\\s])${property}\\s*:`, 'iu').test(style);

/**
 * What a picture is given in place of its file, which the frame never
 * loads: its `width` and `height` attributes and the size its own style
 * states stay, so a picture of a stated size keeps its box; a side the page
 * states nowhere is {@link PICTURE_BOX} pixels. The answer is style to add
 * after the picture's own (empty when it states both).
 */
export function pictureBox(attributes: {
  width: string | null;
  height: string | null;
  style: string | null;
}): string {
  const style = attributes.style ?? '';
  const parts: string[] = [];
  for (const side of ['width', 'height'] as const) {
    const attribute = attributes[side];
    if (declared(style, side)) continue;
    if (attribute !== null && LENGTH.test(attribute)) continue;
    parts.push(`${side}: ${PICTURE_BOX}px`);
  }
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Style sheets

/** Whether `c` can be part of a CSS name. */
const nameChar = (c: string) => /[A-Za-z0-9_\-\u0080-￿]/u.test(c);

/**
 * A CSS name at `at` (`url`, `\75 rl`, `import`), its escapes read: the
 * name as it reads, and where it ends.
 */
function nameAt(css: string, at: number): { name: string; end: number } {
  let name = '';
  let i = at;
  while (i < css.length) {
    const c = css[i]!;
    if (c === '\\' && i + 1 < css.length && css[i + 1] !== '\n') {
      const hex = /^[0-9a-fA-F]{1,6}\s?/u.exec(css.slice(i + 1, i + 8));
      if (hex) {
        const code = parseInt(hex[0], 16);
        name += code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
        i += 1 + hex[0].length;
      } else {
        name += css[i + 1]!;
        i += 2;
      }
      continue;
    }
    if (!nameChar(c)) break;
    name += c;
    i++;
  }
  return { name, end: i };
}

/** Where a string that starts at `at` (a quote) ends, past its closing quote. */
function stringEnd(css: string, at: number): number {
  const quote = css[at]!;
  let i = at + 1;
  while (i < css.length) {
    const c = css[i]!;
    if (c === '\\') i += 2;
    else if (c === quote || c === '\n') return i + 1;
    else i++;
  }
  return css.length;
}

/** Where the brackets opened at `at` (`(`) close, past the closing one; strings and comments skipped. */
function bracketsEnd(css: string, at: number): number {
  let depth = 0;
  let i = at;
  while (i < css.length) {
    const c = css[i]!;
    if (c === '"' || c === "'") {
      i = stringEnd(css, i);
      continue;
    }
    if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close < 0 ? css.length : close + 2;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return css.length;
}

/** Where an at-rule's prelude that starts at `at` ends: past its `;`, or at its block, or at the end. */
function statementEnd(css: string, at: number): number {
  let i = at;
  while (i < css.length) {
    const c = css[i]!;
    if (c === '"' || c === "'") i = stringEnd(css, i);
    else if (c === '(') i = bracketsEnd(css, i);
    else if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close < 0 ? css.length : close + 2;
    } else if (c === ';') return i + 1;
    else if (c === '{' || c === '}') return i;
    else i++;
  }
  return css.length;
}

/** Functions whose words are addresses to load: made empty, or `none`. */
const ADDRESS_FUNCTIONS: Record<string, string> = {
  url: 'url()',
  src: 'url()',
  'image-set': 'none',
  '-webkit-image-set': 'none',
};

/**
 * A style sheet's text with nothing in it that loads anything: every
 * `@import` taken out, every `url(…)` (and `src(…)`) made `url()`, every
 * `image-set(…)` made `none`, however the name is written (escaped, in
 * capitals). Comments and strings are read as such, so an address in one
 * is never taken for a rule. What is left is the sheet as it was. The frame
 * also removes, once a sheet is read, any value that still names an address.
 */
export function defangSheet(css: string): string {
  let out = '';
  let i = 0;
  let previous = '';
  while (i < css.length) {
    const c = css[i]!;
    if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      const end = close < 0 ? css.length : close + 2;
      out += css.slice(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = stringEnd(css, i);
      out += css.slice(i, end);
      previous = c;
      i = end;
      continue;
    }
    if (c === '@') {
      const { name, end } = nameAt(css, i + 1);
      if (name.toLowerCase() === 'import') {
        i = statementEnd(css, end);
        continue;
      }
      out += css.slice(i, end);
      previous = 'a';
      i = end;
      continue;
    }
    if ((nameChar(c) || c === '\\') && !nameChar(previous) && previous !== '\\') {
      const { name, end } = nameAt(css, i);
      const replacement = ADDRESS_FUNCTIONS[name.toLowerCase()];
      if (replacement !== undefined && css[end] === '(') {
        out += replacement;
        i = bracketsEnd(css, end);
        previous = ')';
        continue;
      }
      if (end > i) {
        out += css.slice(i, end);
        previous = css[end - 1]!;
        i = end;
        continue;
      }
    }
    out += c;
    previous = c;
    i++;
  }
  return out;
}

/** A style sheet the page names, in its order: one it links to, by address, or a block of its own. */
export type PageSheet = { address: string; media?: string } | { text: string; media?: string };

/** A sheet kept for a game, with its text (see `styles.rs` in the shell). */
export interface KeptSheetText {
  address?: string;
  text: string;
}

/** A sheet the frame is given, in order. */
export interface FrameSheet {
  text: string;
  media?: string;
}

/**
 * The sheets a page is laid out with, in the order the page has them: for
 * a page that links to sheets, those of them the game keeps, by address,
 * and its own blocks, each where the page has it; for a page that links to
 * none (as a page reader hands over its parts), every sheet the game keeps,
 * in the order they were kept, then its own blocks. The same text is given
 * once. Null when there is nothing to lay the page out with: the game keeps
 * no sheets, or none of those the page links to, so the page is read as it
 * was before (a page laid out without its sheets would say less than its
 * HTML does).
 */
export function sheetsFor(
  page: readonly PageSheet[],
  kept: readonly KeptSheetText[],
): FrameSheet[] | null {
  if (kept.length === 0) return null;
  const byAddress = new Map<string, string>();
  for (const sheet of kept) if (sheet.address) byAddress.set(sheet.address, sheet.text);
  const linked = page.filter((sheet) => 'address' in sheet);
  const out: FrameSheet[] = [];
  const given = new Set<string>();
  const give = (text: string, media?: string) => {
    if (given.has(text) || !text.trim()) return;
    given.add(text);
    out.push({ text, ...(media ? { media } : {}) });
  };
  if (linked.length > 0) {
    let found = 0;
    for (const sheet of page) {
      if ('address' in sheet) {
        const text = byAddress.get(sheet.address);
        if (text === undefined) continue;
        found++;
        give(text, sheet.media);
      } else {
        give(sheet.text, sheet.media);
      }
    }
    return found > 0 ? out : null;
  }
  for (const sheet of kept) give(sheet.text);
  for (const sheet of page) if ('text' in sheet) give(sheet.text, sheet.media);
  return out.length > 0 ? out : null;
}

/**
 * The sheets of a page saved as one file with its style sheets inside it,
 * for trying a site rules file on it (`SiteTrialRequest.layOut` in the
 * importer contract): its own blocks, in its order, with their media.
 * `linked` when the page links to a style sheet (kept beside it or on the
 * site, which the frame never has), `none` when it holds no rules of its
 * own: either way it is not laid out, as it would say less than its HTML.
 */
export function ownSheetsFor(page: readonly PageSheet[]): FrameSheet[] | 'linked' | 'none' {
  if (page.some((sheet) => 'address' in sheet)) return 'linked';
  const out: FrameSheet[] = [];
  const given = new Set<string>();
  for (const sheet of page) {
    if (!('text' in sheet) || !sheet.text.trim() || given.has(sheet.text)) continue;
    given.add(sheet.text);
    out.push({ text: sheet.text, ...(sheet.media ? { media: sheet.media } : {}) });
  }
  return out.length > 0 ? out : 'none';
}
