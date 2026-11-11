// @ts-check
/**
 * A small test pack whose map images are not in the pack but on a local
 * mock tile server (`tileServer.js`), for the desktop download test. Its
 * markers sit on dots that the mock server paints into the tiles, so a
 * screenshot shows whether downloaded tiles line up with the markers.
 *
 *   node apps/desktop/e2e/remotePack.js [port]
 *
 * writes the pack to `packs/e2e-remote/` (ignored by git), pointing at
 * `http://127.0.0.1:<port>/` (default 4431, or ATLAS_E2E_TILE_PORT). Build
 * the desktop app with `ATLAS_BUNDLE_PACKS=e2e-remote,demo` to bundle it as
 * the default game.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const PACK_ID = 'e2e-remote';
export const DEFAULT_PORT = 4431;

/**
 * @typedef {{ z: number, sourceZ: number, offsetX: number, offsetY: number }} RemoteLevel
 * @typedef {{ id: string, name: string, x: number, y: number }} Beacon
 * @typedef {{ slug: string, name: string, width: number, height: number, minZoom: number,
 *   maxZoom: number, levels: RemoteLevel[], beacons: Beacon[] }} TestMap
 */

/** @type {TestMap[]} */
export const MAPS = [
  {
    slug: 'island',
    name: 'Test island',
    width: 2048,
    height: 1536,
    minZoom: 0,
    maxZoom: 3,
    // Levels 0 and 1 are built from level 2.
    levels: [
      { z: 2, sourceZ: 12, offsetX: 100, offsetY: 200 },
      { z: 3, sourceZ: 13, offsetX: 200, offsetY: 400 },
    ],
    beacons: [
      { id: 'centre', name: 'Centre beacon', x: 1024, y: 768 },
      { id: 'north-west', name: 'North-west beacon', x: 300, y: 200 },
      { id: 'north-east', name: 'North-east beacon', x: 1500, y: 400 },
      { id: 'south-west', name: 'South-west beacon', x: 500, y: 1200 },
      { id: 'south-east', name: 'South-east beacon', x: 1700, y: 1300 },
    ],
  },
  {
    slug: 'cave',
    name: 'Test cave',
    width: 1024,
    height: 1024,
    minZoom: 0,
    maxZoom: 2,
    levels: [{ z: 2, sourceZ: 8, offsetX: 3, offsetY: 5 }],
    beacons: [
      { id: 'cave', name: 'Cave beacon', x: 512, y: 512 },
      { id: 'deep', name: 'Deep beacon', x: 180, y: 820 },
    ],
  },
];

/** The island tile the mock server answers with 404, as an empty area would. */
export const MISSING_TILE = { map: 'island', z: 3, x: 7, y: 5 };

/**
 * The island tile (top-right corner of level 2) that the mock server, when
 * asked to, answers like an object store that lets nobody list it answers
 * for an image that does not exist: 403 with an `AccessDenied` XML error.
 * The four level 3 tiles under it are then never asked for.
 */
export const STORE_MISSING_TILE = { map: 'island', z: 2, x: 3, y: 0 };

/** Columns and rows of a level, as `pyramidLevel` in `@atlas/core` works them out. */
export function levelGrid(/** @type {TestMap} */ map, /** @type {number} */ z) {
  const scale = 2 ** (z - map.maxZoom);
  return {
    columns: Math.ceil(Math.max(1, Math.ceil(map.width * scale)) / 256),
    rows: Math.ceil(Math.max(1, Math.ceil(map.height * scale)) / 256),
  };
}

/** Remote tiles up to `top` (every listed level when absent). */
export function remoteTileCount(/** @type {TestMap} */ map, top = map.maxZoom) {
  return map.levels
    .filter((level) => level.z <= top)
    .reduce((sum, level) => {
      const grid = levelGrid(map, level.z);
      return sum + grid.columns * grid.rows;
    }, 0);
}

const id = (/** @type {string} */ kind, /** @type {string} */ local) =>
  `${PACK_ID}:${kind}:${local}`;

/** The pack's files, by name. */
export function packFiles(port = DEFAULT_PORT) {
  return {
    'manifest.json': {
      schemaVersion: 1,
      gameId: PACK_ID,
      title: 'Remote tiles test',
      packVersion: '1.0.0',
      gamePatch: 'test',
      attribution: [{ name: 'Atlas test tiles' }],
      idMigrations: {},
    },
    'maps.json': MAPS.map((map) => ({
      id: id('map', map.slug),
      name: map.name,
      width: map.width,
      height: map.height,
    })),
    'layers.json': MAPS.map((map) => ({
      id: id('layer', map.slug),
      mapId: id('map', map.slug),
      name: 'Surface',
      tiles: {
        type: 'xyz',
        url: `tiles/${map.slug}/{z}/{x}/{y}.png`,
        remote: {
          urlTemplate: `http://127.0.0.1:${port}/${map.slug}/{z}/{x}/{y}.png`,
          levels: map.levels,
        },
      },
      minZoom: map.minZoom,
      maxZoom: map.maxZoom,
      tileSize: 256,
    })),
    'categoryGroups.json': [{ id: id('catgroup', 'marks'), name: 'Marks', order: 0 }],
    'categories.json': [
      {
        id: id('cat', 'beacon'),
        groupId: id('catgroup', 'marks'),
        name: 'Beacon',
        icon: 'star',
        color: '#ffd166',
        trackable: true,
        defaultVisible: true,
      },
    ],
    'locations.json': MAPS.flatMap((map) =>
      map.beacons.map((beacon) => ({
        id: id('loc', beacon.id),
        mapId: id('map', map.slug),
        layerId: id('layer', map.slug),
        x: beacon.x,
        y: beacon.y,
        categoryId: id('cat', 'beacon'),
        regionId: null,
        name: beacon.name,
        entityIds: [],
        guideId: beacon.id === 'centre' ? id('guide', 'beacons') : null,
        since: '1.0.0',
      })),
    ),
    'guides.json': [
      {
        id: id('guide', 'beacons'),
        title: 'Beacons',
        body: 'Each beacon sits on a pink dot in the map image. [About beacons](https://example.com/atlas-e2e-guide)',
        locationIds: [id('loc', 'centre')],
      },
    ],
  };
}

/** Writes the pack into `dir`, replacing what is there. */
export async function writeRemotePack(/** @type {string} */ dir, port = DEFAULT_PORT) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(packFiles(port))) {
    await writeFile(`${dir}/${name}`, `${JSON.stringify(content, null, 2)}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.ATLAS_E2E_TILE_PORT ?? DEFAULT_PORT);
  const dir = fileURLToPath(new URL(`../../../packs/${PACK_ID}`, import.meta.url));
  await writeRemotePack(dir, port);
  console.log(`Wrote ${dir} for tiles at http://127.0.0.1:${port}/`);
}
