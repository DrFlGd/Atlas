import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pyramidLevel } from '@atlas/core';
import { makeFixturePack, makeGuidesFixturePack } from '@atlas/schema/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { validatePackFolder } from './validateFolder';
import { assertValidPack, writePackJson, writeTileFolder } from './writePack';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixtureFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-validate-'));
  folders.push(dir);
  const pack = makeFixturePack();
  await writePackJson(dir, pack);
  const map = pack.maps[0]!;
  const tiles = [];
  for (let z = 0; z <= 2; z++) {
    const level = pyramidLevel(map.width, map.height, 256, 2, z);
    for (let x = 0; x < level.columns; x++)
      for (let y = 0; y < level.rows; y++) tiles.push({ z, x, y, data: Buffer.from('tile') });
  }
  await writeTileFolder(join(dir, 'tiles/surface'), tiles);
  return dir;
}

describe('validatePackFolder', () => {
  it('accepts a valid pack folder with all its tiles', async () => {
    const report = await validatePackFolder(await fixtureFolder());
    expect(report.problems).toEqual([]);
    expect(report.tilesChecked).toBeGreaterThanOrEqual(1 + 2 + 8);
  });

  it('reports unknown fields, broken references and missing tiles', async () => {
    const dir = await fixtureFolder();
    const pack = makeFixturePack();
    const maps = pack.maps.map((map) => ({ ...map, unknownField: 1 }));
    await writeFile(join(dir, 'maps.json'), JSON.stringify(maps));
    let report = await validatePackFolder(dir);
    expect(report.problems.join('\n')).toMatch(/unknownField|Unrecognized/);

    await writeFile(join(dir, 'maps.json'), JSON.stringify(pack.maps));
    await unlink(join(dir, 'tiles/surface/2/1/1.webp'));
    report = await validatePackFolder(dir);
    expect(report.problems).toEqual([
      'demo:layer:surface: 1 tiles missing, such as tiles/surface/2/1/1.webp',
    ]);
  });

  it('reports an unknown list type and an unknown key, which the app would skip', async () => {
    const dir = await fixtureFolder();
    const pack = makeFixturePack();
    const checklists = pack.checklists.map((c) => ({ ...c, type: 'timeline', colour: 'red' }));
    await writeFile(join(dir, 'checklists.json'), JSON.stringify(checklists));
    const report = await validatePackFolder(dir);
    expect(report.problems.join('\n')).toMatch(/checklists\.0\.type/);
    expect(report.problems.join('\n')).toMatch(/colour/);
  });
});

describe('assertValidPack', () => {
  it('refuses what a writer did not mean to write: unknown keys and list types', () => {
    const pack = makeFixturePack();
    expect(() => assertValidPack(pack)).not.toThrow();
    const typo = { ...pack, checklists: [{ ...pack.checklists[0]!, tpye: 'route' }] };
    expect(() => assertValidPack(typo)).toThrow(/tpye/);
    const unknown = {
      ...pack,
      checklists: [{ ...pack.checklists[0]!, type: 'timeline' as never }],
    };
    expect(() => assertValidPack(unknown)).toThrow(/checklists\.0\.type/);
  });
});

describe('validatePackFolder: a game with no map', () => {
  async function guidesFolder(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-validate-'));
    folders.push(dir);
    await writePackJson(dir, makeGuidesFixturePack());
    await mkdir(join(dir, 'pictures'));
    await writeFile(join(dir, 'pictures/gate.png'), 'png');
    return dir;
  }

  it('accepts it with empty map files and without them, but not with some', async () => {
    const dir = await guidesFolder();
    expect((await validatePackFolder(dir)).problems).toEqual([]);
    for (const file of ['maps', 'layers', 'categoryGroups', 'categories', 'locations']) {
      await unlink(join(dir, `${file}.json`));
    }
    expect((await validatePackFolder(dir)).problems).toEqual([]);
    await writeFile(join(dir, 'maps.json'), '[]');
    expect((await validatePackFolder(dir)).problems).toEqual(
      expect.arrayContaining(['layers.json: missing']),
    );
  });

  it('reports a picture whose file is missing', async () => {
    const dir = await guidesFolder();
    await unlink(join(dir, 'pictures/gate.png'));
    expect((await validatePackFolder(dir)).problems).toEqual([
      'pages:picture:gate: pictures/gate.png is missing',
    ]);
  });

  it('accepts a missing file for a picture fetched later', async () => {
    const pack = makeGuidesFixturePack();
    pack.pictures = pack.pictures?.map((p) => ({
      ...p,
      remote: 'https://pictures.example.com/a.png',
    }));
    const dir = await mkdtemp(join(tmpdir(), 'atlas-validate-'));
    folders.push(dir);
    await writePackJson(dir, pack);
    expect((await validatePackFolder(dir)).problems).toEqual([]);
  });

  it('writes contents and pictures only for a pack that has some', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-validate-'));
    folders.push(dir);
    expect(await writePackJson(dir, makeFixturePack())).not.toContain('sections.json');
    expect(await writePackJson(dir, makeGuidesFixturePack())).toEqual(
      expect.arrayContaining(['sections.json', 'pictures.json']),
    );
  });
});
