import {
  newOwnId,
  newOwnType,
  newOwnTypeGroup,
  OWN_TYPE_COLOURS,
  putOwnType,
  sameTitleGames,
  groupOf,
  takenRecordIds,
  type PackEntry,
} from '@atlas/core';
import {
  floorAt,
  ICON_NAMES,
  MAX_OWN_NAME_LENGTH,
  pixelToWorld,
  worldToPixel,
  type Affine,
  type Category,
  type CategoryGroup,
  type GameGroup,
  type Layer,
  type Location,
  type MapDef,
  type OwnLocation,
  type OwnLocations,
  type PackData,
} from '@atlas/schema';

/**
 * "Take locations from another pack…" in Edit locations: the locations of
 * maps of another pack of the same game (one of the same title, or shown
 * with it under one title, see `gameGroups.ts`) put on the map shown, as
 * the person's own, by where they are in the game's world.
 *
 * A location's map pixel leads to its world x and y through its map's
 * `worldTransform`, and they lead back to a pixel of the map shown through
 * that map's own; so two packs that drew the same world at other scales or
 * offsets still line up. What lands off the map shown is left out and
 * said; what is there already (a location of the same name within a
 * couple of pixels) is left out too. On a 3D map each location gets the
 * height of the surface below it, cast down from just above its own height
 * where it has one (`scene/probe.ts`); one with no surface below it is
 * still added, without a height, and flagged in its note.
 *
 * Their types are this game's of the same name, or new types of the
 * person's own, named and coloured as the other pack's, in a group named
 * after it. Everything is added as one change, which one Undo takes back.
 */

/** Two locations of one name this near (in map pixels of the map shown) are the same one. */
export const SAME_SPOT_PX = 2;
/** How far above a location's own height the cast down onto the surface starts, in world units. */
export const CAST_ABOVE = 1.5;

/** The other packs of the game shown on this device: of the same title, or under one title with it. */
export function sameGameSources(
  catalog: readonly PackEntry[],
  groups: readonly GameGroup[],
  gameId: string,
): PackEntry[] {
  const group = groupOf(groups, gameId);
  const grouped = new Set(group?.members.map((member) => member.gameId) ?? []);
  const titled = new Set(sameTitleGames(catalog, gameId).map((entry) => entry.id));
  return catalog.filter(
    (entry) => entry.id !== gameId && (grouped.has(entry.id) || titled.has(entry.id)),
  );
}

/** A map pixel of one map at the same world x and y on another; null when that map's transform cannot be turned round. */
export function carryAcross(
  from: Affine,
  to: Affine,
  x: number,
  y: number,
): [number, number] | null {
  const [wx, wy] = pixelToWorld(from, x, y);
  return worldToPixel(to, wx, wy);
}

/** The map shown, as the locations are put on it. */
export interface TakeTarget {
  map: Pick<MapDef, 'id' | 'name' | 'width' | 'height' | 'worldTransform' | 'scene'>;
  /** Its levels, in order. */
  layers: readonly Layer[];
  /** Its floors, lowest first; empty without them. */
  floors: readonly Layer[];
  /** The level shown, when it is of this map. */
  shownLayer: string | null;
  /** Whether it has a model: the locations then get heights. */
  hasScene: boolean;
  /** The locations on it now, the game's and the person's own. */
  existing: readonly Pick<Location, 'name' | 'x' | 'y'>[];
}

/** A location of the other pack, where it lands on the map shown. */
export interface TakeCandidate {
  source: Location;
  /** The name of its map in the other pack. */
  mapName: string;
  /** The name of its level there. */
  layerName: string | null;
  /** On the map shown, rounded. */
  x: number;
  y: number;
}

/** What taking the locations of some maps would do, before anything is added. */
export interface TakePlan {
  /** Those that land on the map shown, and are not there yet. */
  inside: TakeCandidate[];
  /** Those that land off it. */
  outside: { source: Location; mapName: string }[];
  /** Those that are on it already. */
  already: { source: Location; mapName: string }[];
  /** The maps chosen that cannot be lined up: without a `worldTransform`. */
  unplaced: string[];
}

const nameKey = (name: string) => name.trim().toLocaleLowerCase();

/** Where the locations of the maps chosen (`mapIds`, of the other pack `source`) land on the map shown. */
export function planTake(
  source: Pick<PackData, 'maps' | 'layers' | 'locations'>,
  mapIds: readonly string[],
  target: TakeTarget,
): TakePlan {
  const plan: TakePlan = { inside: [], outside: [], already: [], unplaced: [] };
  const to = target.map.worldTransform;
  const chosen = new Set(mapIds);
  const maps = new Map(source.maps.filter((map) => chosen.has(map.id)).map((m) => [m.id, m]));
  for (const map of maps.values()) {
    if (!map.worldTransform || !to) plan.unplaced.push(map.name);
  }
  const layers = new Map(source.layers.map((layer) => [layer.id, layer.name]));
  const here = new Map<string, Pick<Location, 'x' | 'y'>[]>();
  for (const location of target.existing) {
    const key = nameKey(location.name);
    here.set(key, [...(here.get(key) ?? []), location]);
  }
  for (const location of source.locations) {
    const map = maps.get(location.mapId);
    if (!map?.worldTransform || !to) continue;
    const at = carryAcross(map.worldTransform, to, location.x, location.y);
    const entry = { source: location, mapName: map.name };
    if (!at || at[0] < 0 || at[1] < 0 || at[0] > target.map.width || at[1] > target.map.height) {
      plan.outside.push(entry);
      continue;
    }
    const x = Math.round(at[0]);
    const y = Math.round(at[1]);
    const same = here.get(nameKey(location.name)) ?? [];
    if (same.some((other) => Math.hypot(other.x - x, other.y - y) <= SAME_SPOT_PX)) {
      plan.already.push(entry);
      continue;
    }
    // Two of the same name on the same spot in the other pack are one here.
    here.set(nameKey(location.name), [...same, { x, y }]);
    plan.inside.push({ ...entry, layerName: layers.get(location.layerId) ?? null, x, y });
  }
  return plan;
}

/** Where a cast down onto the model starts for a location: just above its own height, or from the top (null). */
export function castFrom(location: Pick<Location, 'height'>): number | null {
  return location.height === undefined ? null : location.height + CAST_ABOVE;
}

/** A location ready to be added: where, at which height, on which level, and whether it is flagged. */
export interface TakeReady {
  candidate: TakeCandidate;
  layerId: string;
  /** On a map with a model: the surface's height below it, or its own where there was none. */
  height?: number | undefined;
  /** On a map with a model, nothing was found below it. */
  noSurface: boolean;
}

/**
 * The level and height of each location that lands on the map shown.
 * `heights` are the surface's below each (null: none), on a map with a
 * model; null for a map without one, whose locations get no height. On a
 * map with floors, the level is the floor of its height; else the level of
 * the same name as its own, else the level shown, else the first.
 */
export function readyToTake(
  plan: Pick<TakePlan, 'inside'>,
  target: Pick<TakeTarget, 'layers' | 'floors' | 'shownLayer' | 'hasScene'>,
  heights: readonly (number | null)[] | null,
): TakeReady[] {
  const fallback =
    target.layers.find((layer) => layer.id === target.shownLayer)?.id ?? target.layers[0]?.id;
  if (!fallback) return [];
  return plan.inside.map((candidate, i) => {
    const surface = target.hasScene && heights ? (heights[i] ?? null) : null;
    const noSurface = target.hasScene && heights !== null && surface === null;
    const height = target.hasScene ? (surface ?? candidate.source.height ?? undefined) : undefined;
    const floor = height !== undefined ? floorAt(target.floors, height) : undefined;
    const named = target.layers.find(
      (layer) =>
        candidate.layerName !== null && nameKey(layer.name) === nameKey(candidate.layerName),
    );
    return {
      candidate,
      layerId: floor?.id ?? named?.id ?? fallback,
      ...(height !== undefined ? { height: Math.round(height * 100) / 100 } : {}),
      noSurface,
    };
  });
}

/** The note of a location taken with no surface below it. */
export function noSurfaceNote(packTitle: string): string {
  return `No surface was found below this location when it was taken from “${packTitle}”, so it has no height of its own: check where it is.`;
}

const COLOUR = /^#[0-9a-fA-F]{6}$/;

/**
 * The person's own records with the locations added, and the types they
 * need made: the game's type of the same name where there is one, else a
 * new type of the person's own, as the other pack's, in a group named after
 * it (`packTitle`).
 */
export function takeIntoOwn(input: {
  gameId: string;
  /** The game's pack data, without the person's own records. */
  data: PackData;
  own: OwnLocations;
  mapId: string;
  ready: readonly TakeReady[];
  /** The other pack's types and groups. */
  sourceTypes: readonly Category[];
  packTitle: string;
  now: Date;
}): { own: OwnLocations; types: number } {
  const { gameId, data, mapId, ready, packTitle, now } = input;
  let own = input.own;
  const byName = new Map<string, string>();
  for (const type of [...data.categories, ...own.categories]) {
    if (!byName.has(nameKey(type.name))) byName.set(nameKey(type.name), type.id);
  }
  const sourceTypes = new Map(input.sourceTypes.map((type) => [type.id, type]));
  const made = new Map<string, string>();
  let group: CategoryGroup | null = null;
  const typeFor = (sourceId: string): string => {
    const kept = made.get(sourceId);
    if (kept) return kept;
    const type = sourceTypes.get(sourceId);
    const named = type ? byName.get(nameKey(type.name)) : undefined;
    if (named) {
      made.set(sourceId, named);
      return named;
    }
    group ??= newOwnTypeGroup(gameId, `From ${packTitle}`.slice(0, MAX_OWN_NAME_LENGTH), data, own);
    const fresh = newOwnType(
      gameId,
      {
        name: (type?.name ?? 'Location').slice(0, MAX_OWN_NAME_LENGTH),
        color: type && COLOUR.test(type.color) ? type.color : OWN_TYPE_COLOURS[0],
        icon: type && (ICON_NAMES as readonly string[]).includes(type.icon) ? type.icon : 'pin',
        groupId: group.id,
      },
      data,
      own,
    );
    own = putOwnType(own, fresh, group);
    byName.set(nameKey(fresh.name), fresh.id);
    made.set(sourceId, fresh.id);
    return fresh.id;
  };
  const before = own.categories.length;
  const types = ready.map((item) => typeFor(item.candidate.source.categoryId));
  const time = now.toISOString();
  const taken = takenRecordIds(data, own);
  const locations: OwnLocation[] = [];
  for (const [i, item] of ready.entries()) {
    const { candidate } = item;
    const id = newOwnId(gameId, 'loc', taken);
    taken.add(id);
    locations.push({
      id,
      mapId,
      layerId: item.layerId,
      x: candidate.x,
      y: candidate.y,
      categoryId: types[i]!,
      regionId: null,
      name: candidate.source.name.trim().slice(0, MAX_OWN_NAME_LENGTH) || 'Location',
      ...(item.height !== undefined ? { height: item.height } : {}),
      ...(item.noSurface ? { note: noSurfaceNote(packTitle) } : {}),
      createdAt: time,
      updatedAt: time,
    });
  }
  return {
    own: { ...own, locations: [...own.locations, ...locations] },
    types: own.categories.length - before,
  };
}
