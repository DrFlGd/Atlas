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
 */

import {
  GAME_ID_PATTERN,
  checkPackIntegrity,
  idOf,
  packDataSchema,
  type PackData,
} from '@atlas/schema';
import { z } from 'zod';

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
   * The pack the import would replace, if one with that id is in the maps
   * folder: for example to keep each location's `since` version.
   */
  existingPack(packId: string): Promise<PackData | null>;
  /** Whether a pack with that id comes with the app; the app does not replace those. */
  isBundled(packId: string): boolean;
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
  /** The whole pack after the import, including maps from earlier imports. */
  pack: PackData;
  summary: ImportSummary;
}

export interface ImportFailure {
  ok: false;
  /** A plain sentence for the person. */
  message: string;
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
  pageReader: string;
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
   * Source text of a function taking no arguments, evaluated in the page as
   * `(<pageReader>)()`. It must be synchronous, must not change the page and
   * must not make requests. It returns `null` or `undefined` while the data
   * is not there yet (the app asks again a few seconds later), and otherwise
   * a JSON-serialisable value with only the parts the importer needs. An
   * exception counts as "not there yet".
   */
  pageReader: string;
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
}

const isFunction = (value: unknown): value is (...args: never[]) => unknown =>
  typeof value === 'function';

const readerSchema = z.string().min(1).max(MAX_READER_CHARS);
const waitSchema = z.int().min(MIN_WAIT_SECONDS).max(MAX_WAIT_SECONDS).optional();

const gamePagesSchema = z.object({
  matches: z.custom<GamePages['matches']>(isFunction, 'must be a function'),
  pageReader: readerSchema,
  waitSeconds: waitSchema,
  convert: z.custom<GamePages['convert']>(isFunction, 'must be a function'),
  gameAddress: z.custom<NonNullable<GamePages['gameAddress']>>(isFunction).optional(),
});

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
    pageReader: z.string().min(1).max(MAX_READER_CHARS),
    waitSeconds: z.int().min(MIN_WAIT_SECONDS).max(MAX_WAIT_SECONDS).optional(),
    convert: z.custom<AtlasImporter['convert']>(isFunction, 'must be a function'),
    games: gamePagesSchema.optional(),
    catalogue: catalogueSchema.optional(),
    refreshesBundledGames: z.boolean().optional(),
  })
  .refine((importer) => !importer.catalogue || importer.games, {
    message: 'an importer with a catalogue must also read game pages',
    path: ['catalogue'],
  });

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

/** The first installed importer that recognises `url`, or null. */
export function findImporter<T extends Pick<AtlasImporter, 'matches'>>(
  importers: readonly T[],
  url: string,
): T | null {
  if (!isAllowedPageUrl(url)) return null;
  for (const importer of importers) {
    try {
      if (importer.matches(url.trim())) return importer;
    } catch {
      // An importer that throws does not recognise the URL.
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
});

const outcomeSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    packId: z.string().regex(GAME_ID_PATTERN).max(64),
    sourceKey: z.string().regex(SLUG_PATTERN),
    mapId: idOf('map').optional(),
    checklistId: idOf('checklist').optional(),
    pack: z.unknown(),
    summary: summarySchema,
  }),
  z.object({ ok: z.literal(false), message: z.string().trim().min(1).max(2000) }),
]);

/**
 * Checks what an importer's `convert` returned: the outcome's shape, and for
 * a success the pack against the pack schema and its integrity rules. Returns
 * a failure with a readable message when anything is wrong.
 */
export function checkOutcome(value: unknown): ImportOutcome {
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
  if ((success.mapId === undefined) === (success.checklistId === undefined)) {
    return {
      ok: false,
      message: 'The importer must name either the map or the checklist the page became.',
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
  return { ...success, pack: pack.data };
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

/** The first importer that recognises `url` as a game address, or null. */
export function findGameImporter<T extends Pick<AtlasImporter, 'games'>>(
  importers: readonly T[],
  url: string,
): T | null {
  if (!isAllowedPageUrl(url)) return null;
  return (
    importers.find((i) => i.games && safely(() => i.games!.matches(url.trim()), false)) ?? null
  );
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
