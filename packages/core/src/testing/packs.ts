import type { PackData } from '@atlas/schema';
import { makeFixturePack } from '@atlas/schema/testing';
import { indexPack, type LoadedPack } from '../pack/loadedPack';

/**
 * The schema fixture pack extended with a second map (two layers), a
 * non-trackable category in a second group, and a few more locations, for
 * tests that need counts across maps, regions and categories.
 */
export function makeTestPackData(): PackData {
  const pack = makeFixturePack();
  pack.maps.push({ id: 'demo:map:caves', name: 'Caves', width: 512, height: 512 });
  pack.layers.push(
    {
      id: 'demo:layer:upper',
      mapId: 'demo:map:caves',
      name: 'Upper',
      tiles: { type: 'xyz', url: 'tiles/upper/{z}/{x}/{y}.webp' },
      minZoom: 0,
      maxZoom: 1,
      tileSize: 256,
    },
    {
      id: 'demo:layer:lower',
      mapId: 'demo:map:caves',
      name: 'Lower',
      tiles: { type: 'pmtiles', url: 'tiles/lower.pmtiles' },
      minZoom: 0,
      maxZoom: 1,
      tileSize: 256,
    },
  );
  pack.categoryGroups.push({ id: 'demo:catgroup:places', name: 'Places', order: 1 });
  pack.categories.push(
    {
      id: 'demo:cat:camp',
      groupId: 'demo:catgroup:places',
      name: 'Camp',
      icon: 'flame',
      color: '#ff7a59',
      trackable: false,
      defaultVisible: true,
    },
    {
      id: 'demo:cat:chest',
      groupId: 'demo:catgroup:collect',
      name: 'Chest',
      icon: 'not-an-icon',
      color: '#e08a3c',
      trackable: true,
      defaultVisible: false,
    },
  );
  const base = {
    entityIds: [],
    guideId: null,
    since: '1.0.0',
  };
  pack.locations.push(
    {
      ...base,
      id: 'demo:loc:0003',
      mapId: 'demo:map:world',
      layerId: 'demo:layer:surface',
      x: 700,
      y: 100,
      categoryId: 'demo:cat:chest',
      regionId: 'demo:region:north-east',
      name: 'Gilded chest',
    },
    {
      ...base,
      id: 'demo:loc:0004',
      mapId: 'demo:map:world',
      layerId: 'demo:layer:surface',
      x: 300,
      y: 400,
      categoryId: 'demo:cat:camp',
      regionId: null,
      name: 'Hunters’ camp',
    },
    {
      ...base,
      id: 'demo:loc:0005',
      mapId: 'demo:map:caves',
      layerId: 'demo:layer:upper',
      x: 100,
      y: 100,
      categoryId: 'demo:cat:chest',
      regionId: null,
      name: 'Damp chest',
    },
    {
      ...base,
      id: 'demo:loc:0006',
      mapId: 'demo:map:caves',
      layerId: 'demo:layer:lower',
      x: 200,
      y: 300,
      categoryId: 'demo:cat:herb',
      regionId: null,
      name: 'Glow moss',
      entityIds: ['demo:entity:moss'],
    },
  );
  pack.guides[0]!.body = 'Herbs grow near **water**. See [the notes](https://example.test/notes).';
  return pack;
}

export function makeTestPack(): LoadedPack {
  return indexPack(makeTestPackData(), new URL('https://packs.example.test/demo/'));
}
