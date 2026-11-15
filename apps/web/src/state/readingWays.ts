import {
  readingWayOf,
  siteInfoOf,
  type AtlasImporter,
  type ConfirmedLicence,
  type PictureSize,
  type ReadingWay,
  type SiteInfo,
} from '@atlas/importer-api';
import type { ListedPack } from '../desktop';
import { loadWikiNotes, NO_WIKI_NOTES } from './wikiNotes';

/**
 * How the pages of a site are read, as the person chose among the ways its
 * importer offers (`siteInfo` of the contract), and the licence they
 * confirmed for it. The choices are kept with the importer's wiki notes
 * (`wikiNotes.ts`, by the site's key); the app never changes them by itself.
 * Nothing here reads a page: an importer answers from the address alone.
 */

/** A site as its importer describes it, with the person's choices for it. */
export interface SiteReading {
  info: SiteInfo;
  /** The way its pages are read now: the one chosen, else the importer's first. */
  way: ReadingWay;
  /** The person chose that way (it is not only the importer's first). */
  chosen: boolean;
  /** The licence the person confirmed for the site, if any. */
  licence?: ConfirmedLicence;
  /** The size its pictures are kept at: the one chosen, else {@link DEFAULT_PICTURE_SIZE}. */
  pictures: PictureSize;
}

/** The site of `url` for an importer, with the person's choices for it. */
export async function siteReading(importer: AtlasImporter, url: string): Promise<SiteReading> {
  const info = siteInfoOf(importer, url);
  const notes = await loadWikiNotes(importer.id).catch(() => NO_WIKI_NOTES);
  const kept = notes.sites[info.key] ?? {};
  const way = readingWayOf(info, kept.way);
  return {
    info,
    way,
    chosen: kept.way === way,
    ...(kept.licence ? { licence: kept.licence } : {}),
    pictures: kept.pictures ?? DEFAULT_PICTURE_SIZE,
  };
}

/** Whether the importer offers a choice for this site: more than one way, or something to say about it. */
export const offersChoice = (info: SiteInfo): boolean =>
  info.ways.length > 1 || info.notice !== undefined;

/**
 * Whether adding from this site first asks how to read it: when the
 * importer offers a choice ({@link offersChoice}), and either the person
 * has not chosen yet or no game read from the site is in the Library (a
 * wiki whose sessions kept nothing, or one deleted, is started again from
 * the question, with the way chosen before ticked). A wiki in the Library
 * has the choice on its own screen, so adding it again does not ask.
 */
export const asksHow = (reading: SiteReading, { inLibrary }: { inLibrary: boolean }): boolean =>
  offersChoice(reading.info) && (!reading.chosen || !inLibrary);

/** What the Library lists of a game, to tell the site it was read from. */
type ListedGame = Pick<ListedPack, 'imported' | 'pages'>;

/** Whether a game in the Library was read from the site `key` with this importer. */
export function siteInLibrary(
  importer: Pick<AtlasImporter, 'id' | 'siteInfo' | 'fetch' | 'pageReader' | 'browseReader'>,
  key: string,
  packs: readonly ListedGame[],
): boolean {
  return packs.some(
    (pack) =>
      pack.imported?.importerId === importer.id &&
      (pack.pages ?? []).some((page) => siteInfoOf(importer, page.url).key === key),
  );
}

/**
 * The way a page of an importer is read, when the importer says how its
 * sites are read (`siteInfo`); undefined for an importer that does not,
 * which reads as it always did (`fetch.inWindow`).
 */
export async function wayFor(
  importer: AtlasImporter,
  url: string,
): Promise<ReadingWay | undefined> {
  return importer.siteInfo ? (await siteReading(importer, url)).way : undefined;
}

/** The names of the ways, as the app shows them. */
export const WAY_LABELS: Record<ReadingWay, string> = {
  fetch: 'By itself',
  window: 'In a window of this app',
  browse: 'As I browse',
};

/** What each way does, in a sentence. */
export const WAY_TEXTS: Record<ReadingWay, string> = {
  fetch:
    'This app asks the site for each page itself, one at a time with a pause, as its robots.txt allows. A site that asks to confirm you are a person stops it.',
  window:
    'Each page opens in a window of this app, one at a time with a pause, where you answer the site’s check yourself if it shows one. This app never answers it for you.',
  browse:
    'You browse the wiki yourself in a window of this app, and each article page you open is kept, once. This app never opens or fetches a page by itself.',
};

/** The sentence added to a refusal when the site can also be read in a window of this app. */
export const WINDOW_HINT =
  'You can choose to read this wiki “In a window of this app” on its screen in the Library, where you answer the site’s check yourself.';

/**
 * The size the pictures of a site's pages are kept at until the person
 * chooses for the site (see `pictureSize` of the import context): `full`,
 * each picture's full file where the importer can tell it, with a copy
 * made for pages; or `shown`, each as its page shows it. The one place
 * the default is set.
 */
export const DEFAULT_PICTURE_SIZE: PictureSize = 'full';

/** The sizes pictures can be kept at, as the app shows them. */
export const PICTURE_SIZE_LABELS: Record<PictureSize, string> = {
  full: 'Full size',
  shown: 'As the page shows them',
};

/** What each size does, in a sentence. */
export const PICTURE_SIZE_TEXTS: Record<PictureSize, string> = {
  full: 'Each picture is downloaded once at the size of its file, so pressing it shows it large. This takes more disk space and a little more time than the small copies the pages show.',
  shown:
    'Each picture is downloaded at the size the page shows it, which is often a small copy. This takes the least space.',
};

/** What the choice changes for a wiki read before, in a sentence. */
export const PICTURE_SIZE_NOTE =
  'A change counts for pages read from now on. To change the pictures of the pages already read, build the wiki again from its saved pages; its pictures are then downloaded again.';
