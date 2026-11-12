import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pyramidLevel } from '@atlas/core';
import { makeFixturePack } from '@atlas/schema/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { validatePackFolder } from './validateFolder';
import { writePackJson, writeTileFolder } from './writePack';

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
});
