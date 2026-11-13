import {
  readingWayOf,
  siteInfoOf,
  type AtlasImporter,
  type ConfirmedLicence,
  type ReadingWay,
  type SiteInfo,
} from '@atlas/importer-api';
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
  };
}

/**
 * Whether adding from this site first asks how to read it: when the
 * importer offers more than one way, or says something about the site,
 * and the person has not chosen yet.
 */
export const asksHow = (reading: SiteReading): boolean =>
  !reading.chosen && (reading.info.ways.length > 1 || reading.info.notice !== undefined);

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
};

/** What each way does, in a sentence. */
export const WAY_TEXTS: Record<ReadingWay, string> = {
  fetch:
    'This app asks the site for each page itself, one at a time with a pause, as its robots.txt allows. A site that asks to confirm you are a person stops it.',
  window:
    'Each page opens in a window of this app, one at a time with a pause, where you answer the site’s check yourself if it shows one. This app never answers it for you.',
};

/** The sentence added to a refusal when the site can also be read in a window of this app. */
export const WINDOW_HINT =
  'You can choose to read this wiki “In a window of this app” on its screen in the Library, where you answer the site’s check yourself.';
