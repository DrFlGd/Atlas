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
  /** The imported map's name. */
  map: string;
  /** Maps in the pack after this import. */
  maps: number;
  /** Locations in the whole pack, and on the imported map. */
  locations: number;
  mapLocations: number;
  categories: number;
  /** The map was in the pack already and has been refreshed. */
  refreshed: boolean;
}

export interface ImportSuccess {
  ok: true;
  /** The pack's id; the same as `pack.manifest.gameId`. */
  packId: string;
  /** Key under which the app stores this page's data with the pack. Same page, same key. */
  sourceKey: string;
  /** The map in `pack` that this page became. */
  mapId: string;
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
}

const isFunction = (value: unknown): value is (...args: never[]) => unknown =>
  typeof value === 'function';

/** Checks the shape of a loaded importer module's default export. */
export const importerSchema = z.object({
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
});

const outcomeSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    packId: z.string().regex(GAME_ID_PATTERN).max(64),
    sourceKey: z.string().regex(SLUG_PATTERN),
    mapId: idOf('map'),
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
  if (!pack.data.maps.some((map) => map.id === success.mapId)) {
    return { ok: false, message: 'The importer named a map that is not in its pack.' };
  }
  return { ...success, pack: pack.data };
}
