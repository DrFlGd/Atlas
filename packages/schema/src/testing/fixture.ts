import type { PackData } from '../files';

/** A small, valid pack used by tests across the workspace. */
export function makeFixturePack(): PackData {
  return {
    manifest: {
      schemaVersion: 1,
      gameId: 'demo',
      title: 'Fixture pack',
      packVersion: '1.0.0',
      gamePatch: '1.0',
      attribution: [{ name: 'Atlas test suite' }],
      idMigrations: { 'demo:loc:old-1': 'demo:loc:0001' },
    },
    maps: [
      {
        id: 'demo:map:world',
        name: 'World',
        width: 1000,
        height: 600,
        worldTransform: { a: 2, b: 0, c: 0, d: 2, e: -1000, f: -600 },
      },
    ],
    layers: [
      {
        id: 'demo:layer:surface',
        mapId: 'demo:map:world',
        name: 'Surface',
        tiles: { type: 'xyz', url: 'tiles/surface/{z}/{x}/{y}.webp' },
        minZoom: 0,
        maxZoom: 2,
        tileSize: 256,
      },
    ],
    regions: [
      {
        id: 'demo:region:north',
        mapId: 'demo:map:world',
        parentId: null,
        name: 'North',
        polygon: [
          [0, 0],
          [1000, 0],
          [1000, 300],
          [0, 300],
        ],
      },
      {
        id: 'demo:region:north-east',
        mapId: 'demo:map:world',
        parentId: 'demo:region:north',
        name: 'North East',
        polygon: [
          [500, 0],
          [1000, 0],
          [1000, 300],
          [500, 300],
        ],
      },
    ],
    categoryGroups: [{ id: 'demo:catgroup:collect', name: 'Collectibles', order: 0 }],
    categories: [
      {
        id: 'demo:cat:herb',
        groupId: 'demo:catgroup:collect',
        name: 'Herb',
        icon: 'leaf',
        color: '#4caf50',
        trackable: true,
        defaultVisible: true,
      },
    ],
    locations: [
      {
        id: 'demo:loc:0001',
        mapId: 'demo:map:world',
        layerId: 'demo:layer:surface',
        x: 120,
        y: 80,
        categoryId: 'demo:cat:herb',
        regionId: 'demo:region:north',
        name: 'Moss herb',
        entityIds: ['demo:entity:moss'],
        guideId: 'demo:guide:herbs',
        since: '1.0.0',
      },
      {
        id: 'demo:loc:0002',
        mapId: 'demo:map:world',
        layerId: 'demo:layer:surface',
        x: 900,
        y: 500,
        categoryId: 'demo:cat:herb',
        regionId: null,
        name: 'Salt herb',
        entityIds: [],
        guideId: null,
        since: '1.0.0',
        flagId: 'herb_0002',
      },
    ],
    entities: [{ id: 'demo:entity:moss', name: 'Moss', kind: 'item' }],
    checklists: [{ id: 'demo:checklist:herbs', name: 'Herbs', order: 0 }],
    checklistItems: [
      {
        id: 'demo:checkitem:moss',
        checklistId: 'demo:checklist:herbs',
        name: 'Pick moss',
        order: 0,
        locationIds: ['demo:loc:0001'],
        entityIds: ['demo:entity:moss'],
      },
    ],
    guides: [
      {
        id: 'demo:guide:herbs',
        title: 'Herbs',
        body: 'Herbs grow near water.',
        locationIds: ['demo:loc:0001'],
      },
    ],
    links: [{ id: 'demo:link:1', fromId: 'demo:loc:0001', toId: 'demo:loc:0002', kind: 'portal' }],
    presets: [{ id: 'demo:preset:herbs', name: 'Herbs only', categoryIds: ['demo:cat:herb'] }],
  };
}
