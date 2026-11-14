import {
  MAX_STYLE_SHEET_BYTES,
  isFetchedPages,
  pageStylesOf,
  siteInfoOf,
  utf8Bytes,
  type AtlasImporter,
  type PageStyles,
} from '@atlas/importer-api';
import type {
  KeepStylesRequest,
  KeptStyles,
  ListedPack,
  StyleLeftOutReason,
  StylesWay,
} from '../desktop';

/**
 * Keeping the style sheets a wiki's pages use, once per game, in the game's
 * folder (`import/styles/`, see `styles.rs` in the shell and `styles.ts` in
 * the importer contract). Nothing uses them yet, and nothing here changes
 * how a page is read, converted or shown: a sheet that cannot be kept never
 * fails or holds up a session, and the activity log says why.
 *
 * - A page read in the app's window (the ways `window` and `browse`) hands
 *   its sheets over itself: once its data has been read, the importer's
 *   style reader runs once in that page with the marks of the sheets kept
 *   already, so only a sheet not kept yet travels.
 * - A page the app fetched (the way `fetch`) names its sheets in its HTML:
 *   its `<style>` blocks are kept from the page data, and the sheets it
 *   links to on the page's own host are fetched once per game, after the
 *   pages of the session, with the rules of pages (see `importing.ts`).
 * - A sheet a page in the window could not hand over (from another
 *   address) is fetched the same way after a session read in a window,
 *   when it is on the wiki's own host or one its importer names
 *   (`SiteInfo.fileHosts`); never for the way `browse`, where the app
 *   fetches nothing by itself.
 *
 * Nothing in a sheet is followed or run; the text goes to the shell as
 * data only.
 */

/** The shell's commands for a game's sheets. */
export interface StylesShell {
  styles(packId: string): Promise<KeptStyles>;
  keepStyles(packId: string, request: KeepStylesRequest): Promise<KeptStyles>;
}

/** What is known this run of a game's sheets: so a sheet is not handed over or fetched again. */
interface Known {
  marks: Set<string>;
  addresses: Set<string>;
}

/** By game: what the shell said it keeps, and the marks of sheets left out for their size. */
const known = new Map<string, Known>();
/** By game: the marks of sheets pages handed over, on their way to the shell. */
const handed = new Map<string, Set<string>>();
/** The game each site's pages went into, by importer and site key. */
const games = new Map<string, string>();
/** Keeping is one step at a time, in order. */
let keeping: Promise<unknown> = Promise.resolve();

const siteOf = (importerId: string, siteKey: string) => `${importerId}\n${siteKey}`;

/** Forgets what is known (tests). */
export function forgetKnownStyles(): void {
  known.clear();
  handed.clear();
  games.clear();
  pending.clear();
}

/** Notes what the shell keeps of a game's sheets. */
function noteKept(packId: string, kept: KeptStyles): Known {
  const entry = known.get(packId) ?? { marks: new Set<string>(), addresses: new Set<string>() };
  for (const sheet of kept.sheets) {
    if (sheet.mark) entry.marks.add(sheet.mark);
    if (sheet.address) entry.addresses.add(sheet.address);
  }
  known.set(packId, entry);
  return entry;
}

/** What is known of a game's sheets, asked of the shell once a run. */
async function knownOf(shell: StylesShell, packId: string): Promise<Known> {
  const entry = known.get(packId);
  if (entry) return entry;
  const kept = await shell
    .styles(packId)
    .catch((): KeptStyles => ({ sheets: [], files: 0, bytes: 0, leftOut: 0 }));
  return noteKept(packId, kept);
}

/**
 * The game the pages of a site go into: the one its last page went into
 * this run, else one in the Library read from that site with this importer.
 */
export function gameOfSite(
  importer: Pick<AtlasImporter, 'id' | 'siteInfo' | 'fetch' | 'pageReader' | 'browseReader'>,
  url: string,
  packs: readonly Pick<ListedPack, 'id' | 'imported' | 'pages'>[],
): string | null {
  const key = siteInfoOf(importer, url).key;
  const noted = games.get(siteOf(importer.id, key));
  if (noted) return noted;
  const pack = packs.find(
    (pack) =>
      pack.imported?.importerId === importer.id &&
      (pack.pages ?? []).some((page) => siteInfoOf(importer, page.url).key === key),
  );
  return pack?.id ?? null;
}

/** Notes the game a site's page went into. */
export function noteGameOfSite(
  importer: Pick<AtlasImporter, 'id' | 'siteInfo' | 'fetch' | 'pageReader' | 'browseReader'>,
  url: string,
  packId: string,
): void {
  games.set(siteOf(importer.id, siteInfoOf(importer, url).key), packId);
}

/**
 * The marks to hand the style reader: those of the sheets kept for the
 * game, if it is known, and of those pages handed over already.
 */
export async function marksFor(shell: StylesShell, packId: string | null): Promise<string[]> {
  if (!packId) return [];
  const have = await knownOf(shell, packId);
  return [...new Set([...have.marks, ...(handed.get(packId) ?? [])])];
}

/**
 * Notes the marks of the sheets a page handed over for game `packId`, at
 * once, so the next page is not asked for them while they are being kept.
 */
export function noteHandedStyles(packId: string, styles: PageStyles): void {
  const marks = handed.get(packId) ?? new Set<string>();
  handed.set(packId, marks);
  for (const sheet of styles.sheets) if (sheet.mark) marks.add(sheet.mark);
}

/**
 * Runs the importer's style reader once in the page just read (see
 * `DesktopBridge.importWindow.runOnce`): the page's sheets, or null.
 */
export async function readPageStyles(
  runOnce: (script: string, argument: unknown) => Promise<string | null>,
  reader: string,
  marks: readonly string[],
): Promise<PageStyles | null> {
  const text = await runOnce(reader, marks).catch(() => null);
  if (text === null) return null;
  try {
    return pageStylesOf(JSON.parse(text));
  } catch {
    return null;
  }
}

/** A sheet to fetch after a session: its address, and the game it is kept for. */
interface Wanted {
  way: StylesWay;
  /** The hosts it may be fetched from: the wiki's own, and those its importer names for a page read in a window. */
  hosts: Set<string>;
  addresses: Set<string>;
}

/** By session, then game: the sheets to fetch once the session's pages are read. */
const pending = new Map<number, Map<string, Wanted>>();

/** A host without its `www.`, lowercase. */
const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return null;
  }
};

function want(
  session: number,
  packId: string,
  way: StylesWay,
  pageUrl: string,
  fileHosts: readonly string[],
  addresses: readonly string[],
): void {
  if (addresses.length === 0) return;
  const byGame = pending.get(session) ?? new Map<string, Wanted>();
  pending.set(session, byGame);
  const wanted = byGame.get(packId) ?? { way, hosts: new Set<string>(), addresses: new Set() };
  byGame.set(packId, wanted);
  const own = hostOf(pageUrl);
  if (own) wanted.hosts.add(own);
  for (const host of fileHosts) wanted.hosts.add(host);
  for (const address of addresses) wanted.addresses.add(address);
}

/** Keeps sheets with a game, one step after the other; what is kept after, or null. */
function keep(
  shell: StylesShell,
  packId: string,
  request: KeepStylesRequest,
): Promise<KeptStyles | null> {
  if (request.sheets.length === 0 && request.leftOut.length === 0) return Promise.resolve(null);
  const step = keeping.then(() =>
    shell.keepStyles(packId, request).then(
      (kept) => {
        noteKept(packId, kept);
        return kept;
      },
      () => null,
    ),
  );
  keeping = step;
  return step;
}

/**
 * Keeps the sheets a page in the window handed over for game `packId`:
 * their text when it came, a note for one left out for its size, and, for
 * one from another address, a note (`browse`) or a sheet to fetch after
 * the session (`window`, when `fetches`).
 */
export async function keepPageStyles(
  shell: StylesShell,
  {
    packId,
    way,
    pageUrl,
    styles,
    session,
    fetches,
    fileHosts = [],
  }: {
    packId: string;
    way: 'window' | 'browse';
    pageUrl: string;
    styles: PageStyles;
    session: number;
    /** This app may fetch a sheet the page could not hand over (a build that downloads, the way `window`). */
    fetches: boolean;
    fileHosts?: readonly string[];
  },
): Promise<void> {
  const have = await knownOf(shell, packId);
  const request: KeepStylesRequest = { way, sheets: [], leftOut: [] };
  const other: string[] = [];
  for (const sheet of styles.sheets) {
    if (!sheet.readable) {
      if (sheet.address && !have.addresses.has(sheet.address)) other.push(sheet.address);
      continue;
    }
    if (!sheet.mark || have.marks.has(sheet.mark)) continue;
    if (sheet.text !== undefined) {
      request.sheets.push({
        ...(sheet.address ? { address: sheet.address } : {}),
        text: sheet.text,
        mark: sheet.mark,
      });
    } else {
      // Not handed over for its size: noted, and not asked for again this run.
      have.marks.add(sheet.mark);
      request.leftOut.push({
        ...(sheet.address ? { address: sheet.address } : {}),
        reason: 'too-large',
        ...(sheet.chars !== undefined ? { bytes: sheet.chars } : {}),
      });
    }
  }
  if (way === 'window' && fetches) {
    want(session, packId, way, pageUrl, fileHosts, other);
  } else {
    for (const address of new Set(other)) {
      // Noted once a run.
      have.addresses.add(address);
      request.leftOut.push({ address, reason: 'other-address' });
    }
  }
  await keep(shell, packId, request);
}

/** A short mark of a text, as the app gives the blocks of a fetched page: its length and a hash. */
export function markOf(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  }
  return `${text.length}-${hash.toString(36)}`;
}

/** Sheets of one page the app picks out of its HTML at most, of each kind. */
const MAX_PAGE_SHEETS = 100;

/** `&amp;` and the like in an attribute's value, as text. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/giu, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) return codePoint(parseInt(lower.slice(2), 16), whole);
    if (lower.startsWith('#')) return codePoint(parseInt(lower.slice(1), 10), whole);
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[lower] ?? whole;
  });
}

const codePoint = (code: number, whole: string) =>
  Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;

/** The attributes of a tag's text (`<link rel="stylesheet" href=…>`), names lowercase. */
function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const body = tag.replace(/^<\s*[a-z]+/iu, '').replace(/\/?>$/u, '');
  for (const match of body.matchAll(
    /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/gu,
  )) {
    const name = match[1]!.toLowerCase();
    if (!attributes.has(name)) {
      attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
    }
  }
  return attributes;
}

/** Whether a sheet's address is one this app may keep: `https`, or `http` on this computer (tests). */
function sheetAddress(href: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(href.trim(), base);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  url.hash = '';
  return url.href.length <= 2048 ? url.href : null;
}

/**
 * The style sheets a fetched page names in its HTML: the addresses of the
 * sheets it links to (`<link rel="stylesheet">`, against its `<base>`),
 * each once, and the text of its `<style>` blocks. Nothing in a script or
 * a comment counts. Never throws.
 */
export function styleSheetsOfPage(
  html: string,
  pageUrl: string,
): { addresses: string[]; blocks: string[] } {
  const addresses: string[] = [];
  const blocks: string[] = [];
  const text = html
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, '')
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/giu, '');
  let base = pageUrl;
  const baseTag = /<base\b[^>]*>/iu.exec(text);
  const baseHref = baseTag ? attributesOf(baseTag[0]).get('href') : undefined;
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl).href;
    } catch {
      // The page's own address, then.
    }
  }
  for (const [tag] of text.matchAll(/<link\b[^>]*>/giu)) {
    if (addresses.length >= MAX_PAGE_SHEETS) break;
    const attributes = attributesOf(tag);
    const rel = (attributes.get('rel') ?? '').toLowerCase().split(/\s+/u);
    if (!rel.includes('stylesheet') || rel.includes('alternate')) continue;
    const address = sheetAddress(attributes.get('href') ?? '', base);
    if (address && !addresses.includes(address)) addresses.push(address);
  }
  for (const match of text.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/giu)) {
    if (blocks.length >= MAX_PAGE_SHEETS) break;
    const type = attributesOf(`<style ${match[1]!}>`).get('type');
    if (type !== undefined && type.trim() !== '' && type.trim().toLowerCase() !== 'text/css') {
      continue;
    }
    const block = match[2]!;
    if (block.trim() && !blocks.includes(block)) blocks.push(block);
  }
  return { addresses, blocks };
}

/**
 * Keeps the `<style>` blocks of a page the app fetched for game `packId`,
 * and notes the sheets it links to, to fetch after the session.
 */
export async function keepFetchedStyles(
  shell: StylesShell,
  {
    packId,
    pageUrl,
    pageData,
    session,
  }: { packId: string; pageUrl: string; pageData: string; session: number },
): Promise<void> {
  let data: unknown;
  try {
    data = JSON.parse(pageData);
  } catch {
    return;
  }
  if (!isFetchedPages(data)) return;
  const have = await knownOf(shell, packId);
  const request: KeepStylesRequest = { way: 'fetch', sheets: [], leftOut: [] };
  const addresses: string[] = [];
  for (const answer of data.fetched) {
    if (answer.status < 200 || answer.status >= 300 || answer.contentType !== 'text/html') continue;
    const found = styleSheetsOfPage(answer.text, answer.finalUrl || answer.url);
    addresses.push(...found.addresses);
    for (const block of found.blocks) {
      const mark = markOf(block);
      if (have.marks.has(mark)) continue;
      have.marks.add(mark);
      if (utf8Bytes(block) > MAX_STYLE_SHEET_BYTES) {
        request.leftOut.push({ reason: 'too-large', bytes: utf8Bytes(block) });
      } else {
        request.sheets.push({ text: block, mark });
      }
    }
  }
  want(
    session,
    packId,
    'fetch',
    pageUrl,
    [],
    addresses.filter((address) => !have.addresses.has(address)),
  );
  await keep(shell, packId, request);
}

/** How fetching one sheet went (see `fetchSheet` in `importing.ts`). */
export type SheetAnswer =
  | { kind: 'sheet'; text: string }
  /** Not kept; with `stop`, no more sheets of the site are asked for. */
  | { kind: 'not'; reason: StyleLeftOutReason; stop?: boolean; bytes?: number }
  /** Another session started, or the app cannot fetch: nothing more is asked for. */
  | { kind: 'cancelled' };

/** Whether a fetched answer is a style sheet the app keeps, and why not. */
export function sheetFromAnswer(answer: {
  status: number;
  contentType: string;
  text: string;
  refusal: string | null;
}): SheetAnswer {
  if (answer.refusal) return { kind: 'not', reason: 'refused', stop: true };
  if (answer.status < 200 || answer.status >= 300) return { kind: 'not', reason: 'failed' };
  // A page in place of a sheet: the site's check, or its error page. Nothing more is asked.
  if (answer.contentType === 'text/html') return { kind: 'not', reason: 'refused', stop: true };
  if (answer.contentType !== 'text/css') return { kind: 'not', reason: 'failed' };
  const bytes = utf8Bytes(answer.text);
  if (bytes > MAX_STYLE_SHEET_BYTES) return { kind: 'not', reason: 'too-large', bytes };
  return { kind: 'sheet', text: answer.text };
}

/**
 * After session `session`: fetches the sheets its pages named that are not
 * kept yet, one at a time with `fetchSheet` (the rules of pages), from the
 * hosts each game allows, and keeps them with one step per game; a sheet
 * on any other host, or one not asked for because the session stopped
 * (`stopped`), is noted. Stops a game's sheets at the first refusal.
 */
export async function fetchSessionStyles(
  shell: StylesShell,
  session: number,
  stopped: boolean,
  fetchSheet: (address: string) => Promise<SheetAnswer>,
): Promise<void> {
  const wanted = pending.get(session);
  pending.delete(session);
  if (!wanted) return;
  let cancelled = false;
  for (const [packId, game] of wanted) {
    const have = await knownOf(shell, packId);
    const request: KeepStylesRequest = { way: game.way, sheets: [], leftOut: [] };
    let stop: boolean = stopped || cancelled;
    for (const address of game.addresses) {
      if (have.addresses.has(address)) continue;
      const host = hostOf(address);
      if (!host || !game.hosts.has(host)) {
        // Noted once a run.
        have.addresses.add(address);
        request.leftOut.push({ address, reason: 'other-host' });
        continue;
      }
      if (stop) {
        // Asked for after a later session.
        request.leftOut.push({ address, reason: 'not-asked' });
        continue;
      }
      const answer = await fetchSheet(address);
      if (answer.kind === 'cancelled') {
        cancelled = true;
        stop = true;
        request.leftOut.push({ address, reason: 'not-asked' });
        continue;
      }
      // Asked for once a run, whatever the answer.
      have.addresses.add(address);
      if (answer.kind === 'sheet') {
        request.sheets.push({ address, text: answer.text });
      } else {
        if (answer.stop) stop = true;
        request.leftOut.push({
          address,
          reason: answer.reason,
          ...(answer.bytes !== undefined ? { bytes: answer.bytes } : {}),
        });
      }
    }
    await keep(shell, packId, request);
  }
}
