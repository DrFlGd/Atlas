import { MANIFEST_FILE, manifestSchema } from '@atlas/schema';
import { packEntrySchema, resolvePackEntries, type PackEntry } from '@atlas/core';
import { z } from 'zod';

/**
 * Settings read at runtime from `config.json` next to `index.html`, so one
 * build can be deployed anywhere (static host, container, desktop shell) and
 * configured by replacing that file.
 */
const runtimeConfigSchema = z.object({
  /**
   * The packs to offer, overriding the pack index. Same shape as the index
   * entries; URLs are absolute or relative to `config.json`.
   */
  packs: z.array(packEntrySchema).min(1).optional(),
  /** Where to find the pack index when `packs` is not given, relative to `config.json`. */
  packIndex: z.string().min(1).default('packs/index.json'),
  /** A single pack root; older shorthand for a one-entry `packs` list. */
  packUrl: z.string().min(1).optional(),
  theme: z.enum(['dark', 'light']).default('dark'),
  /** Group nearby markers at low zoom. */
  clustering: z.boolean().default(true),
  /**
   * Importers added to a desktop build (`ATLAS_BUNDLE_IMPORTERS`); each
   * `module` is relative to `config.json`. None in a browser.
   */
  importers: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        title: z.string().min(1).max(100),
        description: z.string().max(500).default(''),
        version: z.string().max(50).default(''),
        module: z.string().min(1),
      }),
    )
    .default([]),
});

/** An importer listed in `config.json`; its module is loaded when first needed. */
export interface ImporterEntry {
  id: string;
  title: string;
  description: string;
  version: string;
  /** Absolute URL of the importer's module. */
  moduleUrl: string;
}

export interface RuntimeConfig {
  /** Absolute URL of `config.json`; relative URLs in it resolve against this. */
  baseUrl: string;
  packs: PackEntry[] | null;
  packIndexUrl: string;
  packUrl: string | null;
  theme: 'dark' | 'light';
  clustering: boolean;
  importers: ImporterEntry[];
}

/** Loads and validates `config.json`, resolving its URLs. */
export async function loadRuntimeConfig(
  baseUrl: string = document.baseURI,
  fetchFn: typeof fetch = fetch,
): Promise<RuntimeConfig> {
  const url = new URL('config.json', baseUrl);
  const response = await fetchFn(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load ${url.href}: HTTP ${response.status}`);
  const result = runtimeConfigSchema.safeParse(await response.json());
  if (!result.success) throw new Error(`Invalid config.json:\n${z.prettifyError(result.error)}`);
  const config = result.data;
  return {
    baseUrl: url.href,
    packs: config.packs ? resolvePackEntries({ packs: config.packs }, url) : null,
    packIndexUrl: new URL(config.packIndex, url).href,
    packUrl: config.packUrl ? withSlash(new URL(config.packUrl, url)) : null,
    theme: config.theme,
    clustering: config.clustering,
    importers: config.importers.map(({ module, ...importer }) => ({
      ...importer,
      moduleUrl: new URL(module, url).href,
    })),
  };
}

function withSlash(url: URL): string {
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

/**
 * The packs this installation offers: the explicit list from `config.json`,
 * else its single `packUrl`, else the pack index. Index entry URLs are
 * relative to the app root (where `config.json` lives), as in
 * `{ "url": "packs/demo/" }`.
 */
export async function loadCatalog(
  config: RuntimeConfig,
  fetchFn: typeof fetch = fetch,
): Promise<PackEntry[]> {
  if (config.packs) return config.packs;
  if (config.packUrl) {
    const manifestUrl = new URL(MANIFEST_FILE, config.packUrl);
    const response = await fetchFn(manifestUrl, { cache: 'no-store' });
    if (!response.ok)
      throw new Error(`Could not load ${manifestUrl.href}: HTTP ${response.status}`);
    const manifest = manifestSchema.safeParse(await response.json());
    if (!manifest.success) throw new Error(`Invalid ${manifestUrl.href}`);
    return [{ id: manifest.data.gameId, url: config.packUrl, title: manifest.data.title }];
  }
  const response = await fetchFn(config.packIndexUrl, { cache: 'no-store' });
  if (response.status === 404) {
    throw new Error(
      `No pack index at ${config.packIndexUrl}. Add packs, or list them in config.json.`,
    );
  }
  if (!response.ok) {
    throw new Error(`Could not load ${config.packIndexUrl}: HTTP ${response.status}`);
  }
  const entries = resolvePackEntries(await response.json(), config.baseUrl);
  if (entries.length === 0) throw new Error('No packs are installed.');
  return entries;
}

/**
 * Applies URL query overrides for development and testing:
 * `?clustering=off` draws every marker individually.
 */
export function applyQueryOverrides(config: RuntimeConfig, search: string): RuntimeConfig {
  const params = new URLSearchParams(search);
  const clustering = params.get('clustering');
  if (clustering === 'off') return { ...config, clustering: false };
  if (clustering === 'on') return { ...config, clustering: true };
  return config;
}
