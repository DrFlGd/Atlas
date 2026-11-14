import { loadPack, type PackEntry } from '@atlas/core';
import {
  DEFAULT_WAIT_SECONDS,
  FETCH_PAUSE_MS,
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
  type AtlasImporter,
  type ConfirmedLicence,
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
  type PictureSummary,
  type PictureTiles,
  type PictureTilesRequest,
  type ReadingWay,
  type SavedSource,
  type SiteInfo,
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
import { desktop, type ImportReport, type Listing, type StoredPage } from '../desktop';
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
import {
  KEPT_POLL_MS,
  PageWindows,
  closedMessage,
  type PageRead,
  type PageWaiting,
  type Reading,
} from './pageWindow';
import { fetchPagePictures } from './pagePictures';
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
import { showLibraryAdd, showLibraryGame } from './libraryView';
import { asksHow, siteReading, WINDOW_HINT, type SiteReading } from './readingWays';
import { SETTINGS, progressStore } from './services';
import { useAtlas } from './store';
import {
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
      title: string;
      summary: ImportSummary;
      rebuilt: boolean;
      /** Its pictures are being fetched now (see `pagePictures.ts`). */
      pictures?: boolean;
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
      (module) => {
        const importer = asImporter(module.default, `The importer “${entry.title}”`);
        if (importer.id !== entry.id) {
          throw new Error(`The importer “${entry.title}” has a different id than listed.`);
        }
        return importer;
      },
    );
    promise.catch(() => loaded.delete(entry.id));
    loaded.set(entry.id, promise);
  }
  return promise;
}

/** Every importer of this build that loads. */
async function loadImporters(): Promise<AtlasImporter[]> {
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

/** The reader and wait for a page: a map page, a game page or the list of games. */
function readerFor(importer: AtlasImporter, reading: Reading) {
  const part =
    reading === 'game' ? importer.games : reading === 'catalogue' ? importer.catalogue : null;
  return {
    pageReader: part?.pageReader ?? importer.pageReader ?? '() => null',
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
): Promise<PageRead> {
  // A site read only as the person browses it: nothing is opened or fetched by itself.
  if (way === 'browse') return { state: 'failed', message: BROWSE_ONLY };
  const fetcher = fetcherFor(importer, reading, url, way);
  if (fetcher) return fetchPage(shell, url, fetcher, importer, id, reading);
  const { pageReader, waitSeconds } = readerFor(importer, reading);
  return pageWindows.read(
    shell.importWindow,
    { url, importer, pageReader, waitSeconds, reading, measure, keepFor, onWaiting },
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
  const one = async (address: string) => {
    // After the pause between pages, and at least the pause after the last request.
    const wait = Math.max(pauseLeft(), lastFetchAt + FETCH_PAUSE_MS - Date.now());
    if (wait > 0) await sleep(wait);
    if (id !== session) return null;
    try {
      return await shell.tiles.fetchPage(address);
    } finally {
      lastFetchAt = Date.now();
    }
  };
  try {
    for (const address of named.addresses) {
      const origin = new URL(address).origin;
      let robots = robotsOf.get(origin);
      if (robots?.session !== id) {
        const answer = await one(`${origin}/robots.txt`);
        if (!answer) return { state: 'cancelled' };
        const refusal = refusalOf(answer.status, answer.retryAfter);
        if (refusal) return stop(`${refusal} This app stopped and read no more pages.`);
        robots = { session: id, rules: rulesFromAnswer(answer) };
        robotsOf.set(origin, robots);
      }
      if (!robotsAllows(robots.rules, address)) {
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
  setPhase({ kind: 'converting', url, importer: importer.title });
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
  );
  reportPhase(importer.id, outcome);
  if (id !== session) return;
  setPhase(
    outcome.kind === 'failed' && outcome.refused
      ? refusedPhase(outcome.message, url, site)
      : outcome,
  );
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
    // A site that can be read more than one way: the person chooses first, once.
    const reader = findReader(importers, url);
    const site = reader ? await readingOf(reader.importer, url) : undefined;
    if (reader && site && asksHow(site)) {
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

/** Reads one address the person added: a page, a game's page, or a site's list of games. */
async function addAddress(url: string, importers: readonly AtlasImporter[]): Promise<void> {
  const reader = findReader(importers, url);
  // A site read as the person browses it: browsing starts at the address.
  const site = reader ? await readingOf(reader.importer, url) : undefined;
  if (reader && site?.way === 'browse') await startBrowse(url, reader.importer, site);
  else if (reader?.kind === 'game') await startGameAddress(url, reader.importer);
  else if (reader?.kind === 'catalogue') await startCatalogue(url, reader.importer);
  else await startImport(url);
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
          keptInWindow(importer, url, site?.way) ? id : null,
          site?.way,
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
        update({ kind: 'converting' });
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
        );
        // The person did not confirm the site's licence: nothing more is read.
        if (outcome.kind === 'failed' && outcome.declined) run.stop();
        reportPhase(importer.id, outcome);
        if (importer.fetch && outcome.kind === 'done') {
          const { links = [], writtenAgain = [] } = outcome;
          void noteWikiRead(importer.id, url, links).then(() =>
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
    // A page read in the window kept from the page before follows after a shorter pause.
    (index) => {
      const next = pages[index];
      return next && keptInWindow(next.importer, next.url, sites[index]?.way)
        ? pageWindows.pauseBefore(id, next.importer.id, next.url)
        : RUN_PAUSE_MS;
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
  // The links of the pages read, written every few seconds during the go, are all written now.
  void flushWikiNotes();
  // The pictures of the pages added, once the pages are all read: one download a game.
  const withPictures = new Set(
    final.pages.flatMap(({ state }) =>
      state.kind === 'added' && state.pictures ? [state.packId] : [],
    ),
  );
  for (const packId of withPictures) fetchPagePictures(packId);
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
  /** How the page was read, and the licence the person confirmed for its site. */
  site: { reading?: ReadingWay; confirmedLicence?: ConfirmedLicence } = {},
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
    async existingPack(packId) {
      // A pack in the maps folder, else one that comes with the app (to refresh it).
      const url =
        listing?.packs.find((p) => p.id === packId)?.url ??
        state.bundledCatalog.find((p) => p.id === packId)?.url;
      if (!url) return null;
      try {
        return (await loadPack(url)).data;
      } catch {
        return null;
      }
    },
    isBundled: (packId) => bundled.has(packId),
    ...(listed ? { listed } : {}),
    ...(site.reading ? { reading: site.reading } : {}),
    ...(site.confirmedLicence ? { confirmedLicence: site.confirmedLicence } : {}),
    ...(__ATLAS_DOWNLOADS__ && downloadsOffered(state)
      ? {
          pictureTiles: (request: PictureTilesRequest) =>
            measurePicture(request, rebuilt, onMeasuring, rebuilt ? undefined : observations),
          ...(observations && !rebuilt ? { pageObservations: observations } : {}),
        }
      : {}),
  };
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
  const contextWith = (confirmedLicence: ConfirmedLicence | undefined) =>
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
      },
    );
  let context = contextWith(site?.licence);
  const convert = async () => {
    try {
      return checkOutcome(await importer.convert(data, context), page.url);
    } catch (error) {
      return {
        ok: false as const,
        message: `The importer stopped with an error, so nothing was added: ${errorText(error)}`,
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
    context = contextWith(licence);
    outcome = await convert();
  }
  if (!outcome.ok) {
    return { kind: 'failed', message: outcome.message, ...(outcome.stop ? { refused: true } : {}) };
  }
  const bundled = context.isBundled(outcome.packId);
  if (bundled && !importer.refreshesBundledGames) {
    return {
      kind: 'failed',
      message: `${outcome.summary.game} comes with this app, so it is not replaced by an import. Nothing was added.`,
    };
  }

  const existing = await context.existingPack(outcome.packId);
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
  const stored = await shell.library
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
    listing = await shell.library.saveImport({
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
  applyListing(listing);
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
  return {
    kind: 'done',
    packId: outcome.packId,
    mapId: outcome.mapId ?? null,
    ...(outcome.guideId ? { guideId: outcome.guideId } : {}),
    ...(outcome.links ? { links: outcome.links } : {}),
    ...(outcome.writtenAgain ? { writtenAgain: outcome.writtenAgain } : {}),
    title: outcome.summary.game,
    summary: outcome.summary,
    rebuilt,
    ...(pictures ? { pictures: true } : {}),
  };
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
    const kept = await keepBrowsed(importer, address, result.data);
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
  if (id === session) show({ ended: true });
}

/** Keeps one page the person opened while browsing: its title once kept, or what happened. */
async function keepBrowsed(
  importer: AtlasImporter,
  url: string,
  data: string,
): Promise<{ title?: string; note?: string; stop?: boolean }> {
  // The wiki's contents, when the person opened them: kept as its contents, not as a page.
  const games = importer.games;
  if (games && safely(() => games.matches(url))) {
    const result = await convertListing({ url, importer, reading: 'game' }, data);
    if (result.ok && 'pages' in result) {
      await noteWikiContents(importer.id, url, result.game, result.pages);
      return { note: `The wiki’s contents were read: ${result.pages.length} pages listed.` };
    }
    if (!canAdd(importer, url)) return {};
  }
  if (!canAdd(importer, url)) return {};
  const outcome = await convertAndSave(
    importer,
    { url, pageData: data, importedAt: new Date().toISOString(), way: 'browse' },
    false,
    false,
  );
  reportPhase(importer.id, outcome);
  if (outcome.kind === 'done') {
    await noteWikiRead(importer.id, url, outcome.links ?? []).catch(() => undefined);
    await noteWikiLinks(importer.id, outcome.writtenAgain ?? []).catch(() => undefined);
    return { title: outcome.summary.map || url };
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
let licenceAnswer: ((licence: ConfirmedLicence | null) => void) | null = null;

/**
 * Asks the person to confirm the licence of a page's site, and waits for
 * the answer: a licence of `CONFIRMABLE_LICENCES`, or null for none. One
 * question at a time; a run waits on its page meanwhile.
 */
function askLicence(ask: LicenceAsk): Promise<ConfirmedLicence | null> {
  answerLicence(null);
  useImport.setState({ licenceAsk: ask });
  notify(`${ask.importer}: confirm the wiki’s licence in the Library to read this page.`, 'info');
  return new Promise((resolve) => {
    licenceAnswer = resolve;
  });
}

/** The person's answer to the licence question: the licence they confirmed, or null (not now). */
export function answerLicence(licence: { name: string; url: string } | null): void {
  const answer = licenceAnswer;
  licenceAnswer = null;
  if (useImport.getState().licenceAsk) useImport.setState({ licenceAsk: null });
  answer?.(licence ? { ...licence, confirmedAt: new Date().toISOString() } : null);
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
 * visiting the page: for example after the importer was updated.
 */
export async function rebuildPack(packId: string): Promise<void> {
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
  const id = ++session;
  try {
    const importer = await loadImporter(entry);
    // The last page kept, read alone: the importer reads the others itself when it needs them.
    const listedLast = (await shell.library.importSourceList(packId, importer.id)).at(-1);
    const last = listedLast
      ? await shell.library.importSource(packId, importer.id, listedLast.key)
      : null;
    if (!last) {
      notify(`No page data is kept with ${listed.title}, so it cannot be rebuilt.`, 'error');
      return;
    }
    setPhase({ kind: 'converting', url: last.url, importer: importer.title });
    showLibraryAdd();
    const outcome = await convertAndSave(
      importer,
      { url: last.url, pageData: last.data, importedAt: last.importedAt },
      true,
    );
    reportPhase(importer.id, outcome);
    // The links of the pages written again, this one too, are kept; nothing else about them changes.
    if (importer.fetch && outcome.kind === 'done') {
      await noteWikiLinks(importer.id, [
        { url: last.url, links: outcome.links ?? [] },
        ...(outcome.writtenAgain ?? []),
      ])
        .then(flushWikiNotes)
        .catch(() => undefined);
    }
    if (id === session) setPhase(outcome);
  } catch (error) {
    report({ importerId: entry.id, outcome: 'failed', message: errorText(error) });
    if (id === session) setPhase({ kind: 'failed', message: errorText(error) });
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
        update({ kind: 'converting' });
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

/** Forgets the pages kept for a game. */
export async function forgetQueue(importerId: string, key: string): Promise<void> {
  const games = await readQueue(importerId);
  await writeQueue(
    importerId,
    games.filter((g) => g.key !== key),
  );
}
