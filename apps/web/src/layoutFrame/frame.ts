import {
  LAYOUT_FRAME_HEIGHT,
  LAYOUT_FRAME_WIDTH,
  LAYOUT_NOTE_ATTRIBUTES,
  LAYOUT_NOTES_MS,
  LAYOUT_PAGE_MS,
  readLayoutNotesMark,
  type PageLayoutRequest,
} from '@atlas/importer-api';
import measure from 'virtual:atlas-layout-notes';
import { sheetAddress } from '../state/pageStyles';
import {
  FRAME_SHELL,
  defangSheet,
  elementFate,
  isAtlasAttribute,
  keptAttribute,
  pictureBox,
  sheetsFor,
  type FrameSheet,
  type KeptSheetText,
  type PageSheet,
} from './frameText';

/**
 * The closed frame the app lays a saved page out in, as a browser would
 * show it, without asking any site for anything (see
 * `ImportContext.layOut` in the importer contract, and `frameText.ts`).
 *
 * - The frame is an `iframe` of the app's own window, sandboxed without
 *   scripts (`allow-same-origin` only, so the app can measure it from
 *   outside), its document given as text (`srcdoc`) with a policy that
 *   allows nothing from the network. It is kept out of sight and out of
 *   the accessibility tree, `LAYOUT_FRAME_WIDTH` pixels wide, and removed
 *   when the pass is done.
 * - A page is parsed by the app's `DOMParser`, which runs and loads
 *   nothing, into a document of its own. The `data-atlas-…` attributes it
 *   has are removed: any notes in it are not the app's. A copy of it is
 *   made harmless (`frameText.ts`) and put into the frame, with the sheets
 *   the game keeps that the page links to and its own blocks, every address
 *   in them made empty, set as sheets the app builds itself, and each
 *   element's own style set the same way.
 * - The app's own measuring step (the code of `@atlas/importer-api`, built
 *   into the app) measures the copy in the frame from outside, from the
 *   page's article (the first element one of the importer's selectors finds)
 *   or its body, and the notes are written on the page's own elements,
 *   matched by their place in the page. The page goes back as its HTML
 *   written out again, with the notes.
 *
 * One page at a time, within `LAYOUT_PAGE_MS`; the app's window is given
 * its turn between the steps of a page.
 */

/** How laying one page out went. */
export type LaidOut =
  | { kind: 'noted'; html: string }
  | { kind: 'skipped'; reason: 'no-sheets' | 'time' | 'no-notes' | 'failed' };

/** The frame of one pass, for its pages one at a time. */
export interface LayoutFrame {
  layOut(request: PageLayoutRequest, kept: readonly KeptSheetText[]): Promise<LaidOut>;
  /** Removes the frame. */
  close(): void;
}

/** Each element's place in a copy of the page, so its notes find their way back. */
const PLACE = 'data-atlas-at';
const NOTE_NAMES: readonly string[] = Object.values(LAYOUT_NOTE_ATTRIBUTES);

/** Gives the app's window its turn. */
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The CSS of a value that still names something to load, once the browser has read it. */
const LOADS = /url\(|image-set\(/iu;

/** Takes out of declarations any value that still names an address. */
function scrubStyle(style: CSSStyleDeclaration): void {
  for (let i = style.length - 1; i >= 0; i--) {
    const name = style.item(i);
    if (LOADS.test(style.getPropertyValue(name))) style.removeProperty(name);
  }
}

/** The same in every rule of a sheet, at any depth; an `@import` left is deleted. */
function scrubRules(rules: CSSRuleList, remove: (at: number) => void): void {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i] as CSSRule & {
      style?: CSSStyleDeclaration;
      cssRules?: CSSRuleList;
      deleteRule?: (at: number) => void;
      href?: string;
    };
    // The frame's rules belong to its own window: they are known by what they have. Only an
    // import has an address.
    if (typeof rule.href === 'string') {
      remove(i);
      continue;
    }
    if (rule.style) scrubStyle(rule.style);
    if (rule.cssRules && rule.deleteRule) {
      const inner = rule;
      scrubRules(rule.cssRules, (at) => {
        inner.deleteRule?.(at);
      });
    }
  }
}

/** The address the page's links are read against: its `<base>`, else its own. */
function baseOf(page: Document, url: string): string {
  const href = page.querySelector('base[href]')?.getAttribute('href');
  if (!href) return url;
  try {
    return new URL(href, url).href;
  } catch {
    return url;
  }
}

/** The sheets a page names, in its order: those it links to, by address, and its blocks. */
function pageSheetsOf(page: Document, url: string): PageSheet[] {
  const base = baseOf(page, url);
  const sheets: PageSheet[] = [];
  for (const el of Array.from(page.querySelectorAll('link, style'))) {
    const media = el.getAttribute('media') ?? undefined;
    const withMedia = media ? { media } : {};
    if (el.localName === 'link') {
      const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/u);
      if (!rel.includes('stylesheet') || rel.includes('alternate')) continue;
      const address = sheetAddress(el.getAttribute('href') ?? '', base);
      if (address) sheets.push({ address, ...withMedia });
      continue;
    }
    const type = (el.getAttribute('type') ?? '').trim().toLowerCase();
    if (type && type !== 'text/css') continue;
    sheets.push({ text: el.textContent, ...withMedia });
  }
  return sheets;
}

/** The page written out as text again: its doctype and its elements. */
function written(page: Document): string {
  const doctype = page.doctype ? new XMLSerializer().serializeToString(page.doctype) : '';
  return `${doctype}${page.documentElement.outerHTML}`;
}

/** The element of `body` the first of `selectors` finds, if any. */
function articleOf(doc: Document, selectors: readonly string[] | undefined): Element | null {
  const body = doc.body;
  for (const selector of selectors ?? []) {
    try {
      const found = body.querySelector(selector);
      if (found) return found;
    } catch {
      // Not a selector: the next one.
    }
  }
  return null;
}

/**
 * The copy of a page made harmless for the frame (see `frameText.ts`), each
 * element marked with its place in the page; the style each element is
 * given, by place.
 */
function harmless(copy: Element, copies: readonly Element[]): Map<string, string> {
  const styles = new Map<string, string>();
  for (const el of copies) {
    if (el !== copy && !copy.contains(el)) continue;
    const name = el.localName;
    const fate = elementFate(name, (attribute) => el.getAttribute(attribute));
    if (fate === 'remove') {
      el.remove();
      continue;
    }
    const place = el.getAttribute(PLACE);
    let style = el.getAttribute('style');
    for (const attribute of Array.from(el.attributes)) {
      if (attribute.name === PLACE) continue;
      if (!keptAttribute(name, attribute.name, attribute.value)) {
        el.removeAttribute(attribute.name);
      }
    }
    if (
      name === 'img' ||
      (name === 'input' && el.getAttribute('type')?.toLowerCase() === 'image')
    ) {
      const box = pictureBox({
        width: el.getAttribute('width'),
        height: el.getAttribute('height'),
        style,
      });
      if (box) style = style ? `${style}; ${box}` : box;
    }
    if (style && place !== null) styles.set(place, defangSheet(style));
    if (fate === 'div') {
      const div = el.ownerDocument.createElement('div');
      for (const attribute of Array.from(el.attributes)) {
        div.setAttribute(attribute.name, attribute.value);
      }
      div.append(...Array.from(el.childNodes));
      el.replaceWith(div);
    }
  }
  return styles;
}

/**
 * Opens the frame in `host`'s window, out of sight; null when it cannot be
 * made (no frame came within `LAYOUT_PAGE_MS`).
 */
export async function openLayoutFrame(host: Document = document): Promise<LayoutFrame | null> {
  const frame = host.createElement('iframe');
  // No `allow-scripts`: nothing in the frame runs. Same origin only so the app can measure it.
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('tabindex', '-1');
  frame.inert = true;
  frame.style.cssText = [
    'position: fixed',
    'top: 0',
    `left: -${LAYOUT_FRAME_WIDTH + 2000}px`,
    `width: ${LAYOUT_FRAME_WIDTH}px`,
    `height: ${LAYOUT_FRAME_HEIGHT}px`,
    'border: 0',
    'visibility: hidden',
    'pointer-events: none',
  ].join('; ');
  frame.srcdoc = FRAME_SHELL;
  const ready = new Promise<boolean>((resolve) => {
    const check = () => {
      const doc = frame.contentDocument;
      if (doc?.readyState === 'complete' && doc.querySelector('meta[http-equiv]')) resolve(true);
    };
    frame.addEventListener('load', check);
    setTimeout(() => {
      resolve(false);
    }, LAYOUT_PAGE_MS);
  });
  host.body.append(frame);
  if (!(await ready)) {
    frame.remove();
    return null;
  }
  const view = frame.contentWindow as (Window & typeof globalThis) | null;
  const shown = frame.contentDocument;
  if (!view || !shown) {
    frame.remove();
    return null;
  }
  const doc: Document = shown;
  // The sheets of the pass, read once each: the frame's document stays the same from page to page.
  const built = new Map<string, CSSStyleSheet>();
  const sheetOf = (sheet: FrameSheet): CSSStyleSheet | null => {
    const key = `${sheet.media ?? ''}\n${sheet.text}`;
    const known = built.get(key);
    if (known) return known;
    try {
      const made = new view.CSSStyleSheet(sheet.media ? { media: sheet.media } : {});
      made.replaceSync(defangSheet(sheet.text));
      scrubRules(made.cssRules, (at) => {
        made.deleteRule(at);
      });
      built.set(key, made);
      return made;
    } catch {
      return null;
    }
  };
  const empty = () => {
    doc.adoptedStyleSheets = [];
    doc.documentElement.replaceChildren(doc.createElement('head'), doc.createElement('body'));
  };

  async function layOut(
    request: PageLayoutRequest,
    kept: readonly KeptSheetText[],
  ): Promise<LaidOut> {
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    try {
      // Parsed by the app, which runs and loads nothing of it.
      const page = new DOMParser().parseFromString(request.html, 'text/html');
      const originals = [
        page.documentElement,
        ...Array.from(page.documentElement.getElementsByTagName('*')),
      ];
      // Any notes the page has are not the app's.
      for (const el of originals) {
        for (const attribute of Array.from(el.attributes)) {
          if (isAtlasAttribute(attribute.name)) el.removeAttribute(attribute.name);
        }
      }
      const sheets = sheetsFor(pageSheetsOf(page, request.url), kept);
      if (!sheets) return { kind: 'skipped', reason: 'no-sheets' };
      await turn();
      if (elapsed() > LAYOUT_PAGE_MS) return { kind: 'skipped', reason: 'time' };

      const copy = page.documentElement.cloneNode(true) as Element;
      const copies = [copy, ...Array.from(copy.getElementsByTagName('*'))];
      if (copies.length !== originals.length) return { kind: 'skipped', reason: 'failed' };
      copies.forEach((el, place) => {
        el.setAttribute(PLACE, String(place));
      });
      const styles = harmless(copy, copies);
      await turn();
      if (elapsed() > LAYOUT_PAGE_MS) return { kind: 'skipped', reason: 'time' };

      // Into the frame: the copy, its sheets, and each element's own style, set by the app.
      doc.adoptedStyleSheets = sheets.flatMap((sheet) => sheetOf(sheet) ?? []);
      doc.replaceChild(doc.importNode(copy, true), doc.documentElement);
      for (const el of Array.from(doc.getElementsByTagName('*'))) {
        const place = el.getAttribute(PLACE);
        const style = place === null ? undefined : styles.get(place);
        const declarations = (el as Element & { style?: CSSStyleDeclaration }).style;
        if (style !== undefined && declarations) {
          declarations.cssText = style;
          scrubStyle(declarations);
        }
      }
      const root = articleOf(doc, request.article) ?? doc.body;
      const left = LAYOUT_PAGE_MS - elapsed();
      if (left < 1) {
        empty();
        return { kind: 'skipped', reason: 'time' };
      }
      // The app's own measuring step, on the frame's document, from outside it. The notes go on
      // the app's copy made harmless, which matches the frame's elements one for one, so that no
      // element given a style in the frame is copied again.
      const place = root.getAttribute(PLACE);
      const twin = place === null ? null : (copies[Number(place)] ?? null);
      const noted = measure(root, twin, { ms: Math.min(LAYOUT_NOTES_MS, left) });
      empty();
      if (!noted || !readLayoutNotesMark(noted.getAttribute(LAYOUT_NOTE_ATTRIBUTES.layout) ?? '')) {
        return { kind: 'skipped', reason: 'no-notes' };
      }
      // The notes, on the page's own elements.
      for (const el of [noted, ...Array.from(noted.getElementsByTagName('*'))]) {
        const place = el.getAttribute(PLACE);
        const original = place === null ? undefined : originals[Number(place)];
        if (!original) continue;
        for (const name of NOTE_NAMES) {
          const value = el.getAttribute(name);
          if (value !== null) original.setAttribute(name, value);
        }
      }
      return { kind: 'noted', html: written(page) };
    } catch {
      try {
        empty();
      } catch {
        // The frame is removed at the end of the pass.
      }
      return { kind: 'skipped', reason: 'failed' };
    }
  }

  return {
    layOut,
    close() {
      built.clear();
      frame.remove();
    },
  };
}
