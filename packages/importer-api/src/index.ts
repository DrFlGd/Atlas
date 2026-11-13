/**
 * The contract between the Atlas desktop app and an importer: a JavaScript
 * module, added to a desktop build at build time (`ATLAS_BUNDLE_IMPORTERS`),
 * that turns the data a web page holds into an Atlas pack.
 *
 * The app does the browsing and the file handling; the importer only knows
 * the page:
 *
 * 1. The person pastes a page URL. The app asks each installed importer's
 *    {@link AtlasImporter.matches} whether it recognises it.
 * 2. The app opens the page in a visible window of its own and evaluates
 *    {@link AtlasImporter.pageReader} in it every few seconds, until the
 *    reader returns something other than `null` or `undefined`, the person
 *    closes the window or the wait times out. The page itself is given no
 *    way to call the app.
 * 3. The value the reader returned (the "page data") is capped in size,
 *    parsed as JSON and handed to {@link AtlasImporter.convert} in the app's
 *    own window, with a {@link ImportContext} for merging with earlier
 *    imports. Page data is untrusted: the importer validates it.
 * 4. The app validates the returned pack with the pack schema, writes it to
 *    the maps folder with a description in its manifest, and keeps the page
 *    data in the pack folder so the pack can be rebuilt later without
 *    visiting the page again.
 *
 * An app that downloads map images may also measure a map's picture for
 * `convert` (see {@link ImportContext.pictureTiles}): which tiles of one zoom
 * of an image set exist on its server. When the person asks for it, such an
 * app can also watch which images the page itself loads while an importer's
 * script zooms the page out (see {@link AtlasImporter.pageMeasure} and
 * {@link ImportContext.pageObservations}). Importers must work without both.
 */

import {
  GAME_ID_PATTERN,
  checkPackIntegrity,
  idOf,
  isAllowedRemoteUrl,
  packDataSchema,
  type PackData,
} from '@atlas/schema';
import { z } from 'zod';
import { MAX_PAGE_FETCHES, type PageFetch, type ReadingWay } from './fetching';
import type { ConfirmedLicence, SiteInfo } from './sites';

export * from './fetching';
export * from './sites';

/** The contract version described here. */
export const IMPORTER_API_VERSION = 1;

/** Importer ids and page data keys: short, lowercase, safe as file names. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** How long the app waits for the page data by default, and the limits an importer may set. */
export const DEFAULT_WAIT_SECONDS = 300;
export const MIN_WAIT_SECONDS = 30;
export const MAX_WAIT_SECONDS = 900;

/** Page data larger than this (as JSON text) is refused. The desktop shell enforces the same. */
export const MAX_PAGE_DATA_CHARS = 64 * 1024 * 1024;

/** A page reader's source text longer than this is refused. */
export const MAX_READER_CHARS = 64 * 1024;

/** Page data an importer stored with a pack in an earlier import. */
export interface SavedSource {
  /** The importer's key for the page within the pack, for example the map's slug. */
  key: string;
  url: string;
  /** ISO 8601 time of that import. */
  importedAt: string;
  /** What the page reader returned then. */
  data: unknown;
}

/** A page an importer stored with a pack, without its data (see {@link ImportContext.savedPages}). */
export type SavedPage = Omit<SavedSource, 'data'>;

export interface ImportContext {
  /** The page URL the person entered. */
  url: string;
  /** ISO 8601 time of this import. */
  importedAt: string;
  /** The app doing the import. */
  app: { name: string; version: string };
  /**
   * Page data this importer stored with the pack `packId` in earlier imports,
   * oldest first. Empty when there is no such pack, or it was not made by
   * this importer.
   */
  savedSources(packId: string): Promise<SavedSource[]>;
  /**
   * Optional: the pages this importer stored with the pack `packId`, as
   * {@link savedSources} gives them but without their data, oldest first.
   * With {@link savedSource}, for an importer that goes through many kept
   * pages (a wiki's, say), so it holds one page's data at a time rather
   * than every page's. An app that offers one offers both; an importer must
   * check that they are there and use `savedSources` otherwise.
   */
  savedPages?(packId: string): Promise<SavedPage[]>;
  /**
   * Optional, with {@link savedPages}: the data of one page stored with the
   * pack, by its key; null when there is no such page or its data cannot
   * be read.
   */
  savedSource?(packId: string, key: string): Promise<SavedSource | null>;
  /**
   * The pack the import would replace, if one with that id is in the maps
   * folder: for example to keep each location's `since` version.
   */
  existingPack(packId: string): Promise<PackData | null>;
  /** Whether a pack with that id comes with the app; the app does not replace those. */
  isBundled(packId: string): boolean;
  /**
   * Optional: which tiles of one zoom of an image set exist on its server,
   * for an importer whose site does not say how large a map's picture is.
   * Only an app that downloads map images offers it; an importer must check
   * that it is there and work without it, and an app works the same with
   * importers that never call it.
   *
   * The app asks the image server for the start tile first, then for the
   * eight neighbours of every tile that exists, and never for the
   * neighbours of one that does not, staying inside the world of that zoom
   * and asking at most {@link PICTURE_MAX_REQUESTS} times. It uses its own
   * downloader for this, with its request headers, pace and rules: an
   * answer it cannot take for an image or for "not on the server" ends the
   * measurement, and nothing is tried again or around it. It keeps what it
   * learnt, so no tile is asked for twice, and once the pack is saved it
   * puts the tiles it found into each layer whose remote source has the
   * same `urlTemplate` and a level at that zoom, so "Download map images"
   * does not ask for them again.
   *
   * The answer is `null` when the app cannot measure: in a build without
   * downloads, for an address it does not allow (see
   * {@link isAllowedPictureTemplate}), when the start tile is not an image,
   * when the server refused or answered in a way it did not expect, or with
   * `cachedOnly` when it has learnt nothing about that image set. Call it
   * from `convert` only; it may take a while (a few hundred requests at the
   * app's pace at most), and it never rejects.
   *
   * What a page showed counts too (see {@link PictureTilesRequest.page}):
   * tiles the app knows from a page are known without a request, every
   * tile a page showed as there is in `present`, and the answer may then
   * leave out a start tile it knows nothing about.
   */
  pictureTiles?(request: PictureTilesRequest): Promise<PictureTiles | null>;
  /**
   * Optional: what the page loaded while it was measured with the
   * importer's {@link AtlasImporter.pageMeasure} script. Only an app that
   * downloads map images offers it, only when the person ticked "measure
   * the map picture from the page" for this import, and only for a page the
   * script applies to. It is never there for a rebuild. Like page data it
   * comes from the page and is untrusted: the app has checked its shape and
   * bounds ({@link checkPageObservations}), the importer decides what it
   * means.
   */
  pageObservations?: PageObservations;
  /**
   * Optional: how the page was listed, when it was chosen from a game's
   * list of pages (see {@link GamePages}): its title there and the heading
   * it was under, for an importer that files pages under sections.
   */
  listed?: { title: string; group?: string };
  /**
   * Optional: how the page was read, as the person chose for its site
   * among the ways {@link AtlasImporter.siteInfo} offers. Apps that do not
   * know it leave it out.
   */
  reading?: ReadingWay;
  /**
   * Optional: the Creative Commons licence the person confirmed for the
   * site of the page (see {@link ImportFailure.askLicence}), kept by the
   * app per site. An importer uses it only for a page that states no
   * licence it can read, says in what it writes that the person confirmed
   * it, and never in place of a licence the page states.
   */
  confirmedLicence?: ConfirmedLicence;
}

// ---------------------------------------------------------------------------
// Measuring a map's picture (optional)

/** The most tiles one measurement asks the image server for. The desktop shell enforces the same. */
export const PICTURE_MAX_REQUESTS = 256;
/** The highest zoom a measurement may ask about. */
export const PICTURE_MAX_ZOOM = 30;
/**
 * The most tiles an answer may list, present and absent together. What the
 * app learnt in several measurements adds up, so this is well above what
 * one measurement finds.
 */
export const PICTURE_MAX_TILES = 65536;

/** What an importer asks {@link ImportContext.pictureTiles}. */
export interface PictureTilesRequest {
  /**
   * The image set's address template, in the form of a pack layer's
   * `tiles.remote.urlTemplate`: `https` (plain `http` only on this computer,
   * for tests), with `{z}`, `{x}` (column) and `{y}` (row) in whatever order
   * the server uses. The tiles found are put into the layers whose remote
   * source has exactly this template.
   */
  urlTemplate: string;
  /** The zoom whose tiles are asked about, usually the coarsest one the server has. */
  zoom: number;
  /**
   * The tile to start from, as [column, row] at `zoom`: one that is part of
   * the picture, such as the tile the site's own page opens on.
   */
  start: [x: number, y: number];
  /**
   * Answer only from what the app learnt in earlier measurements, without
   * any request: for pages that are only built again with a new one.
   */
  cachedOnly?: boolean;
  /**
   * Tiles of this image set and zoom that the page of this import showed,
   * worked out by the importer from {@link ImportContext.pageObservations}:
   * `present`, tiles the page loaded as images, or loaded an image inside
   * of at a finer zoom; `absent`, tiles the page
   * was told are not there (404 or 410, or a store's "access denied" after
   * the page had loaded an image of this image set from that host). Only
   * with page observations of the same import: the app checks every tile
   * against them (the template filled in, compared without query or
   * fragment) and refuses the whole request when one does not fit.
   *
   * The app keeps them with what it learnt about this image set and zoom,
   * as known from a page, for this and every later answer, `cachedOnly`
   * ones too: such tiles are never asked for, every tile a page showed as
   * there is in `present`, and a tile known as there stays so. No image of
   * them is kept, so they are not put into the pack's layers; "Download map
   * images" fetches them as usual.
   */
  page?: PageTiles;
}

/** Tiles a page showed, as [column, row] (see {@link PictureTilesRequest.page}). */
export interface PageTiles {
  present: [x: number, y: number][];
  absent: [x: number, y: number][];
}

/** What {@link ImportContext.pictureTiles} found. */
export interface PictureTiles {
  zoom: number;
  /**
   * The tiles that exist, as [column, row]: the start tile among them,
   * unless the app knows nothing about it and answers from what a page
   * showed (`fromPage` above 0).
   */
  present: [x: number, y: number][];
  /** Neighbours of those that the server does not have, as [column, row]. */
  absent: [x: number, y: number][];
  /**
   * Every neighbour of every tile that exists was asked about (inside the
   * world), or is known from a page, so the picture lies within `present`.
   * False when the app stopped at {@link PICTURE_MAX_REQUESTS}, or, with
   * `cachedOnly`, when it had not learnt them all.
   */
  complete: boolean;
  /** How many of `present` the app knows only from what a page showed. */
  fromPage?: number;
}

/**
 * Whether the app may measure the image set at this address template:
 * `https`, or `http` on this computer (tests), with no user name or
 * password, and `{z}`, `{x}` and `{y}` in it.
 */
export function isAllowedPictureTemplate(template: string): boolean {
  if (!isAllowedRemoteUrl(template)) return false;
  if (!['{z}', '{x}', '{y}'].every((part) => template.includes(part))) return false;
  const authority = template.replace(/^https?:\/\//, '').split(/[/?#]/)[0] ?? '';
  return authority.length > 0 && !authority.includes('@');
}

const tileSchema = z.tuple([z.int().nonnegative(), z.int().nonnegative()]);

const pictureTilesSchema = z.strictObject({
  zoom: z.int().min(0).max(PICTURE_MAX_ZOOM),
  present: z.array(tileSchema).min(1).max(PICTURE_MAX_TILES),
  absent: z.array(tileSchema).max(PICTURE_MAX_TILES),
  complete: z.boolean(),
  fromPage: z.int().nonnegative().optional(),
});

const pageTilesSchema = z.strictObject({
  present: z.array(tileSchema).max(PICTURE_MAX_TILES),
  absent: z.array(tileSchema).max(PICTURE_MAX_TILES),
});

/**
 * Whether a list of tiles (present ones and absent ones) holds each tile
 * once, inside a world `size` tiles a side, at most {@link PICTURE_MAX_TILES}
 * in all.
 */
function distinctTiles(lists: readonly (readonly [number, number])[][], size: number): boolean {
  if (lists.reduce((sum, list) => sum + list.length, 0) > PICTURE_MAX_TILES) return false;
  const seen = new Set<string>();
  for (const list of lists) {
    for (const [x, y] of list) {
      const key = `${x},${y}`;
      if (x >= size || y >= size || seen.has(key)) return false;
      seen.add(key);
    }
  }
  return true;
}

/**
 * Whether `request` is one the app can measure: an allowed template, a
 * start tile inside the world, and, when it names tiles a page showed,
 * each of those once and inside the world.
 */
export function isPictureRequest(request: unknown): request is PictureTilesRequest {
  if (!request || typeof request !== 'object') return false;
  const { urlTemplate, zoom, start, cachedOnly, page } = request as Record<string, unknown>;
  if (typeof urlTemplate !== 'string' || urlTemplate.length > MAX_ADDRESS_CHARS) return false;
  if (!isAllowedPictureTemplate(urlTemplate)) return false;
  if (!Number.isInteger(zoom) || (zoom as number) < 0 || (zoom as number) > PICTURE_MAX_ZOOM) {
    return false;
  }
  if (cachedOnly !== undefined && typeof cachedOnly !== 'boolean') return false;
  const size = 2 ** (zoom as number);
  if (page !== undefined) {
    const tiles = pageTilesSchema.safeParse(page);
    if (!tiles.success || !distinctTiles([tiles.data.present, tiles.data.absent], size)) {
      return false;
    }
  }
  return (
    Array.isArray(start) &&
    start.length === 2 &&
    start.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < size)
  );
}

/**
 * Checks what the app's measurement answered for `request`: the shape, the
 * zoom asked about, every tile inside the world and listed once, no tile
 * both present and absent, and the start tile among those that exist,
 * unless the answer has tiles known only from a page (`fromPage`, at most
 * as many as `present`). Anything else is `null`, as is `null` itself.
 */
export function checkPictureTiles(
  value: unknown,
  request: PictureTilesRequest,
): PictureTiles | null {
  const parsed = pictureTilesSchema.safeParse(value);
  if (!parsed.success || parsed.data.zoom !== request.zoom) return null;
  const size = 2 ** request.zoom;
  if (!distinctTiles([parsed.data.present, parsed.data.absent], size)) return null;
  const fromPage = parsed.data.fromPage ?? 0;
  if (fromPage > parsed.data.present.length) return null;
  const [startX, startY] = request.start;
  const hasStart = parsed.data.present.some(([x, y]) => x === startX && y === startY);
  if (!hasStart && fromPage === 0) return null;
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Measuring a map's picture from its page (optional)

/**
 * The most times the app runs an importer's {@link PageMeasure.step} for one
 * page. The desktop shell enforces the same.
 */
export const PAGE_MEASURE_MAX_STEPS = 20;
/** Steps run only this many seconds after the first one. The desktop shell enforces the same. */
export const PAGE_MEASURE_MAX_SECONDS = 90;
/**
 * Before each step, and once after the last, the app waits until the page's
 * own requests have settled: none open, and none started or answered for
 * {@link PAGE_SETTLED_MS}, but for at most {@link PAGE_SETTLE_MAX_MS}.
 */
export const PAGE_SETTLED_MS = 1500;
export const PAGE_SETTLE_MAX_MS = 10_000;
/** Answers of the page that are handed over at most, each address once. */
export const PAGE_MAX_ANSWERS = 4000;
/** Longer addresses are cut to this length. */
export const PAGE_MAX_ADDRESS_CHARS = 512;

/**
 * An importer's way of measuring a map's picture from the page itself, for
 * a site whose image server does not answer the app's own requests but
 * serves the page. Offered to the person as a tick box, off by default; the
 * app watches what the page loads while the importer's script zooms the
 * page out, and hands that to `convert` as
 * {@link ImportContext.pageObservations}.
 *
 * How it runs, in an app that downloads map images: the import window is
 * opened as large as the screen allows (a page's map only loads the tiles
 * in its view), with a watching script added before the page's own
 * scripts run. The page reader runs as usual. Once it has returned the
 * page data, the app runs `step` in the page, once per poll, after the
 * page's requests have settled (see {@link PAGE_SETTLED_MS}), until the
 * step says it is done, it has run {@link PAGE_MEASURE_MAX_STEPS} times,
 * or {@link PAGE_MEASURE_MAX_SECONDS} have passed; then it waits for the
 * requests to settle once more, reads what was watched and closes the
 * window.
 *
 * The watching script only watches: for each `GET` the page makes with
 * `fetch` or `XMLHttpRequest`, it notes the address without its query or
 * fragment, the status, whether the answer starts like an image, and for
 * a 403 the start of the body. It changes nothing in the request or the
 * answer, and the page cannot call the app through it.
 */
export interface PageMeasure {
  /**
   * Whether the importer measures the page at `url` this way (for example
   * map pages, not checklists); without it, every page `matches` accepts.
   * Must not throw.
   */
  matches?(url: string): boolean;
  /**
   * Source text of a function evaluated in the page as
   * `(<step>)({ step, presses })`: `step` counts the earlier runs from 0,
   * `presses` those that said they pressed. It must be synchronous and
   * return `{ done: boolean, pressed?: boolean, note?: string }`, or
   * anything else for "not done, nothing pressed"; an exception counts as
   * that too, and its message is logged.
   *
   * Unlike {@link AtlasImporter.pageReader}, it may press the page's own
   * zoom control (a button of the page's map that zooms out, or in), once
   * per run at most, and say so with `pressed: true`. It must not do
   * anything else: no panning, scrolling, typing or other clicks, no
   * navigation or form submission, no requests of its own, no reading or
   * writing of cookies or storage, and no change to the page. `note` (at
   * most 200 characters) goes to the activity log, so it must not hold
   * anything from the page beyond what the step did, such as the zoom.
   */
  step: string;
}

/**
 * What the page was answered for one address (see {@link PageAnswer}):
 * `image`, a 2xx answer that starts like a JPEG, PNG or WebP image (or, when
 * its bytes cannot be read, says it is an image); `missing`, 404 or 410;
 * `denied`, a 403 whose body is an object store's "access denied" error
 * document, which stores that do not list their contents send for objects
 * that do not exist (and for refusals); `error`, anything else, a network
 * failure among them.
 */
export type PageAnswerKind = 'image' | 'missing' | 'denied' | 'error';

/** One address the page asked for with `GET`, and what it was answered. */
export interface PageAnswer {
  /**
   * `scheme://host[:port]/path`, without query or fragment, at most
   * {@link PAGE_MAX_ADDRESS_CHARS} characters.
   */
  url: string;
  /** When the page asked more than once: `image` over `missing` over `denied` over `error`. */
  answer: PageAnswerKind;
  /** The HTTP status of that answer; 0 when there was none (a network failure). */
  status: number;
}

/** How measuring a page ended. */
export type PageMeasureEnd =
  /** The importer's step said it was done. */
  | 'done'
  /** After {@link PAGE_MEASURE_MAX_STEPS} steps. */
  | 'steps'
  /** After {@link PAGE_MEASURE_MAX_SECONDS}. */
  | 'time'
  /** The person closed the page window; what was watched until then is here. */
  | 'closed';

/** What the page loaded while it was measured (see {@link PageMeasure}). */
export interface PageObservations {
  /** The page's answers, each address once, at most {@link PAGE_MAX_ANSWERS}. */
  answers: PageAnswer[];
  /** The page asked for more addresses than are listed. */
  overflow: boolean;
  /** How often the importer's step ran, and how often it said it pressed. */
  steps: number;
  presses: number;
  ended: PageMeasureEnd;
}

const pageAnswerSchema = z.strictObject({
  url: z.string().min(1).max(PAGE_MAX_ADDRESS_CHARS),
  answer: z.enum(['image', 'missing', 'denied', 'error']),
  status: z.int().min(0).max(999),
});

const pageObservationsSchema = z.strictObject({
  answers: z.array(pageAnswerSchema).max(PAGE_MAX_ANSWERS),
  overflow: z.boolean(),
  steps: z.int().min(0).max(PAGE_MEASURE_MAX_STEPS),
  presses: z.int().min(0).max(PAGE_MEASURE_MAX_STEPS),
  ended: z.enum(['done', 'steps', 'time', 'closed']),
});

/**
 * Checks what the app's shell handed over from a measured page: the shape,
 * the bounds, at most as many presses as steps, and each address a web
 * address (`http` or `https`, no user name or password, no query or
 * fragment) listed once. Anything else is `null`.
 */
export function checkPageObservations(value: unknown): PageObservations | null {
  const parsed = pageObservationsSchema.safeParse(value);
  if (!parsed.success || parsed.data.presses > parsed.data.steps) return null;
  const seen = new Set<string>();
  for (const { url } of parsed.data.answers) {
    let address: URL;
    try {
      address = new URL(url);
    } catch {
      return null;
    }
    if (address.protocol !== 'https:' && address.protocol !== 'http:') return null;
    if (address.username || address.password || address.search || address.hash) return null;
    if (url.includes('?') || url.includes('#') || seen.has(url)) return null;
    seen.add(url);
  }
  return parsed.data;
}

/** The step of the importer's page measuring for the page at `url`, or null when there is none. */
export function pageMeasureStep(
  importer: Pick<AtlasImporter, 'pageMeasure'>,
  url: string,
): string | null {
  const measure = importer.pageMeasure;
  if (!measure) return null;
  if (measure.matches && !safely(() => measure.matches!(url.trim()), false)) return null;
  return measure.step;
}

/** A tile an address names: its zoom, column and row. */
export interface TileAddress {
  z: number;
  x: number;
  y: number;
}

/**
 * A reader of the addresses of one image set: for an address of a page
 * answer, the tile it names when it is `urlTemplate` filled in (compared
 * without the template's query or fragment, as page answers have none),
 * otherwise null. Null when the template has no `{z}`, `{x}` and `{y}`
 * where an address can hold them (in the path), or is not a web address.
 */
export function tileAddressReader(
  urlTemplate: string,
): ((url: string) => TileAddress | null) | null {
  const base = urlTemplate.split(/[?#]/)[0] ?? '';
  const marks = { z: 'atlasmarkz', x: 'atlasmarkx', y: 'atlasmarky' } as const;
  let normal: string;
  try {
    const url = new URL(
      base.replaceAll('{z}', marks.z).replaceAll('{x}', marks.x).replaceAll('{y}', marks.y),
    );
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    normal = url.origin + url.pathname;
  } catch {
    return null;
  }
  const order: ('z' | 'x' | 'y')[] = [];
  const parts = normal.split(/(atlasmark[zxy])/);
  let pattern = '^';
  for (const part of parts) {
    const mark = /^atlasmark([zxy])$/.exec(part);
    if (mark) {
      order.push(mark[1] as 'z' | 'x' | 'y');
      pattern += '(\\d{1,10})';
    } else {
      pattern += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  if (!(['z', 'x', 'y'] as const).every((part) => order.includes(part))) return null;
  const expression = new RegExp(`${pattern}$`);
  return (url) => {
    const found = expression.exec(url);
    if (!found) return null;
    const tile: Partial<Record<'z' | 'x' | 'y', number>> = {};
    for (const [i, part] of order.entries()) {
      const n = Number(found[i + 1]);
      // The same part twice must name the same number.
      if (tile[part] !== undefined && tile[part] !== n) return null;
      tile[part] = n;
    }
    const { z, x, y } = tile as TileAddress;
    if (z > PICTURE_MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) return null;
    return { z, x, y };
  };
}

/**
 * Checks the tiles an importer says a page showed ({@link PictureTilesRequest.page})
 * against what the page loaded: each present tile's address answered with an
 * image, or the address of a tile inside it at a finer zoom did (a page may
 * stop zooming out before it shows the coarsest tiles, and a tile with an
 * image below it exists); each absent one's with `missing`, or with `denied`
 * when the page loaded an image of the same image set (any zoom, so from the
 * same host).
 */
export function pageTilesFit(
  page: PageTiles,
  request: Pick<PictureTilesRequest, 'urlTemplate' | 'zoom'>,
  observations: PageObservations,
): boolean {
  const read = tileAddressReader(request.urlTemplate);
  if (!read) return false;
  const answers = new Map<string, PageAnswerKind>();
  // Tiles of the asked zoom that hold an image the page loaded at a finer zoom.
  const below = new Set<string>();
  let proven = false;
  for (const { url, answer } of observations.answers) {
    const tile = read(url);
    if (!tile) continue;
    if (answer === 'image') {
      proven = true;
      if (tile.z > request.zoom) {
        const span = 2 ** (tile.z - request.zoom);
        below.add(`${Math.floor(tile.x / span)},${Math.floor(tile.y / span)}`);
      }
    }
    if (tile.z === request.zoom) answers.set(`${tile.x},${tile.y}`, answer);
  }
  return (
    page.present.every(
      ([x, y]) => answers.get(`${x},${y}`) === 'image' || below.has(`${x},${y}`),
    ) &&
    page.absent.every(([x, y]) => {
      const answer = answers.get(`${x},${y}`);
      return answer === 'missing' || (answer === 'denied' && proven);
    })
  );
}

/** How the size of an imported map's picture was found, for the summary. */
export interface PictureSummary {
  /** The picture was measured with {@link ImportContext.pictureTiles}. */
  measured: boolean;
  /** When it was measured: how many tiles of the measured zoom exist. */
  tiles?: number;
  /**
   * A plain sentence for the person, for example why it could not be
   * measured and what the importer did instead.
   */
  note?: string;
  /**
   * When the page was measured ({@link ImportContext.pageObservations}):
   * what it showed. Set it only when the context has page observations.
   */
  page?: PageMeasureSummary;
}

/** What measuring a map's picture from its page found (see {@link PictureSummary.page}). */
export interface PageMeasureSummary {
  /** The zoom whose tiles were counted: the coarsest one the site serves. */
  zoom: number;
  /** Tiles of that zoom the page loaded as images. */
  images: number;
  /** Tiles of that zoom the page was told are not there. */
  missing: number;
  /** Tiles next to an image that the page did not load, or whose answer said nothing. */
  unseen: number;
  /** Every tile next to an image was seen, or lies outside the world. */
  complete: boolean;
  /** The map's size was taken from it; `note` says how, or why not. */
  used: boolean;
}

/** Figures shown to the person after an import. */
export interface ImportSummary {
  /** The game's name. */
  game: string;
  /** The name of what the page became: the imported map, or the checklist. */
  map: string;
  /** Maps in the pack after this import. */
  maps: number;
  /** Locations in the whole pack, and on the imported map. */
  locations: number;
  mapLocations: number;
  categories: number;
  /** The map (or checklist) was in the pack already and has been refreshed. */
  refreshed: boolean;
  /** For a page that became a checklist: its items, and rows left out (see {@link ImportSuccess.checklistId}). */
  checklist?: { items: number; leftOut: number };
  /**
   * For a map whose picture the importer measured, or tried to: how its
   * size was found. Set it only when the context has
   * {@link ImportContext.pictureTiles}: apps without it do not know this
   * field and refuse a summary that has it.
   */
  picture?: PictureSummary;
}

export interface ImportSuccess {
  ok: true;
  /** The pack's id; the same as `pack.manifest.gameId`. */
  packId: string;
  /** Key under which the app stores this page's data with the pack. Same page, same key. */
  sourceKey: string;
  /**
   * The map in `pack` that this page became. A page can instead become a
   * checklist of a game that is in the maps folder already (such as a
   * site's checklist or guide page, whose rows are locations of the
   * game): then `checklistId` names it, and `mapId` is left out.
   */
  mapId?: string;
  /** The checklist in `pack` that this page became, when it is not a map. */
  checklistId?: string;
  /**
   * The guide in `pack` that this page became, when it is a page of text
   * read as a guide (a wiki page, say): exactly one of `mapId`,
   * `checklistId` and `guideId` is given.
   */
  guideId?: string;
  /**
   * Optional, for a page that became a guide: the addresses of the other
   * pages of the same site that the page links to, so the app can offer
   * the ones not read yet ("Found on this page, not read"). Each is a page
   * the importer can read ({@link AtlasImporter.matches}), without its
   * fragment. The app keeps at most {@link MAX_PAGE_LINKS}, on the same
   * site as the page, each once; it leaves out the others, and never opens
   * one unless the person ticks it and starts a go. Apps that do not know
   * this field leave it out.
   */
  links?: string[];
  /**
   * Optional, like `links`: the other pages kept with the pack that this
   * call wrote again from their saved data (after the importer changed how
   * it writes pages, say), each with the pages of the same site it links
   * to, so the app knows the links of pages read before it kept them. Each
   * `url` is a page of the same site as the page read; its `links` are
   * kept as `links` are, on the site of that page. The app keeps at most
   * {@link MAX_WRITTEN_AGAIN} pages, each once, and leaves out the page
   * read (its links are `links`) and any entry that is not in this shape.
   * It records the links only; nothing is read because of them.
   */
  writtenAgain?: WrittenAgain[];
  /**
   * Optional, for a page read as the person browsed (`ImportContext.reading`
   * `browse`): the files of pictures the page showed, read from the page as
   * it loaded them (never fetched), for the app to write into the pack's
   * folder with the pack. Each `file` is the `file` of a picture of `pack`
   * (`pictures/<name>.png`, `.jpg`, `.jpeg` or `.webp`), and `data` its
   * bytes in base64, of the type its name says, at most {@link
   * MAX_PICTURE_FILE_BYTES}; at most {@link MAX_PICTURE_FILES} of them and
   * {@link MAX_PICTURE_FILES_BYTES} in all. The app leaves out any other
   * entry, and checks the bytes again before writing them. Such pictures
   * have no `remote`: the app's own picture download never runs for them.
   */
  pictureFiles?: PictureFile[];
  /** The whole pack after the import, including maps from earlier imports. */
  pack: PackData;
  summary: ImportSummary;
}

/** A picture file a page showed, with its bytes (see {@link ImportSuccess.pictureFiles}). */
export interface PictureFile {
  file: string;
  /** Its bytes, in base64. */
  data: string;
}

/** The bytes of one picture file of a page the app takes at most (see {@link ImportSuccess.pictureFiles}). */
export const MAX_PICTURE_FILE_BYTES = 4 * 1024 * 1024;
/** Picture files of one page the app takes at most. */
export const MAX_PICTURE_FILES = 100;
/** The bytes of all picture files of one page the app takes at most. */
export const MAX_PICTURE_FILES_BYTES = 24 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const PICTURE_FILE = /^pictures\/[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.(png|jpe?g|webp)$/;

/** How many bytes a base64 text holds. */
const base64Bytes = (data: string) =>
  Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);

/**
 * The picture files of a page as the app takes them (see {@link
 * ImportSuccess.pictureFiles}): each the file of a picture of `pack`, of a
 * type the app writes, in base64, within the limits, each file once, in
 * the order given; anything else is left out.
 */
export function pictureFilesOf(value: unknown, pack: PackData): PictureFile[] {
  if (!Array.isArray(value)) return [];
  const listed = new Set((pack.pictures ?? []).map((picture) => picture.file));
  const kept: PictureFile[] = [];
  let total = 0;
  for (const entry of value as unknown[]) {
    if (kept.length >= MAX_PICTURE_FILES) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const { file, data } = entry as { file?: unknown; data?: unknown };
    if (typeof file !== 'string' || typeof data !== 'string') continue;
    if (!PICTURE_FILE.test(file) || !listed.has(file) || kept.some((k) => k.file === file)) {
      continue;
    }
    if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) continue;
    const bytes = base64Bytes(data);
    if (bytes > MAX_PICTURE_FILE_BYTES || total + bytes > MAX_PICTURE_FILES_BYTES) continue;
    total += bytes;
    kept.push({ file, data });
  }
  return kept;
}

/** Links of one page that the app keeps at most (see {@link ImportSuccess.links}). */
export const MAX_PAGE_LINKS = 1000;

/** A page written again in the same call, with the pages it links to (see {@link ImportSuccess.writtenAgain}). */
export interface WrittenAgain {
  url: string;
  links: string[];
}

/**
 * Pages written again whose links the app keeps at most (see {@link
 * ImportSuccess.writtenAgain}): far above the pages of a large wiki (tens
 * of thousands), since a go of such pages has no page limit, and there
 * only so that an importer that goes wrong cannot hand over without end.
 */
export const MAX_WRITTEN_AGAIN = 100_000;

export interface ImportFailure {
  ok: false;
  /** A plain sentence for the person. */
  message: string;
  /**
   * The page asked to confirm the reader is a person, to sign in or to
   * slow down: the app stops the go at once and reads no more pages.
   */
  stop?: boolean;
  /**
   * The page states no licence the importer can read, and the importer
   * would read it under a licence the person confirms for its site: an app
   * that can ask does so (one of {@link CONFIRMABLE_LICENCES}), keeps the
   * answer for the site and hands the same page data to `convert` again
   * with {@link ImportContext.confirmedLicence}, fetching nothing again.
   * Without an answer nothing is kept. Other apps show the message.
   */
  askLicence?: boolean;
}

export type ImportOutcome = ImportSuccess | ImportFailure;

// ---------------------------------------------------------------------------
// Listing a game's pages, and a site's games (optional)

/** The `kind` of a listed page that is a map page. */
export const MAP_KIND = 'map';
/** Pages one game listing may hold at most. */
export const MAX_LISTED_PAGES = 500;
/** Games one catalogue may hold at most. */
export const MAX_CATALOGUE_GAMES = 2000;
/** Addresses longer than this are refused in listings. */
export const MAX_ADDRESS_CHARS = 2048;

/** One page of a game, as its game page lists it. */
export interface ListedPage {
  /** The page's full address, on the same site as the game page. */
  url: string;
  /**
   * What the page is: {@link MAP_KIND} for a map page, or another lowercase
   * word the importer chooses (for example the site's name for guide or
   * checklist pages). The app offers a page when the importer recognises
   * its address ({@link AtlasImporter.matches}); a map page must be one it
   * recognises. Other pages are listed as not supported yet, so an importer
   * that learns to read them later only has to accept their addresses.
   */
  kind: string;
  /** The page's name as the site shows it. */
  title: string;
  /** A heading the site lists the page under, if any. */
  group?: string;
}

/** What a game page lists: the game's name and its pages, in the site's order. */
export interface GameListing {
  game: string;
  pages: ListedPage[];
}

/** One game in a site's catalogue of games. */
export interface CatalogueGame {
  /** The pack id this importer gives the game's pack (its maps go into one pack). */
  id: string;
  name: string;
  /** The game's address ({@link GamePages.matches}), or, for a game with one map, that map page. */
  address: string;
  /** Other words the game is found by, such as short names. */
  search?: string;
}

export interface Catalogue {
  games: CatalogueGame[];
}

/** What the app tells a listing's `convert`. */
export interface ListingContext {
  /** The address of the page that was read. */
  url: string;
  app: { name: string; version: string };
}

/** A listing, or a plain reason why there is none. */
export type ListingOutcome<T> = ({ ok: true } & T) | ImportFailure;

/**
 * Reading a game's page: the list of its maps (and other pages). The app
 * opens a game address in the import window exactly as a map page, with
 * the same limits, evaluates {@link GamePages.pageReader} in it until it
 * returns something, and hands that to {@link GamePages.convert}.
 */
export interface GamePages {
  /** Whether `url` is the address of a game's page. Must not throw. */
  matches(url: string): boolean;
  /** Like {@link AtlasImporter.pageReader}, for a game page: returns what `convert` needs, or null while it is not there. */
  pageReader?: string;
  /** Like {@link AtlasImporter.fetch}, for a game page; then `pageReader` is not needed. */
  fetch?: PageFetch;
  /** How long to wait for it, in seconds; the importer's own wait when absent. */
  waitSeconds?: number;
  /** Turns what the reader returned into the game's listing. Must not throw for bad data. */
  convert(
    pageData: unknown,
    context: ListingContext,
  ): Promise<ListingOutcome<GameListing>> | ListingOutcome<GameListing>;
  /**
   * The game address of a map page this importer recognises, or null: used
   * to look for new maps of a game when it is updated. Must not throw.
   */
  gameAddress?(mapUrl: string): string | null;
}

/** Reading the site's list of games. */
export interface SiteCatalogue {
  /** The address of the site's list of games. */
  address: string;
  /** A short label for it, for example "All games on Example Maps". */
  label?: string;
  /** Whether `url` is the address of the list of games. Must not throw. */
  matches(url: string): boolean;
  pageReader: string;
  waitSeconds?: number;
  convert(
    pageData: unknown,
    context: ListingContext,
  ): Promise<ListingOutcome<Catalogue>> | ListingOutcome<Catalogue>;
}

/** What an importer module exports as its default export. */
export interface AtlasImporter {
  apiVersion: typeof IMPORTER_API_VERSION;
  /** Stable id, see {@link SLUG_PATTERN}. Stored with the packs it makes. */
  id: string;
  /** Short name shown in the app, for example "Example Maps". */
  title: string;
  /** One sentence on what the importer reads. */
  description: string;
  version: string;
  /** An example URL, shown as a hint in the app. */
  example?: string;
  /** Whether this importer can read the page at `url` (a full `https:` URL). Must not throw. */
  matches(url: string): boolean;
  /**
   * Optional: whether the importer recognises `url` (with `matches`, or as
   * a game address with `games.matches`) only as a general reader: it does
   * not know the site, and reads it only if its pages turn out to be of a
   * kind it reads, failing plainly otherwise. The app then gives the
   * address to an importer that knows it first ({@link findReader}), and
   * reads nothing until the person asks, as for any address. Must not throw.
   */
  general?(url: string): boolean;
  /**
   * Optional: what the importer says about the site of `url` before
   * anything is read: its key, the ways its pages can be read, and a
   * notice to show (see {@link SiteInfo}, checked with {@link siteInfoOf}).
   * Asked for page and game addresses alike; null for an address it does
   * not read. Must not throw.
   */
  siteInfo?(url: string): SiteInfo | null;
  /**
   * Optional: why the app must not read `url` at all, in a plain sentence,
   * or null. Asked before anything is opened or fetched, for every address
   * the person enters, also those no importer recognises. Must not throw.
   */
  refuses?(url: string): string | null;
  /**
   * Optional: the page is read by fetching the addresses this names,
   * instead of opening it in a window (see `fetching.ts`); `convert` gets
   * {@link FetchedPages}. Then `pageReader` is not needed, except for the
   * pages `fetch.inWindow` has opened in a window after all.
   */
  fetch?: PageFetch;
  /**
   * Source text of a function taking no arguments, evaluated in the page as
   * `(<pageReader>)()`. It must be synchronous and must not change the page.
   * It must not make requests, with one exception: when the data the page
   * was served with is no longer in the document, it may read the page's own
   * address once (same origin, no added headers, never repeated), starting
   * that request in one call and reading its answer in a later one. It
   * returns `null` or `undefined` while the data is not there yet (the app
   * asks again a few seconds later), and otherwise a JSON-serialisable value
   * with only the parts the importer needs. An exception counts as "not
   * there yet". Required unless the importer reads by {@link fetch}.
   */
  pageReader?: string;
  /**
   * Optional: the reader of "browse and keep" (the reading way `browse`,
   * see `fetching.ts`), a function's source like {@link pageReader}, run
   * in the app's window on each page the person opens there themselves,
   * once the page has finished loading. It returns `null` for a page not
   * to keep (not an article, or a page that asks to confirm the reader is a
   * person: the app never reads past such a check) and otherwise the page's
   * data for `convert`, which gets `ImportContext.reading` `browse`. It must
   * not change the page or make any request; it may read the pictures the
   * page already shows, as they loaded, within the page data's size limit
   * (see {@link ImportSuccess.pictureFiles}). Without it, `browse` is not
   * offered.
   */
  browseReader?: string;
  /**
   * Optional: measuring a map's picture from the page, when the person asks
   * for it (see {@link PageMeasure}). An app without it never runs it.
   */
  pageMeasure?: PageMeasure;
  /** How long to wait for the page data, in seconds. */
  waitSeconds?: number;
  /** Turns page data into a pack. Must not throw for bad data; return a failure instead. */
  convert(pageData: unknown, context: ImportContext): Promise<ImportOutcome> | ImportOutcome;
  /** Optional: reading a game's page for the list of its pages. */
  games?: GamePages;
  /** Optional: reading the site's list of games. Needs {@link games}. */
  catalogue?: SiteCatalogue;
  /**
   * Optional: `convert` may return a pack whose id is that of a pack that
   * comes with the app, to refresh it. It must keep that pack's ids, and
   * every map it came with, and give it a `packVersion` above the bundled
   * one; the app checks the last two. Without it such packs are refused.
   */
  refreshesBundledGames?: boolean;
  /**
   * Optional: the pictures its packs list to be fetched later (a picture's
   * `remote`) belong to the pages it reads, so an app that downloads
   * fetches them right after a page is added, without being asked again:
   * by its own downloader, one at a time, at its pace and under its rules.
   * Without it they wait until the person asks for them. An app that does
   * not download ignores it.
   */
  picturesWithPages?: boolean;
}

const isFunction = (value: unknown): value is (...args: never[]) => unknown =>
  typeof value === 'function';

const readerSchema = z.string().min(1).max(MAX_READER_CHARS);
const waitSchema = z.int().min(MIN_WAIT_SECONDS).max(MAX_WAIT_SECONDS).optional();

const fetchSchema = z.object({
  addresses: z.custom<PageFetch['addresses']>(isFunction, 'must be a function'),
  inWindow: z.custom<NonNullable<PageFetch['inWindow']>>(isFunction).optional(),
});

const readsSomehow = (part: { pageReader?: string; fetch?: unknown }) =>
  part.pageReader !== undefined || part.fetch !== undefined;
const readsSomehowError = { message: 'needs a pageReader or fetch', path: ['pageReader'] };

/** Pages a fetching part has opened in a window need its reader for them. */
const readsItsWindows = (part: { pageReader?: string; fetch?: { inWindow?: unknown } }) =>
  part.fetch?.inWindow === undefined || part.pageReader !== undefined;
const readsItsWindowsError = {
  message: 'needs a pageReader for the pages fetch.inWindow has opened in a window',
  path: ['pageReader'],
};

const gamePagesSchema = z
  .object({
    matches: z.custom<GamePages['matches']>(isFunction, 'must be a function'),
    pageReader: readerSchema.optional(),
    fetch: fetchSchema.optional(),
    waitSeconds: waitSchema,
    convert: z.custom<GamePages['convert']>(isFunction, 'must be a function'),
    gameAddress: z.custom<NonNullable<GamePages['gameAddress']>>(isFunction).optional(),
  })
  .refine(readsSomehow, readsSomehowError)
  .refine(readsItsWindows, readsItsWindowsError);

const catalogueSchema = z.object({
  address: z
    .string()
    .max(MAX_ADDRESS_CHARS)
    .refine((text) => isAllowedPageUrl(text), 'must be a web address'),
  label: z.string().trim().min(1).max(100).optional(),
  matches: z.custom<SiteCatalogue['matches']>(isFunction, 'must be a function'),
  pageReader: readerSchema,
  waitSeconds: waitSchema,
  convert: z.custom<SiteCatalogue['convert']>(isFunction, 'must be a function'),
});

/** Checks the shape of a loaded importer module's default export. */
export const importerSchema = z
  .object({
    apiVersion: z.literal(IMPORTER_API_VERSION),
    id: z.string().regex(SLUG_PATTERN),
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(500),
    version: z.string().trim().min(1).max(50),
    example: z.string().max(500).optional(),
    matches: z.custom<AtlasImporter['matches']>(isFunction, 'must be a function'),
    refuses: z.custom<NonNullable<AtlasImporter['refuses']>>(isFunction).optional(),
    general: z.custom<NonNullable<AtlasImporter['general']>>(isFunction).optional(),
    siteInfo: z.custom<NonNullable<AtlasImporter['siteInfo']>>(isFunction).optional(),
    fetch: fetchSchema.optional(),
    pageReader: z.string().min(1).max(MAX_READER_CHARS).optional(),
    browseReader: readerSchema.optional(),
    pageMeasure: z
      .object({
        matches: z.custom<NonNullable<PageMeasure['matches']>>(isFunction).optional(),
        step: readerSchema,
      })
      .optional(),
    waitSeconds: z.int().min(MIN_WAIT_SECONDS).max(MAX_WAIT_SECONDS).optional(),
    convert: z.custom<AtlasImporter['convert']>(isFunction, 'must be a function'),
    games: gamePagesSchema.optional(),
    catalogue: catalogueSchema.optional(),
    refreshesBundledGames: z.boolean().optional(),
    picturesWithPages: z.boolean().optional(),
  })
  .refine((importer) => !importer.catalogue || importer.games, {
    message: 'an importer with a catalogue must also read game pages',
    path: ['catalogue'],
  })
  .refine(readsSomehow, readsSomehowError)
  .refine(readsItsWindows, readsItsWindowsError);

/** Validates a module's default export as an importer, or throws a readable error. */
export function asImporter(value: unknown, label = 'importer'): AtlasImporter {
  const result = importerSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label} is not an Atlas importer:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Whether the app may open `text` as a page to import from: `https`, or `http` on this computer (tests). */
export function isAllowedPageUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return url.hostname.length > 0;
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}

/** Whether an importer recognises `url` only as a general reader (see {@link AtlasImporter.general}). */
export function readsAsGeneral(importer: Pick<AtlasImporter, 'general'>, url: string): boolean {
  return importer.general !== undefined && safely(() => importer.general!(url.trim()), false);
}

/**
 * The first installed importer that recognises `url`, or null: one that
 * knows its site first, then one that would read it as a general reader.
 */
export function findImporter<T extends Pick<AtlasImporter, 'matches' | 'general'>>(
  importers: readonly T[],
  url: string,
): T | null {
  if (!isAllowedPageUrl(url)) return null;
  const recognising = importers.filter((importer) =>
    safely(() => importer.matches(url.trim()), false),
  );
  return recognising.find((importer) => !readsAsGeneral(importer, url)) ?? recognising[0] ?? null;
}

/** What an address is to the importer that reads it (see {@link findReader}). */
export type ReaderKind = 'page' | 'game' | 'catalogue';

/**
 * The importer that reads `url`, and as what: a page, a game's page or
 * the site's list of games. Importers that know the address come first, in
 * that order of kinds; an importer that would read it only as a general
 * reader comes after all of them, so a general reader never takes an
 * address another importer knows. Null when none recognises it.
 */
export function findReader<
  T extends Pick<AtlasImporter, 'matches' | 'general' | 'games' | 'catalogue'>,
>(importers: readonly T[], url: string): { importer: T; kind: ReaderKind } | null {
  if (!isAllowedPageUrl(url)) return null;
  const address = url.trim();
  const kinds: [ReaderKind, (importer: T) => boolean][] = [
    ['page', (importer) => safely(() => importer.matches(address), false)],
    [
      'game',
      (importer) =>
        importer.games !== undefined && safely(() => importer.games!.matches(address), false),
    ],
    [
      'catalogue',
      (importer) =>
        importer.catalogue !== undefined &&
        safely(() => importer.catalogue!.matches(address), false),
    ],
  ];
  for (const general of [false, true]) {
    for (const [kind, recognises] of kinds) {
      const importer = importers.find(
        (candidate) => readsAsGeneral(candidate, address) === general && recognises(candidate),
      );
      if (importer) return { importer, kind };
    }
  }
  return null;
}

const summarySchema = z.strictObject({
  game: z.string().trim().min(1).max(200),
  map: z.string().trim().min(1).max(200),
  maps: z.int().nonnegative(),
  locations: z.int().nonnegative(),
  mapLocations: z.int().nonnegative(),
  categories: z.int().nonnegative(),
  refreshed: z.boolean(),
  checklist: z
    .strictObject({ items: z.int().nonnegative(), leftOut: z.int().nonnegative() })
    .optional(),
  picture: z
    .strictObject({
      measured: z.boolean(),
      tiles: z.int().nonnegative().optional(),
      note: z.string().trim().min(1).max(500).optional(),
      page: z
        .strictObject({
          zoom: z.int().min(0).max(PICTURE_MAX_ZOOM),
          images: z.int().nonnegative(),
          missing: z.int().nonnegative(),
          unseen: z.int().nonnegative(),
          complete: z.boolean(),
          used: z.boolean(),
        })
        .optional(),
    })
    .optional(),
});

const outcomeSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    packId: z.string().regex(GAME_ID_PATTERN).max(64),
    sourceKey: z.string().regex(SLUG_PATTERN),
    mapId: idOf('map').optional(),
    checklistId: idOf('checklist').optional(),
    guideId: idOf('guide').optional(),
    links: z
      .array(z.string().max(MAX_ADDRESS_CHARS))
      .max(MAX_PAGE_LINKS * 4)
      .optional(),
    // Checked entry by entry, and entries that are not in shape are left out.
    writtenAgain: z.unknown().optional(),
    // Checked against the pack, entry by entry (`pictureFilesOf`).
    pictureFiles: z.unknown().optional(),
    pack: z.unknown(),
    summary: summarySchema,
  }),
  z.object({
    ok: z.literal(false),
    message: z.string().trim().min(1).max(2000),
    stop: z.boolean().optional(),
    askLicence: z.boolean().optional(),
  }),
]);

/**
 * The links of a page as the app keeps them (see {@link ImportSuccess.links}):
 * web addresses on the same site as `pageUrl`, without their fragment, each
 * page once and not the page itself, at most {@link MAX_PAGE_LINKS}. Without
 * `pageUrl`, none.
 */
export function pageLinks(links: readonly string[] | undefined, pageUrl?: string): string[] {
  if (!links || !pageUrl) return [];
  const seen = new Set([pageKey(pageUrl)]);
  const kept: string[] = [];
  for (const link of links) {
    if (kept.length >= MAX_PAGE_LINKS) break;
    if (!isAllowedPageUrl(link) || !sameSite(pageUrl, link)) continue;
    const url = new URL(link.trim());
    url.hash = '';
    const key = pageKey(url.href);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(url.href);
  }
  return kept;
}

/**
 * The pages written again as the app keeps them (see
 * {@link ImportSuccess.writtenAgain}): each a web address on the same site
 * as `pageUrl` and not that page, without its fragment, each page once,
 * with its links as {@link pageLinks} gives them for it; at most
 * {@link MAX_WRITTEN_AGAIN}. An entry that is not in shape is left out.
 * Without `pageUrl`, none.
 */
export function writtenAgainLinks(value: unknown, pageUrl?: string): WrittenAgain[] {
  if (!Array.isArray(value) || !pageUrl) return [];
  const seen = new Set([pageKey(pageUrl)]);
  const kept: WrittenAgain[] = [];
  for (const entry of value as unknown[]) {
    if (kept.length >= MAX_WRITTEN_AGAIN) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const { url: given, links } = entry as { url?: unknown; links?: unknown };
    if (typeof given !== 'string' || !Array.isArray(links)) continue;
    if (!isAllowedPageUrl(given) || !sameSite(pageUrl, given)) continue;
    const url = new URL(given.trim());
    url.hash = '';
    const key = pageKey(url.href);
    if (seen.has(key)) continue;
    seen.add(key);
    const texts = (links as unknown[])
      .filter((link): link is string => typeof link === 'string')
      .slice(0, MAX_PAGE_LINKS * 4);
    kept.push({ url: url.href, links: pageLinks(texts, url.href) });
  }
  return kept;
}

/**
 * Checks what an importer's `convert` returned: the outcome's shape, and for
 * a success the pack against the pack schema and its integrity rules. Returns
 * a failure with a readable message when anything is wrong. The pack is about
 * to be written, so it is checked strictly: an unknown key is an error here,
 * although the app skips one when it reads a pack. A success's `links` are
 * kept as {@link pageLinks} gives them for `pageUrl`, the page read (none
 * without it), and left out when there are none; so are the pages it wrote
 * again ({@link writtenAgainLinks}).
 */
export function checkOutcome(value: unknown, pageUrl?: string): ImportOutcome {
  const outcome = outcomeSchema.safeParse(value);
  if (!outcome.success) {
    return {
      ok: false,
      message: `The importer returned something unexpected:\n${z.prettifyError(outcome.error)}`,
    };
  }
  const success = outcome.data;
  if (!success.ok) return success;
  const pack = packDataSchema.safeParse(success.pack);
  if (!pack.success) {
    return {
      ok: false,
      message: `The map data was not in the expected shape:\n${z.prettifyError(pack.error)}`,
    };
  }
  const problems = checkPackIntegrity(pack.data);
  if (problems.length > 0) {
    return {
      ok: false,
      message: `The map data does not fit together:\n${problems
        .slice(0, 10)
        .map((p) => `  - ${p.path}: ${p.message}`)
        .join('\n')}`,
    };
  }
  if (pack.data.manifest.gameId !== success.packId) {
    return { ok: false, message: 'The importer named a pack id that differs from its manifest.' };
  }
  const named = [success.mapId, success.checklistId, success.guideId].filter(
    (id) => id !== undefined,
  );
  if (named.length !== 1) {
    return {
      ok: false,
      message: 'The importer must name one map, checklist or guide the page became.',
    };
  }
  if (success.mapId !== undefined && !pack.data.maps.some((map) => map.id === success.mapId)) {
    return { ok: false, message: 'The importer named a map that is not in its pack.' };
  }
  if (
    success.checklistId !== undefined &&
    !pack.data.checklists.some((checklist) => checklist.id === success.checklistId)
  ) {
    return { ok: false, message: 'The importer named a checklist that is not in its pack.' };
  }
  if (success.guideId !== undefined && !pack.data.guides.some((g) => g.id === success.guideId)) {
    return { ok: false, message: 'The importer named a guide that is not in its pack.' };
  }
  const { links: given, writtenAgain: again, pictureFiles: files, ...rest } = success;
  const links = pageLinks(given, pageUrl);
  const writtenAgain = writtenAgainLinks(again, pageUrl);
  const pictureFiles = pictureFilesOf(files, pack.data);
  return {
    ...rest,
    ...(links.length > 0 ? { links } : {}),
    ...(writtenAgain.length > 0 ? { writtenAgain } : {}),
    ...(pictureFiles.length > 0 ? { pictureFiles } : {}),
    pack: pack.data,
  };
}

// ---------------------------------------------------------------------------
// Listings

/** Calls an importer's function that must not throw; a throw counts as `fallback`. */
function safely<T>(call: () => T, fallback: T): T {
  try {
    return call();
  } catch {
    return fallback;
  }
}

/** The site of an address: its host without a leading `www.`, lowercase. */
function siteOf(url: URL): string {
  const host = url.hostname.toLowerCase();
  return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * Whether `next` is on the same site as `start`, by the import window's
 * rule: the same kind of connection, and the same host or one of its
 * sub-domains, ignoring a leading `www.`.
 */
export function sameSite(start: string, next: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(start);
    b = new URL(next);
  } catch {
    return false;
  }
  if (a.protocol !== b.protocol || (a.protocol === 'http:' && a.port !== b.port)) return false;
  const site = siteOf(a);
  const host = b.hostname.toLowerCase();
  return site.length > 0 && (host === site || host.endsWith(`.${site}`));
}

/** Whether the importer can add the page at `url` (it recognises the address). */
export function canAddPage(importer: Pick<AtlasImporter, 'matches'>, url: string): boolean {
  return isAllowedPageUrl(url) && safely(() => importer.matches(url.trim()), false);
}

/**
 * The first importer that recognises `url` as a game address, or null: one
 * that knows its site first, then one that would read it as a general reader.
 */
export function findGameImporter<T extends Pick<AtlasImporter, 'games' | 'general'>>(
  importers: readonly T[],
  url: string,
): T | null {
  if (!isAllowedPageUrl(url)) return null;
  const recognising = importers.filter(
    (i) => i.games && safely(() => i.games!.matches(url.trim()), false),
  );
  return recognising.find((i) => !readsAsGeneral(i, url)) ?? recognising[0] ?? null;
}

/** The first importer that recognises `url` as the address of its list of games, or null. */
export function findCatalogueImporter<T extends Pick<AtlasImporter, 'catalogue'>>(
  importers: readonly T[],
  url: string,
): T | null {
  if (!isAllowedPageUrl(url)) return null;
  return (
    importers.find((i) => i.catalogue && safely(() => i.catalogue!.matches(url.trim()), false)) ??
    null
  );
}

/**
 * The game address an importer gives for one of its map pages, when it
 * gives one that is a web address on the same site that it recognises as a
 * game address; otherwise null.
 */
export function gameAddressOf(
  importer: Pick<AtlasImporter, 'games'>,
  mapUrl: string,
): string | null {
  const games = importer.games;
  if (!games?.gameAddress) return null;
  const address: unknown = safely(() => games.gameAddress!(mapUrl), null);
  if (typeof address !== 'string' || address.length > MAX_ADDRESS_CHARS) return null;
  if (!isAllowedPageUrl(address) || !sameSite(mapUrl, address)) return null;
  return safely(() => games.matches(address), false) ? address : null;
}

const failureSchema = z.object({
  ok: z.literal(false),
  message: z.string().trim().min(1).max(2000),
});

const listedPageSchema = z.strictObject({
  url: z.string().min(1).max(MAX_ADDRESS_CHARS),
  kind: z.string().regex(SLUG_PATTERN),
  title: z.string().trim().min(1).max(200),
  group: z.string().trim().min(1).max(200).optional(),
});

const gameListingSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    game: z.string().trim().min(1).max(200),
    pages: z.array(listedPageSchema).max(MAX_LISTED_PAGES),
  }),
  failureSchema,
]);

const catalogueGameSchema = z.strictObject({
  id: z.string().regex(GAME_ID_PATTERN).max(64),
  name: z.string().trim().min(1).max(200),
  address: z.string().min(1).max(MAX_ADDRESS_CHARS),
  search: z.string().max(500).optional(),
});

const catalogueOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    games: z.array(catalogueGameSchema).max(MAX_CATALOGUE_GAMES),
  }),
  failureSchema,
]);

/** The key two addresses of one page share: the address without its query, fragment and a trailing slash. */
export function pageKey(text: string): string {
  try {
    const url = new URL(text.trim());
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${siteOf(url)}${url.port ? `:${url.port}` : ''}${path}`;
  } catch {
    return text.trim();
  }
}

const unexpected = (what: string, detail: string): ImportFailure => ({
  ok: false,
  message: `The importer returned ${what} that this app cannot use: ${detail}`,
});

/**
 * Checks what a game listing's `convert` returned for the game page at
 * `gameUrl`: its shape, at most {@link MAX_LISTED_PAGES} pages, each a web
 * address on the same site, listed once, and every map page one the
 * importer recognises. Titles are trimmed. Anything wrong refuses the
 * whole listing with a readable message.
 */
export function checkGameListing(
  value: unknown,
  gameUrl: string,
  importer: Pick<AtlasImporter, 'matches'>,
): ListingOutcome<GameListing> {
  const parsed = gameListingSchema.safeParse(value);
  if (!parsed.success) {
    return unexpected('a list of pages', z.prettifyError(parsed.error));
  }
  if (!parsed.data.ok) return parsed.data;
  const seen = new Set<string>();
  const pages: ListedPage[] = [];
  for (const page of parsed.data.pages) {
    if (!isAllowedPageUrl(page.url) || !sameSite(gameUrl, page.url)) {
      return unexpected(
        'a list of pages',
        `${page.url} is not a page on the site of the game page.`,
      );
    }
    const key = pageKey(page.url);
    if (seen.has(key)) {
      return unexpected('a list of pages', `${page.url} is listed twice.`);
    }
    seen.add(key);
    if (page.kind === MAP_KIND && !canAddPage(importer, page.url)) {
      return unexpected(
        'a list of pages',
        `${page.url} is listed as a map, but the importer does not read it.`,
      );
    }
    pages.push({
      url: page.url.trim(),
      kind: page.kind,
      title: page.title.trim(),
      ...(page.group ? { group: page.group.trim() } : {}),
    });
  }
  return { ok: true, game: parsed.data.game.trim(), pages };
}

/**
 * Checks what a catalogue's `convert` returned for the page at
 * `catalogueUrl`: at most {@link MAX_CATALOGUE_GAMES} games, each id once,
 * and each address a web address on the same site that the importer
 * recognises as a game address or as a map page.
 */
export function checkCatalogue(
  value: unknown,
  catalogueUrl: string,
  importer: Pick<AtlasImporter, 'matches' | 'games'>,
): ListingOutcome<Catalogue> {
  const parsed = catalogueOutcomeSchema.safeParse(value);
  if (!parsed.success) {
    return unexpected('a list of games', z.prettifyError(parsed.error));
  }
  if (!parsed.data.ok) return parsed.data;
  const ids = new Set<string>();
  const games: CatalogueGame[] = [];
  for (const game of parsed.data.games) {
    if (ids.has(game.id)) return unexpected('a list of games', `${game.id} is listed twice.`);
    ids.add(game.id);
    const address = game.address.trim();
    const usable =
      isAllowedPageUrl(address) &&
      sameSite(catalogueUrl, address) &&
      ((importer.games !== undefined && safely(() => importer.games!.matches(address), false)) ||
        canAddPage(importer, address));
    if (!usable) {
      return unexpected(
        'a list of games',
        `${address} is not a game or map address this importer reads.`,
      );
    }
    games.push({
      id: game.id,
      name: game.name.trim(),
      address,
      ...(game.search?.trim() ? { search: game.search.trim() } : {}),
    });
  }
  return { ok: true, games };
}

// ---------------------------------------------------------------------------
// Reading by fetching, and addresses an importer refuses

/**
 * Why the app must not read `url`, from the first importer that refuses
 * it, or null. A throw counts as no refusal.
 */
export function refusalFor(
  importers: readonly Pick<AtlasImporter, 'refuses'>[],
  url: string,
): string | null {
  for (const importer of importers) {
    const reason: unknown = importer.refuses
      ? safely(() => importer.refuses!(url.trim()), null)
      : null;
    if (typeof reason === 'string' && reason.trim()) return reason.trim().slice(0, 500);
  }
  return null;
}

/**
 * The addresses to fetch for the page at `url`, checked: at most
 * {@link MAX_PAGE_FETCHES}, each once, each a web address on the same
 * site. A plain reason instead when there are none or one is not allowed.
 */
export function fetchAddresses(
  fetcher: PageFetch,
  url: string,
): { ok: true; addresses: string[] } | ImportFailure {
  const named: unknown = safely(() => fetcher.addresses(url.trim()), null);
  if (!Array.isArray(named) || named.length === 0) {
    return { ok: false, message: 'The importer cannot read this page.' };
  }
  if (named.length > MAX_PAGE_FETCHES) {
    return unexpected('addresses', `more than ${MAX_PAGE_FETCHES} for one page.`);
  }
  const addresses: string[] = [];
  for (const address of named) {
    if (
      typeof address !== 'string' ||
      address.length > MAX_ADDRESS_CHARS ||
      !isAllowedPageUrl(address) ||
      !sameSite(url, address)
    ) {
      return unexpected('addresses', `${String(address)} is not on the site of the page.`);
    }
    if (!addresses.includes(address)) addresses.push(address);
  }
  return { ok: true, addresses };
}
