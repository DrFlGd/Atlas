/**
 * Keeping the style sheets of a site's pages (optional). An app may keep
 * the style sheets the pages of a wiki use, as plain text, once per game,
 * in the game's folder: never in a file the game is exported to. An app
 * that lays pages out uses them for that alone (`ImportContext.layOut`):
 * it puts them as text into a closed frame of its own, with `@import`
 * left out and every `url()` made empty. Nothing inside a sheet is
 * followed (no `@import`, no fonts, no pictures), and a sheet is never
 * loaded as a style sheet of the app: it is text, kept as data.
 *
 * - For a page read in the app's window (the ways `window` and `browse`),
 *   an importer that has a {@link AtlasImporter.styleReader} hands the
 *   sheets over from the page itself, with no request: once the page's data
 *   has been read, the app runs the style reader once in that same page,
 *   with the marks of the sheets it has kept already, and the reader gives
 *   the text of the others only ({@link PageStyles}). So a sheet travels
 *   once, not with every page.
 * - For a page the app fetches (the way `fetch`), the app picks the sheets
 *   out of the page's HTML itself, and may fetch those on the page's own
 *   host once per game, after the pages of a session, with the same rules
 *   as pages (`fetching.ts`).
 *
 * An importer without a style reader has nothing kept, and a game with no
 * sheets kept is as before.
 */

/** The text of one style sheet the app keeps at most, in bytes (UTF-8). */
export const MAX_STYLE_SHEET_BYTES = 4 * 1024 * 1024;
/** The text of all style sheets kept for one game at most, in bytes (UTF-8). */
export const MAX_SITE_STYLES_BYTES = 16 * 1024 * 1024;
/** The sheets of one page the app takes at most. */
export const MAX_PAGE_STYLE_SHEETS = 200;
/** A reader's mark of a sheet is at most this long. */
export const MAX_STYLE_MARK_CHARS = 200;
/** A sheet's address is at most this long. */
const MAX_STYLE_ADDRESS_CHARS = 2048;

/** One style sheet a page uses, as a style reader hands it over (see {@link PageStyles}). */
export interface PageStyleSheet {
  /** Its address; left out for a `<style>` block in the page itself. */
  address?: string;
  /**
   * Whether the page let its rules be read: false for a sheet from another
   * address than the page's own, which the page cannot hand over (reading
   * its rules throws). Then only its address is given.
   */
  readable: boolean;
  /** For a readable sheet: the length of its text, in characters. */
  chars?: number;
  /**
   * For a readable sheet: the reader's own mark of its text, the same for
   * the same text (its length and a hash, say), at most
   * {@link MAX_STYLE_MARK_CHARS} characters. The app keeps it with the
   * sheet and hands it back the next time, so the text is not given again.
   */
  mark?: string;
  /**
   * For a readable sheet: its text (the rules as the page has them), left
   * out when its mark is one the app said it has, or when the text is
   * longer than {@link MAX_STYLE_SHEET_BYTES}.
   */
  text?: string;
}

/** What a style reader returns: the page's style sheets, in the page's order. */
export interface PageStyles {
  sheets: PageStyleSheet[];
}

/** The bytes a text takes as UTF-8. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    // Each half of a surrogate pair: four bytes for the pair.
    else if (code >= 0xd800 && code <= 0xdfff) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

/** Whether `text` is an address a sheet may have: `https`, or `http` on this computer (tests). */
function isSheetAddress(text: string): boolean {
  if (text.length > MAX_STYLE_ADDRESS_CHARS) return false;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return url.hostname.length > 0;
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}

/**
 * What a style reader returned, as the app takes it: at most
 * {@link MAX_PAGE_STYLE_SHEETS} sheets, each with a usable address or none
 * (a block of the page), a readable one with its mark and length, and its
 * text only when it is within {@link MAX_STYLE_SHEET_BYTES}. Anything else
 * is left out; null when the value is not in this shape at all. Never
 * throws.
 */
export function pageStylesOf(value: unknown): PageStyles | null {
  if (typeof value !== 'object' || value === null) return null;
  const given = (value as { sheets?: unknown }).sheets;
  if (!Array.isArray(given)) return null;
  const sheets: PageStyleSheet[] = [];
  for (const entry of given as unknown[]) {
    if (sheets.length >= MAX_PAGE_STYLE_SHEETS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const { address, readable, chars, mark, text } = entry as Record<string, unknown>;
    if (address !== undefined && (typeof address !== 'string' || !isSheetAddress(address))) {
      continue;
    }
    const at = typeof address === 'string' ? { address } : {};
    if (readable !== true) {
      // A sheet the page could not hand over is known by its address alone.
      if (readable === false && at.address) sheets.push({ ...at, readable: false });
      continue;
    }
    if (typeof mark !== 'string' || mark.length === 0 || mark.length > MAX_STYLE_MARK_CHARS) {
      continue;
    }
    if (typeof chars !== 'number' || !Number.isInteger(chars) || chars < 0) continue;
    const kept =
      typeof text === 'string' && utf8Bytes(text) <= MAX_STYLE_SHEET_BYTES ? { text } : {};
    sheets.push({ ...at, readable: true, chars, mark, ...kept });
  }
  return { sheets };
}
