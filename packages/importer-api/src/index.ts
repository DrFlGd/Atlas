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
 *    way to call the app. A reader that holds back on a page that has
 *    loaded may say why by throwing an `Error` whose message is one plain
 *    sentence: the app keeps waiting just as for `null`, and shows the
 *    first 200 characters of that sentence, as plain text, as the reason
 *    the page window waits.
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
  MAX_SITE_NAME_LENGTH,
  SCENE_AXES,
  checkPackIntegrity,
  idOf,
  isAllowedRemoteUrl,
  isAxesPermutation,
  packDataSchema,
  type PackData,
  type Scene,
  type WorldTransform,
} from '@atlas/schema';
import { z } from 'zod';
import { MAX_PAGE_FETCHES, type PageFetch, type ReadingWay } from './fetching';
import type { PageLayoutRequest } from './layoutNotes';
import {
  MODEL_PIECE_FIELD,
  RULES_READER,
  checkShippedSiteRules,
  isSiteFile,
  readByRules,
  readingWidenings,
  type SiteRules,
  type SiteRulesProblem,
} from './siteRules';
import {
  siteTrialOf,
  type SiteRulesWidening,
  type SiteTrial,
  type SiteTrialRequest,
} from './siteTrial';
import type { SiteInfo, SiteLicence } from './sites';
import { GAME_FILES_KIND_PATTERN, type GameFilesImport } from './gameFiles';

export * from './fetching';
export * from './gameFiles';
export * from './gameLists';
export * from './layoutNotes';
export * from './pageValues';
export * from './sitePatterns';
export * from './siteRules';
export * from './siteTrial';
export * from './sites';
export * from './styles';

/**
 * Writing the layout forms of a page's Markdown (blocks side by side, a
 * card, a row, columns, a centred block), as the app reads them: see
 * `layoutForms.ts` in `@atlas/schema` and "Layout forms" in the README.
 */
export {
  cardMarkdown,
  centredMarkdown,
  columnsMarkdown,
  escapeLayoutMarkers,
  isLayoutMarkerLine,
  layoutOpenLine,
  LAYOUT_END_LINE,
  LAYOUT_NEXT_LINE,
  MAX_COLUMNS,
  MAX_DEPTH,
  MAX_FORMS,
  MAX_SHARE,
  MAX_SIDE_BLOCKS,
  rowMarkdown,
  sharesOf,
  sideBySideMarkdown,
  type LayoutFormName,
} from '@atlas/schema';

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
   * Optional: the person asked to build the game again from the page data
   * kept with it ("Build again from saved pages"), and this call is that:
   * the importer may write every kept page again from its data, and bring
   * back a kept page the pack lacks. Nothing is fetched for it. Absent for
   * an ordinary read.
   */
  rebuild?: boolean;
  /**
   * Optional: tells the app how far a long step is, for the person to see:
   * `done` of `total` kept pages written again while a game is built again
   * (`rebuild`). Call it as often as wanted; the app shows it at its own
   * pace, and may not show it at all.
   */
  progress?(step: { done: number; total: number }): void;
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
   * Optional: what the person answered for the site of the page (see
   * {@link ImportFailure.askLicence}), kept by the app per site: a known
   * licence they confirmed (no `basis`, or `confirmed`), what they filled
   * in (`permission`) or no licence (`none`). An importer uses it only for
   * a page that states no licence it can read, never in place of a licence
   * the page states, and says in what it writes where the licence came
   * from: `licenseConfirmed` for a confirmed one, and the guide source's
   * `licenseBasis` with the words as `license.name` (and the address of the
   * terms as `license.url`, who gave it, when and the note) for the others.
   * An importer that cannot use an answer fails as without one.
   */
  confirmedLicence?: SiteLicence;
  /**
   * Optional: true when the app keeps the manifest's `idSections`, the
   * section of its page another name of a page leads to. An app that does
   * not say so checks a pack strictly and refuses one that has it, as any
   * field it does not know, so an importer writes it only when this is
   * true.
   */
  keepsIdSections?: boolean;
  /**
   * Optional: true when the app keeps the manifest's `homePage`, the guide
   * that is the site's own home page (a wiki's main page). An app that does
   * not say so refuses a pack that has it, as any field it does not know,
   * so an importer writes it only when this is true.
   */
  keepsHomePage?: boolean;
  /**
   * Optional: true when the app keeps the manifest's `pageWidth`, the width
   * the pages of the site are shown at, as the site's rules file gives it
   * (`layout.pageWidth`). An app that does not say so refuses a pack that
   * has it, as any field it does not know, so an importer writes it only
   * when this is true.
   */
  keepsPageWidth?: boolean;
  /**
   * Optional: true when the app keeps the manifest's `siteWidth`, the width
   * of the site's own pages in CSS pixels (measured on the pages laid out
   * with the site's style sheets, see `layoutNotes.ts`, or as the site's
   * rules file gives it, `layout.siteWidth`), and shows the pages at it as
   * the page width `site` (see `pageWidth.ts` in `@atlas/schema`). An app
   * that does not say so refuses a pack that has it, as any field it does
   * not know, and knows no `pageWidth` of `site` either, so an importer
   * writes neither unless this is true.
   */
  keepsSiteWidth?: boolean;
  /**
   * Optional: true when the app keeps the manifest's `mapLinks`, which web
   * links of the pages name a location of a map by the id its site gives
   * it, as the site's rules file gives them (a part's `mapLinks`). An app
   * that does not say so refuses a pack that has it, as any field it does
   * not know, so an importer writes it only when this is true.
   */
  keepsMapLinks?: boolean;
  /**
   * Optional: true when the app keeps a guide's `filedUnder`, the guides
   * the site itself files the page under (a wiki's categories, the title
   * of a navigation box). An app that does not say so refuses a pack that
   * has it, as any field it does not know, so an importer writes it only
   * when this is true.
   */
  keepsFiledUnder?: boolean;
  /**
   * Optional: true when the app keeps a section's `unheaded`, which shows
   * what the section holds in its place, so the top of the contents holds
   * pages and sections in one order. An app that does not say so refuses
   * a pack that has it, as any field it does not know, so an importer
   * writes it only when this is true (and else keeps such pages in a
   * section with a heading, as before).
   */
  keepsUnheadedSections?: boolean;
  /**
   * Optional: true when the app keeps the manifest's `pagesInOrder`, which
   * says the pages are one guide read in order (Previous and Next). An app
   * that does not say so refuses a pack that has it, as any field it does
   * not know, so an importer writes it only when this is true.
   */
  keepsPagesInOrder?: boolean;
  /**
   * Optional: true when the app keeps a type's `picture`, the type's own
   * icon as the map it was read from draws it (read only where the site's
   * rules file says where the icons are, `types.picture`), and a picture's
   * `cut`, the part of a sheet of icons it is. An app that does not say so
   * refuses a pack that has them, as any field it does not know, so an
   * importer writes them only when this is true. Such pictures are kept for
   * the person's own use, as photos are: listed with their address
   * (`remote`) and downloaded by the app, never by the importer.
   */
  keepsTypePictures?: boolean;
  /**
   * Optional: the size the person chose to keep the pictures of the site's
   * pages at, in an app that downloads them (see
   * {@link AtlasImporter.picturesWithPages}). `full`: where the importer
   * can tell the address of a picture's full file from the address its page
   * shows it at, it lists the full file as the picture's `remote`, the
   * address shown as its `shownAt` and a smaller copy for pages as its
   * `pageCopy`, and names the picture after the full file, so the same
   * picture shown at two sizes is one picture. `shown`: each picture as its
   * page shows it, as before. The app downloads the full file in place of
   * the copy shown (never both), and the copy shown only when the full file
   * is refused, not there or cannot be kept. An app that does not say
   * leaves it out: it does not keep `shownAt` or `pageCopy`, so an importer
   * writes them only when this is there, and lists pictures as `shown`.
   */
  pictureSize?: PictureSize;
  /**
   * Optional: lays a page out as a browser shows it, for a page that has
   * no notes of its layout of its own (one the app fetched by itself, or
   * one saved without them), and gives back its HTML with the notes of the
   * measuring step (`LAYOUT_NOTES_SCRIPT`, see `layoutNotes.ts`). Only an
   * app that downloads offers it, only for a game whose site's style
   * sheets it keeps (see `styles.ts`), and only when the person left it on.
   *
   * The app parses the HTML without running or loading anything, removes
   * every `data-atlas-*` attribute it has (any notes in a page handed over
   * are the site's, not the app's), and lays a copy out in a closed frame
   * of its own, `LAYOUT_FRAME_WIDTH` pixels wide: no script runs and
   * nothing is fetched, with the sheets kept for the game that the page
   * links to (all of them for a page that links to none), its own
   * `<style>` blocks and its elements' own `style`, every address in them
   * made empty. It measures the copy from outside with the measuring step,
   * from the first element one of `article` finds, else from the `body`,
   * which carries the mark, and writes the notes on the page's own
   * elements. The answer is the page's HTML as parsed and written out again
   * (the same elements and attributes, scripts kept as text), with the
   * notes; null when it was not laid out: the game keeps no sheets the page
   * uses, the HTML is too long (`MAX_LAYOUT_PAGE_CHARS`), the page took
   * longer than `LAYOUT_PAGE_MS`, or anything went wrong. One page at
   * a time; it never rejects, and makes no request.
   *
   * The notes come back in memory and are the app's: an importer reads a
   * page by them as it reads one its readers measured in the window. The
   * HTML of a page the app fetched may carry `data-atlas-*` attributes of
   * the site's own, which are no notes: an importer that is not handed
   * notes this way reads such a page without them. An app that does not
   * offer it, or a page it does not lay out, is read as before.
   */
  layOut?(page: PageLayoutRequest): Promise<string | null>;
  /**
   * Optional: fetches one whole picture of a map and cuts it into map
   * images with levels further out, as "New game" cuts a picture the person
   * picks, for an importer whose site keeps each map as one picture (see
   * {@link WholePictureRequest}). Only an app that downloads offers it, in
   * its desktop builds; an importer must check that it is there.
   *
   * The app asks for the picture as it asks for every page it reads by
   * itself in a go: never an address the site's rules file keeps it off,
   * the site's live `robots.txt` first, its own pause before the request,
   * its own name (`Atlas/<version>`), no cookies, and redirects on the same
   * site only. A refusal (see {@link refusalOf}), or an address `robots.txt`
   * does not allow that no permission covers, ends the answer with
   * `stop`: the importer then stops too, with a failure that has `stop`,
   * and the app reads no more of the go. One picture at a time; it never
   * rejects. Nothing is written into a pack until the importer names the
   * cut in {@link ImportSuccess.cutPictures} and the pack is saved; a cut
   * no saved pack names is thrown away.
   */
  wholePicture?(request: WholePictureRequest): Promise<WholePicture>;
  /**
   * Optional: fetches the raw 3D model of one map and builds it with
   * Atlas's one 3D builder into the map's model files and its pictures
   * drawn from above (see {@link SceneModelRequest}), for an importer
   * whose site keeps each map as a 3D model. Only an app that downloads
   * offers it, in its desktop builds; an importer must check that it is
   * there.
   *
   * The app asks for the model, or each of its pieces in order, as it asks
   * for every page it reads by itself in a go: never an address the site's
   * rules file keeps it off, the site's live `robots.txt` first, its own
   * pause before each request, its own name (`Atlas/<version>`), no
   * cookies, and redirects on the same site only. A refusal ends the
   * answer with `stop`: the importer then stops too, with a failure that
   * has `stop`, and the app reads no more of the go. Pieces are joined
   * back into one model, which the builder lines up with the world, cuts
   * into cells with levels of detail, compresses and draws from above,
   * one picture per floor asked. One model at a time; it never rejects.
   * Nothing is written into a pack until the importer names the build in
   * {@link ImportSuccess.sceneBuilds} and the pack is saved; a build no
   * saved pack names is thrown away.
   *
   * The original model is kept with the saved game, beside its saved
   * pages (never in a pack file), in place of the one kept before for the
   * same `folder`. In a game built again ({@link ImportContext.rebuild})
   * the app fetches nothing: it builds the map from the model the game
   * keeps for `folder`, as the rest of the request says now (its addresses
   * unused), and answers `missing` for a map whose model is not kept.
   */
  sceneModel?(request: SceneModelRequest): Promise<SceneModel>;
}

/** The sizes the pictures of a site's pages can be kept at (see {@link ImportContext.pictureSize}). */
export type PictureSize = 'full' | 'shown';

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
// A map that is one whole picture (optional)

/**
 * The longest side of a picture the app cuts into a map (the cutter of "New
 * game"): a long thin picture is taken up to this, within
 * {@link WHOLE_PICTURE_MAX_PIXELS}. The desktop shell enforces the same.
 */
export const WHOLE_PICTURE_MAX_SIDE = 65_535;
/** The most pixels a picture the app cuts into a map may have: 16,384 × 16,384. */
export const WHOLE_PICTURE_MAX_PIXELS = 16_384 * 16_384;
/** The shortest side of a picture the app cuts into a map. */
export const WHOLE_PICTURE_MIN_SIDE = 16;
/** The edge of the map images a whole picture is cut into. */
export const WHOLE_PICTURE_TILE_SIZE = 256;

/** What an importer asks {@link ImportContext.wholePicture}. */
export interface WholePictureRequest {
  /**
   * The picture's address: `https` (plain `http` only on this computer,
   * for tests), with no user name or password, on the site of the page
   * being read or on a host its rules file names for pictures.
   */
  url: string;
}

/**
 * Why a whole picture was not cut:
 *
 * - `stop`: the site refused, asked to slow down, or its `robots.txt` does
 *   not allow the address; `message` says which, and the go ends.
 * - `kept-off`: the site's rules file keeps the app off the address.
 * - `missing`: the site has no picture there (404, 410, another answer
 *   that is not a picture, or none at all).
 * - `format`: the file is not a PNG, JPEG or WebP picture.
 * - `size`: the picture is larger than {@link WHOLE_PICTURE_MAX_SIDE} or
 *   {@link WHOLE_PICTURE_MAX_PIXELS}, or smaller than
 *   {@link WHOLE_PICTURE_MIN_SIDE}; `width` and `height` say how large.
 * - `failed`: anything else, such as a damaged picture or a full disk.
 * - `cancelled`: the session was stopped meanwhile.
 */
export type WholePictureProblem =
  'stop' | 'kept-off' | 'missing' | 'format' | 'size' | 'failed' | 'cancelled';

/** What {@link ImportContext.wholePicture} gave. */
export type WholePicture =
  | {
      ok: true;
      /** The app's name for the cut, to name in {@link ImportSuccess.cutPictures}. */
      picture: string;
      width: number;
      height: number;
      /** The level at which one map image pixel is one pixel of the picture; levels go from 0. */
      maxZoom: number;
      /** {@link WHOLE_PICTURE_TILE_SIZE}. */
      tileSize: number;
      /** The map images' files: `jpg`, or `png` for a picture with transparency. */
      extension: 'jpg' | 'png';
    }
  | {
      ok: false;
      problem: WholePictureProblem;
      /** One plain sentence for the person, about the picture. */
      message: string;
      width?: number;
      height?: number;
    };

/** A cut a pack's layer uses (see {@link ImportSuccess.cutPictures}). */
export interface CutPictureUse {
  /** The app's name for the cut ({@link WholePicture}). */
  picture: string;
  /**
   * The folder of the pack's `tiles/` it goes in: the layer whose
   * `tiles.url` is `tiles/<folder>/{z}/{x}/{y}.<extension>` shows it.
   * Letters, digits, `_`, `.` and `-`, starting with a letter or digit.
   */
  folder: string;
}

/** The form of a cut's folder ({@link CutPictureUse.folder}). */
export const CUT_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
/** The form of the app's name for a cut ({@link CutPictureUse.picture}). */
export const CUT_PICTURE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Cuts one import names at most. */
export const MAX_CUT_PICTURES = 500;

/**
 * The cuts of an import as the app takes them (see
 * {@link ImportSuccess.cutPictures}): each named once, each folder once and
 * the folder of a layer of `pack` whose tiles are `tiles/<folder>/{z}/{x}/{y}`
 * with a `jpg` or `png` extension, at most {@link MAX_CUT_PICTURES}, in the
 * order given; anything else is left out.
 */
export function cutPicturesOf(value: unknown, pack: PackData): CutPictureUse[] {
  if (!Array.isArray(value)) return [];
  const folders = new Set(
    pack.layers.flatMap((layer) => {
      if (layer.tiles.type !== 'xyz') return [];
      const found = /^tiles\/([^/]+)\/\{z\}\/\{x\}\/\{y\}\.(?:jpg|png)$/.exec(layer.tiles.url);
      return found ? [found[1]!] : [];
    }),
  );
  const kept: CutPictureUse[] = [];
  for (const entry of value as unknown[]) {
    if (kept.length >= MAX_CUT_PICTURES) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const { picture, folder } = entry as { picture?: unknown; folder?: unknown };
    if (typeof picture !== 'string' || typeof folder !== 'string') continue;
    if (!CUT_PICTURE_PATTERN.test(picture) || !CUT_FOLDER_PATTERN.test(folder)) continue;
    if (!folders.has(folder)) continue;
    if (kept.some((k) => k.picture === picture || k.folder === folder)) continue;
    kept.push({ picture, folder });
  }
  return kept;
}

// ---------------------------------------------------------------------------
// A map that is a 3D model (optional)

/** The most pieces one model may come in ({@link SceneModelRequest.pieces}). The desktop shell enforces the same. */
export const SCENE_MODEL_MAX_PIECES = 200;
/** The largest model the app takes, as a glTF binary file once joined. The desktop shell enforces the same. */
export const SCENE_MODEL_MAX_BYTES = 1024 * 1024 * 1024;
/** The form of a map's folder of a built model ({@link SceneModelRequest.folder}). */
export const SCENE_FOLDER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The form of the app's name for a build ({@link SceneBuildUse.build}). */
export const SCENE_BUILD_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Builds one import names at most. */
export const MAX_SCENE_BUILDS = 200;
/** Floors one build draws at most. */
export const MAX_SCENE_FLOORS = 64;

/** A floor of a map whose model the app draws from above ({@link SceneModelRequest.floors}). */
export interface SceneFloorRequest {
  /** Its folder among the map's pictures: 1 to 64 of `a`–`z`, `0`–`9`, `_` and `-`. */
  id: string;
  /** `[min, max]`, the heights of the world it shows, in world units. */
  heights: [number, number];
}

/**
 * What an importer asks {@link ImportContext.sceneModel}: the raw model of
 * one map, where to get it, how it lines up with the game's world, and the
 * floors to draw. The app builds it with Atlas's one 3D builder (see
 * "Building a 3D map" in `docs/pack-file-format.md`), so it comes out as
 * every 3D map does.
 */
export interface SceneModelRequest {
  /**
   * The model: a glTF binary file (`.glb`) with everything in it. Each
   * address `https` (plain `http` only on this computer, for tests), with
   * no user name or password, on the site of the page being read.
   */
  url?: string;
  /**
   * Or the model itself, a glTF binary file the importer made on this
   * computer from the game's own files: only for a game files build
   * ({@link GameFilesContext.sceneModel}), never for a page read. At most
   * {@link SCENE_MODEL_MAX_BYTES}.
   */
  model?: Uint8Array;
  /**
   * `keep`: the builder keeps the model's textures (each at its own size
   * and fidelity in the finest level of detail, smaller copies in the
   * coarser ones). Absent or `average`: each texture's average colour, as
   * before.
   */
  textures?: 'average' | 'keep';
  /**
   * With `keep`: the longest side of a picture in the finest level, a
   * power of two from 16 to 8192. Absent: each picture keeps its own size.
   */
  textureSize?: number;
  /**
   * Or the model in pieces: each address a JSON file whose value at `field`
   * (a field name of its top object) is text in base64, the pieces' texts
   * joined in this order being the base64 of the model. At most
   * {@link SCENE_MODEL_MAX_PIECES}. Exactly one of `url`, `pieces` and `model`.
   */
  pieces?: { urls: string[]; field: string };
  /**
   * The map's folder in the pack: its model files go in `scene/<folder>/`
   * and its pictures in `tiles/<folder>/` (see {@link SCENE_FOLDER_PATTERN}).
   */
  folder: string;
  /** As the builder's options (and a scene's fields): which axis gives world x, world y and height. */
  axes?: [string, string, string];
  /** World units per model unit. */
  scale?: number;
  /** `[x, y, height]` in world units, added after scaling. */
  offset?: [number, number, number];
  /** Name patterns of parts never seen in game (`*`, `?`, any case), left out. */
  drop?: string[];
  /** The height of open water, in world units. */
  water?: number;
  /** The sky's colour, `#rrggbb`. */
  sky?: string;
  /**
   * The floors to draw from above, one picture each, lowest first; none
   * (or fewer than two) draws the whole map once, as the floor `all`. At
   * most {@link MAX_SCENE_FLOORS}.
   */
  floors?: SceneFloorRequest[];
}

/** One picture of a built map, drawn from above ({@link SceneModel}). */
export interface SceneLayer {
  /** The floor's id as asked, or `all`. */
  id: string;
  /** `tiles/<folder>/<id>/{z}/{x}/{y}.png`, a layer's `tiles.url`. */
  url: string;
  minZoom: number;
  maxZoom: number;
  tileSize: number;
}

/**
 * Why a model was not built:
 *
 * - `stop`: the site refused, asked to slow down, or its `robots.txt` does
 *   not allow the address; `message` says which, and the go ends.
 * - `kept-off`: the site's rules file keeps the app off the address.
 * - `missing`: the site has no model there (404, 410, an answer that is
 *   not one, a piece without its field).
 * - `format`: the file is not a glTF binary file the builder reads.
 * - `size`: it is larger than {@link SCENE_MODEL_MAX_BYTES}.
 * - `failed`: anything else, such as a model with nothing left to show or
 *   a full disk.
 * - `cancelled`: the session was stopped meanwhile.
 */
export type SceneModelProblem =
  'stop' | 'kept-off' | 'missing' | 'format' | 'size' | 'failed' | 'cancelled';

/** What {@link ImportContext.sceneModel} gave. */
export type SceneModel =
  | {
      ok: true;
      /** The app's name for the build, to name in {@link ImportSuccess.sceneBuilds}. */
      build: string;
      /** The scene to put on the map (`maps.json`), its files under `scene/<folder>/`. */
      scene: Scene;
      /** The size of the map's pictures, in pixels. */
      width: number;
      height: number;
      /** Map pixel to world x and y, the map's `worldTransform`. */
      worldTransform: WorldTransform;
      /** The pictures drawn, one for each floor asked (or `all`), in that order. */
      layers: SceneLayer[];
      /** Triangles of the finest level, all cells together. */
      triangles: number;
      /** What the builder said of the model, in plain sentences (textures left out, say). */
      warnings: string[];
    }
  | {
      ok: false;
      problem: SceneModelProblem;
      /** One plain sentence for the person, about the model. */
      message: string;
    };

/** A build a pack's map uses (see {@link ImportSuccess.sceneBuilds}). */
export interface SceneBuildUse {
  /** The app's name for the build ({@link SceneModel}). */
  build: string;
  /** The map's folder it was built for: `scene/<folder>/` and `tiles/<folder>/`. */
  folder: string;
}

/**
 * The builds of an import as the app takes them (see
 * {@link ImportSuccess.sceneBuilds}): each named once, each folder once and
 * the folder of a map of `pack` whose scene's files are all under
 * `scene/<folder>/`, at most {@link MAX_SCENE_BUILDS}, in the order given;
 * anything else is left out.
 */
export function sceneBuildsOf(value: unknown, pack: PackData): SceneBuildUse[] {
  if (!Array.isArray(value)) return [];
  const folders = new Set(
    pack.maps.flatMap((map) => {
      if (!map.scene) return [];
      const files = [
        ...map.scene.cells.flatMap((cell) => cell.lods.map((lod) => lod.file)),
        ...(map.scene.neighbours ? [map.scene.neighbours] : []),
      ];
      const folder = /^scene\/([^/]+)\//.exec(files[0] ?? '')?.[1];
      return folder && files.every((file) => file.startsWith(`scene/${folder}/`)) ? [folder] : [];
    }),
  );
  const kept: SceneBuildUse[] = [];
  for (const entry of value as unknown[]) {
    if (kept.length >= MAX_SCENE_BUILDS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const { build, folder } = entry as { build?: unknown; folder?: unknown };
    if (typeof build !== 'string' || typeof folder !== 'string') continue;
    if (!SCENE_BUILD_PATTERN.test(build) || !SCENE_FOLDER_PATTERN.test(folder)) continue;
    if (!folders.has(folder)) continue;
    if (kept.some((k) => k.build === build || k.folder === folder)) continue;
    kept.push({ build, folder });
  }
  return kept;
}

/**
 * Checks what an importer asks {@link ImportContext.sceneModel}, as the
 * app takes it: the request in bounds, or a plain sentence why not.
 * Addresses are checked for their form only; the app checks each against
 * the site's rules file and `robots.txt` when it asks for it.
 */
export function checkSceneModelRequest(value: unknown): SceneModelRequest | string {
  if (typeof value !== 'object' || value === null) return 'The request is not one.';
  const request = value as Record<string, unknown>;
  const { url, pieces, model, folder, axes, scale, offset, drop, water, sky, floors } = request;
  const { textures, textureSize } = request;
  if (typeof folder !== 'string' || !SCENE_FOLDER_PATTERN.test(folder)) {
    return 'The map’s folder is not one this app takes.';
  }
  const out: SceneModelRequest = { folder };
  if ([url, pieces, model].filter((given) => given !== undefined).length !== 1) {
    return 'The model must be one file, its pieces, or the model itself.';
  }
  if (textures !== undefined) {
    if (textures !== 'average' && textures !== 'keep') {
      return 'The textures must be kept or averaged.';
    }
    out.textures = textures;
  }
  if (textureSize !== undefined) {
    if (
      typeof textureSize !== 'number' ||
      !Number.isInteger(textureSize) ||
      textureSize < 16 ||
      textureSize > 8192 ||
      (textureSize & (textureSize - 1)) !== 0
    ) {
      return 'The texture size must be a power of two from 16 to 8192.';
    }
    out.textureSize = textureSize;
  }
  if (model !== undefined) {
    if (!(model instanceof Uint8Array) || model.byteLength < 20) {
      return 'The model is not a glTF binary file.';
    }
    if (model.byteLength > SCENE_MODEL_MAX_BYTES) return 'The model is larger than this app takes.';
    if (String.fromCharCode(model[0]!, model[1]!, model[2]!, model[3]!) !== 'glTF') {
      return 'The model is not a glTF binary file.';
    }
    out.model = model;
  } else if (url !== undefined) {
    if (typeof url !== 'string' || !isAllowedPageUrl(url))
      return 'This app does not read that address.';
    out.url = url;
  } else {
    const given = pieces as { urls?: unknown; field?: unknown } | null;
    const urls = given?.urls;
    const field = given?.field;
    if (
      !Array.isArray(urls) ||
      urls.length === 0 ||
      urls.length > SCENE_MODEL_MAX_PIECES ||
      !urls.every((u) => typeof u === 'string' && isAllowedPageUrl(u))
    ) {
      return 'The model’s pieces are not addresses this app reads.';
    }
    if (typeof field !== 'string' || !MODEL_PIECE_FIELD.test(field)) {
      return 'The field of the model’s pieces is not a field name.';
    }
    out.pieces = { urls: urls as string[], field };
  }
  if (axes !== undefined) {
    if (
      !Array.isArray(axes) ||
      axes.length !== 3 ||
      !axes.every((a) => typeof a === 'string' && (SCENE_AXES as readonly string[]).includes(a)) ||
      !isAxesPermutation(axes as string[])
    ) {
      return 'The axes must name each of x, y and z once.';
    }
    out.axes = axes as [string, string, string];
  }
  if (scale !== undefined) {
    if (typeof scale !== 'number' || !(scale > 0) || !Number.isFinite(scale)) {
      return 'The scale must be a number above 0.';
    }
    out.scale = scale;
  }
  if (offset !== undefined) {
    if (
      !Array.isArray(offset) ||
      offset.length !== 3 ||
      !offset.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      return 'The offset must be three numbers.';
    }
    out.offset = offset as [number, number, number];
  }
  if (drop !== undefined) {
    if (
      !Array.isArray(drop) ||
      drop.length > 100 ||
      !drop.every((d) => typeof d === 'string' && d.length > 0 && d.length <= 200)
    ) {
      return 'The parts to leave out must be up to 100 name patterns.';
    }
    out.drop = drop as string[];
  }
  if (water !== undefined) {
    if (typeof water !== 'number' || !Number.isFinite(water))
      return 'The water’s height must be a number.';
    out.water = water;
  }
  if (sky !== undefined) {
    if (typeof sky !== 'string' || !/^#[0-9a-f]{6}$/i.test(sky))
      return 'The sky must be a colour written #rrggbb.';
    out.sky = sky.toLowerCase();
  }
  if (floors !== undefined) {
    if (!Array.isArray(floors) || floors.length > MAX_SCENE_FLOORS)
      return 'There are too many floors.';
    const ids = new Set<string>();
    const kept: SceneFloorRequest[] = [];
    for (const floor of floors as unknown[]) {
      const { id, heights } = (floor ?? {}) as { id?: unknown; heights?: unknown };
      if (
        typeof id !== 'string' ||
        !SCENE_FOLDER_PATTERN.test(id) ||
        ids.has(id) ||
        !Array.isArray(heights) ||
        heights.length !== 2 ||
        !heights.every((h) => typeof h === 'number' && Number.isFinite(h)) ||
        !((heights[0] as number) <= (heights[1] as number))
      ) {
        return 'Each floor needs an id of its own and its heights, lowest first.';
      }
      ids.add(id);
      kept.push({ id, heights: [heights[0] as number, heights[1] as number] });
    }
    out.floors = kept;
  }
  return out;
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
  /**
   * What the importer left out of what the page lists, one plain sentence
   * each (a picture too large to cut, say), at most
   * {@link MAX_LEFT_OUT_SENTENCES}; the app shows them with the figures.
   * Set it only when the context has {@link ImportContext.wholePicture}:
   * apps without it do not know this field and refuse a summary that has it.
   */
  leftOut?: string[];
}

/** Sentences of {@link ImportSummary.leftOut} the app takes at most. */
export const MAX_LEFT_OUT_SENTENCES = 200;

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
   * Optional, for a page that became a guide: the page's own address, when
   * the page was read from another address of the same site than the one
   * asked (the site forwarded the address, or names the page otherwise).
   * The address asked is then another name of this page: the app counts
   * it as read, shows the page once under this address, and never reads
   * the other name again. Left out when it is not on the same site as the
   * address asked, or is the same page.
   */
  pageAddress?: string;
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
  /**
   * Optional, for maps made from whole pictures
   * ({@link ImportContext.wholePicture}): the cuts the pack's layers use,
   * each put into the pack's folder as `tiles/<folder>/` when the pack is
   * saved, in place of what was there. A map read before keeps its images:
   * it names no cut. The app leaves out an entry that names no layer of
   * `pack` (see {@link cutPicturesOf}).
   */
  cutPictures?: CutPictureUse[];
  /**
   * Optional, for maps made from 3D models ({@link ImportContext.sceneModel}):
   * the builds the pack's maps use, each put into the pack's folder as
   * `scene/<folder>/` and `tiles/<folder>/` when the pack is saved, in place
   * of what was there. The app leaves out an entry that names no map of
   * `pack` with a scene in that folder (see {@link sceneBuildsOf}).
   */
  sceneBuilds?: SceneBuildUse[];
  /**
   * Optional: the name of the site the page was read from, as the importer
   * shows it to the person (for a site described by a site rules file, the
   * file's `name`). The app records it as the pack manifest's
   * `source.site`, so a pack names its site without the app guessing from
   * the importer or the addresses. Kept as {@link siteNameOf} gives it, and
   * left out when that gives none: the name recorded before is then kept.
   * Apps that do not know this field leave it out, and an importer that
   * leaves it out works as before.
   */
  site?: string;
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
  /** The address its data was kept under: the one asked when it was read. */
  url: string;
  links: string[];
  /** Its own address, when it differs from `url` (see {@link ImportSuccess.pageAddress}). */
  pageAddress?: string;
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
   * would read it under what the person answers for its site: an app that
   * can ask does so (a licence of {@link CONFIRMABLE_LICENCES}, words they
   * fill in, or no licence), keeps the answer for the site and hands the
   * same page data to `convert` again with
   * {@link ImportContext.confirmedLicence}, fetching nothing again. Without
   * an answer nothing is kept. Other apps show the message.
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
   * {@link HOME_PAGE_KIND} is the site's own home page.
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
  /**
   * How many maps the game has, when the list says so before its page is
   * read: shown beside the game, and added up, when the person ticks games
   * to add one after another.
   */
  maps?: number;
  /**
   * About how many bytes its maps take on this computer once added, when
   * the list says so before anything is fetched (the sizes of its whole
   * pictures, say): added up to the disk space needed.
   */
  bytes?: number;
  /** The system the game is for, such as a console, when the list says so. */
  system?: string;
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
  /**
   * Optional, like {@link AtlasImporter.pageReaderFor}, for a game page:
   * the importer's reader of its own for one game address (a game page of
   * a site its rules file describes, say), or null for `pageReader`. Must
   * not throw. See {@link gamePageReaderOf}.
   */
  pageReaderFor?(url: string): string | null;
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
  /** The site's name, as the app says "12 games on <site>"; the importer's title when absent. */
  site?: string;
  /**
   * The system every game of the list is for, such as a console, when the
   * list is of one system: the app files each game it adds from the list
   * under it (the System tag of the Library). A game's own `system` wins.
   */
  system?: string;
  /**
   * Whether the app reads the list only at an address the person gives
   * that {@link matches} recognises, and offers no button for it: for lists
   * of one form at many addresses (a page for each system of a site, say),
   * which `address` alone does not name. `address` is then only the list's
   * key, never opened.
   */
  pastedOnly?: boolean;
  /** Whether `url` is the address of the list of games. Must not throw. */
  matches(url: string): boolean;
  /** Like {@link AtlasImporter.pageReader}, for the list of games; not needed with `fetch`. */
  pageReader?: string;
  /** Like {@link AtlasImporter.fetch}, for the list of games; then `pageReader` is not needed. */
  fetch?: PageFetch;
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
   * Optional: the reader for the page at `url` (a full `https:` URL), when
   * it is not {@link pageReader}: the source of a function of no arguments,
   * as for `pageReader` and under the same rules, made by the importer for
   * that address alone (a map whose site rules file names the values of its
   * page to read, see `pageValues.ts`). Null or undefined for an address
   * read by `pageReader`. A page read by a reader of its own is read for its
   * data only: the app runs no {@link styleReader} on it. The app asks for
   * it each time it opens a page in its window for this importer, and uses
   * `pageReader` when it throws or answers anything but text of at most
   * {@link MAX_READER_CHARS} characters. Must not throw.
   */
  pageReaderFor?(url: string): string | null | undefined;
  /**
   * Optional: the reader of "browse and keep" (the reading way `browse`,
   * see `fetching.ts`), a function's source like {@link pageReader}, run
   * in the app's window on each page the person opens there themselves,
   * once the page has finished loading, or has been loading for a while
   * (a page may never finish what it loads besides its own document, so
   * the reader says whether what it reads is there). It returns `null` for a page not
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
   * Optional: the style sheets of the site's pages are kept with the game
   * (see `styles.ts`), and this is how the page hands them over: the source
   * of a function taking one argument, evaluated in the page as
   * `(<styleReader>)(<marks>)`, where `<marks>` is the list of marks
   * (`PageStyleSheet.mark` in `styles.ts`) of the sheets the app has kept for the
   * game already. The app runs it once on a page read in its window (the
   * ways `window` and `browse`), right after the page's data has been read,
   * on the same page, and only for an importer that reads pages as guides.
   * It returns `PageStyles` (`styles.ts`): each sheet the page uses (its
   * `document.styleSheets`, a `<style>` block of the page too), with the
   * text of a sheet whose mark is not among `<marks>`, and only the address
   * of a sheet from another address, whose rules the page cannot hand over.
   * Like a reader, it must be synchronous, change nothing in the page
   * (no storage, no document) and make no request; an exception counts as
   * no answer. With it, an app that fetches the importer's pages (`fetch`)
   * also keeps the sheets those pages name. Without it, nothing is kept.
   */
  styleReader?: string;
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
   * Optional: more lists of games, for an importer that reads several
   * sites (a general importer, one list for each site its rules files
   * describe with one). Called each time the app lists them, after the
   * importer's site files are applied, so it may change with them. Each is
   * read as {@link catalogue} is, and each must have its own address; a
   * list the app cannot use is left out. Needs {@link games}. Read them
   * with {@link cataloguesOf}.
   */
  catalogues?(): readonly SiteCatalogue[];
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
  /**
   * Optional: making 3D maps from a game's own files on the person's
   * computer (see `gameFiles.ts`). An importer with it may read no pages
   * at all ({@link pageReader} and {@link fetch} are then not needed, and
   * {@link matches} answers `false`). Only a desktop app that downloads
   * offers it.
   */
  gameFiles?: GameFilesImport;
  /**
   * Optional: the importer reads sites by site rules files (see
   * `siteRules.ts` and the guide beside the schema in this package): the
   * files it comes with, and those the person adds and switches on. An app
   * that does not know it never calls it, and the importer reads by the
   * files it comes with, as if each were switched on.
   */
  sites?: ImporterSites;
}

/** A site rules file an importer comes with (see {@link ImporterSites.files}). */
export interface BuiltInSiteRules {
  /** Its file name, `<site id>.atlas-site.json` or `<reader>.reader.atlas-site.json`. */
  name: string;
  /** Its contents, as JSON; the app checks it as it checks the person's ({@link checkSiteRules}). */
  rules: unknown;
}

/** A site rules file the app hands to an importer to read by (see {@link ImporterSites.apply}). */
export interface AppliedSiteRules {
  /** The file's name. */
  name: string;
  /** The person added it; otherwise it came with the importer. */
  own: boolean;
  /** The file, checked with {@link checkSiteRules}. */
  rules: SiteRules;
}

/**
 * How an importer reads sites by site rules files. The format is public
 * and the same for every importer (`siteRules.ts`); which readers there are
 * and what a reader does with a page are the importer's.
 *
 * The app keeps the person's files in its Sites folder, and which files are
 * switched on. It checks every file's form itself, asks the importer what
 * it cannot read of each ({@link check}), and hands it the files switched
 * on ({@link apply}): those it comes with, and the person's, where a
 * person's file with the key of one it comes with (see `siteRulesKey`)
 * takes that file's place. Nothing in a file is ever run: a reader only
 * reads what it says.
 */
export interface ImporterSites {
  /** The files that come with the importer, each switched on until the person switches it off. */
  files: readonly BuiltInSiteRules[];
  /**
   * The names of its built-in readers (see `RULES_READER` for the general
   * one, which an importer lists once it reads by it). A file of the
   * person's goes to the importers that have a reader it names; a part
   * whose reader no importer has is not read, and the app says so.
   */
  readers: readonly string[];
  /**
   * The problems the importer finds in a file whose form is right, in the
   * parts whose reader it has: a part it cannot read yet, an option its
   * reader does not take, a host it never reads. A part whose reader it
   * does not have is left to the app, which says so when no importer has
   * it. Each names its field, as `checkSiteRules` does. None means the
   * importer can read every part it has a reader for. Pure: it changes
   * nothing. Must not throw.
   */
  check(rules: SiteRules): SiteRulesProblem[];
  /**
   * The files switched on, in the order they count (the person's first,
   * then those the importer comes with): from now on the importer reads by
   * them, and by no other, until the next call. Answers the problems of
   * each, in the same order, as {@link check} does, with those only the
   * files together show (such as a host two files name, where the first
   * counts). A part with a problem is not read by. The app calls it once
   * the importer is loaded, before asking it anything else, and again
   * whenever the person changes the files or switches one. Must not throw.
   */
  apply(files: readonly AppliedSiteRules[]): SiteRulesProblem[][];
  /**
   * Optional: what the guide to writing a file says of this importer's
   * readers, in Markdown: their names, what each reads and its signs. The
   * app adds it to the end of the guide it saves for the person.
   */
  guide?: string;
  /**
   * Optional: what a file of the person's widens against the files the
   * importer comes with, for the person to see before they switch it on:
   * each way of reading it adds for a host, and each refusal it overrides
   * (with that refusal's notice). None for a file that keeps or narrows
   * them. Pure: it changes nothing. Must not throw.
   */
  widens?(rules: SiteRules): SiteRulesWidening[];
  /**
   * Optional: tries a file on one page the person saved ("Try on a saved
   * page"), or its map part on a data file the person saved
   * (`SiteTrialRequest.data`), and says what the reader understood (see
   * `siteTrial.ts`): a part read by `rules`, or a page of a site the file
   * has one of the importer's own readers read, read as the importer reads
   * a page kept from its window or as the person browses, by the file as
   * it is given. It may lay the page out first (`SiteTrialRequest.layOut`).
   * Nothing is kept and nothing is fetched. Must not throw.
   */
  tryPage?(request: SiteTrialRequest): SiteTrial | Promise<SiteTrial>;
  /**
   * Optional: why the importer cannot try a file on a saved page
   * ({@link tryPage}), in full sentences that say what the person can do;
   * null when it can try it. Pure. An importer that does not say is taken
   * to try only a file with a part read by `rules`, and only when it lists
   * that reader. Must not throw.
   */
  cannotTry?(rules: SiteRules): string | null;
}

/** Built-in site rules files one importer may come with. */
export const MAX_BUILT_IN_SITE_RULES = 500;

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
    pageReaderFor: z.custom<NonNullable<GamePages['pageReaderFor']>>(isFunction).optional(),
  })
  .refine(readsSomehow, readsSomehowError)
  .refine(readsItsWindows, readsItsWindowsError);

const catalogueSchema = z
  .object({
    address: z
      .string()
      .max(MAX_ADDRESS_CHARS)
      .refine((text) => isAllowedPageUrl(text), 'must be a web address'),
    label: z.string().trim().min(1).max(100).optional(),
    site: z.string().trim().min(1).max(100).optional(),
    system: z.string().trim().min(1).max(80).optional(),
    pastedOnly: z.boolean().optional(),
    matches: z.custom<SiteCatalogue['matches']>(isFunction, 'must be a function'),
    pageReader: readerSchema.optional(),
    fetch: fetchSchema.optional(),
    waitSeconds: waitSchema,
    convert: z.custom<SiteCatalogue['convert']>(isFunction, 'must be a function'),
  })
  .refine(readsSomehow, readsSomehowError)
  .refine(readsItsWindows, readsItsWindowsError);

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
    pageReaderFor: z.custom<NonNullable<AtlasImporter['pageReaderFor']>>(isFunction).optional(),
    browseReader: readerSchema.optional(),
    styleReader: readerSchema.optional(),
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
    catalogues: z.custom<NonNullable<AtlasImporter['catalogues']>>(isFunction).optional(),
    refreshesBundledGames: z.boolean().optional(),
    picturesWithPages: z.boolean().optional(),
    gameFiles: z
      .object({
        kinds: z
          .array(
            z.object({
              id: z.string().regex(GAME_FILES_KIND_PATTERN),
              title: z.string().trim().min(1).max(100),
              description: z.string().trim().min(1).max(500),
            }),
          )
          .min(1)
          .max(20),
        survey: z.custom<GameFilesImport['survey']>(isFunction, 'must be a function'),
        build: z.custom<GameFilesImport['build']>(isFunction, 'must be a function'),
      })
      .optional(),
    sites: z
      .object({
        files: z
          .array(z.object({ name: z.string().min(1).max(100), rules: z.unknown() }))
          .max(MAX_BUILT_IN_SITE_RULES),
        readers: z.array(z.string().max(40)).max(100),
        check: z.custom<ImporterSites['check']>(isFunction, 'must be a function'),
        apply: z.custom<ImporterSites['apply']>(isFunction, 'must be a function'),
        guide: z.string().max(500_000).optional(),
        widens: z.custom<NonNullable<ImporterSites['widens']>>(isFunction).optional(),
        tryPage: z.custom<NonNullable<ImporterSites['tryPage']>>(isFunction).optional(),
        cannotTry: z.custom<NonNullable<ImporterSites['cannotTry']>>(isFunction).optional(),
      })
      .optional(),
  })
  .refine((importer) => !importer.catalogue || importer.games, {
    message: 'an importer with a catalogue must also read game pages',
    path: ['catalogue'],
  })
  .refine((importer) => !importer.catalogues || importer.games, {
    message: 'an importer with catalogues must also read game pages',
    path: ['catalogues'],
  })
  // An importer of game files only may read no pages.
  .refine(
    (importer) => readsSomehow(importer) || importer.gameFiles !== undefined,
    readsSomehowError,
  )
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
  T extends Pick<AtlasImporter, 'matches' | 'general' | 'games' | 'catalogue' | 'catalogues'>,
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
    ['catalogue', (importer) => catalogueAt(importer, address) !== null],
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
  leftOut: z.array(z.string().trim().min(1).max(500)).max(MAX_LEFT_OUT_SENTENCES).optional(),
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
    // Kept only on the site of the page read (`ownAddress`).
    pageAddress: z.unknown().optional(),
    // Checked against the pack, entry by entry (`pictureFilesOf`).
    pictureFiles: z.unknown().optional(),
    // Checked against the pack, entry by entry (`cutPicturesOf`).
    cutPictures: z.unknown().optional(),
    // Checked against the pack, entry by entry (`sceneBuildsOf`).
    sceneBuilds: z.unknown().optional(),
    // Kept when it is a name (`siteNameOf`).
    site: z.unknown().optional(),
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
    const own = ownAddress((entry as { pageAddress?: unknown }).pageAddress, url.href);
    kept.push({
      url: url.href,
      links: pageLinks(texts, own ?? url.href),
      ...(own ? { pageAddress: own } : {}),
    });
  }
  return kept;
}

/**
 * The name of a site as the app keeps it (see {@link ImportSuccess.site}):
 * one line, with line breaks as spaces and other control characters left
 * out, trimmed, of 1 to {@link MAX_SITE_NAME_LENGTH} characters as the
 * manifest schema counts them; else null.
 */
export function siteNameOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  return name.length > 0 && name.length <= MAX_SITE_NAME_LENGTH ? name : null;
}

/**
 * A page's own address as the app keeps it (see {@link
 * ImportSuccess.pageAddress}): a web address on the same site as the
 * address asked, without its fragment, that is not the same page; else null.
 */
export function ownAddress(value: unknown, asked: string | undefined): string | null {
  if (typeof value !== 'string' || !asked || value.length > MAX_ADDRESS_CHARS) return null;
  if (!isAllowedPageUrl(value) || !sameSite(asked, value)) return null;
  const url = new URL(value.trim());
  url.hash = '';
  return pageKey(url.href) === pageKey(asked) ? null : url.href;
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
  const {
    links: given,
    writtenAgain: again,
    pictureFiles: files,
    pageAddress: arrived,
    cutPictures: cuts,
    sceneBuilds: builds,
    site: siteGiven,
    ...rest
  } = success;
  const site = siteNameOf(siteGiven);
  const pageAddress = ownAddress(arrived, pageUrl);
  // Links are kept as links of the page where it is.
  const links = pageLinks(given, pageAddress ?? pageUrl);
  const writtenAgain = writtenAgainLinks(again, pageUrl);
  const pictureFiles = pictureFilesOf(files, pack.data);
  const cutPictures = cutPicturesOf(cuts, pack.data);
  const sceneBuilds = sceneBuildsOf(builds, pack.data);
  return {
    ...rest,
    ...(cutPictures.length > 0 ? { cutPictures } : {}),
    ...(sceneBuilds.length > 0 ? { sceneBuilds } : {}),
    ...(site ? { site } : {}),
    ...(pageAddress ? { pageAddress } : {}),
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

/** The first importer that recognises `url` as the address of one of its lists of games, or null. */
export function findCatalogueImporter<T extends Pick<AtlasImporter, 'catalogue' | 'catalogues'>>(
  importers: readonly T[],
  url: string,
): T | null {
  if (!isAllowedPageUrl(url)) return null;
  return importers.find((i) => catalogueAt(i, url.trim()) !== null) ?? null;
}

/** Lists of games one importer may offer at most, its {@link AtlasImporter.catalogue} among them. */
export const MAX_CATALOGUES = 50;

/**
 * An importer's lists of games: its {@link AtlasImporter.catalogue}, then
 * those {@link AtlasImporter.catalogues} gives, each checked as a loaded
 * importer's `catalogue` is, at most {@link MAX_CATALOGUES}, each address
 * once (the first list with an address counts). A list that is not usable,
 * or a `catalogues` that throws, is left out. Never throws.
 */
export function cataloguesOf(
  importer: Pick<AtlasImporter, 'catalogue' | 'catalogues'>,
): SiteCatalogue[] {
  const given: unknown[] = importer.catalogue ? [importer.catalogue] : [];
  if (typeof importer.catalogues === 'function') {
    const more: unknown = safely(() => importer.catalogues!(), []);
    if (Array.isArray(more)) given.push(...(more as unknown[]).slice(0, MAX_CATALOGUES));
  }
  const out: SiteCatalogue[] = [];
  const addresses = new Set<string>();
  for (const one of given) {
    if (out.length >= MAX_CATALOGUES) break;
    if (!catalogueSchema.safeParse(one).success) continue;
    const catalogue = one as SiteCatalogue;
    const key = pageKey(catalogue.address);
    if (addresses.has(key)) continue;
    addresses.add(key);
    out.push(catalogue);
  }
  return out;
}

/** The list of games of an importer whose address `url` is ({@link SiteCatalogue.matches}), or null. */
export function catalogueAt(
  importer: Pick<AtlasImporter, 'catalogue' | 'catalogues'>,
  url: string,
): SiteCatalogue | null {
  return (
    cataloguesOf(importer).find((catalogue) => safely(() => catalogue.matches(url), false)) ?? null
  );
}

/**
 * The reader an importer gives for one game address of its own
 * ({@link GamePages.pageReaderFor}), when it gives one that is a reader of
 * the allowed size; else null, for its `pageReader`.
 */
export function gamePageReaderOf(
  importer: Pick<AtlasImporter, 'games'>,
  url: string,
): string | null {
  const games = importer.games;
  if (!games?.pageReaderFor) return null;
  const given: unknown = safely(() => games.pageReaderFor!(url), null);
  return typeof given === 'string' && given.length > 0 && given.length <= MAX_READER_CHARS
    ? given
    : null;
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

/**
 * The kind of a listed page that is the site's own home page (a wiki's
 * main page, see the pack manifest's `homePage`): an app that knows it
 * ticks it at first, and keeps the page the person browses to as that page
 * too when the listing was read from it. An app that does not know the
 * kind lists it as any other page.
 */
export const HOME_PAGE_KIND = 'home-page';

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
  maps: z.int().nonnegative().max(100_000).optional(),
  bytes: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  system: z.string().max(80).optional(),
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
      ...(game.maps !== undefined ? { maps: game.maps } : {}),
      ...(game.bytes !== undefined ? { bytes: game.bytes } : {}),
      ...(game.system?.trim() ? { system: game.system.trim() } : {}),
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

// ---------------------------------------------------------------------------
// Site rules files

/** Problems an importer answers for one file, as the app takes them: at most this many. */
const MAX_IMPORTER_PROBLEMS = 50;

/** An importer's answer of problems as the app takes it: each with a field and words, in bounds. */
function problemsFrom(value: unknown): SiteRulesProblem[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).slice(0, MAX_IMPORTER_PROBLEMS).flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { field, message } = entry as { field?: unknown; message?: unknown };
    if (typeof field !== 'string' || typeof message !== 'string' || !message.trim()) return [];
    return [{ field: field.slice(0, 200), message: message.trim().slice(0, 500) }];
  });
}

/**
 * What the importer cannot read of a checked file ({@link ImporterSites.check}),
 * as the app takes it; none for an importer without site rules files, or
 * one that throws or answers in another shape.
 */
export function siteRulesProblemsOf(
  importer: Pick<AtlasImporter, 'sites'>,
  rules: SiteRules,
): SiteRulesProblem[] {
  const sites = importer.sites;
  return sites ? problemsFrom(safely(() => sites.check(rules), [])) : [];
}

/**
 * Hands the files switched on to the importer ({@link ImporterSites.apply})
 * and takes its answer: the problems of each file, in the order given,
 * none for a file it said nothing of. An importer without site rules files
 * is not called.
 */
export function applySiteRules(
  importer: Pick<AtlasImporter, 'sites'>,
  files: readonly AppliedSiteRules[],
): SiteRulesProblem[][] {
  const sites = importer.sites;
  if (!sites) return files.map(() => []);
  const answer: unknown = safely(() => sites.apply(files), []);
  const lists = Array.isArray(answer) ? (answer as unknown[]) : [];
  return files.map((_, index) => problemsFrom(lists[index]));
}

/**
 * What a file of the person's widens against the files the importer comes
 * with, as the app takes it: what the importer says
 * ({@link ImporterSites.widens}; nothing for an importer that does not say,
 * throws or answers in another shape), and what the file's `reading`
 * sections widen against those files whatever the importer says
 * ({@link readingWidenings}: a permission it records, an address a shipped
 * file keeps the app off that it no longer does), each once. None for an
 * importer without site rules files.
 */
export function siteRulesWideningsOf(
  importer: Pick<AtlasImporter, 'sites'>,
  rules: SiteRules,
): SiteRulesWidening[] {
  const sites = importer.sites;
  if (!sites) return [];
  const said = sites.widens ? problemsFrom(safely(() => sites.widens?.(rules), [])) : [];
  const shipped = safely(
    () =>
      sites.files.flatMap((file) => {
        const checked = checkShippedSiteRules(file.rules);
        return checked.ok ? [{ name: file.name, rules: checked.rules }] : [];
      }),
    [],
  );
  const seen = new Set(said.map((one) => `${one.field}\n${one.message}`));
  const more = readingWidenings(rules, shipped).filter(
    (one) => !seen.has(`${one.field}\n${one.message}`),
  );
  return [...said, ...more];
}

/**
 * Whether an importer can try a file on a saved page ({@link ImporterSites.tryPage}):
 * null when it can, else why not, in full sentences. An importer that does
 * not say ({@link ImporterSites.cannotTry}) tries a file with a part read by
 * `rules` when it lists that reader; a fixed sentence says why not for any
 * other. An importer that throws or answers in another shape cannot.
 */
export function cannotTryOf(
  importer: Pick<AtlasImporter, 'sites'>,
  rules: SiteRules,
): string | null {
  const sites = importer.sites;
  if (!sites?.tryPage) return 'This importer cannot try a file on a saved page.';
  if (sites.cannotTry) {
    const said = safely(
      () => sites.cannotTry?.(rules),
      'This importer could not say whether it can try this file.',
    );
    if (said === null) return null;
    return typeof said === 'string' && said.trim()
      ? said.trim().slice(0, 1000)
      : 'This importer could not say whether it can try this file.';
  }
  const byRules =
    sites.readers.includes(RULES_READER) &&
    isSiteFile(rules) &&
    rules.parts.some((part) => readByRules(part));
  return byRules ? null : 'This importer can try only a part read by rules on a saved page.';
}

/**
 * Tries a file on one saved page with the importer's reader
 * ({@link ImporterSites.tryPage}), its answer checked; null for an importer
 * that cannot, or whose answer is not usable.
 */
export async function trySitePage(
  importer: Pick<AtlasImporter, 'sites'>,
  request: SiteTrialRequest,
): Promise<SiteTrial | null> {
  const sites = importer.sites;
  if (!sites?.tryPage) return null;
  try {
    return siteTrialOf(await sites.tryPage(request));
  } catch {
    return null;
  }
}

/**
 * The reader of its own an importer gives for the page at `url`
 * ({@link AtlasImporter.pageReaderFor}), checked: text of 1 to
 * {@link MAX_READER_CHARS} characters, or null when it gives none, gives
 * something else or throws.
 */
export function ownPageReaderOf(
  importer: Pick<AtlasImporter, 'pageReaderFor'>,
  url: string,
): string | null {
  if (!importer.pageReaderFor) return null;
  let given: unknown;
  try {
    given = importer.pageReaderFor(url);
  } catch {
    return null;
  }
  return typeof given === 'string' && given.length > 0 && given.length <= MAX_READER_CHARS
    ? given
    : null;
}
