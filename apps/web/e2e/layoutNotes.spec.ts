import { LAYOUT_NOTES_SCRIPT, readLayoutNote, readLayoutNotesMark } from '@atlas/importer-api';
import { expect, test, type Page } from '@playwright/test';

/**
 * The measuring step of `@atlas/importer-api` (`layoutNotes.ts`) in a real
 * browser: a made-up page laid out by a made-up style sheet, measured as an
 * importer's page reader measures a page in the app's window, and the
 * notes it writes on the copy of the article. It needs no app: the page is
 * set straight into the browser, and nothing is asked of any server.
 */

const STYLE = `
  body { margin: 0; font: 16px/20px sans-serif; background: #fff; }
  #article { width: 960px; padding: 0 20px; }
  .cards { display: flex; gap: 20px; }
  .cards > div { flex: 1 1 0; }
  .card { border: 1px solid #887; background: #f4f0e8; padding: 8px; }
  .card-title { font-size: 20px; line-height: 24px; font-weight: 700; }
  .tiles { display: grid; grid-template-columns: repeat(3, 200px); gap: 10px; }
  .three { column-count: 3; }
  .menu li { display: inline-block; margin-right: 12px; }
  .middle { text-align: center; }
  .folded { display: none; }
  .ghost { visibility: hidden; }
  .reader-only { position: absolute; width: 1px; height: 1px; overflow: hidden; }
  .banner { font-size: 28px; line-height: 32px; font-weight: bold; }
  .small { font-size: 12px; }
`;

const ARTICLE = `
  <div id="article" data-atlas-look="framed">
    <div class="cards" id="cards">
      <div class="card" id="card-1"><div class="card-title" id="title-1">Alder grove</div><p>Bark and moss.</p></div>
      <div class="card" id="card-2"><div class="card-title">Birch hollow</div><p>White trunks.</p></div>
      <div class="card" id="card-3"><div class="card-title">Cedar ridge</div><p>Red wood.</p></div>
    </div>
    <div class="tiles" id="tiles">
      <div class="card" id="tile-1">One</div><div class="card">Two</div><div class="card">Three</div>
      <div class="card" id="tile-4">Four</div><div class="card" id="tile-5">Five</div>
    </div>
    <ul class="three" id="three"><li>Moss</li><li>Fern</li><li>Reed</li><li>Rush</li><li>Sedge</li><li>Thyme</li></ul>
    <ul class="menu" id="menu"><li id="menu-1"><a href="#a">Paths</a></li><li><a href="#b">Wells</a></li><li><a href="#c">Gates</a></li></ul>
    <p class="middle" id="middle">Mind the <b>old</b> bridge.</p>
    <div class="folded" id="folded"><p id="inside-folded">Not shown at first.</p></div>
    <p class="ghost" id="ghost">Kept where it stands, unseen.</p>
    <span class="reader-only" id="reader-only">For screen readers.</span>
    <div class="banner" id="banner">The lantern keepers</div>
    <p id="body">Words of the page, the most of them in its own size. <span class="small">A small note.</span></p>
    <p id="body-2">More words of the page, in the size most of its words have.</p>
  </div>
`;

interface Measured {
  /** The page's own article, after the step, as it was before. */
  same: boolean;
  /** The notes of the copy, by the `id` of each element. */
  notes: Record<string, Record<string, string>>;
}

async function measure(page: Page): Promise<Measured> {
  return page.evaluate((script) => {
    const article = document.getElementById('article')!;
    const before = document.documentElement.outerHTML;
    // As a page reader runs it: evaluated in the page, on the page's article.
    const run = (0, eval)(`(${script})`) as (el: Element) => Element | null;
    const copy = run(article)!;
    const notes: Record<string, Record<string, string>> = {};
    for (const el of [copy, ...Array.from(copy.querySelectorAll('[id]'))]) {
      const attrs: Record<string, string> = {};
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('data-atlas-')) attrs[attr.name] = attr.value;
      }
      notes[el.id] = attrs;
    }
    return { same: document.documentElement.outerHTML === before, notes };
  }, LAYOUT_NOTES_SCRIPT);
}

test('notes on a copy of a made-up article what the browser made of each element', async ({
  page,
}) => {
  const asked: string[] = [];
  await page.route('**/*', (route) => {
    asked.push(route.request().url());
    return route.abort();
  });
  await page.setContent(
    `<!DOCTYPE html><html><head><style>${STYLE}</style></head><body>${ARTICLE}</body></html>`,
  );
  const { same, notes } = await measure(page);
  // The page is as it was, and nothing was asked of anyone.
  expect(same).toBe(true);
  expect(asked).toEqual([]);

  const note = (id: string) => readLayoutNote(notes[id] ?? {});
  // The article: its mark with the size of its text, and its box. A note the page wrote is gone.
  expect(readLayoutNotesMark(notes.article?.['data-atlas-layout'])).toEqual({
    version: 1,
    textSize: 16,
    cut: false,
  });
  expect(note('article')).toEqual({
    box: expect.objectContaining({ left: 0, top: 0, width: 1000 }),
  });

  // Cards side by side in a flex row: one line, three boxes beside each other, each framed.
  expect(note('cards')?.flow).toEqual({ form: 'row', wrap: false });
  const cards = ['card-1', 'card-2', 'card-3'].map((id) => note(id)!);
  expect(new Set(cards.map((card) => card.box!.top)).size).toBe(1);
  for (let i = 1; i < cards.length; i++) {
    expect(cards[i]!.box!.left).toBeGreaterThanOrEqual(
      cards[i - 1]!.box!.left + cards[i - 1]!.box!.width,
    );
  }
  expect(cards.every((card) => card.look?.framed)).toBe(true);
  // The card's title line: bold and larger than the article's text.
  expect(note('title-1')?.look).toMatchObject({ bold: true, size: 1.25 });

  // A grid of five cards in three columns: its tracks, two lines of boxes.
  expect(note('tiles')?.flow).toEqual({ form: 'grid', tracks: [200, 200, 200] });
  const [first, fourth, fifth] = ['tile-1', 'tile-4', 'tile-5'].map((id) => note(id)!.box!);
  expect(fourth!.left).toBe(first!.left);
  expect(fourth!.top).toBeGreaterThan(first!.top);
  expect(fifth!.top).toBe(fourth!.top);

  // A list in three columns, and one set in the line.
  expect(note('three')?.flow).toEqual({ form: 'columns', count: 3 });
  expect(note('menu')?.flow).toEqual({ form: 'inline' });
  expect(note('menu-1')?.box).toBeDefined();

  // A centred line, noted where it is centred.
  expect(note('middle')?.look).toMatchObject({ centred: true });

  // What is not shown: noted, and nothing under it.
  expect(note('folded')).toEqual({ hidden: 'display' });
  expect(notes['inside-folded']).toEqual({});
  expect(note('ghost')).toEqual({ hidden: 'visibility' });
  expect(note('reader-only')).toEqual({ hidden: 'box' });

  // A large bold line standing alone, and the article's own text.
  expect(note('banner')?.look).toMatchObject({ bold: true, size: 1.75 });
  expect(note('body')?.look).toMatchObject({ size: 0.75 });
  expect(note('body-2')?.look).toBeUndefined();
});

test('measures a frame’s document from outside it, and leaves a page whose sheets have not come', async ({
  page,
}) => {
  await page.route('**/*', (route) => route.abort());
  await page.setContent('<!DOCTYPE html><html><body><iframe id="frame"></iframe></body></html>');
  const fromOutside = await page.evaluate(
    ({ script, style, article }) => {
      const frame = document.getElementById('frame') as HTMLIFrameElement;
      const inner = frame.contentDocument!;
      inner.documentElement.innerHTML = `<head><style>${style}</style></head><body>${article}</body>`;
      const run = (0, eval)(`(${script})`) as (el: Element) => Element | null;
      const copy = run(inner.getElementById('article')!)!;
      return {
        flow: copy.querySelector('#cards')?.getAttribute('data-atlas-flow'),
        hidden: copy.querySelector('#folded')?.getAttribute('data-atlas-hidden'),
      };
    },
    { script: LAYOUT_NOTES_SCRIPT, style: STYLE, article: ARTICLE },
  );
  expect(fromOutside).toEqual({ flow: 'row', hidden: 'display' });

  // A page whose linked sheet has not loaded yet: the copy, without notes.
  const waiting = await page.evaluate((script) => {
    document.body.innerHTML = '<div id="article"><p>Words.</p></div>';
    Object.defineProperty(document, 'readyState', { value: 'interactive', configurable: true });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://sheets.example.invalid/never.css';
    document.head.append(link);
    const run = (0, eval)(`(${script})`) as (el: Element) => Element | null;
    const copy = run(document.getElementById('article')!)!;
    return copy.outerHTML;
  }, LAYOUT_NOTES_SCRIPT);
  expect(waiting).toBe('<div id="article"><p>Words.</p></div>');
});
