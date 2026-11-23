import type { Browser } from '@playwright/test';
import { makePdf } from './guidebookFiles';

/**
 * Packs of magazines made here for the tests and screenshots, never
 * downloaded: two made-up magazine titles whose issues cover the demo
 * world and a made-up game that is not here. Their PDF issues are made
 * with `makePdf`; their covers and the pages of the CBZ issue are drawn
 * as JPEG pictures in the browser. Every name in them is made up.
 */

export const MONTHLY = 'magazines-marsh-monthly';
export const GAZETTE = 'magazines-fen-gazette';

const base = (id: string) => `http://atlas-pack.localhost/${id}/`;

/** A pack of magazines as the shell lists it. */
export const listedMagazine = (id: string, title: string) => ({
  id,
  title,
  url: base(id),
  magazines: true,
  packFile: true,
  origin: 'packs-folder',
  path: `/packs/${title}.atlaspack`,
  packVersion: '1.0.0',
  bundled: false,
  imported: null,
});

export const LISTED = [
  listedMagazine(MONTHLY, 'Marsh Monthly'),
  listedMagazine(GAZETTE, 'Fen Gazette'),
];

/** The text of the pages of Issue 41 (a PDF), one list of lines per page. */
const ISSUE_41: string[][] = [
  ['Marsh Monthly', 'Issue 41, April 2026'],
  ['In this issue', 'News from the reed beds', 'Letters'],
  ['Atlas demo world: a walk west', 'Every waystone of Westreach, one by one'],
  ['Atlas demo world, part two', 'The stone circle at dusk', 'The lantern path by night'],
  ['Hollow Marsh', 'The heron returns to the mill'],
  ['Letters', 'A reader asks where the last waystone is'],
];

/** The text of the pages of Issue 40 (a PDF without a cover or games). */
const ISSUE_40: string[][] = [
  ['Marsh Monthly', 'Issue 40, March 2026'],
  ['Spring in the fen', 'Frogs, reeds and the first herons'],
  ['Puzzles', 'Find the ten herons'],
];

/** The pages of Issue 42 (a CBZ): a headline and lines each, drawn as pictures. */
const ISSUE_42: { head: string; lines: string[] }[] = [
  { head: 'Marsh Monthly', lines: ['Issue 42', 'May 2026', 'Eastreach unearthed'] },
  {
    head: 'Eastreach unearthed',
    lines: ['Every relic shard of the east', 'and where the sealed doors open'],
  },
  {
    head: 'Eastreach, part two',
    lines: ['The old key and the cave entrance', 'A camp for the night by the ruin'],
  },
  { head: 'Next month', lines: ['Fen Gazette meets Marsh Monthly', 'More reed beds'] },
];

/** The pages of Fen Gazette's Issue 7. */
const GAZETTE_7: string[][] = [
  ['Fen Gazette', 'Issue 7, December 2025'],
  ['Atlas demo world in winter', 'Lore tablets under the snow, and a waystone by the camp'],
  ['Small ads', 'Wanted: a boat that floats'],
];

const textOf = (pages: string[][]) =>
  JSON.stringify({
    format: 'atlas-guidebook-text',
    version: 1,
    pages: pages.map((lines, i) => ({ page: i + 1, text: lines.join('\n') })),
  });

/** A ZIP whose entries are stored as they are. */
function storedZip(entries: [string, Buffer][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let table: Uint32Array | null = null;

function crc32(data: Buffer): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const html = (body: string, background: string, color: string) =>
  `<!doctype html><html><body style="margin:0;width:480px;height:640px;overflow:hidden;
    background:${background};color:${color};font-family:Georgia,serif">${body}</body></html>`;

/** A cover: the magazine's name, the issue, and a line about what is in it. */
const cover = (name: string, issue: string, line: string, background: string) =>
  html(
    `<div style="padding:36px 32px">
      <div style="font:700 64px/1 Georgia,serif;letter-spacing:-1px">${name}</div>
      <div style="margin-top:12px;font:600 22px sans-serif;opacity:.85">${issue}</div>
      <div style="position:absolute;left:32px;right:32px;bottom:120px;height:180px;border-radius:12px;
        background:rgba(255,255,255,.18)"></div>
      <div style="position:absolute;left:32px;right:32px;bottom:48px;font:700 34px/1.15 sans-serif">${line}</div>
    </div>`,
    background,
    '#fff',
  );

/** A page of the CBZ issue: a headline, its lines, and blocks of made-up print. */
const page = (head: string, lines: string[]) =>
  html(
    `<div style="padding:32px">
      <div style="font:700 36px/1.1 Georgia,serif;margin-bottom:18px">${head}</div>
      ${lines.map((line) => `<p style="font:20px/1.4 Georgia,serif;margin:0 0 10px">${line}</p>`).join('')}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:22px">
        ${Array.from({ length: 12 }, () => '<div style="height:12px;background:#c9c2b4;border-radius:3px"></div>').join('')}
      </div>
      <div style="margin-top:22px;height:160px;background:#8fa88a;border-radius:8px"></div>
    </div>`,
    '#f6f1e6',
    '#222',
  );

/** Draws each page of HTML as a JPEG picture, 480 by 640. */
async function draw(browser: Browser, pages: string[]): Promise<Buffer[]> {
  const tab = await browser.newPage({ viewport: { width: 480, height: 640 } });
  const out: Buffer[] = [];
  for (const content of pages) {
    await tab.setContent(content);
    out.push(await tab.screenshot({ type: 'jpeg', quality: 70 }));
  }
  await tab.close();
  return out;
}

/** The files the pack protocol serves for the two packs of magazines, by pack id and name. */
export async function magazineFiles(
  browser: Browser,
): Promise<Record<string, Record<string, Buffer | string>>> {
  const [cover41, cover42, cover7, ...pages42] = await draw(browser, [
    cover('Marsh Monthly', 'Issue 41 · April 2026', 'Every waystone of Westreach', '#2f6b5a'),
    cover('Marsh Monthly', 'Issue 42 · May 2026', 'Eastreach unearthed', '#7a3f2c'),
    cover('Fen Gazette', 'Issue 7 · December 2025', 'Winter in the demo world', '#2c4a7a'),
    ...ISSUE_42.map(({ head, lines }) => page(head, lines)),
  ]);
  const pdf41 = makePdf(ISSUE_41, [
    ['Contents', 2],
    ['A walk west', 3],
    ['Hollow Marsh', 5],
  ]);
  const pdf40 = makePdf(ISSUE_40);
  const pdf7 = makePdf(GAZETTE_7);
  const cbz42 = storedZip(pages42.map((data, i) => [`issue-42/page-${i + 1}.jpg`, data]));
  const list = (title: string, publisher: string | null, issues: Record<string, unknown>[]) =>
    JSON.stringify({
      format: 'atlas-magazines',
      version: 1,
      magazine: publisher ? { title, publisher } : { title },
      issues,
    });
  const manifest = (id: string, title: string) =>
    JSON.stringify({
      schemaVersion: 2,
      gameId: id,
      title,
      packVersion: '1.0.0',
      gamePatch: 'any',
      attribution: [],
      idMigrations: {},
      writtenBy: { name: 'Fen Shelf', version: '3.1.0' },
    });
  return {
    [MONTHLY]: {
      'manifest.json': manifest(MONTHLY, 'Marsh Monthly'),
      'magazines.json': list('Marsh Monthly', 'Reed Press', [
        {
          file: 'magazines/2026-03-issue-40.pdf',
          title: 'Issue 40',
          date: '2026-03',
          number: 40,
          pages: ISSUE_40.length,
          bytes: pdf40.length,
          text: 'magazines/2026-03-issue-40.text.json',
        },
        {
          file: 'magazines/2026-04-issue-41.pdf',
          title: 'Issue 41',
          date: '2026-04',
          number: 41,
          pages: ISSUE_41.length,
          bytes: pdf41.length,
          text: 'magazines/2026-04-issue-41.text.json',
          cover: 'magazines/2026-04-issue-41.cover.jpg',
          games: [
            { title: 'Atlas Demo World', pages: [[3, 4]] },
            { title: 'Hollow Marsh', system: 'Desk', pages: [[5, 5]] },
          ],
        },
        {
          file: 'magazines/2026-05-issue-42.cbz',
          title: 'Issue 42',
          date: '2026-05',
          number: 42,
          pages: ISSUE_42.length,
          bytes: cbz42.length,
          text: 'magazines/2026-05-issue-42.text.json',
          cover: 'magazines/2026-05-issue-42.cover.jpg',
          games: [{ title: 'A demo world', gameId: 'demo', pages: [[2, 3]] }],
        },
      ]),
      'magazines/2026-03-issue-40.pdf': pdf40,
      'magazines/2026-03-issue-40.text.json': textOf(ISSUE_40),
      'magazines/2026-04-issue-41.pdf': pdf41,
      'magazines/2026-04-issue-41.text.json': textOf(ISSUE_41),
      'magazines/2026-04-issue-41.cover.jpg': cover41!,
      'magazines/2026-05-issue-42.cbz': cbz42,
      'magazines/2026-05-issue-42.text.json': textOf(
        ISSUE_42.map(({ head, lines }) => [head, ...lines]),
      ),
      'magazines/2026-05-issue-42.cover.jpg': cover42!,
    },
    [GAZETTE]: {
      'manifest.json': manifest(GAZETTE, 'Fen Gazette'),
      'magazines.json': list('Fen Gazette', null, [
        {
          file: 'magazines/2025-12-issue-7.pdf',
          title: 'Issue 7',
          date: '2025-12',
          number: 7,
          pages: GAZETTE_7.length,
          bytes: pdf7.length,
          text: 'magazines/2025-12-issue-7.text.json',
          cover: 'magazines/2025-12-issue-7.cover.jpg',
          games: [{ title: 'atlas demo world', pages: [[2, 2]] }],
        },
      ]),
      'magazines/2025-12-issue-7.pdf': pdf7,
      'magazines/2025-12-issue-7.text.json': textOf(GAZETTE_7),
      'magazines/2025-12-issue-7.cover.jpg': cover7!,
    },
  };
}
