import { PAGE_WIDTH_PIXELS } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import {
  LAYOUT_FRAME_WIDTH,
  LAYOUT_NOTE_ATTRIBUTES,
  LAYOUT_NOTES_SCRIPT,
  MAX_ARTICLE_SELECTORS,
  MAX_LAYOUT_PAGE_CHARS,
  MAX_READER_CHARS,
  pageLayoutRequestOf,
  layoutNoteAttributes,
  layoutNotesMark,
  readLayoutNote,
  readLayoutNotesMark,
  type LayoutNote,
} from './index';

describe('the notes of a page’s layout', () => {
  it('are read as written', () => {
    const notes: LayoutNote[] = [
      { hidden: 'display' },
      { hidden: 'box' },
      { box: { left: 0, top: -12, width: 980, height: 40 } },
      {
        box: { left: 16, top: 120, width: 300, height: 200 },
        flow: { form: 'row', wrap: true },
        look: { centred: true, framed: true, bold: false, italic: false, size: 1 },
      },
      { flow: { form: 'grid', tracks: [200, 200, 300] } },
      { flow: { form: 'columns', count: 3 } },
      { flow: { form: 'inline' } },
      { flow: { form: 'float' } },
      { flow: { form: 'column', wrap: false } },
      { look: { centred: false, framed: false, bold: true, italic: true, size: 1.5 } },
    ];
    for (const note of notes) expect(readLayoutNote(layoutNoteAttributes(note))).toEqual(note);
    expect(layoutNoteAttributes(notes[3]!)).toEqual({
      'data-atlas-box': '16 120 300 200',
      'data-atlas-flow': 'row wrap',
      'data-atlas-look': 'centred framed',
    });
    expect(layoutNoteAttributes(notes[9]!)).toEqual({ 'data-atlas-look': 'bold italic x1.5' });
    expect(readLayoutNote({ id: 'a', class: 'b' })).toBeNull();
  });

  it('leave out a value not in its form, so a page’s own attribute says nothing', () => {
    expect(
      readLayoutNote({
        [LAYOUT_NOTE_ATTRIBUTES.hidden]: 'yes',
        [LAYOUT_NOTE_ATTRIBUTES.box]: '1 2 3',
        [LAYOUT_NOTE_ATTRIBUTES.flow]: 'columns 1',
        [LAYOUT_NOTE_ATTRIBUTES.look]: 'loud x0 xx',
      }),
    ).toBeNull();
    expect(readLayoutNote({ [LAYOUT_NOTE_ATTRIBUTES.flow]: 'grid' })).toBeNull();
    expect(readLayoutNote({ [LAYOUT_NOTE_ATTRIBUTES.look]: 'framed shiny' })).toEqual({
      look: { centred: false, framed: true, bold: false, italic: false, size: 1 },
    });
  });

  it('mark the article with their version and the size of its text', () => {
    expect(readLayoutNotesMark('1 16')).toEqual({ version: 1, textSize: 16, cut: false });
    expect(readLayoutNotesMark('1 14.5 cut')).toEqual({ version: 1, textSize: 14.5, cut: true });
    expect(
      readLayoutNotesMark(layoutNotesMark({ version: 1, textSize: 13.3, cut: false })),
    ).toEqual({ version: 1, textSize: 13.5, cut: false });
    for (const value of [undefined, '', '1', 'one 16', '1 0', '1 16 trimmed']) {
      expect(readLayoutNotesMark(value)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The measuring step on a small stand-in of a laid-out document. Its real
// work, on a page a browser lays out, is tested in a browser
// (`apps/web/e2e/layoutNotes.spec.ts`).

interface Shape {
  name: string;
  attrs?: Record<string, string>;
  style?: Record<string, string>;
  rect?: [number, number, number, number];
  text?: string;
  children?: Shape[];
}

class FakeText {
  readonly nodeType = 3;
  nextSibling: FakeNode | null = null;
  constructor(readonly nodeValue: string) {}
}

type FakeNode = FakeElement | FakeText;

class FakeElement {
  readonly nodeType = 1;
  readonly localName: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  rect: [number, number, number, number];
  children: FakeElement[] = [];
  childNodes: FakeNode[] = [];
  parentElement: FakeElement | null = null;
  nextSibling: FakeNode | null = null;
  ownerDocument: FakeDocument;

  constructor(shape: Shape, document: FakeDocument) {
    this.localName = shape.name;
    this.attrs = { ...(shape.attrs ?? {}) };
    this.style = shape.style ?? {};
    this.rect = shape.rect ?? [0, 0, 100, 20];
    this.ownerDocument = document;
    if (shape.text) this.childNodes.push(new FakeText(shape.text));
    for (const child of shape.children ?? []) {
      const el = new FakeElement(child, document);
      el.parentElement = this;
      this.children.push(el);
      this.childNodes.push(el);
    }
    this.childNodes.forEach((node, i) => (node.nextSibling = this.childNodes[i + 1] ?? null));
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  getBoundingClientRect() {
    const [left, top, width, height] = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  getClientRects() {
    return this.style.display === 'none' ? [] : [this.getBoundingClientRect()];
  }

  setAttribute(name: string, value: string) {
    if (this.ownerDocument.live) throw new Error('The page itself was changed.');
    this.attrs[name] = value;
  }

  removeAttribute(name: string) {
    if (this.ownerDocument.live && name in this.attrs) throw new Error('The page was changed.');
    this.attrs = Object.fromEntries(Object.entries(this.attrs).filter(([key]) => key !== name));
  }

  all(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const names = [...selector.matchAll(/\[([\w-]+)\]/gu)].map((match) => match[1]!);
    if (names.length > 0) return this.all().filter((el) => names.some((name) => name in el.attrs));
    const tags = selector.split(',').map((part) => part.trim());
    return this.all().filter((el) => tags.includes(el.localName));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  copy(document: FakeDocument): FakeElement {
    return new FakeElement(this.shape(), document);
  }

  shape(): Shape {
    const text = this.childNodes.find((node): node is FakeText => node.nodeType === 3);
    return {
      name: this.localName,
      attrs: this.attrs,
      style: this.style,
      rect: this.rect,
      ...(text ? { text: text.nodeValue } : {}),
      children: this.children.map((child) => child.shape()),
    };
  }
}

class FakeDocument {
  readyState = 'complete';
  defaultView: unknown;
  sheets: { disabled: boolean; sheet: unknown }[] = [];
  constructor(readonly live: boolean) {
    this.defaultView = live
      ? {
          scrollX: 0,
          scrollY: 0,
          getComputedStyle: (el: FakeElement) => ({
            display: 'block',
            visibility: 'visible',
            overflowX: 'visible',
            overflowY: 'visible',
            fontSize: '16px',
            fontWeight: '400',
            fontStyle: 'normal',
            textAlign: 'start',
            backgroundColor: 'rgba(0, 0, 0, 0)',
            backgroundImage: 'none',
            columnCount: 'auto',
            columnWidth: 'auto',
            float: 'none',
            ...el.style,
          }),
        }
      : null;
  }
  get implementation() {
    return { createHTMLDocument: () => new FakeCopyDocument() };
  }
  querySelectorAll() {
    return this.sheets;
  }
}

class FakeCopyDocument extends FakeDocument {
  constructor() {
    super(false);
  }
  importNode(el: FakeElement) {
    return el.copy(this);
  }
}

/**
 * The step's function, as a page reader evaluates it, with the globals of a
 * page shadowed, so a step that reached for one instead of the article's own
 * document would fail here.
 */
function script(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function(
    'window',
    'document',
    'self',
    'globalThis',
    'fetch',
    'XMLHttpRequest',
    'navigator',
    `return (${LAYOUT_NOTES_SCRIPT});`,
  ) as () => unknown;
  return make();
}

function measure(shape: Shape, limits?: unknown, change?: (document: FakeDocument) => void) {
  const document = new FakeDocument(true);
  change?.(document);
  const article = new FakeElement(shape, document);
  const run = script() as (article: unknown, copy: unknown, limits: unknown) => FakeElement | null;
  const copy = run(article, null, limits);
  return { copy, article };
}

const ARTICLE: Shape = {
  name: 'div',
  attrs: { 'data-atlas-box': '1 1 1 1', 'data-atlas-look': 'framed' },
  rect: [100, 50, 900, 400],
  children: [
    {
      name: 'div',
      style: { display: 'flex' },
      rect: [100, 50, 900, 100],
      children: [
        { name: 'p', rect: [100, 50, 450, 100], text: 'Alder', style: { fontWeight: '700' } },
        { name: 'p', rect: [550, 50, 450, 100], text: 'Birch' },
      ],
    },
    { name: 'p', text: 'Words of the page, more of them than of any other size.' },
    { name: 'p', style: { display: 'none' }, children: [{ name: 'p', text: 'Not shown' }] },
  ],
};

describe('the measuring step', () => {
  it('is a function’s source, short enough for a page reader, that asks for nothing', () => {
    expect(LAYOUT_NOTES_SCRIPT.length).toBeLessThan(MAX_READER_CHARS / 4);
    expect(typeof script()).toBe('function');
    for (const word of [
      'fetch(',
      'XMLHttpRequest',
      'sendBeacon',
      'WebSocket',
      '.click(',
      '.focus(',
      'scrollTo',
      'scrollIntoView',
      'dispatchEvent',
      'localStorage',
      'sessionStorage',
      'cookie',
      'cloneNode',
      'appendChild',
      'window.',
      'document.',
      '\u2014',
    ]) {
      expect(LAYOUT_NOTES_SCRIPT, word).not.toContain(word);
    }
  });

  it('notes the copy, never the page, and takes off notes the page had', () => {
    const { copy, article } = measure(ARTICLE);
    expect(article.attrs).toEqual(ARTICLE.attrs);
    expect(copy!.attrs).toEqual({ 'data-atlas-layout': '1 16', 'data-atlas-box': '0 0 900 400' });
    const [row, words, hidden] = copy!.children;
    expect(row!.attrs).toEqual({ 'data-atlas-box': '0 0 900 100', 'data-atlas-flow': 'row' });
    expect(row!.children.map((p) => p.attrs)).toEqual([
      { 'data-atlas-box': '0 0 450 100', 'data-atlas-look': 'bold' },
      { 'data-atlas-box': '450 0 450 100' },
    ]);
    expect(words!.attrs).toEqual({ 'data-atlas-box': '-100 -50 100 20' });
    // A part not shown: noted so, and nothing under it.
    expect(hidden!.attrs).toEqual({ 'data-atlas-hidden': 'display' });
    expect(hidden!.children[0]!.attrs).toEqual({});
  });

  it('measures the outer elements first and says when its bounds ran out', () => {
    const { copy } = measure(ARTICLE, { elements: 2 });
    expect(copy!.attrs['data-atlas-layout']).toBe('1 16 cut');
    expect(copy!.children[0]!.attrs['data-atlas-flow']).toBe('row');
    expect(copy!.children[1]!.attrs).toEqual({});
    expect(copy!.children[0]!.children[0]!.attrs).toEqual({});
  });

  it('leaves the copy without notes while style sheets load, on an error, or for an article not shown', () => {
    const loading = measure(ARTICLE, undefined, (document) => {
      document.readyState = 'interactive';
      document.sheets = [{ disabled: false, sheet: null }];
    });
    expect(loading.copy!.all().some((el) => Object.keys(el.attrs).length > 0)).toBe(false);
    expect(loading.copy!.attrs).toEqual({});
    const failing = measure(ARTICLE, undefined, (document) => {
      document.defaultView = {
        getComputedStyle: () => {
          throw new Error('No style.');
        },
      };
    });
    expect(failing.copy!.attrs).toEqual({});
    const unseen = measure({ ...ARTICLE, style: { display: 'none' } });
    expect(unseen.copy!.attrs).toEqual({});
    // No copy can be made: nothing.
    const run = script() as (article: unknown) => unknown;
    expect(run({})).toBeNull();
  });
});

describe('a page an importer asks the app to lay out', () => {
  const page = { html: '<!doctype html><p>Moss</p>', url: 'https://wiki.example.org/wiki/Moss' };

  it('is taken with its HTML, its address and the selectors of its article', () => {
    expect(pageLayoutRequestOf(page)).toEqual(page);
    expect(pageLayoutRequestOf({ ...page, article: ['#content', '.text'] })).toEqual({
      ...page,
      article: ['#content', '.text'],
    });
  });

  it('leaves out selectors past the limits, and refuses anything else', () => {
    const many = Array.from({ length: MAX_ARTICLE_SELECTORS + 3 }, (_, i) => `.part-${i}`);
    expect(pageLayoutRequestOf({ ...page, article: many })!.article).toHaveLength(
      MAX_ARTICLE_SELECTORS,
    );
    expect(
      pageLayoutRequestOf({ ...page, article: [3, '', 'x'.repeat(201), '#ok'] })!.article,
    ).toEqual(['#ok']);
    expect(pageLayoutRequestOf({ ...page, article: [] })).toEqual(page);
    for (const bad of [
      null,
      'html',
      { ...page, html: '' },
      { ...page, html: 'x'.repeat(MAX_LAYOUT_PAGE_CHARS + 1) },
      { ...page, url: 'file:///home/page.html' },
      { ...page, url: 'javascript:alert(1)' },
      { html: page.html },
    ]) {
      expect(pageLayoutRequestOf(bad)).toBeNull();
    }
  });

  it('is laid out as wide as a page shown at full width is laid out', () => {
    expect(LAYOUT_FRAME_WIDTH).toBe(PAGE_WIDTH_PIXELS.full);
  });
});
