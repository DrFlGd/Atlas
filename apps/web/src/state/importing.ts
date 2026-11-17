import { GuideContents, loadPack, type ContentsFiling, type PackEntry } from '@atlas/core';
import {
  DEFAULT_WAIT_SECONDS,
  FETCH_PAUSE_MS,
  HOME_PAGE_KIND,
  MAP_KIND,
  MAX_PAGE_DATA_CHARS,
  asImporter,
  checkCatalogue,
  checkGameListing,
  checkOutcome,
  checkPictureTiles,
  fetchAddresses,
  findImporter,
  findReader,
  gameAddressOf,
  isAllowedPageUrl,
  isPictureRequest,
  ownPageReaderOf,
  pageKey,
  readsInWindow,
  pageMeasureStep,
  pageTilesFit,
  refusalFor,
  refusalOf,
  robotsAllows,
  rulesFromAnswer,
  sameSite,
  siteInfoOf,
  siteLicenceOf,
  type AtlasImporter,
  type FetchedPage,
  type PageFetch,
  type RobotsRules,
  type Catalogue,
  type GameListing,
  type ImportContext,
  type ImportFailure,
  type ImportSummary,
  type ListingContext,
  type PageObservations,
  type PageStyles,
  type PictureSize,
  type PictureSummary,
  type PictureTiles,
  type PictureTilesRequest,
  type ReadingWay,
  type SavedSource,
  type SiteInfo,
  type SiteLicence,
  type WrittenAgain,
} from '@atlas/importer-api';
import {
  COLLECTION_NAMES,
  MANIFEST_FILE,
  PACK_COLLECTIONS,
  describePack,
  recordedImages,
  type PackData,
  type PackSource,
} from '@atlas/schema';
import { create } from 'zustand';
import type { ImporterEntry } from '../config';
import {
  desktop,
  type ImportReport,
  type Listing,
  type ShellFetchedPage,
  type StoredPage,
} from '../desktop';
import { downloadsOffered } from '../features';
import { loadGame, notify } from './actions';
import {
  ImportRun,
  checkAddresses,
  parseAddresses,
  runCounts,
  stopReasonText,
  tooManyMessage,
  type CheckedAddress,
  type PageOutcome,
  type RunState,
} from './importRun';
import { pagesToFollow, type FollowLinks } from './followLinks';
import { notePackSaved, packSaves, packTurn } from './packTurns';
import { packWritten } from './shownGameRefresh';
import {
  KEPT_POLL_MS,
  PageWindows,
  closedMessage,
  type PageRead,
  type PageWaiting,
  type Reading,
} from './pageWindow';
import { fetchMapPhotos, listsLocationPhotos, photosWithMapOn } from './mapPhotos';
import { openLayoutFrame } from '../layoutFrame/frame';
import type { KeptSheetText } from '../layoutFrame/frameText';
import {
  layoutReport,
  layoutText,
  pageLayouts,
  type LayoutReport,
  type LayoutTally,
  type PageLayouts,
} from './pageLayouts';
import { fetchPagePictures } from './pagePictures';
import {
  fetchSessionStyles,
  gameOfSite,
  keepFetchedStyles,
  keepPageStyles,
  marksFor,
  noteGameOfSite,
  noteHandedStyles,
  readPageStyles,
  sheetFromAnswer,
  type SheetAnswer,
} from './pageStyles';
import {
  choiceGame,
  keptCatalogue,
  newChoice,
  newPick,
  overCap,
  pickOpened,
  planPick,
  splitChosen,
  tickFrom,
  tickGames,
  tickPages,
  toggleGame,
  toggleGroup,
  togglePage,
  type Choice,
  type ChoiceGame,
  type ChosenPage,
  type GamePick,
  type KeptCatalogue,
  type RecordedPage,
} from './gameChoice';
import { RUN_PAUSE_MS } from './importRun';
import { applyListing } from './library';
import { gameKind, useGameFacts } from './gameFacts';
import { offerSameTitle } from './gameGroups';
import { showLibraryAdd, showLibraryGame } from './libraryView';
import {
  asksHow,
  DEFAULT_PICTURE_SIZE,
  offersChoice,
  siteInLibrary,
  siteReading,
  WINDOW_HINT,
  type SiteReading,
} from './readingWays';
import { SETTINGS, progressStore } from './services';
import { applySitesTo } from './siteRules';
import { useAtlas } from './store';
import {
  forgetSiteNotes,
  siteNotesHeld,
  type SiteNotesHeld,
  leftOutKeys,
  flushWikiNotes,
  loadWikiNotes,
  NO_WIKI_NOTES,
  noteWikiContents,
  noteWikiFailed,
  noteWikiLinks,
  noteWikiRead,
  setSiteLicence,
  setSiteWay,
} from './wikiNotes';

/**
 * "Add a map": the person pastes a page address, an importer that
 * recognises it is chosen, the shell opens the page in a window of its own
 * and reads the page data out of it with the importer's page reader, and
 * the importer turns that data into a pack, which the shell writes to the
 * maps folder. See `packages/importer-api` for the contract. Several
 * addresses are added one after another in the same way (`importRun.ts`).
 *
 * An importer may also read a game's page for the list of its maps (and
 * other pages), and the site's list of games. Those pages are opened in
 * the same window, one at a time with the same pause, and count as pages
 * of the go; the person then ticks what to add (`gameChoice.ts`), and the
 * chosen pages are added as a run. "Update" reads the game page of games
 * added before, or offers the pages they were made from.
 *
 * The page cannot call the app. Page data is untrusted: it is capped,
 * parsed as JSON and only handed to the importer's `convert`, whose result
 * is checked against the pack schema before anything is written.
 */

export type ImportPhase =
  | { kind: 'idle' }
  /** The page is open; the app asks it for its data every few seconds. */
  | {
      kind: 'waiting';
      url: string;
      importer: string;
      startedAt: number;
      now: number;
      waitSeconds: number;
      loading: boolean;
      note: string | null;
      /** The data has been read and the map picture is being measured from the page. */
      measuring?: boolean;
    }
  | {
      kind: 'converting';
      url: string;
      importer: string;
      /** The importer is measuring the map's picture (see {@link measurePicture}). */
      measuring?: boolean;
      /** It waits for another step changing the same game (see `packTurns.ts`). */
      waiting?: boolean;
      /** A page of a wiki written into its game of pages: no map is built. */
      pages?: boolean;
      /** A game of pages is built again from this many saved pages: nothing is fetched. */
      savedPages?: number;
      /** How many of them are written again so far, once the importer says. */
      savedDone?: number;
      /** The saved pages are laid out as a browser shows them before they are written. */
      layingOut?: boolean;
    }
  | {
      kind: 'done';
      packId: string;
      /** The map the page became; null for a checklist or a guide. */
      mapId: string | null;
      /** The guide the page became, when it became one. */
      guideId?: string;
      /** The pages of the same site it links to, when the importer gave them. */
      links?: string[];
      /** Other pages the importer wrote again, with the pages each links to. */
      writtenAgain?: WrittenAgain[];
      /** The address the page was read from, when that is another name of it. */
      pageAddress?: string;
      title: string;
      summary: ImportSummary;
      rebuilt: boolean;
      /** Its pictures are being fetched now (see `pagePictures.ts`). */
      pictures?: boolean;
      /** Its location photos are downloaded after its map images (see `mapPhotos.ts`). */
      photos?: boolean;
      /** A game of pages built again: how its pages are filed in its contents (see {@link pagesFiling}). */
      filing?: PagesFiling;
      /** A game of pages built again: whether its pages were laid out as a browser shows them. */
      layout?: LayoutReport;
    }
  /**
   * `refused`: the site refused or asked to confirm the reader is a person;
   * a run stops. `how`: the address of a site that can be read another way,
   * for the person to choose it. `declined`: the person did not confirm the
   * site's licence; a run stops.
   */
  | { kind: 'failed'; message: string; refused?: boolean; how?: string; declined?: boolean }
  /**
   * Before reading a site whose importer offers more than one way to read
   * it, or says something about it: the ways, the importer's notice, and
   * the way ticked now. Nothing has been read.
   */
  | {
      kind: 'how';
      url: string;
      importerId: string;
      importer: string;
      site: SiteInfo;
      way: ReadingWay;
    }
  /**
   * Browse and keep: the person browses a site in the app's window, and
   * each page they open is kept (see {@link startBrowse}). `ended` once the
   * window was closed or browsing was stopped.
   */
  | {
      kind: 'browse';
      url: string;
      importerId: string;
      importer: string;
      /** The site's key, for the person. */
      site: string;
      /** The pages kept, in the order they were opened. */
      kept: { url: string; title: string }[];
      /** What happened last, in a sentence. */
      note: string | null;
      ended: boolean;
    }
  /** Several addresses, some of which no importer recognises: shown before the run. */
  | {
      kind: 'check';
      addresses: { url: string; importer: string | null; problem: string | null }[];
      /** The titles of the importers of this app. */
      importers: string[];
    }
  /** Several pages, one after another; `shownPackId` is the game shown when it ended. */
  | { kind: 'run'; run: RunState; shownPackId: string | null; update: boolean }
  /** Pages that list others (game pages, a list of games) being read, one at a time. */
  | { kind: 'listing'; run: RunState; purpose: ListingPurpose }
  /** A site's list of games, to tick the games to add. */
  | { kind: 'catalogue'; pick: GamePick }
  /** "Update all": the games to update, before anything opens. */
  | { kind: 'update-games'; games: UpdateGame[]; ticked: string[] }
  /** The pages of one or more games, to tick the ones to add or refresh. */
  | { kind: 'choose'; choice: Choice };

/**
 * Why pages that list others are read: a game address the person pasted,
 * updating games, the site's list of games, or the games picked from it.
 */
export type ListingPurpose = 'game' | 'update' | 'catalogue' | 'catalogue-games';

/** A game added from web pages, which "Update" reads again. */
export interface UpdateGame {
  packId: string;
  title: string;
  importerId: string;
  importerTitle: string;
  /** Its game page, when the importer gives one. */
  address: string | null;
  /** The pages it was made from. */
  recorded: RecordedPage[];
}

export const useImport = create<{
  phase: ImportPhase;
  draft: string;
  /**
   * "Measure the map picture from the page" is ticked: off at first and
   * whenever the dialog closes, never remembered.
   */
  measureFromPage: boolean;
  /** Changes whenever pages kept for later change, for the list of them to read again. */
  queueVersion: number;
  /** A page read waits for the person to confirm its site's licence (see {@link LicenceAsk}). */
  licenceAsk: LicenceAsk | null;
}>()(() => ({
  phase: { kind: 'idle' },
  draft: '',
  measureFromPage: false,
  queueVersion: 0,
  licenceAsk: null,
}));

/**
 * A page of a site whose pages state no licence, read and waiting: its
 * importer asked the person to confirm the site's licence
 * (`askLicence` of the outcome). Nothing of it is kept until they do.
 */
export interface LicenceAsk {
  importerId: string;
  importer: string;
  /** The site's key, as its importer gives it: the licence is kept for the site. */
  siteKey: string;
  /** The page read. */
  url: string;
  /** What the importer said, in its words. */
  message: string;
}

const setPhase = (phase: ImportPhase) => {
  useImport.setState({ phase });
};

export { POLL_MS, KEPT_POLL_MS, STILL_WAITING_SECONDS, waitText } from './pageWindow';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Importers

const loaded = new Map<string, Promise<AtlasImporter>>();

/** Loads an importer module listed in `config.json` (once). */
function loadImporter(entry: ImporterEntry): Promise<AtlasImporter> {
  let promise = loaded.get(entry.id);
  if (!promise) {
    promise = (import(/* @vite-ignore */ entry.moduleUrl) as Promise<{ default: unknown }>).then(
      async (module) => {
        const importer = asImporter(module.default, `The importer “${entry.title}”`);
        if (importer.id !== entry.id) {
          throw new Error(`The importer “${entry.title}” has a different id than listed.`);
        }
        // Before it is asked anything: the site rules files switched on.
        if (__ATLAS_DOWNLOADS__) await applySitesTo(importer);
        return importer;
      },
    );
    promise.catch(() => loaded.delete(entry.id));
    loaded.set(entry.id, promise);
  }
  return promise;
}

/** Every importer of this build that loads. */
export async function loadImporters(): Promise<AtlasImporter[]> {
  const entries = useAtlas.getState().config?.importers ?? [];
  const results = await Promise.allSettled(entries.map(loadImporter));
  return results.flatMap((result) => {
    if (result.status === 'fulfilled') return [result.value];
    console.error(result.reason);
    return [];
  });
}

/** The message for an address no importer recognises. */
export function unrecognisedMessage(url: string, titles: readonly string[]): string {
  if (!isAllowedPageUrl(url)) {
    return 'That is not a web address this app can open. Paste the full address of the map page, starting with https://.';
  }
  return titles.length === 0
    ? 'This app has no importers, so it cannot add maps from web pages.'
    : `None of the importers in this app recognises that address. It can add maps from: ${titles.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// The activity log

/** Records how an import ended in the activity log. Never page data. */
function report(entry: ImportReport): void {
  desktop?.importWindow.report(entry).catch(() => undefined);
}

/** Records the phase an import ended in. */
function reportPhase(importerId: string, phase: ImportPhase): void {
  if (phase.kind === 'failed') {
    report({ importerId, outcome: 'failed', message: phase.message });
  } else if (phase.kind === 'done') {
    const { summary } = phase;
    report({
      importerId,
      outcome: phase.rebuilt ? 'rebuilt' : summary.refreshed ? 'updated' : 'added',
      packId: phase.packId,
      counts: {
        mapLocations: summary.mapLocations,
        maps: summary.maps,
        locations: summary.locations,
        categories: summary.categories,
      },
      ...(summary.picture ? { picture: summary.picture } : {}),
    });
  }
}

/**
 * How the size of an imported map's picture was found, in a sentence for
 * the person: measured on the image server, or estimated from where the
 * places are, with the importer's note.
 */
export function pictureText(picture: PictureSummary): string {
  const tiles = picture.tiles;
  const fromPage = picture.page?.used === true;
  const text = fromPage
    ? `The map picture was measured from the page: it showed ${picture.page!.images === 1 ? '1 map image' : `${picture.page!.images} map images`} of it.`
    : picture.measured
      ? tiles === undefined
        ? 'The map picture was measured on the image server.'
        : `The map picture was measured: ${tiles === 1 ? '1 map image of it was' : `${tiles} map images of it were`} found on the image server.`
      : 'The map picture could not be measured, so its size was estimated from where the locations are.';
  const note = picture.note?.trim();
  if (!note) return text;
  return `${text} ${note.endsWith('.') ? note : `${note}.`}`;
}

/** The importer of the import in progress, for the log. */
let currentImporter: string | null = null;

/**
 * The import window: one at a time, kept for the pages of a go that an
 * importer opens in a window through `fetch.inWindow` (`pageWindow.ts`).
 */
const pageWindows = new PageWindows({
  sleep: (ms) => sleep(ms),
  now: () => Date.now(),
  report,
});

/** What is left of the pause after the page window last let go of a page (closed it, or read a kept window's page). */
const pauseLeft = () => Math.max(0, pageWindows.releasedAt + RUN_PAUSE_MS - Date.now());

const closeWindow = (shell: NonNullable<typeof desktop>) => pageWindows.close(shell.importWindow);

// ---------------------------------------------------------------------------
// Waiting for the page

let session = 0;

/**
 * The reader and wait for a page: a map page (with the importer's reader
 * of its own for that address, when it gives one), a game page or the list
 * of games.
 */
function readerFor(importer: AtlasImporter, reading: Reading, url: string) {
  const part =
    reading === 'game' ? importer.games : reading === 'catalogue' ? importer.catalogue : null;
  const own = reading === 'map' ? ownPageReaderOf(importer, url) : null;
  return {
    pageReader: own ?? part?.pageReader ?? importer.pageReader ?? '() => null',
    waitSeconds: part?.waitSeconds ?? importer.waitSeconds ?? DEFAULT_WAIT_SECONDS,
  };
}

/**
 * Opens `url` in the import window, asks it for its data every few seconds
 * until it appears, the window is closed or the wait runs out, and closes
 * the window. The same for one page and for each page of a run, and for a
 * game page or a list of games with the importer's reader for those. With
 * `keepFor`, the go a page an importer opens in a window through
 * `fetch.inWindow` is read in, the window is kept for the go's next pages
 * on the same site and moved to them (see `pageWindow.ts`).
 */
async function readPage(
  shell: NonNullable<typeof desktop>,
  url: string,
  importer: AtlasImporter,
  id: number,
  onWaiting: (waiting: PageWaiting) => void,
  reading: Reading = 'map',
  /** The importer's page measuring step, when the map picture is to be measured from the page. */
  measure: string | null = null,
  keepFor: number | null = null,
  /** The way the person chose for the site, for an importer that offers ways (`siteInfo`). */
  way?: ReadingWay,
  /** For a page read in the window: run once its data is read, while the window shows it. */
  afterRead?: () => Promise<void>,
): Promise<PageRead> {
  // A site read only as the person browses it: nothing is opened or fetched by itself.
  if (way === 'browse') return { state: 'failed', message: BROWSE_ONLY };
  const fetcher = fetcherFor(importer, reading, url, way);
  if (fetcher) return fetchPage(shell, url, fetcher, importer, id, reading);
  const { pageReader, waitSeconds } = readerFor(importer, reading, url);
  return pageWindows.read(
    shell.importWindow,
    {
      url,
      importer,
      pageReader,
      waitSeconds,
      reading,
      measure,
      keepFor,
      onWaiting,
      ...(afterRead ? { afterRead } : {}),
    },
    () => id === session,
  );
}

/**
 * Whether a page of a go is one an importer that fetches opens in a window
 * (through `fetch.inWindow`, or because the person chose to read the site
 * in a window), whose window the go keeps.
 */
const keptInWindow = (importer: AtlasImporter, url: string, way?: ReadingWay) =>
  importer.fetch !== undefined &&
  (way === undefined ? readsInWindow(importer.fetch, url) : way === 'window');

// ---------------------------------------------------------------------------
// Reading a page by fetching it (see `fetching.ts` in the importer contract)

/**
 * How an importer has a page of this reading fetched, if it reads that way:
 * as the person chose for the site (`way`), or for an importer that offers
 * no choice, unless it opens the page in a window (`fetch.inWindow`).
 */
function fetcherFor(
  importer: AtlasImporter,
  reading: Reading,
  url: string,
  way?: ReadingWay,
): PageFetch | null {
  if (reading === 'catalogue') return null;
  const fetch = (reading === 'game' ? importer.games?.fetch : importer.fetch) ?? null;
  if (!fetch) return null;
  if (way !== undefined) return way === 'fetch' ? fetch : null;
  // A page its site shows only to a person is opened in a window, where the person answers.
  return readsInWindow(fetch, url) ? null : fetch;
}

/** The site of a page with the person's choices, for an importer that offers ways to read its sites. */
const readingOf = (importer: AtlasImporter, url: string): Promise<SiteReading | undefined> =>
  importer.siteInfo
    ? siteReading(importer, url).catch(() => undefined)
    : Promise.resolve(undefined);

/**
 * A refusal, with a sentence that the site can be read in a window of this
 * app instead, when it was fetched and its importer offers that way.
 */
function withWindowHint(message: string, site: SiteReading | undefined): string {
  return site?.way === 'fetch' && site.info.ways.includes('window')
    ? `${message} ${WINDOW_HINT}`
    : message;
}

/** When the app last asked a site for a page. */
let lastFetchAt = 0;

/** The robots.txt rules of each site, read once in a go (`session`). */
const robotsOf = new Map<string, { session: number; rules: RobotsRules }>();

/**
 * Asks for one address as the app, after the pause between pages and at
 * least the pause after the last request; null when another go or a cancel
 * took over meanwhile.
 */
async function fetchAsApp(
  shell: NonNullable<typeof desktop>,
  address: string,
  id: number,
): Promise<ShellFetchedPage | null> {
  const wait = Math.max(pauseLeft(), lastFetchAt + FETCH_PAUSE_MS - Date.now());
  if (wait > 0) await sleep(wait);
  if (id !== session) return null;
  try {
    return await shell.tiles.fetchPage(address);
  } finally {
    lastFetchAt = Date.now();
  }
}

/**
 * The robots.txt rules of the site of `origin` in go `id`, asked for once
 * in a go; a refusal when the site refused that, null when another go or a
 * cancel took over.
 */
async function robotsFor(
  shell: NonNullable<typeof desktop>,
  origin: string,
  id: number,
): Promise<RobotsRules | { refusal: string } | null> {
  const robots = robotsOf.get(origin);
  if (robots?.session === id) return robots.rules;
  const answer = await fetchAsApp(shell, `${origin}/robots.txt`, id);
  if (!answer) return null;
  const refusal = refusalOf(answer.status, answer.retryAfter);
  if (refusal) return { refusal };
  const rules = rulesFromAnswer(answer);
  robotsOf.set(origin, { session: id, rules });
  return rules;
}

/**
 * Fetches the addresses an importer names for `url`, as the app, one at a
 * time: robots.txt first (once per site in a go), then each address after
 * the pause. An answer that refuses stops here, and so does an address
 * robots.txt does not allow.
 */
async function fetchPage(
  shell: NonNullable<typeof desktop>,
  url: string,
  fetcher: PageFetch,
  importer: AtlasImporter,
  id: number,
  reading: Reading,
): Promise<PageRead> {
  const named = fetchAddresses(fetcher, url);
  if (!named.ok) return { state: 'failed', message: named.message };
  const fetched: FetchedPage[] = [];
  const stop = (message: string): PageRead => {
    report({ importerId: importer.id, outcome: 'failed', message });
    return { state: 'refused', message };
  };
  const one = (address: string) => fetchAsApp(shell, address, id);
  try {
    for (const address of named.addresses) {
      const robots = await robotsFor(shell, new URL(address).origin, id);
      if (!robots) return { state: 'cancelled' };
      if ('refusal' in robots) {
        return stop(`${robots.refusal} This app stopped and read no more pages.`);
      }
      if (!robotsAllows(robots, address)) {
        return stop(
          `The site's robots.txt does not allow this app to read ${address}, so it stopped and read no more pages.`,
        );
      }
      const answer = await one(address);
      if (!answer) return { state: 'cancelled' };
      const refusal = refusalOf(answer.status, answer.retryAfter);
      if (refusal) return stop(`${refusal} This app stopped and read no more pages.`);
      const { retryAfter: _, ...page } = answer;
      fetched.push(page);
    }
  } catch (error) {
    if (id !== session) return { state: 'cancelled' };
    const message = `The ${reading === 'map' ? 'page' : 'list of pages'} could not be read: ${errorText(error)}`;
    return { state: 'failed', message };
  }
  if (id !== session) return { state: 'cancelled' };
  const data = JSON.stringify({ fetched });
  if (data.length > MAX_PAGE_DATA_CHARS) {
    return { state: 'failed', message: 'The page provided more data than this app accepts.' };
  }
  return { state: 'ready', data };
}

// ---------------------------------------------------------------------------
// The style sheets of a wiki's pages (see `pageStyles.ts`)

/** The style work of pages read, one step after the other: the end of a session waits for it. */
let stylesWork: Promise<unknown> = Promise.resolve();

const queueStyles = (work: () => Promise<void>) => {
  stylesWork = stylesWork.then(work).catch(() => undefined);
};

/** Whether this app fetches style sheets itself: a build that downloads, with downloads on. */
const fetchesSheets = () => __ATLAS_DOWNLOADS__ && downloadsOffered(useAtlas.getState());

/** How a page's style sheets came, for keeping them once the page is saved. */
type PageSheets =
  { way: 'fetch'; pageData: string } | { way: 'window' | 'browse'; styles: PageStyles | null };

/**
 * For a page that an importer that keeps style sheets (`styleReader`) has
 * read in the window: the step that runs the style reader once the page's
 * data is read, with the marks of the sheets kept for its game, and what
 * it read. Null for an importer without one.
 */
function windowStyles(
  shell: NonNullable<typeof desktop>,
  importer: AtlasImporter,
  url: string,
): { afterRead: () => Promise<void>; sheets: () => PageSheets } | null {
  const reader = importer.styleReader;
  // A page with a reader of its own is read for its data only (`pageReaderFor`).
  if (!reader || ownPageReaderOf(importer, url) !== null) return null;
  let styles: PageStyles | null = null;
  return {
    afterRead: async () => {
      const packs = useAtlas.getState().library?.packs ?? [];
      const marks = await marksFor(shell.library, gameOfSite(importer, url, packs));
      styles = await readPageStyles(
        (script, argument) => shell.importWindow.runOnce(script, argument),
        reader,
        marks,
      );
    },
    sheets: () => ({ way: 'window', styles }),
  };
}

/** Keeps the style sheets a page came with, once the page is saved in game `packId`. */
function keepStylesOf(
  shell: NonNullable<typeof desktop>,
  importer: AtlasImporter,
  url: string,
  packId: string,
  id: number,
  sheets: PageSheets | null,
): void {
  if (!importer.styleReader || !sheets) return;
  noteGameOfSite(importer, url, packId);
  const library = shell.library;
  if (sheets.way === 'fetch') {
    const { pageData } = sheets;
    queueStyles(() => keepFetchedStyles(library, { packId, pageUrl: url, pageData, session: id }));
    return;
  }
  const { way, styles } = sheets;
  if (!styles) return;
  noteHandedStyles(packId, styles);
  const fileHosts = siteInfoOf(importer, url).fileHosts ?? [];
  queueStyles(() =>
    keepPageStyles(library, {
      packId,
      way,
      pageUrl: url,
      styles,
      session: id,
      fetches: way === 'window' && fetchesSheets(),
      fileHosts,
    }),
  );
}

/**
 * Once the pages of session `id` are read: fetches the style sheets they
 * named that are not kept yet, with the rules of pages (`pageStyles.ts`).
 * Nothing is fetched when the session stopped before its end.
 */
function afterSessionStyles(
  shell: NonNullable<typeof desktop>,
  id: number,
  stopped: boolean,
): void {
  queueStyles(() =>
    fetchSessionStyles(shell.library, id, stopped, (address) => fetchSheet(shell, address, id)),
  );
  queueStyles(() => layOutOnceSheetsCame(shell, id));
}

// ---------------------------------------------------------------------------
// Laying pages out as a browser shows them (see `pageLayouts.ts` and `layoutFrame/`)

/**
 * Laying out the pages one convert call asks for (`ImportContext.layOut`),
 * with the style sheets kept for game `packId` (none when it is not known
 * yet): in a build with downloads only. `onPage` is called as each page is
 * about to be laid out.
 */
function layoutsFor(
  packId: string | null,
  onPage?: () => void,
  sheets?: Promise<readonly KeptSheetText[]>,
): PageLayouts | null {
  const shell = desktop;
  if (!__ATLAS_DOWNLOADS__ || !shell || !downloadsOffered(useAtlas.getState())) return null;
  return pageLayouts({
    sheets: () =>
      sheets ??
      (packId ? shell.library.styleTexts(packId) : Promise.resolve([] as KeptSheetText[])),
    open: () => openLayoutFrame(),
    ...(onPage ? { onPage } : {}),
  });
}

/** By session: the games some of whose pages were written without being laid out, for want of their sheets. */
const unlaid = new Map<number, Set<string>>();

/**
 * Notes that some pages of session `id` went into game `packId` without
 * being laid out because its sheets were not kept yet (a wiki's first
 * session: the sheets its pages link to are fetched after its pages).
 */
function noteUnlaid(id: number, packId: string, tally: LayoutTally | null): void {
  if (!tally || tally.noSheets === 0) return;
  const games = unlaid.get(id) ?? new Set<string>();
  games.add(packId);
  unlaid.set(id, games);
}

/**
 * Once the style sheets of session `id` are kept: a game some of whose
 * pages were written without being laid out, for want of its sheets, is
 * built again from its saved pages if it keeps sheets now, so those pages
 * are laid out too. Nothing is fetched for it.
 */
async function layOutOnceSheetsCame(shell: NonNullable<typeof desktop>, id: number): Promise<void> {
  const games = unlaid.get(id);
  unlaid.delete(id);
  if (!__ATLAS_DOWNLOADS__ || !games) return;
  for (const packId of games) {
    const kept = await shell.library.styleTexts(packId).catch((): KeptSheetText[] => []);
    if (kept.some((sheet) => sheet.address !== undefined))
      void rebuildPack(packId, { quiet: true });
  }
}

/**
 * Fetches one style sheet as the app fetches a page: robots.txt first
 * (once per site in a go), after the pause, and a refusal or a page in
 * place of the sheet (a check that the reader is a person) stops asking.
 */
async function fetchSheet(
  shell: NonNullable<typeof desktop>,
  address: string,
  id: number,
): Promise<SheetAnswer> {
  if (!fetchesSheets()) return { kind: 'cancelled' };
  try {
    const robots = await robotsFor(shell, new URL(address).origin, id);
    if (!robots) return { kind: 'cancelled' };
    if ('refusal' in robots) return { kind: 'not', reason: 'refused', stop: true };
    if (!robotsAllows(robots, address)) return { kind: 'not', reason: 'robots' };
    const answer = await fetchAsApp(shell, address, id);
    if (!answer) return { kind: 'cancelled' };
    return sheetFromAnswer({ ...answer, refusal: refusalOf(answer.status, answer.retryAfter) });
  } catch {
    return { kind: 'not', reason: 'failed' };
  }
}

/**
 * The importer's page measuring step for `url`, when the person ticked
 * "Measure the map picture from the page" and this app can do it.
 */
function measureStep(importer: AtlasImporter, url: string): string | null {
  if (!__ATLAS_DOWNLOADS__ || !downloadsOffered(useAtlas.getState())) return null;
  if (!useImport.getState().measureFromPage) return null;
  return pageMeasureStep(importer, url);
}

/** Ticks or unticks "Measure the map picture from the page". */
export function setMeasureFromPage(on: boolean): void {
  useImport.setState({ measureFromPage: on });
}

/**
 * Whether "Measure the map picture from the page" can be offered for these
 * map page addresses: in an app that downloads map images, when the
 * importer of at least one of them measures such pages.
 */
export async function pageMeasureOffered(urls: readonly string[]): Promise<boolean> {
  if (!__ATLAS_DOWNLOADS__ || !desktop || !downloadsOffered(useAtlas.getState())) return false;
  if (urls.length === 0) return false;
  const importers = await loadImporters();
  return urls.some((url) => {
    const importer = findImporter(importers, url);
    return importer !== null && pageMeasureStep(importer, url) !== null;
  });
}

/** Starts an import from a page address. */
export async function startImport(text: string): Promise<void> {
  const shell = desktop;
  if (!shell) return;
  const url = text.trim();
  const id = ++session;
  const importers = await loadImporters();
  const refusal = refusalFor(importers, url);
  const importer = refusal ? null : findImporter(importers, url);
  if (refusal) {
    report({ importerId: null, outcome: 'failed', message: refusal });
    setPhase({ kind: 'failed', message: refusal });
    return;
  }
  if (!importer) {
    const message = unrecognisedMessage(
      url,
      importers.map((i) => i.title),
    );
    report({ importerId: null, outcome: 'failed', message });
    setPhase({ kind: 'failed', message });
    return;
  }
  currentImporter = importer.id;
  const site = await readingOf(importer, url);
  const styles = keptInWindow(importer, url, site?.way) ? windowStyles(shell, importer, url) : null;
  const read = await readPage(
    shell,
    url,
    importer,
    id,
    (waiting) => {
      setPhase({ kind: 'waiting', url, importer: importer.title, ...waiting });
    },
    'map',
    measureStep(importer, url),
    null,
    site?.way,
    styles?.afterRead,
  );
  if (read.state === 'cancelled') return;
  if (read.state !== 'ready') {
    if (id === session) {
      setPhase(
        read.state === 'refused'
          ? refusedPhase(read.message, url, site)
          : failedPhase(read.message),
      );
    }
    return;
  }
  const pages = importer.fetch ? { pages: true } : {};
  setPhase({ kind: 'converting', url, importer: importer.title, ...pages });
  const layouts = layoutsFor(gameOfSite(importer, url, useAtlas.getState().library?.packs ?? []));
  const outcome = await convertAndSave(
    importer,
    {
      url,
      pageData: read.data,
      importedAt: new Date().toISOString(),
      observations: read.page,
      ...(site ? { way: site.way } : {}),
    },
    false,
    true,
    () => {
      if (id === session) {
        setPhase({ kind: 'converting', url, importer: importer.title, measuring: true });
      }
    },
    {
      onWaiting: () => {
        if (id === session) {
          setPhase({ kind: 'converting', url, importer: importer.title, waiting: true, ...pages });
        }
      },
      layouts,
    },
  );
  layouts?.close();
  reportPhase(importer.id, outcome);
  if (outcome.kind === 'done') {
    noteUnlaid(id, outcome.packId, layouts?.tally() ?? null);
    keepStylesOf(
      shell,
      importer,
      url,
      outcome.packId,
      id,
      sheetsOf(importer, url, site, read, styles),
    );
  }
  afterSessionStyles(shell, id, false);
  if (id !== session) return;
  setPhase(
    outcome.kind === 'failed' && outcome.refused
      ? refusedPhase(outcome.message, url, site)
      : outcome,
  );
}

/** How the style sheets of a page read came: in its fetched data, or from the window. */
function sheetsOf(
  importer: AtlasImporter,
  url: string,
  site: SiteReading | undefined,
  read: { data: string },
  styles: { sheets: () => PageSheets } | null,
): PageSheets | null {
  if (styles) return styles.sheets();
  return fetcherFor(importer, 'map', url, site?.way) ? { way: 'fetch', pageData: read.data } : null;
}

const failedPhase = (message: string): ImportPhase => ({ kind: 'failed', message });

/** A page the site refused, with a way to read the site in a window instead when it offers one. */
function refusedPhase(message: string, url: string, site: SiteReading | undefined): ImportPhase {
  const hint = withWindowHint(message, site);
  return {
    kind: 'failed',
    message: hint,
    refused: true,
    ...(hint !== message ? { how: url } : {}),
  };
}

/** Stops waiting and closes the page window; a run stops with it. */
export async function cancelImport(): Promise<void> {
  if (useImport.getState().phase.kind === 'waiting') {
    report({ importerId: currentImporter, outcome: 'cancelled' });
  }
  currentRun?.cancel();
  session++;
  answerLicence(null);
  setPhase({ kind: 'idle' });
  if (__ATLAS_DOWNLOADS__ && desktop && downloadsOffered(useAtlas.getState())) {
    // A page of a run may be measuring its map's picture.
    await desktop.tiles.cancelPicture().catch(() => undefined);
  }
  if (desktop) await closeWindow(desktop);
}

/**
 * Whether pages are being read or a game is being changed now: a page
 * open or turned into its game (a game built again from saved pages too),
 * a session of pages or lists going, or the person browsing a wiki.
 */
export const sessionGoing = (phase: ImportPhase): boolean =>
  phase.kind === 'waiting' ||
  phase.kind === 'converting' ||
  (phase.kind === 'browse' && !phase.ended) ||
  ((phase.kind === 'run' || phase.kind === 'listing') && phase.run.status === 'running');

/**
 * After a wiki was deleted to start it again from the beginning: the
 * address box holds its start address, and the steps of adding ask how its
 * pages are read, with the way chosen before ticked (when its importer
 * offers a choice; otherwise the person presses Add). Nothing is read.
 */
export async function startWikiAgain(start: string): Promise<void> {
  setDraft(start);
  setPhase({ kind: 'idle' });
  showLibraryAdd();
  await chooseHow(start);
}

/** Back to the address field, after a result or a failure. */
export function resetImport(): void {
  const { phase } = useImport.getState();
  if (
    phase.kind === 'waiting' ||
    (phase.kind === 'browse' && !phase.ended) ||
    ((phase.kind === 'run' || phase.kind === 'listing') && phase.run.status === 'running')
  ) {
    return;
  }
  setPhase({ kind: 'idle' });
}

// ---------------------------------------------------------------------------
// Several addresses

/** The run in progress, if any. */
let currentRun: ImportRun | null = null;

/** While a game is built again, how far it is is shown at most this often. */
const REBUILD_PROGRESS_MS = 200;

/**
 * Games asked to be built again while a go was under way, built when it
 * ends: quietly, unless the person asked for one of the builds.
 */
const rebuildAfterGo = new Map<string, boolean>();

/** Keeps what the person typed, so it is still there after going back. */
export function setDraft(draft: string): void {
  useImport.setState({ draft });
}

/**
 * Starts adding what the person pasted: one address as before; several
 * one after another, after showing any that cannot be added.
 */
export async function submitAddresses(text: string): Promise<void> {
  const { addresses, tooMany } = parseAddresses(text);
  if (addresses.length === 0) return;
  const importers = await loadImporters();
  // A map page first; then a game's page, or a site's list of games: of an importer that
  // knows the address before one that would read it only as a general reader.
  const listing = (url: string) => {
    const reader = findReader(importers, url);
    return reader && reader.kind !== 'page' ? reader.kind : null;
  };
  if (addresses.length === 1) {
    const url = addresses[0]!;
    // An address an importer refuses is never opened or fetched.
    const refusal = refusalFor(importers, url);
    if (refusal) {
      report({ importerId: null, outcome: 'failed', message: refusal });
      setPhase({ kind: 'failed', message: refusal });
      return;
    }
    // A site that can be read more than one way: the person chooses first, and again
    // whenever no wiki of the site is in the Library (started again from the beginning).
    const reader = findReader(importers, url);
    const site = reader ? await readingOf(reader.importer, url) : undefined;
    if (reader && site && asksHow(site, { inLibrary: inLibrary(reader.importer, site) })) {
      setPhase({
        kind: 'how',
        url,
        importerId: reader.importer.id,
        importer: reader.importer.title,
        site: site.info,
        way: site.way,
      });
      return;
    }
    await addAddress(url, importers);
    return;
  }
  if (addresses.some((url) => listing(url) !== null)) {
    setPhase({ kind: 'failed', message: MIXED_MESSAGE });
    return;
  }
  if (tooMany) {
    setPhase({ kind: 'failed', message: tooManyMessage(addresses.length) });
    return;
  }
  const checked = checkAddresses(addresses, importers);
  if (checked.some((address) => !address.importer)) {
    setPhase({
      kind: 'check',
      addresses: checked.map(({ url, importer, problem }) => ({
        url,
        importer: importer?.title ?? null,
        problem,
      })),
      importers: importers.map((importer) => importer.title),
    });
    return;
  }
  await startRun(checked, 0);
}

/** Whether a game read from this site with this importer is in the Library. */
const inLibrary = (importer: AtlasImporter, site: SiteReading): boolean =>
  siteInLibrary(importer, site.info.key, useAtlas.getState().library?.packs ?? []);

/** Reads one address the person added: a page, a game's page, or a site's list of games. */
async function addAddress(url: string, importers: readonly AtlasImporter[]): Promise<void> {
  const reader = findReader(importers, url);
  // A site read as the person browses it: browsing starts at the address.
  const site = reader ? await readingOf(reader.importer, url) : undefined;
  const started = session;
  if (reader && site?.way === 'browse') await startBrowse(url, reader.importer, site);
  else if (reader?.kind === 'game') await startGameAddress(url, reader.importer);
  else if (reader?.kind === 'catalogue') await startCatalogue(url, reader.importer);
  else await startImport(url);
  // Whatever went wrong, the person can choose another way to read a site that offers one.
  const { phase } = useImport.getState();
  if (
    site &&
    offersChoice(site.info) &&
    phase.kind === 'failed' &&
    !phase.how &&
    session - started <= 1
  ) {
    setPhase({ ...phase, how: url });
  }
}

/**
 * The address to choose how a site is read for, after a session of its
 * pages that kept none: the address the person added when it is of the
 * same site as `page`, else `page`; null when the site offers no choice.
 * Nothing is read.
 */
export async function howAddressFor(page: string, added: string | null): Promise<string | null> {
  const importers = await loadImporters().catch((): AtlasImporter[] => []);
  const reader = findReader(importers, page);
  const site = reader ? await readingOf(reader.importer, page) : undefined;
  if (!reader || !site || !offersChoice(site.info)) return null;
  const same =
    added !== null &&
    findReader(importers, added)?.importer.id === reader.importer.id &&
    siteInfoOf(reader.importer, added).key === site.info.key;
  return same ? added : page;
}

/**
 * Shows how the site of `url` can be read, with the way chosen now ticked,
 * for the person to change it (after a refusal, say). Nothing is read.
 */
export async function chooseHow(url: string): Promise<void> {
  const importers = await loadImporters();
  const reader = findReader(importers, url);
  const site = reader ? await readingOf(reader.importer, url) : undefined;
  if (!reader || !site) return;
  setPhase({
    kind: 'how',
    url,
    importerId: reader.importer.id,
    importer: reader.importer.title,
    site: site.info,
    way: site.way,
  });
}

/** Ticks a way in the step that asks how a site is read. */
export function setHowWay(way: ReadingWay): void {
  const { phase } = useImport.getState();
  if (phase.kind === 'how' && phase.site.ways.includes(way)) setPhase({ ...phase, way });
}

/** Keeps the way ticked for the site, then reads the address as the person added it. */
export async function confirmHow(): Promise<void> {
  const { phase } = useImport.getState();
  if (phase.kind !== 'how') return;
  await setSiteWay(phase.importerId, phase.site.key, phase.way).catch(() => undefined);
  await addAddress(phase.url, await loadImporters());
}

/** After the check: adds the addresses that can be added and leaves out the rest. */
export async function confirmChecked(): Promise<void> {
  const { phase } = useImport.getState();
  if (phase.kind !== 'check') return;
  const usable = phase.addresses.filter((address) => address.importer !== null);
  if (usable.length === 0) return;
  if (usable.length === 1) {
    await startImport(usable[0]!.url);
    return;
  }
  const importers = await loadImporters();
  await startRun(
    checkAddresses(
      usable.map((address) => address.url),
      importers,
    ),
    phase.addresses.length - usable.length,
  );
}

/** The message when a game address or a list of games comes with other addresses. */
export const MIXED_MESSAGE =
  'A game address, or the address of a list of games, has to be added on its own: paste it alone, and this app lists its maps for you to choose from. To add several maps at once, paste map page addresses only.';

/** Stops the run, or the reading of game pages, after the page that is open now. */
export function stopRun(): void {
  currentRun?.stop();
}

const outcomeOf = (
  read: Exclude<PageRead, { state: 'ready' }>,
): Extract<PageOutcome, { message: string }> => {
  switch (read.state) {
    case 'closed':
      return { kind: 'closed', message: read.message };
    case 'failed':
      return { kind: 'failed', message: read.message };
    case 'timed-out':
    case 'open-failed':
      return { kind: 'no-data', message: read.message };
    case 'cancelled':
      return { kind: 'cancelled', message: 'Stopped before the page provided its data.' };
    case 'refused':
      return { kind: 'refused', message: read.message };
  }
};

/**
 * Works through several pages, one at a time, in the order given (see
 * `importRun.ts`), then shows the game of the last map added. In a go of
 * pages an importer fetches, `follow` says per importer how far the links
 * of the pages read are followed (see `followLinks.ts`): the pages found
 * are added to the go, after the others: a go has no page limit.
 */
async function startRun(
  checked: readonly CheckedAddress<AtlasImporter>[],
  leftOut: number,
  {
    update = false,
    firstPauseMs = 0,
    follow,
  }: {
    update?: boolean;
    firstPauseMs?: number;
    follow?: ReadonlyMap<string, FollowLinks>;
  } = {},
): Promise<RunState | null> {
  const shell = desktop;
  if (!shell) return null;
  const pages: {
    url: string;
    importer: AtlasImporter;
    listed?: CheckedAddress<unknown>['listed'] | undefined;
  }[] = checked.flatMap(({ url, importer, listed }) =>
    importer ? [{ url, importer, listed }] : [],
  );
  // How each page is read, as the person chose for its site (fixed for the go).
  const sites = await Promise.all(pages.map((page) => readingOf(page.importer, page.url)));
  // How many links away from a page ticked each page is (0: ticked), and every page of the go.
  const depths = pages.map(() => 0);
  const inGo = new Set(pages.map((page) => pageKey(page.url)));
  const following = follow !== undefined && pages.every((page) => page.importer.fetch);
  const id = ++session;
  const run = new ImportRun(
    pages.map((page) => page.url),
    leftOut,
    {
      sleep,
      onChange: (state) => {
        if (id === session) setPhase({ kind: 'run', run: state, shownPackId: null, update });
      },
      async importPage(index, url, update) {
        const { importer, listed } = pages[index]!;
        const site = sites[index];
        currentImporter = importer.id;
        const kept = keptInWindow(importer, url, site?.way);
        const styles = kept ? windowStyles(shell, importer, url) : null;
        const read = await readPage(
          shell,
          url,
          importer,
          id,
          (waiting) => {
            update({ kind: 'open', ...waiting });
          },
          'map',
          measureStep(importer, url),
          kept ? id : null,
          site?.way,
          styles?.afterRead,
        );
        if (read.state !== 'ready') {
          if (read.state === 'cancelled') {
            report({ importerId: importer.id, outcome: 'cancelled' });
          }
          const result = outcomeOf(read);
          if (result.kind === 'refused') result.message = withWindowHint(result.message, site);
          if (importer.fetch && read.state !== 'cancelled' && read.state !== 'closed') {
            void noteWikiFailed(importer.id, url, result.message);
          }
          return result;
        }
        // A page of a wiki is written into a game of pages: no map is built.
        const of = importer.fetch ? ({ of: 'pages' } as const) : {};
        update({ kind: 'converting', ...of });
        // The pages it asks to lay out, with the sheets kept for its site's game, if known yet.
        const layouts = layoutsFor(
          gameOfSite(importer, url, useAtlas.getState().library?.packs ?? []),
        );
        const outcome = await convertAndSave(
          importer,
          {
            url,
            pageData: read.data,
            importedAt: new Date().toISOString(),
            observations: read.page,
            listed,
            ...(site ? { way: site.way } : {}),
          },
          false,
          false,
          () => {
            update({ kind: 'converting', measuring: true });
          },
          {
            onWaiting: () => {
              update({ kind: 'converting', waiting: true, ...of });
            },
            layouts,
          },
        );
        layouts?.close();
        if (outcome.kind === 'done') noteUnlaid(id, outcome.packId, layouts?.tally() ?? null);
        // The person did not confirm the site's licence: nothing more is read.
        if (outcome.kind === 'failed' && outcome.declined) run.stop();
        reportPhase(importer.id, outcome);
        if (outcome.kind === 'done') {
          keepStylesOf(
            shell,
            importer,
            url,
            outcome.packId,
            id,
            sheetsOf(importer, url, site, read, styles),
          );
        }
        if (importer.fetch && outcome.kind === 'done') {
          // The game shown takes in the page now and then during a long go.
          packWritten(outcome.packId, { duringGo: true });
          const { links = [], writtenAgain = [], pageAddress } = outcome;
          // Read under another name of it: that name is in the go now too.
          if (pageAddress) inGo.add(pageKey(pageAddress));
          void noteWikiRead(importer.id, url, links, pageAddress).then(() =>
            noteWikiLinks(importer.id, writtenAgain),
          );
          // The pages it links to join this go, when the person chose that.
          if (following && links.length > 0) {
            await followFrom(index, url, importer, links);
          }
        } else if (importer.fetch && outcome.kind === 'failed') {
          void noteWikiFailed(importer.id, url, outcome.message);
        }
        if (outcome.kind === 'done') {
          return {
            kind: 'added',
            game: outcome.summary.game,
            map: outcome.summary.map,
            packId: outcome.packId,
            ...(outcome.mapId ? { mapId: outcome.mapId } : {}),
            refreshed: outcome.summary.refreshed,
            ...(outcome.summary.checklist ? { checklist: outcome.summary.checklist } : {}),
            ...(outcome.summary.picture ? { picture: outcome.summary.picture } : {}),
            ...(outcome.guideId ? { guide: true } : {}),
            ...(outcome.pictures ? { pictures: true } : {}),
            ...(outcome.photos ? { photos: true } : {}),
          };
        }
        if (outcome.kind === 'failed' && outcome.refused) {
          return { kind: 'refused', message: withWindowHint(outcome.message, site) };
        }
        return {
          kind: 'failed',
          message: outcome.kind === 'failed' ? outcome.message : 'Nothing was added.',
        };
      },
    },
    // A page read in the window kept from the page before follows after a shorter pause;
    // a site whose rules file sets a longer pause (`SiteInfo.pause`) waits that long.
    (index) => {
      const next = pages[index];
      const pause =
        next && keptInWindow(next.importer, next.url, sites[index]?.way)
          ? pageWindows.pauseBefore(id, next.importer.id, next.url)
          : RUN_PAUSE_MS;
      return Math.max(pause, (sites[index]?.info.pause ?? 0) * 1000);
    },
    firstPauseMs,
  );
  /** Adds the pages a page read links to, as `follow` says, within the go's limit. */
  async function followFrom(
    index: number,
    url: string,
    importer: AtlasImporter,
    links: readonly string[],
  ): Promise<void> {
    const notes = await loadWikiNotes(importer.id).catch(() => null);
    const depth = depths[index] ?? 0;
    const { add } = pagesToFollow({
      follow: follow?.get(importer.id) ?? 'ticked',
      depth,
      links,
      importer,
      inGo,
      read: recordedKeys(),
      leftOut: new Set(notes?.leftOut ?? []),
      ...(notes ? { otherNames: notes.otherNames } : {}),
    });
    if (add.length === 0 || id !== session || run.state.stopRequested) return;
    // A page the wiki's contents list is filed under its heading there.
    const listedPages = new Map(
      Object.values(notes?.contents ?? {}).flatMap((contents) =>
        contents.pages.map((page) => [pageKey(page.url), page] as const),
      ),
    );
    for (const found of add) {
      const listed = listedPages.get(pageKey(found));
      pages.push({
        url: found,
        importer,
        ...(listed
          ? { listed: { title: listed.title, ...(listed.group ? { group: listed.group } : {}) } }
          : {}),
      });
      sites.push(await readingOf(importer, found));
      depths.push(depth + 1);
      inGo.add(pageKey(found));
    }
    run.add(add.map((found) => ({ url: found, foundOn: url })));
  }
  currentRun = run;
  // The pages of an importer that names addresses to fetch become guides.
  if (pages.length > 0 && pages.every((page) => page.importer.fetch)) {
    run.state = { ...run.state, guidePages: true };
  }
  report({
    importerId: null,
    outcome: 'run-started',
    pages: pages.map((page) => page.url),
    run: { leftOut },
    ...(update ? { update } : {}),
  });
  const final = await run.run();
  if (currentRun === run) currentRun = null;
  // The window kept for the go's pages closes with it, however it ended.
  await pageWindows.release(shell.importWindow, id);
  // The style sheets its pages named, once its pages are all read.
  afterSessionStyles(shell, id, final.stopReason !== null);
  // The links of the pages read, written every few seconds during the go, are all written now.
  void flushWikiNotes();
  // The pictures of the pages added, once the pages are all read: one download a game.
  const withPictures = new Set(
    final.pages.flatMap(({ state }) =>
      state.kind === 'added' && state.pictures ? [state.packId] : [],
    ),
  );
  for (const packId of withPictures) fetchPagePictures(packId);
  // The location photos of the maps added, after their map images: one download a game.
  const withPhotos = new Set(
    final.pages.flatMap(({ state }) =>
      state.kind === 'added' && state.photos ? [state.packId] : [],
    ),
  );
  for (const packId of withPhotos) fetchMapPhotos(packId);
  // The game shown, if the go added to it, takes in every page read: it is loaded again.
  const shownId = useAtlas.getState().game?.entry.id;
  const addedToShown = final.pages.some(
    ({ state }) => state.kind === 'added' && state.packId === shownId && !state.mapId,
  );
  if (shownId && addedToShown) packWritten(shownId);
  // A game asked to be built again during the go is built now.
  for (const [packId, quiet] of rebuildAfterGo) {
    rebuildAfterGo.delete(packId);
    void rebuildPack(packId, { quiet });
  }
  const counts = runCounts(final);
  if (final.stopReason) {
    report({
      importerId: null,
      outcome: 'run-stopped',
      message: stopReasonText(final.stopReason),
      run: { ...counts, leftOut },
      ...(update ? { update } : {}),
    });
  }
  report({
    importerId: null,
    outcome: 'run-finished',
    run: { ...counts, leftOut },
    ...(update ? { update } : {}),
  });
  if (id !== session) return final;

  // Show the game of the last map added, as after a single import.
  const last = final.pages.findLast(
    (page) => page.state.kind === 'added' && page.state.mapId !== undefined,
  )?.state;
  let shownPackId: string | null = null;
  if (last?.kind === 'added' && last.mapId) {
    const entry = useAtlas.getState().catalog.find((p) => p.id === last.packId);
    if (entry && (await showMap(entry, last.mapId))) shownPackId = last.packId;
  }
  if (id === session) setPhase({ kind: 'run', run: final, shownPackId, update });
  return final;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Converting and saving

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Measures a map's picture for an importer (`ImportContext.pictureTiles`),
 * through the shell's own downloader. A rebuild never asks the image
 * server: it only gets what the app learnt in earlier imports. Anything
 * unexpected is `null`, and the importer sizes the map without it.
 */
async function measurePicture(
  request: unknown,
  rebuilt: boolean,
  onMeasuring?: () => void,
  observations?: PageObservations,
): Promise<PictureTiles | null> {
  const shell = desktop;
  if (!__ATLAS_DOWNLOADS__ || !shell || !isPictureRequest(request)) return null;
  // Tiles a page showed are taken only from this import's page, as it loaded them.
  const page = request.page;
  if (page && (!observations || !pageTilesFit(page, request, observations))) return null;
  const asked: PictureTilesRequest = {
    urlTemplate: request.urlTemplate,
    zoom: request.zoom,
    start: [request.start[0], request.start[1]],
    cachedOnly: rebuilt || request.cachedOnly === true,
    ...(page
      ? {
          page: {
            present: page.present.map(([x, y]) => [x, y] as [number, number]),
            absent: page.absent.map(([x, y]) => [x, y] as [number, number]),
          },
        }
      : {}),
  };
  if (!asked.cachedOnly) onMeasuring?.();
  try {
    return checkPictureTiles(await shell.tiles.pictureTiles(asked), asked);
  } catch {
    return null;
  }
}

/**
 * The context an importer gets: earlier imports and the pack it would
 * replace, and in an app that downloads map images, a way to measure the
 * map's picture, and what the page loaded when it was measured from the
 * page. Exported for tests.
 */
export function importContext(
  url: string,
  importedAt: string,
  importerId: string,
  rebuilt = false,
  onMeasuring?: () => void,
  observations?: PageObservations,
  listed?: ImportContext['listed'],
  /**
   * How the page was read, the licence the person confirmed for its site,
   * and the size its pictures are kept at (for an importer whose pages
   * come with their pictures).
   */
  site: {
    reading?: ReadingWay;
    confirmedLicence?: SiteLicence;
    pictureSize?: PictureSize;
  } = {},
): ImportContext {
  const state = useAtlas.getState();
  const listing = state.library;
  const bundled = new Set([
    ...state.bundledCatalog.map((p) => p.id),
    ...(listing?.packs ?? []).filter((p) => p.bundled).map((p) => p.id),
  ]);
  return {
    url,
    importedAt,
    app: { name: state.app?.name ?? 'Atlas', version: state.app?.version ?? '' },
    async savedSources(packId) {
      if (!desktop) return [];
      const stored = await desktop.library.importSources(packId, importerId).catch(() => []);
      return stored.flatMap((source): SavedSource[] => {
        const data = parse(source.data);
        return data === undefined
          ? []
          : [{ key: source.key, url: source.url, importedAt: source.importedAt, data }];
      });
    },
    // The same pages one at a time, for an importer that goes through many of them.
    async savedPages(packId) {
      if (!desktop) return [];
      const stored = await desktop.library.importSourceList(packId, importerId).catch(() => []);
      return stored.map(({ key, url, importedAt }) => ({ key, url, importedAt }));
    },
    async savedSource(packId, key) {
      if (!desktop) return null;
      const source = await desktop.library.importSource(packId, importerId, key).catch(() => null);
      const data = source ? parse(source.data) : undefined;
      return source && data !== undefined
        ? { key: source.key, url: source.url, importedAt: source.importedAt, data }
        : null;
    },
    existingPack(packId) {
      // A pack in the maps folder, else one that comes with the app (to refresh it).
      const url =
        listing?.packs.find((p) => p.id === packId)?.url ??
        state.bundledCatalog.find((p) => p.id === packId)?.url;
      return openListedPack(url, async (at) => (await loadPack(at)).data);
    },
    isBundled: (packId) => bundled.has(packId),
    // The sections other names of pages lead to are kept with the pack.
    keepsIdSections: true,
    // So is the guide that is the site's own home page.
    keepsHomePage: true,
    // And the width the site's pages are shown at.
    keepsPageWidth: true,
    // And which links of the pages name a location of a map.
    keepsMapLinks: true,
    // And the guides the site itself files a page under.
    keepsFiledUnder: true,
    // Built again from the pages kept, as the person asked: nothing is fetched.
    ...(rebuilt ? { rebuild: true } : {}),
    ...(listed ? { listed } : {}),
    ...(site.reading ? { reading: site.reading } : {}),
    ...(site.confirmedLicence ? { confirmedLicence: site.confirmedLicence } : {}),
    // The app keeps a picture's address shown and its copy for pages.
    ...(site.pictureSize ? { pictureSize: site.pictureSize } : {}),
    ...(__ATLAS_DOWNLOADS__ && downloadsOffered(state)
      ? {
          pictureTiles: (request: PictureTilesRequest) =>
            measurePicture(request, rebuilt, onMeasuring, rebuilt ? undefined : observations),
          ...(observations && !rebuilt ? { pageObservations: observations } : {}),
        }
      : {}),
  };
}

/** Why a read stopped when the game it adds to is listed but could not be opened. */
export const PACK_NOT_OPENED =
  'This game could not be opened, so nothing was read. Press Look again in Settings, then try again.';

/** Thrown by `existingPack` for a game that is listed but could not be opened. */
export class PackNotOpenedError extends Error {
  constructor() {
    super(PACK_NOT_OPENED);
    this.name = 'PackNotOpenedError';
  }
}

/**
 * The pack a read adds to: null only for a game that is not listed yet, which
 * the read then starts new. A game that is listed but cannot be opened stops
 * the read, so that a game of one page is never written over the real one.
 */
export async function openListedPack(
  url: string | undefined,
  load: (url: string) => Promise<PackData>,
): Promise<PackData | null> {
  if (!url) return null;
  try {
    return await load(url);
  } catch {
    throw new PackNotOpenedError();
  }
}

/** What to show when an importer's `convert` stopped with an error. */
export function importerStoppedMessage(error: unknown): string {
  if (error instanceof PackNotOpenedError) return PACK_NOT_OPENED;
  return `The importer stopped with an error, so nothing was added: ${errorText(error)}`;
}

/** The `source` block of the manifest: every page the pack was made from. */
function packSource(
  importer: AtlasImporter,
  stored: readonly StoredPage[],
  current: { key: string; url: string; mapId: string | undefined; importedAt: string },
): PackSource {
  const pages = stored
    .filter((source) => source.key !== current.key)
    .map((source) => ({
      url: source.url,
      ...(source.mapId ? { mapId: source.mapId } : {}),
      importedAt: source.importedAt,
    }));
  pages.push({
    url: current.url,
    ...(current.mapId ? { mapId: current.mapId } : {}),
    importedAt: current.importedAt,
  });
  return { importer: { id: importer.id, title: importer.title }, pages };
}

/** The pack's files as JSON text, with a manifest that describes it. */
export function packFiles(pack: PackData): Record<string, string> {
  const files: Record<string, string> = {
    [MANIFEST_FILE]: `${JSON.stringify(pack.manifest, null, 2)}\n`,
  };
  // Every file, an optional collection the pack leaves out as an empty one.
  for (const name of COLLECTION_NAMES) {
    files[PACK_COLLECTIONS[name].file] = `${JSON.stringify(pack[name] ?? [], null, 2)}\n`;
  }
  return files;
}

/**
 * Hands page data to the importer, checks what it returns, and writes the
 * pack. Returns the phase to show.
 */
async function convertAndSave(
  importer: AtlasImporter,
  page: {
    url: string;
    pageData: string;
    importedAt: string;
    observations?: PageObservations;
    listed?: ImportContext['listed'];
    /** How it was read, as the person chose for its site. */
    way?: ReadingWay;
  },
  rebuilt = false,
  show = true,
  onMeasuring?: () => void,
  turn: {
    /** The pack whose turn the caller holds already (see `packTurns.ts`). */
    held?: string;
    /** Called when the page waits for another step changing the same pack. */
    onWaiting?: () => void;
    /** Called as the importer says how far a long step is (see `ImportContext.progress`). */
    onProgress?: (step: { done: number; total: number }) => void;
    /** Lays out the pages the importer asks to (see `ImportContext.layOut`); the caller closes it. */
    layouts?: PageLayouts | null;
  } = {},
): Promise<ImportPhase> {
  const shell = desktop;
  if (!shell) return { kind: 'idle' };
  if (page.pageData.length > MAX_PAGE_DATA_CHARS) {
    return { kind: 'failed', message: 'The page provided more data than this app accepts.' };
  }
  const data = parse(page.pageData);
  if (data === undefined) {
    return { kind: 'failed', message: 'The page data was not in the expected shape.' };
  }
  // The licence the person confirmed for the site, as kept now: a page before may just have asked.
  const site = await readingOf(importer, page.url);
  const contextWith = (confirmedLicence: SiteLicence | undefined) =>
    importContext(
      page.url,
      page.importedAt,
      importer.id,
      rebuilt,
      onMeasuring,
      page.observations,
      page.listed,
      {
        ...(page.way ? { reading: page.way } : {}),
        ...(confirmedLicence ? { confirmedLicence } : {}),
        // Built again too with the size chosen for the site now.
        ...(importer.picturesWithPages === true
          ? { pictureSize: site?.pictures ?? DEFAULT_PICTURE_SIZE }
          : {}),
      },
    );
  // When the importer read each pack: changed since, it reads it again (see `packTurns.ts`).
  const readAt = new Map<string, number>();
  // A listed game that could not be opened: the read stops even if the importer went on without it.
  let unopened = false;
  const noting = (given: ImportContext): ImportContext => ({
    ...given,
    existingPack: (packId) => {
      readAt.set(packId, packSaves(packId));
      return given.existingPack(packId).catch((error: unknown) => {
        if (error instanceof PackNotOpenedError) unopened = true;
        throw error;
      });
    },
    ...(turn.onProgress
      ? {
          progress: (step: unknown) => {
            // An importer's figures are shown only when they are whole counts that fit together.
            const { done, total } = (step ?? {}) as { done?: unknown; total?: unknown };
            if (typeof done !== 'number' || typeof total !== 'number') return;
            if (!Number.isInteger(done) || !Number.isInteger(total)) return;
            if (total < 1 || done < 0) return;
            turn.onProgress?.({ done: Math.min(done, total), total });
          },
        }
      : {}),
    ...(turn.layouts ? { layOut: turn.layouts.layOut.bind(turn.layouts) } : {}),
  });
  let context = noting(contextWith(site?.licence));
  const convert = async () => {
    try {
      const checked = checkOutcome(await importer.convert(data, context), page.url);
      return unopened ? { ok: false as const, message: PACK_NOT_OPENED } : checked;
    } catch (error) {
      return {
        ok: false as const,
        message: unopened ? PACK_NOT_OPENED : importerStoppedMessage(error),
      };
    }
  };
  let outcome = await convert();
  // A site whose pages state no licence: the person confirms one, once, and the page is read with it.
  if (!outcome.ok && outcome.askLicence && site && !context.confirmedLicence) {
    const licence = await askLicence({
      importerId: importer.id,
      importer: importer.title,
      siteKey: site.info.key,
      url: page.url,
      message: outcome.message,
    });
    if (!licence) {
      return {
        kind: 'failed',
        message: LICENCE_NOT_CONFIRMED,
        declined: true,
      };
    }
    await setSiteLicence(importer.id, site.info.key, licence).catch(() => undefined);
    context = noting(contextWith(licence));
    outcome = await convert();
  }
  if (!outcome.ok) {
    return { kind: 'failed', message: outcome.message, ...(outcome.stop ? { refused: true } : {}) };
  }
  // One step at a time changes a pack: this one waits for any other under way.
  const mine = turn.held === outcome.packId ? null : packTurn(outcome.packId);
  try {
    if (mine) {
      if (mine.waits) turn.onWaiting?.();
      await mine.ready;
      // Saved by another step meanwhile: the page is turned into the pack as it is now.
      const read = readAt.get(outcome.packId);
      if (read !== undefined && read !== packSaves(outcome.packId)) {
        outcome = await convert();
        if (!outcome.ok) {
          return {
            kind: 'failed',
            message: outcome.message,
            ...(outcome.stop ? { refused: true } : {}),
          };
        }
      }
    }
    return await saveOutcome(outcome);
  } finally {
    mine?.done();
  }

  async function saveOutcome(
    outcome: Extract<Awaited<ReturnType<typeof convert>>, { ok: true }>,
  ): Promise<ImportPhase> {
    const library = desktop?.library;
    if (!library) return { kind: 'idle' };
    const bundled = context.isBundled(outcome.packId);
    if (bundled && !importer.refreshesBundledGames) {
      return {
        kind: 'failed',
        message: `${outcome.summary.game} comes with this app, so it is not replaced by an import. Nothing was added.`,
      };
    }

    let existing: PackData | null;
    try {
      existing = await context.existingPack(outcome.packId);
    } catch (error) {
      return {
        kind: 'failed',
        message: error instanceof PackNotOpenedError ? PACK_NOT_OPENED : errorText(error),
      };
    }
    if (bundled) {
      // A refresh keeps every map the game has; the shell checks this, and the version, again.
      const missing = (existing?.maps ?? []).filter(
        (map) => !outcome.pack.maps.some((kept) => kept.id === map.id),
      );
      if (missing.length > 0) {
        return {
          kind: 'failed',
          message: `${outcome.summary.game} comes with this app, and refreshing it from this page would leave out maps it came with: ${missing.map((map) => map.name).join(', ')}. Nothing was changed.`,
        };
      }
    }
    // The pages kept with it, without their data: a wiki's can be many, and large.
    const stored = await library
      .importSourceList(outcome.packId, importer.id)
      .catch((): StoredPage[] => []);
    const app = useAtlas.getState().app;
    const manifest = describePack(outcome.pack, {
      ...(existing?.manifest.schemaVersion === 2 && existing.manifest.created
        ? { created: existing.manifest.created }
        : {}),
      updated: rebuilt ? new Date().toISOString() : page.importedAt,
      writtenBy: { name: app?.name ?? 'Atlas', version: app?.version ?? '0.0.0' },
      source: packSource(importer, stored, {
        key: outcome.sourceKey,
        url: page.url,
        mapId: outcome.mapId,
        importedAt: page.importedAt,
      }),
      images: existing ? recordedImages(existing.manifest) : new Map(),
    });
    let listing: Listing;
    try {
      listing = await library.saveImport({
        packId: outcome.packId,
        importer: { id: importer.id, title: importer.title },
        sourceKey: outcome.sourceKey,
        pageUrl: page.url,
        importedAt: page.importedAt,
        ...(outcome.mapId ? { mapId: outcome.mapId } : {}),
        pageData: page.pageData,
        files: packFiles({ ...outcome.pack, manifest }),
        ...(bundled ? { refreshBundled: true } : {}),
        // Pictures a page showed as the person browsed it, read from the page as it loaded them.
        ...(page.way === 'browse' && outcome.pictureFiles
          ? { pictures: Object.fromEntries(outcome.pictureFiles.map((p) => [p.file, p.data])) }
          : {}),
      });
    } catch (error) {
      return { kind: 'failed', message: errorText(error) };
    }
    notePackSaved(outcome.packId);
    applyListing(listing);
    // A new game with the title of one here: offered once to show them under one title.
    if (__ATLAS_DOWNLOADS__ && !existing) void offerSameTitle(outcome.packId);
    const entry = useAtlas.getState().catalog.find((p) => p.id === outcome.packId);
    // Load the new pack and show the imported map; a run does that at its end.
    if (entry && show && outcome.mapId) await showMap(entry, outcome.mapId);
    else if (entry && show) await loadGame(entry);
    // Pages that come with their pictures: fetched now; a run does that at its end.
    const pictures =
      __ATLAS_DOWNLOADS__ &&
      importer.picturesWithPages === true &&
      (outcome.pack.pictures ?? []).some((picture) => picture.remote !== undefined);
    if (pictures && show) fetchPagePictures(outcome.packId);
    // A map's location photos: after its map images; a run does that at its end.
    const photos =
      __ATLAS_DOWNLOADS__ &&
      !pictures &&
      !rebuilt &&
      outcome.mapId !== undefined &&
      listsLocationPhotos(outcome.pack) &&
      (await photosWithMapOn());
    if (photos && show) fetchMapPhotos(outcome.packId);
    // A game of pages built again: how its pages are filed now.
    const filing = rebuilt && outcome.guideId ? pagesFiling(outcome.pack) : null;
    return {
      kind: 'done',
      packId: outcome.packId,
      mapId: outcome.mapId ?? null,
      ...(outcome.guideId ? { guideId: outcome.guideId } : {}),
      ...(outcome.links ? { links: outcome.links } : {}),
      ...(outcome.writtenAgain ? { writtenAgain: outcome.writtenAgain } : {}),
      ...(outcome.pageAddress ? { pageAddress: outcome.pageAddress } : {}),
      title: outcome.summary.game,
      summary: outcome.summary,
      rebuilt,
      ...(pictures ? { pictures: true } : {}),
      ...(photos ? { photos: true } : {}),
      ...(filing ? { filing } : {}),
    };
  }
}

/** How the pages of a game of pages are filed, and the name of its section of pages placed by links. */
export interface PagesFiling extends ContentsFiling {
  /** The title of the section of pages no list page lists ("Pages"). */
  pagesTitle: string;
}

/**
 * How the pages of a game of pages are filed in its contents, as Guides
 * shows them before the person's own changes (see `pageTree.ts` in the
 * core package): nothing for a pack with no section of pages placed by
 * links.
 */
export function pagesFiling(pack: PackData): PagesFiling | null {
  const loose = (pack.sections ?? []).find((section) => section.placeByLinks === true);
  if (!loose) return null;
  const contents = new GuideContents({
    data: pack,
    aliases: pack.manifest.idMigrations,
    homePage: pack.manifest.homePage ?? null,
  });
  return { ...contents.filing(), pagesTitle: loose.title };
}

// ---------------------------------------------------------------------------
// Browse and keep

/** A page of a site read only as the person browses it, asked for in a go or by fetching. */
export const BROWSE_ONLY =
  'This wiki is read only as you browse it, so this app does not open or fetch its pages by itself. Start browsing on its screen in the Library, or add its address again, and each page you open in the window is kept.';

/** A page the person opened while browsing that its importer counts part of another wiki. */
export const OTHER_WIKI =
  'This page is of another wiki than the one you are browsing, so it was not kept. Start browsing that wiki to keep its pages.';

/**
 * Browse and keep: opens `url` in the app's window, browsing, and keeps
 * each page the person opens there that the importer's browse reader reads
 * (an article page), once a page has finished loading: converted and saved
 * like any page, but never more than once while browsing, and never with
 * a pause or a go. The app never opens, moves to or fetches a page itself;
 * the window stays on its site. The pages a kept page links to are kept as
 * found, not read. It ends when the person closes the window or presses
 * Stop browsing ({@link stopBrowse}).
 */
async function startBrowse(
  url: string,
  importer: AtlasImporter,
  site: SiteReading | undefined,
): Promise<void> {
  const shell = desktop;
  if (!shell || !importer.browseReader) return;
  currentRun?.cancel();
  const id = ++session;
  await closeWindow(shell);
  currentImporter = importer.id;
  let state: Extract<ImportPhase, { kind: 'browse' }> = {
    kind: 'browse',
    url,
    importerId: importer.id,
    importer: importer.title,
    site: site?.info.key ?? new URL(url).hostname,
    kept: [],
    note: null,
    ended: false,
  };
  const show = (change: Partial<typeof state>) => {
    state = { ...state, ...change };
    if (id === session) setPhase(state);
  };
  show({});
  try {
    await shell.importWindow.open(
      url,
      importer.browseReader,
      { id: importer.id },
      'map',
      undefined,
      false,
      true,
    );
  } catch (error) {
    show({ ended: true, note: `The window could not be opened: ${errorText(error)}` });
    return;
  }
  // Pages read while browsing, by page key: each once.
  const seen = new Set<string>();
  // The games pages were kept in.
  const browsedInto = new Set<string>();
  while (id === session) {
    await sleep(KEPT_POLL_MS);
    if (id !== session) break;
    let result: Awaited<ReturnType<typeof shell.importWindow.poll>>;
    try {
      result = await shell.importWindow.poll();
    } catch {
      continue;
    }
    if (result.state === 'closed') break;
    if (result.state === 'failed') {
      if (result.message === 'No page is open.') break;
      show({ note: result.message });
      continue;
    }
    if (result.state !== 'ready') continue;
    const address = result.address ?? url;
    // By the whole address but its fragment: a wiki may tell its pages apart by the query.
    const key = address.split('#')[0] ?? address;
    if (!sameSite(url, address) || seen.has(key)) continue;
    seen.add(key);
    // A page of another wiki on the same host (another language, say) is not kept here.
    if (site && siteInfoOf(importer, address).key !== site.info.key) {
      show({ note: OTHER_WIKI });
      continue;
    }
    // The page's style sheets, at once, while the window still shows it.
    const styles = await browsedStyles(shell, importer, address);
    const kept = await keepBrowsed(importer, address, result.data);
    if (kept.packId) {
      browsedInto.add(kept.packId);
      packWritten(kept.packId, { duringGo: true });
      keepStylesOf(shell, importer, address, kept.packId, id, { way: 'browse', styles });
    }
    if (id !== session) break;
    if (kept.title) {
      show({ kept: [...state.kept, { url: address, title: kept.title }], note: null });
    } else if (kept.note) {
      show({ note: kept.note });
    }
    if (kept.stop) break;
  }
  await shell.importWindow.close().catch(() => undefined);
  void flushWikiNotes();
  // The game shown, if pages were kept in it, takes them all in.
  for (const packId of browsedInto) packWritten(packId);
  if (id === session) show({ ended: true });
}

/** The style sheets of a page the person opened while browsing, handed over by the page, for an importer that keeps them. */
async function browsedStyles(
  shell: NonNullable<typeof desktop>,
  importer: AtlasImporter,
  url: string,
): Promise<PageStyles | null> {
  const reader = importer.styleReader;
  if (!reader) return null;
  const packs = useAtlas.getState().library?.packs ?? [];
  const marks = await marksFor(shell.library, gameOfSite(importer, url, packs));
  return readPageStyles(
    (script, argument) => shell.importWindow.runOnce(script, argument),
    reader,
    marks,
  );
}

/** Keeps one page the person opened while browsing: its title once kept, or what happened. */
async function keepBrowsed(
  importer: AtlasImporter,
  url: string,
  data: string,
): Promise<{ title?: string; note?: string; stop?: boolean; packId?: string }> {
  // The wiki's contents, when the person opened them: kept as its contents, not as a page;
  // but when they name the wiki's home page, which the start address shows, as that page too.
  const games = importer.games;
  if (games && safely(() => games.matches(url))) {
    const result = await convertListing({ url, importer, reading: 'game' }, data);
    if (result.ok && 'pages' in result) {
      await noteWikiContents(importer.id, url, result.game, result.pages);
      const note = `The wiki’s contents were read: ${result.pages.length} pages listed.`;
      const home = result.pages.find(
        (page) => page.kind === HOME_PAGE_KIND && canAdd(importer, page.url),
      );
      if (!home) return { note };
      const kept = await keepBrowsedPage(importer, home.url, data);
      return { ...kept, note: kept.note ? `${note} ${kept.note}` : note };
    }
    if (!canAdd(importer, url)) return {};
  }
  if (!canAdd(importer, url)) return {};
  return keepBrowsedPage(importer, url, data);
}

/** Keeps one page the person opened while browsing, as the page at `url`. */
async function keepBrowsedPage(
  importer: AtlasImporter,
  url: string,
  data: string,
): Promise<{ title?: string; note?: string; stop?: boolean; packId?: string }> {
  const outcome = await convertAndSave(
    importer,
    { url, pageData: data, importedAt: new Date().toISOString(), way: 'browse' },
    false,
    false,
  );
  reportPhase(importer.id, outcome);
  if (outcome.kind === 'done') {
    await noteWikiRead(importer.id, url, outcome.links ?? [], outcome.pageAddress).catch(
      () => undefined,
    );
    await noteWikiLinks(importer.id, outcome.writtenAgain ?? []).catch(() => undefined);
    return { title: outcome.summary.map || url, packId: outcome.packId };
  }
  if (outcome.kind === 'failed') {
    void noteWikiFailed(importer.id, url, outcome.message);
    return { note: outcome.message, ...(outcome.declined ? { stop: true } : {}) };
  }
  return {};
}

/** What an importer's function answers, or false when it throws. */
const safely = (answer: () => boolean) => {
  try {
    return answer();
  } catch {
    return false;
  }
};

/** Stop browsing: closes the window; what was kept stays. */
export async function stopBrowse(): Promise<void> {
  if (desktop) await desktop.importWindow.close().catch(() => undefined);
}

/** Starts browsing a wiki from its screen in the Library, at `url` (its contents or a page). */
export async function browseWiki(source: WikiSource, url: string): Promise<void> {
  const importer = (await loadImporters()).find((i) => i.id === source.importerId);
  if (!importer) return;
  showLibraryAdd();
  await startBrowse(url, importer, await readingOf(importer, url));
}

/** A page whose site's licence the person did not confirm. */
export const LICENCE_NOT_CONFIRMED =
  'The wiki’s licence was not confirmed, so nothing was added from this page and no more pages were read.';

/** The answer to the licence question now asked, when it is answered. */
let licenceAnswer: ((licence: SiteLicence | null) => void) | null = null;

/**
 * Asks the person what the licence of a page's site is, and waits for the
 * answer: a licence of `CONFIRMABLE_LICENCES`, words they filled in, no
 * licence, or null when they do not answer now. One question at a time; a
 * run waits on its page meanwhile.
 */
function askLicence(ask: LicenceAsk): Promise<SiteLicence | null> {
  answerLicence(null);
  useImport.setState({ licenceAsk: ask });
  notify(`${ask.importer}: choose the wiki’s licence in the Library to read this page.`, 'info');
  return new Promise((resolve) => {
    licenceAnswer = resolve;
  });
}

/** Each type of answer without its time. */
type WithoutTime<T> = T extends unknown ? Omit<T, 'confirmedAt'> : never;

/** An answer to the licence question, before the app adds when it was given. */
export type LicenceAnswer = WithoutTime<SiteLicence>;

/**
 * The person's answer to the licence question: a licence they confirmed,
 * words they filled in or no licence, checked (see `siteLicenceOf`), or
 * null (not now).
 */
export function answerLicence(licence: LicenceAnswer | null): void {
  const answer = licenceAnswer;
  licenceAnswer = null;
  if (useImport.getState().licenceAsk) useImport.setState({ licenceAsk: null });
  answer?.(licence ? siteLicenceOf({ ...licence, confirmedAt: new Date().toISOString() }) : null);
}

/** Loads a game and shows one of its maps. */
async function showMap(entry: PackEntry, mapId: string): Promise<boolean> {
  if (!(await loadGame(entry))) return false;
  const game = useAtlas.getState().game;
  const layer = game?.pack.layersOf(mapId)[0];
  if (game && layer) useAtlas.setState({ mapId, layerId: layer.id });
  return true;
}

/**
 * Builds an imported pack again from the page data kept with it, without
 * visiting the page: for example after the importer was updated. The pages
 * the importer asks to lay out are laid out as a browser shows them, with
 * the style sheets kept for the game (see `layoutFrame/`). `quiet`: after a
 * session whose pages were written before their sheets came, without
 * showing it in the steps of adding; a line says when it starts and ends.
 */
export async function rebuildPack(
  packId: string,
  { quiet = false }: { quiet?: boolean } = {},
): Promise<void> {
  const shell = desktop;
  const state = useAtlas.getState();
  const listed = state.library?.packs.find((p) => p.id === packId);
  const entry = state.config?.importers.find((i) => i.id === listed?.imported?.importerId);
  if (!shell || !listed?.imported) return;
  if (!entry) {
    notify(
      `${listed.title} was added with “${listed.imported.importerTitle}”, which this app does not have.`,
      'error',
    );
    return;
  }
  // During a go, the game is built again when the go ends.
  if (currentRun) {
    rebuildAfterGo.set(packId, quiet && (rebuildAfterGo.get(packId) ?? true));
    if (!quiet) {
      notify(
        `${listed.title} is built again from its saved pages when the pages being read now are done.`,
        'info',
      );
    }
    return;
  }
  const id = quiet ? session : ++session;
  // Shown only by a build the person asked for, while no other step took the screen.
  const shows = () => !quiet && id === session;
  // One change to the game at a time: a page being saved to it is saved first.
  const turn = packTurn(packId);
  // The sheets kept for the game, read once for the pages to be laid out with.
  const sheets =
    __ATLAS_DOWNLOADS__ && downloadsOffered(state)
      ? shell.library.styleTexts(packId).catch((): KeptSheetText[] => [])
      : Promise.resolve([] as KeptSheetText[]);
  let layouts: PageLayouts | null = null;
  try {
    if (turn.waits && shows()) {
      setPhase({ kind: 'converting', url: listed.url, importer: entry.title, waiting: true });
      showLibraryAdd();
    }
    await turn.ready;
    const importer = await loadImporter(entry);
    // The last page kept, read alone: the importer reads the others itself when it needs them.
    const kept = await shell.library.importSourceList(packId, importer.id);
    const listedLast = kept.at(-1);
    const last = listedLast
      ? await shell.library.importSource(packId, importer.id, listedLast.key)
      : null;
    if (!last) {
      notify(`No page data is kept with ${listed.title}, so it cannot be rebuilt.`, 'error');
      return;
    }
    if (quiet) {
      notify(
        `${listed.title} is built again from its saved pages, so that the pages read before its style sheets were kept are laid out as a browser shows them. Nothing is downloaded.`,
        'info',
      );
    }
    // A go started meanwhile keeps the screen.
    if (shows()) {
      setPhase({
        kind: 'converting',
        url: last.url,
        importer: importer.title,
        // A game of pages: every saved page is written again, which takes a while for many.
        ...(importer.fetch ? { savedPages: kept.length } : {}),
      });
      showLibraryAdd();
    }
    let shownAt = 0;
    let step: { done: number; total: number } | null = null;
    let layingOut = false;
    // How far the saved pages are, shown a few times a second at most.
    const show = (now: boolean) => {
      if (!step || !shows()) return;
      const at = Date.now();
      if (!now && step.done < step.total && at - shownAt < REBUILD_PROGRESS_MS) return;
      shownAt = at;
      setPhase({
        kind: 'converting',
        url: last.url,
        importer: importer.title,
        savedPages: step.total,
        savedDone: step.done,
        ...(layingOut ? { layingOut: true } : {}),
      });
    };
    layouts = layoutsFor(
      packId,
      () => {
        // The first page laid out says so at once; then as often as the figures.
        const first = !layingOut;
        layingOut = true;
        show(first);
      },
      sheets,
    );
    const outcome = await convertAndSave(
      importer,
      { url: last.url, pageData: last.data, importedAt: last.importedAt },
      true,
      !quiet,
      undefined,
      {
        held: packId,
        onProgress: (progress) => {
          step = progress;
          show(false);
        },
        layouts,
      },
    );
    layouts?.close();
    const layout = layoutReport(layouts?.tally() ?? null, (await sheets).length > 0);
    const phase: ImportPhase = outcome.kind === 'done' && layout ? { ...outcome, layout } : outcome;
    reportPhase(importer.id, outcome);
    // The links of the pages written again, this one too, are kept; nothing else about them changes.
    if (importer.fetch && outcome.kind === 'done') {
      await noteWikiLinks(importer.id, [
        { url: last.url, links: outcome.links ?? [], pageAddress: outcome.pageAddress },
        ...(outcome.writtenAgain ?? []),
      ])
        .then(flushWikiNotes)
        .catch(() => undefined);
    }
    if (quiet) {
      if (outcome.kind === 'done') packWritten(packId);
      notify(
        outcome.kind === 'done'
          ? `${listed.title} was built again: ${layoutText(layout) ?? 'its pages were written again.'}`
          : `${listed.title} could not be built again: ${outcome.kind === 'failed' ? outcome.message : 'nothing was changed.'}`,
        outcome.kind === 'done' ? 'info' : 'error',
      );
    }
    if (shows()) setPhase(phase);
  } catch (error) {
    report({ importerId: entry.id, outcome: 'failed', message: errorText(error) });
    if (shows()) setPhase({ kind: 'failed', message: errorText(error) });
  } finally {
    layouts?.close();
    turn.done();
  }
}

/**
 * Leaves the steps of adding for the game open in the Library: back to an
 * empty address box. A run or a page that is open goes on (the strip at the
 * bottom of the Library shows it, with Stop).
 */
export function closeAdding(): void {
  resetImport();
  setDraft('');
  setMeasureFromPage(false);
  showLibraryGame();
}

// ---------------------------------------------------------------------------
// Game pages and the list of games

/** A page that lists others, to read in a listing run. */
interface ListingItem {
  url: string;
  importer: AtlasImporter;
  reading: 'game' | 'catalogue';
}

type ListingResult =
  ({ ok: true } & GameListing) | ({ ok: true } & Catalogue) | ImportFailure | undefined;

/** The page keys of every page the packs in the maps folder were made from. */
function recordedKeys(): Set<string> {
  const packs = useAtlas.getState().library?.packs ?? [];
  return new Set(packs.flatMap((pack) => (pack.pages ?? []).map((page) => pageKey(page.url))));
}

/** The pages a listed pack was made from. */
function recordedPages(packId: string | null): RecordedPage[] {
  if (!packId) return [];
  const pack = useAtlas.getState().library?.packs.find((p) => p.id === packId);
  return (pack?.pages ?? []).map((page) => ({ url: page.url, mapId: page.mapId ?? null }));
}

/** The pack a game page's maps were added to before, if any: one made from one of them. */
function packForListing(importerId: string, listing: GameListing): string | null {
  const keys = new Set(listing.pages.map((page) => pageKey(page.url)));
  const packs = useAtlas.getState().library?.packs ?? [];
  return (
    packs.find(
      (pack) =>
        pack.imported?.importerId === importerId &&
        (pack.pages ?? []).some((page) => keys.has(pageKey(page.url))),
    )?.id ?? null
  );
}

/** Reads what a game page or a list of games returned, and checks it. */
async function convertListing(
  item: ListingItem,
  data: string,
): Promise<NonNullable<ListingResult>> {
  if (data.length > MAX_PAGE_DATA_CHARS) {
    return { ok: false, message: 'The page provided more data than this app accepts.' };
  }
  const state = useAtlas.getState();
  const context: ListingContext = {
    url: item.url,
    app: { name: state.app?.name ?? 'Atlas', version: state.app?.version ?? '' },
  };
  try {
    if (item.reading === 'game') {
      const returned: unknown = await item.importer.games!.convert(parse(data), context);
      return checkGameListing(returned, item.url, item.importer);
    }
    const returned: unknown = await item.importer.catalogue!.convert(parse(data), context);
    return checkCatalogue(returned, item.url, item.importer);
  } catch (error) {
    return {
      ok: false,
      message: `The importer stopped with an error while reading the list: ${errorText(error)}`,
    };
  }
}

/** Records what a list held in the activity log: kinds and counts, never the pages. */
function reportListing(item: ListingItem, result: NonNullable<ListingResult>): void {
  const base = { importerId: item.importer.id, pages: [item.url] };
  if (!result.ok) {
    report({ ...base, outcome: 'listing-failed', message: result.message });
  } else if ('pages' in result) {
    const kinds: Record<string, number> = {};
    for (const page of result.pages) kinds[page.kind] = (kinds[page.kind] ?? 0) + 1;
    const recorded = recordedKeys();
    report({
      ...base,
      outcome: 'game-listed',
      kinds,
      alreadyAdded: result.pages.filter(
        (page) => page.kind === MAP_KIND && recorded.has(pageKey(page.url)),
      ).length,
    });
  } else {
    const listed = new Set(useAtlas.getState().library?.packs.map((pack) => pack.id) ?? []);
    report({
      ...base,
      outcome: 'catalogue-listed',
      games: result.games.length,
      alreadyAdded: result.games.filter((game) => listed.has(game.id)).length,
    });
  }
}

/**
 * Reads pages that list others, one at a time with the pause between them
 * and the stop rules of a run, and returns what each held. Null when it was
 * cancelled or another import took over.
 */
async function readListings(
  items: readonly ListingItem[],
  purpose: ListingPurpose,
): Promise<{ run: RunState; results: ListingResult[] } | null> {
  const shell = desktop;
  if (!shell) return null;
  const id = ++session;
  const results: ListingResult[] = [];
  const run = new ImportRun(
    items.map((item) => item.url),
    0,
    {
      sleep,
      onChange: (state) => {
        if (id === session) setPhase({ kind: 'listing', run: state, purpose });
      },
      async importPage(index, url, update) {
        const item = items[index]!;
        currentImporter = item.importer.id;
        const site = await readingOf(item.importer, url);
        const read = await readPage(
          shell,
          url,
          item.importer,
          id,
          (waiting) => {
            update({ kind: 'open', ...waiting });
          },
          item.reading,
          null,
          null,
          site?.way,
        );
        if (read.state !== 'ready') {
          if (read.state === 'cancelled') {
            report({ importerId: item.importer.id, outcome: 'cancelled' });
          }
          const outcome = outcomeOf(read);
          if (outcome.kind === 'refused') outcome.message = withWindowHint(outcome.message, site);
          results[index] = { ok: false, message: outcome.message };
          return outcome;
        }
        update({ kind: 'converting', of: 'list' });
        const result = await convertListing(item, read.data);
        results[index] = result;
        reportListing(item, result);
        // A wiki's contents, kept for the Library's wiki screen.
        if (item.importer.fetch && result.ok && 'pages' in result) {
          await noteWikiContents(item.importer.id, url, result.game, result.pages);
        }
        if (!result.ok) return { kind: 'failed', message: result.message };
        if ('pages' in result) {
          const count = result.pages.filter((page) => canAdd(item.importer, page.url)).length;
          return {
            kind: 'listed',
            game: result.game,
            count,
            other: result.pages.length - count,
          };
        }
        return { kind: 'listed', game: '', count: result.games.length, other: 0 };
      },
    },
    RUN_PAUSE_MS,
    pauseLeft(),
  );
  currentRun = run;
  const final = await run.run();
  if (currentRun === run) currentRun = null;
  if (id !== session) return null;
  return { run: final, results };
}

const canAdd = (importer: AtlasImporter, url: string) => {
  try {
    return importer.matches(url);
  } catch {
    return false;
  }
};

/** Pages opened in a listing run: those that were not left unread. */
const openedIn = (run: RunState) =>
  run.pages.filter((page) => page.state.kind !== 'not-started' && page.state.kind !== 'waiting')
    .length;

/** Why a listing gave nothing to choose from, for the dialog. */
function listingFailure(run: RunState, result: ListingResult): string {
  if (run.stopReason === 'closed') return closedMessage('game');
  if (result && !result.ok) return result.message;
  return 'The page did not provide a list. Nothing was added.';
}

/** A game address the person pasted: reads its page, then lists its pages to choose from. */
async function startGameAddress(url: string, importer: AtlasImporter): Promise<void> {
  const read = await readListings([{ url, importer, reading: 'game' }], 'game');
  if (!read) return;
  const result = read.results[0];
  if (!result?.ok || !('pages' in result)) {
    const message = listingFailure(read.run, result);
    setPhase({
      kind: 'failed',
      message,
      ...(message.endsWith(WINDOW_HINT) ? { refused: true, how: url } : {}),
    });
    return;
  }
  const packId = packForListing(importer.id, result);
  const game = await withoutLeftOut(
    choiceGame({
      key: url,
      title: result.game,
      importer,
      packId,
      listed: result.pages,
      recorded: recordedPages(packId),
      queues: importer.fetch !== undefined,
      // Its pages open in a window, when the importer says so of the game's own address.
      inWindow: readsInWindow(importer.fetch, url),
    }),
  );
  setPhase({ kind: 'choose', choice: newChoice('add', [game], openedIn(read.run)) });
}

/** The ids of the games in the maps folder, to mark them in a list of games. */
const addedGames = () => new Set(useAtlas.getState().library?.packs.map((pack) => pack.id) ?? []);

/** The list of games this app kept from the last time it read the importer's, if it can be used. */
async function readKeptCatalogue(importer: AtlasImporter): Promise<KeptCatalogue | null> {
  try {
    return keptCatalogue(
      await progressStore().getSetting(SETTINGS.catalogue(importer.id)),
      importer,
    );
  } catch {
    return null;
  }
}

/**
 * A site's list of games: reads it from the site, keeps it for next time,
 * then lists the games to tick (`ticked` stay ticked where still listed).
 */
async function startCatalogue(
  url: string,
  importer: AtlasImporter,
  ticked: readonly string[] = [],
): Promise<void> {
  const read = await readListings([{ url, importer, reading: 'catalogue' }], 'catalogue');
  if (!read) return;
  const result = read.results[0];
  if (!result?.ok || !('games' in result)) {
    setPhase({ kind: 'failed', message: listingFailure(read.run, result) });
    return;
  }
  if (url === importer.catalogue?.address && result.games.length > 0) {
    const kept: KeptCatalogue = { url, readAt: new Date().toISOString(), games: result.games };
    try {
      await progressStore().putSetting(SETTINGS.catalogue(importer.id), kept);
    } catch {
      // Not kept: the list is read again next time.
    }
  }
  setPhase({
    kind: 'catalogue',
    pick: newPick(importer, url, result.games, addedGames(), { ticked }),
  });
}

/** The importers of this build that offer a list of games, with its label. */
export async function catalogueImporters(): Promise<
  { id: string; title: string; label: string; address: string }[]
> {
  const importers = await loadImporters();
  return importers.flatMap((importer) =>
    importer.catalogue
      ? [
          {
            id: importer.id,
            title: importer.title,
            label: importer.catalogue.label ?? `Games on ${importer.title}`,
            address: importer.catalogue.address,
          },
        ]
      : [],
  );
}

/**
 * "Browse games…": shows the importer's list of games as it was last read,
 * or reads it from the site when it has not been read on this device yet.
 * "Update the list" ({@link updateCatalogue}) reads it again.
 */
export async function browseGames(importerId: string): Promise<void> {
  const importer = (await loadImporters()).find((i) => i.id === importerId);
  if (!importer?.catalogue) return;
  const kept = await readKeptCatalogue(importer);
  if (!kept) {
    await startCatalogue(importer.catalogue.address, importer);
    return;
  }
  setPhase({
    kind: 'catalogue',
    pick: newPick(importer, kept.url, kept.games, addedGames(), { keptFrom: kept.readAt }),
  });
}

/** "Update the list": reads the shown list of games from the site again. */
export async function updateCatalogue(): Promise<void> {
  const { phase } = useImport.getState();
  if (phase.kind !== 'catalogue') return;
  const { pick } = phase;
  const importer = (await loadImporters()).find((i) => i.id === pick.importerId);
  if (importer) await startCatalogue(pick.url, importer, pick.ticked);
}

export function setCatalogueQuery(query: string): void {
  const { phase } = useImport.getState();
  if (phase.kind === 'catalogue') setPhase({ ...phase, pick: { ...phase.pick, query } });
}

export function toggleCatalogueGame(id: string): void {
  const { phase } = useImport.getState();
  if (phase.kind === 'catalogue') setPhase({ ...phase, pick: toggleGame(phase.pick, id) });
}

/** "Tick all" and "Tick none" in a site's list of games: the games its search shows. */
export function tickCatalogueGames(ids: readonly string[], on: boolean): void {
  const { phase } = useImport.getState();
  if (phase.kind === 'catalogue') setPhase({ ...phase, pick: tickGames(phase.pick, ids, on) });
}

/**
 * Reads the game page of each game ticked in the list of games (a game
 * with one map needs none), then lists their pages to choose from. Games
 * that do not fit in one go are left for later, and the dialog says so.
 */
export async function readPickedGames(): Promise<void> {
  const { phase } = useImport.getState();
  if (phase.kind !== 'catalogue') return;
  const { pick } = phase;
  const importer = (await loadImporters()).find((i) => i.id === pick.importerId);
  if (!importer) return;
  const plan = planPick(pick);
  const toRead = plan.games.filter((game) => !game.direct);
  const read =
    toRead.length > 0
      ? await readListings(
          toRead.map((game) => ({ url: game.address, importer, reading: 'game' })),
          'catalogue-games',
        )
      : { run: null, results: [] };
  if (!read) return;
  const games = plan.games.map((game): ChoiceGame => {
    const packId = useAtlas.getState().library?.packs.some((p) => p.id === game.id)
      ? game.id
      : null;
    const recorded = recordedPages(packId);
    if (game.direct) {
      return choiceGame({
        key: game.id,
        title: game.name,
        importer,
        packId,
        listed: [{ url: game.address, kind: MAP_KIND, title: game.name }],
        recorded,
      });
    }
    const index = toRead.indexOf(game);
    const result = read.results[index];
    if (result?.ok && 'pages' in result) {
      return choiceGame({
        key: game.id,
        title: game.name,
        importer,
        packId,
        listed: result.pages,
        recorded,
      });
    }
    const reached = read.run?.pages[index]?.state.kind === 'failed';
    return choiceGame({
      key: game.id,
      title: game.name,
      importer,
      packId,
      listed: null,
      recorded,
      tick: false,
      note: reached
        ? `Its game page could not be read: ${result && !result.ok ? result.message : 'no list'}`
        : 'Its game page was not read, because this app stopped early.',
    });
  });
  setPhase({
    kind: 'choose',
    choice: newChoice(
      'add',
      games,
      pickOpened(pick) + (read.run ? openedIn(read.run) : 0),
      plan.leftOut.map((game) => game.name),
    ),
  });
}

// ---------------------------------------------------------------------------
// Updating games

/** The games in the maps folder that were added from web pages with an importer of this app. */
export async function updatableGames(packIds?: readonly string[]): Promise<UpdateGame[]> {
  const state = useAtlas.getState();
  const importers = await loadImporters();
  return (state.library?.packs ?? []).flatMap((pack): UpdateGame[] => {
    if (packIds && !packIds.includes(pack.id)) return [];
    const importer = importers.find((i) => i.id === pack.imported?.importerId);
    const recorded = (pack.pages ?? []).map((page) => ({
      url: page.url,
      mapId: page.mapId ?? null,
    }));
    if (!importer || recorded.length === 0) return [];
    // A game that comes with the app is refreshed only when its importer allows it.
    const bundled = pack.bundled || state.bundledCatalog.some((entry) => entry.id === pack.id);
    if (bundled && !importer.refreshesBundledGames) return [];
    const address =
      recorded.map((page) => gameAddressOf(importer, page.url)).find((a) => a !== null) ?? null;
    return [
      {
        packId: pack.id,
        title: pack.title,
        importerId: importer.id,
        importerTitle: importer.title,
        address,
        recorded,
      },
    ];
  });
}

/** "Update from the site…" for one game: reads its game page at once. */
export async function updateGame(packId: string): Promise<void> {
  showLibraryAdd();
  const games = await updatableGames([packId]);
  if (games.length === 0) {
    setPhase({
      kind: 'failed',
      message: 'This game was not added from web pages this app can read, so it cannot be updated.',
    });
    return;
  }
  await startUpdate(games);
}

/** The wiki a game was read from, for the Library's wiki screen: its importer and the address of its contents. */
export interface WikiSource {
  importerId: string;
  importerTitle: string;
  /** The address of the wiki's contents; null when the importer gives none. */
  address: string | null;
  /** A page's pictures are downloaded with it. */
  pictures: boolean;
  /** Its pages are read in a window kept for a go (`fetch.inWindow`, or as the person chose), with that window's shorter pause. */
  inWindow: boolean;
  /** Where browsing it starts: its contents, else the last page read. */
  start: string;
  /** The site as its importer describes it, when it offers ways to read its sites (`siteInfo`). */
  site: SiteInfo | null;
}

/** The wiki a game was read from, when an importer that fetches its pages made it; null otherwise. */
export async function wikiSourceOf(packId: string): Promise<WikiSource | null> {
  const importers = await loadImporters().catch((): AtlasImporter[] => []);
  const [game] = await updatableGames([packId]);
  const importer = importers.find((i) => i.id === game?.importerId);
  if (!game || !importer?.fetch) return null;
  const at = game.address ?? game.recorded[0]?.url ?? '';
  const site = await readingOf(importer, at);
  return {
    importerId: game.importerId,
    importerTitle: game.importerTitle,
    address: importer.games ? game.address : null,
    pictures: importer.picturesWithPages === true,
    inWindow: site ? site.way === 'window' : readsInWindow(importer.fetch, at),
    start: game.address ?? game.recorded.at(-1)?.url ?? at,
    site: site?.info ?? null,
  };
}

/** The site a wiki in the Library was read from, as the app keeps its notes on it. */
export interface WikiSite {
  importerId: string;
  /** The site's key, as its importer gives it (`siteInfoOf`). */
  key: string;
  /** Where adding it again starts: its contents, else the last page read. */
  start: string;
  /** Another game in the Library was read from the same site, so what the app keeps of the site stays. */
  shared: boolean;
}

/**
 * The site of a wiki in the Library: a game of pages made by an importer
 * that fetches pages; null for anything else, maps included. Nothing is read
 * but the game's own files.
 */
export async function wikiSiteOf(packId: string): Promise<WikiSite | null> {
  const listed = useAtlas.getState().library?.packs.find((p) => p.id === packId);
  if (!listed?.imported) return null;
  const source = await wikiSourceOf(packId);
  const importer = (await loadImporters()).find((i) => i.id === source?.importerId);
  if (!source || !importer) return null;
  let details = useGameFacts.getState().byId[packId]?.details ?? null;
  if (!details && desktop) details = await desktop.packFiles.details(packId).catch(() => null);
  if (gameKind(listed, details) !== 'wiki') return null;
  const key = source.site?.key ?? siteInfoOf(importer, source.start).key;
  const others = (useAtlas.getState().library?.packs ?? []).filter((p) => p.id !== packId);
  return {
    importerId: importer.id,
    key,
    start: source.start,
    shared: siteInLibrary(importer, key, others),
  };
}

/** Whether an address is of the site `key` of an importer, each address asked once. */
function siteTest(importer: AtlasImporter, key: string): (address: string) => boolean {
  const known = new Map<string, boolean>();
  return (address) => {
    let of = known.get(address);
    if (of === undefined) {
      of = siteInfoOf(importer, address).key === key;
      known.set(address, of);
    }
    return of;
  };
}

/**
 * Forgets what this app keeps of one site read with an importer: its wiki
 * notes (see `withoutSite` in `wikiNotes.ts`: its list of pages, the pages
 * that could not be read, left out, their links and other names, the way
 * chosen and the licence confirmed) and its pages kept for later. Nothing
 * of the importer's other sites changes, and nothing is read.
 */
export async function forgetSite(importer: AtlasImporter, key: string): Promise<void> {
  const ofSite = siteTest(importer, key);
  await forgetSiteNotes(importer.id, key, ofSite);
  const games = await readQueue(importer.id);
  const kept = games.flatMap((game): QueuedGame[] =>
    ofSite(game.key) ? [] : [{ ...game, pages: game.pages.filter((page) => !ofSite(page.url)) }],
  );
  const pages = (list: readonly QueuedGame[]) =>
    list.reduce((sum, game) => sum + game.pages.length, 0);
  if (kept.length !== games.length || pages(kept) !== pages(games)) {
    await writeQueue(importer.id, kept);
  }
}

/** {@link forgetSite} for an importer of this app, by its id. */
export async function forgetWikiSite(importerId: string, key: string): Promise<void> {
  const importer = (await loadImporters()).find((i) => i.id === importerId);
  if (!importer) throw new Error('The importer of this wiki is not in this app any more.');
  await forgetSite(importer, key);
}

/** What this app keeps of a site, for the person: its notes, pages kept for later, and whether a game of it is in the Library. */
export interface SiteMemory {
  key: string;
  held: SiteNotesHeld;
  /** Pages kept for later. */
  queued: number;
  inLibrary: boolean;
}

/** What this app keeps of the site of `url`, read with an importer of this app; null when it reads no such site. */
export async function siteMemory(importerId: string, url: string): Promise<SiteMemory | null> {
  const importer = (await loadImporters()).find((i) => i.id === importerId);
  if (!importer) return null;
  const key = siteInfoOf(importer, url).key;
  const ofSite = siteTest(importer, key);
  const notes = await loadWikiNotes(importerId).catch(() => NO_WIKI_NOTES);
  const queued = (await readQueue(importerId))
    .filter((game) => ofSite(game.key) || game.pages.some((page) => ofSite(page.url)))
    .reduce(
      (sum, game) =>
        sum +
        (ofSite(game.key) ? game.pages.length : game.pages.filter((p) => ofSite(p.url)).length),
      0,
    );
  return {
    key,
    held: siteNotesHeld(notes, key, ofSite),
    queued,
    inLibrary: siteInLibrary(importer, key, useAtlas.getState().library?.packs ?? []),
  };
}

/**
 * "Read the contents again": reads the wiki's contents page, one page, and
 * keeps what it lists (see `wikiNotes.ts`); nothing else is read. Returns
 * why it could not be read, or null.
 */
export async function readWikiContents(source: WikiSource): Promise<string | null> {
  if (!source.address) return 'This wiki’s importer gives no contents page.';
  const importer = (await loadImporters()).find((i) => i.id === source.importerId);
  if (!importer?.games) return 'The importer of this wiki is not in this app any more.';
  const read = await readListings([{ url: source.address, importer, reading: 'game' }], 'update');
  if (!read) return null;
  const result = read.results[0];
  if (result?.ok && 'pages' in result) {
    setPhase({ kind: 'idle' });
    return null;
  }
  return listingFailure(read.run, result);
}

/**
 * "Read n pages" on the wiki screen: the pages go to the front of the
 * wiki's pages kept to read, and a go reads them now, one at a time with
 * the pause, as "Read them" does, following their links as far as
 * `follow` says. Pages left out are not read.
 */
export async function readWikiPages(
  source: WikiSource,
  game: string,
  pages: readonly QueuedPage[],
  follow: FollowLinks,
): Promise<void> {
  const key = source.address ?? pages[0]?.url;
  const importer = (await loadImporters()).find((i) => i.id === source.importerId);
  if (!key || !importer) return;
  const leftOut = await leftOutKeys(importer.id).catch(() => new Set<string>());
  const reading = pages.filter((page) => !leftOut.has(pageKey(page.url)));
  if (reading.length === 0) return;
  // Pages kept for later that are read now are off that list.
  const games = await readQueue(importer.id);
  const kept = games.find((g) => g.key === key);
  if (kept) {
    const now = new Set(reading.map((page) => pageKey(page.url)));
    await writeQueue(importer.id, [
      ...games.filter((g) => g.key !== key),
      { ...kept, pages: kept.pages.filter((page) => !now.has(pageKey(page.url))) },
    ]);
  }
  // Every page in one go: a go of these pages has no limit.
  await readChosen(importer, key, game, reading, follow);
}

/** "Update all…": lists the games to update, all ticked, before anything opens. */
export async function updateAll(): Promise<void> {
  showLibraryAdd();
  const games = await updatableGames();
  setPhase({ kind: 'update-games', games, ticked: games.map((game) => game.packId) });
}

export function toggleUpdateGame(packId: string): void {
  const { phase } = useImport.getState();
  if (phase.kind !== 'update-games') return;
  setPhase({
    ...phase,
    ticked: phase.ticked.includes(packId)
      ? phase.ticked.filter((id) => id !== packId)
      : [...phase.ticked, packId],
  });
}

/** "Tick all" and "Tick none" among the games to update. */
export function tickUpdateGames(packIds: readonly string[], on: boolean): void {
  const { phase } = useImport.getState();
  if (phase.kind !== 'update-games') return;
  const named = new Set(packIds);
  setPhase({
    ...phase,
    ticked: on
      ? [
          ...phase.ticked,
          ...phase.games
            .map((game) => game.packId)
            .filter((id) => named.has(id) && !phase.ticked.includes(id)),
        ]
      : phase.ticked.filter((id) => !named.has(id)),
  });
}

/** After "Update all…": reads the game pages of the ticked games. */
export async function confirmUpdateGames(): Promise<void> {
  const { phase } = useImport.getState();
  if (phase.kind !== 'update-games') return;
  const games = phase.games.filter((game) => phase.ticked.includes(game.packId));
  if (games.length > 0) await startUpdate(games);
}

/**
 * Reads the game page of each game that has one, one at a time, then lists
 * each game's pages: from its game page (new maps marked as new), or the
 * pages it was made from when there is no game page or it could not be read.
 */
async function startUpdate(games: readonly UpdateGame[]): Promise<void> {
  const importers = await loadImporters();
  const withAddress = games.filter((game) => game.address !== null);
  report({
    importerId: null,
    outcome: 'update-started',
    games: games.length,
    pages: withAddress.map((game) => game.address!),
  });
  // A wiki read only as the person browses it is never read by an update.
  const browsed = new Set<string>();
  for (const game of games) {
    const importer = importers.find((i) => i.id === game.importerId);
    const at = game.address ?? game.recorded[0]?.url;
    if (importer && at && (await readingOf(importer, at))?.way === 'browse') {
      browsed.add(game.packId);
    }
  }
  const items = withAddress.flatMap((game): ListingItem[] => {
    const importer = importers.find((i) => i.id === game.importerId);
    return importer && !browsed.has(game.packId)
      ? [{ url: game.address!, importer, reading: 'game' }]
      : [];
  });
  const read = items.length > 0 ? await readListings(items, 'update') : { run: null, results: [] };
  if (!read) return;
  const choice = games.flatMap((game): ChoiceGame[] => {
    const importer = importers.find((i) => i.id === game.importerId);
    if (!importer) return [];
    const index = items.findIndex((item) => item.url === game.address);
    const result = index >= 0 ? read.results[index] : undefined;
    const base = {
      key: game.packId,
      title: game.title,
      importer,
      packId: game.packId,
      recorded: game.recorded,
    };
    if (result?.ok && 'pages' in result) return [choiceGame({ ...base, listed: result.pages })];
    if (browsed.has(game.packId)) {
      return [choiceGame({ ...base, listed: null, tick: false, note: BROWSE_ONLY })];
    }
    if (index < 0) {
      return [
        choiceGame({
          ...base,
          listed: null,
          note: 'The importer gives no game page for it, so the pages it was made from are listed.',
        }),
      ];
    }
    const reached = read.run?.pages[index]?.state.kind === 'failed';
    return [
      choiceGame({
        ...base,
        listed: null,
        tick: false,
        note: reached
          ? `Its game page could not be read (${result && !result.ok ? result.message : 'no list'}), so the pages it was made from are listed, unticked.`
          : 'Its game page was not read, because this app stopped early, so the pages it was made from are listed, unticked.',
      }),
    ];
  });
  const kept = await Promise.all(choice.map(withoutLeftOut));
  setPhase({
    kind: 'choose',
    choice: newChoice('update', kept, read.run ? openedIn(read.run) : 0),
  });
}

/** A game's pages to choose from, with the pages the person left out unticked (see `wikiNotes.ts`). */
async function withoutLeftOut(game: ChoiceGame): Promise<ChoiceGame> {
  const leftOut = await leftOutKeys(game.importerId).catch(() => new Set<string>());
  if (leftOut.size === 0) return game;
  return {
    ...game,
    pages: game.pages.map((page) =>
      leftOut.has(pageKey(page.url)) ? { ...page, checked: false } : page,
    ),
  };
}

// ---------------------------------------------------------------------------
// The choice

export function toggleChoice(gameKey: string, url: string): void {
  const { phase } = useImport.getState();
  if (phase.kind === 'choose')
    setPhase({ kind: 'choose', choice: togglePage(phase.choice, gameKey, url) });
}

/** "Tick all" and "Tick none" among the pages to choose: the pages named by `choicePageKey`. */
export function tickChoicePages(keys: readonly string[], on: boolean): void {
  const { phase } = useImport.getState();
  if (phase.kind === 'choose')
    setPhase({ kind: 'choose', choice: tickPages(phase.choice, keys, on) });
}

/** Ticks every page under one heading, or unticks them all. */
export function toggleChoiceGroup(gameKey: string, group: string | null): void {
  const { phase } = useImport.getState();
  if (phase.kind === 'choose')
    setPhase({ kind: 'choose', choice: toggleGroup(phase.choice, gameKey, group) });
}

/** Ticks a page and every page after it ("From here on"). */
export function tickChoiceFrom(gameKey: string, url: string): void {
  const { phase } = useImport.getState();
  if (phase.kind === 'choose')
    setPhase({ kind: 'choose', choice: tickFrom(phase.choice, gameKey, url) });
}

/** "Add N maps" / "Update N maps": the ticked pages, as a run. */
export async function confirmChoice(): Promise<void> {
  const { phase } = useImport.getState();
  if (phase.kind !== 'choose' || overCap(phase.choice)) return;
  const importers = await loadImporters();
  const { now, later } = splitChosen(phase.choice);
  if (now.length === 0) return;
  // Pages that do not fit in this go are kept, to continue with later.
  for (const page of later) await queuePages(page.importerId, page.gameKey, page.game, [page]);
  // How far the links of a wiki's pages are followed, as last chosen for its importer.
  const follow = new Map<string, FollowLinks>();
  for (const page of now) {
    if (page.queues && !follow.has(page.importerId)) {
      follow.set(page.importerId, await followOf(page.importerId));
    }
  }
  const final = await startRun(
    now.map((page) => ({
      url: page.url,
      importer: importers.find((i) => i.id === page.importerId) ?? null,
      problem: null,
      listed: { title: page.title, ...(page.group ? { group: page.group } : {}) },
    })),
    0,
    { update: phase.choice.mode === 'update', firstPauseMs: pauseLeft(), follow },
  );
  await requeueUnread(now, final);
}

// ---------------------------------------------------------------------------
// Pages kept for later (importers that read pages by fetching them)

/** A page kept to read in a later go. */
export interface QueuedPage {
  url: string;
  title: string;
  group?: string;
}

/** The pages of one game kept for later. */
export interface QueuedGame {
  /** The game's key: the address of its list of pages. */
  key: string;
  game: string;
  importerId: string;
  pages: QueuedPage[];
}

async function readQueue(importerId: string): Promise<QueuedGame[]> {
  try {
    const stored = await progressStore().getSetting(SETTINGS.pageQueue(importerId));
    if (!Array.isArray(stored)) return [];
    return stored.filter(
      (game): game is QueuedGame =>
        typeof game === 'object' &&
        game !== null &&
        typeof (game as QueuedGame).key === 'string' &&
        typeof (game as QueuedGame).game === 'string' &&
        Array.isArray((game as QueuedGame).pages),
    );
  } catch {
    return [];
  }
}

async function writeQueue(importerId: string, games: QueuedGame[]): Promise<void> {
  await progressStore()
    .putSetting(
      SETTINGS.pageQueue(importerId),
      games.filter((game) => game.pages.length > 0),
    )
    .catch(() => undefined);
  useImport.setState({ queueVersion: useImport.getState().queueVersion + 1 });
}

/** Adds pages to a game's queue, at its end (or its start), each once. */
async function queuePages(
  importerId: string,
  key: string,
  game: string,
  pages: readonly (QueuedPage & { group?: string })[],
  first = false,
): Promise<void> {
  const games = await readQueue(importerId);
  const known = games.find((g) => g.key === key);
  const kept = known?.pages ?? [];
  const adding = pages
    .filter((page) => !kept.some((k) => pageKey(k.url) === pageKey(page.url)))
    .map((page) => ({
      url: page.url,
      title: page.title,
      ...(page.group ? { group: page.group } : {}),
    }));
  const next: QueuedGame = {
    key,
    game,
    importerId,
    pages: first ? [...adding, ...kept] : [...kept, ...adding],
  };
  await writeQueue(importerId, [...games.filter((g) => g.key !== key), next]);
}

/** Pages of a go that were not read (the go stopped first) go back to the front of their queue. */
async function requeueUnread(pages: readonly ChosenPage[], final: RunState | null): Promise<void> {
  if (!final) return;
  const unread = pages.filter((page, i) => {
    const state = final.pages[i]?.state;
    return (
      page.queues &&
      (state?.kind === 'not-started' || (state?.kind === 'failed' && state.cause === 'refused'))
    );
  });
  for (const page of unread) {
    await queuePages(page.importerId, page.gameKey, page.game, [page], true);
  }
}

/** Every game with pages kept for later, of the importers of this app. */
export async function queuedGames(): Promise<QueuedGame[]> {
  const importers = await loadImporters().catch((): AtlasImporter[] => []);
  const games: QueuedGame[] = [];
  for (const importer of importers.filter((i) => i.fetch)) {
    games.push(...(await readQueue(importer.id)));
  }
  return games;
}

/** Reads the pages kept for a game, all in one go: a go of them has no limit. */
export async function continueQueue(importerId: string, key: string): Promise<void> {
  const importers = await loadImporters();
  const importer = importers.find((i) => i.id === importerId);
  const games = await readQueue(importerId);
  const game = games.find((g) => g.key === key);
  if (!importer || !game || game.pages.length === 0) return;
  // Pages the person left out since they were kept are not read.
  const leftOut = await leftOutKeys(importerId).catch(() => new Set<string>());
  const pages = game.pages.filter((page) => !leftOut.has(pageKey(page.url)));
  const now = pages;
  await writeQueue(importerId, [...games.filter((g) => g.key !== key), { ...game, pages: [] }]);
  if (now.length === 0) return;
  await readChosen(importer, key, game.game, now, await followOf(importerId));
}

/** How far a go follows links for an importer's wikis, as the person last chose. */
async function followOf(importerId: string): Promise<FollowLinks> {
  return (await loadWikiNotes(importerId).catch(() => NO_WIKI_NOTES)).follow;
}

/** Reads pages of a game that keeps pages for later, as one go; those it did not read are kept. */
async function readChosen(
  importer: AtlasImporter,
  key: string,
  game: string,
  pages: readonly QueuedPage[],
  follow: FollowLinks,
): Promise<void> {
  const chosen: ChosenPage[] = pages.map((page) => ({
    url: page.url,
    importerId: importer.id,
    game,
    gameKey: key,
    title: page.title,
    ...(page.group ? { group: page.group } : {}),
    queues: true,
  }));
  const final = await startRun(
    chosen.map((page) => ({
      url: page.url,
      importer,
      problem: null,
      listed: { title: page.title, ...(page.group ? { group: page.group } : {}) },
    })),
    0,
    { firstPauseMs: pauseLeft(), follow: new Map([[importer.id, follow]]) },
  );
  await requeueUnread(chosen, final);
}

/**
 * Forgets the pages kept for a wiki that has no game in the Library (its
 * sessions kept no page, or it was deleted): its pages kept for later, and
 * everything else this app keeps of its site ({@link forgetSite}), as
 * deleting the wiki does. A wiki in the Library keeps what it has.
 */
export async function forgetQueuedWiki(importerId: string, key: string): Promise<void> {
  const importer = (await loadImporters()).find((i) => i.id === importerId);
  await forgetQueue(importerId, key);
  if (!importer) return;
  const site = siteInfoOf(importer, key).key;
  if (siteInLibrary(importer, site, useAtlas.getState().library?.packs ?? [])) return;
  await forgetSite(importer, site);
}

/** Forgets the pages kept for a game. */
export async function forgetQueue(importerId: string, key: string): Promise<void> {
  const games = await readQueue(importerId);
  await writeQueue(
    importerId,
    games.filter((g) => g.key !== key),
  );
}
