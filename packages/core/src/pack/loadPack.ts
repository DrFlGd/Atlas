import {
  COLLECTION_NAMES,
  MANIFEST_FILE,
  PACK_COLLECTIONS,
  SCHEMA_VERSION,
  checkPackIntegrity,
  manifestSchema,
  type CollectionName,
  type PackData,
  type PackManifest,
} from '@atlas/schema';
import { type z } from 'zod';
import { indexPack, type LoadedPack } from './loadedPack';

/** Raised when a pack cannot be fetched, parsed or validated. */
export class PackLoadError extends Error {
  override readonly name = 'PackLoadError';
  constructor(
    message: string,
    /** Pack-relative file the problem was found in, when there is one. */
    readonly file: string | null,
    /** Individual problems, one per line. */
    readonly issues: readonly string[] = [],
  ) {
    super(issues.length > 0 ? `${message}\n${issues.map((i) => `  - ${i}`).join('\n')}` : message);
  }
}

export interface LoadPackOptions {
  /** Fetch implementation; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** Highest number of issues listed in a {@link PackLoadError}. */
const MAX_LISTED_ISSUES = 20;

/**
 * Loads, validates and indexes the data pack at `packUrl`. The URL must be
 * absolute and point at the pack root folder (the one holding
 * `manifest.json`); relative paths inside the pack resolve against it.
 */
export async function loadPack(
  packUrl: string | URL,
  options: LoadPackOptions = {},
): Promise<LoadedPack> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = new URL(packUrl);
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';

  const readJson = async (file: string, required: boolean): Promise<unknown> => {
    const url = new URL(file, baseUrl);
    let response: Response;
    try {
      response = await doFetch(url, options.signal ? { signal: options.signal } : {});
    } catch (error) {
      throw new PackLoadError(`Could not fetch ${url.href}: ${String(error)}`, file);
    }
    if (response.status === 404 && !required) return undefined;
    if (!response.ok) {
      throw new PackLoadError(`Could not fetch ${url.href}: HTTP ${response.status}`, file);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new PackLoadError(`${file} is not valid JSON: ${String(error)}`, file);
    }
  };

  const rawManifest = await readJson(MANIFEST_FILE, true);
  const version = (rawManifest as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version !== SCHEMA_VERSION) {
    throw new PackLoadError(
      `Unsupported pack schema version ${JSON.stringify(version)}; this app reads version ${SCHEMA_VERSION}`,
      MANIFEST_FILE,
    );
  }
  const manifest: PackManifest = parseWith(manifestSchema, rawManifest, MANIFEST_FILE);

  const entries = await Promise.all(
    COLLECTION_NAMES.map(async (name) => {
      const spec = PACK_COLLECTIONS[name];
      const raw = await readJson(spec.file, spec.required);
      const parsed = raw === undefined ? [] : parseWith(spec.schema, raw, spec.file);
      return [name, parsed] as const;
    }),
  );
  const collections = Object.fromEntries(entries) as { [K in CollectionName]: PackData[K] };
  const data: PackData = { manifest, ...collections };

  const issues = checkPackIntegrity(data);
  if (issues.length > 0) {
    throw new PackLoadError(
      `Pack ${manifest.gameId} ${manifest.packVersion} is inconsistent (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      null,
      issues.slice(0, MAX_LISTED_ISSUES).map((issue) => `${issue.path}: ${issue.message}`),
    );
  }

  return indexPack(data, baseUrl);
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown, file: string): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new PackLoadError(
    `${file} does not match the pack schema`,
    file,
    result.error.issues
      .slice(0, MAX_LISTED_ISSUES)
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`),
  );
}
