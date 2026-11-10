import { describe, expect, it } from 'vitest';
import { applyQueryOverrides, loadRuntimeConfig } from './config';

const serve = (body: unknown, status = 200) =>
  (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as typeof fetch;

describe('loadRuntimeConfig', () => {
  it('resolves the pack URL against the config file, so the app works under any sub-path', async () => {
    const config = await loadRuntimeConfig(
      'https://example.test/tools/atlas/index.html',
      serve({ packUrl: 'packs/demo/' }),
    );
    expect(config).toEqual({
      packUrl: 'https://example.test/tools/atlas/packs/demo/',
      theme: 'dark',
      clustering: true,
    });
  });

  it('keeps absolute pack URLs', async () => {
    const config = await loadRuntimeConfig(
      'https://example.test/',
      serve({ packUrl: 'https://cdn.example.test/p/', theme: 'light', clustering: false }),
    );
    expect(config).toMatchObject({
      packUrl: 'https://cdn.example.test/p/',
      theme: 'light',
      clustering: false,
    });
  });

  it('rejects invalid settings', async () => {
    await expect(
      loadRuntimeConfig('https://example.test/', serve({ theme: 'blue' })),
    ).rejects.toThrow(/Invalid config\.json/);
  });

  it('reports a missing file', async () => {
    await expect(loadRuntimeConfig('https://example.test/', serve({}, 404))).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

describe('applyQueryOverrides', () => {
  const base = { packUrl: 'x', theme: 'dark' as const, clustering: true };

  it('turns clustering off from the query string', () => {
    expect(applyQueryOverrides(base, '?clustering=off').clustering).toBe(false);
    expect(applyQueryOverrides({ ...base, clustering: false }, '?clustering=on').clustering).toBe(
      true,
    );
    expect(applyQueryOverrides(base, '?other=1')).toBe(base);
  });
});
