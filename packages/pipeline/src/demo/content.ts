import { pointInPolygon, pyramidMaxZoom } from '@atlas/core';
import {
  SCHEMA_VERSION,
  makeId,
  type Category,
  type CategoryGroup,
  type ChecklistItem,
  type Entity,
  type Link,
  type Location,
  type PackData,
  type Region,
  type TileSource,
} from '@atlas/schema';
import { rectangle, voronoiCells } from '../geometry/voronoi';
import { createRandom, deriveSeed, pick, type Random } from '../random';
import { elevationAt, moistureAt, type Terrain } from './terrain';

export const DEMO_GAME_ID = 'demo';
const PACK_VERSION = '1.0.0';
const id = (kind: Parameters<typeof makeId>[1], local: string) => makeId(DEMO_GAME_ID, kind, local);

export interface DemoContentOptions {
  seed: number;
  /** Edge length of the square map image. */
  size: number;
  tileSize: number;
  locationCount: number;
  tiles: TileSource;
}

/** A demo region: every one has an outline. */
export type DemoRegion = Region & { polygon: [number, number][] };

/**
 * Region layout: two top-level halves, each split into Voronoi cells. The
 * cells have a centre, their Voronoi site; the halves have none, so the app
 * goes to the middle of their outline.
 */
export interface DemoRegionLayout {
  regions: DemoRegion[];
  /** Sites of the child regions, grouped by parent half (west, east). */
  sites: [number, number][][];
  /** x of the border between the two halves. */
  divide: number;
}

const PARENT_REGIONS = [
  { local: 'westreach', name: 'Westreach' },
  { local: 'eastreach', name: 'Eastreach' },
] as const;

const CHILD_REGION_NAMES = [
  ['Emberfall Vale', 'Saltmarsh Wilds', 'Greywater Basin', 'Thornwood'],
  ['Highcrown Peaks', 'Duskmoor', 'Glimmer Coast', 'Lanternfield'],
] as const;

interface CategorySpec {
  local: string;
  group: string;
  name: string;
  icon: string;
  color: string;
  trackable: boolean;
  defaultVisible: boolean;
  /** Share of all locations. */
  share: number;
  /** Whether a spot suits this category, given elevation and moisture there. */
  suits: (elevation: number, moisture: number) => boolean;
  names: readonly string[];
}

const GROUPS: CategoryGroup[] = [
  { id: id('catgroup', 'collectibles'), name: 'Collectibles', order: 0 },
  { id: id('catgroup', 'places'), name: 'Points of interest', order: 1 },
  { id: id('catgroup', 'creatures'), name: 'Creatures', order: 2 },
];

const LAND = 0.012;

const CATEGORIES: CategorySpec[] = [
  {
    local: 'herb',
    group: 'collectibles',
    name: 'Wild herb',
    icon: 'leaf',
    color: '#5cc96b',
    trackable: true,
    defaultVisible: true,
    share: 0.3,
    suits: (e, m) => e > LAND && e < 0.3 && m > 0.4,
    names: ['Moonpetal', 'Ashroot', 'Brightmoss', 'Saltleaf', 'Duskbloom'],
  },
  {
    local: 'relic',
    group: 'collectibles',
    name: 'Relic shard',
    icon: 'gem',
    color: '#e6b450',
    trackable: true,
    defaultVisible: true,
    share: 0.18,
    suits: (e) => e > LAND,
    names: ['Relic shard'],
  },
  {
    local: 'chest',
    group: 'collectibles',
    name: 'Treasure chest',
    icon: 'chest',
    color: '#e08a3c',
    trackable: true,
    defaultVisible: true,
    share: 0.16,
    suits: (e) => e > -0.06,
    names: ['Weathered chest', 'Iron-bound chest', 'Gilded chest'],
  },
  {
    local: 'tablet',
    group: 'collectibles',
    name: 'Lore tablet',
    icon: 'scroll',
    color: '#b393f0',
    trackable: true,
    defaultVisible: true,
    share: 0.06,
    suits: (e) => e > 0.05,
    names: ['Lore tablet'],
  },
  {
    local: 'waystone',
    group: 'places',
    name: 'Waystone',
    icon: 'star',
    color: '#4fc3f7',
    trackable: true,
    defaultVisible: true,
    share: 0.024,
    suits: (e) => e > LAND && e < 0.45,
    names: ['Waystone'],
  },
  {
    local: 'camp',
    group: 'places',
    name: 'Camp',
    icon: 'flame',
    color: '#ff7a59',
    trackable: false,
    defaultVisible: true,
    share: 0.036,
    suits: (e) => e > LAND && e < 0.3,
    names: ["Hunters' camp", 'Bandit camp', 'Pilgrim rest'],
  },
  {
    local: 'ruin',
    group: 'places',
    name: 'Ruin',
    icon: 'tower',
    color: '#c3ccd6',
    trackable: false,
    defaultVisible: true,
    share: 0.04,
    suits: (e) => e > LAND,
    names: ['Fallen watchtower', 'Sunken shrine', 'Old mill', 'Broken aqueduct'],
  },
  {
    local: 'cavemouth',
    group: 'places',
    name: 'Cave entrance',
    icon: 'cave',
    color: '#8fb3c9',
    trackable: false,
    defaultVisible: true,
    share: 0.004,
    suits: (e) => e > 0.2 && e < 0.5,
    names: ['Cave entrance'],
  },
  {
    local: 'door',
    group: 'places',
    name: 'Sealed door',
    icon: 'door',
    color: '#a7a0c8',
    trackable: false,
    defaultVisible: true,
    share: 0,
    suits: (e) => e > LAND,
    names: ['Sealed door'],
  },
  {
    local: 'key',
    group: 'collectibles',
    name: 'Old key',
    icon: 'key',
    color: '#7fd1c0',
    trackable: true,
    defaultVisible: true,
    share: 0,
    suits: (e) => e > LAND,
    names: ['Rusted key', 'Bone key', 'Glass key'],
  },
  {
    local: 'den',
    group: 'creatures',
    name: 'Beast den',
    icon: 'paw',
    color: '#d0694f',
    trackable: true,
    defaultVisible: true,
    share: 0.12,
    suits: (e) => e > 0.08 && e < 0.5,
    names: ['Wolf den', 'Boar hollow', 'Spider nest', 'Drake roost'],
  },
  {
    local: 'elite',
    group: 'creatures',
    name: 'Elite foe',
    icon: 'skull',
    color: '#ff4f7b',
    trackable: true,
    defaultVisible: true,
    share: 0.08,
    suits: (e) => e > 0.28,
    names: ['Stone warden', 'Ashen knight', 'Frost wyrm', 'Hollow king'],
  },
];

/** Splits `total` across shares so that the parts add up exactly. */
function apportion(total: number, shares: readonly number[]): number[] {
  const sum = shares.reduce((a, b) => a + b, 0);
  const exact = shares.map((s) => (s / sum) * total);
  const counts = exact.map(Math.floor);
  let remaining = total - counts.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of byRemainder) {
    if (remaining-- <= 0) break;
    counts[index]!++;
  }
  return counts;
}

/** A random land point, or any point inside `bounds` if land is hard to find. */
function samplePoint(
  random: Random,
  terrain: Terrain,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  accept: (x: number, y: number) => boolean,
): [number, number] {
  let fallback: [number, number] | null = null;
  for (let attempt = 0; attempt < 2000; attempt++) {
    const x = Math.round(bounds.minX + random() * (bounds.maxX - bounds.minX));
    const y = Math.round(bounds.minY + random() * (bounds.maxY - bounds.minY));
    if (accept(x, y)) return [x, y];
    if (!fallback && elevationAt(terrain, x, y) > LAND) fallback = [x, y];
  }
  if (fallback) return fallback;
  throw new Error('could not place a point on land');
}

/** Lays out the demo regions over the terrain. */
export function layoutRegions(seed: number, terrain: Terrain): DemoRegionLayout {
  const random = createRandom(deriveSeed(seed, 'regions'));
  const { size } = terrain;
  const divide = Math.round(size / 2);
  const halves = [rectangle(0, 0, divide, size), rectangle(divide, 0, size, size)];
  const regions: DemoRegion[] = [];
  const sites: [number, number][][] = [];

  halves.forEach((half, h) => {
    const parent = PARENT_REGIONS[h]!;
    const parentId = id('region', parent.local);
    regions.push({
      id: parentId,
      mapId: id('map', 'world'),
      parentId: null,
      name: parent.name,
      polygon: half,
    });
    const minX = half[0]![0];
    const maxX = half[1]![0];
    const inset = size * 0.05;
    const siteBounds = {
      minX: minX + inset,
      minY: size * 0.1,
      maxX: maxX - inset,
      maxY: size * 0.9,
    };
    const halfSites: [number, number][] = [];
    for (const _name of CHILD_REGION_NAMES[h]!) {
      halfSites.push(
        samplePoint(
          random,
          terrain,
          siteBounds,
          (x, y) =>
            elevationAt(terrain, x, y) > 0.05 &&
            halfSites.every(([sx, sy]) => Math.hypot(sx - x, sy - y) > size / 6),
        ),
      );
    }
    sites.push(halfSites);
    voronoiCells(halfSites, half).forEach((cell, i) => {
      const name = CHILD_REGION_NAMES[h]![i]!;
      regions.push({
        id: id('region', name.toLowerCase().replace(/[^a-z]+/g, '-')),
        mapId: id('map', 'world'),
        parentId,
        name,
        polygon: cell.map(([x, y]) => [Math.round(x), Math.round(y)] as [number, number]),
        center: [...halfSites[i]!],
      });
    });
  });
  return { regions, sites, divide };
}

/** The innermost region containing a point, or null. */
function regionOf(regions: readonly DemoRegion[], x: number, y: number): DemoRegion | null {
  let found: DemoRegion | null = null;
  for (const region of regions) {
    if (pointInPolygon({ x, y }, region.polygon)) {
      if (!found || region.parentId === found.id) found = region;
    }
  }
  return found;
}

/** Generates the full demo pack data, deterministically for a given seed. */
export function generateDemoContent(
  terrain: Terrain,
  layout: DemoRegionLayout,
  options: DemoContentOptions,
): PackData {
  const { size, tileSize, locationCount } = options;
  const random = createRandom(deriveSeed(options.seed, 'locations'));
  const mapId = id('map', 'world');
  const layerId = id('layer', 'surface');
  const { regions } = layout;

  const categories: Category[] = CATEGORIES.map((spec) => ({
    id: id('cat', spec.local),
    groupId: id('catgroup', spec.group),
    name: spec.name,
    icon: spec.icon,
    color: spec.color,
    trackable: spec.trackable,
    defaultVisible: spec.defaultVisible,
  }));

  const herbSpec = CATEGORIES.find((c) => c.local === 'herb')!;
  const eliteSpec = CATEGORIES.find((c) => c.local === 'elite')!;
  const entities: Entity[] = [
    ...herbSpec.names.map((name) => ({
      id: id('entity', name.toLowerCase()),
      name,
      kind: 'item',
      description: `A wild herb found in damp lowland.`,
    })),
    ...eliteSpec.names.map((name) => ({
      id: id('entity', name.toLowerCase().replace(/ /g, '-')),
      name,
      kind: 'enemy',
    })),
  ];
  const entityByName = new Map(entities.map((e) => [e.name, e.id]));

  const guides = [
    {
      id: id('guide', 'herbs'),
      title: 'Gathering herbs',
      body: [
        'Herbs grow in **damp lowland**, mostly near rivers and lakes.',
        '',
        '- Each plant regrows after a short while, so a route can be walked again.',
        '- Moonpetal only opens at night.',
        '',
        'Mark a herb found once you have picked it; the counter in the top bar keeps the total.',
      ].join('\n'),
      locationIds: [] as string[],
    },
    {
      id: id('guide', 'elites'),
      title: 'Elite foes',
      body: [
        'Elite foes guard the **high ground** and the deepest galleries.',
        '',
        '1. Clear the camp around them first.',
        '2. Bring a full party and something to cure frostbite.',
        '',
        '> They do not return once defeated.',
      ].join('\n'),
      locationIds: [] as string[],
    },
  ];

  const counts = apportion(
    locationCount,
    CATEGORIES.map((c) => c.share),
  );
  const margin = 64;
  const bounds = { minX: margin, minY: margin, maxX: size - margin, maxY: size - margin };
  const locations: Location[] = [];
  const waystones: Location[] = [];
  const minWaystoneSpacing = size / 40;

  CATEGORIES.forEach((spec, c) => {
    const nameCounters = new Map<string, number>();
    for (let n = 0; n < counts[c]!; n++) {
      const [x, y] = samplePoint(random, terrain, bounds, (px, py) => {
        if (!spec.suits(elevationAt(terrain, px, py), moistureAt(terrain, px, py))) return false;
        return (
          spec.local !== 'waystone' ||
          waystones.every((w) => Math.hypot(w.x - px, w.y - py) > minWaystoneSpacing)
        );
      });
      const variant = pick(random, spec.names);
      const index = (nameCounters.get(variant) ?? 0) + 1;
      nameCounters.set(variant, index);
      const region = regionOf(regions, x, y);
      const local = String(locations.length + 1).padStart(4, '0');
      const location: Location = {
        id: id('loc', local),
        mapId,
        layerId,
        x,
        y,
        categoryId: id('cat', spec.local),
        regionId: region?.id ?? null,
        name:
          spec.local === 'waystone' && region
            ? `${region.name} waystone ${index}`
            : `${variant} ${index}`,
        entityIds: entityByName.has(variant) ? [entityByName.get(variant)!] : [],
        guideId:
          spec.local === 'herb'
            ? id('guide', 'herbs')
            : spec.local === 'elite'
              ? id('guide', 'elites')
              : null,
        since: PACK_VERSION,
        ...(spec.trackable && spec.local === 'chest' ? { flagId: `chest_${local}` } : {}),
      };
      locations.push(location);
      if (spec.local === 'waystone') waystones.push(location);
    }
  });

  guides[1]!.locationIds = locations
    .filter((l) => l.guideId === id('guide', 'elites'))
    .slice(0, 10)
    .map((l) => l.id);
  guides[0]!.locationIds = locations
    .filter((l) => l.guideId === id('guide', 'herbs'))
    .slice(0, 10)
    .map((l) => l.id);

  const checklistItems: ChecklistItem[] = waystones.map((w, order) => ({
    id: id('checkitem', `waystone-${order + 1}`),
    checklistId: id('checklist', 'waystones'),
    name: `Attune ${w.name}`,
    order,
    locationIds: [w.id],
    entityIds: [],
  }));

  // Pair each waystone with its nearest neighbour as a two-way portal network.
  const links: Link[] = [];
  waystones.forEach((w, i) => {
    let nearest: Location | undefined;
    let best = Infinity;
    for (const other of waystones) {
      const d = Math.hypot(other.x - w.x, other.y - w.y);
      if (other !== w && d < best) {
        best = d;
        nearest = other;
      }
    }
    if (nearest) {
      links.push({
        id: id('link', `portal-${i + 1}`),
        fromId: w.id,
        toId: nearest.id,
        kind: 'portal',
      });
    }
  });

  const maxZoom = pyramidMaxZoom(size, size, tileSize);
  return {
    manifest: {
      schemaVersion: SCHEMA_VERSION,
      gameId: DEMO_GAME_ID,
      title: 'Atlas demo world',
      packVersion: PACK_VERSION,
      gamePatch: '1.0',
      attribution: [{ name: 'Procedurally generated by the Atlas pipeline' }],
      idMigrations: {},
    },
    maps: [
      {
        id: mapId,
        name: 'The Sundered Isle',
        width: size,
        height: size,
        // World units: origin at the image centre, y up, 4 pixels per unit.
        worldTransform: { a: 0.25, b: 0, c: 0, d: -0.25, e: -size / 8, f: size / 8 },
      },
    ],
    layers: [
      {
        id: layerId,
        mapId,
        name: 'Surface',
        tiles: options.tiles,
        minZoom: 0,
        maxZoom,
        tileSize,
      },
    ],
    regions,
    categoryGroups: GROUPS,
    categories,
    locations,
    entities,
    checklists: [{ id: id('checklist', 'waystones'), name: 'Waystones', order: 0 }],
    checklistItems,
    guides,
    links,
    presets: [
      {
        id: id('preset', 'collector'),
        name: 'Collector',
        categoryIds: ['herb', 'relic', 'chest', 'tablet', 'key'].map((c) => id('cat', c)),
      },
      {
        id: id('preset', 'explorer'),
        name: 'Explorer',
        categoryIds: ['waystone', 'camp', 'ruin', 'cavemouth', 'door'].map((c) => id('cat', c)),
      },
      {
        id: id('preset', 'hunter'),
        name: 'Hunter',
        categoryIds: ['den', 'elite'].map((c) => id('cat', c)),
      },
    ],
  };
}

/**
 * Returns how strongly a pixel lies on a region border, from 0 to 1, for
 * drawing borders into the map image. Borders are dashed; the border between
 * the two halves is wider than those between their sub-regions.
 */
export function regionBorderStrength(layout: DemoRegionLayout): (x: number, y: number) => number {
  const { sites, divide } = layout;
  return (x, y) => {
    const dash = (x + y) % 48 < 30;
    if (!dash) return 0;
    if (Math.abs(x - divide) < 5) return 1;
    const halfSites = sites[x < divide ? 0 : 1]!;
    let first = -1;
    let second = -1;
    let d1 = Infinity;
    let d2 = Infinity;
    for (let i = 0; i < halfSites.length; i++) {
      const [sx, sy] = halfSites[i]!;
      const d = (sx - x) * (sx - x) + (sy - y) * (sy - y);
      if (d < d1) {
        d2 = d1;
        second = first;
        d1 = d;
        first = i;
      } else if (d < d2) {
        d2 = d;
        second = i;
      }
    }
    if (second < 0) return 0;
    const [ax, ay] = halfSites[first]!;
    const [bx, by] = halfSites[second]!;
    // Distance from the pixel to the bisector of its two nearest sites.
    const distance = (d2 - d1) / (2 * Math.hypot(bx - ax, by - ay));
    return distance < 3 ? 0.75 : 0;
  };
}
