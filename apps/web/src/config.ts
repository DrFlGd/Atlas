import { z } from 'zod';

/**
 * Settings read at runtime from `config.json` next to `index.html`, so one
 * build can be deployed anywhere (static host, container, desktop shell) and
 * configured by replacing that file.
 */
const runtimeConfigSchema = z.object({
  /** Pack root, absolute or relative to `config.json`. */
  packUrl: z.string().min(1),
  theme: z.enum(['dark', 'light']).default('dark'),
  /** Group nearby markers at low zoom. */
  clustering: z.boolean().default(true),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

/** Loads and validates `config.json`, resolving `packUrl` to an absolute URL. */
export async function loadRuntimeConfig(
  baseUrl: string = document.baseURI,
  fetchFn: typeof fetch = fetch,
): Promise<RuntimeConfig> {
  const url = new URL('config.json', baseUrl);
  const response = await fetchFn(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load ${url.href}: HTTP ${response.status}`);
  const result = runtimeConfigSchema.safeParse(await response.json());
  if (!result.success) throw new Error(`Invalid config.json:\n${z.prettifyError(result.error)}`);
  return { ...result.data, packUrl: new URL(result.data.packUrl, url).href };
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
