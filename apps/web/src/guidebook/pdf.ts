import {
  getDocument,
  GlobalWorkerOptions,
  PDFDataRangeTransport,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist';
import { MAX_GUIDEBOOK_PAGES, MAX_GUIDEBOOK_TEXT_BYTES } from '../state/guidebookData';
import { readRange, RANGE_PIECE } from './ranges';

/**
 * PDF guidebooks, read with pdf.js (`pdfjs-dist`, bundled with the app,
 * its worker a file of the app's own, `pdfWorker.ts`). The file is read in parts, through
 * the pack protocol's range requests (see `ranges.ts`), never whole. The
 * PDF runs no script: pdf.js runs a PDF's JavaScript only through its
 * scripting sandbox, which the app never loads, `isEvalSupported` is off,
 * so fonts are never compiled into functions, and XFA forms are not
 * shown. A link to a web page is an ordinary link the app's guard opens
 * in the system browser.
 *
 * Every PDF is untrusted: pdf.js reads it in its worker, the outline is
 * bounded in depth and size, the text of the pages in size, and a canvas
 * in pixels. A file pdf.js cannot read gives a sentence.
 */

let worker: Worker | null = null;

/** pdf.js's worker (`pdfWorker.ts`), started when the first PDF is opened and kept for the next. */
function startWorker(): void {
  if (worker) return;
  worker = new Worker(new URL('./pdfWorker.ts', import.meta.url), { type: 'module' });
  GlobalWorkerOptions.workerPort = worker;
}

/** The most items of the outline listed, and its deepest level. */
const MAX_OUTLINE_ITEMS = 5000;
const MAX_OUTLINE_DEPTH = 12;
/** The largest canvas drawn, in pixels: beyond it a page is drawn less sharp. */
const MAX_CANVAS_PIXELS = 16_000_000;
/** The largest picture in a page pdf.js decodes, in pixels. */
const MAX_IMAGE_PIXELS = 100_000_000;

/** Fetches the parts pdf.js asks for, and hands them over; a part that cannot be read stops the reading. */
class RangeTransport extends PDFDataRangeTransport {
  constructor(
    private readonly url: string,
    length: number,
    initial: Uint8Array,
    private readonly failed: (error: unknown) => void,
  ) {
    super(length, initial);
  }

  override requestDataRange(begin: number, end: number): void {
    void (async () => {
      try {
        for (let at = begin; at < end; at += RANGE_PIECE) {
          const part = await readRange(this.url, at, Math.min(end, at + RANGE_PIECE), this.length);
          this.onDataRange(at, part);
        }
      } catch (error) {
        this.failed(error);
      }
    })();
  }
}

/** An outline item: its title, the page it goes to (null when none), and the items under it. */
export interface OutlineItem {
  title: string;
  page: number | null;
  items: OutlineItem[];
}

/** A link on a page: to a web page, or to a page of the guidebook; where it is on the page, at scale 1. */
export interface PageLink {
  rect: { x: number; y: number; width: number; height: number };
  url: string | null;
  page: number | null;
}

/** A run of text on a page, and where it is at scale 1. */
export interface TextRun {
  text: string;
  rect: { x: number; y: number; width: number; height: number };
}

/** An open PDF. */
export interface PdfBook {
  pages: number;
  /** The size of page 1 at scale 1 (CSS pixels, 1 for each point). */
  firstSize: { width: number; height: number };
  size(page: number): Promise<{ width: number; height: number }>;
  /** Draws a page on a canvas at `scale` (times the screen's pixel ratio); stops when `signal` aborts. */
  draw(page: number, canvas: HTMLCanvasElement, scale: number, signal: AbortSignal): Promise<void>;
  outline(): Promise<OutlineItem[]>;
  links(page: number): Promise<PageLink[]>;
  textRuns(page: number): Promise<TextRun[]>;
  /** The text of every page, read one after another; stops (null) when `still` says so. */
  allText(
    onProgress: (done: number, total: number) => void,
    still: () => boolean,
  ): Promise<string[] | null>;
  close(): void;
}

/** What to say when pdf.js cannot open a file. */
function openError(error: unknown): Error {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'PasswordException') {
    return new Error(
      'This guidebook is locked with a password, and Atlas does not open such files.',
    );
  }
  if (name === 'InvalidPDFException') {
    return new Error('This guidebook’s file is not a PDF that can be read. It may be damaged.');
  }
  if (error instanceof Error && error.message.startsWith('This guidebook')) return error;
  return new Error('This guidebook’s file could not be read. It may be damaged.');
}

/** Opens the PDF at `url`, of `bytes` bytes, read in parts. */
export async function openPdf(url: string, bytes: number): Promise<PdfBook> {
  startWorker();
  const first = await readRange(url, 0, Math.min(bytes, RANGE_PIECE), bytes);
  let fail: (error: unknown) => void = () => undefined;
  const failure = new Promise<never>((_, reject) => {
    fail = reject;
  });
  failure.catch(() => undefined);
  const transport = new RangeTransport(url, bytes, first, (error) => {
    fail(error);
  });
  const task: PDFDocumentLoadingTask = getDocument({
    range: transport,
    length: bytes,
    rangeChunkSize: 64 * 1024,
    disableAutoFetch: true,
    disableStream: true,
    isEvalSupported: false,
    enableXfa: false,
    maxImageSize: MAX_IMAGE_PIXELS,
    stopAtErrors: false,
    useWorkerFetch: false,
  });
  let doc: PDFDocumentProxy;
  try {
    doc = await Promise.race([task.promise, failure]);
  } catch (error) {
    void task.destroy();
    throw openError(error);
  }
  const pages = Math.min(doc.numPages, MAX_GUIDEBOOK_PAGES);
  if (pages < 1) {
    void task.destroy();
    throw new Error('This guidebook has no pages.');
  }
  const page = (n: number) => Promise.race([doc.getPage(n), failure]);
  const one = await page(1);
  const view = one.getViewport({ scale: 1 });
  const sizes = new Map<number, { width: number; height: number }>([
    [1, { width: view.width, height: view.height }],
  ]);
  const size = async (n: number) => {
    const known = sizes.get(n);
    if (known) return known;
    const viewport = (await page(n)).getViewport({ scale: 1 });
    const found = { width: viewport.width, height: viewport.height };
    sizes.set(n, found);
    return found;
  };
  let outlineRead: Promise<OutlineItem[]> | null = null;
  return {
    pages,
    firstSize: sizes.get(1)!,
    size,
    async draw(n, canvas, scale, signal) {
      const stopped = () => signal.aborted;
      const proxy = await page(n);
      if (stopped()) return;
      let ratio = scale * (window.devicePixelRatio || 1);
      const base = proxy.getViewport({ scale: 1 });
      const pixels = base.width * base.height * ratio * ratio;
      if (pixels > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
      const viewport = proxy.getViewport({ scale: ratio });
      const drawn = document.createElement('canvas');
      drawn.width = Math.max(1, Math.floor(viewport.width));
      drawn.height = Math.max(1, Math.floor(viewport.height));
      const context = drawn.getContext('2d');
      if (!context) throw new Error('This page could not be drawn.');
      const render = proxy.render({ canvasContext: context, viewport });
      const stop = () => {
        render.cancel();
      };
      signal.addEventListener('abort', stop);
      try {
        await Promise.race([render.promise, failure]);
      } catch (error) {
        if ((error as { name?: unknown } | null)?.name === 'RenderingCancelledException') return;
        throw openError(error);
      } finally {
        signal.removeEventListener('abort', stop);
      }
      if (stopped()) return;
      // Drawn aside, then shown at once, so a page never shows half drawn.
      canvas.width = drawn.width;
      canvas.height = drawn.height;
      canvas.getContext('2d')?.drawImage(drawn, 0, 0);
      drawn.width = 0;
      drawn.height = 0;
    },
    outline() {
      outlineRead ??= readOutline(doc, failure).catch(() => []);
      return outlineRead;
    },
    async links(n) {
      const proxy = await page(n);
      const annotations = (await Promise.race([
        proxy.getAnnotations({ intent: 'display' }),
        failure,
      ])) as unknown[];
      const found: PageLink[] = [];
      for (const annotation of annotations.slice(0, 500)) {
        const { subtype, url, dest, rect } = annotation as {
          subtype?: unknown;
          url?: unknown;
          dest?: unknown;
          rect?: unknown;
        };
        if (subtype !== 'Link' || !isRect(rect)) continue;
        const web = typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
        const to = web ? null : await destPage(doc, dest, failure).catch(() => null);
        if (!web && to === null) continue;
        found.push({ rect: toView(proxy, rect), url: web, page: to });
      }
      return found;
    },
    async textRuns(n) {
      const proxy = await page(n);
      const content = await Promise.race([proxy.getTextContent(), failure]);
      const runs: TextRun[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [, , , d = 0, e = 0, f = 0] = item.transform as number[];
        const height = item.height || Math.abs(d);
        runs.push({ text: item.str, rect: toView(proxy, [e, f, e + item.width, f + height]) });
      }
      return runs;
    },
    async allText(onProgress, still) {
      const text: string[] = [];
      let size = 0;
      for (let n = 1; n <= pages; n++) {
        if (!still()) return null;
        const proxy = await page(n);
        const content = await Promise.race([proxy.getTextContent(), failure]);
        let line = '';
        for (const item of content.items) {
          if (!('str' in item)) continue;
          line += item.str + (item.hasEOL ? '\n' : '');
        }
        proxy.cleanup();
        size += line.length;
        // Text past the most a guidebook's text can be is not searched.
        // (Each character is at most three bytes as UTF-8.)
        if (size * 3 > MAX_GUIDEBOOK_TEXT_BYTES) {
          return text.concat(Array<string>(pages - n + 1).fill(''));
        }
        text.push(line);
        if (n % 5 === 0 || n === pages) onProgress(n, pages);
      }
      return text;
    },
    close() {
      void task.destroy();
    },
  };
}

const isRect = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number');

/** A rectangle of the page (PDF units) where it is shown at scale 1, from the top left. */
function toView(page: PDFPageProxy, rect: number[]): TextRun['rect'] {
  const viewport = page.getViewport({ scale: 1 });
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = viewport.convertToViewportRectangle(rect) as number[];
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** The page (from 1) a destination goes to, or null. */
async function destPage(
  doc: PDFDocumentProxy,
  dest: unknown,
  failure: Promise<never>,
): Promise<number | null> {
  let explicit: unknown = dest;
  if (typeof dest === 'string') {
    explicit = await Promise.race([doc.getDestination(dest), failure]);
  }
  if (!Array.isArray(explicit) || explicit.length === 0) return null;
  const target: unknown = explicit[0];
  if (typeof target === 'number' && Number.isInteger(target)) return target + 1;
  if (typeof target === 'object' && target !== null && 'num' in target && 'gen' in target) {
    const index = await Promise.race([
      doc.getPageIndex(target as { num: number; gen: number }),
      failure,
    ]);
    return index + 1;
  }
  return null;
}

/** The outline of a PDF, bounded in depth and number of items. */
async function readOutline(doc: PDFDocumentProxy, failure: Promise<never>): Promise<OutlineItem[]> {
  const outline = await Promise.race([doc.getOutline(), failure]);
  let count = 0;
  const walk = async (items: readonly unknown[] | null, depth: number): Promise<OutlineItem[]> => {
    const out: OutlineItem[] = [];
    for (const item of items ?? []) {
      if (count >= MAX_OUTLINE_ITEMS) break;
      count += 1;
      const {
        title,
        dest,
        items: under,
      } = item as {
        title?: unknown;
        dest?: unknown;
        items?: unknown;
      };
      const name = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
      const page = await destPage(doc, dest, failure).catch(() => null);
      out.push({
        title: name || 'Untitled',
        page,
        items:
          depth < MAX_OUTLINE_DEPTH && Array.isArray(under) ? await walk(under, depth + 1) : [],
      });
    }
    return out;
  };
  return walk(outline, 1);
}

/**
 * "Add a guidebook…": the pages of the PDF at `url` (the picked file, as
 * the shell serves it) and the text of each, read here with pdf.js. The
 * text is null when the PDF has none (pictures of pages only).
 */
export async function readPdfText(
  url: string,
  bytes: number,
  onProgress: (done: number, total: number) => void,
  still: () => boolean,
): Promise<{ pages: number; text: string[] | null }> {
  const book = await openPdf(url, bytes);
  try {
    onProgress(0, book.pages);
    const text = await book.allText(onProgress, still);
    const some = text?.some((page) => page.trim() !== '') ?? false;
    return { pages: book.pages, text: some ? text : null };
  } finally {
    book.close();
  }
}
