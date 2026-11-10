import { describe, expect, it } from 'vitest';
import { applyQueryOverrides, loadCatalog, loadRuntimeConfig, type RuntimeConfig } from './config';

/** Serves JSON bodies by absolute URL; anything else is a 404. */
const serve = (files: Record<string, unknown>) =>
  ((input: string | URL) => {
    const href = String(input);
    const body = files[href];
    return Promise.resolve(
      body === undefined
        ? new Response('not found', { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 }),
    );
  }) as typeof fetch;

const BASE = 'https://example.test/tools/atlas/';

describe('loadRuntimeConfig', () => {
  it('defaults to the pack index next to the app, so the app works under any sub-path', async () => {
    const config = await loadRuntimeConfig(
      `${BASE}index.html`,
      serve({ [`${BASE}config.json`]: {} }),
    );
    expect(config).toEqual({
      baseUrl: `${BASE}config.json`,
      packs: null,
      packIndexUrl: `${BASE}packs/index.json`,
      packUrl: null,
      theme: 'dark',
      clustering: true,
      importers: [],
    });
  });

  it('resolves an explicit pack list and the single-pack shorthand', async () => {
    const config = await loadRuntimeConfig(
      BASE,
      serve({
        [`${BASE}config.json`]: {
          packs: [
            { id: 'demo', url: 'packs/demo', title: 'Demo' },
            { id: 'far', url: 'https://cdn.example.test/far/', title: 'Far' },
          ],
          packUrl: 'p/one',
          theme: 'light',
          clustering: false,
        },
      }),
    );
    expect(config.packs?.map((p) => p.url)).toEqual([
      `${BASE}packs/demo/`,
      'https://cdn.example.test/far/',
    ]);
    expect(config.packUrl).toBe(`${BASE}p/one/`);
    expect(config).toMatchObject({ theme: 'light', clustering: false });
  });

  it('resolves importer modules against config.json', async () => {
    const config = await loadRuntimeConfig(
      BASE,
      serve({
        [`${BASE}config.json`]: {
          importers: [{ id: 'demo-maps', title: 'Demo', module: 'importers/demo-maps.js' }],
        },
      }),
    );
    expect(config.importers).toEqual([
      {
        id: 'demo-maps',
        title: 'Demo',
        description: '',
        version: '',
        moduleUrl: `${BASE}importers/demo-maps.js`,
      },
    ]);
    await expect(
      loadRuntimeConfig(
        BASE,
        serve({
          [`${BASE}config.json`]: { importers: [{ id: '../x', title: 'X', module: 'x.js' }] },
        }),
      ),
    ).rejects.toThrow(/Invalid config\.json/);
  });

  it('rejects invalid settings and reports a missing file', async () => {
    await expect(
      loadRuntimeConfig(BASE, serve({ [`${BASE}config.json`]: { theme: 'blue' } })),
    ).rejects.toThrow(/Invalid config\.json/);
    await expect(loadRuntimeConfig(BASE, serve({}))).rejects.toThrow(/HTTP 404/);
  });
});

describe('loadCatalog', () => {
  const config = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
    baseUrl: `${BASE}config.json`,
    packs: null,
    packIndexUrl: `${BASE}packs/index.json`,
    packUrl: null,
    theme: 'dark',
    clustering: true,
    importers: [],
    ...overrides,
  });

  it('reads the pack index and resolves entries against the app root', async () => {
    const entries = await loadCatalog(
      config(),
      serve({
        [`${BASE}packs/index.json`]: {
          packs: [
            { id: 'demo', url: 'packs/demo/', title: 'Atlas demo world' },
            { id: 'other', url: 'packs/other/', title: 'Other' },
          ],
        },
      }),
    );
    expect(entries).toEqual([
      { id: 'demo', url: `${BASE}packs/demo/`, title: 'Atlas demo world' },
      { id: 'other', url: `${BASE}packs/other/`, title: 'Other' },
    ]);
  });

  it('prefers the explicit list, then the single pack URL', async () => {
    const listed = [{ id: 'x', url: `${BASE}x/`, title: 'X' }];
    expect(await loadCatalog(config({ packs: listed }), serve({}))).toBe(listed);

    const manifest = {
      schemaVersion: 1,
      gameId: 'single',
      title: 'Single pack',
      packVersion: '1.0.0',
      gamePatch: '1',
      attribution: [],
      idMigrations: {},
    };
    const entries = await loadCatalog(
      config({ packUrl: `${BASE}one/` }),
      serve({ [`${BASE}one/manifest.json`]: manifest }),
    );
    expect(entries).toEqual([{ id: 'single', url: `${BASE}one/`, title: 'Single pack' }]);
  });

  it('explains an empty or missing index', async () => {
    await expect(loadCatalog(config(), serve({}))).rejects.toThrow(/No pack index/);
    await expect(
      loadCatalog(config(), serve({ [`${BASE}packs/index.json`]: { packs: [] } })),
    ).rejects.toThrow(/No packs are installed/);
  });
});

describe('applyQueryOverrides', () => {
  const base: RuntimeConfig = {
    baseUrl: BASE,
    packs: null,
    packIndexUrl: '',
    packUrl: null,
    theme: 'dark',
    clustering: true,
    importers: [],
  };

  it('turns clustering off from the query string', () => {
    expect(applyQueryOverrides(base, '?clustering=off').clustering).toBe(false);
    expect(applyQueryOverrides({ ...base, clustering: false }, '?clustering=on').clustering).toBe(
      true,
    );
    expect(applyQueryOverrides(base, '?other=1')).toBe(base);
  });
});
