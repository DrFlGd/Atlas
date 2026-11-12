import { loadPack, type PackEntry } from '@atlas/core';
import {
  DEFAULT_WAIT_SECONDS,
  MAP_KIND,
  MAX_PAGE_DATA_CHARS,
  asImporter,
  checkCatalogue,
  checkGameListing,
  checkOutcome,
  checkPictureTiles,
  findCatalogueImporter,
  findGameImporter,
  findImporter,
  gameAddressOf,
  isAllowedPageUrl,
  isPictureRequest,
  pageKey,
  type AtlasImporter,
  type Catalogue,
  type GameListing,
  type ImportContext,
  type ImportFailure,
  type ImportSummary,
  type ListingContext,
  type PictureSummary,
  type PictureTiles,
  type PictureTilesRequest,
  type SavedSource,
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
import { desktop, type ImportReport, type Listing, type StoredSource } from '../desktop';
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
import {
  chosenPages,
  choiceGame,
  keptCatalogue,
  newChoice,
  newPick,
  overCap,
  pickOpened,
  planPick,
  toggleGame,
  togglePage,
  type Choice,
  type ChoiceGame,
  type GamePick,
  type KeptCatalogue,
  type RecordedPage,
} from './gameChoice';
import { RUN_PAUSE_MS } from './importRun';
import { applyListing } from './library';
import { SETTINGS, progressStore } from './services';
import { useAtlas } from './store';

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
      /** The map the page became; null for a checklist. */
      mapId: string | null;
      title: string;
      summary: ImportSummary;
      rebuilt: boolean;
    }
  | { kind: 'failed'; message: string }
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

export const useImport = create<{ phase: ImportPhase; draft: string }>()(() => ({
  phase: { kind: 'idle' },
  draft: '',
}));

const setPhase = (phase: ImportPhase) => {
  useImport.setState({ phase });
};

/** How often the open page is asked for its data. */
export const POLL_MS = 2000;
/** After this long, the dialog explains what may be holding the page up. */
export const STILL_WAITING_SECONDS = 20;

/** A wait in words: "45 seconds", "5 minutes". */
export const waitText = (seconds: number) =>
  seconds < 120 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;

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
  const text = picture.measured
    ? tiles === undefined
      ? 'The map picture was measured on the image server.'
      : `The map picture was measured: ${tiles === 1 ? '1 map image of it was' : `${tiles} map images of it were`} found on the image server.`
    : 'The map picture could not be measured, so its size was estimated from where the places are.';
  const note = picture.note?.trim();
  if (!note) return text;
  return `${text} ${note.endsWith('.') ? note : `${note}.`}`;
}

/** The importer of the import in progress, for the log. */
let currentImporter: string | null = null;

/** When the page window last closed: the next page opens no sooner than the pause after it. */
let lastClosedAt = 0;

/** What is left of the pause after the page window last closed. */
const pauseLeft = () => Math.max(0, lastClosedAt + RUN_PAUSE_MS - Date.now());

const closeWindow = async (shell: NonNullable<typeof desktop>) => {
  await shell.importWindow.close().catch(() => undefined);
  lastClosedAt = Date.now();
};

/** What a page is read for. */
type Reading = 'map' | 'game' | 'catalogue';

const READING_NOUN: Record<Reading, string> = {
  map: 'the map data',
  game: 'the list of its pages',
  catalogue: 'the list of games',
};

// ---------------------------------------------------------------------------
// Waiting for the page

let session = 0;

/** How reading one page ended. */
type PageRead =
  | { state: 'ready'; data: string }
  /** The person closed the page window. */
  | { state: 'closed'; message: string }
  /** The page's data could not be used (not JSON, too large). */
  | { state: 'failed'; message: string }
  /** The data did not appear within the wait (reported to the log). */
  | { state: 'timed-out'; message: string }
  /** The window did not open. */
  | { state: 'open-failed'; message: string }
  /** Another import or a cancel took over. */
  | { state: 'cancelled' };

const closedMessage = (reading: Reading) =>
  `The page window was closed before the page provided ${READING_NOUN[reading]}. Nothing was added.`;

/** The reader and wait for a page: a map page, a game page or the list of games. */
function readerFor(importer: AtlasImporter, reading: Reading) {
  const part =
    reading === 'game' ? importer.games : reading === 'catalogue' ? importer.catalogue : null;
  return {
    pageReader: part?.pageReader ?? importer.pageReader,
    waitSeconds: part?.waitSeconds ?? importer.waitSeconds ?? DEFAULT_WAIT_SECONDS,
  };
}

/**
 * Opens `url` in the import window, asks it for its data every few seconds
 * until it appears, the window is closed or the wait runs out, and closes
 * the window. The same for one page and for each page of a run, and for a
 * game page or a list of games with the importer's reader for those.
 */
async function readPage(
  shell: NonNullable<typeof desktop>,
  url: string,
  importer: AtlasImporter,
  id: number,
  onWaiting: (waiting: {
    startedAt: number;
    now: number;
    waitSeconds: number;
    loading: boolean;
    note: string | null;
  }) => void,
  reading: Reading = 'map',
): Promise<PageRead> {
  const { pageReader, waitSeconds } = readerFor(importer, reading);
  const startedAt = Date.now();
  onWaiting({ startedAt, now: startedAt, waitSeconds, loading: true, note: null });
  try {
    await shell.importWindow.open(url, pageReader, { id: importer.id, waitSeconds }, reading);
  } catch (error) {
    lastClosedAt = Date.now();
    return id === session
      ? { state: 'open-failed', message: errorText(error) }
      : { state: 'cancelled' };
  }

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (id !== session) return { state: 'cancelled' };
    const now = Date.now();
    if (now - startedAt > waitSeconds * 1000) {
      await closeWindow(shell);
      const message = `The page did not provide ${READING_NOUN[reading]} within ${waitText(waitSeconds)}. If it asked you to sign in, to confirm you are a person or to wait, it may not have let the ${reading === 'map' ? 'map' : 'page'} load; you can try again later. Nothing was added.`;
      report({ importerId: importer.id, outcome: 'timed-out', message });
      return { state: 'timed-out', message };
    }
    let result;
    try {
      result = await shell.importWindow.poll();
    } catch (error) {
      result = { state: 'failed', message: errorText(error) } as const;
    }
    if (id !== session) return { state: 'cancelled' };
    if (result.state === 'waiting') {
      onWaiting({ startedAt, now, waitSeconds, loading: result.loading, note: result.note });
      continue;
    }
    await closeWindow(shell);
    if (result.state === 'closed') return { state: 'closed', message: closedMessage(reading) };
    if (result.state === 'failed') return { state: 'failed', message: result.message };
    return { state: 'ready', data: result.data };
  }
}

/** Starts an import from a page address. */
export async function startImport(text: string): Promise<void> {
  const shell = desktop;
  if (!shell) return;
  const url = text.trim();
  const id = ++session;
  const importers = await loadImporters();
  const importer = findImporter(importers, url);
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
  const read = await readPage(shell, url, importer, id, (waiting) => {
    setPhase({ kind: 'waiting', url, importer: importer.title, ...waiting });
  });
  if (read.state === 'cancelled') return;
  if (read.state !== 'ready') {
    if (id === session) setPhase({ kind: 'failed', message: read.message });
    return;
  }
  setPhase({ kind: 'converting', url, importer: importer.title });
  const outcome = await convertAndSave(
    importer,
    { url, pageData: read.data, importedAt: new Date().toISOString() },
    false,
    true,
    () => {
      if (id === session) {
        setPhase({ kind: 'converting', url, importer: importer.title, measuring: true });
      }
    },
  );
  reportPhase(importer.id, outcome);
  if (id === session) setPhase(outcome);
}

/** Stops waiting and closes the page window; a run stops with it. */
export async function cancelImport(): Promise<void> {
  if (useImport.getState().phase.kind === 'waiting') {
    report({ importerId: currentImporter, outcome: 'cancelled' });
  }
  currentRun?.cancel();
  session++;
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
  // A map page first; then a game's page, or a site's list of games.
  const listing = (url: string) =>
    findImporter(importers, url)
      ? null
      : findGameImporter(importers, url)
        ? 'game'
        : findCatalogueImporter(importers, url)
          ? 'catalogue'
          : null;
  if (addresses.length === 1) {
    const url = addresses[0]!;
    const kind = listing(url);
    if (kind === 'game') await startGameAddress(url, findGameImporter(importers, url)!);
    else if (kind === 'catalogue')
      await startCatalogue(url, findCatalogueImporter(importers, url)!);
    else await startImport(url);
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
  }
};

/**
 * Works through several pages, one at a time, in the order given (see
 * `importRun.ts`), then shows the game of the last map added.
 */
async function startRun(
  checked: readonly CheckedAddress<AtlasImporter>[],
  leftOut: number,
  { update = false, firstPauseMs = 0 }: { update?: boolean; firstPauseMs?: number } = {},
): Promise<void> {
  const shell = desktop;
  if (!shell) return;
  const pages = checked.flatMap(({ url, importer }) => (importer ? [{ url, importer }] : []));
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
        const importer = pages[index]!.importer;
        currentImporter = importer.id;
        const read = await readPage(shell, url, importer, id, (waiting) => {
          update({ kind: 'open', ...waiting });
        });
        if (read.state !== 'ready') {
          if (read.state === 'cancelled') {
            report({ importerId: importer.id, outcome: 'cancelled' });
          }
          return outcomeOf(read);
        }
        update({ kind: 'converting' });
        const outcome = await convertAndSave(
          importer,
          { url, pageData: read.data, importedAt: new Date().toISOString() },
          false,
          false,
          () => {
            update({ kind: 'converting', measuring: true });
          },
        );
        reportPhase(importer.id, outcome);
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
          };
        }
        return {
          kind: 'failed',
          message: outcome.kind === 'failed' ? outcome.message : 'Nothing was added.',
        };
      },
    },
    RUN_PAUSE_MS,
    firstPauseMs,
  );
  currentRun = run;
  report({
    importerId: null,
    outcome: 'run-started',
    pages: pages.map((page) => page.url),
    run: { leftOut },
    ...(update ? { update } : {}),
  });
  const final = await run.run();
  if (currentRun === run) currentRun = null;
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
  if (id !== session) return;

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
): Promise<PictureTiles | null> {
  const shell = desktop;
  if (!__ATLAS_DOWNLOADS__ || !shell || !isPictureRequest(request)) return null;
  const asked: PictureTilesRequest = {
    urlTemplate: request.urlTemplate,
    zoom: request.zoom,
    start: [request.start[0], request.start[1]],
    cachedOnly: rebuilt || request.cachedOnly === true,
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
 * map's picture. Exported for tests.
 */
export function importContext(
  url: string,
  importedAt: string,
  importerId: string,
  rebuilt = false,
  onMeasuring?: () => void,
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
    ...(__ATLAS_DOWNLOADS__ && downloadsOffered(state)
      ? {
          pictureTiles: (request: PictureTilesRequest) =>
            measurePicture(request, rebuilt, onMeasuring),
        }
      : {}),
  };
}

/** The `source` block of the manifest: every page the pack was made from. */
function packSource(
  importer: AtlasImporter,
  stored: readonly StoredSource[],
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
  for (const name of COLLECTION_NAMES) {
    files[PACK_COLLECTIONS[name].file] = `${JSON.stringify(pack[name], null, 2)}\n`;
  }
  return files;
}

/**
 * Hands page data to the importer, checks what it returns, and writes the
 * pack. Returns the phase to show.
 */
async function convertAndSave(
  importer: AtlasImporter,
  page: { url: string; pageData: string; importedAt: string },
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
  const context = importContext(page.url, page.importedAt, importer.id, rebuilt, onMeasuring);
  let returned: unknown;
  try {
    returned = await importer.convert(data, context);
  } catch (error) {
    return {
      kind: 'failed',
      message: `The importer stopped with an error, so nothing was added: ${errorText(error)}`,
    };
  }
  const outcome = checkOutcome(returned);
  if (!outcome.ok) return { kind: 'failed', message: outcome.message };
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
  const stored = await shell.library
    .importSources(outcome.packId, importer.id)
    .catch((): StoredSource[] => []);
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
    });
  } catch (error) {
    return { kind: 'failed', message: errorText(error) };
  }
  applyListing(listing);
  const entry = useAtlas.getState().catalog.find((p) => p.id === outcome.packId);
  // Load the new pack and show the imported map; a run does that at its end.
  if (entry && show && outcome.mapId) await showMap(entry, outcome.mapId);
  else if (entry && show) await loadGame(entry);
  return {
    kind: 'done',
    packId: outcome.packId,
    mapId: outcome.mapId ?? null,
    title: outcome.summary.game,
    summary: outcome.summary,
    rebuilt,
  };
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
    const stored = await shell.library.importSources(packId, importer.id);
    const last = stored.at(-1);
    if (!last) {
      notify(`No page data is kept with ${listed.title}, so it cannot be rebuilt.`, 'error');
      return;
    }
    setPhase({ kind: 'converting', url: last.url, importer: importer.title });
    useAtlas.setState({ addMapOpen: true, mapsDialogOpen: false });
    const outcome = await convertAndSave(
      importer,
      { url: last.url, pageData: last.data, importedAt: last.importedAt },
      true,
    );
    reportPhase(importer.id, outcome);
    if (id === session) setPhase(outcome);
  } catch (error) {
    report({ importerId: entry.id, outcome: 'failed', message: errorText(error) });
    if (id === session) setPhase({ kind: 'failed', message: errorText(error) });
  }
}

export function setAddMapOpen(open: boolean): void {
  useAtlas.setState({ addMapOpen: open });
  if (!open) {
    resetImport();
    setDraft('');
  }
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
        const read = await readPage(
          shell,
          url,
          item.importer,
          id,
          (waiting) => {
            update({ kind: 'open', ...waiting });
          },
          item.reading,
        );
        if (read.state !== 'ready') {
          if (read.state === 'cancelled') {
            report({ importerId: item.importer.id, outcome: 'cancelled' });
          }
          const outcome = outcomeOf(read);
          results[index] = { ok: false, message: outcome.message };
          return outcome;
        }
        update({ kind: 'converting' });
        const result = await convertListing(item, read.data);
        results[index] = result;
        reportListing(item, result);
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
    setPhase({ kind: 'failed', message: listingFailure(read.run, result) });
    return;
  }
  const packId = packForListing(importer.id, result);
  const game = choiceGame({
    key: url,
    title: result.game,
    importer,
    packId,
    listed: result.pages,
    recorded: recordedPages(packId),
  });
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
  useAtlas.setState({ addMapOpen: true, mapsDialogOpen: false });
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

/** "Update all…": lists the games to update, all ticked, before anything opens. */
export async function updateAll(): Promise<void> {
  useAtlas.setState({ addMapOpen: true, mapsDialogOpen: false });
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
  const items = withAddress.flatMap((game): ListingItem[] => {
    const importer = importers.find((i) => i.id === game.importerId);
    return importer ? [{ url: game.address!, importer, reading: 'game' }] : [];
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
  setPhase({
    kind: 'choose',
    choice: newChoice('update', choice, read.run ? openedIn(read.run) : 0),
  });
}

// ---------------------------------------------------------------------------
// The choice

export function toggleChoice(gameKey: string, url: string): void {
  const { phase } = useImport.getState();
  if (phase.kind === 'choose')
    setPhase({ kind: 'choose', choice: togglePage(phase.choice, gameKey, url) });
}

/** "Add N maps" / "Update N maps": the ticked pages, as a run. */
export async function confirmChoice(): Promise<void> {
  const { phase } = useImport.getState();
  if (phase.kind !== 'choose' || overCap(phase.choice)) return;
  const importers = await loadImporters();
  const pages = chosenPages(phase.choice);
  if (pages.length === 0) return;
  await startRun(
    pages.map(({ url, importerId }) => ({
      url,
      importer: importers.find((i) => i.id === importerId) ?? null,
      problem: null,
    })),
    0,
    { update: phase.choice.mode === 'update', firstPauseMs: pauseLeft() },
  );
}
