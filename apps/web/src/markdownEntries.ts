import type { MarkdownIt, StateCore, Token } from 'markdown-it';

/**
 * Entries of a wiki page that are on the map (see `mapEntries.ts`): a small
 * map mark after each, which shows the entry's locations when pressed.
 *
 * What counts as an entry:
 *
 * - a link to a page that is linked to a location (`MapEntryOptions.pageLocations`);
 * - an in-app link to a location, as a web link that names one by its
 *   site's id becomes (see `MarkdownOptions.mapLink`);
 * - a plain name that is exactly the name of one location of the game, and
 *   of no other (`MapEntryOptions.nameLocation`), only as the whole first
 *   cell of a table's row, or the first words of a list's item (bold or
 *   not), never in running text.
 *
 * With `MapEntryOptions.adding`, entries that are not on the map have a
 * mark too, which puts one on the map (see `mapEntries.ts`): a link to a
 * page with no location, the first cell of a table's row, and a list's
 * item's bold first words, or its first words before a colon or a dash
 * between spaces, that name no location.
 *
 * The marks are buttons the renderer makes, holding only the page's id or
 * the location's (`data-map-entry`) or the entry's words, escaped
 * (`data-map-add`). Nothing is stored.
 */

export interface MapEntryOptions {
  /** The locations an in-app link to this page stands for, none when it stands for none. */
  pageLocations: (guideId: string) => readonly string[];
  /** The one location of the game with this exact name, or null. */
  nameLocation: (name: string) => string | null;
  /** Whether a content id is a location of the game. */
  isLocation: (id: string) => boolean;
  /** Whether entries not on the map have a mark that adds them. */
  adding?: boolean;
}

/** The longest entry words a list's item gives: a name, not a sentence. */
const MAX_ENTRY_WORDS = 8;
const MAX_ENTRY_CHARS = 80;
/** What ends the first words of a list's item. */
const ENTRY_END = /^(?:\s*$|\s*[,.:;()[\]]|\s+[-–—](?:\s|$))/u;

interface EntryMeta {
  mapEntry?: { kind: 'page' | 'location'; id: string; label: string };
  mapAdd?: { label: string; page?: string };
}

function markToken(state: StateCore, meta: EntryMeta): Token {
  const token = new state.Token('atlas_map_entry', 'button', 0);
  token.meta = { ...meta };
  return token;
}

/** The words of an inline run of tokens, as read. */
function wordsOf(tokens: readonly Token[]): string {
  return tokens
    .map((t) => (t.type === 'text' || t.type === 'code_inline' ? t.content : ''))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * The first words of a text that make a location's name, the longest that
 * do and end at a word's end before a separator: their length, and the
 * location. Null when none do.
 */
function namePrefix(
  text: string,
  nameLocation: (name: string) => string | null,
): { length: number; id: string } | null {
  const words = [...text.matchAll(/\S+/gu)].slice(0, MAX_ENTRY_WORDS);
  for (let n = words.length; n >= 1; n--) {
    const last = words[n - 1]!;
    let end = last.index + last[0].length;
    // A word's own trailing comma or colon is not part of the name.
    while (end > 0 && /[,.:;]/u.test(text[end - 1]!)) end--;
    const name = text.slice(0, end);
    if (name.length < 3 || !ENTRY_END.test(text.slice(end))) continue;
    const id = nameLocation(name);
    if (id) return { length: end, id };
  }
  return null;
}

/**
 * The first words of a list's item that name an entry not on the map: those
 * before a colon or a dash between spaces ("Hay barn – north"), as a list of
 * things is written. Null for words that end otherwise, as a sentence does.
 */
function entryWords(text: string): string | null {
  const words = [...text.matchAll(/\S+/gu)].slice(0, MAX_ENTRY_WORDS);
  for (let n = 1; n <= words.length; n++) {
    const word = words[n - 1]!;
    let end = word.index + word[0].length;
    while (end > 0 && /[,.;]/u.test(text[end - 1]!)) end--;
    const after = text.slice(end);
    if (word[0].endsWith(':') || /^\s+[-–—]\s/u.test(after)) {
      if (word[0].endsWith(':')) end -= 1;
      const found = text.slice(0, end).trim();
      return found.length >= 2 && found.length <= MAX_ENTRY_CHARS ? found : null;
    }
    if (ENTRY_END.test(after)) return null;
  }
  return null;
}

/** Marks the links of an inline block that are entries. */
function markLinks(state: StateCore, block: Token, options: MapEntryOptions): void {
  const children = block.children!;
  const out: Token[] = [];
  let open: Token | null = null;
  let inside: Token[] = [];
  for (const token of children) {
    out.push(token);
    if (token.type === 'link_open') {
      open = token;
      inside = [];
      continue;
    }
    if (!open) continue;
    if (token.type !== 'link_close') {
      inside.push(token);
      continue;
    }
    const raw = open.attrGet('data-atlas-target');
    const target = raw === null ? null : String(raw);
    const label = wordsOf(inside) || 'this entry';
    open = null;
    if (target === null) continue;
    if (options.isLocation(target)) {
      out.push(markToken(state, { mapEntry: { kind: 'location', id: target, label } }));
    } else if (target.includes(':guide:')) {
      if (options.pageLocations(target).length > 0) {
        out.push(markToken(state, { mapEntry: { kind: 'page', id: target, label } }));
      } else if (options.adding) {
        out.push(markToken(state, { mapAdd: { label, page: target } }));
      }
    }
  }
  block.children = out;
}

/**
 * Marks the entry at the start of an inline block (a table's first cell, a
 * list's first words): a location's name, or with `adding`, the words of
 * one not on the map. A block that starts with a link is the link's.
 */
function markStart(state: StateCore, block: Token, options: MapEntryOptions, whole: boolean): void {
  const children = block.children!;
  // Empty text before bold words is nothing.
  while (children.length > 1 && children[0]!.type === 'text' && children[0]!.content === '') {
    children.shift();
  }
  const first = children[0];
  if (!first || first.type === 'link_open') return;
  // Bold first words: the words inside it are the entry.
  if (first.type === 'strong_open') {
    const close = children.findIndex((t) => t.type === 'strong_close');
    if (close < 0 || children.slice(1, close).some((t) => t.type === 'link_open')) return;
    const words = wordsOf(children.slice(1, close));
    if (!words || words.length > MAX_ENTRY_CHARS) return;
    if (whole && wordsOf(children.slice(close + 1)) !== '') return;
    const id = options.nameLocation(words);
    const meta: EntryMeta | null = id
      ? { mapEntry: { kind: 'location', id, label: words } }
      : options.adding
        ? { mapAdd: { label: words } }
        : null;
    if (meta) children.splice(close + 1, 0, markToken(state, meta));
    return;
  }
  if (first.type !== 'text') return;
  if (whole) {
    if (children.length !== 1) return;
    const words = first.content.trim();
    if (!words || words.length > MAX_ENTRY_CHARS) return;
    const id = options.nameLocation(words);
    const meta: EntryMeta | null = id
      ? { mapEntry: { kind: 'location', id, label: words } }
      : options.adding && words.length >= 2
        ? { mapAdd: { label: words } }
        : null;
    if (meta) children.push(markToken(state, meta));
    return;
  }
  const text = first.content;
  const found = namePrefix(text, options.nameLocation);
  const words = found ? text.slice(0, found.length) : options.adding ? entryWords(text) : null;
  if (!words) return;
  const head = new state.Token('text', '', 0);
  head.content = words;
  const tail = new state.Token('text', '', 0);
  tail.content = text.slice(words.length);
  const meta: EntryMeta = found
    ? { mapEntry: { kind: 'location', id: found.id, label: words.trim() } }
    : { mapAdd: { label: words.trim() } };
  children.splice(0, 1, head, markToken(state, meta), ...(tail.content ? [tail] : []));
}

/** The plugin: run with `MarkdownOptions.mapEntries` in the env. */
export function markdownEntries(md: MarkdownIt): void {
  md.core.ruler.push('atlas_map_entries', (state) => {
    const options = (state.env as { mapEntries?: MapEntryOptions } | undefined)?.mapEntries;
    if (!options) return;
    const tokens = state.tokens;
    let firstCell = false;
    let inBody = false;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.type === 'tbody_open') inBody = true;
      else if (token.type === 'tbody_close') inBody = false;
      else if (token.type === 'tr_open') firstCell = true;
      if (token.type !== 'inline' || !token.children) continue;
      const before = tokens[i - 1];
      const outer = tokens[i - 2];
      if (before?.type === 'td_open' && firstCell && inBody) {
        firstCell = false;
        markStart(state, token, options, true);
      } else if (before?.type === 'td_open' || before?.type === 'th_open') {
        firstCell = false;
      } else if (before?.type === 'paragraph_open' && outer?.type === 'list_item_open') {
        markStart(state, token, options, false);
      }
      markLinks(state, token, options);
    }
  });

  md.renderer.rules.atlas_map_entry = (tokens, index) => {
    const meta = tokens[index]!.meta as EntryMeta;
    const escape = md.utils.escapeHtml;
    if (meta.mapEntry) {
      const { kind, id, label } = meta.mapEntry;
      return `<button type="button" class="map-entry" data-map-entry="${escape(id)}" data-map-entry-kind="${kind}" data-map-label="${escape(label)}" aria-label="Show ${escape(label)} on the map" title="Show on the map">${MAP_MARK}</button>`;
    }
    const { label, page } = meta.mapAdd!;
    return `<button type="button" class="map-entry map-entry-add" data-map-add="${escape(label)}"${page ? ` data-map-add-page="${escape(page)}"` : ''} aria-label="Put ${escape(label)} on the map" title="Put it on the map">${ADD_MARK}</button>`;
  };
}

/** A folded map, drawn small: the app's own map icon. */
const MAP_MARK =
  '<svg viewBox="0 0 20 20" width="1em" height="1em" aria-hidden="true" focusable="false"><path d="M2.5 5l5-2l5 2l5-2v12l-5 2l-5-2l-5 2zM7.5 3v12M12.5 5v12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
/** A pin with a plus. */
const ADD_MARK =
  '<svg viewBox="0 0 20 20" width="1em" height="1em" aria-hidden="true" focusable="false"><path d="M10 18c-3.6-4-5.5-7-5.5-9.5a5.5 5.5 0 0 1 11 0c0 2.5-1.9 5.5-5.5 9.5zM10 5.8v5.4M7.3 8.5h5.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
