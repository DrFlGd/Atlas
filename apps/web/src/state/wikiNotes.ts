import {
  MAX_PAGE_LINKS,
  MAX_SITE_KEY_CHARS,
  isConfirmedLicence,
  isReadingWay,
  pageKey,
  type ConfirmedLicence,
  type ReadingWay,
} from '@atlas/importer-api';
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
 * - `wikiPageLinks:<importer id>:<page key>`: the pages of the same wiki
 *   a read page links to, as the importer gave them (`links` of the import
 *   outcome), one record per page, so that a change writes only the pages
 *   that changed, however large the wiki. During a go they are written
 *   every few seconds rather than after every page ({@link
 *   LINKS_WRITE_MS}). Version 0.6.1 kept them all in one record,
 *   `wikiLinks:<importer id>`; it is still read, moved to records per page
 *   and then emptied.
 * - `wikiOtherNames:<importer id>`: other names of pages read, by page
 *   key: a page asked for under one address and read from another of the
 *   same wiki (the wiki forwarded it, or names it otherwise; `pageAddress`
 *   of the import outcome), with the address it was read from. Both are
 *   one page: one row on the wiki's screen, read, and never fetched again
 *   under the other name. Kept as each page is read, and learnt again from
 *   the pages kept when a game is built again from them.
 * - `wikiLeftOut:<importer id>`: the page keys of pages the person left
 *   out. They are never ticked or read until taken back in. A page read
 *   before is also hidden from Guides, among the person's own pages.
 * - `wikiFollow:<importer id>`: how far a go follows the links of the
 *   pages it reads (`followLinks.ts`), as the person last chose.
 * - `wikiSites:<importer id>`: the person's choices for each site of the
 *   importer, by the key the importer gives the site (`siteInfo` of the
 *   contract): how its pages are read, among the ways the importer offers
 *   (`way`), and the Creative Commons licence the person confirmed for a
 *   site whose pages state none (`licence`). A choice stays until the
 *   person changes it; the app never changes it by itself.
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

/** The person's choices for one site of an importer. */
export interface SiteChoices {
  /** How its pages are read, as the person chose; the importer's first way until then. */
  way?: ReadingWay;
  /** The licence the person confirmed for it, when its pages state none. */
  licence?: ConfirmedLicence;
}

export interface WikiNotes {
  contents: Record<string, WikiContents>;
  failed: Record<string, WikiFailure>;
  links: Record<string, string[]>;
  /** The address each other name (page key) of a page read leads to. */
  otherNames: Record<string, string>;
  leftOut: string[];
  follow: FollowLinks;
  sites: Record<string, SiteChoices>;
}

export const NO_WIKI_NOTES: WikiNotes = {
  contents: {},
  failed: {},
  links: {},
  otherNames: {},
  leftOut: [],
  follow: DEFAULT_FOLLOW,
  sites: {},
};

/**
 * Wikis' contents kept per importer, pages with failures and with links,
 * left-out pages: at most. A go has no page limit, so the bounds on pages
 * are far above the pages of a large wiki (tens of thousands), so its
 * notes are never cut short; they are only there so that an importer that
 * goes wrong cannot fill the settings without end.
 */
const MAX_CONTENTS = 50;
export const MAX_FAILED = 100_000;
export const MAX_LINKED_PAGES = 100_000;
export const MAX_LEFT_OUT = 100_000;
export const MAX_OTHER_NAMES = 100_000;
/** Sites with choices kept, per importer. */
export const MAX_SITES = 1_000;

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

function readSites(value: unknown): Record<string, SiteChoices> {
  if (!isRecord(value)) return {};
  const kept: Record<string, SiteChoices> = {};
  for (const [key, entry] of Object.entries(value).slice(-MAX_SITES)) {
    if (!isRecord(entry) || key.length > MAX_SITE_KEY_CHARS) continue;
    const choices: SiteChoices = {
      ...(isReadingWay(entry.way) ? { way: entry.way } : {}),
      ...(isConfirmedLicence(entry.licence)
        ? {
            licence: {
              name: entry.licence.name,
              url: entry.licence.url,
              confirmedAt: entry.licence.confirmedAt,
            },
          }
        : {}),
    };
    if (choices.way || choices.licence) kept[key] = choices;
  }
  return kept;
}

function readOtherNames(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const kept: Record<string, string> = {};
  for (const [key, address] of Object.entries(value).slice(-MAX_OTHER_NAMES)) {
    if (isText(address) && key.length > 0) kept[key] = address;
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
      const prefix = SETTINGS.wikiPageLinksOf(importerId);
      const [contents, failed, oldLinks, pageLinks, otherNames, leftOut, follow, sites] =
        await Promise.all([
          get(SETTINGS.wikiContents(importerId)),
          get(SETTINGS.wikiFailed(importerId)),
          get(SETTINGS.wikiLinks(importerId)),
          store.listSettings(prefix).catch((): { key: string; value: unknown }[] => []),
          get(SETTINGS.wikiOtherNames(importerId)),
          get(SETTINGS.wikiLeftOut(importerId)),
          get(SETTINGS.wikiFollow(importerId)),
          get(SETTINGS.wikiSites(importerId)),
        ]);
      // The record of 0.6.1 first; a record per page, newer, wins.
      const byPage = new Map(Object.entries(readLinks(oldLinks)));
      const moving = new Set(byPage.keys());
      for (const { key, value } of pageLinks) {
        const page = key.slice(prefix.length);
        moving.delete(page);
        const kept = Array.isArray(value) ? value.filter(isText).slice(0, MAX_PAGE_LINKS) : [];
        if (kept.length > 0) byPage.set(page, kept);
        else byPage.delete(page);
      }
      const links = Object.fromEntries(byPage);
      const notes: WikiNotes = {
        contents: readContents(contents),
        failed: readFailed(failed),
        links,
        otherNames: readOtherNames(otherNames),
        leftOut: readLeftOut(leftOut),
        follow: isFollowLinks(follow) ? follow : DEFAULT_FOLLOW,
        sites: readSites(sites),
      };
      // The links of 0.6.1 move to a record per page, once, and their old record is emptied.
      if (oldLinks !== undefined && oldLinks !== null) {
        markLinks(importerId, moving);
        emptyOldLinks.add(importerId);
      }
      // Changes made while reading win.
      const now = useWikiNotes.getState().byImporter[importerId];
      if (!now) setNotes(importerId, notes);
      if (emptyOldLinks.has(importerId)) void write(importerId, 'links');
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

const settingOf = (importerId: string, part: Exclude<keyof WikiNotes, 'links'>) =>
  ({
    contents: SETTINGS.wikiContents,
    failed: SETTINGS.wikiFailed,
    otherNames: SETTINGS.wikiOtherNames,
    leftOut: SETTINGS.wikiLeftOut,
    follow: SETTINGS.wikiFollow,
    sites: SETTINGS.wikiSites,
  })[part](importerId);

/** Pages whose links changed since they were last written, by importer. */
const changedLinks = new Map<string, Set<string>>();
/** Importers whose links of 0.6.1, in one record, are to be emptied once moved. */
const emptyOldLinks = new Set<string>();

/** Notes that the links of these pages (page keys) are to be written. */
function markLinks(importerId: string, keys: Iterable<string>): void {
  const marked = changedLinks.get(importerId) ?? new Set<string>();
  for (const key of keys) marked.add(key);
  changedLinks.set(importerId, marked);
}

/**
 * The links of a wiki's pages with some pages' links set (or removed, for
 * none), at most {@link MAX_LINKED_PAGES} pages (the first noted are
 * dropped first); every page changed or dropped is marked to be written.
 */
function withLinks(
  importerId: string,
  links: Record<string, string[]>,
  pages: readonly (readonly [key: string, links: readonly string[]])[],
): Record<string, string[]> {
  // A copy, changed in place: a wiki's links are read after every page of a go.
  let next: Record<string, string[]> = { ...links };
  for (const [key, given] of pages) {
    if (given.length > 0) {
      next[key] = [...given];
    } else if (key in next) {
      const { [key]: _gone, ...rest } = next;
      next = rest;
    }
  }
  markLinks(
    importerId,
    pages.map(([key]) => key),
  );
  const keys = Object.keys(next);
  if (keys.length > MAX_LINKED_PAGES) {
    const dropped = new Set(keys.slice(0, keys.length - MAX_LINKED_PAGES));
    next = Object.fromEntries(Object.entries(next).filter(([key]) => !dropped.has(key)));
    markLinks(importerId, dropped);
  }
  return next;
}

/** Writes the links of the pages marked, a record per page, and empties the record of 0.6.1 once they are moved. */
async function writeLinks(importerId: string, notes: WikiNotes): Promise<void> {
  const keys = [...(changedLinks.get(importerId) ?? [])];
  changedLinks.delete(importerId);
  try {
    await progressStore().putSettings(
      keys.map((key) => ({
        key: SETTINGS.wikiPageLinks(importerId, key),
        value: notes.links[key] ?? null,
      })),
    );
    if (emptyOldLinks.delete(importerId)) {
      await progressStore().putSetting(SETTINGS.wikiLinks(importerId), null);
    }
  } catch (error) {
    // Written next time.
    markLinks(importerId, keys);
    throw error;
  }
}

/** Writes one part of an importer's notes as they are now, after the writes before it. */
function write(importerId: string, part: keyof WikiNotes): Promise<unknown> {
  writing = writing
    .then(() => {
      const notes = useWikiNotes.getState().byImporter[importerId];
      if (!notes) return null;
      if (part === 'links') return writeLinks(importerId, notes);
      return progressStore().putSetting(settingOf(importerId, part), notes[part]);
    })
    .catch(() => undefined);
  return writing;
}

/**
 * The links of a wiki's pages can grow large (a page may link to a
 * thousand others, and a wiki may have tens of thousands of pages), so
 * they are kept a record per page and, during a go, written at most this
 * often, not after every page: each write holds only the pages read since
 * the last one. {@link flushWikiNotes} writes them at once, at the end of
 * a go.
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

/** A page read, as the app notes it: its address asked, its links, and where it was read from. */
export interface PageRead {
  url: string;
  links: readonly string[];
  /** The address it was read from, when that is another name of it (`pageAddress`). */
  pageAddress?: string | undefined;
}

/** The other names of pages with these pages' (asked under one, read from another). */
function withOtherNames(
  otherNames: Record<string, string>,
  pages: readonly PageRead[],
): Record<string, string> | null {
  let next: Record<string, string> | null = null;
  for (const page of pages) {
    if (!page.pageAddress) continue;
    const asked = pageKey(page.url);
    const at = pageKey(page.pageAddress);
    // A page of its own again, under the address it was read from.
    if ((next ?? otherNames)[at] !== undefined) {
      const { [at]: _gone, ...rest } = next ?? otherNames;
      next = rest;
    }
    if (asked === at || (next ?? otherNames)[asked] === page.pageAddress) continue;
    next = withLast(next ?? otherNames, asked, page.pageAddress, MAX_OTHER_NAMES);
  }
  return next;
}

/**
 * Pages were read (or written again from their kept data): they are off
 * the pages that could not be read, their links are kept, under the
 * address each was read from, and their other names.
 */
async function noteRead(
  importerId: string,
  pages: readonly PageRead[],
  { clearFailed }: { clearFailed: boolean },
): Promise<void> {
  if (pages.length === 0) return;
  const notes = await loadWikiNotes(importerId);
  const otherNames = withOtherNames(notes.otherNames, pages);
  if (otherNames) {
    await change(importerId, 'otherNames', (n) => ({
      ...n,
      otherNames: withOtherNames(n.otherNames, pages) ?? n.otherNames,
    }));
  }
  // A page read is not one that could not be read, under either of its names.
  const tried = clearFailed
    ? pages.flatMap((page) => [
        pageKey(page.url),
        ...(page.pageAddress ? [pageKey(page.pageAddress)] : []),
      ])
    : pages.flatMap((page) => (page.pageAddress ? [pageKey(page.pageAddress)] : []));
  if (tried.some((key) => key in notes.failed)) {
    await change(importerId, 'failed', (n) => ({
      ...n,
      failed: Object.fromEntries(Object.entries(n.failed).filter(([key]) => !tried.includes(key))),
    }));
  }
  // The links are kept under the address the page was read from; any under its other name go.
  const entries = pages.flatMap((page): (readonly [string, readonly string[]])[] => {
    const asked = pageKey(page.url);
    const at = page.pageAddress ? pageKey(page.pageAddress) : asked;
    return at === asked
      ? [[at, page.links]]
      : [
          [asked, []],
          [at, page.links],
        ];
  });
  if (entries.some(([key, links]) => links.length > 0 || key in notes.links)) {
    await change(
      importerId,
      'links',
      (n) => ({ ...n, links: withLinks(importerId, n.links, entries) }),
      { soon: true },
    );
  }
}

/** A page was read: it is off the pages that could not be read, and its links are kept. */
export function noteWikiRead(
  importerId: string,
  url: string,
  links: readonly string[],
  pageAddress?: string,
): Promise<void> {
  return noteRead(importerId, [{ url, links, pageAddress }], { clearFailed: true });
}

/**
 * The links of pages read before, as the importer gave them when it wrote
 * those pages again (`writtenAgain` of the import outcome): kept as the
 * links of a page just read, with the other name of a page kept under
 * another one; nothing else about the pages changes (a note that one
 * could not be read again stays).
 */
export function noteWikiLinks(importerId: string, pages: readonly PageRead[]): Promise<void> {
  return noteRead(importerId, pages, { clearFailed: false });
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

/** Changes the person's choices for one site of an importer, and keeps them. */
function changeSite(
  importerId: string,
  key: string,
  next: (choices: SiteChoices) => SiteChoices,
): Promise<void> {
  return change(importerId, 'sites', (notes) => {
    const choices = next(notes.sites[key] ?? {});
    const { [key]: _old, ...others } = notes.sites;
    const kept = choices.way || choices.licence ? { ...others, [key]: choices } : others;
    return { ...notes, sites: Object.fromEntries(Object.entries(kept).slice(-MAX_SITES)) };
  });
}

/** Keeps how the person chose to read a site's pages. */
export function setSiteWay(importerId: string, key: string, way: ReadingWay): Promise<void> {
  return changeSite(importerId, key, (choices) => ({ ...choices, way }));
}

/** Keeps the licence the person confirmed for a site, or forgets it (null). */
export function setSiteLicence(
  importerId: string,
  key: string,
  licence: ConfirmedLicence | null,
): Promise<void> {
  return changeSite(importerId, key, ({ licence: _old, ...choices }) =>
    licence ? { ...choices, licence } : choices,
  );
}

/** The person's choices for a site of an importer, as kept. */
export async function siteChoices(importerId: string, key: string): Promise<SiteChoices> {
  return (await loadWikiNotes(importerId)).sites[key] ?? {};
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
