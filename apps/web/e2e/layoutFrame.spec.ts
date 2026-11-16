import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readLayoutNote, readLayoutNotesMark } from '@atlas/importer-api';
import { expect, test, type Page } from '@playwright/test';
import { build, type Plugin } from 'vite';
import { layoutNotesPlugin } from '../tooling/layoutNotesPlugin.ts';

/**
 * The closed frame a saved page is laid out in (`src/layoutFrame/`), in a
 * real browser, under the desktop app's own content security policy (read
 * from the shell's `tauri.conf.json`): a made-up saved page and a made-up
 * style sheet that lays its cards side by side and its list in columns
 * and hides a block, with a script that would change the page, pictures
 * and addresses in the sheet that would be fetched, and notes the "site"
 * claims to have. The frame's code is built here as the app builds it; the
 * page is set straight into the browser, and every request is watched:
 * none may be made.
 */

const WEB = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = 'virtual:layout-frame-entry';
const ORIGIN = 'http://atlas.test';

/** The frame's code as the app has it, with `openLayoutFrame` on the window. */
async function frameScript(): Promise<string> {
  const entry: Plugin = {
    name: 'layout-frame-entry',
    resolveId: (id) => (id === ENTRY ? `\0${ENTRY}` : null),
    load: (id) =>
      id === `\0${ENTRY}`
        ? `import { openLayoutFrame } from ${JSON.stringify(`${WEB}src/layoutFrame/frame.ts`)};\nwindow.openLayoutFrame = openLayoutFrame;\n`
        : null,
  };
  const built = await build({
    configFile: false,
    root: WEB,
    logLevel: 'warn',
    plugins: [layoutNotesPlugin(), entry],
    define: { __ATLAS_DOWNLOADS__: 'true' },
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: ENTRY, output: { format: 'iife' } },
    },
  });
  const output = (Array.isArray(built) ? built[0]! : built) as { output: { code?: string }[] };
  return output.output[0]!.code!;
}

/** The desktop app's content security policy, as its shell sets it. */
async function appPolicy(): Promise<string> {
  const config = JSON.parse(
    await readFile(new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  ) as { app: { security: { csp: Record<string, string> } } };
  return Object.entries(config.app.security.csp)
    .map(([name, value]) => `${name} ${value}`)
    .join('; ');
}

const SHEET = `
@import url("https://styles.example.org/more.css");
@font-face { font-family: Fenleaf; src: url(https://fonts.example.org/fenleaf.woff2); }
body { margin: 0; font: 16px/20px sans-serif; background: #fff; }
#nav { font-size: 13px; }
#content { width: 960px; padding: 0 20px; }
.cards { display: flex; gap: 20px; }
.cards > .card { flex: 1 1 0; border: 1px solid #887; background: #f4f0e8 url(https://pictures.example.org/paper.png); padding: 8px; }
.card-title { font-size: 20px; line-height: 24px; font-weight: 700; }
.three { column-count: 3; }
.folded { display: none; }
.shots img { display: block; }
.banner { background-image: image-set("https://pictures.example.org/a.png" 1x); }
`;

const PAGE = `<!doctype html>
<html lang="en"><head><title>Fenmoor</title>
<meta http-equiv="refresh" content="0;url=https://elsewhere.example.org/">
<base href="https://wiki.example.org/">
<link rel="stylesheet" href="/skin.css">
<link rel="stylesheet" href="https://styles.example.org/not-kept.css">
<script src="https://scripts.example.org/tracker.js"></script>
<script>document.title = 'changed'; parent.document.title = 'changed'; document.body.classList.add('ran');</script>
</head>
<body onload="parent.document.title = 'changed'">
<div id="nav"><a href="/wiki/Main">Main</a></div>
<div id="content" data-atlas-layout="1 99">
  <h1>Fenmoor</h1>
  <div class="cards" id="cards" data-atlas-flow="column">
    <div class="card" id="card-1"><div class="card-title">Alder grove</div><p>Bark and moss.</p></div>
    <div class="card" id="card-2"><div class="card-title">Birch hollow</div><p>White trunks.</p></div>
    <div class="card" id="card-3"><div class="card-title">Cedar ridge</div><p>Red wood.</p></div>
  </div>
  <ul class="three" id="three"><li>Moss</li><li>Fern</li><li>Reed</li><li>Rush</li><li>Sedge</li><li>Thyme</li></ul>
  <div class="folded" id="folded"><p>Not shown at first.</p></div>
  <p id="said" data-atlas-hidden="display">Words the site says are hidden, which it shows.</p>
  <p class="shots"><img id="sized" src="https://pictures.example.org/heron.png" width="120" height="80" alt="A heron">
  <img id="unsized" src="https://pictures.example.org/reed.png" srcset="https://pictures.example.org/reed-2x.png 2x" alt="Reeds"></p>
  <div class="banner" id="banner" style="background: url(https://pictures.example.org/inline.png); height: 40px">Banner</div>
  <video poster="https://pictures.example.org/poster.png"><source src="https://media.example.org/clip.webm"></video>
  <iframe src="https://elsewhere.example.org/embed"></iframe>
  <object data="https://elsewhere.example.org/thing.swf"></object>
  <form action="https://forms.example.org/send"><input name="q"></form>
  <svg width="10" height="10"><image href="https://pictures.example.org/drawing.png" width="10" height="10"/></svg>
</div>
</body></html>`;

const KEPT = [{ address: 'https://wiki.example.org/skin.css', text: SHEET }];

interface Laid {
  kind: string;
  reason?: string;
  html?: string;
  title: string;
  frames: number;
  frameWhileOpen: Record<string, string | null>;
}

async function layOut(page: Page, kept: typeof KEPT, article?: string[]): Promise<Laid> {
  return page.evaluate(
    async ({ html, kept, article }) => {
      type Open = (host?: Document) => Promise<{
        layOut(
          request: unknown,
          kept: unknown,
        ): Promise<{ kind: string; html?: string; reason?: string }>;
        close(): void;
      } | null>;
      const open = (window as unknown as { openLayoutFrame: Open }).openLayoutFrame;
      const frame = await open(document);
      if (!frame) throw new Error('No frame.');
      const shown = document.querySelector('iframe')!;
      const frameWhileOpen = Object.fromEntries(
        ['sandbox', 'aria-hidden', 'tabindex', 'srcdoc', 'src'].map((name) => [
          name,
          name === 'srcdoc'
            ? String(shown.getAttribute(name)?.includes("default-src 'none'"))
            : shown.getAttribute(name),
        ]),
      );
      Object.assign(frameWhileOpen, {
        inert: String(shown.inert),
        visibility: getComputedStyle(shown).visibility,
        width: String(shown.getBoundingClientRect().width),
        right: String(shown.getBoundingClientRect().right),
      });
      const laid = await frame.layOut(
        { html, url: 'https://wiki.example.org/wiki/Fenmoor', ...(article ? { article } : {}) },
        kept,
      );
      frame.close();
      return {
        ...laid,
        title: document.title,
        frames: document.querySelectorAll('iframe').length,
        frameWhileOpen,
      };
    },
    { html: PAGE, kept, article },
  );
}

/** The notes of the page laid out, by element `id`, and what else it holds. */
async function notesOf(page: Page, html: string) {
  return page.evaluate((text) => {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const notes: Record<string, Record<string, string>> = {};
    for (const el of Array.from(doc.querySelectorAll('[id]'))) {
      const attrs: Record<string, string> = {};
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('data-atlas-')) attrs[attr.name] = attr.value;
      }
      notes[el.id] = attrs;
    }
    return {
      notes,
      body: Object.fromEntries(
        Array.from(doc.body.attributes)
          .filter((attr) => attr.name.startsWith('data-atlas-'))
          .map((attr) => [attr.name, attr.value]),
      ),
      scripts: doc.querySelectorAll('script').length,
      links: doc.querySelectorAll('link').length,
      pictures: Array.from(doc.querySelectorAll('img')).map((img) => img.getAttribute('src')),
      ran: doc.body.classList.contains('ran'),
      title: doc.title,
      places: doc.querySelectorAll('[data-atlas-at]').length,
    };
  }, html);
}

test.describe('the closed frame a saved page is laid out in', () => {
  let script = '';
  let policy = '';

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    [script, policy] = await Promise.all([frameScript(), appPolicy()]);
  });

  /** A page of the app's own origin, under the app's policy, with the frame's code; every request noted. */
  async function appPage(page: Page): Promise<string[]> {
    await page.route(`${ORIGIN}/**`, (route) => {
      const url = route.request().url();
      if (url === `${ORIGIN}/frame.js`) {
        return route.fulfill({ contentType: 'text/javascript', body: script });
      }
      return route.fulfill({
        contentType: 'text/html',
        headers: { 'Content-Security-Policy': policy },
        body: '<!doctype html><html><head><title>Atlas</title><script src="/frame.js"></script></head><body></body></html>',
      });
    });
    // Anything else would be a request for the page's sake: refused, and noted.
    await page.route(/^(?!http:\/\/atlas\.test\/)/u, (route) => route.abort());
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => 'openLayoutFrame' in window);
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    // Nothing tries to run in the frame at all: what the page had to run was taken out before.
    page.on('console', (message) => {
      if (message.text().includes('Blocked script execution')) requests.push(message.text());
    });
    return requests;
  }

  test('notes what a browser shows, runs nothing and asks for nothing', async ({ page }) => {
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("style-src 'self'");
    const requests = await appPage(page);
    const laid = await layOut(page, KEPT, ['#content']);
    expect(laid.kind).toBe('noted');
    // The frame: sandboxed without scripts, given as text, out of sight and of the accessibility tree, gone after.
    expect(laid.frameWhileOpen).toEqual({
      sandbox: 'allow-same-origin',
      'aria-hidden': 'true',
      tabindex: '-1',
      srcdoc: 'true',
      src: null,
      inert: 'true',
      visibility: 'hidden',
      width: '1280',
      right: expect.stringMatching(/^-/u) as unknown as string,
    });
    expect(laid.frames).toBe(0);
    // Nothing ran: not the page's script, not its events.
    expect(laid.title).toBe('Atlas');
    const read = await notesOf(page, laid.html!);
    expect(read.ran).toBe(false);
    expect(read.title).toBe('Fenmoor');
    // The page's own HTML, with the notes: its scripts and links kept as text, its pictures as they were.
    expect(read.scripts).toBe(2);
    expect(read.links).toBe(2);
    expect(read.pictures).toEqual([
      'https://pictures.example.org/heron.png',
      'https://pictures.example.org/reed.png',
    ]);
    expect(read.places).toBe(0);
    // The article carries the mark, with the size of its own text, not the site's claim.
    expect(readLayoutNotesMark(read.notes.content!['data-atlas-layout'])).toEqual({
      version: 1,
      textSize: 16,
      cut: false,
    });
    expect(read.body).toEqual({});
    expect(read.notes.nav).toEqual({});
    // The sheet laid the cards out side by side and the list in columns, and hid the fold.
    expect(readLayoutNote(read.notes.cards!)?.flow).toEqual({ form: 'row', wrap: false });
    const cards = [1, 2, 3].map((n) => readLayoutNote(read.notes[`card-${n}`]!)!);
    expect(new Set(cards.map((card) => card.box!.top)).size).toBe(1);
    expect(cards.every((card) => card.look?.framed)).toBe(true);
    expect(readLayoutNote(read.notes.three!)?.flow).toEqual({ form: 'columns', count: 3 });
    expect(read.notes.folded).toEqual({ 'data-atlas-hidden': 'display' });
    // What the site said of its own layout is gone: the app's notes only.
    expect(read.notes.said!['data-atlas-hidden']).toBeUndefined();
    expect(readLayoutNote(read.notes.said!)?.box).toBeDefined();
    // A picture keeps the box it states; one that states none gets a small one.
    expect(readLayoutNote(read.notes.sized!)?.box).toMatchObject({ width: 120, height: 80 });
    expect(readLayoutNote(read.notes.unsized!)?.box).toMatchObject({ width: 24, height: 24 });
    // The page's own style counts, without its address.
    expect(readLayoutNote(read.notes.banner!)?.box?.height).toBe(40);
    // Not one request, for a sheet, a font, a picture, a medium, a frame or a script.
    expect(requests).toEqual([]);
  });

  test('measures from the body when no selector finds the article, and lays out nothing without sheets', async ({
    page,
  }) => {
    const requests = await appPage(page);
    const laid = await layOut(page, KEPT, ['#no-such-part', 'not a [selector']);
    expect(laid.kind).toBe('noted');
    const read = await notesOf(page, laid.html!);
    expect(readLayoutNotesMark(read.body['data-atlas-layout'])?.version).toBe(1);
    expect(read.notes.content!['data-atlas-layout']).toBeUndefined();
    expect(readLayoutNote(read.notes.cards!)?.flow).toEqual({ form: 'row', wrap: false });
    // The sheets the page links to are not kept: no frame pass, the page as it came.
    const without = await layOut(page, [
      { address: 'https://wiki.example.org/other.css', text: SHEET },
    ]);
    expect(without).toMatchObject({ kind: 'skipped', reason: 'no-sheets', frames: 0 });
    expect(requests).toEqual([]);
  });
});
