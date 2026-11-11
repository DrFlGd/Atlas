import type { PinKindRule, SaveTuning } from '../reader';
import type { SavePin, SaveSummary } from '../summary';
import { autoCalibrate, KindGrid, type AutoCalibration, type KindPoint } from './calibrate';
import {
  affineScale,
  applyAffine,
  applyLinear,
  distance,
  invertAffine,
  type Affine,
  type Point2,
} from './transform';
import { mapForWorld, type WorldMapSource } from './worlds';

/**
 * Matching a read save against a loaded pack: where the player is on which
 * map, and which places the save shows as done.
 */

/** The parts of a pack the matcher reads. */
export interface PackForMatching {
  maps: readonly {
    id: string;
    name: string;
    width: number;
    height: number;
    /** Map pixels to world coordinates, when the pack knows it. */
    worldTransform?: Affine | undefined;
  }[];
  categories: readonly { id: string; name: string; trackable: boolean }[];
  locations: readonly {
    id: string;
    mapId: string;
    x: number;
    y: number;
    categoryId: string;
    flagId?: string | undefined;
  }[];
}

/** How a map was lined up with its world. */
export type CalibrationSource = 'pack' | 'manual' | 'auto';

/** A world-to-pixel transform kept for a map, with how it was made. */
export interface MapCalibration {
  source: 'manual' | 'auto';
  /** World coordinates to map pixels. */
  transform: Affine;
  /** For `manual`: the points the person marked. */
  points?: { world: Point2; pixel: Point2 }[];
  /** For `auto`: how well the pins fit. */
  fit?: { inliers: number; candidates: number; rms: number };
  /** When it was made, in milliseconds since the epoch. */
  at: number;
}

export interface MatchInput {
  summary: SaveSummary;
  pack: PackForMatching;
  tuning: SaveTuning;
  /** The person's choices of map per world id (null: no map). */
  worldMaps: Readonly<Record<string, string | null>>;
  /** Calibrations kept on this device, by map id. */
  calibrations: Readonly<Record<string, MapCalibration>>;
  /** Try to line maps up from the save's pins when nothing else does. Default true. */
  autoCalibrate?: boolean;
  now?: number;
}

export interface WorldMatch {
  worldId: string;
  name: string;
  mapId: string | null;
  mapSource: WorldMapSource;
  /** How world coordinates become pixels on that map; null when they cannot yet. */
  calibration: CalibrationSource | null;
}

export interface MatchedLocation {
  locationId: string;
  /** The pin kind, or `flag` for a match by the location's `flagId`. */
  kind: string;
  /** Why it matched, in plain words. */
  reason: string;
}

export interface CategoryCount {
  categoryId: string;
  kind: string;
  /** Places of this category the save marks found. */
  matched: number;
}

/** Done pins that did not become a found place, counted by kind and reason. */
export interface Unmatched {
  kind: string;
  label: string;
  reason: 'no-category' | 'no-place-nearby' | 'no-position' | 'no-map' | 'not-lined-up';
  count: number;
}

export interface PlayerOnMap {
  mapId: string;
  x: number;
  y: number;
  /** Facing on the map, in degrees clockwise from up; null when unknown. */
  heading: number | null;
  /** The point lies inside the map image. */
  onMap: boolean;
}

/**
 * Why a save marks nothing:
 * - `no-map`: the save's map could not be read;
 * - `nothing-done`: the save has not discovered or cleared any place yet
 *   (a new game);
 * - `no-tag-table`: the save names its discovered or cleared places by the
 *   game's tags alone, without positions, and no place of the pack names
 *   them; telling which places they are needs a table of where each tag is
 *   (in the game's own files), which Atlas does not have.
 */
export type NothingReason = 'no-map' | 'nothing-done' | 'no-tag-table';

export interface SaveMatch {
  /** The world the player is in, with its map. */
  current: WorldMatch | null;
  /** Every world with pins or the player, with its map. */
  worlds: WorldMatch[];
  player: PlayerOnMap | null;
  /** Places to mark found. */
  found: MatchedLocation[];
  categories: CategoryCount[];
  unmatched: Unmatched[];
  /** New automatic calibrations made now, by map id, for the caller to keep. */
  calibrated: Record<string, MapCalibration>;
  /** The current world has a map that cannot be lined up yet: ask the person to mark points. */
  needsCalibration: boolean;
  /**
   * Pins the save shows discovered or cleared that it names by tag alone,
   * with no position, and that no place of the pack names by its `flagId`.
   */
  unplaced: number;
  /** Why nothing is found, when nothing is; null when something is, or when `unmatched` says why. */
  nothingBecause: NothingReason | null;
}

/** The pin kind of each category whose name holds one of a kind's keywords. */
export function categoryKinds(
  categories: readonly { id: string; name: string }[],
  rules: readonly PinKindRule[],
): Map<string, string> {
  const kinds = new Map<string, string>();
  for (const category of categories) {
    const name = category.name.toLowerCase().replace(/[’`]/g, "'");
    const rule = rules.find((r) => r.categoryKeywords.some((keyword) => name.includes(keyword)));
    if (rule) kinds.set(category.id, rule.kind);
  }
  return kinds;
}

/** Whether a pin is in the state that makes its place found. */
export function pinIsDone(pin: SavePin, rule: PinKindRule): boolean {
  if (pin.cleared) return true;
  return rule.foundWhen === 'discovered' && pin.discovered === true;
}

/** World to pixels for a map: the person's points, the pack's own transform, or an automatic fit. */
export function transformFor(
  map: PackForMatching['maps'][number],
  calibrations: Readonly<Record<string, MapCalibration>>,
): { transform: Affine; source: CalibrationSource } | null {
  const kept = calibrations[map.id];
  if (kept?.source === 'manual') return { transform: kept.transform, source: 'manual' };
  if (map.worldTransform) {
    const inverse = invertAffine(map.worldTransform);
    if (inverse) return { transform: inverse, source: 'pack' };
  }
  if (kept) return { transform: kept.transform, source: 'auto' };
  return null;
}

export function matchSave(input: MatchInput): SaveMatch {
  const { summary, pack, tuning } = input;
  const rules = new Map(tuning.pinKinds.map((rule) => [rule.kind, rule]));
  const kindOfCategory = categoryKinds(pack.categories, tuning.pinKinds);
  const trackable = new Set(pack.categories.filter((c) => c.trackable).map((c) => c.id));
  const mapsById = new Map(pack.maps.map((map) => [map.id, map]));
  const calibrations: Record<string, MapCalibration> = { ...input.calibrations };
  const calibrated: Record<string, MapCalibration> = {};

  const worldIds = new Set<string>();
  if (summary.world) worldIds.add(summary.world.id);
  for (const pin of summary.pins) if (pin.world) worldIds.add(pin.world);
  const nameOf = (id: string) =>
    summary.worlds.find((w) => w.id === id)?.name ??
    tuning.worlds.find((w) => w.id === id)?.name ??
    id;

  // Lines a world up with its map, automatically from pins when it has to.
  const worlds = new Map<string, WorldMatch & { transform: Affine | null }>();
  for (const worldId of worldIds) {
    const { mapId, source } = mapForWorld(worldId, pack.maps, tuning.worlds, input.worldMaps);
    const map = mapId ? mapsById.get(mapId) : undefined;
    let found = map ? transformFor(map, calibrations) : null;
    if (map && (!found || found.source === 'auto') && input.autoCalibrate !== false) {
      const auto = calibrateFromPins(summary.pins, worldId, map, pack, kindOfCategory, tuning);
      if (auto) {
        const calibration: MapCalibration = {
          source: 'auto',
          transform: auto.transform,
          fit: { inliers: auto.inliers, candidates: auto.candidates, rms: auto.rms },
          at: input.now ?? Date.now(),
        };
        calibrated[map.id] = calibration;
        calibrations[map.id] = calibration;
        found = { transform: auto.transform, source: 'auto' };
      }
    }
    worlds.set(worldId, {
      worldId,
      name: nameOf(worldId),
      mapId: mapId ?? null,
      mapSource: source,
      calibration: found?.source ?? null,
      transform: found?.transform ?? null,
    });
  }

  const strip = ({ transform: _transform, ...world }: WorldMatch & { transform: Affine | null }) =>
    world;
  const currentWorld = summary.world ? worlds.get(summary.world.id) : undefined;

  // The player.
  let player: PlayerOnMap | null = null;
  if (summary.player && currentWorld?.mapId && currentWorld.transform) {
    const map = mapsById.get(currentWorld.mapId)!;
    const at = applyAffine(currentWorld.transform, summary.player.position);
    player = {
      mapId: map.id,
      x: at.x,
      y: at.y,
      heading:
        summary.player.yaw === null
          ? null
          : headingOnMap(currentWorld.transform, summary.player.yaw),
      onMap: at.x >= 0 && at.y >= 0 && at.x <= map.width && at.y <= map.height,
    };
  }

  // Places by the save's flags (a location's `flagId` naming a fact or a pin).
  const found = new Map<string, MatchedLocation>();
  const pinsById = new Map(summary.pins.map((pin) => [pin.id, pin]));
  for (const location of pack.locations) {
    if (!location.flagId || !trackable.has(location.categoryId)) continue;
    const fact = summary.facts[location.flagId];
    const pin = pinsById.get(location.flagId);
    // A pin named by tag alone has no kind: its place's category says what done means.
    const kind = pin?.kind ?? kindOfCategory.get(location.categoryId);
    const rule = kind ? rules.get(kind) : undefined;
    const done = pin
      ? pin.cleared === true || (rule ? pinIsDone(pin, rule) : pin.discovered === true)
      : false;
    if (fact !== undefined && fact > 0) {
      found.set(location.id, {
        locationId: location.id,
        kind: 'flag',
        reason: `The save has the fact “${location.flagId}” set.`,
      });
    } else if (pin && done) {
      found.set(location.id, {
        locationId: location.id,
        kind: 'flag',
        reason: `The save shows the map pin “${location.flagId}” as ${pin.cleared ? 'cleared' : 'discovered'}.`,
      });
    }
  }

  // Places by done pins near them.
  const unmatched = new Map<string, Unmatched>();
  const miss = (kind: string, reason: Unmatched['reason']) => {
    const key = `${kind}\u0000${reason}`;
    const entry = unmatched.get(key);
    if (entry) entry.count++;
    else unmatched.set(key, { kind, label: rules.get(kind)?.label ?? kind, reason, count: 1 });
  };
  const kindsWithCategory = new Set(kindOfCategory.values());
  const grids = new Map<string, KindGrid<KindPoint & { id: string }>>();
  const gridFor = (mapId: string) => {
    let grid = grids.get(mapId);
    if (!grid) {
      const map = mapsById.get(mapId)!;
      const places = pack.locations
        .filter(
          (l) =>
            l.mapId === mapId && kindOfCategory.has(l.categoryId) && trackable.has(l.categoryId),
        )
        .map((l) => ({ id: l.id, x: l.x, y: l.y, kind: kindOfCategory.get(l.categoryId)! }));
      grid = new KindGrid(places, map.width, map.height);
      grids.set(mapId, grid);
    }
    return grid;
  };
  // Pins a location names by its flagId were matched above, not by distance.
  const named = new Set(pack.locations.map((l) => l.flagId).filter((id) => id !== undefined));
  const options: { pin: SavePin; locationId: string; distance: number; metres: number }[] = [];
  const pinsToPlace: SavePin[] = [];
  for (const pin of summary.pins) {
    const rule = pin.kind ? rules.get(pin.kind) : undefined;
    if (!rule || !pinIsDone(pin, rule) || named.has(pin.id)) continue;
    if (!kindsWithCategory.has(rule.kind)) {
      miss(rule.kind, 'no-category');
      continue;
    }
    if (!pin.position) {
      miss(rule.kind, 'no-position');
      continue;
    }
    const world = pin.world ? worlds.get(pin.world) : currentWorld;
    if (!world?.mapId) {
      miss(rule.kind, 'no-map');
      continue;
    }
    if (!world.transform) {
      miss(rule.kind, 'not-lined-up');
      continue;
    }
    const scale = affineScale(world.transform);
    const radius = Math.max(tuning.minRadiusPx, tuning.matchRadius * scale);
    const at = applyAffine(world.transform, pin.position);
    pinsToPlace.push(pin);
    for (const place of gridFor(world.mapId).within(at, rule.kind, radius)) {
      const d = distance(at, place);
      options.push({ pin, locationId: place.id, distance: d, metres: d / scale });
    }
  }
  options.sort((a, b) => a.distance - b.distance);
  const placed = new Set<SavePin>();
  for (const option of options) {
    if (placed.has(option.pin) || found.has(option.locationId)) continue;
    placed.add(option.pin);
    const rule = rules.get(option.pin.kind!)!;
    found.set(option.locationId, {
      locationId: option.locationId,
      kind: rule.kind,
      reason: `${singular(rule.label)} ${option.pin.cleared ? 'cleared' : 'discovered'} in the save, ${Math.round(option.metres)} m from this place.`,
    });
  }
  for (const pin of pinsToPlace) if (!placed.has(pin)) miss(pin.kind!, 'no-place-nearby');

  // Done pins named by tag alone, which nothing here can place.
  let done = 0;
  let unplaced = 0;
  for (const pin of summary.pins) {
    if (pin.cleared !== true && pin.discovered !== true) continue;
    done++;
    if (!pin.position && !pin.kind && !named.has(pin.id)) unplaced++;
  }
  const nothingBecause: NothingReason | null =
    found.size > 0
      ? null
      : !summary.map
        ? 'no-map'
        : done === 0
          ? 'nothing-done'
          : unplaced > 0
            ? 'no-tag-table'
            : null;

  // Counts by category.
  const counts = new Map<string, CategoryCount>();
  const categoryOf = new Map(pack.locations.map((l) => [l.id, l.categoryId]));
  for (const match of found.values()) {
    const categoryId = categoryOf.get(match.locationId)!;
    const count = counts.get(categoryId);
    if (count) count.matched++;
    else counts.set(categoryId, { categoryId, kind: match.kind, matched: 1 });
  }

  return {
    current: currentWorld ? strip(currentWorld) : null,
    worlds: [...worlds.values()].map(strip),
    player,
    found: [...found.values()],
    categories: [...counts.values()],
    unmatched: [...unmatched.values()],
    calibrated,
    needsCalibration: Boolean(currentWorld?.mapId && !currentWorld.transform),
    unplaced,
    nothingBecause,
  };
}

function singular(label: string): string {
  const special: Record<string, string> = {
    'People in distress': 'Person in distress',
    'Spoils of war': 'Spoils of war',
    "Smugglers' caches": "Smugglers' cache",
    'Places of power': 'Place of power',
  };
  return special[label] ?? label.replace(/s$/, '');
}

/**
 * The player's facing on the map, in degrees clockwise from up. The game
 * faces along (-sin yaw, cos yaw) in world coordinates (yaw 0 is +y,
 * north); the map's transform turns that into a direction in pixels.
 */
export function headingOnMap(transform: Affine, yawDegrees: number): number {
  const yaw = (yawDegrees * Math.PI) / 180;
  const direction = applyLinear(transform, { x: -Math.sin(yaw), y: Math.cos(yaw) });
  const degrees = (Math.atan2(direction.x, -direction.y) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** An automatic world-to-pixel fit for a map from the anchor pins of a world. */
export function calibrateFromPins(
  pins: readonly SavePin[],
  worldId: string,
  map: PackForMatching['maps'][number],
  pack: PackForMatching,
  kindOfCategory: ReadonlyMap<string, string>,
  tuning: SaveTuning,
): AutoCalibration | null {
  const anchors = new Set(tuning.pinKinds.filter((rule) => rule.anchor).map((rule) => rule.kind));
  const worldPins = pins
    .filter((pin) => pin.position && pin.kind && anchors.has(pin.kind) && pin.world === worldId)
    .map((pin) => ({ x: pin.position!.x, y: pin.position!.y, kind: pin.kind! }));
  if (worldPins.length === 0) return null;
  const places = pack.locations
    .filter((l) => l.mapId === map.id && kindOfCategory.has(l.categoryId))
    .map((l) => ({ x: l.x, y: l.y, kind: kindOfCategory.get(l.categoryId)! }))
    .filter((p) => anchors.has(p.kind));
  return autoCalibrate({
    pins: worldPins,
    places,
    radiusWorld: tuning.matchRadius,
    minRadiusPx: tuning.minRadiusPx,
    mapSize: { width: map.width, height: map.height },
  });
}
