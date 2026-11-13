import { MAX_PAGE_LINKS, pageKey } from '@atlas/importer-api';
import { create } from 'zustand';
import { DEFAULT_FOLLOW, isFollowLinks, type FollowLinks } from './followLinks';
import { SETTINGS, progressStore } from './services';

/**
 * What this app keeps about the pages of a wiki (an importer that reads
 * pages by fetching them), for the Library's wiki screen. Kept per importer
 * in the app's settings, which stay on this device and are never exported:
 *
 * - `wikiContents:<importer id>`: each wiki's contents as last read, by the
 *   page key of its address: its pages, titles and headings. Written when
 *   the person reads the contents ("Choose pages to read", or adding the
 *   wiki); nothing is read to keep it up to date.
 * - `wikiFailed:<importer id>`: pages that could not be read, by page key,
 *   with why and when. A page read later is taken off.
 * - `wikiLinks:<importer id>`: the pages of the same wiki each read page
 *   links to, as the importer gave them (`links` of the import outcome).
 *   During a go they are written every few seconds rather than after
 *   every page ({@link LINKS_WRITE_MS}).
 * - `wikiLeftOut:<importer id>`: the page keys of pages the person left
 *   out. They are never ticked or read until taken back in. A page read
 *   before is also hidden from Guides, among the person's own pages.
 * - `wikiFollow:<importer id>`: how far a go follows the links of the
 *   pages it reads (`followLinks.ts`), as the person last chose.
 *
 * Nothing here is fetched: these are notes on what the person read.
 */

/** A page of a wiki's contents. */
export interface WikiListedPage {
  url: string;
  title: string;
  group?: string;
}

/** A wiki's contents as last read. */
export interface WikiContents {
  /** The address the contents were read from. */
  address: string;
  /** The wiki's name, as its contents gave it. */
  game: string;
  /** When the contents were read (ISO time). */
  readAt: string;
  pages: WikiListedPage[];
}

/** Why a page could not be read. */
export interface WikiFailure {
  url: string;
  message: string;
  /** ISO time. */
  at: string;
}

export interface WikiNotes {
  contents: Record<string, WikiContents>;
  failed: Record<string, WikiFailure>;
  links: Record<string, string[]>;
  leftOut: string[];
  follow: FollowLinks;
}

export const NO_WIKI_NOTES: WikiNotes = {
  contents: {},
  failed: {},
  links: {},
  leftOut: [],
  follow: DEFAULT_FOLLOW,
};

/** Wikis' contents kept per importer, pages with failures and with links, left-out pages: at most. */
const MAX_CONTENTS = 50;
const MAX_FAILED = 2000;
const MAX_LINKED_PAGES = 2000;
const MAX_LEFT_OUT = 5000;

export const useWikiNotes = create<{ byImporter: Record<string, WikiNotes> }>()(() => ({
  byImporter: {},
}));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === 'string';

function readContents(value: unknown): Record<string, WikiContents> {
  if (!isRecord(value)) return {};
  const kept: Record<string, WikiContents> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry) || !isText(entry.address) || !Array.isArray(entry.pages)) continue;
    kept[key] = {
      address: entry.address,
      game: isText(entry.game) ? entry.game : '',
      readAt: isText(entry.readAt) ? entry.readAt : '',
      pages: entry.pages.flatMap((page: unknown): WikiListedPage[] =>
        isRecord(page) && isText(page.url) && isText(page.title)
          ? [
              {
                url: page.url,
                title: page.title,
                ...(isText(page.group) ? { group: page.group } : {}),
              },
            ]
          : [],
      ),
    };
  }
  return kept;
}

function readFailed(value: unknown): Record<string, WikiFailure> {
  if (!isRecord(value)) return {};
  const kept: Record<string, WikiFailure> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isRecord(entry) && isText(entry.url) && isText(entry.message)) {
      kept[key] = { url: entry.url, message: entry.message, at: isText(entry.at) ? entry.at : '' };
    }
  }
  return kept;
}

function readLinks(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const kept: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry)) kept[key] = entry.filter(isText).slice(0, MAX_PAGE_LINKS);
  }
  return kept;
}

const readLeftOut = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter(isText).slice(0, MAX_LEFT_OUT) : [];

const loading = new Map<string, Promise<WikiNotes>>();

/** Reads the notes of an importer's wikis, once; later calls get what is kept here. */
export function loadWikiNotes(importerId: string): Promise<WikiNotes> {
  const known = useWikiNotes.getState().byImporter[importerId];
  if (known) return Promise.resolve(known);
  let pending = loading.get(importerId);
  if (!pending) {
    pending = (async () => {
      const store = progressStore();
      const get = (key: string) => store.getSetting(key).catch((): unknown => undefined);
      const [contents, failed, links, leftOut, follow] = await Promise.all([
        get(SETTINGS.wikiContents(importerId)),
        get(SETTINGS.wikiFailed(importerId)),
        get(SETTINGS.wikiLinks(importerId)),
        get(SETTINGS.wikiLeftOut(importerId)),
        get(SETTINGS.wikiFollow(importerId)),
      ]);
      const notes: WikiNotes = {
        contents: readContents(contents),
        failed: readFailed(failed),
        links: readLinks(links),
        leftOut: readLeftOut(leftOut),
        follow: isFollowLinks(follow) ? follow : DEFAULT_FOLLOW,
      };
      // Changes made while reading win.
      const now = useWikiNotes.getState().byImporter[importerId];
      if (!now) setNotes(importerId, notes);
      loading.delete(importerId);
      return now ?? notes;
    })();
    loading.set(importerId, pending);
  }
  return pending;
}

function setNotes(importerId: string, notes: WikiNotes): void {
  useWikiNotes.setState((s) => ({ byImporter: { ...s.byImporter, [importerId]: notes } }));
}

/** Writes are made one after another, so the last change is the one kept. */
let writing: Promise<unknown> = Promise.resolve();

const settingOf = (importerId: string, part: keyof WikiNotes) =>
  ({
    contents: SETTINGS.wikiContents,
    failed: SETTINGS.wikiFailed,
    links: SETTINGS.wikiLinks,
    leftOut: SETTINGS.wikiLeftOut,
    follow: SETTINGS.wikiFollow,
  })[part](importerId);

/** Writes one part of an importer's notes as they are now, after the writes before it. */
function write(importerId: string, part: keyof WikiNotes): Promise<unknown> {
  writing = writing
    .then(() => {
      const notes = useWikiNotes.getState().byImporter[importerId];
      return notes ? progressStore().putSetting(settingOf(importerId, part), notes[part]) : null;
    })
    .catch(() => undefined);
  return writing;
}

/**
 * The links of a wiki's pages can grow large (a page may link to a
 * thousand others, and a go may read a thousand pages), so during a go they
 * are written at most this often, not after every page; {@link
 * flushWikiNotes} writes them at once, at the end of a go.
 */
export const LINKS_WRITE_MS = 10_000;

/** Parts written soon rather than now, by importer. */
const pending = new Map<string, Set<keyof WikiNotes>>();
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/** Writes the notes kept to write soon, now. */
export async function flushWikiNotes(): Promise<void> {
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
  const parts = [...pending];
  pending.clear();
  for (const [importerId, names] of parts) {
    for (const part of names) void write(importerId, part);
  }
  await writing;
}

async function change(
  importerId: string,
  part: keyof WikiNotes,
  next: (notes: WikiNotes) => WikiNotes,
  { soon = false }: { soon?: boolean } = {},
): Promise<void> {
  const loaded = await loadWikiNotes(importerId);
  // The notes as they are now: another change may have been made meanwhile.
  const notes = next(useWikiNotes.getState().byImporter[importerId] ?? loaded);
  setNotes(importerId, notes);
  if (!soon) {
    pending.get(importerId)?.delete(part);
    await write(importerId, part);
    return;
  }
  const names = pending.get(importerId) ?? new Set();
  names.add(part);
  pending.set(importerId, names);
  pendingTimer ??= setTimeout(() => {
    pendingTimer = null;
    void flushWikiNotes();
  }, LINKS_WRITE_MS);
}

// Notes kept to write soon are written when the app's page goes away, as far as it can.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    void flushWikiNotes();
  });
}

/** The newest `max` entries of a record, the one given last. */
function withLast<T>(record: Record<string, T>, key: string, value: T, max: number) {
  const { [key]: _old, ...rest } = record;
  const entries = [...Object.entries(rest), [key, value] as const];
  return Object.fromEntries(entries.slice(-max)) as Record<string, T>;
}

/** Keeps a wiki's contents as just read from `address`. */
export function noteWikiContents(
  importerId: string,
  address: string,
  game: string,
  pages: readonly { url: string; title: string; group?: string | undefined }[],
): Promise<void> {
  const contents: WikiContents = {
    address,
    game,
    readAt: new Date().toISOString(),
    pages: pages.map((page) => ({
      url: page.url,
      title: page.title,
      ...(page.group ? { group: page.group } : {}),
    })),
  };
  return change(importerId, 'contents', (notes) => ({
    ...notes,
    contents: withLast(notes.contents, pageKey(address), contents, MAX_CONTENTS),
  }));
}

/** A page was read: it is off the pages that could not be read, and its links are kept. */
export async function noteWikiRead(
  importerId: string,
  url: string,
  links: readonly string[],
): Promise<void> {
  const key = pageKey(url);
  const notes = await loadWikiNotes(importerId);
  if (key in notes.failed) {
    await change(importerId, 'failed', (n) => {
      const { [key]: _gone, ...failed } = n.failed;
      return { ...n, failed };
    });
  }
  if (links.length > 0 || key in notes.links) {
    await change(
      importerId,
      'links',
      (n) => {
        if (links.length > 0) {
          return { ...n, links: withLast(n.links, key, [...links], MAX_LINKED_PAGES) };
        }
        const { [key]: _gone, ...rest } = n.links;
        return { ...n, links: rest };
      },
      { soon: true },
    );
  }
}

/**
 * The links of pages read before, as the importer gave them when it wrote
 * those pages again (`writtenAgain` of the import outcome): kept as the
 * links of a page just read, but nothing else about the pages changes (a
 * note that one could not be read again stays).
 */
export async function noteWikiLinks(
  importerId: string,
  pages: readonly { url: string; links: readonly string[] }[],
): Promise<void> {
  if (pages.length === 0) return;
  await change(
    importerId,
    'links',
    (n) => {
      // The pages given last are the newest, as for pages read one by one.
      const links = new Map(Object.entries(n.links));
      for (const page of pages) {
        const key = pageKey(page.url);
        links.delete(key);
        if (page.links.length > 0) links.set(key, [...page.links]);
      }
      return { ...n, links: Object.fromEntries([...links].slice(-MAX_LINKED_PAGES)) };
    },
    { soon: true },
  );
}

/** A page could not be read, and why. */
export function noteWikiFailed(importerId: string, url: string, message: string): Promise<void> {
  const failure: WikiFailure = { url, message, at: new Date().toISOString() };
  return change(importerId, 'failed', (notes) => ({
    ...notes,
    failed: withLast(notes.failed, pageKey(url), failure, MAX_FAILED),
  }));
}

/** Leaves pages out, or takes them back in. */
export function setWikiLeftOut(
  importerId: string,
  urls: readonly string[],
  leftOut: boolean,
): Promise<void> {
  const keys = new Set(urls.map(pageKey));
  return change(importerId, 'leftOut', (notes) => {
    const others = notes.leftOut.filter((key) => !keys.has(key));
    return { ...notes, leftOut: leftOut ? [...others, ...keys].slice(-MAX_LEFT_OUT) : others };
  });
}

/** Keeps how far a go follows links, as the person chose it for this importer's wikis. */
export function setWikiFollow(importerId: string, follow: FollowLinks): Promise<void> {
  return change(importerId, 'follow', (notes) => ({ ...notes, follow }));
}

/** The page keys the person left out, of an importer's wikis. */
export async function leftOutKeys(importerId: string): Promise<Set<string>> {
  return new Set((await loadWikiNotes(importerId)).leftOut);
}

/**
 * How many pages a wiki's contents list, for the wiki a game was read from
 * (the contents that list one of the pages it was made from); null when
 * its contents were not read on this computer.
 */
export function listedPages(
  notes: WikiNotes | undefined,
  read: readonly { url: string }[],
): number | null {
  if (!notes || read.length === 0) return null;
  const keys = new Set(read.map((page) => pageKey(page.url)));
  const contents = Object.values(notes.contents).find((entry) =>
    entry.pages.some((page) => keys.has(pageKey(page.url))),
  );
  return contents ? contents.pages.length : null;
}
