import { MAX_STYLE_SHEET_BYTES, type AtlasImporter, type PageStyles } from '@atlas/importer-api';
import { beforeEach, describe, expect, it } from 'vitest';
import type { KeepStylesRequest, KeptStyles } from '../desktop';
import {
  fetchSessionStyles,
  forgetKnownStyles,
  gameOfSite,
  keepFetchedStyles,
  keepPageStyles,
  marksFor,
  markOf,
  noteGameOfSite,
  noteHandedStyles,
  readPageStyles,
  sheetFromAnswer,
  styleSheetsOfPage,
  type SheetAnswer,
} from './pageStyles';

const WIKI = 'https://wiki.example.org';
const PAGE = `${WIKI}/wiki/Lanterns`;

/** The shell's commands for a game's sheets, keeping what it is given in memory. */
function fakeShell(start: KeptStyles['sheets'] = []) {
  const kept: KeptStyles['sheets'] = [...start];
  const requests: { packId: string; request: KeepStylesRequest }[] = [];
  const listed = (): KeptStyles => ({
    sheets: kept.map((sheet) => ({ ...sheet })),
    files: kept.length,
    bytes: kept.reduce((sum, sheet) => sum + sheet.bytes, 0),
    leftOut: 0,
  });
  return {
    requests,
    asked: 0,
    styles(): Promise<KeptStyles> {
      this.asked++;
      return Promise.resolve(listed());
    },
    keepStyles(packId: string, request: KeepStylesRequest): Promise<KeptStyles> {
      requests.push({ packId, request });
      for (const sheet of request.sheets) {
        kept.push({
          ...(sheet.address ? { address: sheet.address } : {}),
          ...(sheet.mark ? { mark: sheet.mark } : {}),
          bytes: sheet.text.length,
        });
      }
      return Promise.resolve(listed());
    },
  };
}

beforeEach(() => {
  forgetKnownStyles();
});

describe('picking the style sheets out of a fetched page', () => {
  it('takes the sheets it links to and its style blocks, each once', () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="/load.css?modules=site&amp;only=styles">
      <LINK REL='Stylesheet preload' HREF='https://wiki.example.org/skin.css'>
      <link rel=stylesheet href=/load.css?modules=site&amp;only=styles>
      <link rel="alternate stylesheet" href="/high-contrast.css">
      <link rel="icon" href="/favicon.ico">
      <link rel="stylesheet" href="http://wiki.example.org/plain.css">
      <link rel="stylesheet" href="javascript:alert(1)">
      <link rel="stylesheet" href="https://cdn.example.net/fonts.css">
      <style>.box { float: right; }</style>
      <style type="text/css" media="screen">.cols { column-count: 2; }</style>
      <style type="text/less">.ignored { }</style>
      <style>.box { float: right; }</style>
      <!-- <link rel="stylesheet" href="/commented.css"> -->
      <script>document.write('<link rel="stylesheet" href="/written.css"><style>.s{}</style>');</script>
    </head><body><p>Text</p></body></html>`;
    expect(styleSheetsOfPage(html, PAGE)).toEqual({
      addresses: [
        `${WIKI}/load.css?modules=site&only=styles`,
        `${WIKI}/skin.css`,
        'https://cdn.example.net/fonts.css',
      ],
      blocks: ['.box { float: right; }', '.cols { column-count: 2; }'],
    });
  });

  it('reads relative addresses against the page’s base', () => {
    const html =
      '<head><base href="https://wiki.example.org/w/"><link rel="stylesheet" href="skin/main.css"></head>';
    expect(styleSheetsOfPage(html, PAGE).addresses).toEqual([`${WIKI}/w/skin/main.css`]);
    expect(styleSheetsOfPage('not a page at all', PAGE)).toEqual({ addresses: [], blocks: [] });
  });
});

describe('style sheets a page in the window hands over', () => {
  const styles: PageStyles = {
    sheets: [
      {
        address: `${WIKI}/load.css`,
        readable: true,
        chars: 22,
        mark: '22-a',
        text: '.box{float:right}',
      },
      { readable: true, chars: 9, mark: '9-b', text: '.hide{}' },
      { address: 'https://files.example.net/skin.css', readable: false },
      { address: `${WIKI}/big.css`, readable: true, chars: MAX_STYLE_SHEET_BYTES + 1, mark: 'big' },
    ],
  };

  it('keeps their text once, and notes what the page could not hand over when browsing', async () => {
    const shell = fakeShell();
    await keepPageStyles(shell, {
      packId: 'example-wiki',
      way: 'browse',
      pageUrl: PAGE,
      styles,
      session: 1,
      fetches: true,
    });
    expect(shell.requests).toEqual([
      {
        packId: 'example-wiki',
        request: {
          way: 'browse',
          sheets: [
            { address: `${WIKI}/load.css`, text: '.box{float:right}', mark: '22-a' },
            { text: '.hide{}', mark: '9-b' },
          ],
          leftOut: [
            { address: `${WIKI}/big.css`, reason: 'too-large', bytes: MAX_STYLE_SHEET_BYTES + 1 },
            { address: 'https://files.example.net/skin.css', reason: 'other-address' },
          ],
        },
      },
    ]);
    // The next page hands over the marks kept, and its sheets are not kept again.
    expect((await marksFor(shell, 'example-wiki')).sort()).toEqual(['22-a', '9-b', 'big']);
    await keepPageStyles(shell, {
      packId: 'example-wiki',
      way: 'browse',
      pageUrl: PAGE,
      styles,
      session: 1,
      fetches: true,
    });
    expect(shell.requests).toHaveLength(1);
    // Browsing, nothing is fetched by the app itself.
    let fetched = 0;
    await fetchSessionStyles(shell, 1, false, () => {
      fetched++;
      return Promise.resolve({ kind: 'cancelled' });
    });
    expect(fetched).toBe(0);
  });

  it('asks the shell once a run what is kept, and hands those marks to the reader', async () => {
    const shell = fakeShell([{ address: `${WIKI}/load.css`, mark: '22-a', bytes: 22 }]);
    expect(await marksFor(shell, null)).toEqual([]);
    expect(await marksFor(shell, 'example-wiki')).toEqual(['22-a']);
    expect(await marksFor(shell, 'example-wiki')).toEqual(['22-a']);
    expect(shell.asked).toBe(1);
    // Marks a page handed over count at once, while their sheets are being kept.
    noteHandedStyles('example-wiki', {
      sheets: [{ readable: true, chars: 3, mark: '3-z', text: 'a{}' }, { readable: false }],
    });
    expect(await marksFor(shell, 'example-wiki')).toEqual(['22-a', '3-z']);
    const asked: unknown[] = [];
    const answer = await readPageStyles(
      (script, argument) => {
        asked.push([script, argument]);
        return Promise.resolve(JSON.stringify({ sheets: [{ readable: false, address: 'nope' }] }));
      },
      '(marks) => null',
      ['22-a'],
    );
    expect(asked).toEqual([['(marks) => null', ['22-a']]]);
    // An address that is not one is left out.
    expect(answer).toEqual({ sheets: [] });
    expect(await readPageStyles(() => Promise.resolve(null), '(m) => 1', [])).toBeNull();
    expect(await readPageStyles(() => Promise.reject(new Error('x')), '(m) => 1', [])).toBeNull();
    expect(await readPageStyles(() => Promise.resolve('not json'), '(m) => 1', [])).toBeNull();
  });

  it('finds the game of a site from the pages before, or from the Library', () => {
    const importer: Pick<
      AtlasImporter,
      'id' | 'siteInfo' | 'fetch' | 'pageReader' | 'browseReader'
    > = { id: 'wikis', pageReader: '() => null' };
    const packs = [
      { id: 'other', imported: { importerId: 'wikis', importerTitle: 'W' }, pages: [] },
      {
        id: 'example-wiki',
        imported: { importerId: 'wikis', importerTitle: 'W' },
        pages: [{ url: `${WIKI}/wiki/Bells`, mapId: null }],
      },
    ];
    expect(gameOfSite(importer, PAGE, packs)).toBe('example-wiki');
    expect(gameOfSite(importer, 'https://other.example.org/wiki/A', packs)).toBeNull();
    noteGameOfSite(importer, 'https://other.example.org/wiki/A', 'other');
    expect(gameOfSite(importer, 'https://other.example.org/wiki/B', packs)).toBe('other');
  });
});

describe('fetching style sheets after a session', () => {
  /** A stand-in for `fetchSheet` in `importing.ts`, answering from `answers` by address. */
  function fetcher(answers: Record<string, SheetAnswer>) {
    const asked: string[] = [];
    return {
      asked,
      fetchSheet: (address: string): Promise<SheetAnswer> => {
        asked.push(address);
        return Promise.resolve(answers[address] ?? { kind: 'not', reason: 'failed' });
      },
    };
  }

  it('fetches only from the wiki’s own host, and each sheet once', async () => {
    const shell = fakeShell();
    const page = (links: string[]) =>
      JSON.stringify({
        fetched: [
          {
            url: PAGE,
            finalUrl: PAGE,
            status: 200,
            contentType: 'text/html',
            text: `${links.map((href) => `<link rel="stylesheet" href="${href}">`).join('')}<style>.a{}</style>`,
          },
        ],
      });
    await keepFetchedStyles(shell, {
      packId: 'example-wiki',
      pageUrl: PAGE,
      pageData: page(['/load.css', 'https://www.wiki.example.org/skin.css']),
      session: 7,
    });
    // The same sheets on the next page of the session: noted once.
    await keepFetchedStyles(shell, {
      packId: 'example-wiki',
      pageUrl: `${WIKI}/wiki/Bells`,
      pageData: page(['/load.css', 'https://cdn.example.net/fonts.css']),
      session: 7,
    });
    // The page's block, kept from the page data, once.
    expect(shell.requests).toEqual([
      {
        packId: 'example-wiki',
        request: { way: 'fetch', sheets: [{ text: '.a{}', mark: markOf('.a{}') }], leftOut: [] },
      },
    ]);
    const { asked, fetchSheet } = fetcher({
      [`${WIKI}/load.css`]: { kind: 'sheet', text: '.box { float: right; }' },
      'https://www.wiki.example.org/skin.css': { kind: 'sheet', text: '.skin {}' },
    });
    await fetchSessionStyles(shell, 7, false, fetchSheet);
    expect(asked).toEqual([`${WIKI}/load.css`, 'https://www.wiki.example.org/skin.css']);
    expect(shell.requests[1]).toEqual({
      packId: 'example-wiki',
      request: {
        way: 'fetch',
        sheets: [
          { address: `${WIKI}/load.css`, text: '.box { float: right; }' },
          { address: 'https://www.wiki.example.org/skin.css', text: '.skin {}' },
        ],
        leftOut: [{ address: 'https://cdn.example.net/fonts.css', reason: 'other-host' }],
      },
    });

    // Another session with the same pages: nothing is fetched or kept again.
    await keepFetchedStyles(shell, {
      packId: 'example-wiki',
      pageUrl: PAGE,
      pageData: page(['/load.css', 'https://cdn.example.net/fonts.css']),
      session: 8,
    });
    await fetchSessionStyles(shell, 8, false, fetchSheet);
    expect(asked).toHaveLength(2);
    expect(shell.requests).toHaveLength(2);
  });

  it('stops asking at a refusal, asks nothing after a session that stopped, and fetches a window’s sheets from the named hosts only', async () => {
    const shell = fakeShell();
    const styles: PageStyles = {
      sheets: [
        { address: `${WIKI}/a.css`, readable: false },
        { address: 'https://files.example.net/b.css', readable: false },
        { address: `${WIKI}/c.css`, readable: false },
        { address: 'https://ads.example.com/d.css', readable: false },
      ],
    };
    await keepPageStyles(shell, {
      packId: 'example-wiki',
      way: 'window',
      pageUrl: PAGE,
      styles,
      session: 3,
      fetches: true,
      fileHosts: ['files.example.net'],
    });
    // Nothing kept yet: the sheets wait for the end of the session.
    expect(shell.requests).toEqual([]);
    const { asked, fetchSheet } = fetcher({
      [`${WIKI}/a.css`]: { kind: 'sheet', text: '.a {}' },
      'https://files.example.net/b.css': { kind: 'not', reason: 'refused', stop: true },
    });
    await fetchSessionStyles(shell, 3, false, fetchSheet);
    expect(asked).toEqual([`${WIKI}/a.css`, 'https://files.example.net/b.css']);
    expect(shell.requests[0]!.request).toEqual({
      way: 'window',
      sheets: [{ address: `${WIKI}/a.css`, text: '.a {}' }],
      leftOut: [
        { address: 'https://files.example.net/b.css', reason: 'refused' },
        { address: `${WIKI}/c.css`, reason: 'not-asked' },
        { address: 'https://ads.example.com/d.css', reason: 'other-host' },
      ],
    });

    // A session that stopped before its end asks for nothing; the next one may.
    await keepPageStyles(shell, {
      packId: 'example-wiki',
      way: 'window',
      pageUrl: PAGE,
      styles,
      session: 4,
      fetches: true,
    });
    await fetchSessionStyles(shell, 4, true, fetchSheet);
    expect(asked).toHaveLength(2);
    expect(shell.requests[1]!.request.leftOut).toEqual([
      { address: `${WIKI}/c.css`, reason: 'not-asked' },
    ]);
    // In an app that does not download, such a sheet is only noted.
    forgetKnownStyles();
    const plain = fakeShell();
    await keepPageStyles(plain, {
      packId: 'example-wiki',
      way: 'window',
      pageUrl: PAGE,
      styles: { sheets: [styles.sheets[0]!] },
      session: 5,
      fetches: false,
    });
    expect(plain.requests[0]!.request.leftOut).toEqual([
      { address: `${WIKI}/a.css`, reason: 'other-address' },
    ]);
  });

  it('takes a style sheet only, and stops at a page in its place', () => {
    const answer = (status: number, contentType: string, text = '.a {}', refusal = null) =>
      sheetFromAnswer({ status, contentType, text, refusal });
    expect(answer(200, 'text/css')).toEqual({ kind: 'sheet', text: '.a {}' });
    expect(answer(200, 'text/html')).toEqual({ kind: 'not', reason: 'refused', stop: true });
    expect(answer(404, 'text/html')).toEqual({ kind: 'not', reason: 'failed' });
    expect(answer(200, 'application/javascript')).toEqual({ kind: 'not', reason: 'failed' });
    expect(
      sheetFromAnswer({ status: 429, contentType: '', text: '', refusal: 'slow down' }),
    ).toEqual({ kind: 'not', reason: 'refused', stop: true });
    const big = 'a'.repeat(MAX_STYLE_SHEET_BYTES + 1);
    expect(answer(200, 'text/css', big)).toEqual({
      kind: 'not',
      reason: 'too-large',
      bytes: big.length,
    });
  });
});
