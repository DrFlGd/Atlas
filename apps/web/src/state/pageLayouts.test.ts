import { describe, expect, it } from 'vitest';
import { layoutReport, layoutText, pageLayouts } from './pageLayouts';

const PAGE = { html: '<!doctype html><p>Moss</p>', url: 'https://wiki.example.org/wiki/Moss' };
const SHEETS = [{ address: 'https://wiki.example.org/skin.css', text: '.cards { display: flex }' }];

/** A frame that notes every page, one at a time, and counts what it was asked. */
function fakeFrame(answer: 'noted' | 'no-sheets' | 'time' = 'noted') {
  const seen = { opened: 0, pages: 0, closed: 0, atOnce: 0, most: 0 };
  return {
    seen,
    open: () => {
      seen.opened++;
      return Promise.resolve({
        async layOut(request: { html: string }) {
          seen.pages++;
          seen.atOnce++;
          seen.most = Math.max(seen.most, seen.atOnce);
          await new Promise((resolve) => setTimeout(resolve, 5));
          seen.atOnce--;
          return answer === 'noted'
            ? { kind: 'noted' as const, html: `${request.html}<!-- noted -->` }
            : { kind: 'skipped' as const, reason: answer };
        },
        close() {
          seen.closed++;
        },
      });
    },
  };
}

describe('laying out the pages of one convert call', () => {
  it('opens one frame at the first page, lays pages out one at a time, and removes it at the end', async () => {
    const frame = fakeFrame();
    let reads = 0;
    let pages = 0;
    const layouts = pageLayouts({
      sheets: () => {
        reads++;
        return Promise.resolve(SHEETS);
      },
      open: frame.open,
      onPage: () => {
        pages++;
      },
    });
    expect(frame.seen.opened).toBe(0);
    const answers = await Promise.all([
      layouts.layOut(PAGE),
      layouts.layOut(PAGE),
      layouts.layOut(PAGE),
    ]);
    expect(answers).toEqual(Array(3).fill(`${PAGE.html}<!-- noted -->`));
    expect(frame.seen).toMatchObject({ opened: 1, pages: 3, most: 1 });
    expect(reads).toBe(1);
    expect(pages).toBe(3);
    expect(layouts.tally()).toEqual({ laidOut: 3, noSheets: 0, missed: 0 });
    layouts.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frame.seen.closed).toBe(1);
    // Closed: nothing more is laid out.
    expect(await layouts.layOut(PAGE)).toBeNull();
  });

  it('opens no frame for a game that keeps no sheets, and says so', async () => {
    const frame = fakeFrame();
    const layouts = pageLayouts({ sheets: () => Promise.resolve([]), open: frame.open });
    expect(await layouts.layOut(PAGE)).toBeNull();
    expect(await layouts.layOut(PAGE)).toBeNull();
    expect(frame.seen.opened).toBe(0);
    expect(layouts.tally()).toEqual({ laidOut: 0, noSheets: 2, missed: 0 });
    expect(layoutReport(layouts.tally(), false)).toEqual({ kind: 'no-sheets' });
  });

  it('takes only a request in the contract’s shape, and never rejects', async () => {
    const frame = fakeFrame();
    const layouts = pageLayouts({ sheets: () => Promise.resolve(SHEETS), open: frame.open });
    for (const bad of [
      null,
      'text',
      { html: '' },
      { html: '<p>', url: 'file:///x' },
      { url: PAGE.url },
    ]) {
      expect(await layouts.layOut(bad as never)).toBeNull();
    }
    expect(frame.seen.pages).toBe(0);
    const failing = pageLayouts({
      sheets: () => Promise.reject(new Error('no disk')),
      open: () => Promise.reject(new Error('no frame')),
    });
    expect(await failing.layOut(PAGE)).toBeNull();
    const noFrame = pageLayouts({
      sheets: () => Promise.resolve(SHEETS),
      open: () => Promise.reject(new Error('no frame')),
    });
    expect(await noFrame.layOut(PAGE)).toBeNull();
    expect(noFrame.tally()).toEqual({ laidOut: 0, noSheets: 0, missed: 1 });
  });

  it('counts pages the frame could not lay out', async () => {
    const late = pageLayouts({
      sheets: () => Promise.resolve(SHEETS),
      open: fakeFrame('time').open,
    });
    const unused = pageLayouts({
      sheets: () => Promise.resolve(SHEETS),
      open: fakeFrame('no-sheets').open,
    });
    expect(await late.layOut(PAGE)).toBeNull();
    expect(await unused.layOut(PAGE)).toBeNull();
    expect(late.tally()).toEqual({ laidOut: 0, noSheets: 0, missed: 1 });
    expect(unused.tally()).toEqual({ laidOut: 0, noSheets: 1, missed: 0 });
  });
});

describe('what Build again says of it', () => {
  it('says nothing when the importer asked for nothing', () => {
    expect(layoutReport(null, true)).toBeNull();
    expect(layoutReport({ laidOut: 0, noSheets: 0, missed: 0 }, true)).toBeNull();
    expect(layoutText(null)).toBeNull();
  });

  it('says once, in full sentences, what was done', () => {
    expect(layoutText({ kind: 'no-sheets' })).toBe(
      'This wiki keeps no style sheets, so its pages were written from their HTML alone, not laid out as a browser shows them. Its sheets are kept as its pages are read again.',
    );
    expect(layoutText(layoutReport({ laidOut: 3400, noSheets: 0, missed: 0 }, true))).toBe(
      '3,400 pages were laid out as a browser shows them, with the wiki’s style sheets kept on this computer.',
    );
    expect(layoutText(layoutReport({ laidOut: 1, noSheets: 1, missed: 0 }, true))).toBe(
      '1 page was laid out as a browser shows it, with the wiki’s style sheets kept on this computer. 1 page was written from its HTML alone, as the sheets it uses are not kept or it could not be laid out in time.',
    );
    expect(layoutText(layoutReport({ laidOut: 10, noSheets: 2, missed: 3 }, true))).toContain(
      '5 pages were written from their HTML alone',
    );
    for (const report of [
      { kind: 'no-sheets' } as const,
      { kind: 'laid-out', pages: 2, missed: 2 } as const,
    ]) {
      expect(layoutText(report)).not.toMatch(/—|\bplace\b|\bkind\b|built-in/u);
    }
  });
});
