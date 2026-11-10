import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPackIndex, bundledPackNames } from './packsPlugin.ts';

describe('bundledPackNames', () => {
  it('defaults to the demo pack and splits a list', () => {
    expect(bundledPackNames(undefined)).toEqual(['demo']);
    expect(bundledPackNames('')).toEqual([]);
    expect(bundledPackNames(' demo , other,demo ')).toEqual(['demo', 'other']);
  });

  it('rejects folder names that could leave the packs folder', () => {
    expect(() => bundledPackNames('../secret')).toThrow(/Invalid pack folder/);
  });
});

describe('buildPackIndex', () => {
  const root = mkdtemp(join(tmpdir(), 'atlas-packs-'));
  afterAll(async () => {
    await rm(await root, { recursive: true, force: true });
  });

  it('lists folders with a manifest by game id and title', async () => {
    const dir = await root;
    const pack = async (folder: string, manifest: unknown) => {
      await mkdir(join(dir, folder), { recursive: true });
      if (manifest !== null)
        await writeFile(join(dir, folder, 'manifest.json'), JSON.stringify(manifest));
    };
    await pack('demo', { gameId: 'demo', title: 'Demo' });
    await pack('copy', { gameId: 'demo', title: 'Copy' });
    await pack('broken', { title: 'No id' });
    await pack('empty', null);
    const warnings: string[] = [];
    const index = await buildPackIndex(dir, ['demo', 'copy', 'broken', 'empty'], (m) =>
      warnings.push(m),
    );
    expect(index).toEqual({ packs: [{ id: 'demo', url: 'packs/demo/', title: 'Demo' }] });
    expect(warnings).toHaveLength(2);
  });

  it('keeps the order of ATLAS_BUNDLE_PACKS, so its first pack is the default game', async () => {
    const dir = await root;
    await mkdir(join(dir, 'zeta'), { recursive: true });
    await writeFile(
      join(dir, 'zeta', 'manifest.json'),
      JSON.stringify({ gameId: 'zeta', title: 'Zeta' }),
    );
    const index = await buildPackIndex(dir, bundledPackNames('zeta,demo'));
    expect(index.packs.map((p) => p.id)).toEqual(['zeta', 'demo']);
  });
});
